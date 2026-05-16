"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Eye,
  Clock,
  Users,
  Heart,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Loader2,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Totals = {
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

type Daily = {
  date: string;
  views: number;
  watchMinutes: number;
  subscribersGained: number;
  subscribersLost: number;
};

type Overview = {
  period: { startDate: string; endDate: string; days: number };
  totals: Totals;
  previousTotals: Totals | null;
  daily: Daily[];
};

type TopVideo = {
  videoId: string;
  views: number;
  watchMinutes: number;
  avgViewDurationSec: number;
  title?: string;
  thumbnail?: string | null;
};

type Payload = {
  connected: boolean;
  revenueAccess: "allowed" | "denied" | "unknown";
  period: string;
  overview: Overview | null;
  topVideos: TopVideo[];
  error?: string;
};

const PERIODS: { value: string; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "28d", label: "28d" },
  { value: "90d", label: "90d" },
  { value: "365d", label: "365d" },
  { value: "all", label: "All" },
];

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString("en-US");
}

function fmtMinutes(min: number): string {
  // Under an hour: stay in minutes so small values still read naturally.
  if (min < 60) return `${Math.round(min)} min`;
  // 1+ hour: convert to hours, then K/M-scale so we never show a raw
  // "30412 hrs" — the dashboard wants "30K hrs" / "1.2M hrs" / "850 hrs".
  const hrs = min / 60;
  if (hrs >= 1_000_000) {
    return `${(hrs / 1_000_000).toFixed(1).replace(/\.0$/, "")}M hrs`;
  }
  if (hrs >= 1_000) {
    return `${(hrs / 1_000).toFixed(1).replace(/\.0$/, "")}K hrs`;
  }
  return `${Math.round(hrs)} hrs`;
}

function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pctChange(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null;
  // Suppress nonsensical "+4 816 225%" deltas. They happen when the
  // previous period was effectively zero (a brand-new channel, freshly
  // monetised, just spun up — the previous-period query returns a
  // tiny baseline like 5-20 views vs hundreds of thousands now).
  // Threshold: if previous is less than 1% of current magnitude AND
  // current is non-trivial, the comparison is meaningless. Studio
  // hides the delta in this case too.
  if (Math.abs(curr) > 100 && Math.abs(prev) / Math.abs(curr) < 0.01) {
    return null;
  }
  // Hard cap at ±1000% — any larger and the channel is on a different
  // trajectory than "incremental period-over-period comparison" can
  // describe. Showing "+923%" is fine; "+4M%" is line-noise.
  const raw = ((curr - prev) / prev) * 100;
  if (raw > 1000 || raw < -100) return null;
  return raw;
}

/**
 * The Studio-style "Last X days" overview block. Lives on Dashboard,
 * pulls from /api/analytics/overview which proxies YouTube Analytics API
 * with a 6h cache. When Google OAuth isn't connected we render a
 * lightweight CTA card pointing at /integrations instead.
 */
export function StudioOverview() {
  const [period, setPeriod] = useState("28d");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [chartMetric, setChartMetric] = useState<"views" | "watchMinutes" | "subs">("views");

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const url = new URL(`/api/analytics/overview`, window.location.origin);
        url.searchParams.set("period", period);
        if (force) url.searchParams.set("nocache", "1");
        const res = await fetch(url.toString());
        const d = (await res.json()) as Payload;
        setData(d);
      } catch {
        /* keep previous data on transient errors */
      } finally {
        setLoading(false);
      }
    },
    [period]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Not connected — single CTA card.
  if (data && !data.connected) {
    return (
      <Card className="mb-4 border-primary/30 bg-primary/5">
        <CardContent className="flex items-start gap-3 p-4 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="flex-1">
            <div className="font-medium">YouTube Analytics not connected</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Connect Google OAuth to see Studio-style channel analytics — views
              over time, watch time, subscriber dynamics, top videos by period.
            </p>
            <Link href="/integrations#youtube-analytics">
              <Button size="sm" variant="outline" className="mt-2 gap-2">
                Connect YouTube Analytics
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Connected but errored. The most common case is 403 — YouTube Analytics
  // API doesn't grant data via Channel Permissions "Manager" role; only via
  // Brand Account managers / Owners. We detect that and surface actionable
  // guidance instead of a confusing raw error.
  if (data?.error) {
    const is403 = /\b403\b/.test(data.error);
    return (
      <Card className="mb-4 border-amber-500/40 bg-amber-500/5">
        <CardContent className="space-y-3 p-4 text-sm">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="flex-1">
              <div className="font-medium text-amber-700 dark:text-amber-300">
                {is403 ? "Analytics access denied (403)" : "Analytics unavailable"}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{data.error}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => load(true)} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>

          {is403 && (
            <div className="rounded-md border border-border bg-background p-3 text-xs">
              <div className="mb-2 font-medium text-foreground">
                Why this happens
              </div>
              <p className="text-muted-foreground">
                YouTube Analytics API doesn&apos;t grant data via &quot;Channel
                Permissions&quot; Manager role — only via Brand Account Managers
                or channel Owners. If you can see this channel&apos;s analytics
                on{" "}
                <a
                  href="https://studio.youtube.com"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  studio.youtube.com
                </a>{" "}
                but the API still 403s, you&apos;re on Channel Permissions —
                that&apos;s expected.
              </p>
              <div className="mt-2 font-medium text-foreground">Three ways forward</div>
              <ol className="mt-1 list-decimal space-y-1 pl-4 text-muted-foreground">
                <li>
                  Channel owner adds you as a <strong>Brand Account Manager</strong>{" "}
                  (different from Channel Permissions). They go to{" "}
                  <a
                    href="https://myaccount.google.com/brandaccounts"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    myaccount.google.com/brandaccounts
                  </a>{" "}
                  and add your email there.
                </li>
                <li>
                  Channel owner makes you the <strong>Owner</strong> (Brand
                  Accounts only — they transfer primary ownership).
                </li>
                <li>
                  Channel owner clicks <strong>Reconnect</strong> on this
                  machine themselves, with their own Google account. Their
                  refresh token gets saved locally —{" "}
                  <Link href="/integrations#youtube-analytics" className="text-primary hover:underline">
                    Integrations
                  </Link>
                  .
                </li>
              </ol>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const overview = data?.overview;

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="text-base">Channel analytics</CardTitle>
          <CardDescription>
            Live data from YouTube Analytics API
            {overview && (
              <>
                {" · "}
                <span className="font-mono text-[10px]">
                  {overview.period.startDate} → {overview.period.endDate}
                </span>
              </>
            )}
          </CardDescription>
        </div>
        <div className="flex items-center gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium transition-colors",
                period === p.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="ml-1 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label="Refresh"
            title="Force refresh (skips cache)"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!overview ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading analytics…
          </div>
        ) : (
          <>
            {/* KPI cards with delta vs previous period */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard
                icon={Eye}
                label="Views"
                value={fmt(overview.totals.views)}
                delta={pctChange(
                  overview.totals.views,
                  overview.previousTotals?.views ?? 0
                )}
                onClick={() => setChartMetric("views")}
                active={chartMetric === "views"}
              />
              <KpiCard
                icon={Clock}
                label="Watch time"
                value={fmtMinutes(overview.totals.watchMinutes)}
                delta={pctChange(
                  overview.totals.watchMinutes,
                  overview.previousTotals?.watchMinutes ?? 0
                )}
                onClick={() => setChartMetric("watchMinutes")}
                active={chartMetric === "watchMinutes"}
              />
              <KpiCard
                icon={Users}
                label="Net subs"
                value={(overview.totals.netSubscribers >= 0 ? "+" : "") +
                  fmt(overview.totals.netSubscribers)}
                delta={pctChange(
                  overview.totals.netSubscribers,
                  overview.previousTotals?.netSubscribers ?? 0
                )}
                hint={`${overview.totals.subscribersGained} gained · ${overview.totals.subscribersLost} lost`}
                onClick={() => setChartMetric("subs")}
                active={chartMetric === "subs"}
              />
              <KpiCard
                icon={Heart}
                label="Avg view duration"
                value={fmtSec(overview.totals.avgViewDurationSec)}
                delta={pctChange(
                  overview.totals.avgViewDurationSec,
                  overview.previousTotals?.avgViewDurationSec ?? 0
                )}
              />
            </div>

            {/* Trend chart — the active KPI is highlighted in the card above */}
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={overview.daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(d: string) => d.slice(5)}
                  />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => fmt(v)}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "hsl(var(--foreground))" }}
                    formatter={(value) => {
                      const v = typeof value === "number" ? value : Number(value) || 0;
                      const label =
                        chartMetric === "views"
                          ? "Views"
                          : chartMetric === "watchMinutes"
                            ? "Watch time"
                            : "Subs gained";
                      const formatted =
                        chartMetric === "watchMinutes" ? fmtMinutes(v) : fmt(v);
                      return [formatted, label] as [string, string];
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey={
                      chartMetric === "views"
                        ? "views"
                        : chartMetric === "watchMinutes"
                          ? "watchMinutes"
                          : "subscribersGained"
                    }
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fill="url(#trendFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Engagement quick stats */}
            <div className="flex items-center gap-4 border-t border-border pt-3 text-xs text-muted-foreground">
              <span>
                Likes:{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {fmt(overview.totals.likes)}
                </span>
              </span>
              <span>
                Comments:{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {fmt(overview.totals.comments)}
                </span>
              </span>
              <span>
                Shares:{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {fmt(overview.totals.shares)}
                </span>
              </span>
            </div>
          </>
        )}

        {/* Top videos table */}
        {data && data.topVideos.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="mb-2 text-sm font-medium">Top videos in this period</div>
            <ul className="space-y-1">
              {data.topVideos.map((v, i) => (
                <li key={v.videoId}>
                  <Link
                    href={`/videos/${v.videoId}`}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
                  >
                    <span className="w-4 shrink-0 font-mono text-xs text-muted-foreground">
                      {i + 1}
                    </span>
                    {v.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={v.thumbnail}
                        alt=""
                        className="h-7 w-12 shrink-0 rounded object-cover"
                      />
                    ) : null}
                    <span
                      className={`min-w-0 flex-1 truncate ${
                        v.title ? "" : "font-mono text-xs"
                      }`}
                      title={v.title ?? v.videoId}
                    >
                      {v.title ?? v.videoId}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums">
                      {fmt(v.views)} views
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {fmtSec(v.avgViewDurationSec)} avg
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  delta,
  hint,
  onClick,
  active,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  delta: number | null;
  hint?: string;
  onClick?: () => void;
  active?: boolean;
}) {
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
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors",
        active
          ? "border-primary bg-primary/5"
          : "border-border bg-card",
        onClick && "hover:border-primary/50 hover:bg-accent/30 cursor-pointer"
      )}
    >
      <div className="flex w-full items-center justify-between">
        <div className="flex h-7 w-7 items-center justify-center rounded bg-primary/10 text-primary">
          <Icon className="h-3.5 w-3.5" />
        </div>
        {delta !== null && (
          <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", deltaColor)}>
            <DeltaIcon className="h-3 w-3" />
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </button>
  );
}
