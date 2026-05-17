"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, ExternalLink, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  TIERS,
  TIER_LABEL,
  TIER_PILL,
  TIER_TOOLTIP,
  type Tier,
} from "@/lib/competitor-tiers";

type SyncStatus = "queued" | "syncing" | "synced" | "failed";

type Competitor = {
  id: number;
  channelId: string | null;
  handle: string | null;
  title: string | null;
  avatarUrl: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  tier: Tier;
  userChannelId: string | null;
  syncStatus: SyncStatus;
  syncError: string | null;
  similarityScore: number | null;
  outliers30d: number;
  medianViews30d: number | null;
  lastUploadAt: number | null;
  recentVideoViews: number[];
  views7d: number;
  views28d: number;
  views90d: number;
};

type CompetitorVideoRow = {
  competitor_id: number;
  video_id: string;
  title: string;
  thumbnail_url: string | null;
  views: number;
  likes: number;
  comments: number;
  duration_seconds: number | null;
  published_at: number | null;
};

type OutlierRow = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  views: number;
  publishedAt: number | null;
  multiplier: number;
  channelMedian: number;
  competitorId: number;
  tier: Tier;
};

type Period = "7d" | "28d" | "90d";

function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtRelative(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w ago`;
  return `${Math.floor(diff / (86400 * 30))}mo ago`;
}

export default function CompetitorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [comp, setComp] = useState<Competitor | null>(null);
  const [videos, setVideos] = useState<CompetitorVideoRow[]>([]);
  const [outliers, setOutliers] = useState<OutlierRow[]>([]);
  const [outliersLoading, setOutliersLoading] = useState(false);
  const [patching, setPatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("28d");

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/competitors/${id}`, { cache: "no-store" });
      const d = (await r.json()) as {
        competitor?: Competitor;
        videos?: CompetitorVideoRow[];
        error?: string;
      };
      if (d.error || !d.competitor) {
        setError(d.error ?? "competitor not found");
        return;
      }
      setComp(d.competitor);
      setVideos(d.videos ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, [id]);

  const refreshOutliers = useCallback(async () => {
    setOutliersLoading(true);
    try {
      const r = await fetch(
        `/api/outliers?competitorId=${encodeURIComponent(id)}`,
        { cache: "no-store" }
      );
      const d = (await r.json()) as { outliers?: OutlierRow[] };
      setOutliers(d.outliers ?? []);
    } catch {
      setOutliers([]);
    } finally {
      setOutliersLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshOutliers();
  }, [refreshOutliers]);

  const patchCompetitor = async (patch: { tier?: Tier }) => {
    if (patching) return;
    setPatching(true);
    setError(null);
    try {
      const r = await fetch(`/api/competitors/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        competitor?: Competitor;
        error?: string;
      };
      if (!r.ok || !d.ok || !d.competitor) {
        setError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      // PATCH response carries the tier-changed slice only — refetch the
      // full record so the metric strip stays consistent.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "update failed");
    } finally {
      setPatching(false);
    }
  };

  const deleteCompetitor = async () => {
    if (!comp) return;
    if (
      !confirm(
        "Remove this competitor and all its synced data? This can't be undone."
      )
    )
      return;
    try {
      const r = await fetch(`/api/competitors/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      window.location.href = "/competitors";
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  };

  if (error && !comp) {
    return (
      <div className="mx-auto max-w-4xl">
        <BackLink />
        <Card>
          <CardContent className="py-12 text-center text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!comp) {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }

  const initial = (comp.title ?? comp.handle ?? "?").slice(0, 1).toUpperCase();
  const viewsForPeriod =
    period === "7d" ? comp.views7d : period === "28d" ? comp.views28d : comp.views90d;
  const recentVideos = [...videos]
    .sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0))
    .slice(0, 20);

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink />

      {/* HEADER CARD */}
      <Card className="mb-4">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            {comp.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={comp.avatarUrl}
                alt=""
                className="h-12 w-12 shrink-0 rounded-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-base font-semibold text-muted-foreground">
                {initial}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h1 className="break-words text-xl font-semibold tracking-tight">
                    {comp.title ?? comp.handle ?? "(syncing…)"}
                  </h1>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    {comp.handle ?? comp.channelId ?? "—"}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <span
                    title={TIER_TOOLTIP[comp.tier]}
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs font-medium",
                      TIER_PILL[comp.tier]
                    )}
                  >
                    {TIER_LABEL[comp.tier]}
                  </span>
                  <SimilarityScore score={comp.similarityScore} />
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>Tier:</span>
                    <select
                      value={comp.tier}
                      onChange={(e) =>
                        patchCompetitor({ tier: e.target.value as Tier })
                      }
                      disabled={patching}
                      title={TIER_TOOLTIP[comp.tier]}
                      className="rounded-md border border-input bg-background px-1.5 py-0.5 text-[11px]"
                    >
                      {TIERS.map((t) => (
                        <option key={t} value={t} title={TIER_TOOLTIP[t]}>
                          {TIER_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={deleteCompetitor}
                    className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove
                  </Button>
                </div>
              </div>
              {error && (
                <div className="mt-2 text-[11px] text-destructive">{error}</div>
              )}
              {comp.syncStatus === "failed" && comp.syncError && (
                <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
                  Last sync failed — {comp.syncError}
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 grid grid-cols-4 gap-3 border-t border-border pt-4 text-center">
            <Metric label="Subs" value={fmtCount(comp.subscriberCount)} />
            <ViewsMetric
              value={viewsForPeriod}
              period={period}
              onPeriodChange={setPeriod}
            />
            <Metric label="Outliers 30d" value={String(comp.outliers30d)} />
            <Metric label="Last upload" value={fmtRelative(comp.lastUploadAt)} />
          </div>
        </CardContent>
      </Card>

      {/* LATEST VIDEOS */}
      <Card className="mb-4">
        <CardContent className="p-6">
          <h2 className="mb-3 text-base font-semibold">Latest videos</h2>
          {recentVideos.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {comp.syncStatus === "queued" || comp.syncStatus === "syncing"
                ? "Waiting for the first sync to land…"
                : "No videos synced yet."}
            </div>
          ) : (
            <ul className="space-y-2">
              {recentVideos.map((v) => {
                const ytUrl = `https://www.youtube.com/watch?v=${v.video_id}`;
                const multiplier =
                  comp.medianViews30d && comp.medianViews30d > 0
                    ? v.views / comp.medianViews30d
                    : null;
                return (
                  <li key={v.video_id} className="flex items-start gap-3">
                    <a
                      href={ytUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0"
                    >
                      {v.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={v.thumbnail_url}
                          alt=""
                          className="h-14 w-24 rounded object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="flex h-14 w-24 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                          no thumb
                        </div>
                      )}
                    </a>
                    <div className="min-w-0 flex-1">
                      <a
                        href={ytUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                      >
                        {v.title}
                        <ExternalLink className="h-3 w-3 opacity-60" />
                      </a>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        <span>{fmtCount(v.views)} views</span>
                        {multiplier && (
                          <span
                            className={cn(
                              "rounded px-1 py-0.5 font-mono",
                              multiplier >= 3
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                                : "text-muted-foreground"
                            )}
                          >
                            {multiplier.toFixed(1)}× median
                          </span>
                        )}
                        <span>{fmtRelative(v.published_at)}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* OUTLIERS */}
      <Card className="mb-4">
        <CardContent className="p-6">
          <h2 className="mb-3 text-base font-semibold">Outliers</h2>
          {outliersLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Loader2 className="inline h-4 w-4 animate-spin" />
            </div>
          ) : outliers.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No outliers from this competitor in the last 30 days. Either no
              video crossed 3× their own median, or there aren&apos;t enough
              videos in the window (the threshold needs at least 5).
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {outliers.map((o) => {
                const ytUrl = `https://www.youtube.com/watch?v=${o.videoId}`;
                return (
                  <li
                    key={o.videoId}
                    className="flex items-start gap-3 rounded-md border border-border/70 p-3"
                  >
                    <a
                      href={ytUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0"
                    >
                      {o.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={o.thumbnailUrl}
                          alt=""
                          className="h-14 w-24 rounded object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="flex h-14 w-24 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                          no thumb
                        </div>
                      )}
                    </a>
                    <div className="min-w-0 flex-1">
                      <a
                        href={ytUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium hover:underline"
                      >
                        {o.title}
                      </a>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono font-medium text-emerald-700 dark:text-emerald-400">
                          {o.multiplier.toFixed(1)}× median
                        </span>
                        <span className="text-muted-foreground">
                          {fmtCount(o.views)} views · median{" "}
                          {fmtCount(o.channelMedian)}
                        </span>
                        <span className="text-muted-foreground">
                          {fmtRelative(o.publishedAt)}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* HOW OUTLIERS ARE DETECTED */}
      <Card>
        <CardContent className="space-y-3 p-6 text-sm leading-relaxed text-muted-foreground">
          <h2 className="text-base font-semibold text-foreground">
            How outliers are detected
          </h2>
          <p>
            An outlier is a video that beats <strong>its own channel&apos;s
            median</strong> by 3× or more (MENTOR_METHOD §2). We do not use
            absolute view thresholds — a 100K-view video on a 10K-subscriber
            channel is a stronger signal than 1M views on a 5M-subscriber one.
          </p>
          <p>
            The median is computed over the last 30 days of uploads. We need
            at least 5 videos in that window before showing outliers for the
            competitor — otherwise the sample is too small to be statistically
            meaningful.
          </p>
          <p>
            Click any outlier to open it on YouTube. Use the AI Chat to ask
            <em> why</em> a specific outlier worked — the agent can attach
            &ldquo;what made it work&rdquo; levers (curiosity, nostalgia,
            counterintuitive, etc.) grounded in §9 of the methodology.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/competitors"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Back to Competitors
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-base font-semibold">{value}</div>
    </div>
  );
}

function ViewsMetric({
  value,
  period,
  onPeriodChange,
}: {
  value: number;
  period: Period;
  onPeriodChange: (p: Period) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Views</span>
        <div className="inline-flex items-center gap-0.5">
          {(["7d", "28d", "90d"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPeriodChange(p)}
              className={cn(
                "rounded px-1 text-[9px] leading-none transition-colors",
                period === p
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground/70 hover:text-foreground"
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-0.5 text-base font-semibold">{fmtCount(value)}</div>
    </div>
  );
}

function SimilarityScore({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <span
        className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        title="AI similarity score — runs after each successful sync."
      >
        — match
      </span>
    );
  }
  const cls =
    score >= 60
      ? "text-emerald-600 dark:text-emerald-400"
      : score >= 30
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";
  return (
    <span
      className={cn("font-mono text-xs font-semibold", cls)}
      title="AI-scored channel similarity (0–100). Compared to: your channel's niche + audience."
    >
      {score}% match
    </span>
  );
}
