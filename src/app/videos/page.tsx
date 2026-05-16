"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Search,
  Eye,
  ThumbsUp,
  MessageCircle,
  Upload,
  Clock,
  Sparkles,
  Calendar,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import { TranscribeAllBanner } from "@/components/transcribe-all-banner";

type Video = {
  id: string;
  title: string;
  description: string | null;
  published_at: number | null;
  duration_seconds: number | null;
  views: number;
  likes: number;
  comments: number;
  thumbnail_url: string | null;
};

type Sort = "recent" | "oldest" | "views" | "likes" | "comments" | "engagement";
type Duration = "all" | "short" | "long";

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

function fmtDate(ts: number | null): string {
  if (!ts) return "";
  // Force "en-US" so the month name is always English ("Apr") regardless of
  // the user's OS locale — passing `undefined` would render "квіт." on a
  // Ukrainian Windows install. The platform itself is English-only now,
  // so dates should match.
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Human-friendly "how long ago" for fresh uploads. Returns null if the
 * video is older than ~6 months — at that point an absolute date is more
 * useful and the relative version becomes noise.
 */
function fmtRelative(ts: number | null): string | null {
  if (!ts) return null;
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 0) return null;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  const days = Math.floor(sec / 86400);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 180) return `${Math.floor(days / 30)}mo ago`;
  return null; // older — only absolute date shown
}

function fmtDuration(sec: number | null): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function VideosPage() {
  const { t } = useI18n();
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [duration, setDuration] = useState<Duration>("all");

  useEffect(() => {
    const url = new URL("/api/videos", window.location.origin);
    if (q.trim()) url.searchParams.set("search", q.trim());
    url.searchParams.set("sort", sort);
    url.searchParams.set("duration", duration);
    url.searchParams.set("limit", "200");
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      fetch(url, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => setVideos(d.videos ?? []))
        .catch(() => {});
    }, 200);
    return () => {
      ctrl.abort();
      clearTimeout(id);
    };
  }, [q, sort, duration]);

  const sortOptions: { value: Sort; label: string }[] = useMemo(
    () => [
      { value: "recent", label: t.videos.sort.recent },
      { value: "oldest", label: t.videos.sort.oldest },
      { value: "views", label: t.videos.sort.views },
      { value: "likes", label: t.videos.sort.likes },
      { value: "comments", label: t.videos.sort.comments },
      { value: "engagement", label: t.videos.sort.engagement },
    ],
    [t]
  );

  const durationOptions: { value: Duration; label: string }[] = useMemo(
    () => [
      { value: "all", label: t.videos.duration.all },
      { value: "long", label: t.videos.duration.long },
      { value: "short", label: t.videos.duration.short },
    ],
    [t]
  );

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t.videos.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.videos.subtitle}</p>
      </header>

      <TranscribeAllBanner />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t.videos.search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <SelectPill
            value={sort}
            options={sortOptions}
            onChange={(v) => setSort(v as Sort)}
            label={t.videos.sortLabel}
          />
          <SelectPill
            value={duration}
            options={durationOptions}
            onChange={(v) => setDuration(v as Duration)}
            label={t.videos.durationLabel}
          />
        </div>
      </div>

      {videos === null ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Loading...
          </CardContent>
        </Card>
      ) : videos.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <div className="text-sm text-muted-foreground">{t.videos.empty}</div>
            <Link href="/settings/import">
              <Button size="sm" className="gap-2">
                <Upload className="h-4 w-4" />
                {t.nav.import}
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            {t.videos.countFound.replace("{n}", String(videos.length))}
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {videos.map((v) => (
              <Link
                key={v.id}
                href={`/videos/${v.id}`}
                className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
              >
                <Card className="overflow-hidden transition-colors group-hover:border-primary/40 group-hover:bg-accent/40">
                  <CardContent className="p-0">
                    {v.thumbnail_url ? (
                      <div className="relative aspect-video bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={v.thumbnail_url}
                          alt=""
                          className="h-full w-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                        {v.duration_seconds && (
                          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
                            {fmtDuration(v.duration_seconds)}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="aspect-video bg-muted" />
                    )}
                    <div className="p-3">
                      <div className="mb-1 line-clamp-2 text-sm font-medium leading-snug" title={v.title}>
                        {v.title}
                      </div>
                      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                        {v.published_at && (
                          <span
                            className="inline-flex items-center gap-1 font-medium"
                            title={new Date(v.published_at * 1000).toLocaleString("en-US")}
                          >
                            <Calendar className="h-3 w-3" />
                            {fmtDate(v.published_at)}
                            {fmtRelative(v.published_at) && (
                              <span className="font-normal text-muted-foreground/70">
                                · {fmtRelative(v.published_at)}
                              </span>
                            )}
                          </span>
                        )}
                        {v.duration_seconds !== null && v.duration_seconds <= 60 && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-pink-500/15 px-1 py-0.5 font-medium text-pink-600 dark:text-pink-400">
                            <Sparkles className="h-2.5 w-2.5" />
                            Short
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Eye className="h-3 w-3" />
                          {fmt(v.views)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <ThumbsUp className="h-3 w-3" />
                          {fmt(v.likes)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <MessageCircle className="h-3 w-3" />
                          {fmt(v.comments)}
                        </span>
                        <span className="ml-auto inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {fmtDuration(v.duration_seconds)}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SelectPill({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <label className={cn(
      "inline-flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground",
      "focus-within:ring-2 focus-within:ring-ring"
    )}>
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent py-0.5 pr-1 text-sm text-foreground outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
