import { NextResponse } from "next/server";
import { getActiveChannelId, listCompetitorAlerts } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/competitors/alerts
 *   ?unread=1            → unread only
 *   ?userChannelId=X     → scope to one of the user's channels (defaults
 *                          to the active channel; pass "all" to bypass)
 *
 * No row cap — RecentTab + chat tool both want the full set. Pagination
 * is deferred until a real perf signal lands (sqlite over the indexed
 * table handles thousands of rows cheaply, and client-side filtering on
 * Recent does the visible-window narrowing).
 *
 * Cross-channel alerts would leak after the rework — every consumer of
 * this endpoint should be looking at one user channel at a time.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const channelParam = url.searchParams.get("userChannelId");
  const userChannelId =
    channelParam === "all"
      ? null
      : channelParam && channelParam.length > 0
        ? channelParam
        : (getActiveChannelId() ?? null);

  const alerts = listCompetitorAlerts({ unreadOnly, userChannelId });
  return NextResponse.json({ alerts });
}
