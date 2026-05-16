"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Users,
  Eye,
  Video,
  TrendingUp,
  Upload,
  ChevronDown,
  ChevronUp,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  Calendar,
  RefreshCw,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";
import { ConnectBanner } from "@/components/connect-banner";
import { StudioOverview } from "@/components/studio-overview";
import { TodaysEarnings } from "@/components/todays-earnings";
import { MultiChannelEarnings } from "@/components/multi-channel-earnings";
import { TagsOverview } from "@/components/tags-overview";
import { DashboardTabs } from "@/components/dashboard-tabs";
import { AllChannelsOverview } from "@/components/all-channels-overview";
import { cn } from "@/lib/utils";

type Stats = {
  total: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  avgViews: number;
};

type Channel = {
  id: string;
  title: string | null;
  subscriber_count: number | null;
  view_count: number | null;
  video_count: number | null;
};

type VideoLite = {
  id: string;
  title: string;
  views: number;
  likes: number;
  comments: number;
  published_at: number | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
};

type EngVideo = VideoLite & { engagement: number };
type OutlierVideo = VideoLite & { zscore: number };

type Aggregates = {
  topByViews: VideoLite[];
  topByEngagement: EngVideo[];
  bottomByViews: VideoLite[];
  outliers: OutlierVideo[];
  byMonth: { month: string; count: number; views: number }[];
};

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

export default function DashboardPage() {
  const { t } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [aggregates, setAggregates] = useState<Aggregates | null>(null);
  const [expanded, setExpanded] = useState(false);
  // "all" = cross-channel summary view (selected via DashboardTabs);
  // "channel" = the existing single-channel dashboard. Defaults to
  // "channel" until DashboardTabs reads its persisted preference and
  // calls onModeChange.
  const [viewMode, setViewMode] = useState<"all" | "channel">("channel");
  const [refreshing, setRefreshing] = useState(false);
  // Bumped each time the user hits Refresh — child components keyed off
  // this re-mount and re-fetch fresh data.
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      // Bust the analytics-cache table on the server, then re-fetch
      // dashboard aggregates and force every refresh-key-aware child
      // (Studio Overview, today's earnings, multi-channel, etc.) to
      // re-fetch by changing their key.
      await fetch("/api/analytics/cache", { method: "POST" });
      const r = await fetch("/api/dashboard");
      const d = await r.json();
      setStats(d.stats);
      setChannel(d.channel);
      setAggregates(d.aggregates);
      setRefreshKey((k) => k + 1);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((d) => {
        setStats(d.stats);
        setChannel(d.channel);
        setAggregates(d.aggregates);
      })
      .catch(() => {});
  }, []);

  const hasData = (stats?.total ?? 0) > 0;

  const kpis = [
    {
      label: t.dashboard.kpi.subscribers,
      value: fmt(channel?.subscriber_count ?? null),
      icon: Users,
    },
    {
      label: t.dashboard.kpi.views,
      value: fmt(stats?.totalViews ?? (channel?.view_count ?? null)),
      icon: Eye,
    },
    {
      label: t.dashboard.kpi.videos,
      value: fmt(stats?.total ?? null),
      icon: Video,
    },
    {
      label: t.dashboard.kpi.avgViews,
      value: fmt(stats?.avgViews ?? null),
      icon: TrendingUp,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t.dashboard.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {viewMode === "all"
              ? "All connected channels — combined view"
              : channel?.title
                ? channel.title
                : t.dashboard.subtitle}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            className="gap-1.5"
            title="Bust the analytics cache and reload fresh data"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
          {channel && viewMode === "channel" && (
            <Link href="/channel">
              <Button variant="outline" size="sm" className="gap-2">
                <ArrowUpRight className="h-3.5 w-3.5" />
                {t.dashboard.channelDetails}
              </Button>
            </Link>
          )}
        </div>
      </header>

      <ConnectBanner />

      {/* Multi-channel tab bar — auto-hides when only 0/1 channels are
          connected. Lets the user pick "All channels" (cross-channel
          aggregate) or any specific channel. */}
      <DashboardTabs onModeChange={setViewMode} />

      {/* Cross-channel summary view */}
      {viewMode === "all" && <AllChannelsOverview key={`all-${refreshKey}`} />}

      {/* Per-channel widgets — hidden when "All channels" tab is active.
          `key={refreshKey}` forces a full re-mount when the user clicks
          Refresh, so each widget re-runs its useEffect and re-fetches
          freshly (after the server-side analytics cache was busted). */}
      {viewMode === "channel" && channel && (
        <>
          <MultiChannelEarnings key={`mc-${refreshKey}`} />
          <TagsOverview key={`tg-${refreshKey}`} />
          <TodaysEarnings key={`te-${refreshKey}`} />
        </>
      )}

      {viewMode === "channel" && channel && <StudioOverview key={`so-${refreshKey}`} />}

      {viewMode === "channel" && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {kpis.map((k) => {
            const Icon = k.icon;
            return (
              <Card key={k.label}>
                <CardContent className="flex items-center gap-4 p-5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{k.label}</div>
                    <div className="text-xl font-semibold">{k.value}</div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {viewMode === "channel" && !hasData ? (
        <Card>
          <CardHeader>
            <CardTitle>{t.dashboard.emptyTitle}</CardTitle>
            <CardDescription>{t.dashboard.noData}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/settings/import">
              <Button size="sm" className="gap-2">
                <Upload className="h-4 w-4" />
                {t.nav.import}
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : viewMode === "channel" && hasData ? (
        <>
          <Card className="mb-4">
            <CardHeader
              className="cursor-pointer"
              onClick={() => setExpanded((v) => !v)}
              role="button"
            >
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Zap className="h-4 w-4 text-primary" />
                    {t.dashboard.deeper}
                  </CardTitle>
                  <CardDescription className="mt-1">{t.dashboard.deeperDesc}</CardDescription>
                </div>
                {expanded ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
            </CardHeader>
            {expanded && aggregates && (
              <CardContent className="space-y-4">
                {aggregates.outliers.length > 0 && (
                  <OutliersBlock videos={aggregates.outliers} />
                )}
                {aggregates.bottomByViews.length > 0 && (
                  <VideoListCard
                    title={t.dashboard.bottomByViews}
                    description={t.dashboard.bottomByViewsDesc}
                    icon={ArrowDownRight}
                    accent="text-muted-foreground"
                    videos={aggregates.bottomByViews}
                    metricKey="views"
                    embedded
                  />
                )}
                {aggregates.byMonth.length > 0 && (
                  <MonthlyBars byMonth={aggregates.byMonth} />
                )}
              </CardContent>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

function VideoListCard({
  title,
  description,
  icon: Icon,
  accent,
  videos,
  metricKey,
  embedded,
}: {
  title: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  videos: (VideoLite & { engagement?: number; zscore?: number })[];
  metricKey: "views" | "engagement";
  embedded?: boolean;
}) {
  const body = (
    <ul className="space-y-2">
      {videos.map((v, i) => (
        <li key={v.id}>
          <Link
            href={`/videos/${v.id}`}
            className="flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent"
          >
            <span className="w-4 shrink-0 text-xs font-mono text-muted-foreground">
              {i + 1}
            </span>
            {v.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={v.thumbnail_url}
                alt=""
                className="h-8 w-14 shrink-0 rounded object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="h-8 w-14 shrink-0 rounded bg-muted" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm">{v.title}</span>
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              {metricKey === "engagement" && v.engagement !== undefined
                ? `${(v.engagement * 100).toFixed(2)}%`
                : fmt(v.views)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );

  if (embedded) {
    return (
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Icon className={cn("h-4 w-4", accent)} />
          <h3 className="text-sm font-medium">{title}</h3>
        </div>
        {description && <p className="mb-2 text-xs text-muted-foreground">{description}</p>}
        {body}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className={cn("h-4 w-4", accent)} />
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function OutliersBlock({ videos }: { videos: OutlierVideo[] }) {
  const { t } = useI18n();
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Zap className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-medium">{t.dashboard.outliers}</h3>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{t.dashboard.outliersDesc}</p>
      <ul className="space-y-1.5">
        {videos.map((v) => (
          <li key={v.id}>
            <Link
              href={`/videos/${v.id}`}
              className="flex items-center gap-3 rounded-md px-2 py-1 transition-colors hover:bg-accent"
            >
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono",
                  v.zscore > 0
                    ? "bg-green-500/15 text-green-600 dark:text-green-400"
                    : "bg-red-500/15 text-red-600 dark:text-red-400"
                )}
                title="z-score relative to channel average"
              >
                {v.zscore > 0 ? "+" : ""}
                {v.zscore.toFixed(1)}σ
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{v.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{fmt(v.views)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MonthlyBars({ byMonth }: { byMonth: { month: string; count: number; views: number }[] }) {
  const { t } = useI18n();
  const maxViews = useMemo(() => Math.max(1, ...byMonth.map((m) => m.views)), [byMonth]);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Calendar className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t.dashboard.monthly}</h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t.dashboard.monthlyDesc}</p>
      <div className="space-y-1">
        {byMonth.map((m) => (
          <div key={m.month} className="flex items-center gap-2 text-xs">
            <span className="w-16 shrink-0 font-mono text-muted-foreground">{m.month}</span>
            <div className="flex-1">
              <div className="relative h-4 rounded bg-muted">
                <div
                  className="absolute inset-y-0 left-0 rounded bg-primary/60"
                  style={{ width: `${(m.views / maxViews) * 100}%` }}
                />
              </div>
            </div>
            <span className="w-12 shrink-0 text-right text-muted-foreground">
              {fmt(m.views)}
            </span>
            <span className="w-12 shrink-0 text-right text-muted-foreground">
              {m.count} {t.dashboard.monthlyCountSuffix}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
