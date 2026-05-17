"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Search,
  Plus,
  RefreshCw,
  Loader2,
  Users,
  AlertCircle,
  Eye,
  ExternalLink,
  Check,
  ArrowLeft,
  Sparkles,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  addedAt: number;
  lastSyncAt: number | null;
  userChannelId: string | null;
  tier: Tier;
  tierSetAt: number | null;
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

type Kpis = {
  competitors: number;
  combinedSubs: number;
  outliersThisWeek: number;
  lastSync: number | null;
};

type UserChannel = {
  id: string;
  title: string | null;
  handle: string | null;
};

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
};

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

type Tab = "overview" | "gaps" | "alerts";
type Period = "7d" | "28d" | "90d";

// Tier display order — matches MENTOR_METHOD §1 strategic priority.
// Breakthrough is the most predictive, so it sorts highest.
const TIER_RANK: Record<Tier, number> = {
  breakthrough: 0,
  authority: 1,
  adjacent: 2,
  far: 3,
};

function fmtCount(n: number | null | undefined): string {
  if (!n && n !== 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtRelative(ts: number | null): string {
  if (!ts) return "never";
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / (86400 * 30))}mo ago`;
}

export default function CompetitorsPage() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [kpis, setKpis] = useState<Kpis>({
    competitors: 0,
    combinedSubs: 0,
    outliersThisWeek: 0,
    lastSync: null,
  });
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unread, setUnread] = useState(0);
  const [inFlight, setInFlight] = useState(0);
  const [tab, setTab] = useState<Tab>("overview");
  const [tierFilters, setTierFilters] = useState<Set<Tier>>(
    new Set(TIERS as readonly Tier[])
  );
  const [migrationView, setMigrationView] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [addTier, setAddTier] = useState<Tier>("authority");
  const [syncingAll, setSyncingAll] = useState(false);
  const [retryingIds, setRetryingIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Topics-Gap state (replaces word-frequency Gap Analysis)
  const [gaps, setGaps] = useState<TopicGap[] | null>(null);
  const [gapsLoading, setGapsLoading] = useState(false);
  const [gapsGeneratedAt, setGapsGeneratedAt] = useState<number | null>(null);
  const [gapsCached, setGapsCached] = useState(false);
  const [gapsError, setGapsError] = useState<string | null>(null);

  const refreshChannels = useCallback(async () => {
    try {
      const r = await fetch("/api/channels", { cache: "no-store" });
      const d = (await r.json()) as {
        channels: UserChannel[];
        activeId: string | null;
      };
      setChannels(d.channels);
      setActiveId(d.activeId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load channels");
    }
  }, []);

  const refresh = useCallback(async () => {
    const qs = migrationView
      ? "?userChannelId=unassigned"
      : activeId
        ? `?userChannelId=${encodeURIComponent(activeId)}`
        : "";
    try {
      const r = await fetch(`/api/competitors${qs}`, { cache: "no-store" });
      const d = (await r.json()) as {
        competitors: Competitor[];
        unreadAlerts: number;
        unassignedCount: number;
        kpis: Kpis;
        inFlight: number;
      };
      setCompetitors(d.competitors);
      setUnread(d.unreadAlerts);
      setUnassignedCount(d.unassignedCount);
      setInFlight(d.inFlight ?? 0);
      if (d.kpis) setKpis(d.kpis);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [activeId, migrationView]);

  const refreshAlerts = useCallback(async () => {
    if (!activeId) return setAlerts([]);
    try {
      const r = await fetch(
        `/api/competitors/alerts?limit=100&userChannelId=${encodeURIComponent(activeId)}`,
        { cache: "no-store" }
      );
      const d = (await r.json()) as { alerts: Alert[] };
      setAlerts(d.alerts);
    } catch {
      /* keep current */
    }
  }, [activeId]);

  const fetchGaps = useCallback(
    async (refresh: boolean) => {
      if (!activeId) {
        setGaps(null);
        return;
      }
      setGapsLoading(true);
      setGapsError(null);
      try {
        const r = await fetch("/api/competitors/topics-gap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userChannelId: activeId, refresh }),
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
          setGapsError(d.error ?? `HTTP ${r.status}`);
          return;
        }
        setGaps(d.gaps);
        setGapsCached(d.cached ?? false);
        setGapsGeneratedAt(d.generatedAt ?? null);
      } catch (e) {
        setGapsError(e instanceof Error ? e.message : "failed");
      } finally {
        setGapsLoading(false);
      }
    },
    [activeId]
  );

  useEffect(() => {
    refreshChannels();
  }, [refreshChannels]);

  useEffect(() => {
    refresh();
    refreshAlerts();
  }, [refresh, refreshAlerts]);

  // Lazy-load gaps when the user actually navigates to the tab. Avoids
  // burning a Claude call on every page load.
  useEffect(() => {
    if (tab === "gaps" && gaps === null && activeId && !gapsLoading) {
      fetchGaps(false);
    }
  }, [tab, gaps, activeId, gapsLoading, fetchGaps]);

  // Polling: while inFlight > 0, GET /api/competitors every 5s so the
  // queued/syncing/synced/failed transitions render live. Stops when
  // every visible row is settled.
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (inFlight > 0 && pollRef.current === null) {
      pollRef.current = window.setInterval(() => {
        refresh();
      }, 5000);
    }
    if (inFlight === 0 && pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current !== null && inFlight === 0) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [inFlight, refresh]);

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === activeId) ?? null,
    [channels, activeId]
  );

  const visibleCompetitors = useMemo(() => {
    const base = migrationView
      ? competitors
      : competitors.filter((c) => tierFilters.has(c.tier));
    // Tier sort then most-recently-added.
    return [...base].sort((a, b) => {
      const t = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (t !== 0) return t;
      return b.addedAt - a.addedAt;
    });
  }, [competitors, tierFilters, migrationView]);

  const addCompetitor = async () => {
    if (!identifier.trim()) return;
    if (!activeId) {
      setError("No active channel — set one from the top-right channel picker.");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const r = await fetch("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier,
          userChannelId: activeId,
          tier: addTier,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        queued?: boolean;
      };
      // 202 + ok:true is the new async happy path. 409 still returns ok:false
      // with an id — we surface the error then.
      if ((!r.ok && r.status !== 202) || !d.ok) {
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      setIdentifier("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setAdding(false);
    }
  };

  const retryOne = async (id: number) => {
    setRetryingIds((prev) => new Set(prev).add(id));
    setError(null);
    try {
      const r = await fetch(`/api/competitors/${id}/sync`, { method: "POST" });
      if (!r.ok && r.status !== 202) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "retry failed");
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const syncAll = async () => {
    setSyncingAll(true);
    setError(null);
    try {
      const r = await fetch("/api/competitors/sync-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userChannelId: activeId }),
      });
      if (!r.ok && r.status !== 202) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncingAll(false);
    }
  };

  const markAlertRead = async (id: number) => {
    await fetch(`/api/competitors/alerts/${id}/read`, { method: "POST" });
    await refreshAlerts();
    await refresh();
  };

  const patchCompetitor = useCallback(
    async (id: number, patch: { userChannelId?: string | null; tier?: Tier }) => {
      setError(null);
      try {
        const r = await fetch(`/api/competitors/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const d = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!r.ok || !d.ok) {
          throw new Error(d.error ?? `HTTP ${r.status}`);
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "update failed");
      }
    },
    [refresh]
  );

  const toggleTierFilter = (t: Tier) => {
    setTierFilters((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Search className="h-6 w-6" />
            Competitor Tracking
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Per-channel competitor lists. Tag each as Authority, Breakthrough,
            Adjacent, or Far.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!migrationView && (
            <Button
              variant="outline"
              size="sm"
              onClick={syncAll}
              disabled={syncingAll || competitors.length === 0}
              className="gap-1.5"
            >
              {syncingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Sync this channel
            </Button>
          )}
        </div>
      </header>

      {!migrationView && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground">
          <span className="text-foreground/70">Active channel:</span>
          <span className="font-medium text-foreground">
            {activeChannel?.title ?? "(none)"}
          </span>
          {activeChannel?.handle && (
            <span className="font-mono">{activeChannel.handle}</span>
          )}
        </div>
      )}

      {!migrationView && unassignedCount > 0 && (
        <button
          type="button"
          onClick={() => setMigrationView(true)}
          className="mb-4 flex w-full items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-sm hover:bg-amber-500/15"
        >
          <span className="inline-flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
            <AlertCircle className="h-4 w-4" />
            You have {unassignedCount} unassigned{" "}
            {unassignedCount === 1 ? "competitor" : "competitors"} from the
            previous app version.
          </span>
          <span className="text-xs text-amber-700/80 dark:text-amber-400/80">
            Review and assign →
          </span>
        </button>
      )}

      {!migrationView && (
        <div className="mb-4 flex gap-4 border-b border-border">
          <TabButton
            active={tab === "overview"}
            onClick={() => setTab("overview")}
          >
            Overview
          </TabButton>
          <TabButton active={tab === "gaps"} onClick={() => setTab("gaps")}>
            <Sparkles className="h-3.5 w-3.5" />
            Topics Gap
            {gaps && gaps.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                {gaps.length}
              </span>
            )}
          </TabButton>
          <TabButton active={tab === "alerts"} onClick={() => setTab("alerts")}>
            Alerts
            {unread > 0 && (
              <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                {unread}
              </span>
            )}
          </TabButton>
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      {migrationView && (
        <MigrationView
          competitors={competitors}
          channels={channels}
          onAssign={patchCompetitor}
          onBack={() => setMigrationView(false)}
        />
      )}

      {!migrationView && tab === "overview" && (
        <div className="space-y-4">
          {/* Slim KPI strip — only the two values that drive ongoing decisions. */}
          <div className="grid grid-cols-2 gap-3">
            <Kpi
              icon={Users}
              label="Competitors"
              value={String(kpis.competitors)}
            />
            <Kpi
              icon={RefreshCw}
              label="Last sync"
              value={fmtRelative(kpis.lastSync)}
            />
          </div>

          {/* Tier filter pills — each with strategic-meaning tooltip via title=""  */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Filter:</span>
            {TIERS.map((t) => {
              const on = tierFilters.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTierFilter(t)}
                  title={TIER_TOOLTIP[t]}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 font-medium transition-colors",
                    on
                      ? TIER_PILL[t]
                      : "border border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {TIER_LABEL[t]}
                </button>
              );
            })}
          </div>

          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-3">
              <Plus className="h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="@handle, channel URL, or UCxxxx..."
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                disabled={adding}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !adding) addCompetitor();
                }}
                className="min-w-[260px] flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0"
              />
              <select
                value={addTier}
                onChange={(e) => setAddTier(e.target.value as Tier)}
                disabled={adding}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                {TIERS.map((t) => (
                  <option key={t} value={t} title={TIER_TOOLTIP[t]}>
                    {TIER_LABEL[t]}
                  </option>
                ))}
              </select>
              <Button
                onClick={addCompetitor}
                disabled={adding || !identifier.trim() || !activeId}
                size="sm"
                className="gap-1.5"
              >
                {adding ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Add Competitor
              </Button>
            </CardContent>
          </Card>

          {inFlight > 0 && (
            <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />
              Syncing {inFlight} competitor{inFlight === 1 ? "" : "s"} in the
              background. The cards below update every 5 seconds.
            </div>
          )}

          {visibleCompetitors.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                {competitors.length === 0
                  ? `No competitors tracked for ${activeChannel?.title ?? "this channel"} yet. Click 'Add Competitor' to start.`
                  : "No competitors match the current tier filter."}
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {visibleCompetitors.map((c) => (
                <CompetitorCard
                  key={c.id}
                  competitor={c}
                  retrying={retryingIds.has(c.id)}
                  onRetry={() => retryOne(c.id)}
                  onTierChange={(t) => patchCompetitor(c.id, { tier: t })}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {!migrationView && tab === "gaps" && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-1">
                <p className="text-sm text-foreground">
                  Topics working for your competitors that you haven&apos;t
                  covered yet. Grounded in MENTOR_METHOD §4 (topics ≠ formats).
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {gapsGeneratedAt ? (
                    <>
                      {gapsCached ? "Cached" : "Generated"}{" "}
                      {fmtRelative(gapsGeneratedAt)} · refresh after 4 hours
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
                disabled={gapsLoading}
                className="gap-1.5"
              >
                {gapsLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {gaps ? "Re-generate" : "Generate"}
              </Button>
            </div>

            {gapsError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                {gapsError}
              </div>
            )}

            {gaps === null && !gapsLoading && !gapsError ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Click <strong>Generate</strong> to run the AI topic-gap pass.
              </div>
            ) : gapsLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                <Loader2 className="mb-1 inline h-4 w-4 animate-spin" />
                <div>Asking Claude to group competitor outliers into topics…</div>
              </div>
            ) : gaps && gaps.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No topic gaps found — either you&apos;ve covered every angle
                your competitors are winning on, or there aren&apos;t enough
                outliers yet.
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
                    <p className="mt-1 text-xs text-muted-foreground">
                      {g.reason}
                    </p>
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
      )}

      {!migrationView && tab === "alerts" && (
        <Card>
          <CardContent className="p-4">
            {alerts.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No viral alerts yet. They appear automatically when a tracked
                competitor&apos;s video crosses 2× their median views.
              </div>
            ) : (
              <ul className="space-y-2">
                {alerts.map((a) => {
                  const ytUrl = `https://www.youtube.com/watch?v=${a.video_id}`;
                  return (
                    <li
                      key={a.id}
                      className={cn(
                        "flex flex-wrap items-start gap-3 rounded-md border p-3",
                        a.read_at
                          ? "border-border bg-background"
                          : "border-amber-500/40 bg-amber-500/5"
                      )}
                    >
                      {a.thumbnail_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={a.thumbnail_url}
                          alt=""
                          className="h-16 w-28 shrink-0 rounded object-cover"
                          referrerPolicy="no-referrer"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <a
                          href={ytUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                        >
                          {a.title ?? "(untitled)"}
                          <ExternalLink className="h-3 w-3 opacity-60" />
                        </a>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          <span>
                            <strong className="text-foreground">
                              {a.competitor_title ?? a.competitor_handle ?? "?"}
                            </strong>
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Eye className="h-3 w-3" />
                            {fmtCount(a.views)} views
                          </span>
                          {a.multiplier && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono font-medium text-amber-700 dark:text-amber-400">
                              {a.multiplier.toFixed(1)}× median
                            </span>
                          )}
                          <span>· {fmtRelative(a.detected_at)}</span>
                        </div>
                      </div>
                      {!a.read_at && (
                        <button
                          type="button"
                          onClick={() => markAlertRead(a.id)}
                          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                          aria-label="Mark read"
                          title="Mark read"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {!migrationView && (
        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          Competitor sync uses your{" "}
          <Link href="/settings/integrations" className="text-primary hover:underline">
            Apify integration
          </Link>
          . No Apify key → sync errors but everything else works (manual entry,
          AI topics-gap on existing data).
        </p>
      )}
    </div>
  );
}

function TabButton({
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
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="truncate text-base font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function SimilarityBadge({ score }: { score: number | null }) {
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
      title="AI-scored channel similarity (0–100). Compared to: your channel's niche + audience. Recomputed after each successful sync."
    >
      {score}% match
    </span>
  );
}

function CompetitorCard({
  competitor,
  retrying,
  onRetry,
  onTierChange,
}: {
  competitor: Competitor;
  retrying: boolean;
  onRetry: () => void;
  onTierChange: (t: Tier) => void;
}) {
  const [period, setPeriod] = useState<Period>("28d");
  const initial = (competitor.title ?? competitor.handle ?? "?")
    .slice(0, 1)
    .toUpperCase();

  const stop = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
  };

  const viewsForPeriod =
    period === "7d"
      ? competitor.views7d
      : period === "28d"
        ? competitor.views28d
        : competitor.views90d;

  const isQueued = competitor.syncStatus === "queued";
  const isSyncing = competitor.syncStatus === "syncing";
  const isFailed = competitor.syncStatus === "failed";
  const isWorking = isQueued || isSyncing;

  return (
    <Link
      href={`/competitors/${competitor.id}`}
      className="block rounded-xl outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card>
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            {competitor.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={competitor.avatarUrl}
                alt=""
                className="h-8 w-8 shrink-0 rounded-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                {initial}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="break-words text-sm font-semibold leading-snug">
                {competitor.title ?? competitor.handle ?? "(syncing…)"}
              </div>
              <div className="mt-0.5 break-all text-xs text-muted-foreground">
                {competitor.handle ?? competitor.channelId ?? "—"}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span
                title={TIER_TOOLTIP[competitor.tier]}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                  TIER_PILL[competitor.tier]
                )}
              >
                {TIER_LABEL[competitor.tier]}
              </span>
              <SimilarityBadge score={competitor.similarityScore} />
            </div>
          </div>

          {/* Sync-state row replaces the metric strip while the sync runs. */}
          {isWorking && (
            <div className="mt-3 flex items-center justify-center gap-2 rounded-md border border-border/60 bg-muted/30 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {isQueued ? "Queued — will sync next" : "Syncing… (fetching videos)"}
            </div>
          )}

          {isFailed && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 min-w-0 break-words">
                Sync failed — {competitor.syncError ?? "unknown error"}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  stop(e);
                  onRetry();
                }}
                disabled={retrying}
                className="rounded-md border border-input bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-accent disabled:opacity-50"
              >
                {retrying ? (
                  <Loader2 className="inline h-3 w-3 animate-spin" />
                ) : (
                  "Retry"
                )}
              </button>
            </div>
          )}

          {!isWorking && !isFailed && (
            <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
              <CardMetric
                label="Subs"
                value={fmtCount(competitor.subscriberCount)}
              />
              <ViewsMetric
                value={viewsForPeriod}
                period={period}
                onPeriodChange={setPeriod}
                onClickStop={stop}
              />
              <CardMetric
                label="Outliers 30d"
                value={String(competitor.outliers30d)}
                highlight={competitor.outliers30d > 0}
              />
              <CardMetric
                label="Last upload"
                value={fmtRelative(competitor.lastUploadAt)}
              />
            </div>
          )}

          {/* Tier dropdown — bottom row, stays clickable during all states. */}
          <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-3 text-[11px]">
            <label
              className="inline-flex items-center gap-1.5 text-muted-foreground"
              onClick={stop}
            >
              <span>Tier:</span>
              <select
                value={competitor.tier}
                onChange={(e) => onTierChange(e.target.value as Tier)}
                onClick={stop}
                title={TIER_TOOLTIP[competitor.tier]}
                className="rounded-md border border-input bg-background px-1.5 py-0.5 text-[11px]"
              >
                {TIERS.map((t) => (
                  <option key={t} value={t} title={TIER_TOOLTIP[t]}>
                    {TIER_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function CardMetric({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 font-semibold",
          highlight && "text-emerald-600 dark:text-emerald-400"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function ViewsMetric({
  value,
  period,
  onPeriodChange,
  onClickStop,
}: {
  value: number;
  period: Period;
  onPeriodChange: (p: Period) => void;
  onClickStop: (e: React.MouseEvent) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Views</span>
        <div className="inline-flex items-center gap-0.5" onClick={onClickStop}>
          {(["7d", "28d", "90d"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={(e) => {
                onClickStop(e);
                onPeriodChange(p);
              }}
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
      <div className="mt-0.5 font-semibold">{fmtCount(value)}</div>
    </div>
  );
}

function MigrationView({
  competitors,
  channels,
  onAssign,
  onBack,
}: {
  competitors: Competitor[];
  channels: UserChannel[];
  onAssign: (
    id: number,
    patch: { userChannelId?: string | null; tier?: Tier }
  ) => Promise<void>;
  onBack: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkChannel, setBulkChannel] = useState<string>(channels[0]?.id ?? "");
  const [bulkTier, setBulkTier] = useState<Tier>("authority");
  const [busy, setBusy] = useState(false);

  const toggleRow = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const assignSelected = async () => {
    if (!bulkChannel || selected.size === 0) return;
    setBusy(true);
    try {
      for (const id of selected) {
        await onAssign(id, { userChannelId: bulkChannel, tier: bulkTier });
      }
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to active channel
        </Button>
        <span className="text-xs text-muted-foreground">
          {competitors.length} unassigned
        </span>
      </div>
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="text-xs text-muted-foreground">
            Pre-rework competitors had no per-channel ownership. Pick a channel
            and tier for each one, or use the bulk row below to assign several
            at once.
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/30 p-2 text-xs">
            <span className="font-medium">Bulk:</span>
            <select
              value={bulkChannel}
              onChange={(e) => setBulkChannel(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              disabled={busy}
            >
              {channels.length === 0 ? (
                <option value="">(no channels)</option>
              ) : (
                channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title ?? c.handle ?? c.id}
                  </option>
                ))
              )}
            </select>
            <select
              value={bulkTier}
              onChange={(e) => setBulkTier(e.target.value as Tier)}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              disabled={busy}
            >
              {TIERS.map((t) => (
                <option key={t} value={t} title={TIER_TOOLTIP[t]}>
                  {TIER_LABEL[t]}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              onClick={assignSelected}
              disabled={busy || !bulkChannel || selected.size === 0}
              className="gap-1.5"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Assign {selected.size > 0 ? `(${selected.size})` : "selected"}
            </Button>
          </div>
          {competitors.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              All competitors are assigned. Click &ldquo;Back to active
              channel&rdquo; to return.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {competitors.map((c) => (
                <MigrationRow
                  key={c.id}
                  competitor={c}
                  channels={channels}
                  checked={selected.has(c.id)}
                  onToggle={() => toggleRow(c.id)}
                  onAssign={(userChannelId, tier) =>
                    onAssign(c.id, { userChannelId, tier })
                  }
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MigrationRow({
  competitor,
  channels,
  checked,
  onToggle,
  onAssign,
}: {
  competitor: Competitor;
  channels: UserChannel[];
  checked: boolean;
  onToggle: () => void;
  onAssign: (userChannelId: string, tier: Tier) => Promise<void>;
}) {
  const [rowChannel, setRowChannel] = useState(channels[0]?.id ?? "");
  const [rowTier, setRowTier] = useState<Tier>("authority");
  const [busy, setBusy] = useState(false);

  const assign = async () => {
    if (!rowChannel) return;
    setBusy(true);
    try {
      await onAssign(rowChannel, rowTier);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-2 py-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4"
        disabled={busy}
        aria-label={`Select ${competitor.title ?? competitor.handle ?? competitor.id}`}
      />
      <span className="min-w-[180px] flex-1 truncate font-medium">
        {competitor.title ?? "(no title yet)"}
      </span>
      <span className="min-w-[120px] truncate text-muted-foreground">
        {competitor.handle ?? competitor.channelId ?? "—"}
      </span>
      <span className="min-w-[60px] text-muted-foreground">
        {fmtCount(competitor.subscriberCount)} subs
      </span>
      <select
        value={rowChannel}
        onChange={(e) => setRowChannel(e.target.value)}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        disabled={busy || channels.length === 0}
      >
        {channels.length === 0 ? (
          <option value="">(no channels)</option>
        ) : (
          channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title ?? c.handle ?? c.id}
            </option>
          ))
        )}
      </select>
      <select
        value={rowTier}
        onChange={(e) => setRowTier(e.target.value as Tier)}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        disabled={busy}
      >
        {TIERS.map((t) => (
          <option key={t} value={t} title={TIER_TOOLTIP[t]}>
            {TIER_LABEL[t]}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        onClick={assign}
        disabled={busy || !rowChannel}
        className="gap-1.5"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
        Assign
      </Button>
    </li>
  );
}

