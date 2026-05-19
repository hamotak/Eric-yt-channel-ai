import { NextResponse } from "next/server";
import {
  claimNextQueuedCompetitor,
  type Competitor,
  db,
  getSetting,
  markCompetitorSyncDone,
  markCompetitorSyncFailed,
  setSetting,
} from "@/lib/db";
import {
  CompetitorSyncError,
  enrichCompetitorMetadataFromYouTube,
  syncCompetitor,
} from "@/lib/competitor-sync";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

const LOCK_KEY = "competitor_sync.in_progress";
// If a worker process crashed mid-sync (Mac sleep, dev-server restart), the
// lock would never clear. Anything older than this is treated as stale and
// reclaimed. 10 minutes is long enough for any legitimate single sync.
const STALE_LOCK_SEC = 600;
// Background re-enrichment trigger: a row whose Apify sync succeeded but
// whose YT-enriched fields are still null after a grace period almost
// certainly hit the old "enrich-before-sync" worker-order bug. Re-queue
// it so a fresh enrichment pass runs.
const STALE_META_SEC = 300;
// Apify free-tier concurrency ceiling. 5 in-flight runs is safe per their
// per-account limits and gives a ~5x wall-clock speedup over the prior
// serial loop. Lower this if a different tier or actor caps lower.
const PARALLEL_CAP = 5;
// Defensive total-processed cap. Was the prior loop's `i < 50` ceiling;
// protects against runaway loops if the DB layer ever leaves a row stuck.
const MAX_PROCESSED_PER_RUN = 50;

/**
 * POST /api/competitors/sync-queued — worker route.
 *
 * Drains the queued competitor pile sequentially:
 *   1. Acquire a process-wide lock via settings[LOCK_KEY] = unix-seconds.
 *      A second concurrent caller sees the lock and returns 200 {skipped}.
 *      A lock older than STALE_LOCK_SEC is treated as crashed and reclaimed.
 *   2. Loop: claim the oldest queued row → mark 'syncing' →
 *      run Apify sync FIRST (resolves channel_id) → THEN YT enrich
 *      (needs channel_id to fetch subs + avatar) → mark 'synced' or
 *      'failed' → kick similarity scoring (fire-and-forget so a failure
 *      there doesn't taint the sync result).
 *   3. After draining: scan for synced rows with NULL metadata older
 *      than STALE_META_SEC — those got the old enrich-before-sync race
 *      and need a fresh enrichment pass.
 *   4. Release the lock.
 */
export async function POST(req: Request) {
  const now = Math.floor(Date.now() / 1000);
  const lockRaw = Number(getSetting(LOCK_KEY) ?? "0");
  if (lockRaw > 0 && now - lockRaw < STALE_LOCK_SEC) {
    return NextResponse.json({ ok: true, skipped: true, reason: "locked" });
  }
  setSetting(LOCK_KEY, String(now));

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let reEnriched = 0;
  const errors: string[] = [];
  const origin = new URL(req.url).origin;

  // Per-row work — claim → apify → yt-enrich → mark done/failed, plus
  // sanity logging and fire-and-forget similarity scoring. Hoisted out
  // so the parallel-batch loop can run it for several rows at once.
  const runOne = async (row: Competitor) => {
    try {
      // Apify FIRST — resolves channel_id from the handle so the
      // subsequent YT enrich call has something to look up. (The
      // previous order, enrich-then-sync, was the cause of
      // "title syncs but no avatar/subs" for newly-added competitors.)
      await syncCompetitor(row.id);
      // YT enrich SECOND — now channel_id is set, channels.list works.
      // Non-fatal: a YT failure here doesn't fail the sync overall.
      await enrichCompetitorMetadataFromYouTube(row.id);
      markCompetitorSyncDone(row.id);
      succeeded++;
      // Dev-side sanity log: per-window view sums so HAmo can
      // spot-check the math without opening sqlite.
      const viewsLog = db
        .prepare(
          `SELECT
             c.title,
             SUM(CASE WHEN v.published_at > strftime('%s','now') -  7 * 86400 THEN v.views ELSE 0 END) AS v7,
             SUM(CASE WHEN v.published_at > strftime('%s','now') - 28 * 86400 THEN v.views ELSE 0 END) AS v28,
             SUM(CASE WHEN v.published_at > strftime('%s','now') - 90 * 86400 THEN v.views ELSE 0 END) AS v90
           FROM competitors c
           LEFT JOIN competitor_videos v ON v.competitor_id = c.id
           WHERE c.id = ?`
        )
        .get(row.id) as
        | { title: string | null; v7: number; v28: number; v90: number }
        | undefined;
      if (viewsLog) {
        log.info("competitors", "Per-window views (sanity log)", {
          competitor: viewsLog.title,
          window7d: viewsLog.v7,
          window28d: viewsLog.v28,
          window90d: viewsLog.v90,
        });
      }
      log.info(
        "competitors",
        `Queued sync succeeded for ${row.id} (${row.handle ?? row.channel_id ?? "?"})`
      );
      // Fire-and-forget similarity scoring. Failure is silent — the UI
      // shows "—" for the score until a successful run lands.
      void fetch(`${origin}/api/competitors/${row.id}/score-similarity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      }).catch(() => {});
    } catch (err) {
      const msg =
        err instanceof CompetitorSyncError || err instanceof Error
          ? err.message
          : "sync failed";
      markCompetitorSyncFailed(row.id, msg);
      failed++;
      errors.push(`${row.id}: ${msg}`);
      log.warn("competitors", `Queued sync failed for ${row.id}: ${msg}`);
    }
  };

  try {
    // Batched-parallel drain. We claim up to PARALLEL_CAP rows from the
    // queue at once and run their sync+enrich in parallel via
    // Promise.allSettled. The lock still serialises *workers* (only
    // one /api/competitors/sync-queued at a time), but inside a single
    // worker the per-row Apify + YT calls fire concurrently — 7
    // competitors that took ~5 minutes serially now take ~1 minute.
    // Apify free-tier concurrency cap is the binding constraint, so
    // PARALLEL_CAP defaults to 5.
    while (processed < MAX_PROCESSED_PER_RUN) {
      const batch: Array<Competitor> = [];
      while (batch.length < PARALLEL_CAP && processed + batch.length < MAX_PROCESSED_PER_RUN) {
        const row = claimNextQueuedCompetitor();
        if (!row) break;
        batch.push(row);
      }
      if (batch.length === 0) break;
      processed += batch.length;
      log.info(
        "competitors",
        `Queued sync: starting parallel batch of ${batch.length} (processed=${processed}/${MAX_PROCESSED_PER_RUN})`
      );
      await Promise.allSettled(batch.map(runOne));
    }

    // Background re-enrichment for rows that fell through the cracks of
    // the old worker order. Pick up to 5 stale rows per pass — bounded so
    // a one-time bug doesn't blow through the YT quota.
    const staleRows = db
      .prepare(
        `SELECT id FROM competitors
         WHERE sync_status = 'synced'
           AND channel_id IS NOT NULL
           AND subscriber_count IS NULL
           AND avatar_url IS NULL
           AND added_at < strftime('%s','now') - ?
         LIMIT 5`
      )
      .all(STALE_META_SEC) as { id: number }[];
    for (const s of staleRows) {
      try {
        await enrichCompetitorMetadataFromYouTube(s.id);
        reEnriched++;
        log.info("competitors", `Background re-enrich ${s.id}`);
      } catch (err) {
        log.warn(
          "competitors",
          `Background re-enrich ${s.id} failed: ${err instanceof Error ? err.message : "?"}`
        );
      }
    }
  } finally {
    setSetting(LOCK_KEY, "0");
  }

  return NextResponse.json({
    ok: true,
    processed,
    succeeded,
    failed,
    reEnriched,
    errors: errors.slice(0, 10),
  });
}
