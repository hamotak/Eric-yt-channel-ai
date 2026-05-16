"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Eye,
  Clock,
  Users,
  Loader2,
  RefreshCw,
  ListPlus,
  ThumbsUp,
  MessageCircle,
  Share2,
  TrendingUp,
  TrendingDown,
  MousePointerClick,
  Search,
  Smartphone,
  Globe,
  Bookmark,
  Target,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { cn } from "@/lib/utils";

type Bundle = {
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
    averageViewPercentage: number;
    videosAddedToPlaylists: number;
    videosRemovedFromPlaylists: number;
  };
  cards: { impressions: number; clicks: number; ctr: number } | null;
  endScreen: { impressions: number; clicks: number; ctr: number } | null;
  daily: {
    date: string;
    views: number;
    watchMinutes: number;
    likes: number;
    comments: number;
    subscribersGained: number;
    subscribersLost: number;
  }[];
  retention: { ratio: number; audienceRetention: number; relativeRetention: number }[];
  trafficSources: { source: string; views: number; watchMinutes: number }[];
  playbackLocations: { location: string; views: number; watchMinutes: number }[];
  searchTerms: { term: string; views: number }[];
  sharingServices: { service: string; shares: number }[];
  operatingSystems: { os: string; views: number }[];
  subscribedStatus: {
    status: string;
    views: number;
    watchMinutes: number;
    avgViewDurationSec: number;
  }[];
  demographics: { ageGroup: string; gender: string; viewerPercentage: number }[];
  geography: { country: string; views: number; watchMinutes: number }[];
  vsChannelAverage: {
    avgChannelViewsPerVideo: number;
    avgChannelWatchMinutesPerVideo: number;
    avgChannelViewDurationSec: number;
    viewsRatio: number;
    watchTimeRatio: number;
    durationRatio: number;
  } | null;
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

type Payload = {
  connected: boolean;
  period: string;
  analytics: Bundle | null;
  error?: string;
};

const PERIODS = ["7d", "28d", "90d", "365d", "all"] as const;

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString("en-US");
}

function fmtMinutes(min: number): string {
  if (min >= 60_000) return `${(min / 60).toFixed(0)} hrs`;
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${min} min`;
}

function fmtSec(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function sourceLabel(s: string): string {
  const map: Record<string, string> = {
    YT_SEARCH: "YouTube search",
    SUGGESTED_VIDEO: "Suggested videos",
    EXTERNAL: "External",
    BROWSE: "Browse features",
    PLAYLIST: "Playlist",
    YT_CHANNEL: "Channel page",
    YT_OTHER_PAGE: "Other YouTube",
    NOTIFICATION: "Notifications",
    SUBSCRIBER: "Subscribers feed",
    NO_LINK_OTHER: "Direct / unknown",
    NO_LINK_EMBEDDED: "Embedded player",
    SHORTS: "Shorts feed",
    HASHTAGS: "Hashtags",
    END_SCREEN: "End screen",
    ANNOTATION: "Cards / annotations",
    ADVERTISING: "Advertising",
    LIVE: "Live",
  };
  return map[s] ?? s;
}

function locationLabel(s: string): string {
  const map: Record<string, string> = {
    WATCH: "YouTube watch page",
    EMBEDDED: "Embedded (third-party site)",
    CHANNEL: "Channel page",
    SEARCH: "Search results",
    EXTERNAL_APP: "External app",
    MOBILE: "Mobile (legacy)",
    YT_OTHER: "Other YouTube",
    SHORTS: "Shorts feed",
  };
  return map[s] ?? s;
}

function subscribedLabel(s: string): string {
  if (s === "SUBSCRIBED") return "Subscribed";
  if (s === "UNSUBSCRIBED") return "Not subscribed";
  return s;
}

const PIE_COLORS = [
  "hsl(var(--primary))",
  "#f59e0b",
  "#10b981",
  "#6366f1",
  "#ec4899",
  "#14b8a6",
  "#eab308",
  "#8b5cf6",
];

type DailyMetric = "views" | "watchMinutes" | "likes" | "subscribersGained";

const DAILY_METRIC_DEFS: { key: DailyMetric; label: string }[] = [
  { key: "views", label: "Views" },
  { key: "watchMinutes", label: "Watch time" },
  { key: "likes", label: "Likes" },
  { key: "subscribersGained", label: "Subs gained" },
];

export function VideoAnalyticsPanel({ videoId }: { videoId: string }) {
  const [period, setPeriod] = useState<string>("28d");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [dailyMetric, setDailyMetric] = useState<DailyMetric>("views");

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const url = new URL(`/api/analytics/video/${videoId}`, window.location.origin);
        url.searchParams.set("period", period);
        if (force) url.searchParams.set("nocache", "1");
        const res = await fetch(url.toString());
        const d = (await res.json()) as Payload;
        setData(d);
      } catch {
        /* keep previous on transient errors */
      } finally {
        setLoading(false);
      }
    },
    [videoId, period]
  );

  useEffect(() => {
    load();
  }, [load]);

  if (data && !data.connected) {
    return (
      <Card>
        <CardContent className="space-y-2 p-6 text-sm">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <div className="font-medium">YouTube Analytics not connected</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Per-video analytics need a Google OAuth connection so we can pull
                data from the YouTube Analytics API.
              </p>
              <Link href="/settings/integrations#youtube-analytics">
                <Button size="sm" variant="outline" className="mt-2 gap-2">
                  Connect YouTube Analytics
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (data?.error) {
    const is403 = /\b403\b/.test(data.error);
    return (
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardContent className="flex items-start gap-3 p-4 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1">
            <div className="font-medium">
              {is403 ? "Analytics access denied" : "Analytics unavailable"}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {is403
                ? "Channel Permissions Manager doesn't give Analytics API access. The channel owner needs to elevate your role to Brand Account Manager / Owner, or run OAuth from their own Google account."
                : data.error}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => load(true)} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const a = data?.analytics;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                period === p
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              )}
            >
              {p}
            </button>
          ))}
        </div>
        <button
          onClick={() => load(true)}
          disabled={loading}
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          title="Force refresh"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {!a ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading video analytics…
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Headline KPIs — 8 cards now */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat icon={Eye} label="Views" value={fmt(a.totals.views)} />
            <Stat icon={Clock} label="Watch time" value={fmtMinutes(a.totals.watchMinutes)} />
            <Stat
              icon={Target}
              label="Avg view duration"
              value={fmtSec(a.totals.avgViewDurationSec)}
              hint={`${a.totals.averageViewPercentage}% of video`}
            />
            <Stat
              icon={Users}
              label="Net subs"
              value={
                (a.totals.subscribersGained - a.totals.subscribersLost >= 0 ? "+" : "") +
                fmt(a.totals.subscribersGained - a.totals.subscribersLost)
              }
              hint={`+${a.totals.subscribersGained} / -${a.totals.subscribersLost}`}
            />
            <Stat icon={ThumbsUp} label="Likes" value={fmt(a.totals.likes)} />
            <Stat icon={MessageCircle} label="Comments" value={fmt(a.totals.comments)} />
            <Stat icon={Share2} label="Shares" value={fmt(a.totals.shares)} />
            <Stat
              icon={ListPlus}
              label="Playlist adds"
              value={(a.totals.videosAddedToPlaylists >= 0 ? "+" : "") +
                fmt(a.totals.videosAddedToPlaylists)}
              hint={
                a.totals.videosRemovedFromPlaylists > 0
                  ? `${a.totals.videosRemovedFromPlaylists} removed`
                  : undefined
              }
            />
          </div>

          {/* Per-video revenue (when monetary access is available) */}
          {a.revenue && a.revenue.estimatedRevenue > 0 && (
            <Card className="border-emerald-500/40 bg-emerald-50/30 dark:bg-emerald-900/10">
              <CardContent className="space-y-2 p-4">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  💰 Revenue from this video
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  How much this video earned in the selected period.
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat
                    label="Estimated revenue"
                    value={`$${a.revenue.estimatedRevenue.toFixed(2)}`}
                  />
                  <Stat
                    label="Ad revenue"
                    value={`$${a.revenue.estimatedAdRevenue.toFixed(2)}`}
                  />
                  <Stat
                    label="CPM"
                    value={`$${a.revenue.cpm.toFixed(2)}`}
                    hint="Cost per 1k impressions"
                  />
                  <Stat
                    label="Monetized playbacks"
                    value={fmt(a.revenue.monetizedPlaybacks)}
                  />
                </div>
                {a.revenue.estimatedRedPartnerRevenue > 0 && (
                  <div className="text-[11px] text-muted-foreground">
                    YouTube Premium revenue:{" "}
                    <span className="font-medium text-foreground">
                      ${a.revenue.estimatedRedPartnerRevenue.toFixed(2)}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Vs channel average */}
          {a.vsChannelAverage && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <h3 className="text-sm font-medium">vs channel average</h3>
                <p className="text-[11px] text-muted-foreground">
                  How this video compares to your typical video in the same
                  period. 1.0× = average performance.
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <RatioStat
                    label="Views"
                    ratio={a.vsChannelAverage.viewsRatio}
                    avgValue={fmt(a.vsChannelAverage.avgChannelViewsPerVideo)}
                  />
                  <RatioStat
                    label="Watch time"
                    ratio={a.vsChannelAverage.watchTimeRatio}
                    avgValue={fmtMinutes(a.vsChannelAverage.avgChannelWatchMinutesPerVideo)}
                  />
                  <RatioStat
                    label="Avg duration"
                    ratio={a.vsChannelAverage.durationRatio}
                    avgValue={fmtSec(a.vsChannelAverage.avgChannelViewDurationSec)}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Cards & End screen performance */}
          {(a.cards || a.endScreen) && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {a.cards && (
                <Card>
                  <CardContent className="space-y-2 p-4">
                    <h3 className="flex items-center gap-2 text-sm font-medium">
                      <MousePointerClick className="h-3.5 w-3.5 text-primary" />
                      Card performance
                    </h3>
                    <p className="text-[11px] text-muted-foreground">
                      Overlay teaser cards layered on the video.
                    </p>
                    <div className="grid grid-cols-3 gap-3">
                      <Stat label="Impressions" value={fmt(a.cards.impressions)} />
                      <Stat label="Clicks" value={fmt(a.cards.clicks)} />
                      <Stat
                        label="CTR"
                        value={fmtPct(a.cards.ctr * 100)}
                        hint="Clicks / impressions"
                      />
                    </div>
                  </CardContent>
                </Card>
              )}
              {a.endScreen && (
                <Card>
                  <CardContent className="space-y-2 p-4">
                    <h3 className="flex items-center gap-2 text-sm font-medium">
                      <Bookmark className="h-3.5 w-3.5 text-primary" />
                      End-screen performance
                    </h3>
                    <p className="text-[11px] text-muted-foreground">
                      Elements that appear in the last 5-20 seconds.
                    </p>
                    <div className="grid grid-cols-3 gap-3">
                      <Stat label="Impressions" value={fmt(a.endScreen.impressions)} />
                      <Stat label="Clicks" value={fmt(a.endScreen.clicks)} />
                      <Stat
                        label="CTR"
                        value={fmtPct(a.endScreen.ctr * 100)}
                        hint="Clicks / impressions"
                      />
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Daily chart with metric switcher */}
          {a.daily.length > 0 && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-1">
                    {DAILY_METRIC_DEFS.map((m) => (
                      <button
                        key={m.key}
                        onClick={() => setDailyMetric(m.key)}
                        className={cn(
                          "rounded px-2 py-1 text-xs font-medium transition-colors",
                          dailyMetric === m.key
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/70"
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {a.period.startDate} → {a.period.endDate}
                  </span>
                </div>
                <div className="h-[220px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={a.daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="vidDailyFill" x1="0" y1="0" x2="0" y2="1">
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
                        tickFormatter={(v: number) =>
                          dailyMetric === "watchMinutes" ? fmtMinutes(v) : fmt(v)
                        }
                      />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                        formatter={(value) => {
                          const v = Number(value) || 0;
                          const label =
                            DAILY_METRIC_DEFS.find((m) => m.key === dailyMetric)?.label ?? "";
                          const formatted = dailyMetric === "watchMinutes" ? fmtMinutes(v) : fmt(v);
                          return [formatted, label] as [string, string];
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey={dailyMetric}
                        stroke="hsl(var(--primary))"
                        strokeWidth={2}
                        fill="url(#vidDailyFill)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Retention curve */}
          {a.retention.length > 0 && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <h3 className="text-sm font-medium">Audience retention</h3>
                <p className="text-[11px] text-muted-foreground">
                  % of viewers still watching at each point in the video. Big
                  drops are good cuts to study; bumps mean a moment that
                  re-engaged them.
                </p>
                <div className="h-[220px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={a.retention} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="retFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
                          <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="ratio"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                        domain={[0, 1]}
                        type="number"
                      />
                      <YAxis
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                        domain={[0, 1]}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                        labelFormatter={(label) =>
                          `At ${Math.round(Number(label) * 100)}% of video`
                        }
                        formatter={(value, name) => [
                          `${(Number(value) * 100).toFixed(1)}%`,
                          name === "audienceRetention" ? "Watching" : "vs YT avg",
                        ]}
                      />
                      <Area
                        type="monotone"
                        dataKey="audienceRetention"
                        stroke="#10b981"
                        strokeWidth={2}
                        fill="url(#retFill)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Subscribed vs Not — wide card */}
          {a.subscribedStatus.length > 0 && (
            <SubscribedStatusCard rows={a.subscribedStatus} />
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Traffic sources pie */}
            {a.trafficSources.length > 0 && (
              <PieListCard
                title="Traffic sources"
                icon={ArrowUpRight}
                data={a.trafficSources.map((s) => ({
                  key: s.source,
                  label: sourceLabel(s.source),
                  value: s.views,
                }))}
                valueLabel="views"
              />
            )}

            {/* Playback locations pie */}
            {a.playbackLocations.length > 0 && (
              <PieListCard
                title="Playback locations"
                icon={Globe}
                description="Where the video was actually played"
                data={a.playbackLocations.map((p) => ({
                  key: p.location,
                  label: locationLabel(p.location),
                  value: p.views,
                }))}
                valueLabel="views"
              />
            )}

            {/* Top countries */}
            {a.geography.length > 0 && (
              <Card>
                <CardContent className="space-y-2 p-4">
                  <h3 className="text-sm font-medium">Top countries</h3>
                  <div className="h-[220px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={a.geography.slice(0, 10)}
                        layout="vertical"
                        margin={{ top: 4, right: 8, left: 8, bottom: 0 }}
                      >
                        <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" horizontal={false} />
                        <XAxis
                          type="number"
                          stroke="hsl(var(--muted-foreground))"
                          fontSize={10}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(v: number) => fmt(v)}
                        />
                        <YAxis
                          type="category"
                          dataKey="country"
                          stroke="hsl(var(--muted-foreground))"
                          fontSize={10}
                          tickLine={false}
                          axisLine={false}
                          width={32}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: 6,
                            fontSize: 12,
                          }}
                          formatter={(value) => [fmt(Number(value) || 0), "Views"]}
                        />
                        <Bar dataKey="views" fill="hsl(var(--primary))" radius={[0, 3, 3, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Operating systems bar */}
            {a.operatingSystems.length > 0 && (
              <Card>
                <CardContent className="space-y-2 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    <Smartphone className="h-3.5 w-3.5 text-primary" />
                    Operating systems
                  </h3>
                  <ul className="space-y-1.5">
                    {a.operatingSystems.map((o) => {
                      const total = a.operatingSystems.reduce((s, r) => s + r.views, 0) || 1;
                      const pct = (o.views / total) * 100;
                      return (
                        <li key={o.os} className="flex items-center gap-2 text-xs">
                          <span className="w-20 shrink-0 capitalize">
                            {o.os.toLowerCase()}
                          </span>
                          <div className="flex-1">
                            <div className="relative h-2 rounded bg-muted">
                              <div
                                className="absolute inset-y-0 left-0 rounded bg-primary"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                          <span className="w-10 shrink-0 text-right tabular-nums">
                            {pct.toFixed(0)}%
                          </span>
                          <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
                            {fmt(o.views)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Sharing services */}
            {a.sharingServices.length > 0 && (
              <Card>
                <CardContent className="space-y-2 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    <Share2 className="h-3.5 w-3.5 text-primary" />
                    Where viewers shared
                  </h3>
                  <ul className="space-y-1.5">
                    {a.sharingServices.map((s) => {
                      const total = a.sharingServices.reduce((sum, r) => sum + r.shares, 0) || 1;
                      const pct = (s.shares / total) * 100;
                      return (
                        <li key={s.service} className="flex items-center gap-2 text-xs">
                          <span className="w-24 shrink-0 truncate">
                            {s.service.replace(/_/g, " ").toLowerCase()}
                          </span>
                          <div className="flex-1">
                            <div className="relative h-2 rounded bg-muted">
                              <div
                                className="absolute inset-y-0 left-0 rounded bg-primary"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                          <span className="w-12 shrink-0 text-right tabular-nums">
                            {fmt(s.shares)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Top YouTube search terms */}
            {a.searchTerms.length > 0 && (
              <Card>
                <CardContent className="space-y-2 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    <Search className="h-3.5 w-3.5 text-primary" />
                    Top search terms
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    What people typed in YouTube search to find this video.
                  </p>
                  <ul className="space-y-1">
                    {a.searchTerms.slice(0, 12).map((t, i) => (
                      <li
                        key={t.term + i}
                        className="flex items-center gap-2 text-xs"
                      >
                        <span className="w-3 shrink-0 text-muted-foreground tabular-nums">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{t.term}</span>
                        <span className="shrink-0 text-muted-foreground tabular-nums">
                          {fmt(t.views)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Demographics */}
          {a.demographics.length > 0 && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <h3 className="text-sm font-medium">Demographics</h3>
                <p className="text-[11px] text-muted-foreground">
                  Viewer % by age and gender. Sum across all rows ≈ 100%.
                </p>
                <DemographicsBar rows={a.demographics} />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      {Icon ? (
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-primary/10 text-primary">
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="text-[11px] text-muted-foreground">{label}</div>
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">{label}</div>
      )}
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function RatioStat({
  label,
  ratio,
  avgValue,
}: {
  label: string;
  ratio: number;
  avgValue: string;
}) {
  const above = ratio > 1.05;
  const below = ratio < 0.95;
  const Icon = above ? TrendingUp : below ? TrendingDown : null;
  const color = above
    ? "text-green-600 dark:text-green-400"
    : below
      ? "text-red-600 dark:text-red-400"
      : "text-muted-foreground";
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-1 flex items-center gap-1.5 text-lg font-semibold tabular-nums", color)}>
        {Icon && <Icon className="h-4 w-4" />}
        {ratio.toFixed(2)}×
      </div>
      <div className="text-[10px] text-muted-foreground">channel avg: {avgValue}</div>
    </div>
  );
}

function SubscribedStatusCard({
  rows,
}: {
  rows: { status: string; views: number; watchMinutes: number; avgViewDurationSec: number }[];
}) {
  const total = rows.reduce((s, r) => s + r.views, 0) || 1;
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <h3 className="text-sm font-medium">Subscribed vs not subscribed</h3>
        <p className="text-[11px] text-muted-foreground">
          Are existing subscribers watching, or new viewers from discovery?
        </p>
        <div className="space-y-2">
          {rows.map((r) => {
            const pct = (r.views / total) * 100;
            return (
              <div key={r.status} className="space-y-1">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-medium">{subscribedLabel(r.status)}</span>
                  <span className="tabular-nums">
                    {fmt(r.views)}{" "}
                    <span className="text-muted-foreground">({pct.toFixed(0)}%)</span>
                  </span>
                </div>
                <div className="relative h-2 rounded bg-muted">
                  <div
                    className={cn(
                      "absolute inset-y-0 left-0 rounded",
                      r.status === "SUBSCRIBED" ? "bg-primary" : "bg-amber-500"
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex gap-4 text-[10px] text-muted-foreground">
                  <span>Watch: {fmtMinutes(r.watchMinutes)}</span>
                  <span>Avg duration: {fmtSec(r.avgViewDurationSec)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function PieListCard({
  title,
  icon: Icon,
  description,
  data,
  valueLabel,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  description?: string;
  data: { key: string; label: string; value: number }[];
  valueLabel: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Icon className="h-3.5 w-3.5 text-primary" />
          {title}
        </h3>
        {description && (
          <p className="text-[11px] text-muted-foreground">{description}</p>
        )}
        <div className="h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="label"
                innerRadius={45}
                outerRadius={75}
                paddingAngle={2}
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                formatter={(value, name) => [
                  `${fmt(Number(value) || 0)} ${valueLabel}`,
                  String(name),
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="space-y-0.5 text-xs">
          {data.slice(0, 6).map((d, i) => (
            <li key={d.key} className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
              />
              <span className="flex-1 truncate">{d.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {fmt(d.value)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function DemographicsBar({
  rows,
}: {
  rows: { ageGroup: string; gender: string; viewerPercentage: number }[];
}) {
  const data = useMemo(() => {
    const ages = Array.from(
      new Set(rows.map((r) => r.ageGroup).sort((a, b) => a.localeCompare(b)))
    );
    return ages.map((age) => {
      const male =
        rows.find(
          (r) => r.ageGroup === age && /male/i.test(r.gender) && !/female/i.test(r.gender)
        )?.viewerPercentage ?? 0;
      const female =
        rows.find((r) => r.ageGroup === age && /female/i.test(r.gender))?.viewerPercentage ?? 0;
      const other =
        rows.find((r) => r.ageGroup === age && !/male|female/i.test(r.gender))?.viewerPercentage ??
        0;
      return {
        age: age.replace("age", ""),
        male: Number(male.toFixed(1)),
        female: Number(female.toFixed(1)),
        other: Number(other.toFixed(1)),
      };
    });
  }, [rows]);

  return (
    <div className="h-[180px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="age"
            stroke="hsl(var(--muted-foreground))"
            fontSize={10}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="hsl(var(--muted-foreground))"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value, name) => [
              `${value}%`,
              String(name).charAt(0).toUpperCase() + String(name).slice(1),
            ]}
          />
          <Bar dataKey="male" stackId="a" fill="#3b82f6" />
          <Bar dataKey="female" stackId="a" fill="#ec4899" />
          <Bar dataKey="other" stackId="a" fill="#94a3b8" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
