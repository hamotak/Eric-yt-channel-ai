import { NextResponse } from "next/server";
import {
  addCompetitor,
  COMPETITOR_TIERS,
  Competitor,
  CompetitorMetrics,
  competitorListKpis,
  competitorMetricsByCompetitor,
  CompetitorTier,
  countCompetitorsInFlight,
  countUnassignedCompetitors,
  getActiveChannelId,
  getCompetitorByUserChannelAndHandle,
  getCompetitorByUserChannelAndYouTubeId,
  isCompetitorTier,
  listAllChannels,
  listCompetitors,
  unreadCompetitorAlertCount,
} from "@/lib/db";
import { normaliseChannelUrl } from "@/lib/competitor-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/competitors
 *   - no param          → every row (used by the migration banner view)
 *   - ?userChannelId=X  → only competitors owned by user channel X
 *   - ?userChannelId=unassigned → only rows with user_channel_id IS NULL
 *
 * Response also carries:
 *   - unreadAlerts:    unread alert count scoped to the active user channel
 *   - unassignedCount: total NULL-user_channel_id rows — drives the migration banner
 *   - kpis:            top-strip aggregates (competitors, lastSync)
 *   - inFlight:        number of (queued + syncing) rows in the active scope
 *                      — the client uses this to decide whether to keep polling
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const param = url.searchParams.get("userChannelId");
  let scope: string | "unassigned" | undefined;
  if (param === "unassigned") scope = "unassigned";
  else if (typeof param === "string" && param.length > 0) scope = param;

  const competitors = listCompetitors(scope);
  const activeId = getActiveChannelId();
  const metricsScope =
    scope === "unassigned" ? null : (scope ?? activeId ?? null);
  const metricsMap = competitorMetricsByCompetitor(metricsScope);
  const kpis = competitorListKpis(activeId);
  const inFlight = countCompetitorsInFlight(metricsScope);

  return NextResponse.json({
    competitors: competitors.map((c) => toWire(c, metricsMap.get(c.id))),
    unreadAlerts: unreadCompetitorAlertCount(activeId),
    unassignedCount: countUnassignedCompetitors(),
    kpis,
    inFlight,
  });
}

/**
 * POST /api/competitors
 *
 * Body: { identifier, userChannelId, tier }
 *
 * Async flow:
 *   1. Validate input + dedup (same as before).
 *   2. INSERT the row with sync_status='queued' (addCompetitor default).
 *   3. Fire-and-forget a POST to /api/competitors/sync-queued — the worker
 *      picks up the queued row (sequentially, lock-guarded) and drains
 *      the queue.
 *   4. Return 202 immediately so the client can stop showing the spinner
 *      and start polling GET /api/competitors instead.
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
      { error: `tier must be one of: ${COMPETITOR_TIERS.join(", ")}` },
      { status: 400 }
    );
  }
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

  // Pair-scoped dedup guards (same as before — must run before the INSERT).
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

  // Fire-and-forget kick to the worker. We do NOT await — the response
  // returns 202 immediately. The worker self-locks via settings flag, so
  // duplicate kicks are safe; an offline worker just means the row sits
  // queued until the next /sync-queued POST (which the client also issues
  // when the page mounts with queued rows).
  void kickWorker(req).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[competitors] worker kick failed (non-fatal):", err);
  });

  return NextResponse.json(
    { ok: true, id, queued: true },
    { status: 202 }
  );
}

async function kickWorker(req: Request): Promise<void> {
  const origin = new URL(req.url).origin;
  await fetch(`${origin}/api/competitors/sync-queued`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    cache: "no-store",
  });
}

function toWire(c: Competitor, metrics?: CompetitorMetrics) {
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
    syncStatus: c.sync_status,
    syncError: c.sync_error,
    similarityScore: c.similarity_score,
    outliers30d: metrics?.outliers30d ?? 0,
    medianViews30d: metrics?.medianViews30d ?? null,
    lastUploadAt: metrics?.lastUploadAt ?? null,
    recentVideoViews: metrics?.recentVideoViews ?? [],
    views7d: metrics?.views7d ?? 0,
    views28d: metrics?.views28d ?? 0,
    views90d: metrics?.views90d ?? 0,
  };
}

