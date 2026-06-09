import { NextResponse } from "next/server";
import { db, getActiveChannelId, getLastUserVideosSyncAt } from "@/lib/db";

export const runtime = "nodejs";

type VideoRow = {
  id: string;
  title: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  published_at: number | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
};

export async function GET(req: Request) {
  const activeChannelId = getActiveChannelId();
  if (!activeChannelId) {
    return NextResponse.json({ error: "no active channel" }, { status: 400 });
  }

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
    : 50;
  const search = url.searchParams.get("q")?.trim() ?? "";
  const args: unknown[] = [activeChannelId];
  let where = "WHERE channel_id = ?";
  if (search) {
    where += " AND title LIKE ?";
    args.push(`%${search}%`);
  }
  args.push(limit);

  const videos = db
    .prepare(
      `SELECT id, title, views, likes, comments, published_at, duration_seconds, thumbnail_url
       FROM videos
       ${where}
       ORDER BY COALESCE(published_at, 0) DESC, imported_at DESC
       LIMIT ?`
    )
    .all(...args) as VideoRow[];

  return NextResponse.json({
    channelId: activeChannelId,
    lastSyncAt: getLastUserVideosSyncAt(activeChannelId),
    videos,
  });
}
