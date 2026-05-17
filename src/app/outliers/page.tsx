"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUp,
  Check,
  ExternalLink,
  Eye,
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
type TabName = "recent" | "library" | "patterns" | "gaps";

/* ---------------- Recent + Topics Gap types (shared) ---------------- */

type Alert = {
  id: number;
  competitor_id: number;
  video_id: string;
  title: string | null;
  thumbnail_url: string | null;
  views: number | null;
  channel_median_views: number | null;
  multiplier: number | null;
  detected_at: number;
  read_at: number | null;
  competitor_title: string | null;
  competitor_handle: string | null;
  competitor_tier: Tier;
  published_at: number | null;
};

type AlertSort = "outlier" | "newest" | "views";
type AlertWindow = "all" | "7d" | "28d" | "90d";

// 1× was dropped when the alert generation floor moved to 1.5×. Sourced
// from the same per-browser key the old /competitors Alerts tab used —
// existing users carry over their picked filter.
const ALERTS_MIN_MULT_STOPS = [1.5, 2, 3, 5, 10] as const;
const ALERTS_MIN_MULT_KEY = "alerts.min_multiplier";

type TopicGap = {
  topic: string;
  reason: string;
  avgMultiplier: number;
  totalViews: number;
  examples: Array<{
    videoId: string;
    title: string;
    views: number;
    thumbnailUrl: string;
    competitorTitle: string | null;
    tier: Tier;
  }>;
};

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
  // Default landing tab is Recent — the sidebar badge expects unread
  // discoveries to be one click away, and most session entries come via
  // that badge. Library / Patterns / Gaps remain reachable via ?tab=.
  const tabParam = searchParams.get("tab");
  const activeTab: TabName =
    tabParam === "library" || tabParam === "patterns" || tabParam === "gaps"
      ? tabParam
      : "recent";

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
    // Recent is the default — strip ?tab= so the URL stays clean on
    // the most common landing.
    if (t === "recent") qs.delete("tab");
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
          Competitor videos that beat their own channel&apos;s median. Recent
          shows fresh discoveries (≥1.5× generation floor); Library is the
          methodology view (≥2× per{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            MENTOR_METHOD.md §2
          </code>
          ).
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
      <nav className="mb-6 flex flex-wrap gap-4 border-b border-border">
        <TabLink
          active={activeTab === "recent"}
          onClick={() => goTab("recent")}
        >
          Recent
        </TabLink>
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
        <TabLink
          active={activeTab === "gaps"}
          onClick={() => goTab("gaps")}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Topics Gap
        </TabLink>
      </nav>

      {activeTab === "recent" ? (
        <RecentTab scope={scope} />
      ) : activeTab === "library" ? (
        <LibraryTab scope={scope} />
      ) : activeTab === "patterns" ? (
        <PatternsTab scope={scope} />
      ) : (
        <TopicsGapTab scope={scope} />
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

const MIN_MULT_KEY = "outliers.min_multiplier";
const MIN_MULT_STOPS = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 10.0] as const;

function readPersistedMultiplier(): number {
  if (typeof window === "undefined") return 2;
  const raw = window.localStorage.getItem(MIN_MULT_KEY);
  if (!raw) return 2;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 2;
  return parsed;
}

function LibraryTab({ scope }: { scope: string | "all" | null }) {
  const [outliers, setOutliers] = useState<Outlier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openOutlier, setOpenOutlier] = useState<Outlier | null>(null);
  // Initialise from localStorage on first render so we don't double-fetch.
  // SSR safety: readPersistedMultiplier guards `typeof window`.
  const [minMult, setMinMult] = useState<number>(() => readPersistedMultiplier());

  useEffect(() => {
    window.localStorage.setItem(MIN_MULT_KEY, String(minMult));
  }, [minMult]);

  useEffect(() => {
    if (scope === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("userChannelId", scope === "all" ? "all" : scope);
    params.set("minMultiplier", String(minMult));
    fetch(`/api/outliers?${params.toString()}`, { cache: "no-store" })
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
  }, [scope, minMult]);

  return (
    <>
      {/* Min outlier multiplier — single per-user display filter, persisted
          to localStorage. The server-side default (the count rendered on
          /competitors cards) stays at 2×; this slider only narrows what's
          shown HERE on the Library tab. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Min outlier multiplier:</span>
        <div className="inline-flex flex-wrap items-center gap-1">
          {MIN_MULT_STOPS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setMinMult(v)}
              className={cn(
                "rounded-full px-2.5 py-0.5 font-medium transition-colors",
                minMult === v
                  ? "bg-primary/15 text-primary"
                  : "border border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {v.toFixed(1)}×
            </button>
          ))}
        </div>
        <span className="ml-2 text-muted-foreground">
          Showing outliers ≥ {minMult.toFixed(1)}×
        </span>
      </div>

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
            No outliers at ≥ {minMult.toFixed(1)}×. Try lowering the threshold,
            sync more competitors, or wait for their recent videos to accumulate
            views.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {outliers.map((o) => (
            <OutlierRow
              key={o.videoId}
              videoId={o.videoId}
              title={o.title}
              thumbnailUrl={o.thumbnailUrl}
              views={o.views}
              multiplier={o.multiplier}
              publishedAt={o.publishedAt}
              competitorTitle={o.competitorTitle}
              competitorHandle={o.competitorHandle}
              tier={o.tier}
              durationSeconds={o.durationSeconds}
              onExplain={() => setOpenOutlier(o)}
            />
          ))}
        </ul>
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

/* ---------------- Recent tab (the discovery log) ---------------- */
/**
 * Reads from competitor_alerts — discovered competitor videos at the
 * 1.5× generation floor. Sorted newest first. Per-row mark-read clears
 * the sidebar badge. Read-state and the filter/sort knobs live here;
 * Library is the strictly-2× methodology view with no read state.
 */
function RecentTab({ scope }: { scope: string | "all" | null }) {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<AlertSort>("outlier");
  const [windowKey, setWindowKey] = useState<AlertWindow>("all");
  const [minMult, setMinMult] = useState<number>(2);

  // Preserve the per-browser filter the old /competitors Alerts tab used.
  // Guard at 1.5 so a stale "1" from before the 1× pill was dropped snaps
  // back to the default of 2 instead of leaving no pill highlighted.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(ALERTS_MIN_MULT_KEY);
    if (!raw) return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 1.5) setMinMult(parsed);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ALERTS_MIN_MULT_KEY, String(minMult));
  }, [minMult]);

  const refresh = useCallback(async () => {
    if (scope === null) return;
    // The alerts endpoint scopes to one user channel. "all" mode falls
    // back to the active channel server-side (passing "all" disables the
    // scope and surfaces cross-channel alerts — Recent stays per-channel
    // to match the sidebar badge semantics).
    const channelParam = scope === "all" ? "all" : scope;
    try {
      const r = await fetch(
        `/api/competitors/alerts?limit=100&userChannelId=${encodeURIComponent(
          channelParam
        )}`,
        { cache: "no-store" }
      );
      const d = (await r.json()) as { alerts?: Alert[]; error?: string };
      if (d.error) {
        setError(d.error);
        setAlerts([]);
        return;
      }
      setAlerts(d.alerts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
    }
  }, [scope]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const markRead = async (id: number) => {
    await fetch(`/api/competitors/alerts/${id}/read`, { method: "POST" });
    await refresh();
  };

  const filtered = useMemo(() => {
    if (!alerts) return [];
    const now = Math.floor(Date.now() / 1000);
    const windowSec =
      windowKey === "7d"
        ? 7 * 86400
        : windowKey === "28d"
          ? 28 * 86400
          : windowKey === "90d"
            ? 90 * 86400
            : null;
    const out = alerts.filter((a) => {
      if (windowSec !== null) {
        const t = a.published_at ?? a.detected_at;
        if (now - t > windowSec) return false;
      }
      // Alerts without a multiplier slip through at the lowest stop and get
      // dropped at anything higher — historical rows from before multiplier
      // was tracked, harmless.
      if (minMult > 1.5) {
        if (a.multiplier === null || a.multiplier < minMult) return false;
      }
      return true;
    });
    return out.sort((a, b) => {
      if (sort === "newest") {
        return (
          (b.published_at ?? b.detected_at) - (a.published_at ?? a.detected_at)
        );
      }
      if (sort === "views") {
        return (b.views ?? 0) - (a.views ?? 0);
      }
      return (b.multiplier ?? 0) - (a.multiplier ?? 0);
    });
  }, [alerts, sort, windowKey, minMult]);

  if (alerts === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading recent discoveries…
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Filter row — Sort + Window on line 1, Min outlier on line 2. */}
      <div className="mb-3 space-y-2 border-b border-border/60 pb-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span>Sort:</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as AlertSort)}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            >
              <option value="outlier">Highest outlier score</option>
              <option value="newest">Newest upload</option>
              <option value="views">Most views</option>
            </select>
          </label>
          <div className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground">Window:</span>
            {(["all", "7d", "28d", "90d"] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindowKey(w)}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
                  windowKey === w
                    ? "bg-primary/15 text-primary"
                    : "border border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {w === "all" ? "All" : w}
              </button>
            ))}
          </div>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {filtered.length} alert{filtered.length === 1 ? "" : "s"} shown
            {filtered.length !== alerts.length && (
              <span className="text-muted-foreground/60">
                {" "}
                (of {alerts.length})
              </span>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">Min outlier:</span>
          {ALERTS_MIN_MULT_STOPS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setMinMult(v)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
                minMult === v
                  ? "bg-primary/15 text-primary"
                  : "border border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {`${v}×`}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {alerts.length === 0
            ? "Alerts surface competitor videos at ≥ 1.5× their channel's median views. Add competitors and sync to populate."
            : "No alerts match these filters. Try widening the window or lowering the min outlier."}
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((a) => (
            <OutlierRow
              key={a.id}
              videoId={a.video_id}
              title={a.title}
              thumbnailUrl={a.thumbnail_url}
              views={a.views}
              multiplier={a.multiplier}
              publishedAt={a.published_at}
              detectedAt={a.detected_at}
              competitorTitle={a.competitor_title}
              competitorHandle={a.competitor_handle}
              tier={a.competitor_tier}
              isUnread={!a.read_at}
              onMarkRead={() => markRead(a.id)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/* ---------------- Topics Gap tab (ported from /competitors) ---------------- */
/**
 * AI grouping of competitor outliers into topics the user hasn't covered.
 * Lazy-loads on first tab open so we don't burn a Claude call on every
 * page visit. Cached server-side per active channel for 4 hours.
 */
function TopicsGapTab({ scope }: { scope: string | "all" | null }) {
  const [gaps, setGaps] = useState<TopicGap[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [cached, setCached] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Topics Gap is per-channel; "all" mode doesn't make sense because the
  // server keys the cache by user_channel_id. Pass scope through; the
  // route falls back to the active channel when no userChannelId is given.
  const fetchGaps = useCallback(
    async (refresh: boolean) => {
      if (scope === null) return;
      setLoading(true);
      setError(null);
      try {
        const r = await fetch("/api/competitors/topics-gap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            scope === "all" ? { refresh } : { userChannelId: scope, refresh }
          ),
          cache: "no-store",
        });
        const d = (await r.json()) as {
          ok?: boolean;
          gaps?: TopicGap[];
          cached?: boolean;
          generatedAt?: number;
          error?: string;
        };
        if (!r.ok || !d.ok || !Array.isArray(d.gaps)) {
          setGaps(null);
          setError(d.error ?? `HTTP ${r.status}`);
          return;
        }
        setGaps(d.gaps);
        setCached(d.cached ?? false);
        setGeneratedAt(d.generatedAt ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed");
      } finally {
        setLoading(false);
      }
    },
    [scope]
  );

  // Lazy load on first render — only when we have a real scope.
  useEffect(() => {
    if (scope !== null && gaps === null && !loading) {
      void fetchGaps(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm text-foreground">
              Topics working for your competitors that you haven&apos;t covered
              yet. Grounded in MENTOR_METHOD §4 (topics ≠ formats).
            </p>
            <p className="text-[11px] text-muted-foreground">
              {generatedAt ? (
                <>
                  {cached ? "Cached" : "Generated"} {fmtRelative(generatedAt)} ·
                  refresh after 4 hours
                </>
              ) : (
                "Click the button to generate. Cached 4 hours per channel."
              )}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => fetchGaps(true)}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {gaps ? "Re-generate" : "Generate"}
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </div>
        )}

        {gaps === null && !loading && !error ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Click <strong>Generate</strong> to run the AI topic-gap pass.
          </div>
        ) : loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loader2 className="mb-1 inline h-4 w-4 animate-spin" />
            <div>Asking Claude to group competitor outliers into topics…</div>
          </div>
        ) : gaps && gaps.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No topic gaps found — either you&apos;ve covered every angle your
            competitors are winning on, or there aren&apos;t enough outliers
            yet.
          </div>
        ) : gaps ? (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {gaps.map((g) => (
              <li
                key={g.topic}
                className="rounded-md border border-border/70 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold leading-snug">
                    {g.topic}
                  </h3>
                  <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                    {g.avgMultiplier.toFixed(1)}×
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{g.reason}</p>
                {g.examples.length > 0 && (
                  <div className="mt-2 flex gap-1.5">
                    {g.examples.map((ex) => (
                      <a
                        key={ex.videoId}
                        href={`https://www.youtube.com/watch?v=${ex.videoId}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`${ex.title} — ${ex.competitorTitle ?? "?"} (${TIER_LABEL[ex.tier]})`}
                        className="block w-16 shrink-0"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={ex.thumbnailUrl}
                          alt=""
                          className="h-9 w-16 rounded object-cover"
                          referrerPolicy="no-referrer"
                        />
                      </a>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ---------------- Shared row card (used by Recent + Library) ---------------- */
/**
 * Single row visual used by both Recent and Library. The two tabs feed
 * different data shapes (alert row vs live outlier row) but they show
 * the same fields in the same arrangement — keeps the visual contract
 * consistent and means a card-styling change only happens in one place.
 *
 * Optional knobs:
 *   - isUnread          → amber unread accent (Recent only)
 *   - onExplain         → click anywhere on the row opens the ExplainModal
 *                          (Library only; renders a Sparkles affordance)
 *   - onMarkRead        → renders a Check button when isUnread (Recent only)
 *   - durationSeconds   → small overlay on the thumbnail (Library only)
 *   - detectedAt        → "detected Xh ago" tooltip on the upload date
 *                          (Recent only)
 */
type OutlierRowProps = {
  videoId: string;
  title: string | null;
  thumbnailUrl: string | null;
  views: number | null;
  multiplier: number | null;
  publishedAt: number | null;
  competitorTitle: string | null;
  competitorHandle: string | null;
  tier: Tier;
  detectedAt?: number | null;
  durationSeconds?: number | null;
  isUnread?: boolean;
  onExplain?: () => void;
  onMarkRead?: () => void;
};

function OutlierRow(props: OutlierRowProps) {
  const ytUrl = `https://www.youtube.com/watch?v=${props.videoId}`;
  // Fall back to detection time for the rare orphaned-alert case
  // (competitor_videos row deleted but alert remains).
  const uploadTs = props.publishedAt ?? props.detectedAt ?? null;
  const uploadLabel = props.publishedAt !== null ? "uploaded" : "detected";
  const clickable = !!props.onExplain;
  return (
    <li
      onClick={clickable ? props.onExplain : undefined}
      className={cn(
        "group flex flex-wrap items-start gap-3 rounded-md border p-3 transition-colors",
        props.isUnread
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-border bg-background",
        clickable && "cursor-pointer hover:bg-accent/40"
      )}
    >
      {props.thumbnailUrl && (
        <div className="relative shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={props.thumbnailUrl}
            alt=""
            className="h-16 w-28 rounded object-cover"
            referrerPolicy="no-referrer"
          />
          {props.durationSeconds ? (
            <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 py-0.5 text-[9px] font-mono text-white">
              {fmtDuration(props.durationSeconds)}
            </span>
          ) : null}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <a
          href={ytUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-start gap-1 text-sm font-medium leading-snug hover:underline"
        >
          <span className="line-clamp-2">{props.title ?? "(untitled)"}</span>
          <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
        </a>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>
            <strong className="text-foreground">
              {props.competitorTitle ?? props.competitorHandle ?? "?"}
            </strong>
          </span>
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              TIER_PILL[props.tier]
            )}
          >
            {TIER_LABEL[props.tier]}
          </span>
          <span className="inline-flex items-center gap-1">
            <Eye className="h-3 w-3" />
            {fmtCount(props.views)} views
          </span>
          {props.multiplier !== null && props.multiplier !== undefined && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono font-medium text-amber-700 dark:text-amber-400">
              {props.multiplier.toFixed(1)}× median
            </span>
          )}
          {uploadTs !== null && (
            <span
              title={
                props.detectedAt
                  ? `Detected ${fmtRelative(props.detectedAt)}`
                  : undefined
              }
            >
              · {uploadLabel} {fmtRelative(uploadTs)}
            </span>
          )}
        </div>
      </div>
      {clickable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onExplain?.();
          }}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Explain why this worked"
          title="Explain why this worked"
        >
          <Sparkles className="h-3.5 w-3.5" />
        </button>
      )}
      {props.isUnread && props.onMarkRead && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onMarkRead?.();
          }}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Mark read"
          title="Mark read"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
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
