import "server-only";
import { apifyYouTubeScrape, type ApifyYouTubeVideo } from "./apify";
import {
  Competitor,
  competitorMedianViews,
  getCompetitor,
  getIntegration,
  recordCompetitorAlert,
  updateCompetitorAfterSync,
  upsertCompetitorVideo,
} from "./db";
import { log } from "./logger";
import { resolveChannel, YouTubeApiError } from "./youtube";

// Outlier threshold — when a video's views exceed median × this we flag it.
// Generation floor is 1.5×; the methodology canon (MENTOR_METHOD §2) stays
// at 2×. Why the gap: the Alerts tab UI lets the user filter by min
// multiplier (1.5×, 2×, 3×, 5×, 10×). If generation also stopped at 2× the
// 1.5× pill would always show 0 results. 1.5× generation + 2× default
// filter = methodology preserved at the surface, with an opt-in wider bucket.
const OUTLIER_MULTIPLIER = 1.5;

// How many videos to pull per sync. Apify charges per request, so we cap
// at 50 — covers most channels' recent activity without burning credits.
const VIDEOS_PER_SYNC = 50;

export class CompetitorSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompetitorSyncError";
  }
}

/**
 * Resolve various user-supplied identifiers (@handle, full URLs, plain
 * UCxxxxx) to a single canonical channel URL that Apify accepts.
 */
export function normaliseChannelUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new CompetitorSyncError("Empty channel identifier");
  if (/^https?:\/\//.test(trimmed)) return trimmed.replace(/\/+$/, "");
  if (trimmed.startsWith("@")) {
    return `https://www.youtube.com/${trimmed}`;
  }
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    return `https://www.youtube.com/channel/${trimmed}`;
  }
  // Bare handle without @ prefix.
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://www.youtube.com/@${trimmed}`;
  }
  throw new CompetitorSyncError(
    `Could not parse identifier "${input}". Pass a YouTube channel URL, @handle, or UC-id.`
  );
}

/** Parse Apify's duration string ("PT3M42S" or "3:42" or seconds) into seconds. */
function parseDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  // ISO 8601: PT3M42S
  const iso = raw.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (iso) {
    const [, h = "0", m = "0", s = "0"] = iso;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  // Colon-separated 3:42 or 1:03:42
  const parts = raw.split(":").map((p) => Number(p));
  if (parts.every((n) => Number.isFinite(n))) {
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function parseDate(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function extractVideoId(url: string | undefined, fallback: string | undefined): string | null {
  if (fallback) return fallback;
  if (!url) return null;
  // youtu.be/ID, watch?v=ID, /shorts/ID
  const m = url.match(/(?:youtu\.be\/|v=|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/**
 * Pull the competitor's latest videos via Apify, upsert them, and
 * promote any outliers (views ≥ median × OUTLIER_MULTIPLIER) into
 * alerts. Returns a small summary the UI can show after a sync.
 */
export async function syncCompetitor(competitorId: number): Promise<{
  videosSeen: number;
  videosInserted: number;
  newAlerts: number;
  channelTitle: string | null;
  medianViews: number;
}> {
  const competitor = getCompetitor(competitorId);
  if (!competitor) {
    throw new CompetitorSyncError(`Competitor ${competitorId} not found`);
  }
  const apifyKey = getIntegration("apify")?.api_key;
  if (!apifyKey) {
    throw new CompetitorSyncError(
      "Apify API key is not configured. Add it in Integrations to sync competitors."
    );
  }

  const url = competitor.channel_id
    ? `https://www.youtube.com/channel/${competitor.channel_id}`
    : competitor.handle
      ? normaliseChannelUrl(competitor.handle)
      : null;
  if (!url) {
    throw new CompetitorSyncError(
      `Competitor ${competitorId} has no channel identifier — re-add with a valid handle/URL.`
    );
  }

  log.info("competitors", "Syncing competitor", { competitorId, url });
  const startedAt = Date.now();
  const items: ApifyYouTubeVideo[] = await apifyYouTubeScrape(
    { startUrls: [{ url }], maxResults: VIDEOS_PER_SYNC, includeTranscript: false },
    apifyKey
  );

  // Pull channel metadata off the first item (Apify embeds channelName
  // / channelUrl on every video row). We don't fetch channel info
  // separately because the scraper already has it.
  const first = items[0];
  const channelTitle = first?.channelName ?? competitor.title ?? null;
  // ChannelUrl pattern: https://www.youtube.com/channel/UCxxx
  const channelIdMatch = first?.channelUrl?.match(/channel\/(UC[A-Za-z0-9_-]+)/);
  const resolvedChannelId = channelIdMatch ? channelIdMatch[1] : competitor.channel_id;

  let videosInserted = 0;
  for (const it of items) {
    const vid = extractVideoId(it.url, it.id);
    if (!vid || !it.title) continue;
    upsertCompetitorVideo({
      competitor_id: competitorId,
      video_id: vid,
      title: it.title,
      thumbnail_url: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
      views: it.viewCount ?? 0,
      likes: it.likes ?? 0,
      comments: it.commentsCount ?? 0,
      duration_seconds: parseDuration(it.duration),
      published_at: parseDate(it.date),
    });
    videosInserted++;
  }

  updateCompetitorAfterSync(competitorId, {
    title: channelTitle,
    channel_id: resolvedChannelId,
    video_count: videosInserted,
  });

  // Outlier scan — must run AFTER inserts so median includes the new rows.
  const median = competitorMedianViews(competitorId);
  let newAlerts = 0;
  if (median > 0) {
    for (const it of items) {
      const vid = extractVideoId(it.url, it.id);
      if (!vid || !it.title || !it.viewCount) continue;
      const multiplier = it.viewCount / median;
      if (multiplier >= OUTLIER_MULTIPLIER) {
        recordCompetitorAlert({
          competitor_id: competitorId,
          video_id: vid,
          title: it.title,
          thumbnail_url: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
          views: it.viewCount,
          channel_median_views: median,
          multiplier: Math.round(multiplier * 10) / 10,
        });
        newAlerts++;
      }
    }
  }

  log.info("competitors", "Competitor sync done", {
    competitorId,
    videosSeen: items.length,
    videosInserted,
    newAlerts,
    medianViews: median,
    durationMs: Date.now() - startedAt,
  });

  return {
    videosSeen: items.length,
    videosInserted,
    newAlerts,
    channelTitle,
    medianViews: median,
  };
}

/**
 * Always-on YouTube Data API metadata enrichment. Layered on top of the
 * Apify sync (Apify still owns video lists + view counts; YT API owns
 * canonical channel metadata: title, subscriber count, video count, avatar).
 *
 * Safe to call repeatedly — overwrites the same DB columns each time.
 * Returns ok:false rather than throwing on any of:
 *   - competitor row missing
 *   - channel_id not yet resolved (Apify hasn't run / errored on add)
 *   - no YouTube Data API key configured
 *   - YouTube API error (4xx/5xx, network, channel not found)
 *
 * Quota cost: 1 unit per call (channels.list with a single UC-id).
 */
export type EnrichResult = {
  ok: boolean;
  fields: Partial<{
    subscriber_count: number | null;
    video_count: number | null;
    title: string | null;
    avatar_url: string | null;
    handle: string | null;
  }>;
  error?: string;
};

export async function enrichCompetitorMetadataFromYouTube(
  competitorId: number
): Promise<EnrichResult> {
  const comp = getCompetitor(competitorId);
  if (!comp) {
    return { ok: false, fields: {}, error: "competitor not found" };
  }
  if (!comp.channel_id) {
    // Handle-only entries until first Apify sync resolves the UC-id.
    return { ok: false, fields: {}, error: "no channel_id resolved yet" };
  }
  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    return { ok: false, fields: {}, error: "no YouTube Data API key configured" };
  }

  try {
    // resolveChannel called with a UC-id skips the search/handle lookup
    // and goes straight to channels.list — exactly 1 quota unit.
    const resolved = await resolveChannel(comp.channel_id, apiKey);

    // Log the raw shape we received so the next "subs not showing up"
    // report is a `tail -f` away rather than an investigation. Includes
    // the bits we actually consume; not the full payload (description
    // strings would bloat logs).
    log.info("competitors", `YT enrich ${comp.channel_id} resolved`, {
      title: resolved.title,
      subscribers: resolved.subscribers,
      videoCount: resolved.videoCount,
      hasThumbnail: !!resolved.thumbnail,
    });

    const fields: EnrichResult["fields"] = {
      title: resolved.title,
      subscriber_count: resolved.subscribers,
      video_count: resolved.videoCount,
      avatar_url: resolved.thumbnail,
    };
    // Handle protection: only overwrite a null local handle. Never clobber
    // a value the user typed in (custom URLs returned by YouTube can lag
    // by months when a creator updates their @handle).
    if (!comp.handle && resolved.handle) {
      fields.handle = resolved.handle.startsWith("@")
        ? resolved.handle
        : `@${resolved.handle}`;
    }

    updateCompetitorAfterSync(competitorId, fields as Partial<Competitor>);
    log.info("competitors", `YT enrich ${comp.channel_id}: 1 unit quota burned`);
    return { ok: true, fields };
  } catch (err) {
    const message =
      err instanceof YouTubeApiError || err instanceof Error
        ? err.message
        : "unknown error";
    log.warn(
      "competitors",
      `YT enrich ${comp.channel_id} failed (non-fatal): ${message}`
    );
    return { ok: false, fields: {}, error: message };
  }
}
