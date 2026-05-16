import { NextResponse } from "next/server";
import { getActiveChannelId, listCompetitors } from "@/lib/db";
import { syncCompetitor } from "@/lib/competitor-sync";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
// Up to 10 competitors × ~30s each. 600s ceiling on Railway, so we keep
// some slack for Apify queueing if multiple sync requests stack up.
export const maxDuration = 300;

/**
 * POST /api/competitors/sync-all
 * Body: { userChannelId?: string, allChannels?: boolean }
 *
 * Default behaviour: sync every competitor under the active user channel
 * (or the user channel named in `userChannelId`). The legacy global
 * "sync every competitor regardless of channel" path is preserved behind
 * an explicit `allChannels: true` opt-in for cases like a one-off refresh
 * after import.
 *
 * Serialised rather than parallelised because Apify rate-limits per actor.
 */
export async function POST(req: Request) {
  const body = (await req
    .json()
    .catch(() => ({}))) as {
    userChannelId?: unknown;
    allChannels?: unknown;
  };

  const competitors = body.allChannels === true
    ? listCompetitors() // legacy global behaviour
    : listCompetitors(
        typeof body.userChannelId === "string" && body.userChannelId.length > 0
          ? body.userChannelId
          : (getActiveChannelId() ?? undefined)
      );

  const results: Array<{
    id: number;
    ok: boolean;
    videosInserted?: number;
    newAlerts?: number;
    error?: string;
  }> = [];

  for (const c of competitors) {
    try {
      const r = await syncCompetitor(c.id);
      results.push({
        id: c.id,
        ok: true,
        videosInserted: r.videosInserted,
        newAlerts: r.newAlerts,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "sync failed";
      log.warn("competitors", `Bulk sync skipped ${c.id}: ${msg}`);
      results.push({ id: c.id, ok: false, error: msg });
    }
  }

  return NextResponse.json({
    total: competitors.length,
    succeeded: results.filter((r) => r.ok).length,
    results,
  });
}
