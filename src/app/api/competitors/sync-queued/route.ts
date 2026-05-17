import { NextResponse } from "next/server";
import {
  claimNextQueuedCompetitor,
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

/**
 * POST /api/competitors/sync-queued — worker route.
 *
 * Drains the queued competitor pile sequentially:
 *   1. Acquire a process-wide lock via settings[LOCK_KEY] = unix-seconds.
 *      A second concurrent caller sees the lock and returns 200 {skipped:true}.
 *      A lock older than STALE_LOCK_SEC is treated as crashed and reclaimed.
 *   2. Loop: claim the oldest queued row → mark 'syncing' →
 *      run YT enrich + Apify sync → mark 'synced' or 'failed' →
 *      kick similarity scoring (fire-and-forget so a failure there doesn't
 *      taint the sync result).
 *   3. Release the lock.
 *
 * Returns a summary the client can log; the page's polling loop relies on
 * GET /api/competitors.inFlight to know when to stop polling.
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
  const errors: string[] = [];
  const origin = new URL(req.url).origin;

  try {
    // Defensive cap. A typical add session queues 1-3 rows. 50 protects
    // against runaway loops if the DB layer ever leaves a row stuck.
    for (let i = 0; i < 50; i++) {
      const row = claimNextQueuedCompetitor();
      if (!row) break;
      processed++;
      try {
        // YT enrich first (cheap, 1 quota unit). Non-fatal on failure —
        // the Apify sync still runs.
        await enrichCompetitorMetadataFromYouTube(row.id);
        await syncCompetitor(row.id);
        markCompetitorSyncDone(row.id);
        succeeded++;
        log.info(
          "competitors",
          `Queued sync succeeded for ${row.id} (${row.handle ?? row.channel_id ?? "?"})`
        );
        // Fire-and-forget similarity scoring. Failure is silent — the UI
        // shows "—" for the score until a successful run lands. Done as
        // an internal POST so the rate-limit / cache logic in the route
        // is the single source of truth.
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
    }
  } finally {
    setSetting(LOCK_KEY, "0");
  }

  return NextResponse.json({
    ok: true,
    processed,
    succeeded,
    failed,
    errors: errors.slice(0, 10),
  });
}
