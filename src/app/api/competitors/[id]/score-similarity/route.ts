import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { scoreCompetitorSimilarity } from "@/lib/competitor-similarity";

export const runtime = "nodejs";
export const maxDuration = 60;

// Per-competitor cooldown — 1 hour. Stops the user (or a bug) from
// burning Claude tokens hammering the button. Cache writes go into
// settings under a per-id key.
const COOLDOWN_SEC = 60 * 60;

/**
 * POST /api/competitors/[id]/score-similarity
 *
 * Calls Claude with the user channel's niche/positioning/audience/voice
 * context (from /channel-info) and the competitor's recent 10 titles,
 * gets a 0-100 score grounded in MENTOR_METHOD.md §1, persists into
 * competitors.similarity_score. Used by the sync-queued worker after
 * each successful sync AND by a manual "Re-score" button on the detail
 * page (button comes in a later sub-step — endpoint is the same).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const competitorId = Number(id);
  if (!Number.isFinite(competitorId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const rateKey = `competitor_similarity.last_run.${competitorId}`;
  const last = Number(getSetting(rateKey) ?? "0");
  const now = Math.floor(Date.now() / 1000);
  if (last > 0 && now - last < COOLDOWN_SEC) {
    return NextResponse.json(
      {
        error: "Similarity scoring is rate-limited per competitor (1 per hour)",
        retryAfterSec: COOLDOWN_SEC - (now - last),
      },
      { status: 429 }
    );
  }

  const result = await scoreCompetitorSimilarity(competitorId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status }
    );
  }

  setSetting(rateKey, String(now));
  return NextResponse.json({
    ok: true,
    competitorId: result.competitorId,
    score: result.score,
    reasoning: result.reasoning,
  });
}
