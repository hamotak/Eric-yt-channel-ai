import { NextResponse } from "next/server";
import {
  addCompetitorResolved,
  db,
  getActiveChannelId,
  getCompetitorByUserChannelAndHandle,
  getCompetitorByUserChannelAndYouTubeId,
  listCompetitors,
} from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 30;

const SELF_AS_COMPETITOR_ERROR =
  "This is your own channel — cannot add as competitor.";

function normalizeHandle(handle: string | null): string | null {
  const trimmed = handle?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function isActiveUserChannel(
  channelId: string | null,
  handle: string | null,
  activeChannelId: string
): boolean {
  // Multi-channel installs can intentionally use one owned channel as a
  // reference competitor for another owned channel. Only reject adding the
  // currently-active user channel to itself.
  if (channelId && channelId === activeChannelId) return true;

  const normalised = normalizeHandle(handle);
  if (!normalised) return false;

  const active = db
    .prepare(`SELECT handle FROM channels WHERE id = ?`)
    .get(activeChannelId) as { handle: string | null } | undefined;
  const activeHandle = normalizeHandle(active?.handle ?? null);
  return !!activeHandle && activeHandle.toLowerCase() === normalised.toLowerCase();
}

/**
 * GET /api/competitors
 *
 * Returns competitors scoped to the active channel. T2 strip: no metrics,
 * no tier/outlier/snapshot aggregates — just the fields the simplified
 * card needs.
 */
export async function GET(_req: Request) {
  const activeId = getActiveChannelId();
  if (!activeId) {
    return NextResponse.json({ competitors: [], activeChannelId: null });
  }
  const rows = listCompetitors(activeId);
  const competitors = rows.map((c) => ({
    id: c.id,
    channelId: c.channel_id,
    handle: c.handle,
    title: c.title,
    avatarUrl: c.avatar_url,
    subscriberCount: c.subscriber_count,
    note: c.note ?? null,
    addedAt: c.added_at,
  }));
  return NextResponse.json({ competitors, activeChannelId: activeId });
}

/**
 * POST /api/competitors
 *
 * Body: { resolved: { channel_id, channel_name, handle, thumbnail_url,
 *                     subscriber_count }, note? }
 *
 * The client first calls /api/competitors/resolve to fetch metadata from
 * YouTube Data API; the returned object is then posted here as `resolved`.
 * We do NOT re-call YT or queue any background sync — the row lands
 * fully populated with sync_status='synced'. The new pipeline pulls
 * competitor videos LIVE at ideation time (no per-competitor cache here).
 *
 * Guards:
 *   - T8 self-as-competitor (channel_id OR handle matches active user channel)
 *   - Pair-scoped dedup (already tracked under this user channel)
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = body as {
    resolved?: {
      channel_id?: unknown;
      channel_name?: unknown;
      handle?: unknown;
      thumbnail_url?: unknown;
      subscriber_count?: unknown;
    };
    note?: unknown;
  };

  const r = parsed.resolved;
  if (!r || typeof r !== "object") {
    return NextResponse.json(
      { error: "resolved object required — call /api/competitors/resolve first" },
      { status: 400 }
    );
  }
  const channelId = typeof r.channel_id === "string" ? r.channel_id.trim() : "";
  const channelName = typeof r.channel_name === "string" ? r.channel_name.trim() : "";
  const handle = typeof r.handle === "string" ? r.handle : null;
  const thumbnail = typeof r.thumbnail_url === "string" ? r.thumbnail_url : null;
  const subscriberCount =
    typeof r.subscriber_count === "number" ? r.subscriber_count : null;
  const note = typeof parsed.note === "string" ? parsed.note.trim() : null;

  if (!channelId || !channelName) {
    return NextResponse.json(
      { error: "resolved.channel_id and resolved.channel_name required" },
      { status: 400 }
    );
  }
  if (!/^UC[A-Za-z0-9_-]{20,24}$/.test(channelId)) {
    return NextResponse.json(
      { error: `resolved.channel_id is not a valid YouTube channel ID: ${channelId}` },
      { status: 400 }
    );
  }

  const userChannelId = getActiveChannelId();
  if (!userChannelId) {
    return NextResponse.json(
      { error: "no active channel — connect one from the top-right channel switcher" },
      { status: 400 }
    );
  }

  // T8: self-as-competitor guard. Other owned channels are allowed here
  // because they may be useful reference channels for the active channel.
  if (isActiveUserChannel(channelId, handle, userChannelId)) {
    return NextResponse.json(
      { error: SELF_AS_COMPETITOR_ERROR },
      { status: 400 }
    );
  }

  // Pair-scoped dedup: already tracked under this user channel?
  const dupById = getCompetitorByUserChannelAndYouTubeId(userChannelId, channelId);
  if (dupById) {
    return NextResponse.json(
      { error: "Already tracked under this channel.", id: dupById.id },
      { status: 409 }
    );
  }
  if (handle) {
    const dupByHandle = getCompetitorByUserChannelAndHandle(userChannelId, handle);
    if (dupByHandle) {
      return NextResponse.json(
        { error: "Already tracked under this channel.", id: dupByHandle.id },
        { status: 409 }
      );
    }
  }

  const id = addCompetitorResolved({
    user_channel_id: userChannelId,
    channel_id: channelId,
    handle,
    title: channelName,
    avatar_url: thumbnail,
    subscriber_count: subscriberCount,
    note,
  });

  return NextResponse.json({
    ok: true,
    competitor: {
      id,
      channelId,
      handle,
      title: channelName,
      avatarUrl: thumbnail,
      subscriberCount: subscriberCount,
      note,
    },
  });
}
