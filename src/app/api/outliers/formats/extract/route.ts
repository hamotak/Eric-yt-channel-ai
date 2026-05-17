import { NextResponse } from "next/server";
import { getActiveChannelId } from "@/lib/db";
import { extractFormatsFromOutliers } from "@/lib/outlier-formats";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/outliers/formats/extract — kicks off Claude-driven format
 * extraction for the active channel's current outliers. Rate-limited
 * 1 call per channel per 30 min by the underlying lib helper. Returns
 * { formatsCreated, videosLinked, lastExtractedAt } or a structured
 * error.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    userChannelId?: unknown;
  };
  const userChannelId =
    typeof body.userChannelId === "string" && body.userChannelId.trim()
      ? body.userChannelId.trim()
      : (getActiveChannelId() ?? "");
  if (!userChannelId) {
    return NextResponse.json(
      { error: "No active channel; pass userChannelId in the body." },
      { status: 400 }
    );
  }
  const result = await extractFormatsFromOutliers(userChannelId);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        ...(result.retryAfterSec ? { retryAfterSec: result.retryAfterSec } : {}),
      },
      { status: result.status }
    );
  }
  return NextResponse.json({
    formatsCreated: result.formatsCreated,
    videosLinked: result.videosLinked,
    lastExtractedAt: result.lastExtractedAt,
  });
}
