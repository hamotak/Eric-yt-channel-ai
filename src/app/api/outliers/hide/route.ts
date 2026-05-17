import { NextResponse } from "next/server";
import {
  getActiveChannelId,
  hideCompetitorOutlier,
  invalidateTopicsGapCache,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/outliers/hide
 *
 * Body: { videoId: string, competitorId: number, reason?: string }
 *
 * Hides one competitor video from every outlier surface for the active
 * user_channel: Recent, /api/outliers (incl. /competitors/[id]),
 * Topics Gap source, Patterns extraction source, and chat list_outliers.
 *
 * Idempotent (INSERT … ON CONFLICT DO UPDATE in the helper). Returns
 * 400 if no active channel is bound. After the write, the matching
 * Topics Gap cache rows for this user_channel are deleted so the next
 * Generate click rebuilds without the hidden video in the source set.
 * The Patterns table (outlier_formats) is NOT invalidated — Re-extract
 * is a deliberate user action.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    videoId?: unknown;
    competitorId?: unknown;
    reason?: unknown;
  };
  const videoId =
    typeof body.videoId === "string" ? body.videoId.trim() : "";
  if (!videoId) {
    return NextResponse.json({ error: "videoId required" }, { status: 400 });
  }
  const competitorId =
    typeof body.competitorId === "number" && Number.isFinite(body.competitorId)
      ? body.competitorId
      : NaN;
  if (!Number.isFinite(competitorId)) {
    return NextResponse.json(
      { error: "competitorId required (number)" },
      { status: 400 }
    );
  }
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : null;

  const userChannelId = getActiveChannelId();
  if (!userChannelId) {
    return NextResponse.json(
      { error: "No active channel — set one from the top-right picker." },
      { status: 400 }
    );
  }

  hideCompetitorOutlier({
    userChannelId,
    competitorId,
    videoId,
    reason,
  });
  invalidateTopicsGapCache(userChannelId);

  return NextResponse.json({ ok: true });
}
