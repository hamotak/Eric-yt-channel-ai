import { NextResponse } from "next/server";
import { explainOutlier } from "@/lib/outlier-explain";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/outliers/explain — thin wrapper over the shared explainOutlier
 * helper. Same flow used by the explain_outlier chat tool. Cache-first;
 * cached responses bypass rate-limit. Returns Claude's 2-3 §9 levers +
 * 2-3 sentence explanation grounded in §2 / §9.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    videoId?: unknown;
    competitorId?: unknown;
  };
  const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
  const competitorId = Number(body.competitorId);
  const result = await explainOutlier({
    videoId,
    competitorId: Number.isFinite(competitorId) ? competitorId : undefined,
  });
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
    videoId: result.videoId,
    levers: result.levers,
    explanation: result.explanation,
    cached: result.cached,
    generatedAt: result.generatedAt,
  });
}
