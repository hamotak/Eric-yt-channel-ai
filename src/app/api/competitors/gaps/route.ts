import { NextResponse } from "next/server";
import { competitorGapAnalysis, getActiveChannelId } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/competitors/gaps?topN=25&userChannelId=X
 *
 * Returns words frequent in competitor TOP videos that DON'T appear
 * in the user's own catalogue for the scoped channel. Without a user
 * channel scope the words would mix across channels — meaningless.
 * Falls back to getActiveChannelId() when no param is given.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const topN = Math.min(
    50,
    Math.max(5, Number(url.searchParams.get("topN") ?? 25))
  );
  const channelParam = url.searchParams.get("userChannelId");
  const userChannelId =
    channelParam && channelParam.length > 0
      ? channelParam
      : (getActiveChannelId() ?? null);

  const gaps = competitorGapAnalysis({ topN, userChannelId });
  return NextResponse.json({ gaps });
}
