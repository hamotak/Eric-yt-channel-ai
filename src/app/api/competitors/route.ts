import { NextResponse } from "next/server";
import {
  addCompetitor,
  COMPETITOR_TIERS,
  Competitor,
  CompetitorTier,
  countUnassignedCompetitors,
  getActiveChannelId,
  getChannel,
  getCompetitorByUserChannelAndHandle,
  getCompetitorByUserChannelAndYouTubeId,
  isCompetitorTier,
  listAllChannels,
  listCompetitors,
  unreadCompetitorAlertCount,
} from "@/lib/db";
import {
  CompetitorSyncError,
  normaliseChannelUrl,
  syncCompetitor,
} from "@/lib/competitor-sync";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/competitors
 *   - no param          → every row (used by the migration banner view)
 *   - ?userChannelId=X  → only competitors owned by user channel X
 *   - ?userChannelId=unassigned → only rows with user_channel_id IS NULL
 *
 * The response also carries:
 *   - unreadAlerts:    unread alert count scoped to the active user channel
 *                      (the sidebar badge polls this endpoint without args)
 *   - unassignedCount: total NULL-user_channel_id rows — drives the yellow
 *                      migration banner on the page.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const param = url.searchParams.get("userChannelId");
  let scope: string | "unassigned" | undefined;
  if (param === "unassigned") scope = "unassigned";
  else if (typeof param === "string" && param.length > 0) scope = param;

  const competitors = listCompetitors(scope);

  // The sidebar badge polls this endpoint with no params — it expects
  // `unreadAlerts` to mean "the active channel's unread count" rather
  // than a global total (which would tick up for competitors that don't
  // belong to whichever channel is currently focused).
  const activeId = getActiveChannelId();

  return NextResponse.json({
    competitors: competitors.map(toWire),
    unreadAlerts: unreadCompetitorAlertCount(activeId),
    unassignedCount: countUnassignedCompetitors(),
  });
}

/**
 * POST /api/competitors
 *
 * Body: { identifier: string, userChannelId: string, tier: CompetitorTier }
 *
 * Adds a competitor under a specific user channel. Both userChannelId and
 * tier are required. Dedup is per (userChannelId, channelId) and also per
 * (userChannelId, handle) so the post-sync UPDATE doesn't race the partial
 * unique index when only an @handle was supplied. Runs the first sync
 * inline so the UI sees populated data on the redirect that follows.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    identifier?: unknown;
    userChannelId?: unknown;
    tier?: unknown;
  };
  const identifier =
    typeof body.identifier === "string" ? body.identifier.trim() : "";
  const userChannelId =
    typeof body.userChannelId === "string" ? body.userChannelId.trim() : "";
  const tier = body.tier;

  if (!identifier) {
    return NextResponse.json({ error: "identifier required" }, { status: 400 });
  }
  if (!userChannelId) {
    return NextResponse.json(
      { error: "userChannelId required" },
      { status: 400 }
    );
  }
  if (!isCompetitorTier(tier)) {
    return NextResponse.json(
      {
        error: `tier must be one of: ${COMPETITOR_TIERS.join(", ")}`,
      },
      { status: 400 }
    );
  }
  // Validate that the user channel actually exists. Hand-rolled because
  // there's no `channelExists` helper; getChannel() requires the active
  // pointer to be set so we use listAllChannels() instead.
  const allChannels = listAllChannels();
  if (!allChannels.some((c) => c.id === userChannelId)) {
    return NextResponse.json(
      { error: `Unknown userChannelId: ${userChannelId}` },
      { status: 400 }
    );
  }

  let normalised: string;
  try {
    normalised = normaliseChannelUrl(identifier);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "invalid identifier" },
      { status: 400 }
    );
  }

  const ucMatch = normalised.match(/channel\/(UC[A-Za-z0-9_-]+)/);
  const handleMatch = normalised.match(/@([A-Za-z0-9_.-]+)/);
  const handle = handleMatch ? `@${handleMatch[1]}` : normalised;

  // 409 guards before insert — pair-scoped on both UC-id and handle so
  // we catch the duplicate before the partial unique index would.
  if (ucMatch) {
    const existing = getCompetitorByUserChannelAndYouTubeId(
      userChannelId,
      ucMatch[1]
    );
    if (existing) {
      return NextResponse.json(
        { error: "Already tracked under this channel.", id: existing.id },
        { status: 409 }
      );
    }
  }
  const handleDup = getCompetitorByUserChannelAndHandle(userChannelId, handle);
  if (handleDup) {
    return NextResponse.json(
      { error: "Already tracked under this channel.", id: handleDup.id },
      { status: 409 }
    );
  }

  const id = addCompetitor({
    handle,
    channel_id: ucMatch ? ucMatch[1] : null,
    user_channel_id: userChannelId,
    tier: tier as CompetitorTier,
  });

  try {
    const result = await syncCompetitor(id);
    return NextResponse.json({ ok: true, id, ...result });
  } catch (err) {
    const message =
      err instanceof CompetitorSyncError || err instanceof Error
        ? err.message
        : "sync failed";
    log.error("competitors", `Initial sync failed for ${id}: ${message}`, err);
    return NextResponse.json(
      { ok: true, id, syncError: message },
      { status: 201 }
    );
  }
}

function toWire(c: Competitor) {
  return {
    id: c.id,
    channelId: c.channel_id,
    handle: c.handle,
    title: c.title,
    avatarUrl: c.avatar_url,
    subscriberCount: c.subscriber_count,
    videoCount: c.video_count,
    addedAt: c.added_at,
    lastSyncAt: c.last_sync_at,
    userChannelId: c.user_channel_id,
    tier: c.tier,
    tierSetAt: c.tier_set_at,
  };
}
