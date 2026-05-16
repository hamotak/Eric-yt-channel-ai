"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const TIERS = ["authority", "breakthrough", "adjacent", "far"] as const;
type Tier = (typeof TIERS)[number];

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
  outliers30d: number;
  medianViews30d: number | null;
  lastUploadAt: number | null;
  recentVideoViews: number[];
};

type UserChannel = {
  id: string;
  title: string | null;
  handle: string | null;
};

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
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [patching, setPatching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/competitors/${id}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { competitor?: Competitor; error?: string }) => {
        if (cancelled) return;
        if (d.error || !d.competitor) {
          setError(d.error ?? "competitor not found");
          return;
        }
        setComp(d.competitor);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Channel list for the "Move to another channel" chooser. Same source
  // as the list-page card so the dropdown shows every channel the user
  // owns minus the one this competitor is already assigned to.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/channels", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { channels?: UserChannel[] }) => {
        if (cancelled) return;
        setChannels(d.channels ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Both controls hit the existing PATCH /api/competitors/[id]. On 200,
  // update local state from the returned full record so the page
  // reflects the change without a hard reload.
  const patchCompetitor = async (patch: {
    tier?: Tier;
    userChannelId?: string | null;
  }) => {
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
      setComp(d.competitor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "update failed");
    } finally {
      setPatching(false);
    }
  };

  if (error) {
    return (
      <div className="mx-auto max-w-4xl">
        <Link
          href="/competitors"
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Competitors
        </Link>
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

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/competitors"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Competitors
      </Link>

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
                    {comp.title ?? "(syncing…)"}
                  </h1>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    {comp.handle ?? comp.channelId ?? "—"}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs font-medium",
                      TIER_PILL[comp.tier]
                    )}
                  >
                    {TIER_LABEL[comp.tier]}
                  </span>
                  {/* Inline tier dropdown — mirrors the list-page card so
                      the user can re-tag without going back. */}
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>Tier:</span>
                    <select
                      value={comp.tier}
                      onChange={(e) =>
                        patchCompetitor({ tier: e.target.value as Tier })
                      }
                      disabled={patching}
                      className="rounded-md border border-input bg-background px-1.5 py-0.5 text-[11px]"
                    >
                      {TIERS.map((t) => (
                        <option key={t} value={t}>
                          {TIER_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {/* Move-to-another-channel chooser. Only show if the
                      user owns more than just this competitor's current
                      channel — otherwise the chooser would be empty. */}
                  {channels.filter((c) => c.id !== comp.userChannelId).length >
                    0 && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setMoveOpen((v) => !v)}
                        disabled={patching}
                        className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
                      >
                        Move to another channel ↗
                      </button>
                      {moveOpen && (
                        <div className="absolute right-0 z-10 mt-1 min-w-[200px] rounded-md border border-border bg-popover p-1 shadow-md">
                          {channels
                            .filter((c) => c.id !== comp.userChannelId)
                            .map((ch) => (
                              <button
                                key={ch.id}
                                type="button"
                                onClick={() => {
                                  setMoveOpen(false);
                                  patchCompetitor({ userChannelId: ch.id });
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
              </div>
              {error && (
                <div className="mt-2 text-[11px] text-destructive">{error}</div>
              )}
            </div>
          </div>

          <div className="mt-5 grid grid-cols-4 gap-3 border-t border-border pt-4 text-center">
            <Metric label="Subs" value={fmtCount(comp.subscriberCount)} />
            <Metric label="Outliers 30d" value={String(comp.outliers30d)} />
            <Metric
              label="Median views"
              value={fmtCount(comp.medianViews30d)}
            />
            <Metric label="Last upload" value={fmtRelative(comp.lastUploadAt)} />
          </div>

          {comp.recentVideoViews.length > 1 && (
            <div className="mt-4 text-primary">
              <Sparkline values={comp.recentVideoViews} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <h2 className="mb-2 text-base font-semibold">Coming soon</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Per-competitor outlier breakdown lands in Step 3 (Outliers).
            You&apos;ll see each of this channel&apos;s videos ranked by how far
            they beat its own median.
          </p>
        </CardContent>
      </Card>
    </div>
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

function Sparkline({ values }: { values: number[] }) {
  // values come in most-recent-first; sparkline reads left=oldest → right=newest.
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
      <path d={`M${points}`} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
