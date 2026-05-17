import { NextResponse } from "next/server";
import {
  competitorMetricsForOne,
  getCompetitor,
} from "@/lib/db";
import { enrichCompetitorMetadataFromYouTube } from "@/lib/competitor-sync";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/competitors/[id]/refresh-metadata
 *
 * Manual re-run of enrichCompetitorMetadataFromYouTube for one competitor.
 * Exposed as a button on the detail page header for the cases where the
 * initial worker pass left avatar/subs blank (the prior worker-order bug
 * where YT enrichment ran before Apify had resolved channel_id).
 *
 * Returns the freshly-enriched competitor row in the same wire shape the
 * GET endpoint uses so the client can drop it straight into state.
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
  const existing = getCompetitor(competitorId);
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const result = await enrichCompetitorMetadataFromYouTube(competitorId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "enrichment failed" },
      { status: 502 }
    );
  }

  const refreshed = getCompetitor(competitorId);
  if (!refreshed) {
    return NextResponse.json({ error: "row vanished" }, { status: 500 });
  }
  const metrics = competitorMetricsForOne(competitorId);

  return NextResponse.json({
    ok: true,
    competitor: {
      id: refreshed.id,
      channelId: refreshed.channel_id,
      handle: refreshed.handle,
      title: refreshed.title,
      avatarUrl: refreshed.avatar_url,
      subscriberCount: refreshed.subscriber_count,
      videoCount: refreshed.video_count,
      addedAt: refreshed.added_at,
      lastSyncAt: refreshed.last_sync_at,
      userChannelId: refreshed.user_channel_id,
      tier: refreshed.tier,
      tierSetAt: refreshed.tier_set_at,
      syncStatus: refreshed.sync_status,
      syncError: refreshed.sync_error,
      similarityScore: refreshed.similarity_score,
      outliers60d: metrics.outliers60d,
      outliers60d2x: metrics.outliers60d2x,
      medianViews60d: metrics.medianViews60d,
      lastUploadAt: metrics.lastUploadAt,
      recentVideoViews: metrics.recentVideoViews,
      views7d: metrics.views7d,
      views28d: metrics.views28d,
      views90d: metrics.views90d,
    },
    enriched: result.fields,
  });
}
