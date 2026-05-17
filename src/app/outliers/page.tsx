"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUp,
  Flame,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/* ---------------- Types ---------------- */

type Tier = "authority" | "breakthrough" | "adjacent" | "far";

const TIER_LABEL: Record<Tier, string> = {
  authority: "Authority",
  breakthrough: "Breakthrough",
  adjacent: "Adjacent",
  far: "Far",
};
const TIER_PILL: Record<Tier, string> = {
  authority:
    "bg-sky-500/15 text-sky-700 dark:text-sky-400 border border-sky-500/30",
  breakthrough:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30",
  adjacent:
    "bg-orange-500/15 text-orange-700 dark:text-orange-400 border border-orange-500/30",
  far: "bg-muted text-muted-foreground border border-border",
};

type Outlier = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  views: number;
  publishedAt: number | null;
  durationSeconds: number | null;
  competitorId: number;
  competitorTitle: string | null;
  competitorHandle: string | null;
  competitorAvatar: string | null;
  tier: Tier;
  multiplier: number;
  channelMedian: number;
};

type Explanation = {
  levers: string[];
  explanation: string;
  cached?: boolean;
};

type FormatExample = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  views: number;
  publishedAt: number | null;
  competitorTitle: string | null;
  competitorHandle: string | null;
  competitorSubs: number | null;
  tier: Tier;
  multiplierAtExtract: number;
};

type FormatRow = {
  id: number;
  template: string;
  avgMultiplier: number | null;
  totalViewsMonth: number | null;
  risingRate: number | null;
  extractedAt: number;
  examples: FormatExample[];
  weekly: { weekIndex: number; n: number; avgMult: number }[];
};

const VIEW_MODE_KEY = "dashboard.viewMode";
type TabName = "library" | "patterns";

/* ---------------- Formatters ---------------- */

function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtRelative(ts: number | null): string {
  if (!ts) return "—";
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w ago`;
  return `${Math.floor(diff / (86400 * 30))}mo ago`;
}

function fmtDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ---------------- Page wrapper (Suspense for useSearchParams) ---------------- */

export default function OutliersPage() {
  return (
    <Suspense fallback={null}>
      <OutliersInner />
    </Suspense>
  );
}

function OutliersInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab: TabName =
    searchParams.get("tab") === "patterns" ? "patterns" : "library";

  const [scope, setScope] = useState<string | "all" | null>(null);

  // Resolve scope from localStorage viewMode + active channel pointer.
  useEffect(() => {
    let cancelled = false;
    const viewMode = (typeof window !== "undefined"
      ? window.localStorage.getItem(VIEW_MODE_KEY)
      : null) as "all" | "channel" | null;
    if (viewMode === "all") {
      setScope("all");
      return;
    }
    fetch("/api/channels/active", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { activeId: string | null }) => {
        if (cancelled) return;
        setScope(d.activeId ?? "all");
      })
      .catch(() => {
        if (cancelled) return;
        setScope("all");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const goTab = (t: TabName) => {
    const qs = new URLSearchParams(searchParams.toString());
    if (t === "library") qs.delete("tab");
    else qs.set("tab", t);
    router.push(`${pathname}${qs.toString() ? `?${qs.toString()}` : ""}`);
  };

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Flame className="h-6 w-6 text-amber-500" />
          Outliers
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Competitor videos that beat their own channel&apos;s median by 3× or
          more. Methodology in{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            MENTOR_METHOD.md §2
          </code>
          .
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Want ideas from these outliers?{" "}
          <Link
            href="/chat"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <MessageSquare className="h-3 w-3" />
            Ask the AI Chat →
          </Link>
        </p>
      </header>

      {/* Tab bar */}
      <nav className="mb-6 flex gap-4 border-b border-border">
        <TabLink
          active={activeTab === "library"}
          onClick={() => goTab("library")}
        >
          Library
        </TabLink>
        <TabLink
          active={activeTab === "patterns"}
          onClick={() => goTab("patterns")}
        >
          Patterns
        </TabLink>
      </nav>

      {activeTab === "library" ? (
        <LibraryTab scope={scope} />
      ) : (
        <PatternsTab scope={scope} />
      )}
    </div>
  );
}

function TabLink({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 pb-2 text-sm transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/* ---------------- Library tab ---------------- */

function LibraryTab({ scope }: { scope: string | "all" | null }) {
  const [outliers, setOutliers] = useState<Outlier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openOutlier, setOpenOutlier] = useState<Outlier | null>(null);

  useEffect(() => {
    if (scope === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = scope === "all" ? "?userChannelId=all" : `?userChannelId=${encodeURIComponent(scope)}`;
    fetch(`/api/outliers${qs}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { outliers?: Outlier[]; error?: string }) => {
        if (cancelled) return;
        if (d.error) {
          setError(d.error);
          setOutliers([]);
          return;
        }
        setOutliers(d.outliers ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load outliers.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return (
    <>
      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading outliers…
        </div>
      ) : outliers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No outliers right now. Sync more competitors, or try again after
            their videos have had time to accumulate views.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {outliers.map((o) => (
            <OutlierCard
              key={o.videoId}
              outlier={o}
              onOpen={() => setOpenOutlier(o)}
            />
          ))}
        </div>
      )}
      {openOutlier && (
        <ExplainModal
          outlier={openOutlier}
          onClose={() => setOpenOutlier(null)}
        />
      )}
    </>
  );
}

/* ---------------- Outlier card + explain modal (unchanged from prior step) ---------------- */

function OutlierCard({
  outlier,
  onOpen,
}: {
  outlier: Outlier;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative block w-full rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="overflow-hidden transition-colors group-hover:bg-accent/30">
        <div className="relative aspect-video w-full bg-muted">
          {outlier.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={outlier.thumbnailUrl}
              alt=""
              className="h-full w-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : null}
          {outlier.durationSeconds ? (
            <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-mono text-white">
              {fmtDuration(outlier.durationSeconds)}
            </span>
          ) : null}
          <div className="absolute inset-x-0 bottom-0 flex translate-y-full items-center justify-center bg-gradient-to-t from-black/85 via-black/55 to-transparent p-3 opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-white/15 px-3 py-1 text-xs font-medium text-white backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" />
              Explain why this worked
            </span>
          </div>
        </div>
        <CardContent className="space-y-2 p-3">
          <div className="line-clamp-2 text-sm font-medium leading-snug">
            {outlier.title}
          </div>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate text-muted-foreground">
              {outlier.competitorTitle ?? outlier.competitorHandle ?? "—"}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                TIER_PILL[outlier.tier]
              )}
            >
              {TIER_LABEL[outlier.tier]}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {fmtCount(outlier.views)} views ·{" "}
              <span className="font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                {outlier.multiplier.toFixed(1)}× median
              </span>
            </span>
            <span>{fmtRelative(outlier.publishedAt)}</span>
          </div>
        </CardContent>
      </Card>
    </button>
  );
}

function ExplainModal({
  outlier,
  onClose,
}: {
  outlier: Outlier;
  onClose: () => void;
}) {
  const [data, setData] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/outliers/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: outlier.videoId,
        competitorId: outlier.competitorId,
      }),
    })
      .then((r) => r.json())
      .then((d: Explanation | { error?: string; retryAfterSec?: number }) => {
        if (cancelled) return;
        if ("error" in d) {
          const detail = d.retryAfterSec
            ? `${d.error} (try again in ${d.retryAfterSec}s)`
            : d.error;
          setError(detail ?? "Could not generate explanation.");
          return;
        }
        setData(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Network error.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [outlier]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <Card className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Flame className="h-4 w-4 text-amber-500" />
                Why this outlier worked
              </CardTitle>
              <CardDescription>
                {outlier.competitorTitle ?? outlier.competitorHandle ?? "—"} ·{" "}
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", TIER_PILL[outlier.tier])}>
                  {TIER_LABEL[outlier.tier]}
                </span>{" "}
                · {fmtCount(outlier.views)} views ·{" "}
                <span className="font-bold text-amber-600 dark:text-amber-400">
                  {outlier.multiplier.toFixed(1)}× median
                </span>
              </CardDescription>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {outlier.thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={outlier.thumbnailUrl}
              alt=""
              className="aspect-video w-full rounded-md object-cover"
              referrerPolicy="no-referrer"
            />
          )}
          <div>
            <div className="text-base font-semibold leading-snug">
              {outlier.title}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {fmtRelative(outlier.publishedAt)}
              {outlier.durationSeconds
                ? ` · ${fmtDuration(outlier.durationSeconds)}`
                : ""}
            </div>
            <a
              href={`https://www.youtube.com/watch?v=${outlier.videoId}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-xs text-primary hover:underline"
            >
              Open on YouTube ↗
            </a>
          </div>
          <div className="border-t border-border/60 pt-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              What made it work
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Analyzing…
              </div>
            ) : error ? (
              <div className="text-sm text-destructive">{error}</div>
            ) : data ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {data.levers.map((l) => (
                    <span
                      key={l}
                      className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary"
                    >
                      {l}
                    </span>
                  ))}
                </div>
                <p className="text-sm leading-relaxed">{data.explanation}</p>
                {data.cached && (
                  <p className="text-[10px] text-muted-foreground">
                    (cached — free to re-open)
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------- Patterns tab (Format Library) ---------------- */

type SortKey = "rising" | "avgMultiplier" | "totalViewsMonth";

function PatternsTab({ scope }: { scope: string | "all" | null }) {
  const [formats, setFormats] = useState<FormatRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("rising");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractStatus, setExtractStatus] = useState<string | null>(null);

  // Resolve concrete channel id (Patterns is per-channel — "all" mode
  // doesn't make sense here because formats are keyed by user_channel_id).
  const channelIdParam =
    scope === "all" ? null : scope; // null → server falls back to active

  const load = useCallback(async () => {
    if (scope === null) return;
    setLoading(true);
    setError(null);
    try {
      const qs = channelIdParam
        ? `?userChannelId=${encodeURIComponent(channelIdParam)}`
        : "";
      const r = await fetch(`/api/outliers/formats${qs}`, { cache: "no-store" });
      const d = (await r.json()) as { formats?: FormatRow[]; error?: string };
      if (d.error) {
        setError(d.error);
        setFormats([]);
        return;
      }
      setFormats(d.formats ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load formats.");
    } finally {
      setLoading(false);
    }
  }, [scope, channelIdParam]);

  useEffect(() => {
    load();
  }, [load]);

  const extract = async () => {
    setExtracting(true);
    setExtractError(null);
    setExtractStatus(null);
    try {
      const r = await fetch("/api/outliers/formats/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          channelIdParam ? { userChannelId: channelIdParam } : {}
        ),
      });
      const d = (await r.json()) as {
        formatsCreated?: number;
        videosLinked?: number;
        error?: string;
        retryAfterSec?: number;
      };
      if (!r.ok) {
        setExtractError(
          d.retryAfterSec
            ? `${d.error} (try again in ${Math.ceil(d.retryAfterSec / 60)} min)`
            : (d.error ?? `HTTP ${r.status}`)
        );
        return;
      }
      setExtractStatus(
        `Extracted ${d.formatsCreated} formats covering ${d.videosLinked} videos.`
      );
      await load();
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setExtracting(false);
    }
  };

  const visible = useMemo(() => {
    if (!formats) return [];
    const q = query.trim().toLowerCase();
    let rows = formats;
    if (q) {
      rows = rows.filter((f) => f.template.toLowerCase().includes(q));
    }
    rows = [...rows];
    if (sortKey === "rising") {
      rows.sort((a, b) => (b.risingRate ?? 0) - (a.risingRate ?? 0));
    } else if (sortKey === "avgMultiplier") {
      rows.sort((a, b) => (b.avgMultiplier ?? 0) - (a.avgMultiplier ?? 0));
    } else {
      rows.sort((a, b) => (b.totalViewsMonth ?? 0) - (a.totalViewsMonth ?? 0));
    }
    return rows;
  }, [formats, query, sortKey]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Trending Formats
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Title-format templates extracted from your competitor outliers, per{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
              MENTOR_METHOD.md §4
            </code>
            .
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={extract}
          disabled={extracting}
          className="shrink-0 gap-1.5"
        >
          {extracting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {formats && formats.length > 0 ? "Re-extract" : "Extract"} format patterns
        </Button>
      </div>

      {extractError && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {extractError}
        </div>
      )}
      {extractStatus && (
        <div className="mb-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {extractStatus}
        </div>
      )}

      {/* Search + sort */}
      {formats && formats.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search templates…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="rising">Trending (rising rate)</option>
            <option value="avgMultiplier">Avg outlier</option>
            <option value="totalViewsMonth">Most views (month)</option>
          </select>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading formats…
        </div>
      ) : formats && formats.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 py-12 text-center">
            <Sparkles className="mx-auto h-6 w-6 text-primary" />
            <h3 className="text-base font-semibold">
              No formats extracted yet
            </h3>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              Click <strong>Extract format patterns</strong> above to have
              Claude group your current outliers into structural title
              templates (per MENTOR_METHOD §4). Takes 15–30 seconds.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {visible.map((f) => (
            <FormatCard key={f.id} format={f} />
          ))}
          {visible.length === 0 && query && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No format matches &ldquo;{query}&rdquo;.
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

function FormatCard({ format }: { format: FormatRow }) {
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        {/* Template line with blue placeholders */}
        <div>
          <div className="break-words text-base font-semibold leading-snug">
            <TemplateLine template={format.template} />
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
              <ArrowUp className="h-3 w-3" />
              Rising{" "}
              {format.risingRate !== null
                ? `${format.risingRate.toFixed(1)}×`
                : "—"}
            </span>
            <span className="mx-2">·</span>
            <span>
              {format.avgMultiplier !== null
                ? `${format.avgMultiplier.toFixed(1)}× avg outlier`
                : "— avg"}
            </span>
            <span className="mx-2">·</span>
            <span>
              {fmtCount(format.totalViewsMonth ?? 0)} views (month)
            </span>
          </div>
        </div>

        {/* Examples */}
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Examples
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {format.examples.map((ex) => (
              <ExampleTile key={ex.videoId} ex={ex} />
            ))}
          </div>
        </div>

        {/* Per-format weekly charts */}
        <ChartsStrip weekly={format.weekly} />
      </CardContent>
    </Card>
  );
}

function TemplateLine({ template }: { template: string }) {
  // Split on the brackets but keep them in the result.
  const parts = template.split(/(\[[^\]]+\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[") && p.endsWith("]") ? (
          <span key={i} className="font-mono text-sky-600 dark:text-sky-400">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

function ExampleTile({ ex }: { ex: FormatExample }) {
  return (
    <a
      href={`https://www.youtube.com/watch?v=${ex.videoId}`}
      target="_blank"
      rel="noreferrer"
      className="block rounded-md border border-border/60 transition-colors hover:bg-accent/30"
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-t-md bg-muted">
        {ex.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={ex.thumbnailUrl}
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : null}
        <span
          className={cn(
            "absolute left-1 top-1 rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
            TIER_PILL[ex.tier]
          )}
        >
          {ex.multiplierAtExtract.toFixed(1)}×
        </span>
      </div>
      <div className="space-y-0.5 p-2">
        <div className="line-clamp-2 text-[11px] font-medium leading-snug">
          {ex.title}
        </div>
        <div className="truncate text-[10px] text-muted-foreground">
          {ex.competitorHandle ?? ex.competitorTitle ?? "—"}
          {ex.competitorSubs !== null && (
            <> · {fmtCount(ex.competitorSubs)} subs</>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {fmtCount(ex.views)} · {fmtRelative(ex.publishedAt)}
        </div>
      </div>
    </a>
  );
}

function ChartsStrip({
  weekly,
}: {
  weekly: { weekIndex: number; n: number; avgMult: number }[];
}) {
  if (weekly.length < 4) {
    return (
      <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-center text-[11px] text-muted-foreground">
        Not enough data yet — needs more outliers in this format to plot a
        weekly trend.
      </div>
    );
  }

  // Build a dense 10-bucket series (weekIndex 0..9), filling missing weeks
  // with 0 so the SVG geometry is stable. Week 0 = most recent.
  const dense: { week: number; n: number; avg: number }[] = [];
  for (let w = 0; w < 10; w++) {
    const row = weekly.find((x) => x.weekIndex === w);
    dense.push({ week: w, n: row?.n ?? 0, avg: row?.avgMult ?? 0 });
  }
  // Render oldest → newest left-to-right.
  const ordered = [...dense].reverse();

  return (
    <div className="grid grid-cols-2 gap-3 border-t border-border/60 pt-3">
      <ChartPanel label="Views" data={ordered.map((d) => d.n)} kind="bar" />
      <ChartPanel
        label="Avg outlier"
        data={ordered.map((d) => d.avg)}
        kind="line"
      />
    </div>
  );
}

function ChartPanel({
  label,
  data,
  kind,
}: {
  label: string;
  data: number[];
  kind: "bar" | "line";
}) {
  const max = Math.max(...data, 1);
  const w = 100;
  const h = 32;
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="h-8 w-full text-primary"
      >
        {kind === "bar"
          ? data.map((v, i) => {
              const bw = w / data.length;
              const bh = (v / max) * h;
              return (
                <rect
                  key={i}
                  x={i * bw + 0.5}
                  y={h - bh}
                  width={Math.max(0, bw - 1)}
                  height={bh}
                  fill="currentColor"
                  opacity={0.75}
                />
              );
            })
          : (() => {
              const dx = data.length > 1 ? w / (data.length - 1) : w;
              const points = data
                .map(
                  (v, i) =>
                    `${(i * dx).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`
                )
                .join(" L");
              return (
                <path
                  d={`M${points}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              );
            })()}
      </svg>
    </div>
  );
}
