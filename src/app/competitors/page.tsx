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
  Check,
  ArrowLeft,
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
  outliers60d: number;
  medianViews60d: number | null;
  lastUploadAt: number | null;
  recentVideoViews: number[];
  totalViews: number;
  totalVideos: number;
};

type Kpis = {
  competitors: number;
  combinedSubs: number;
  lastSync: number | null;
};

type UserChannel = {
  id: string;
  title: string | null;
  handle: string | null;
};

// Tier display order — matches MENTOR_METHOD §1 strategic priority.
// Breakthrough is the most predictive, so it sorts highest.
const TIER_RANK: Record<Tier, number> = {
  breakthrough: 0,
  authority: 1,
  adjacent: 2,
  far: 3,
};

function fmtCount(n: number | null | undefined): string {
  // -1 is our hidden-subs sentinel from youtube.ts's resolveChannel.
  // Channels that opt to hide their sub count return Hidden, not "—".
  if (n === -1) return "Hidden";
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
    lastSync: null,
  });
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [inFlight, setInFlight] = useState(0);
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
        unassignedCount: number;
        kpis: Kpis;
        inFlight: number;
      };
      setCompetitors(d.competitors);
      setUnassignedCount(d.unassignedCount);
      setInFlight(d.inFlight ?? 0);
      if (d.kpis) setKpis(d.kpis);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [activeId, migrationView]);

  useEffect(() => {
    refreshChannels();
  }, [refreshChannels]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

      {!migrationView && (
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
                />
              ))}
            </div>
          )}
        </div>
      )}

      {!migrationView && (
        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          Competitor sync uses your{" "}
          <Link href="/settings/integrations" className="text-primary hover:underline">
            Apify integration
          </Link>
          . No Apify key → sync errors but everything else works (manual entry,
          Topics Gap on{" "}
          <Link href="/outliers?tab=gaps" className="text-primary hover:underline">
            /outliers
          </Link>{" "}
          on existing data).
        </p>
      )}
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
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="truncate text-base font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function SimilarityBadge({
  score,
  syncStatus,
}: {
  score: number | null;
  syncStatus: SyncStatus;
}) {
  if (syncStatus === "queued" || syncStatus === "syncing") {
    return (
      <span
        className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        title="Will compute after the sync finishes."
      >
        — match (calculating)
      </span>
    );
  }
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
}: {
  competitor: Competitor;
  retrying: boolean;
  onRetry: () => void;
}) {
  const initial = (competitor.title ?? competitor.handle ?? "?")
    .slice(0, 1)
    .toUpperCase();

  const stop = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
  };

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
            ) : isWorking ? (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              </div>
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                {initial}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="break-words text-sm font-semibold leading-snug">
                {competitor.title ??
                  competitor.handle ??
                  (isWorking ? (
                    <span className="italic text-muted-foreground">
                      Fetching channel info…
                    </span>
                  ) : (
                    "(no title)"
                  ))}
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
              <SimilarityBadge
                score={competitor.similarityScore}
                syncStatus={competitor.syncStatus}
              />
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
            // Outliers 60d cell moved to the detail-page header only — too
            // dense on the list card alongside similarity %, and the user
            // already drills in for outlier-level work.
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <CardMetric
                label="Subs"
                value={fmtCount(competitor.subscriberCount)}
              />
              <ViewsTrackedCell
                totalViews={competitor.totalViews}
                totalVideos={competitor.totalVideos}
              />
              <CardMetric
                label="Last upload"
                value={fmtRelative(competitor.lastUploadAt)}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function ViewsTrackedCell({
  totalViews,
  totalVideos,
}: {
  totalViews: number;
  totalVideos: number;
}) {
  const tooltip =
    totalVideos > 0
      ? `Total views across the ${totalVideos} most recent videos we've synced. Real time-windowed view growth would require per-video snapshots over time — not implemented yet.`
      : "No videos synced yet for this competitor.";
  return (
    <div title={tooltip}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Views (tracked)
      </div>
      <div className="mt-0.5 font-semibold">{fmtCount(totalViews)}</div>
      <div className="text-[9px] leading-tight text-muted-foreground/70">
        across {totalVideos} {totalVideos === 1 ? "video" : "videos"}
      </div>
    </div>
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

