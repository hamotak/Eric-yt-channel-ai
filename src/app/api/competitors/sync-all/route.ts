import { NextResponse } from "next/server";
import {
  getActiveChannelId,
  listCompetitors,
  requeueCompetitor,
} from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/competitors/sync-all
 * Body: { userChannelId?: string, allChannels?: boolean }
 *
 * Re-queues every competitor in scope (sets sync_status='queued') and
 * kicks the /sync-queued worker. Returns 202 immediately — the worker
 * drains the queue serially and the page polls GET /api/competitors
 * for progress.
 *
 * This used to do inline serial sync per competitor; the async model
 * lets the user navigate away during a long bulk sync.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
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

  for (const c of competitors) {
    requeueCompetitor(c.id);
  }

  const origin = new URL(req.url).origin;
  void fetch(`${origin}/api/competitors/sync-queued`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    cache: "no-store",
  }).catch(() => {});

  return NextResponse.json(
    { ok: true, queued: competitors.length },
    { status: 202 }
  );
}
