import { NextResponse } from "next/server";
import {
  COMPETITOR_TIERS,
  CompetitorTier,
  deleteCompetitor,
  getCompetitor,
  getCompetitorByUserChannelAndYouTubeId,
  isCompetitorTier,
  listAllChannels,
  listCompetitorVideos,
  updateCompetitorAssignment,
} from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const competitorId = Number(id);
  if (!Number.isFinite(competitorId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const competitor = getCompetitor(competitorId);
  if (!competitor) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const videos = listCompetitorVideos(competitorId, 100);
  return NextResponse.json({ competitor, videos });
}

/**
 * PATCH /api/competitors/[id]
 * Body: { userChannelId?: string | null, tier?: CompetitorTier }
 *
 * Used by:
 *  - the migration banner ("assign this unassigned competitor to channel X")
 *  - the per-card tier dropdown ("re-tag this competitor as Breakthrough")
 *  - the per-card "Move to another channel" link
 *
 * tier_set_at is bumped server-side whenever tier changes (see
 * updateCompetitorAssignment in db.ts).
 */
export async function PATCH(
  req: Request,
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

  const body = (await req.json().catch(() => ({}))) as {
    userChannelId?: unknown;
    tier?: unknown;
  };

  const patch: { user_channel_id?: string | null; tier?: CompetitorTier } = {};

  if ("userChannelId" in body) {
    const v = body.userChannelId;
    if (v === null) {
      patch.user_channel_id = null;
    } else if (typeof v === "string" && v.length > 0) {
      // Validate the target user channel exists.
      const all = listAllChannels();
      if (!all.some((c) => c.id === v)) {
        return NextResponse.json(
          { error: `Unknown userChannelId: ${v}` },
          { status: 400 }
        );
      }
      // Reject re-assignment that would collide with the partial unique
      // index (same competitor already tracked under the target channel).
      if (existing.channel_id) {
        const collide = getCompetitorByUserChannelAndYouTubeId(
          v,
          existing.channel_id
        );
        if (collide && collide.id !== competitorId) {
          return NextResponse.json(
            {
              error: "Target channel already tracks this competitor.",
              id: collide.id,
            },
            { status: 409 }
          );
        }
      }
      patch.user_channel_id = v;
    } else {
      return NextResponse.json(
        { error: "userChannelId must be a string or null" },
        { status: 400 }
      );
    }
  }

  if ("tier" in body) {
    if (!isCompetitorTier(body.tier)) {
      return NextResponse.json(
        { error: `tier must be one of: ${COMPETITOR_TIERS.join(", ")}` },
        { status: 400 }
      );
    }
    patch.tier = body.tier;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "nothing to update — pass userChannelId and/or tier" },
      { status: 400 }
    );
  }

  const updated = updateCompetitorAssignment(competitorId, patch);
  if (!updated) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    competitor: {
      id: updated.id,
      channelId: updated.channel_id,
      handle: updated.handle,
      title: updated.title,
      avatarUrl: updated.avatar_url,
      subscriberCount: updated.subscriber_count,
      videoCount: updated.video_count,
      addedAt: updated.added_at,
      lastSyncAt: updated.last_sync_at,
      userChannelId: updated.user_channel_id,
      tier: updated.tier,
      tierSetAt: updated.tier_set_at,
    },
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const competitorId = Number(id);
  if (!Number.isFinite(competitorId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  // ON DELETE CASCADE wipes competitor_videos and competitor_alerts too,
  // so we don't have to lift cleanup logic into the route handler.
  deleteCompetitor(competitorId);
  return NextResponse.json({ ok: true });
}
