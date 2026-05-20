"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Eye,
  ThumbsUp,
  MessageCircle,
  Clock,
  Calendar,
  ExternalLink,
  Sparkles,
  Loader2,
  AlertCircle,
  BarChart3,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import { VideoCommentsPanel } from "@/components/video-comments-panel";
import { VideoAnalyticsPanel } from "@/components/video-analytics-panel";

type Video = {
  id: string;
  channel_id: string | null;
  title: string;
  description: string | null;
  published_at: number | null;
  duration_seconds: number | null;
  views: number;
  likes: number;
  comments: number;
  thumbnail_url: string | null;
  tags: string | null;
};

type Channel = { id: string; title: string | null; handle: string | null };

type Detail = {
  video: Video;
  channel: Channel | null;
  commentSummary: { total: number; topLevel: number; fetchedAt: number | null };
};

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

function fmtDuration(sec: number | null | undefined): string {
  if (!sec) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function daysSince(ts: number | null): number | null {
  if (!ts) return null;
  return Math.max(1, Math.floor((Date.now() / 1000 - ts) / 86400));
}

export default function VideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "comments" | "analytics">("overview");

  const loadDetail = useCallback(async () => {
    try {
      const r = await fetch(`/api/videos/${id}`);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      const d = (await r.json()) as Detail;
      setDetail(d);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "failed");
    }
  }, [id]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const tags = useMemo(() => {
    if (!detail?.video.tags) return [];
    try {
      const parsed = JSON.parse(detail.video.tags);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }, [detail?.video.tags]);

  const avgPerDay = useMemo(() => {
    if (!detail?.video.published_at) return null;
    const d = daysSince(detail.video.published_at);
    return d ? Math.round(detail.video.views / d) : null;
  }, [detail]);

  const engagementRate = useMemo(() => {
    if (!detail || detail.video.views === 0) return null;
    return ((detail.video.likes + detail.video.comments) / detail.video.views) * 100;
  }, [detail]);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl">
        <Link href="/videos" className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t.videos.title}
        </Link>
        <Card>
          <CardContent className="flex items-center gap-3 p-8 text-destructive">
            <AlertCircle className="h-5 w-5" />
            {error}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }

  const { video } = detail;
  const ytUrl = `https://www.youtube.com/watch?v=${video.id}`;

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/videos"
        className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t.videos.title}
      </Link>

      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row">
        {video.thumbnail_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={video.thumbnail_url}
            alt=""
            className="h-48 w-full rounded-lg object-cover sm:h-32 sm:w-56"
            referrerPolicy="no-referrer"
          />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{video.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {fmtDate(video.published_at)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {fmtDuration(video.duration_seconds)}
            </span>
            <a
              href={ytUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {t.videoDetail.openOnYouTube}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          {tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {tags.slice(0, 12).map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  #{tag}
                </span>
              ))}
              {tags.length > 12 && (
                <span className="text-[11px] text-muted-foreground">+{tags.length - 12}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* KPIs */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi icon={Eye} label={t.videoDetail.views} value={fmt(video.views)} />
        <Kpi icon={ThumbsUp} label={t.videoDetail.likes} value={fmt(video.likes)} />
        <Kpi icon={MessageCircle} label={t.videoDetail.comments} value={fmt(video.comments)} />
        <Kpi
          icon={Sparkles}
          label={t.videoDetail.engagementRate}
          value={engagementRate !== null ? `${engagementRate.toFixed(2)}%` : "—"}
        />
      </div>

      {avgPerDay !== null && (
        <p className="mb-4 text-xs text-muted-foreground">
          {t.videoDetail.avgViewsPerDay.replace("{n}", fmt(avgPerDay))}
        </p>
      )}

      {/* Tabs */}
      <div className="mb-3 flex flex-wrap gap-1 border-b border-border">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
          {t.videoDetail.tabOverview}
        </TabButton>
        <TabButton active={tab === "analytics"} onClick={() => setTab("analytics")}>
          <BarChart3 className="h-3.5 w-3.5" />
          Analytics
        </TabButton>
        <TabButton active={tab === "comments"} onClick={() => setTab("comments")}>
          <MessageCircle className="h-3.5 w-3.5" />
          {t.videoDetail.tabComments}
          {detail.commentSummary.topLevel > 0 && (
            <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
              {detail.commentSummary.topLevel}
            </span>
          )}
        </TabButton>
      </div>

      {tab === "overview" && (
        <Card>
          <CardContent className="space-y-3 p-5 text-sm">
            <h2 className="font-medium">{t.videoDetail.description}</h2>
            <div className="whitespace-pre-wrap text-muted-foreground">
              {video.description?.trim() || <em>{t.videoDetail.noDescription}</em>}
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "comments" && (
        <VideoCommentsPanel videoId={video.id} initialSummary={detail.commentSummary} />
      )}

      {tab === "analytics" && <VideoAnalyticsPanel videoId={video.id} />}
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="truncate text-base font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function TabButton({
  children,
  active,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
        disabled && "cursor-not-allowed opacity-60 hover:text-muted-foreground"
      )}
    >
      {children}
    </button>
  );
}
