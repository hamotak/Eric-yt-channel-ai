"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  DollarSign,
  Loader2,
  Lock,
  RefreshCw,
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
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  topVideos: {
    videoId: string;
    estimatedRevenue: number;
    views: number;
    title?: string;
    thumbnail?: string | null;
  }[];
};

type Payload = {
  connected: boolean;
  revenueAccess: "allowed" | "denied" | "unknown";
  period: string;
  revenue: Bundle | null;
  error?: string;
};

const PERIODS = ["7d", "28d", "90d", "365d", "all"] as const;

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString("en-US");
}

/**
 * Channel revenue card. Three states:
 *   1. `denied` — user can't see monetary data on this channel (Manager
 *      tier, or non-monetised channel). We show a clear "Owner only"
 *      explanation instead of an error.
 *   2. `unknown` / `allowed` with no data yet — loading spinner.
 *   3. `allowed` with data — KPIs + revenue trend chart + top earners.
 *
 * The `revenueAccess` flag is set sticky on the server when a 403 hits
 * the monetary endpoint, so we don't keep re-trying every page load.
 */
export function ChannelRevenue() {
  const [period, setPeriod] = useState<string>("28d");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const url = new URL("/api/analytics/revenue", window.location.origin);
        url.searchParams.set("period", period);
        if (force) {
          url.searchParams.set("nocache", "1");
          url.searchParams.set("force", "1");
        }
        const res = await fetch(url.toString());
        const d = (await res.json()) as Payload;
        setData(d);
      } catch {
        /* keep prior */
      } finally {
        setLoading(false);
      }
    },
    [period]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Not connected — render nothing (other components nudge to /integrations).
  if (data && !data.connected) return null;

  // No revenue access — graceful, informative card.
  if (data && data.revenueAccess === "denied") {
    return (
      <Card className="mb-4 border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4 text-muted-foreground" />
            Revenue
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
              Owner only
            </span>
          </CardTitle>
          <CardDescription>
            Revenue, RPM, CPM, and ad impressions require channel-Owner access (or
            Brand Account Owner). Manager-tier accounts get 403 from YouTube on
            this endpoint.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            If you ARE the channel owner and still see this:
          </p>
          <ol className="ml-4 list-decimal space-y-1 text-xs text-muted-foreground">
            <li>
              The channel may not be monetised — the YouTube Partner Program
              must be approved before revenue endpoints return data.
            </li>
            <li>
              Reconnect Google with the <code className="rounded bg-muted px-1">yt-analytics-monetary.readonly</code>{" "}
              scope —{" "}
              <Link
                href="/settings/integrations#youtube-analytics"
                className="text-primary hover:underline"
              >
                Integrations
              </Link>{" "}
              → Reconnect.
            </li>
          </ol>
          <Button size="sm" variant="outline" onClick={() => load(true)} className="mt-2 gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (data?.error) {
    return (
      <Card className="mb-4 border-amber-500/40 bg-amber-500/5">
        <CardContent className="flex items-start gap-3 p-4 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1">
            <div className="font-medium">Revenue load failed</div>
            <p className="mt-0.5 text-xs text-muted-foreground">{data.error}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => load(true)} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const r = data?.revenue;

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <DollarSign className="h-4 w-4 text-green-600 dark:text-green-400" />
            Revenue
          </CardTitle>
          <CardDescription>
            Estimated earnings, RPM, CPM, ad impressions
            {r && (
              <>
                {" · "}
                <span className="font-mono text-[10px]">
                  {r.period.startDate} → {r.period.endDate}
                </span>
              </>
            )}
          </CardDescription>
        </div>
        <div className="flex items-center gap-1">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium transition-colors",
                period === p
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {p}
            </button>
          ))}
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="ml-1 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!r ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading revenue…
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Estimated revenue" value={fmtUsd(r.totals.estimatedRevenue)} bold />
              <Stat label="Ad revenue" value={fmtUsd(r.totals.estimatedAdRevenue)} />
              <Stat label="YouTube Premium" value={fmtUsd(r.totals.estimatedRedPartnerRevenue)} />
              <Stat label="Gross" value={fmtUsd(r.totals.grossRevenue)} />
              <Stat
                label="CPM"
                value={fmtUsd(r.totals.cpm)}
                hint="Per 1k ad impressions"
              />
              <Stat
                label="Playback CPM"
                value={fmtUsd(r.totals.playbackBasedCpm)}
                hint="Per 1k playbacks"
              />
              <Stat
                label="Monetized playbacks"
                value={fmtNum(r.totals.monetizedPlaybacks)}
              />
              <Stat label="Ad impressions" value={fmtNum(r.totals.adImpressions)} />
            </div>

            {/* Daily revenue trend */}
            {r.daily.length > 0 && (
              <div className="h-[220px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={r.daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
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
                      tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                      formatter={(value, name) => {
                        const v = Number(value) || 0;
                        return [
                          name === "estimatedRevenue" ? `$${v.toFixed(2)}` : `$${v.toFixed(2)}`,
                          name === "estimatedRevenue" ? "Revenue" : "CPM",
                        ];
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="estimatedRevenue"
                      stroke="#10b981"
                      strokeWidth={2}
                      fill="url(#revFill)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Top earners */}
            {r.topVideos.length > 0 && (
              <div>
                <div className="mb-2 text-sm font-medium">Top earning videos</div>
                <ul className="space-y-1">
                  {r.topVideos.map((v, i) => (
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
                            v.title ? "text-sm" : "font-mono text-xs"
                          }`}
                          title={v.title ?? v.videoId}
                        >
                          {v.title ?? v.videoId}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {fmtNum(v.views)} views
                        </span>
                        <span className="shrink-0 text-xs font-semibold tabular-nums text-green-600 dark:text-green-400">
                          {fmtUsd(v.estimatedRevenue)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  bold,
}: {
  label: string;
  value: string;
  hint?: string;
  bold?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md border bg-card p-3",
        bold && "border-green-500/40 bg-green-500/5"
      )}
    >
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 tabular-nums",
          bold ? "text-xl font-bold" : "text-base font-semibold"
        )}
      >
        {value}
      </div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
