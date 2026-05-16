"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  DollarSign,
  Loader2,
  Lock,
  Minus,
  RefreshCw,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Bundle = {
  period: { startDate: string; endDate: string; days: number };
  totals: {
    estimatedRevenue: number;
    estimatedAdRevenue: number;
    estimatedRedPartnerRevenue: number;
    grossRevenue: number;
    cpm: number;
    playbackBasedCpm: number;
    monetizedPlaybacks: number;
    adImpressions: number;
  };
  daily: { date: string; estimatedRevenue: number; cpm: number }[];
  topVideos: { videoId: string; estimatedRevenue: number; views: number }[];
};

type Payload = {
  connected: boolean;
  revenueAccess: "allowed" | "denied" | "unknown";
  period: string;
  revenue: Bundle | null;
  error?: string;
};

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

/**
 * Compact "money today" widget for the Dashboard. Pulls the same revenue
 * report as ChannelRevenue but surfaces only the latest day + MTD instead
 * of the full breakdown — designed to answer "did I make money today
 * without clicking into anything?".
 *
 * Quietly renders nothing when revenue access is denied (Manager tier),
 * so a creator without monetary access doesn't see a useless empty box.
 */
export function TodaysEarnings() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/analytics/revenue?period=28d");
      const d = (await res.json()) as Payload;
      setData(d);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Don't render if not connected or denied — keeps the dashboard clean
  // for creators who don't have revenue access yet.
  if (data && (!data.connected || data.revenueAccess === "denied")) {
    return null;
  }

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <DollarSign className="h-4 w-4 text-green-600 dark:text-green-400" />
            Earnings
          </CardTitle>
          <CardDescription>
            Latest day vs the day before, and month-to-date total.
            <span
              className="ml-1 cursor-help text-[11px] underline decoration-dotted"
              title="YouTube Analytics has a 24-48h pipeline lag — the latest available date is typically 'today minus 2'. This is the same data Studio shows; not a bug. Today's earnings show up tomorrow or the day after."
            >
              (data lag explained)
            </span>
          </CardDescription>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </CardHeader>

      <CardContent>
        {!data?.revenue ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading earnings…
          </div>
        ) : (
          <EarningsBody bundle={data.revenue} />
        )}
      </CardContent>
    </Card>
  );
}

function EarningsBody({ bundle }: { bundle: Bundle }) {
  // Compute "latest day" (last entry in daily series — typically today−2
  // due to the YT Analytics 24-48h lag) vs "previous day" for delta.
  const sortedDaily = [...bundle.daily].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sortedDaily[sortedDaily.length - 1] ?? null;
  const previous = sortedDaily[sortedDaily.length - 2] ?? null;

  const latestUsd = latest?.estimatedRevenue ?? 0;
  const prevUsd = previous?.estimatedRevenue ?? 0;
  const delta = prevUsd > 0 ? ((latestUsd - prevUsd) / prevUsd) * 100 : null;

  // Month-to-date — sum daily entries that fall in the current calendar
  // month (UTC). Days returned by the API are YYYY-MM-DD strings so we
  // compare prefixes.
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const mtdTotal = sortedDaily
    .filter((d) => d.date.startsWith(currentMonth))
    .reduce((s, d) => s + d.estimatedRevenue, 0);

  // Previous-month fallback. YouTube Analytics has a 1-3 day data lag,
  // so on the 1st-3rd of a new month the MTD figure is genuinely $0
  // (no current-month days reported yet). Showing $0 with no context
  // looks like a bug — fall back to the previous full month total when
  // MTD is empty. We compute coverage range so the label can be honest:
  // on period=28d at May 1 the daily series only reaches April 3, so
  // we show "Apr 3 – Apr 30 total" rather than pretending it's all of
  // April. The headline /api/analytics/revenue-multi widget does the
  // same thing for the cross-channel view; we mirror that logic here
  // for the per-channel card so the two widgets agree.
  const prevDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevMonthKey = `${prevDate.getUTCFullYear()}-${String(
    prevDate.getUTCMonth() + 1
  ).padStart(2, "0")}`;
  const prevMonthFirstDay = `${prevMonthKey}-01`;
  const prevMonthDaily = sortedDaily.filter((d) =>
    d.date.startsWith(prevMonthKey)
  );
  const prevMonthTotal = prevMonthDaily.reduce(
    (s, d) => s + d.estimatedRevenue,
    0
  );
  const prevMonthCoverageStart = prevMonthDaily[0]?.date ?? "";
  const prevMonthCoverageEnd =
    prevMonthDaily[prevMonthDaily.length - 1]?.date ?? "";
  const prevMonthPartial =
    !!prevMonthCoverageStart && prevMonthCoverageStart > prevMonthFirstDay;

  const useFallback = mtdTotal < 0.01 && prevMonthTotal > 0;
  const monthValue = useFallback ? prevMonthTotal : mtdTotal;
  const formatShortDay = (iso: string): string => {
    if (!iso) return "";
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const prevMonthHumanLabel = prevDate.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
  const monthBaseLabel = useFallback
    ? prevMonthPartial && prevMonthCoverageStart && prevMonthCoverageEnd
      ? `${formatShortDay(prevMonthCoverageStart)} – ${formatShortDay(
          prevMonthCoverageEnd
        )} total`
      : `${prevMonthHumanLabel} total`
    : "Month-to-date";
  const monthSubLabel = useFallback
    ? prevMonthPartial
      ? `${prevMonthHumanLabel} (partial — ${formatShortDay(prevMonthCoverageStart)} onward). Pick a longer period to cover the full month.`
      : `${prevMonthHumanLabel} (current month not yet reported — typical 1-3 day data lag)`
    : now.toLocaleString("en-US", { month: "long", year: "numeric" });

  const DeltaIcon =
    delta === null ? Minus : delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus;
  const deltaColor =
    delta === null
      ? "text-muted-foreground"
      : delta > 0
        ? "text-green-600 dark:text-green-400"
        : delta < 0
          ? "text-red-600 dark:text-red-400"
          : "text-muted-foreground";

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {/* Latest day */}
      <div className="rounded-lg border bg-card p-3">
        <div className="text-[10px] uppercase text-muted-foreground">
          Latest day{latest ? ` (${latest.date})` : ""}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums text-green-700 dark:text-green-400">
            ${latestUsd.toFixed(2)}
          </span>
          {delta !== null && (
            <span className={cn("inline-flex items-center text-xs font-medium", deltaColor)}>
              <DeltaIcon className="h-3 w-3" />
              {Math.abs(delta).toFixed(1)}%
            </span>
          )}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {previous ? `vs $${prevUsd.toFixed(2)} prior day` : "no prior day data"}
        </div>
      </div>

      {/* Month-to-date — falls back to prev-month total when current
          month is empty (early-of-month data lag). Label switches to
          the actual covered range so partial-coverage figures aren't
          mislabelled as "full month". */}
      <div className="rounded-lg border bg-card p-3">
        <div className="text-[10px] uppercase text-muted-foreground">
          {monthBaseLabel}
        </div>
        <div
          className={cn(
            "mt-1 text-2xl font-bold tabular-nums",
            useFallback && "text-muted-foreground"
          )}
          title={
            useFallback
              ? "Showing previous-month total because YouTube Analytics hasn't reported any current-month days yet (typical 1-3 day data lag)."
              : undefined
          }
        >
          ${monthValue.toFixed(2)}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {monthSubLabel}
        </div>
      </div>

      {/* RPM — what the channel earns per 1,000 views, after YouTube's cut.
          Computed client-side from the same monetary bundle we already fetch
          (no new endpoint). Falls back to $0 when views == 0 to avoid NaN. */}
      <div className="rounded-lg border bg-card p-3">
        <div className="text-[10px] uppercase text-muted-foreground">RPM</div>
        <div className="mt-1 text-2xl font-bold tabular-nums">
          {fmtUsd(
            bundle.totals.views > 0
              ? (bundle.totals.estimatedRevenue / bundle.totals.views) * 1000
              : 0
          )}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          Revenue per 1,000 views
        </div>
      </div>
    </div>
  );
}

// Lock icon kept for completeness — not currently rendered but ready if
// we add an explicit "denied" surface here in the future.
void Lock;
