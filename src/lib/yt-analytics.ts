import "server-only";
import { getValidAccessToken } from "./google-oauth";
import { getSetting, setSetting } from "./db";
import { log } from "./logger";

/**
 * Resolve the channel ID we should query against. We always prefer the
 * `youtube.channelId` saved at sync time over `channel==MINE`, because:
 *   - `MINE` resolves to the OAuth user's PRIMARY channel, which is rarely
 *     what we want when the user is a Manager on someone else's channel
 *     (their personal account has its own toy channel with a handful of
 *     views — that's the data Google would return).
 *   - `channel==UCxxx` works as long as the OAuth user has any access role
 *     (Manager / Editor / Owner) to that channel.
 * Fallback to MINE if we somehow don't know the channel id (e.g. user
 * connected OAuth before binding a channel).
 */
function resolveChannelIds(): string {
  const cid = getSetting("youtube.channelId");
  return cid ? `channel==${cid}` : "channel==MINE";
}

/**
 * Thin wrapper around YouTube Analytics API v2 (`/youtubeAnalytics/v2/reports`).
 *
 * Why thin: the API has dozens of dimensions × metrics × filters
 * combinations and we don't need a full SDK. We expose `runReport()` that
 * takes the raw query params, plus a few high-level helpers
 * (`fetchChannelOverview`, `fetchTopVideos`, etc.) for the patterns we
 * actually render in UI.
 *
 * Important data caveats baked in:
 *   - Google's analytics pipeline lags ~24-48h. Asking for "today" returns
 *     stale or zero data. Our helpers default `endDate` to today-2.
 *   - Revenue metrics (estimatedRevenue, cpm, rpm) require the
 *     `yt-analytics-monetary.readonly` scope AND Owner-tier access at the
 *     channel level. Manager tier gets a 403 even with the scope. We catch
 *     that and remember it so the UI can hide revenue panels.
 */

const BASE = "https://youtubeanalytics.googleapis.com/v2/reports";

export class YtAnalyticsError extends Error {
  constructor(public status: number, message: string, public reason?: string) {
    super(message);
    this.name = "YtAnalyticsError";
  }
}

/**
 * Whether we've observed a "monetary access denied" response from Google
 * for the *current* channel. Stored per-channel because multi-channel
 * users very often have a mix: e.g. main channel is Owner-tier (monetary
 * access works), twink/test channel has no monetization or only Manager
 * access (returns 403). A global flag would tag every channel as denied
 * after the first 403, which is exactly the bug the user hit.
 *
 * Falls back to the legacy single-tenant key so existing installs don't
 * lose their flag during the transition.
 */
function revenueAccessKeyFor(channelId: string | null): string {
  return channelId
    ? `analytics.revenueAccess.${channelId}`
    : "analytics.revenueAccess";
}

function activeChannelIdForFlag(): string | null {
  // Read directly from settings (rather than importing getActiveChannelId)
  // to keep this module self-contained — getSetting is already imported.
  return getSetting("youtube.activeChannelId") || getSetting("youtube.channelId") || null;
}

export function getRevenueAccessFlag(channelId?: string): "allowed" | "denied" | "unknown" {
  const id = channelId ?? activeChannelIdForFlag();
  // Per-channel key takes precedence. CRITICAL: do NOT fall back to the
  // legacy global "analytics.revenueAccess" key when a channel id is in
  // scope — that's exactly what poisoned the user's experience (channel
  // B getting 403 once would leave the global key set to "denied", and
  // every other channel would inherit that denial via the fallback).
  // The legacy key is only consulted when no channel id is supplied at
  // all, e.g. by tooling that pre-dates multi-channel.
  if (id) {
    const v = getSetting(revenueAccessKeyFor(id));
    if (v === "allowed" || v === "denied") return v;
    return "unknown";
  }
  const legacy = getSetting("analytics.revenueAccess");
  if (legacy === "allowed" || legacy === "denied") return legacy;
  return "unknown";
}

function setRevenueAccessFlag(v: "allowed" | "denied", channelId?: string): void {
  const id = channelId ?? activeChannelIdForFlag();
  setSetting(revenueAccessKeyFor(id), v);
}

/** Format YYYY-MM-DD in UTC. The Analytics API expects UTC dates. */
export function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today minus N days as a UTC YYYY-MM-DD. */
export function daysAgo(n: number): string {
  return ymd(new Date(Date.now() - n * 86400_000));
}

export type ReportQuery = {
  /** Channel scope. "MINE" = the authenticated user's own channel. Or "channel==<UC...>". */
  ids?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  metrics: string[]; // e.g. ["views", "estimatedMinutesWatched"]
  dimensions?: string[]; // e.g. ["day"]
  filters?: string; // e.g. "video==abc123"
  sort?: string; // e.g. "-views"
  maxResults?: number;
  /** Tag this report as monetary so we can flip the access flag on 403. */
  isMonetary?: boolean;
};

export type ReportResponse = {
  columnHeaders: { name: string; columnType: string; dataType: string }[];
  rows: (string | number)[][];
};

export async function runReport(q: ReportQuery): Promise<ReportResponse> {
  // Per-channel OAuth: pull the channel id out of `q.ids` (form
  // "channel==UCxxx") and use that channel's tokens if it has its own
  // OAuth slot. Falls back to the global slot via getValidAccessToken's
  // own fallback. This is what makes "different Google account per
  // channel" work — Channel A might be on cupak3002@gmail.com while
  // Channel B is on a brand account.
  const ids = q.ids ?? resolveChannelIds();
  const cidMatch = ids.match(/channel==([\w-]+)/);
  const accessToken = await getValidAccessToken(cidMatch?.[1] ?? null);

  const url = new URL(BASE);
  // Always target the bound channel (e.g. "channel==UCxxx") instead of
  // the OAuth user's MINE — see resolveChannelIds() comment for why.
  url.searchParams.set("ids", ids);
  url.searchParams.set("startDate", q.startDate);
  url.searchParams.set("endDate", q.endDate);
  url.searchParams.set("metrics", q.metrics.join(","));
  if (q.dimensions?.length) url.searchParams.set("dimensions", q.dimensions.join(","));
  if (q.filters) url.searchParams.set("filters", q.filters);
  if (q.sort) url.searchParams.set("sort", q.sort);
  if (q.maxResults) url.searchParams.set("maxResults", String(q.maxResults));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    cache: "no-store",
  });

  if (!res.ok) {
    let reason: string | undefined;
    let detail = "";
    try {
      const body = (await res.json()) as {
        error?: { message?: string; errors?: { reason?: string }[] };
      };
      detail = body.error?.message ?? "";
      reason = body.error?.errors?.[0]?.reason;
    } catch {
      /* ignore parse fail */
    }

    // Sticky-detect monetary access denial. Manager-tier accounts return 403
    // with "insufficientPermissions" / "accessDenied" the first time we ask
    // for revenue metrics. After that we don't bother trying.
    // Channel-scoped: extract the channel id from the explicit ids
    // parameter if present (e.g. "channel==UCxxx"), else fall back to
    // active channel. Otherwise a 403 on Channel B would falsely tag
    // Channel A as denied too.
    if (q.isMonetary && (res.status === 403 || res.status === 401)) {
      const cidMatch = q.ids?.match(/channel==([\w-]+)/);
      setRevenueAccessFlag("denied", cidMatch?.[1]);
      log.warn("yt-analytics", "Monetary access denied — flag set to 'denied'", {
        status: res.status,
        reason,
        channelId: cidMatch?.[1] ?? "(active)",
      });
    }

    log.warn("yt-analytics", `Report failed (${res.status})`, {
      query: q,
      reason,
      detail,
    });
    throw new YtAnalyticsError(
      res.status,
      `YouTube Analytics ${res.status}: ${detail || res.statusText}`,
      reason
    );
  }

  if (q.isMonetary) {
    // Successful monetary report — flag the matching channel as allowed.
    const cidMatch = q.ids?.match(/channel==([\w-]+)/);
    setRevenueAccessFlag("allowed", cidMatch?.[1]);
  }

  const data = (await res.json()) as ReportResponse;
  return data;
}

/* ===================== High-level helpers ===================== */

/**
 * Channel overview metrics aggregated for a given period vs the preceding
 * period of equal length. Returns totals + day-by-day arrays for charting.
 *
 * The "preceding period" comparison is what Studio shows as "last 28 days vs
 * previous 28 days" with a Δ% number — we compute it the same way.
 */
export type OverviewBundle = {
  period: { startDate: string; endDate: string; days: number };
  totals: {
    views: number;
    watchMinutes: number;
    avgViewDurationSec: number;
    subscribersGained: number;
    subscribersLost: number;
    netSubscribers: number;
    likes: number;
    comments: number;
    shares: number;
  };
  /** Same metrics for the equally-sized period immediately before — used
   * for Δ% calculations. Null if the prior period would extend before the
   * channel even existed (e.g. brand new channel). */
  previousTotals: OverviewBundle["totals"] | null;
  /** Time series — one row per day in chronological order. */
  daily: {
    date: string;
    views: number;
    watchMinutes: number;
    subscribersGained: number;
    subscribersLost: number;
  }[];
};

const OVERVIEW_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "subscribersGained",
  "subscribersLost",
  "likes",
  "comments",
  "shares",
];

const DAILY_METRICS = ["views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost"];

/**
 * Lag from "now" we use as the effective endDate. YouTube's analytics
 * pipeline takes ~24-48h to settle, so asking for `today` returns near-zero
 * numbers that scare users. Day-2 is a reasonable conservative cut-off.
 */
const ANALYTICS_LAG_DAYS = 2;

/**
 * Earliest date we'll ever query when the user picks "All time". YouTube
 * was founded in February 2005 — anything earlier is meaningless. The API
 * silently returns zero rows for dates before the channel's creation, so
 * this is safe to use as a universal floor.
 */
const ANCIENT_START = "2005-01-01";

/** Period parameter — either a fixed number of days, or `"all"` for the
 * full channel lifetime (since 2005-01-01 → today−2). */
export type PeriodSpec = number | "all";

/** Resolves a period spec to concrete startDate / endDate / actualDays.
 * For `"all"` we skip the previous-period comparison since there's nothing
 * meaningful to compare against. */
function resolvePeriod(period: PeriodSpec): {
  startDate: string;
  endDate: string;
  actualDays: number;
  prev: { startDate: string; endDate: string } | null;
} {
  const endDate = daysAgo(ANALYTICS_LAG_DAYS);
  if (period === "all") {
    const ms = new Date(endDate).getTime() - new Date(ANCIENT_START).getTime();
    return {
      startDate: ANCIENT_START,
      endDate,
      actualDays: Math.max(1, Math.round(ms / 86400_000)),
      prev: null,
    };
  }
  const startDate = daysAgo(ANALYTICS_LAG_DAYS + period - 1);
  const prevEnd = daysAgo(ANALYTICS_LAG_DAYS + period);
  const prevStart = daysAgo(ANALYTICS_LAG_DAYS + period * 2 - 1);
  return {
    startDate,
    endDate,
    actualDays: period,
    prev: { startDate: prevStart, endDate: prevEnd },
  };
}

export async function fetchChannelOverview(period: PeriodSpec): Promise<OverviewBundle> {
  const { startDate, endDate, actualDays, prev } = resolvePeriod(period);

  // 1. Totals for current + previous period (parallel when prev exists).
  const [curRes, prevRes] = await Promise.all([
    runReport({ startDate, endDate, metrics: OVERVIEW_METRICS }),
    prev
      ? runReport({
          startDate: prev.startDate,
          endDate: prev.endDate,
          metrics: OVERVIEW_METRICS,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const cur = parseTotalsRow(curRes, OVERVIEW_METRICS);
  const prevTotals = prevRes ? parseTotalsRow(prevRes, OVERVIEW_METRICS) : null;

  // 2. Daily time series for charts.
  const dailyRes = await runReport({
    startDate,
    endDate,
    metrics: DAILY_METRICS,
    dimensions: ["day"],
    sort: "day",
  });
  const dailyIdx = headerIndex(dailyRes, DAILY_METRICS);
  const daily = (dailyRes.rows ?? []).map((row) => ({
    date: String(row[0]),
    views: Number(row[dailyIdx.views]) || 0,
    watchMinutes: Number(row[dailyIdx.estimatedMinutesWatched]) || 0,
    subscribersGained: Number(row[dailyIdx.subscribersGained]) || 0,
    subscribersLost: Number(row[dailyIdx.subscribersLost]) || 0,
  }));

  return {
    period: { startDate, endDate, days: actualDays },
    totals: makeTotals(cur),
    previousTotals: prevTotals ? makeTotals(prevTotals) : null,
    daily,
  };
}

/** Top-N videos in the period by chosen metric. */
export type TopVideoRow = {
  videoId: string;
  views: number;
  watchMinutes: number;
  avgViewDurationSec: number;
  /** Folded in by the API route from local cache so the UI doesn't have
   *  to render raw videoIds. Optional because the wrapper itself only
   *  knows what the analytics API returns. */
  title?: string;
  thumbnail?: string | null;
};

export async function fetchTopVideos(
  period: PeriodSpec,
  limit = 10,
  sortBy: "views" | "estimatedMinutesWatched" | "averageViewDuration" = "views"
): Promise<TopVideoRow[]> {
  const { startDate, endDate } = resolvePeriod(period);

  const metrics = ["views", "estimatedMinutesWatched", "averageViewDuration"];
  const res = await runReport({
    startDate,
    endDate,
    metrics,
    dimensions: ["video"],
    sort: `-${sortBy}`,
    maxResults: limit,
  });
  const idx = headerIndex(res, metrics);
  return (res.rows ?? []).map((row) => ({
    videoId: String(row[0]),
    views: Number(row[idx.views]) || 0,
    watchMinutes: Number(row[idx.estimatedMinutesWatched]) || 0,
    avgViewDurationSec: Number(row[idx.averageViewDuration]) || 0,
  }));
}

/* ===================== Per-video analytics ===================== */

export type VideoAnalyticsBundle = {
  videoId: string;
  period: { startDate: string; endDate: string; days: number };
  totals: {
    views: number;
    watchMinutes: number;
    avgViewDurationSec: number;
    likes: number;
    comments: number;
    shares: number;
    subscribersGained: number;
    subscribersLost: number;
    averageViewPercentage: number; // 0..100, what % of video the avg viewer watches
    videosAddedToPlaylists: number;
    videosRemovedFromPlaylists: number;
  };
  /** Card performance — overlay-card impressions / clicks / CTR.
   * Null when the video has no cards or the API doesn't return data. */
  cards: { impressions: number; clicks: number; ctr: number } | null;
  /** End-screen element performance. Same nullability as cards. */
  endScreen: { impressions: number; clicks: number; ctr: number } | null;
  /** Per-day time series with 6 metrics. UI lets the user pick which one
   * to chart so we keep them all server-side rather than refetching. */
  daily: {
    date: string;
    views: number;
    watchMinutes: number;
    likes: number;
    comments: number;
    subscribersGained: number;
    subscribersLost: number;
  }[];
  /** Audience retention curve. Points sampled at percentage-of-video
   * positions (0..100). Each point is the fraction of original viewers
   * still watching at that moment. Studio's retention chart uses the
   * exact same source data. */
  retention: { ratio: number; audienceRetention: number; relativeRetention: number }[];
  /** Where the viewers came from. Source types are YouTube's enums:
   * YT_SEARCH, SUGGESTED_VIDEO, EXTERNAL, BROWSE, PLAYLIST, NOTIFICATION, etc. */
  trafficSources: { source: string; views: number; watchMinutes: number }[];
  /** Where the video was actually played: WATCH (the YouTube watch page),
   * EMBEDDED (third-party sites), CHANNEL (your channel page), SEARCH,
   * EXTERNAL_APP, MOBILE (legacy mobile), YT_OTHER, SHORTS. */
  playbackLocations: { location: string; views: number; watchMinutes: number }[];
  /** Top YouTube search keywords that led to this video. Goldmine for SEO
   * decisions on new uploads. May be empty if the video doesn't get much
   * search traffic. */
  searchTerms: { term: string; views: number }[];
  /** Where viewers shared the video. e.g. TWITTER, WHATSAPP, REDDIT. */
  sharingServices: { service: string; shares: number }[];
  /** Operating system breakdown — complements `geography` for ad/thumbnail
   * optimisation choices. */
  operatingSystems: { os: string; views: number }[];
  /** Subscribed-vs-not breakdown. Tells you whether this video is hitting
   * your existing audience or pulling new viewers via discovery. */
  subscribedStatus: {
    status: string;
    views: number;
    watchMinutes: number;
    avgViewDurationSec: number;
  }[];
  /** Demographic breakdown. `viewerPercentage` is in percent (0..100) within
   * each (age, gender) bucket — sums to ~100 across all rows. */
  demographics: { ageGroup: string; gender: string; viewerPercentage: number }[];
  /** Top countries by views. ISO-3166-1 alpha-2 codes (US, UA, GB, ...). */
  geography: { country: string; views: number; watchMinutes: number }[];
  /** This video vs channel-wide averages over the same period. Lets the
   * user (and Claude) see "this video gets 2.3× the channel's typical
   * views". `null` if we can't compute (e.g. brand-new channel). */
  vsChannelAverage: {
    avgChannelViewsPerVideo: number;
    avgChannelWatchMinutesPerVideo: number;
    avgChannelViewDurationSec: number;
    viewsRatio: number; // this video / channel-avg, 1.0 = average
    watchTimeRatio: number;
    durationRatio: number;
  } | null;
  /** Per-video monetary numbers. Null when the channel has no monetary
   *  access (Manager tier / non-monetised) or when the API call 403s. */
  revenue: {
    estimatedRevenue: number;
    estimatedAdRevenue: number;
    estimatedRedPartnerRevenue: number;
    grossRevenue: number;
    cpm: number;
    playbackBasedCpm: number;
    monetizedPlaybacks: number;
    adImpressions: number;
  } | null;
};

const VIDEO_TOTALS_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "likes",
  "comments",
  "shares",
  "subscribersGained",
  "subscribersLost",
  "videosAddedToPlaylists",
  "videosRemovedFromPlaylists",
];

/** Card performance — overlay teasers/cards layered on the video. */
const CARD_METRICS = [
  "cardImpressions",
  "cardClicks",
  "cardClickRate",
];

/** End-screen elements appear in the last 5-20 seconds. */
const ENDSCREEN_METRICS = [
  "endScreenElementImpressions",
  "endScreenElementClicks",
  "endScreenElementClickRate",
];

const VIDEO_DAILY_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "likes",
  "comments",
  "subscribersGained",
  "subscribersLost",
];

/** Channel-wide average per-video baseline used for the "vs channel" comparison.
 * We pull total channel views/watch and divide by video count from the same
 * period — that gives us a ratio against typical performance. */
async function fetchChannelAverages(
  startDate: string,
  endDate: string,
  channelId?: string | null
): Promise<{ avgViews: number; avgWatchMin: number; avgDuration: number } | null> {
  // Same multi-channel rationale as fetchVideoAnalytics — pin to the
  // specific channel so the comparison is correct when this is invoked
  // from a per-video page where the video belongs to a non-active
  // channel.
  const ids = channelId ? `channel==${channelId}` : undefined;
  try {
    const res = await runReport({
      ids,
      startDate,
      endDate,
      metrics: ["views", "estimatedMinutesWatched", "averageViewDuration"],
    });
    const idx = headerIndex(res, ["views", "estimatedMinutesWatched", "averageViewDuration"]);
    const row = res.rows?.[0] ?? [];
    const channelViews = Number(row[idx.views]) || 0;
    const channelWatch = Number(row[idx.estimatedMinutesWatched]) || 0;
    const avgDuration = Number(row[idx.averageViewDuration]) || 0;

    // Count videos active in this period — gives us the denominator.
    // Use a separate report that lists videos via dimension=video.
    const countRes = await runReport({
      ids,
      startDate,
      endDate,
      metrics: ["views"],
      dimensions: ["video"],
      maxResults: 200,
    });
    const videoCount = countRes.rows?.length ?? 0;
    if (videoCount === 0) return null;

    return {
      avgViews: Math.round(channelViews / videoCount),
      avgWatchMin: Math.round(channelWatch / videoCount),
      avgDuration: Math.round(avgDuration),
    };
  } catch {
    return null;
  }
}

/**
 * Pull everything we need for a per-video analytics tab in 5 parallel
 * report calls. Reports that fail individually (e.g. demographics 403 on
 * very small audiences) downgrade to empty arrays — the panel still
 * renders the parts that came back.
 */
export async function fetchVideoAnalytics(
  videoId: string,
  period: PeriodSpec,
  channelId?: string | null
): Promise<VideoAnalyticsBundle> {
  const { startDate, endDate, actualDays } = resolvePeriod(period);
  const filter = `video==${videoId}`;
  // Pinning every sub-report to the video's owner channel (when known)
  // is critical for multi-channel installs — `runReport`'s default is
  // to read whichever channel is currently active, and a video on a
  // *different* channel would silently return zero rows. With `ids`
  // supplied, runReport also picks the matching per-channel OAuth slot.
  const ids = channelId ? `channel==${channelId}` : undefined;

  // Soft-fail wrapper so a single bad sub-report doesn't kill the whole bundle.
  const soft = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      log.warn("yt-analytics", `Video sub-report failed (soft)`, {
        videoId,
        error: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    }
  };

  const empty: ReportResponse = { columnHeaders: [], rows: [] };

  // 12 parallel reports. They share the same OAuth quota bucket but YouTube
  // Analytics rate-limits per project, not per-call; we comfortably stay
  // inside it. Each soft-fail returns empty rather than killing the whole
  // panel — e.g. cards return 400 if the video has no cards configured.
  const [
    totalsRes,
    dailyRes,
    retentionRes,
    sourcesRes,
    demoRes,
    geoRes,
    cardsRes,
    endScreenRes,
    playbackRes,
    searchRes,
    sharingRes,
    osRes,
    subStatusRes,
    channelAverages,
  ] = await Promise.all([
    runReport({ ids, startDate, endDate, metrics: VIDEO_TOTALS_METRICS, filters: filter }),
    runReport({
      ids,
      startDate,
      endDate,
      metrics: VIDEO_DAILY_METRICS,
      dimensions: ["day"],
      filters: filter,
      sort: "day",
    }),
    soft(
      () =>
        runReport({
          ids,
          startDate,
          endDate,
          // Retention data has its own metric names — `audienceWatchRatio`
          // is "% of viewers still watching at this point", and
          // `relativeRetention` compares to YouTube average.
          metrics: ["audienceWatchRatio", "relativeRetention"],
          dimensions: ["elapsedVideoTimeRatio"],
          filters: filter,
        }),
      empty
    ),
    soft(
      () =>
        runReport({
          ids,
          startDate,
          endDate,
          metrics: ["views", "estimatedMinutesWatched"],
          dimensions: ["insightTrafficSourceType"],
          filters: filter,
          sort: "-views",
        }),
      empty
    ),
    soft(
      () =>
        runReport({
          ids,
          startDate,
          endDate,
          metrics: ["viewerPercentage"],
          dimensions: ["ageGroup", "gender"],
          filters: filter,
        }),
      empty
    ),
    soft(
      () =>
        runReport({
          ids,
          startDate,
          endDate,
          metrics: ["views", "estimatedMinutesWatched"],
          dimensions: ["country"],
          filters: filter,
          sort: "-views",
          maxResults: 15,
        }),
      empty
    ),
    // Cards (overlay teasers). 400-errors silently if video has no cards.
    soft(
      () => runReport({ ids, startDate, endDate, metrics: CARD_METRICS, filters: filter }),
      empty
    ),
    // End-screen elements (last 5-20s of video).
    soft(
      () => runReport({ ids, startDate, endDate, metrics: ENDSCREEN_METRICS, filters: filter }),
      empty
    ),
    // Where the video was actually played: WATCH page, EMBEDDED, etc.
    soft(
      () =>
        runReport({
          ids,
          startDate,
          endDate,
          metrics: ["views", "estimatedMinutesWatched"],
          dimensions: ["insightPlaybackLocationType"],
          filters: filter,
          sort: "-views",
        }),
      empty
    ),
    // Top YouTube search keywords driving traffic to this video.
    // Filter combines the per-video filter with the YT_SEARCH source.
    soft(
      () =>
        runReport({
          ids,
          startDate,
          endDate,
          metrics: ["views"],
          dimensions: ["insightTrafficSourceDetail"],
          filters: `${filter};insightTrafficSourceType==YT_SEARCH`,
          sort: "-views",
          maxResults: 15,
        }),
      empty
    ),
    // Where the video was shared (Twitter, WhatsApp, Reddit, etc.).
    soft(
      () =>
        runReport({
          ids,
          startDate,
          endDate,
          metrics: ["shares"],
          dimensions: ["sharingService"],
          filters: filter,
          sort: "-shares",
          maxResults: 10,
        }),
      empty
    ),
    // OS breakdown — complements devices.
    soft(
      () =>
        runReport({
          ids,
          startDate,
          endDate,
          metrics: ["views"],
          dimensions: ["operatingSystem"],
          filters: filter,
          sort: "-views",
          maxResults: 8,
        }),
      empty
    ),
    // Subscribed vs non-subscribed viewers.
    soft(
      () =>
        runReport({
          ids,
          startDate,
          endDate,
          metrics: ["views", "estimatedMinutesWatched", "averageViewDuration"],
          dimensions: ["subscribedStatus"],
          filters: filter,
        }),
      empty
    ),
    // Channel-wide per-video averages for the "vs channel" comparison.
    // Scoped to the same channel as the video so we compare apples to
    // apples in multi-channel installs.
    fetchChannelAverages(startDate, endDate, channelId),
  ]);

  // Monetary report runs sequentially after the rest because we want to
  // soft-fail it on 403 (Manager tier / non-monetised channel) without
  // tripping the parent Promise.all rejection.
  const revenueRes = await soft(
    () =>
      runReport({
        ids,
        startDate,
        endDate,
        metrics: REVENUE_METRICS,
        filters: filter,
        isMonetary: true,
      }),
    empty
  );

  const totals = parseTotalsRow(totalsRes, VIDEO_TOTALS_METRICS);

  const dailyIdx = headerIndex(dailyRes, VIDEO_DAILY_METRICS);
  const daily = (dailyRes.rows ?? []).map((row) => ({
    date: String(row[0]),
    views: Number(row[dailyIdx.views]) || 0,
    watchMinutes: Number(row[dailyIdx.estimatedMinutesWatched]) || 0,
    likes: Number(row[dailyIdx.likes]) || 0,
    comments: Number(row[dailyIdx.comments]) || 0,
    subscribersGained: Number(row[dailyIdx.subscribersGained]) || 0,
    subscribersLost: Number(row[dailyIdx.subscribersLost]) || 0,
  }));

  const retention = (retentionRes.rows ?? []).map((row) => ({
    ratio: Number(row[0]) || 0,
    audienceRetention: Number(row[1]) || 0,
    relativeRetention: Number(row[2]) || 0,
  }));

  const trafficSources = (sourcesRes.rows ?? []).map((row) => ({
    source: String(row[0]),
    views: Number(row[1]) || 0,
    watchMinutes: Number(row[2]) || 0,
  }));

  const demographics = (demoRes.rows ?? []).map((row) => ({
    ageGroup: String(row[0]),
    gender: String(row[1]),
    viewerPercentage: Number(row[2]) || 0,
  }));

  const geography = (geoRes.rows ?? []).map((row) => ({
    country: String(row[0]),
    views: Number(row[1]) || 0,
    watchMinutes: Number(row[2]) || 0,
  }));

  // Cards / End-screen — both have a single row of totals; null if empty.
  const cardsTotals = parseTotalsRow(cardsRes, CARD_METRICS);
  const cards =
    cardsRes.rows && cardsRes.rows.length > 0
      ? {
          impressions: Math.round(cardsTotals.cardImpressions ?? 0),
          clicks: Math.round(cardsTotals.cardClicks ?? 0),
          ctr: Number((cardsTotals.cardClickRate ?? 0).toFixed(2)),
        }
      : null;

  const endTotals = parseTotalsRow(endScreenRes, ENDSCREEN_METRICS);
  const endScreen =
    endScreenRes.rows && endScreenRes.rows.length > 0
      ? {
          impressions: Math.round(endTotals.endScreenElementImpressions ?? 0),
          clicks: Math.round(endTotals.endScreenElementClicks ?? 0),
          ctr: Number((endTotals.endScreenElementClickRate ?? 0).toFixed(2)),
        }
      : null;

  const playbackLocations = (playbackRes.rows ?? []).map((row) => ({
    location: String(row[0]),
    views: Number(row[1]) || 0,
    watchMinutes: Number(row[2]) || 0,
  }));

  const searchTerms = (searchRes.rows ?? []).map((row) => ({
    term: String(row[0]),
    views: Number(row[1]) || 0,
  }));

  const sharingServices = (sharingRes.rows ?? []).map((row) => ({
    service: String(row[0]),
    shares: Number(row[1]) || 0,
  }));

  const operatingSystems = (osRes.rows ?? []).map((row) => ({
    os: String(row[0]),
    views: Number(row[1]) || 0,
  }));

  const subscribedStatus = (subStatusRes.rows ?? []).map((row) => ({
    status: String(row[0]),
    views: Number(row[1]) || 0,
    watchMinutes: Math.round(Number(row[2]) || 0),
    avgViewDurationSec: Math.round(Number(row[3]) || 0),
  }));

  const videoViews = totals.views ?? 0;
  const videoWatch = Math.round(totals.estimatedMinutesWatched ?? 0);
  const videoDur = Math.round(totals.averageViewDuration ?? 0);

  const vsChannelAverage = channelAverages
    ? {
        avgChannelViewsPerVideo: channelAverages.avgViews,
        avgChannelWatchMinutesPerVideo: channelAverages.avgWatchMin,
        avgChannelViewDurationSec: channelAverages.avgDuration,
        viewsRatio:
          channelAverages.avgViews > 0
            ? Number((videoViews / channelAverages.avgViews).toFixed(2))
            : 0,
        watchTimeRatio:
          channelAverages.avgWatchMin > 0
            ? Number((videoWatch / channelAverages.avgWatchMin).toFixed(2))
            : 0,
        durationRatio:
          channelAverages.avgDuration > 0
            ? Number((videoDur / channelAverages.avgDuration).toFixed(2))
            : 0,
      }
    : null;

  // Per-video monetary block. `revenueRes.rows[0]` is empty if the
  // monetary report soft-failed (403) or returned no row for this video
  // — in either case we surface `null` and the UI hides the block.
  const revenueTotals = parseTotalsRow(revenueRes, REVENUE_METRICS);
  const revenue =
    revenueRes.rows && revenueRes.rows.length > 0
      ? {
          estimatedRevenue: Number((revenueTotals.estimatedRevenue ?? 0).toFixed(2)),
          estimatedAdRevenue: Number((revenueTotals.estimatedAdRevenue ?? 0).toFixed(2)),
          estimatedRedPartnerRevenue: Number(
            (revenueTotals.estimatedRedPartnerRevenue ?? 0).toFixed(2)
          ),
          grossRevenue: Number((revenueTotals.grossRevenue ?? 0).toFixed(2)),
          cpm: Number((revenueTotals.cpm ?? 0).toFixed(2)),
          playbackBasedCpm: Number((revenueTotals.playbackBasedCpm ?? 0).toFixed(2)),
          monetizedPlaybacks: Math.round(revenueTotals.monetizedPlaybacks ?? 0),
          adImpressions: Math.round(revenueTotals.adImpressions ?? 0),
        }
      : null;

  return {
    videoId,
    period: { startDate, endDate, days: actualDays },
    totals: {
      views: videoViews,
      watchMinutes: videoWatch,
      avgViewDurationSec: videoDur,
      likes: totals.likes ?? 0,
      comments: totals.comments ?? 0,
      shares: totals.shares ?? 0,
      subscribersGained: totals.subscribersGained ?? 0,
      subscribersLost: totals.subscribersLost ?? 0,
      averageViewPercentage: Number((totals.averageViewPercentage ?? 0).toFixed(1)),
      videosAddedToPlaylists: Math.round(totals.videosAddedToPlaylists ?? 0),
      videosRemovedFromPlaylists: Math.round(totals.videosRemovedFromPlaylists ?? 0),
    },
    cards,
    endScreen,
    daily,
    retention,
    trafficSources,
    playbackLocations,
    searchTerms,
    sharingServices,
    operatingSystems,
    subscribedStatus,
    demographics,
    geography,
    vsChannelAverage,
    revenue,
  };
}

/* ===================== Channel-wide audience (Phase 3) ===================== */

export type ChannelAudienceBundle = {
  period: { startDate: string; endDate: string; days: number };
  demographics: { ageGroup: string; gender: string; viewerPercentage: number }[];
  geography: { country: string; views: number; watchMinutes: number }[];
  devices: { deviceType: string; views: number; watchMinutes: number }[];
  trafficSources: { source: string; views: number; watchMinutes: number }[];
};

export async function fetchChannelAudience(period: PeriodSpec): Promise<ChannelAudienceBundle> {
  const { startDate, endDate, actualDays } = resolvePeriod(period);

  const soft = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      log.warn("yt-analytics", "Audience sub-report failed (soft)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    }
  };

  const [demoRes, geoRes, devRes, srcRes] = await Promise.all([
    soft(
      () =>
        runReport({
          startDate,
          endDate,
          metrics: ["viewerPercentage"],
          dimensions: ["ageGroup", "gender"],
        }),
      { columnHeaders: [], rows: [] } as ReportResponse
    ),
    soft(
      () =>
        runReport({
          startDate,
          endDate,
          metrics: ["views", "estimatedMinutesWatched"],
          dimensions: ["country"],
          sort: "-views",
          maxResults: 25,
        }),
      { columnHeaders: [], rows: [] } as ReportResponse
    ),
    soft(
      () =>
        runReport({
          startDate,
          endDate,
          metrics: ["views", "estimatedMinutesWatched"],
          dimensions: ["deviceType"],
          sort: "-views",
        }),
      { columnHeaders: [], rows: [] } as ReportResponse
    ),
    soft(
      () =>
        runReport({
          startDate,
          endDate,
          metrics: ["views", "estimatedMinutesWatched"],
          dimensions: ["insightTrafficSourceType"],
          sort: "-views",
        }),
      { columnHeaders: [], rows: [] } as ReportResponse
    ),
  ]);

  return {
    period: { startDate, endDate, days: actualDays },
    demographics: (demoRes.rows ?? []).map((r) => ({
      ageGroup: String(r[0]),
      gender: String(r[1]),
      viewerPercentage: Number(r[2]) || 0,
    })),
    geography: (geoRes.rows ?? []).map((r) => ({
      country: String(r[0]),
      views: Number(r[1]) || 0,
      watchMinutes: Number(r[2]) || 0,
    })),
    devices: (devRes.rows ?? []).map((r) => ({
      deviceType: String(r[0]),
      views: Number(r[1]) || 0,
      watchMinutes: Number(r[2]) || 0,
    })),
    trafficSources: (srcRes.rows ?? []).map((r) => ({
      source: String(r[0]),
      views: Number(r[1]) || 0,
      watchMinutes: Number(r[2]) || 0,
    })),
  };
}

/* ===================== Revenue (Phase 5, owner-only) ===================== */

export type RevenueBundle = {
  period: { startDate: string; endDate: string; days: number };
  totals: {
    views: number;            // Total views in the period — RPM denominator.
    estimatedRevenue: number; // USD
    estimatedAdRevenue: number;
    estimatedRedPartnerRevenue: number;
    grossRevenue: number;
    cpm: number;
    playbackBasedCpm: number;
    monetizedPlaybacks: number;
    adImpressions: number;
  };
  daily: { date: string; estimatedRevenue: number; cpm: number }[];
  /**
   * `views` here comes back from YT Analytics' monetary report. For some
   * videos it's reliably populated; for others (especially older or
   * heavily-demonetized ones) the API returns 0 even though the video
   * obviously has views. Callers that have access to a local cache of
   * video stats should override this with their own number — the API
   * route layer does exactly that and also folds in the human title.
   */
  topVideos: {
    videoId: string;
    estimatedRevenue: number;
    views: number;
    title?: string;
    thumbnail?: string | null;
  }[];
};

// `views` is the divisor for RPM = (estimatedRevenue / views) × 1000. It's
// a non-monetary metric but YT Analytics will return it in the same
// monetary report request — no extra API call.
const REVENUE_METRICS = [
  "views",
  "estimatedRevenue",
  "estimatedAdRevenue",
  "estimatedRedPartnerRevenue",
  "grossRevenue",
  "cpm",
  "playbackBasedCpm",
  "monetizedPlaybacks",
  "adImpressions",
];

export async function fetchChannelRevenue(
  period: PeriodSpec,
  channelId?: string
): Promise<RevenueBundle> {
  const { startDate, endDate, actualDays } = resolvePeriod(period);
  // Multi-channel: callers (the cross-channel earnings widget) can pin a
  // specific channel without flipping the active-channel pointer. Falls
  // back to `resolveChannelIds()` (active channel) when omitted.
  const ids = channelId ? `channel==${channelId}` : undefined;

  const [totalsRes, dailyRes, topRes] = await Promise.all([
    runReport({ startDate, endDate, metrics: REVENUE_METRICS, isMonetary: true, ids }),
    runReport({
      startDate,
      endDate,
      metrics: ["estimatedRevenue", "cpm"],
      dimensions: ["day"],
      sort: "day",
      isMonetary: true,
      ids,
    }),
    runReport({
      startDate,
      endDate,
      metrics: ["estimatedRevenue", "views"],
      dimensions: ["video"],
      sort: "-estimatedRevenue",
      maxResults: 10,
      isMonetary: true,
      ids,
    }).catch(() => ({ columnHeaders: [], rows: [] }) as ReportResponse),
  ]);

  const totals = parseTotalsRow(totalsRes, REVENUE_METRICS);
  return {
    period: { startDate, endDate, days: actualDays },
    totals: {
      views: Math.round(totals.views ?? 0),
      estimatedRevenue: Number((totals.estimatedRevenue ?? 0).toFixed(2)),
      estimatedAdRevenue: Number((totals.estimatedAdRevenue ?? 0).toFixed(2)),
      estimatedRedPartnerRevenue: Number((totals.estimatedRedPartnerRevenue ?? 0).toFixed(2)),
      grossRevenue: Number((totals.grossRevenue ?? 0).toFixed(2)),
      cpm: Number((totals.cpm ?? 0).toFixed(2)),
      playbackBasedCpm: Number((totals.playbackBasedCpm ?? 0).toFixed(2)),
      monetizedPlaybacks: Math.round(totals.monetizedPlaybacks ?? 0),
      adImpressions: Math.round(totals.adImpressions ?? 0),
    },
    daily: (dailyRes.rows ?? []).map((r) => ({
      date: String(r[0]),
      estimatedRevenue: Number(r[1]) || 0,
      cpm: Number(r[2]) || 0,
    })),
    topVideos: (topRes.rows ?? []).map((r) => ({
      videoId: String(r[0]),
      estimatedRevenue: Number(r[1]) || 0,
      views: Number(r[2]) || 0,
    })),
  };
}

/* ===================== Internal helpers ===================== */

function headerIndex(res: ReportResponse, metrics: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of metrics) {
    const i = res.columnHeaders.findIndex((h) => h.name === m);
    if (i === -1) {
      log.warn("yt-analytics", `Column ${m} missing from report`, {
        headers: res.columnHeaders.map((h) => h.name),
      });
    }
    out[m] = i;
  }
  return out;
}

function parseTotalsRow(res: ReportResponse, metrics: string[]): Record<string, number> {
  const idx = headerIndex(res, metrics);
  const row = res.rows?.[0] ?? [];
  const out: Record<string, number> = {};
  for (const m of metrics) {
    out[m] = Number(row[idx[m]]) || 0;
  }
  return out;
}

function makeTotals(raw: Record<string, number>): OverviewBundle["totals"] {
  return {
    views: raw.views ?? 0,
    watchMinutes: Math.round(raw.estimatedMinutesWatched ?? 0),
    avgViewDurationSec: Math.round(raw.averageViewDuration ?? 0),
    subscribersGained: raw.subscribersGained ?? 0,
    subscribersLost: raw.subscribersLost ?? 0,
    netSubscribers: (raw.subscribersGained ?? 0) - (raw.subscribersLost ?? 0),
    likes: raw.likes ?? 0,
    comments: raw.comments ?? 0,
    shares: raw.shares ?? 0,
  };
}
