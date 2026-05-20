import { NextResponse } from "next/server";
import { db, getActiveChannelId } from "@/lib/db";

export const runtime = "nodejs";

type GenRow = {
  id: string;
  user_channel_id: string;
  mode: string;
  count: number;
  status: string;
  started_at: string;
  completed_at: string | null;
};

/**
 * GET /api/ideate/history?channelId=UC...
 *
 * Returns the last 20 generations for the channel. Default scope is the
 * active channel. Used by the left history sidebar on /ideate.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelId =
    url.searchParams.get("channelId") ?? getActiveChannelId();
  if (!channelId) {
    return NextResponse.json({ history: [], channelId: null });
  }
  const rows = db
    .prepare(
      `SELECT id, user_channel_id, mode, count, status, started_at, completed_at
       FROM generations
       WHERE user_channel_id = ?
       ORDER BY started_at DESC
       LIMIT 20`
    )
    .all(channelId) as GenRow[];

  return NextResponse.json({
    channelId,
    history: rows.map((r) => ({
      id: r.id,
      mode: r.mode,
      count: r.count,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    })),
  });
}
