"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Search,
  Plus,
  RefreshCw,
  Trash2,
  Loader2,
  Users,
  AlertCircle,
  TrendingUp,
  Eye,
  ExternalLink,
  Check,
  ArrowLeft,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Tier vocabulary mirrors MENTOR_METHOD.md §1 — UI labels are the exact
// names from the methodology so the user maps them 1:1.
const TIERS = ["authority", "breakthrough", "adjacent", "far"] as const;
type Tier = (typeof TIERS)[number];

const TIER_LABEL: Record<Tier, string> = {
  authority: "Authority",
  breakthrough: "Breakthrough",
  adjacent: "Adjacent",
  far: "Far",
};

// Pill colors. Authority = blue (established), Breakthrough = green
// (currently winning), Adjacent = orange (related niche), Far = grey
// (unrelated audience).
const TIER_PILL: Record<Tier, string> = {
  authority:
    "bg-sky-500/15 text-sky-700 dark:text-sky-400 border border-sky-500/30",
  breakthrough:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30",
  adjacent:
    "bg-orange-500/15 text-orange-700 dark:text-orange-400 border border-orange-500/30",
  far: "bg-muted text-muted-foreground border border-border",
};

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
  outliers30d: number;
  medianViews30d: number | null;
  lastUploadAt: number | null;
  recentVideoViews: number[];
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

type Gap = {
  word: string;
  competitorUses: number;
  competitorTotalViews: number;
  avgViews: number;
  exampleCompetitorTitle: string;
};

type Tab = "overview" | "gaps" | "alerts";

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
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [unread, setUnread] = useState(0);
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
  const [syncingIds, setSyncingIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // One-shot fetch of /api/channels to populate the active channel +
  // the chooser dropdowns used by the migration view + the per-card
  // "Move to another channel" link.
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
    // Migration view: ask for the unassigned slice. Default view: ask
    // for the active channel's slice. Both responses carry the global
    // unassignedCount so the banner stays accurate either way.
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
      };
      setCompetitors(d.competitors);
      setUnread(d.unreadAlerts);
      setUnassignedCount(d.unassignedCount);
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

  const refreshGaps = useCallback(async () => {
    if (!activeId) return setGaps([]);
    try {
      const r = await fetch(
        `/api/competitors/gaps?topN=30&userChannelId=${encodeURIComponent(activeId)}`,
        { cache: "no-store" }
      );
      const d = (await r.json()) as { gaps: Gap[] };
      setGaps(d.gaps);
    } catch {
      /* keep current */
    }
  }, [activeId]);

  useEffect(() => {
    refreshChannels();
  }, [refreshChannels]);

  useEffect(() => {
    refresh();
    refreshAlerts();
    refreshGaps();
  }, [refresh, refreshAlerts, refreshGaps]);

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === activeId) ?? null,
    [channels, activeId]
  );
  const otherChannels = useMemo(
    () => channels.filter((c) => c.id !== activeId),
    [channels, activeId]
  );

  const visibleCompetitors = useMemo(() => {
    // Tier filter only applies on the normal view — in migration view
    // every unassigned row shows up regardless of tier so the user can
    // bulk-assign without losing rows behind a filter chip.
    if (migrationView) return competitors;
    return competitors.filter((c) => tierFilters.has(c.tier));
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
        syncError?: string;
      };
      if (!r.ok && !d.ok) {
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      setIdentifier("");
      if (d.syncError) {
        setError(`Added, but first sync failed: ${d.syncError}`);
      }
      await refresh();
      await refreshAlerts();
      await refreshGaps();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setAdding(false);
    }
  };

  const syncOne = async (id: number) => {
    setSyncingIds((prev) => new Set(prev).add(id));
    setError(null);
    try {
      const r = await fetch(`/api/competitors/${id}/sync`, { method: "POST" });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      await refresh();
      await refreshAlerts();
      await refreshGaps();
    } catch (e) {
      setError(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncingIds((prev) => {
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
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      await refresh();
      await refreshAlerts();
      await refreshGaps();
    } catch (e) {
      setError(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncingAll(false);
    }
  };

  const removeOne = async (id: number) => {
    if (!confirm("Remove this competitor and all its synced data?")) return;
    try {
      await fetch(`/api/competitors/${id}`, { method: "DELETE" });
      await refresh();
      await refreshAlerts();
      await refreshGaps();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
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

      {/* Active-channel chip */}
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

      {/* Migration banner */}
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

      {/* Tabs — hidden in migration view, which is a focused single-task screen */}
      {!migrationView && (
        <div className="mb-4 flex gap-4 border-b border-border">
          <TabButton
            active={tab === "overview"}
            onClick={() => setTab("overview")}
          >
            Overview
          </TabButton>
          <TabButton active={tab === "gaps"} onClick={() => setTab("gaps")}>
            <TrendingUp className="h-3.5 w-3.5" />
            Gap Analysis
            {gaps.length > 0 && (
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

      {/* ===== MIGRATION VIEW ===== */}
      {migrationView && (
        <MigrationView
          competitors={competitors}
          channels={channels}
          onAssign={patchCompetitor}
          onBack={() => setMigrationView(false)}
        />
      )}

      {/* ===== OVERVIEW ===== */}
      {!migrationView && tab === "overview" && (
        <div className="space-y-4">
          {/* KPI strip — server-computed scoped to the active user channel.
              "Outliers this week" replaces the old "Videos tracked", which
              didn't surface anything actionable. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi
              icon={Users}
              label="Competitors"
              value={String(kpis.competitors)}
            />
            <Kpi
              icon={Eye}
              label="Combined subs"
              value={fmtCount(kpis.combinedSubs)}
            />
            <Kpi
              icon={TrendingUp}
              label="Outliers this week"
              value={String(kpis.outliersThisWeek)}
            />
            <Kpi
              icon={RefreshCw}
              label="Last sync"
              value={fmtRelative(kpis.lastSync)}
            />
          </div>

          {/* Tier filter pills */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Filter:</span>
            {TIERS.map((t) => {
              const on = tierFilters.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTierFilter(t)}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 font-medium transition-colors",
                    on ? TIER_PILL[t] : "border border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {TIER_LABEL[t]}
                </button>
              );
            })}
          </div>

          {/* Add competitor — requires a tier choice up front */}
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
                  <option key={t} value={t}>
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

          {/* Competitor cards */}
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
                  otherChannels={otherChannels}
                  syncing={syncingIds.has(c.id)}
                  onSync={() => syncOne(c.id)}
                  onRemove={() => removeOne(c.id)}
                  onTierChange={(t) => patchCompetitor(c.id, { tier: t })}
                  onMove={(targetUserChannelId) =>
                    patchCompetitor(c.id, { userChannelId: targetUserChannelId })
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===== GAP ANALYSIS ===== */}
      {!migrationView && tab === "gaps" && (
        <Card>
          <CardContent className="p-4">
            {gaps.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No gaps detected yet. Add at least one competitor and sync to
                surface keywords you&apos;re missing.
              </div>
            ) : (
              <>
                <p className="mb-3 text-xs text-muted-foreground">
                  Words that appear in your competitors&apos; TOP videos but{" "}
                  <strong>not in any of yours</strong>. Sorted by aggregate
                  views — the bigger the bar, the more proof the keyword pulls
                  in your niche.
                </p>
                <ul className="space-y-1">
                  {gaps.map((g) => (
                    <li
                      key={g.word}
                      className="flex flex-wrap items-center gap-3 rounded-md border border-border/70 p-3"
                    >
                      <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-sm font-medium text-primary">
                        {g.word}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        appears in{" "}
                        <strong className="text-foreground">
                          {g.competitorUses}
                        </strong>{" "}
                        competitor videos · avg{" "}
                        <strong className="text-foreground">
                          {fmtCount(g.avgViews)}
                        </strong>{" "}
                        views · total{" "}
                        <strong className="text-foreground">
                          {fmtCount(g.competitorTotalViews)}
                        </strong>
                      </span>
                      <span className="w-full truncate text-[11px] italic text-muted-foreground">
                        e.g. &ldquo;{g.exampleCompetitorTitle}&rdquo;
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ===== ALERTS ===== */}
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
          gap analysis on existing data).
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

function CompetitorCard({
  competitor,
  otherChannels,
  syncing,
  onSync,
  onRemove,
  onTierChange,
  onMove,
}: {
  competitor: Competitor;
  otherChannels: UserChannel[];
  syncing: boolean;
  onSync: () => void;
  onRemove: () => void;
  onTierChange: (t: Tier) => void;
  onMove: (targetUserChannelId: string) => void;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const initial = (competitor.title ?? competitor.handle ?? "?")
    .slice(0, 1)
    .toUpperCase();

  // The whole card is a click target → competitor detail page. Every
  // interactive control inside MUST stopPropagation, otherwise clicking
  // a dropdown / icon also triggers the navigation. Each control wraps
  // its own handler so we don't accidentally call the parent <Link>.
  const stop = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
  };

  return (
    <Link
      href={`/competitors/${competitor.id}`}
      className="block rounded-xl outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card>
        <CardContent className="p-4">
          {/* Top row: avatar + title + tier badge top-right */}
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
                {competitor.title ?? "(syncing…)"}
              </div>
              <div className="mt-0.5 break-all text-xs text-muted-foreground">
                {competitor.handle ?? competitor.channelId ?? "—"}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                  TIER_PILL[competitor.tier]
                )}
              >
                {TIER_LABEL[competitor.tier]}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={(e) => {
                    stop(e);
                    onSync();
                  }}
                  disabled={syncing}
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  title="Sync now"
                  aria-label="Sync"
                >
                  {syncing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    stop(e);
                    onRemove();
                  }}
                  className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="Remove"
                  aria-label="Remove"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>

          {/* 4-cell metric strip */}
          <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
            <CardMetric label="Subs" value={fmtCount(competitor.subscriberCount)} />
            <CardMetric
              label="Outliers 30d"
              value={String(competitor.outliers30d)}
              highlight={competitor.outliers30d > 0}
            />
            <CardMetric
              label="Median views"
              value={fmtCount(competitor.medianViews30d)}
            />
            <CardMetric
              label="Last upload"
              value={fmtRelative(competitor.lastUploadAt)}
            />
          </div>

          {/* Sparkline — last 10 videos' views. Skipped when there's nothing
              to plot (need at least 2 points to draw a line). */}
          {competitor.recentVideoViews.length > 1 && (
            <div className="mt-3 text-primary/70">
              <CardSparkline values={competitor.recentVideoViews} />
            </div>
          )}

          {/* Bottom row: tier dropdown + move-to-another-channel link. Both
              call stop() so clicking them doesn't trigger the card link. */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[11px]">
            <label
              className="inline-flex items-center gap-1.5 text-muted-foreground"
              onClick={stop}
            >
              <span>Tier:</span>
              <select
                value={competitor.tier}
                onChange={(e) => onTierChange(e.target.value as Tier)}
                onClick={stop}
                className="rounded-md border border-input bg-background px-1.5 py-0.5 text-[11px]"
              >
                {TIERS.map((t) => (
                  <option key={t} value={t}>
                    {TIER_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            {otherChannels.length > 0 && (
              <div className="relative" onClick={stop}>
                <button
                  type="button"
                  onClick={(e) => {
                    stop(e);
                    setMoveOpen((v) => !v);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  Move to another channel ↗
                </button>
                {moveOpen && (
                  <div className="absolute right-0 z-10 mt-1 min-w-[200px] rounded-md border border-border bg-popover p-1 shadow-md">
                    {otherChannels.map((ch) => (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={(e) => {
                          stop(e);
                          setMoveOpen(false);
                          onMove(ch.id);
                        }}
                        className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-accent"
                      >
                        {ch.title ?? ch.handle ?? ch.id}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
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

function CardSparkline({ values }: { values: number[] }) {
  // Server returns most-recent first. Visually: left=oldest → right=newest.
  const ordered = [...values].reverse();
  if (ordered.length < 2) return null;
  const max = Math.max(...ordered, 1);
  const w = 100;
  const h = 24;
  const dx = w / (ordered.length - 1);
  const points = ordered
    .map((v, i) => `${(i * dx).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(" L");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-6 w-full"
    >
      <path
        d={`M${points}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
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
                <option key={t} value={t}>
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
          <option key={t} value={t}>
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
