"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Users,
  Eye,
  Video as VideoIcon,
  TrendingUp,
  TrendingDown,
  ThumbsUp,
  MessageSquare,
  ArrowLeft,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Calendar,
  BarChart3,
  Clock,
  Activity,
  FileText,
  Hash,
  Languages,
  Type,
  Minus,
  Rocket,
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
import { cn } from "@/lib/utils";
import { ChannelAudience } from "@/components/channel-audience";
import { ChannelRevenue } from "@/components/channel-revenue";

type Channel = {
  id: string;
  title: string | null;
  handle: string | null;
  description: string | null;
  subscriber_count: number | null;
  view_count: number | null;
  video_count: number | null;
  imported_at: number;
};

type Stats = {
  total: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  avgViews: number;
};

type Analytics = {
  core: {
    total: number;
    totalViews: number;
    totalLikes: number;
    totalComments: number;
    avgViews: number;
    medianViews: number;
    avgLikes: number;
    avgComments: number;
    engagementRate: number;
    likesPerView: number;
    commentsPerView: number;
  };
  performance: {
    minViews: number;
    maxViews: number;
    medianViews: number;
    p25Views: number;
    p75Views: number;
    stdevViews: number;
    aboveMedianPct: number;
    topViralPct: number;
  };
  contentMix: {
    shorts: { count: number; totalViews: number; avgViews: number };
    longForm: { count: number; totalViews: number; avgViews: number };
    durationBuckets: { label: string; count: number; totalViews: number }[];
  };
  transcripts: {
    total: number;
    withTranscript: number;
    coveragePct: number;
    avgChars: number;
    languages: { lang: string; count: number }[];
  };
  cadence: {
    firstUploadTs: number | null;
    lastUploadTs: number | null;
    channelAgeDays: number | null;
    daysSinceLastUpload: number | null;
    avgDaysBetween: number | null;
    uploadsLast30d: number;
    uploadsLast90d: number;
    activeMonths: number;
    silentMonths: number;
  };
  patterns: {
    byDayOfWeek: { day: number; label: string; count: number; avgViews: number }[];
    byHour: { hour: number; count: number }[];
    byMonth: { month: string; count: number; views: number }[];
  };
  themes: {
    topTags: { tag: string; count: number }[];
    topTitleWords: { word: string; count: number }[];
    avgTitleLength: number;
  };
  growth: {
    recent5AvgViews: number | null;
    previous5AvgViews: number | null;
    growthPct: number | null;
    recent10AvgViews: number | null;
    previous10AvgViews: number | null;
    trend: "up" | "down" | "flat" | "insufficient-data";
  };
};

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  } catch {
    return "—";
  }
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return "—";
  return `${n.toFixed(digits)}%`;
}

export default function ChannelPage() {
  const { t } = useI18n();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);

  useEffect(() => {
    fetch("/api/channel")
      .then((r) => r.json())
      .then((d) => {
        setChannel(d.channel ?? null);
        setStats(d.stats ?? null);
        setAnalytics(d.analytics ?? null);
      })
      .catch(() => {});
  }, []);

  if (!channel) {
    return (
      <div className="mx-auto max-w-5xl">
        <Link
          href="/"
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t.channel.backToDashboard}
        </Link>
        <Card>
          <CardHeader>
            <CardTitle>{t.channel.emptyTitle}</CardTitle>
            <CardDescription>{t.channel.emptyDesc}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const engagementRate =
    stats && stats.totalViews > 0
      ? (((stats.totalLikes + stats.totalComments) / stats.totalViews) * 100).toFixed(2) + "%"
      : "—";

  const channelUrl = channel.handle
    ? `https://www.youtube.com/${channel.handle.startsWith("@") ? channel.handle : "@" + channel.handle}`
    : `https://www.youtube.com/channel/${channel.id}`;

  const description = channel.description ?? "";
  const isLongDesc = description.length > 300;
  const shownDesc = descExpanded || !isLongDesc ? description : description.slice(0, 300) + "…";

  const kpis = [
    { label: t.dashboard.kpi.subscribers, value: fmt(channel.subscriber_count), icon: Users },
    {
      label: t.dashboard.kpi.views,
      value: fmt(stats?.totalViews ?? channel.view_count),
      icon: Eye,
    },
    { label: t.dashboard.kpi.videos, value: fmt(stats?.total ?? channel.video_count), icon: VideoIcon },
    { label: t.dashboard.kpi.avgViews, value: fmt(stats?.avgViews ?? null), icon: TrendingUp },
    { label: t.channel.totalLikes, value: fmt(stats?.totalLikes ?? null), icon: ThumbsUp },
    { label: t.channel.totalComments, value: fmt(stats?.totalComments ?? null), icon: MessageSquare },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Link
        href="/"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t.channel.backToDashboard}
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {channel.title ?? t.channel.unknownTitle}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {channel.handle && <span>{channel.handle.startsWith("@") ? channel.handle : "@" + channel.handle}</span>}
          <a
            href={channelUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            {t.channel.openOnYouTube}
          </a>
        </div>
      </header>

      {/* Core KPIs — 6 headline numbers */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <Card key={k.label}>
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] text-muted-foreground truncate">{k.label}</div>
                  <div className="text-base font-semibold tabular-nums">{k.value}</div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* About + Meta */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">{t.channel.aboutTitle}</CardTitle>
            <CardDescription>{t.channel.aboutDesc}</CardDescription>
          </CardHeader>
          <CardContent>
            {description ? (
              <>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {shownDesc}
                </p>
                {isLongDesc && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 h-7 gap-1 px-2 text-xs"
                    onClick={() => setDescExpanded((v) => !v)}
                  >
                    {descExpanded ? (
                      <>
                        <ChevronUp className="h-3 w-3" />
                        {t.channel.showLess}
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3 w-3" />
                        {t.channel.showMore}
                      </>
                    )}
                  </Button>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t.channel.noDescription}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t.channel.metaTitle}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <MetaRow label={t.channel.channelId} value={channel.id} mono />
            {channel.handle && (
              <MetaRow
                label={t.channel.handleLabel}
                value={channel.handle.startsWith("@") ? channel.handle : "@" + channel.handle}
              />
            )}
            <MetaRow
              label={t.channel.importedAt}
              value={fmtDate(channel.imported_at)}
              icon={Calendar}
            />
          </CardContent>
        </Card>
      </div>

      {/* Legacy engagement summary — keeps existing info */}
      {stats && stats.total > 0 && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">{t.channel.engagementTitle}</CardTitle>
            <CardDescription>{t.channel.engagementDesc}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <MiniStat icon={ThumbsUp} label={t.channel.totalLikes} value={fmt(stats.totalLikes)} />
              <MiniStat
                icon={MessageSquare}
                label={t.channel.totalComments}
                value={fmt(stats.totalComments)}
              />
              <MiniStat icon={TrendingUp} label={t.channel.engagementRate} value={engagementRate} />
              <MiniStat icon={VideoIcon} label={t.channel.importedVideos} value={fmt(stats.total)} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* ===== Live YouTube Analytics sections (server-fetched) =====
          These pull straight from the YouTube Analytics API, not the
          local DB. Each component handles its own loading / error /
          permission states — they render `null` when not connected to
          avoid duplicate "connect Google" CTAs (the dashboard already
          has one). */}
      <ChannelAudience />
      <ChannelRevenue />

      {/* ===== Local-DB deep analytics (computed from synced videos) ===== */}
      {analytics && (
        <>
          <GrowthCard analytics={analytics} />
          <PerformanceCard analytics={analytics} />
          <CadenceCard analytics={analytics} />
          <HourOfDayCard analytics={analytics} />
          <ThemesCard analytics={analytics} />
          <TranscriptsCoverageCard analytics={analytics} />
        </>
      )}
    </div>
  );
}

/* ---------------- Section cards ---------------- */

function GrowthCard({ analytics }: { analytics: Analytics }) {
  const { t } = useI18n();
  const g = analytics.growth;
  const TrendIcon =
    g.trend === "up" ? TrendingUp : g.trend === "down" ? TrendingDown : Minus;
  const trendColor =
    g.trend === "up"
      ? "text-green-600 dark:text-green-400"
      : g.trend === "down"
        ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground";
  const trendLabel =
    g.trend === "up"
      ? t.channel.trendUp
      : g.trend === "down"
        ? t.channel.trendDown
        : g.trend === "flat"
          ? t.channel.trendFlat
          : t.channel.trendInsufficient;

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Rocket className="h-4 w-4 text-primary" />
          {t.channel.growthTitle}
        </CardTitle>
        <CardDescription>{t.channel.growthDesc}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex items-center gap-3 rounded-md border bg-muted/30 p-3">
          <TrendIcon className={cn("h-5 w-5", trendColor)} />
          <div className="flex-1">
            <div className={cn("text-sm font-medium", trendColor)}>{trendLabel}</div>
            {g.growthPct !== null && (
              <div className="text-xs text-muted-foreground tabular-nums">
                {g.growthPct > 0 ? "+" : ""}
                {g.growthPct.toFixed(1)}%
              </div>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MiniStat icon={Activity} label={t.channel.recent5Avg} value={fmt(g.recent5AvgViews ?? null)} />
          <MiniStat icon={Activity} label={t.channel.previous5Avg} value={fmt(g.previous5AvgViews ?? null)} />
          <MiniStat icon={Activity} label={t.channel.recent10Avg} value={fmt(g.recent10AvgViews ?? null)} />
          <MiniStat icon={Activity} label={t.channel.previous10Avg} value={fmt(g.previous10AvgViews ?? null)} />
        </div>
      </CardContent>
    </Card>
  );
}

function PerformanceCard({ analytics }: { analytics: Analytics }) {
  const { t } = useI18n();
  const p = analytics.performance;
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="h-4 w-4 text-primary" />
          {t.channel.performanceTitle}
        </CardTitle>
        <CardDescription>{t.channel.performanceDesc}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Percentile strip */}
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <MiniStat label={t.channel.perfMin} value={fmt(p.minViews)} />
          <MiniStat label={t.channel.perfP25} value={fmt(p.p25Views)} />
          <MiniStat label={t.channel.perfMedian} value={fmt(p.medianViews)} />
          <MiniStat label={t.channel.perfP75} value={fmt(p.p75Views)} />
          <MiniStat label={t.channel.perfMax} value={fmt(p.maxViews)} />
        </div>

        {/* Distribution bar — shows min→p25→median→p75→max visually */}
        <DistributionBar performance={p} />

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MiniStat label={t.channel.perfStdev} value={fmt(p.stdevViews)} />
          <MiniStat label={t.channel.perfAboveMedian} value={fmtPct(p.aboveMedianPct)} />
          <MiniStat
            label={t.channel.perfTopViral}
            value={fmtPct(p.topViralPct)}
            hint={t.channel.perfTopViralHint}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function DistributionBar({ performance }: { performance: Analytics["performance"] }) {
  const { minViews, p25Views, medianViews, p75Views, maxViews } = performance;
  if (maxViews === 0) return null;
  const pos = (v: number) => (v / maxViews) * 100;
  return (
    <div className="relative h-8 w-full rounded-md bg-muted">
      {/* IQR box */}
      <div
        className="absolute top-1 bottom-1 rounded bg-primary/30"
        style={{ left: `${pos(p25Views)}%`, width: `${pos(p75Views) - pos(p25Views)}%` }}
      />
      {/* median line */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-primary"
        style={{ left: `${pos(medianViews)}%` }}
      />
      {/* whiskers */}
      <div
        className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-muted-foreground/40"
        style={{ left: `${pos(minViews)}%`, width: `${pos(p25Views) - pos(minViews)}%` }}
      />
      <div
        className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-muted-foreground/40"
        style={{ left: `${pos(p75Views)}%`, width: `${pos(maxViews) - pos(p75Views)}%` }}
      />
    </div>
  );
}

function CadenceCard({ analytics }: { analytics: Analytics }) {
  const { t } = useI18n();
  const c = analytics.cadence;
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-primary" />
          {t.channel.cadenceTitle}
        </CardTitle>
        <CardDescription>{t.channel.cadenceDesc}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <MiniStat
            label={t.channel.firstUpload}
            value={fmtDate(c.firstUploadTs)}
          />
          <MiniStat
            label={t.channel.lastUpload}
            value={fmtDate(c.lastUploadTs)}
          />
          <MiniStat
            label={t.channel.channelAge}
            value={c.channelAgeDays !== null ? `${c.channelAgeDays} ${t.channel.daysShort}` : "—"}
          />
          <MiniStat
            label={t.channel.sinceLastUpload}
            value={
              c.daysSinceLastUpload !== null
                ? `${c.daysSinceLastUpload} ${t.channel.daysShort}`
                : "—"
            }
          />
          <MiniStat
            label={t.channel.avgBetweenUploads}
            value={c.avgDaysBetween !== null ? `${c.avgDaysBetween} ${t.channel.daysShort}` : "—"}
          />
          <MiniStat label={t.channel.uploads30d} value={String(c.uploadsLast30d)} />
          <MiniStat label={t.channel.uploads90d} value={String(c.uploadsLast90d)} />
          <MiniStat
            label={`${t.channel.activeMonths} / ${t.channel.silentMonths}`}
            value={`${c.activeMonths} / ${c.silentMonths}`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function HourOfDayCard({ analytics }: { analytics: Analytics }) {
  const { t } = useI18n();
  const hours = analytics.patterns.byHour;
  const maxCount = Math.max(1, ...hours.map((h) => h.count));
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-primary" />
          {t.channel.hourOfDayTitle}
        </CardTitle>
        <CardDescription>{t.channel.hourOfDayDesc}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-px">
          {hours.map((h) => {
            const height = (h.count / maxCount) * 100;
            return (
              <div
                key={h.hour}
                className="group relative flex flex-1 flex-col items-center"
              >
                <div className="relative flex h-20 w-full items-end">
                  <div
                    className={cn(
                      "w-full rounded-sm bg-primary/60 transition-colors group-hover:bg-primary",
                      h.count === 0 && "bg-muted"
                    )}
                    style={{ height: `${Math.max(height, h.count > 0 ? 4 : 2)}%` }}
                  />
                </div>
                <div className="mt-0.5 text-[9px] font-mono text-muted-foreground">
                  {h.hour % 3 === 0 ? String(h.hour).padStart(2, "0") : "·"}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ThemesCard({ analytics }: { analytics: Analytics }) {
  const { t } = useI18n();
  const th = analytics.themes;
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Hash className="h-4 w-4 text-primary" />
          {t.channel.themesTitle}
        </CardTitle>
        <CardDescription>{t.channel.themesDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Hash className="h-3 w-3" />
            <span className="font-medium text-foreground">{t.channel.topTags}</span>
          </div>
          {th.topTags.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.channel.noTags}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {th.topTags.map((tag) => (
                <span
                  key={tag.tag}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  <span>{tag.tag}</span>
                  <span className="rounded bg-primary/20 px-1 text-[10px] font-mono tabular-nums">
                    {tag.count}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Type className="h-3 w-3" />
            <span className="font-medium text-foreground">{t.channel.topTitleWords}</span>
            <span className="ml-auto text-muted-foreground">
              {t.channel.avgTitleLen}: {th.avgTitleLength} {t.channel.charsShort}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {th.topTitleWords.map((w, i) => {
              const weight = Math.max(0.7, Math.min(1.8, (w.count / (th.topTitleWords[0]?.count || 1)) * 1.4));
              return (
                <span
                  key={w.word + i}
                  className="rounded-full bg-muted px-2 py-0.5 font-mono"
                  style={{ fontSize: `${0.7 * weight}rem` }}
                >
                  {w.word}
                  <span className="ml-1 text-muted-foreground text-[10px]">{w.count}</span>
                </span>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TranscriptsCoverageCard({ analytics }: { analytics: Analytics }) {
  const { t } = useI18n();
  const tr = analytics.transcripts;
  const pct = tr.coveragePct;
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4 text-primary" />
          {t.channel.transcriptsCoverageTitle}
        </CardTitle>
        <CardDescription>{t.channel.transcriptsCoverageDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-sm">
              <span className="font-semibold tabular-nums">{tr.withTranscript}</span>
              <span className="text-muted-foreground"> / {tr.total}</span>
            </span>
            <span className="text-sm font-semibold tabular-nums">{fmtPct(pct)}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full transition-all",
                pct >= 80 ? "bg-green-500" : pct >= 40 ? "bg-amber-500" : "bg-primary/60"
              )}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MiniStat
            icon={Type}
            label={t.channel.avgTranscriptLen}
            value={`${fmt(tr.avgChars)} ${t.channel.charsShort}`}
          />
          <MiniStat icon={Languages} label={t.channel.languagesLabel} value={String(tr.languages.length)} />
        </div>
        {tr.languages.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tr.languages.map((l) => (
              <span
                key={l.lang}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
              >
                <span className="font-mono">{l.lang}</span>
                <span className="rounded bg-primary/20 px-1 text-[10px] font-mono tabular-nums">
                  {l.count}
                </span>
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------- Shared primitives ---------------- */

function MetaRow({
  label,
  value,
  mono,
  icon: Icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </span>
      <span
        className={
          "min-w-0 flex-1 truncate text-right" + (mono ? " font-mono text-xs" : "")
        }
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function MiniStat({
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
    <div
      className="flex items-center gap-3 rounded-md border bg-card p-3"
      title={hint}
    >
      {Icon && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground truncate">{label}</div>
        <div className="truncate text-sm font-semibold tabular-nums">{value}</div>
      </div>
    </div>
  );
}

