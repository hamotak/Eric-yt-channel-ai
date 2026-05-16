import { NextResponse } from "next/server";
import { getActiveChannelId, listCompetitorAlerts } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/competitors/alerts
 *   ?unread=1            → unread only
 *   ?limit=N             → cap row count (default 100, max 200)
 *   ?userChannelId=X     → scope to one of the user's channels (defaults
 *                          to the active channel; pass "all" to bypass)
 *
 * Cross-channel alerts would leak after the rework — every consumer of
 * this endpoint should be looking at one user channel at a time.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const limit = Math.min(
    200,
    Math.max(1, Number(url.searchParams.get("limit") ?? 100))
  );
  const channelParam = url.searchParams.get("userChannelId");
  const userChannelId =
    channelParam === "all"
      ? null
      : channelParam && channelParam.length > 0
        ? channelParam
        : (getActiveChannelId() ?? null);

  const alerts = listCompetitorAlerts({ unreadOnly, limit, userChannelId });
  return NextResponse.json({ alerts });
}
