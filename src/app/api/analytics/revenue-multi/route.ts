import { NextResponse } from "next/server";
import { getCached, listAllChannels, setCached, tagsByChannel } from "@/lib/db";
import {
  fetchChannelRevenue,
  YtAnalyticsError,
  getRevenueAccessFlag,
} from "@/lib/yt-analytics";
import { getOAuthTokens } from "@/lib/google-oauth";

export const runtime = "nodejs";
export const maxDuration = 60;

const PERIODS: Record<string, number | "all"> = {
  "7d": 7,
  "28d": 28,
  "90d": 90,
  "365d": 365,
  all: "all",
};

const CACHE_TTL_SEC = 6 * 3600;

type ChannelEarnings = {
  channelId: string;
  title: string | null;
  handle: string | null;
  /** Sum of estimatedRevenue across the period. `null` when the call failed
   *  (denied / network) — distinguishes "no money" from "couldn't get data". */
  total: number | null;
  /** Last-day estimatedRevenue from the daily series. `null` if missing. */
  latestDay: { date: string; amount: number } | null;
  /** Sum of estimatedRevenue for entries whose date prefix matches the
   *  current calendar month (UTC). */
  mtd: number;
  /** Sum of estimatedRevenue for the previous full calendar month (UTC).
   *  Used as a fallback when MTD is empty in the first 1-3 days of a new
   *  month — YouTube Analytics has data lag, so a fresh May 1 dashboard
   *  would otherwise show $0 for "this month" with no context. */
  prevMonth: number;
  /** YYYY-MM string the prevMonth value covers — UI renders it as a
   *  human label (e.g. "April"). Undefined when the period covered
   *  doesn't include the previous month. */
  prevMonthKey?: string;
  /** Tags attached to this channel (from channel_tags m:n). Each tag
   *  may carry a cut_percent that the dashboard subtracts from gross
   *  revenue. We send the full list so the UI can show chips per row. */
  tags: { id: number; name: string; cut_percent: number | null }[];
  /** Sum of all tag cut_percents on this channel, clamped 0-100. The
   *  dashboard uses this to compute net-after-cuts for the headline
   *  tiles + per-channel "Net" column. Pre-computed server-side so the
   *  client can just multiply. */
  totalCutPercent: number;
  // Legacy fields (kept for back-compat with any consumer that still
  // reads them; new UI consumes `tags`).
  cmsName: string | null;
  cmsCutPercent: number | null;
  adsenseName: string | null;
  editorName: string | null;
  monetizationStatus: "monetized" | "pending" | "not_eligible" | null;
  error?: string;
};

type Payload = {
  connected: boolean;
  revenueAccess: "allowed" | "denied" | "unknown";
  period: string;
  channels: ChannelEarnings[];
  totals: {
    /** Sum of `total` across channels that succeeded. */
    period: number;
    /** Sum of `latestDay.amount` across channels. */
    latestDay: number;
    /** Sum of `mtd` across channels. */
    mtd: number;
    /** Sum of `prevMonth` across channels. UI shows this when `mtd` is
     *  zero, so the headline tile stays informative on the 1st-3rd of
     *  a new month while YouTube Analytics catches up. */
    prevMonth: number;
    /** Same three numbers but with each channel's CMS cut subtracted —
     *  i.e. "what you actually keep" after networks take their share. */
    periodNet: number;
    latestDayNet: number;
    mtdNet: number;
    prevMonthNet: number;
    /** YYYY-MM key the prevMonth values cover. Always present so the
     *  UI can label the fallback tile (e.g. "April total"). */
    prevMonthKey: string;
    /** Earliest YYYY-MM-DD covered by the prevMonth sum. When the
     *  selected period is shorter than the days-since-prev-month-1st
     *  (e.g. period=28d on May 1 only reaches April 3), this lets the
     *  UI label the figure honestly as "Apr 3-30" instead of pretending
     *  it's the whole month. Empty string when no prev-month data
     *  available. */
    prevMonthCoverageStart: string;
    /** Latest YYYY-MM-DD covered by the prevMonth sum. Pairs with
     *  prevMonthCoverageStart. Always equals the last day of the prev
     *  month when full coverage; equals min(last-day-of-month,
     *  last-data-day) otherwise. */
    prevMonthCoverageEnd: string;
    /** True when prevMonthCoverageStart is later than the 1st of the
     *  prev month — i.e. the figure misses the early days of that
     *  month because the selected period didn't reach back far enough. */
    prevMonthPartial: boolean;
    /** Channel IDs that returned `total === null` (transient OAuth 401,
     *  monetary access denied, etc.) and were silently dropped from
     *  every sum in this `totals` block. The UI surfaces this as a
     *  warning chip so the user knows the headline is incomplete. */
    excludedChannelIds: string[];
  };
  /**
   * Day-by-day combined revenue across every channel that succeeded.
   * Sorted ascending by date. Lets the UI roll up to weekly / monthly
   * client-side instead of refetching, so the granularity toggle is
   * snappy. Days with zero across all channels are still included so
   * the chart line/bar layout is uniform.
   */
  combinedDaily: { date: string; total: number }[];
};

/**
 * Cross-channel earnings aggregator. Walks every channel stored locally,
 * pulls a revenue report for each (in parallel), and returns a flat
 * summary the dashboard can render as "today across all channels" +
 * "this month across all channels".
 *
 * One OAuth token covers every channel the user owns under the connected
 * Google account, so we can hit each channel's report with the same
 * credentials — no per-channel reconnect required.
 */
export async function GET(req: Request) {
  const tokens = getOAuthTokens();
  const channels = listAllChannels();

  if (!tokens?.refresh_token) {
    return NextResponse.json({
      connected: false,
      revenueAccess: "unknown",
      period: "28d",
      channels: [],
      totals: {
        period: 0,
        latestDay: 0,
        mtd: 0,
        prevMonth: 0,
        periodNet: 0,
        latestDayNet: 0,
        mtdNet: 0,
        prevMonthNet: 0,
        prevMonthKey: "",
        prevMonthCoverageStart: "",
        prevMonthCoverageEnd: "",
        prevMonthPartial: false,
        excludedChannelIds: [],
      },
      combinedDaily: [],
    } satisfies Payload);
  }

  const url = new URL(req.url);
  const periodKey = url.searchParams.get("period") ?? "28d";
  const periodSpec = PERIODS[periodKey];
  if (periodSpec === undefined) {
    return NextResponse.json(
      { error: `Invalid period. Use one of: ${Object.keys(PERIODS).join(", ")}` },
      { status: 400 }
    );
  }

  // No global short-circuit anymore — revenueAccess is now per-channel,
  // so we have to actually try each one. Per-channel skip lives inside
  // the iteration below.

  // v7: payload now also reports totals.excludedChannelIds (any channel
  // whose total === null was silently dropped from the sums; the UI
  // surfaces a warning chip). v6 entries lack that field; bumping the
  // cache key flushes them.
  const cacheKey = `analytics.revenue-multi.v7.${periodKey}.${channels
    .map((c) => c.id)
    .sort()
    .join(",")}`;
  if (url.searchParams.get("nocache") !== "1") {
    const cached = getCached<Payload>(cacheKey);
    if (cached) return NextResponse.json(cached);
  }

  // Current calendar month in UTC, e.g. "2026-04" — used to compute MTD
  // by string-prefix match on YYYY-MM-DD daily entries. We also compute
  // the previous month key (e.g. "2026-03") so the API can return a
  // fallback figure for the dashboard's "Month-to-date" tile when it's
  // still empty in the first few days of a new month (YT Analytics has
  // a 1-3 day data lag — fresh May 1 dashboards would otherwise show $0
  // for "this month" with zero context).
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(
    now.getUTCMonth() + 1
  ).padStart(2, "0")}`;
  const prevDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevMonthKey = `${prevDate.getUTCFullYear()}-${String(
    prevDate.getUTCMonth() + 1
  ).padStart(2, "0")}`;
  // First day of the prev month — used to detect partial coverage in
  // the daily series (when period < days-since-prev-month-1st, the
  // earliest reported date will be later than this).
  const prevMonthFirstDay = `${prevMonthKey}-01`;

  // Per-day combined revenue, keyed YYYY-MM-DD. Built up as each
  // channel's daily series comes in; the UI rolls this up to weekly /
  // monthly buckets client-side.
  const combinedByDate = new Map<string, number>();

  // Build a quick-access view of the user-managed metadata so each
  // ChannelEarnings row can carry it without re-querying. Tags come
  // from a single tagsByChannel() call below — no N+1.
  const tagsMap = tagsByChannel();
  const metaById = new Map(
    channels.map((c) => {
      const tagsForChannel = (tagsMap.get(c.id) ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        cut_percent: t.cut_percent,
      }));
      // Sum cut percents across all attached tags. Clamped to [0,100].
      // We sum (rather than max) because each tag with a cut models a
      // separate party taking their share — CMS deal + AdSense management
      // fee + etc. Stacking models that correctly.
      const rawCut = tagsForChannel.reduce(
        (s, t) => s + (typeof t.cut_percent === "number" ? t.cut_percent : 0),
        0
      );
      const totalCutPercent = Math.max(0, Math.min(100, rawCut));
      return [
        c.id,
        {
          tags: tagsForChannel,
          totalCutPercent,
          cmsName: c.cms_name ?? null,
          cmsCutPercent: c.cms_cut_percent ?? null,
          adsenseName: c.adsense_name ?? null,
          editorName: c.editor_name ?? null,
          monetizationStatus: (c.monetization_status as
            | "monetized"
            | "pending"
            | "not_eligible"
            | null) ?? null,
        },
      ];
    })
  );

  const settled = await Promise.all(
    channels.map(async (c): Promise<ChannelEarnings> => {
      const meta = metaById.get(c.id) ?? {
        tags: [],
        totalCutPercent: 0,
        cmsName: null,
        cmsCutPercent: null,
        adsenseName: null,
        editorName: null,
        monetizationStatus: null,
      };
      // Skip channels we already know are denied (Manager-tier etc.) so
      // we don't burn a guaranteed-403 round-trip per poll. The flag is
      // per-channel — denial on Channel B doesn't taint Channel A.
      if (
        getRevenueAccessFlag(c.id) === "denied" &&
        url.searchParams.get("force") !== "1"
      ) {
        return {
          channelId: c.id,
          title: c.title,
          handle: c.handle,
          total: null,
          latestDay: null,
          mtd: 0,
          prevMonth: 0,
          prevMonthKey,
          ...meta,
          error: "monetary access denied",
        };
      }
      try {
        // Per-channel OAuth check: warn early when this channel doesn't
        // even have OAuth tokens at all. Without this we'd 401 inside
        // runReport with a generic message; better to flag the missing
        // connection so the user knows to click Google for that channel.
        const channelTokens = (await import("@/lib/google-oauth")).getOAuthTokens(c.id);
        if (!channelTokens?.refresh_token) {
          return {
            channelId: c.id,
            title: c.title,
            handle: c.handle,
            total: null,
            latestDay: null,
            mtd: 0,
            prevMonth: 0,
            prevMonthKey,
            ...meta,
            error: "no Google account connected for this channel",
          };
        }
        const bundle = await fetchChannelRevenue(periodSpec, c.id);
        const sortedDaily = [...bundle.daily].sort((a, b) =>
          a.date.localeCompare(b.date)
        );
        // Fold this channel's daily series into the cross-channel map.
        for (const d of sortedDaily) {
          combinedByDate.set(
            d.date,
            (combinedByDate.get(d.date) ?? 0) + d.estimatedRevenue
          );
        }
        const latest = sortedDaily[sortedDaily.length - 1] ?? null;
        const mtd = sortedDaily
          .filter((d) => d.date.startsWith(currentMonth))
          .reduce((s, d) => s + d.estimatedRevenue, 0);
        // Previous full calendar month — fallback for the dashboard
        // tile while YT Analytics catches up on the new month.
        const prevMonth = sortedDaily
          .filter((d) => d.date.startsWith(prevMonthKey))
          .reduce((s, d) => s + d.estimatedRevenue, 0);
        return {
          channelId: c.id,
          title: c.title,
          handle: c.handle,
          total: Number(bundle.totals.estimatedRevenue.toFixed(2)),
          latestDay: latest
            ? { date: latest.date, amount: Number(latest.estimatedRevenue.toFixed(2)) }
            : null,
          mtd: Number(mtd.toFixed(2)),
          prevMonth: Number(prevMonth.toFixed(2)),
          prevMonthKey,
          ...meta,
        };
      } catch (err) {
        // Translate common YT Analytics failure modes into something the
        // user can act on, instead of dumping the raw HTTP error.
        let msg: string;
        if (err instanceof YtAnalyticsError) {
          if (err.status === 403 || err.status === 401) {
            msg =
              "no monetary data — channel may not be in YPP, or the connected Google account is Manager-tier (not Owner)";
          } else if (err.status === 400) {
            msg = `bad request (${err.message.slice(0, 120)})`;
          } else {
            msg = `${err.status}: ${err.message}`;
          }
        } else {
          msg = err instanceof Error ? err.message : "unknown error";
        }
        return {
          channelId: c.id,
          title: c.title,
          handle: c.handle,
          total: null,
          latestDay: null,
          mtd: 0,
          prevMonth: 0,
          prevMonthKey,
          ...meta,
          error: msg,
        };
      }
    })
  );

  // Compute both gross totals and net-after-cuts totals.
  // Cuts now come from `totalCutPercent` (sum of all tag cuts on the
  // channel, clamped 0-100). The legacy single cms_cut_percent field
  // is no longer the source of truth — tags are.
  // Compute prev-month coverage from the combinedDaily map (which holds
  // every day any channel reported for). We want: earliest April day
  // seen, and latest April day seen. If period was 28d on May 1 the
  // earliest is around April 3 — that means the prev-month total is
  // missing April 1+2 and we must label it honestly.
  const prevMonthDates = [...combinedByDate.keys()]
    .filter((d) => d.startsWith(prevMonthKey))
    .sort();
  const prevMonthCoverageStart = prevMonthDates[0] ?? "";
  const prevMonthCoverageEnd =
    prevMonthDates[prevMonthDates.length - 1] ?? "";
  // Partial = the earliest prev-month date we have isn't the 1st of the
  // month. That's the only kind of "missing days" that matters; the end
  // of the month is bounded naturally because we're already past it.
  const prevMonthPartial =
    !!prevMonthCoverageStart && prevMonthCoverageStart > prevMonthFirstDay;

  const excludedChannelIds = settled
    .filter((c) => c.total === null)
    .map((c) => c.channelId);

  const totals = settled.reduce(
    (s, c) => {
      const gross = c.total ?? 0;
      const grossLatest = c.latestDay?.amount ?? 0;
      const grossMtd = c.mtd;
      const grossPrevMonth = c.prevMonth ?? 0;
      const cut = c.totalCutPercent ?? 0;
      const keep = cut > 0 ? Math.max(0, 1 - cut / 100) : 1;
      s.period += gross;
      s.latestDay += grossLatest;
      s.mtd += grossMtd;
      s.prevMonth += grossPrevMonth;
      s.periodNet += gross * keep;
      s.latestDayNet += grossLatest * keep;
      s.mtdNet += grossMtd * keep;
      s.prevMonthNet += grossPrevMonth * keep;
      return s;
    },
    {
      period: 0,
      latestDay: 0,
      mtd: 0,
      prevMonth: 0,
      periodNet: 0,
      latestDayNet: 0,
      mtdNet: 0,
      prevMonthNet: 0,
      prevMonthKey,
      prevMonthCoverageStart,
      prevMonthCoverageEnd,
      prevMonthPartial,
      excludedChannelIds,
    }
  );
  totals.period = Number(totals.period.toFixed(2));
  totals.latestDay = Number(totals.latestDay.toFixed(2));
  totals.mtd = Number(totals.mtd.toFixed(2));
  totals.prevMonth = Number(totals.prevMonth.toFixed(2));
  totals.periodNet = Number(totals.periodNet.toFixed(2));
  totals.latestDayNet = Number(totals.latestDayNet.toFixed(2));
  totals.mtdNet = Number(totals.mtdNet.toFixed(2));
  totals.prevMonthNet = Number(totals.prevMonthNet.toFixed(2));

  // Sort the combined daily series ascending so the chart x-axis is
  // monotonically increasing. Two-decimal rounding per day so the
  // serialised payload is small.
  const combinedDaily = [...combinedByDate.entries()]
    .map(([date, total]) => ({ date, total: Number(total.toFixed(2)) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // If at least one channel returned numbers, the widget is useful;
  // mark "allowed". Only flip to "denied" when *every* channel failed
  // — that's when the widget would show all dashes and should hide.
  const anyAllowed = settled.some((s) => s.total !== null);
  const payload: Payload = {
    connected: true,
    revenueAccess: anyAllowed ? "allowed" : "denied",
    period: periodKey,
    channels: settled,
    totals,
    combinedDaily,
  };

  setCached(cacheKey, payload, CACHE_TTL_SEC);
  return NextResponse.json(payload);
}
