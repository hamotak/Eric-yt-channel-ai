"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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

type Competitor = {
  id: number;
  channelId: string | null;
  handle: string | null;
  title: string | null;
  avatarUrl: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  tier: Tier;
  outliers30d: number;
  medianViews30d: number | null;
  lastUploadAt: number | null;
  recentVideoViews: number[];
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
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium",
                    TIER_PILL[comp.tier]
                  )}
                >
                  {TIER_LABEL[comp.tier]}
                </span>
              </div>
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
