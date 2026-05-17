import { NextResponse } from "next/server";
import {
  getActiveChannelId,
  getCompetitorVideosByIds,
} from "@/lib/db";
import {
  competitorTopicsGap,
  type GapsWindowDays,
} from "@/lib/competitor-topics-gap";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/competitors/topics-gap
 *
 * Body:
 *   {
 *     userChannelId?: string,
 *     refresh?: boolean,
 *     windowDays?: 14|30|90|null,
 *     cacheOnly?: boolean,
 *   }
 *
 * Calls Claude with §4 inlined to surface topic-level gaps (subject
 * areas working for competitors that the user hasn't covered). Cached
 * 4 hours per (userChannelId, windowDays); pass {refresh:true} to bust
 * the cache for the chosen window. windowDays defaults to 14 — the
 * page-level Topics Gap pill row aligns with this.
 *
 * cacheOnly:true short-circuits before any Claude call — returns the
 * fresh cache if one exists, otherwise `{ ok:true, cacheMiss:true,
 * gaps:[] }`. The Gaps tab uses this on tab/window open so nothing
 * fires until the user clicks Generate.
 *
 * Response embeds example-video thumbnail/title data alongside each
 * gap so the UI can render thumbnails without a second round-trip.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    userChannelId?: unknown;
    refresh?: unknown;
    windowDays?: unknown;
    cacheOnly?: unknown;
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
  const refresh = body.refresh === true;
  const cacheOnly = body.cacheOnly === true;

  // Validate windowDays. Accept 14/30/90 (numeric), null (explicit
  // "all time"), or undefined (lib defaults to 14). Reject anything
  // else so the cache key namespace stays bounded.
  let windowDays: GapsWindowDays | undefined;
  if (body.windowDays === null) {
    windowDays = null;
  } else if (body.windowDays === undefined) {
    windowDays = undefined;
  } else if (
    body.windowDays === 14 ||
    body.windowDays === 30 ||
    body.windowDays === 90
  ) {
    windowDays = body.windowDays;
  } else {
    return NextResponse.json(
      {
        error:
          "windowDays must be one of: 14, 30, 90, null (for all time), or omitted.",
      },
      { status: 400 }
    );
  }

  const result = await competitorTopicsGap({
    userChannelId,
    refresh,
    windowDays,
    cacheOnly,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status }
    );
  }

  // Hydrate example video ids with title + thumb + competitor name so
  // the UI can render thumbnails inline.
  const allIds = Array.from(
    new Set(result.gaps.flatMap((g) => g.exampleCompetitorVideoIds))
  );
  const videos = getCompetitorVideosByIds(allIds);
  const videoMap = new Map(videos.map((v) => [v.videoId, v]));

  return NextResponse.json({
    ok: true,
    cached: result.cached,
    cacheMiss: result.cacheMiss ?? false,
    generatedAt: result.generatedAt,
    gaps: result.gaps.map((g) => ({
      ...g,
      examples: g.exampleCompetitorVideoIds
        .map((id) => {
          const v = videoMap.get(id);
          if (!v) return null;
          return {
            videoId: v.videoId,
            title: v.title,
            views: v.views,
            thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
            competitorTitle: v.competitorTitle,
            tier: v.tier,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    })),
  });
}
