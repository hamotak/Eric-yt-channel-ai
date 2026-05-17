"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  Loader2,
  Trophy,
  BarChart3,
  ListOrdered,
  CheckCircle2,
  AlertCircle,
  RotateCw,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HookAnalysisBanner } from "@/components/hook-analysis-banner";
import { cn } from "@/lib/utils";

type HookAnalysisJob = {
  id: number;
  started_at: number;
  completed_at: number | null;
  channel_id: string | null;
  total: number;
  done: number;
  failed: number;
  current_video_id: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  last_error: string | null;
};

type Formula =
  | "direct_question"
  | "statistic"
  | "comment_reference"
  | "personal_story"
  | "mystery"
  | "character_place_date"
  | "provocation"
  | "other";

type Hook = {
  video_id: string;
  hook_text: string;
  formula_type: Formula;
  score_open_loop: number;
  score_value_promise: number;
  score_conflict: number;
  score_specific_language: number;
  score_identification: number;
  score_pacing: number;
  score_benefit: number;
  overall_score: number;
  fortalezas: string | null;
  mejoras: string | null;
  analyzed_at: number;
  analyzer_model: string | null;
  title: string;
  views: number;
  published_at: number | null;
  thumbnail_url: string | null;
};

type Dashboard = {
  overall: {
    analyzed: number;
    totalVideos: number;
    avgScore: number;
    topFormula: Formula | null;
  };
  formulas: Array<{
    formula: Formula;
    count: number;
    avgViews: number;
    avgScore: number;
  }>;
  pending: number;
};

type Tab = "dashboard" | "rankings" | "cards";

const FORMULA_LABEL: Record<Formula, string> = {
  direct_question: "Direct Question",
  statistic: "Statistic",
  comment_reference: "Comment Reference",
  personal_story: "Personal Story",
  mystery: "Mystery",
  character_place_date: "Character + Place + Date",
  provocation: "Provocation",
  other: "Other",
};

const FORMULA_COLOR: Record<Formula, string> = {
  direct_question: "bg-sky-500",
  statistic: "bg-emerald-500",
  comment_reference: "bg-blue-500",
  personal_story: "bg-orange-500",
  mystery: "bg-violet-500",
  character_place_date: "bg-amber-500",
  provocation: "bg-rose-500",
  other: "bg-zinc-500",
};

const SCORE_LABELS: Array<{ key: keyof Hook; label: string; cap: string }> = [
  { key: "score_open_loop", label: "Open loop", cap: "<10s" },
  { key: "score_value_promise", label: "Value promise", cap: "" },
  { key: "score_conflict", label: "Conflict", cap: "<30s" },
  { key: "score_specific_language", label: "Specific language", cap: "" },
  { key: "score_identification", label: "Identification", cap: "<15s" },
  { key: "score_pacing", label: "Pacing", cap: "" },
  { key: "score_benefit", label: "Benefit", cap: "<60s" },
];

function fmtCount(n: number | null | undefined): string {
  if (!n && n !== 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function HooksPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [orderBy, setOrderBy] = useState<"score" | "views" | "recent">("score");

  const refresh = useCallback(async () => {
    try {
      const [dRes, hRes] = await Promise.all([
        fetch("/api/hooks/dashboard", { cache: "no-store" }),
        fetch(`/api/hooks?orderBy=${orderBy}&limit=200`, { cache: "no-store" }),
      ]);
      const d = (await dRes.json()) as Dashboard;
      const h = (await hRes.json()) as { hooks: Hook[] };
      setDashboard(d);
      setHooks(h.hooks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [orderBy]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Kick off a background batch and let HookAnalysisBanner take over
  // the progress UI. We don't `await` the work itself — the endpoint
  // returns immediately after enqueueing — because for 40+ videos at
  // ~10s/Claude-call the request would take minutes and the UI would
  // just spin "Analyzing…" with no feedback (and no way to cancel).
  // The previous implementation did exactly that, which is why
  // pressing the button felt like it did nothing.
  const analyzeAllPending = async () => {
    setError(null);
    try {
      const r = await fetch("/api/hooks/analyze-pending", { method: "POST" });
      const d = (await r.json()) as {
        ok?: boolean;
        jobId?: number;
        total?: number;
        error?: string;
      };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      // Banner will pick the new job up on its next poll. Refresh
      // dashboard so the "Pending" count is fresh too.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  };

  // Banner pushes the running-job state up so the header button can
  // disable itself + show "Analysing…" while a batch is in flight,
  // even if the user navigates away and back (we re-read the job from
  // the server on mount).
  const handleJobChange = useCallback(
    (job: HookAnalysisJob | null) => {
      const running = job?.status === "running";
      setAnalyzing(running);
      // If a new job is running, clear any stale "batch already running"
      // toast from a previous double-click — otherwise both the toast
      // and the progress banner stack on top of each other and look
      // like contradictory state.
      if (running) setError(null);
      // When a job finishes, refresh dashboard counts so the user sees
      // "0 pending" / updated avg score without a manual reload.
      if (job && job.status !== "running") {
        refresh();
      }
    },
    [refresh]
  );

  const reanalyzeOne = async (videoId: string) => {
    setAnalyzingIds((prev) => new Set(prev).add(videoId));
    setError(null);
    try {
      const r = await fetch(`/api/hooks/analyze/${videoId}`, { method: "POST" });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setAnalyzingIds((prev) => {
        const next = new Set(prev);
        next.delete(videoId);
        return next;
      });
    }
  };

  // For the Dashboard's per-formula bars we normalise against the
  // top formula's avg views (so the longest bar is always full-width)
  // — keeps the chart legible even on channels where one formula
  // dominates by 10×.
  const maxAvgViews = useMemo(
    () => Math.max(1, ...(dashboard?.formulas.map((f) => f.avgViews) ?? [1])),
    [dashboard]
  );

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

  if (!dashboard) {
    return (
      <div className="mx-auto max-w-6xl">
        <Card>
          <CardContent className="py-10 text-center text-sm text-destructive">
            Failed to load Hook Lab.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Sparkles className="h-6 w-6" />
            Hook Lab
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            AI breakdown of every opening hook — formula, quality scores,
            strengths, suggested fixes.
          </p>
        </div>
        <Button
          onClick={analyzeAllPending}
          disabled={analyzing || dashboard.pending === 0}
          size="sm"
          className="gap-1.5"
        >
          {analyzing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {analyzing
            ? "Analyzing…"
            : dashboard.pending === 0
              ? "All analyzed"
              : `Analyze ${dashboard.pending} pending`}
        </Button>
      </header>

      {/* Background-job banner: shows progress + cancel while a batch
          is in flight, completion summary afterwards. Pushes the
          running-job state up so the header button stays disabled. */}
      <HookAnalysisBanner onJobChange={handleJobChange} />

      {/* Tabs */}
      <div className="mb-4 flex gap-4 border-b border-border">
        <TabButton active={tab === "dashboard"} onClick={() => setTab("dashboard")}>
          <BarChart3 className="h-3.5 w-3.5" />
          Dashboard
        </TabButton>
        <TabButton active={tab === "rankings"} onClick={() => setTab("rankings")}>
          <ListOrdered className="h-3.5 w-3.5" />
          Rankings
        </TabButton>
        <TabButton active={tab === "cards"} onClick={() => setTab("cards")}>
          <Trophy className="h-3.5 w-3.5" />
          Video Cards
        </TabButton>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      {/* ===== DASHBOARD ===== */}
      {tab === "dashboard" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi
              label="Analyzed"
              value={`${dashboard.overall.analyzed} / ${dashboard.overall.totalVideos}`}
              hint="videos scored"
            />
            <Kpi
              label="Avg Score"
              value={`${dashboard.overall.avgScore.toFixed(1)} / 10`}
              hint="across all hooks"
            />
            <Kpi
              label="Winning formula"
              value={
                dashboard.overall.topFormula
                  ? FORMULA_LABEL[dashboard.overall.topFormula]
                  : "—"
              }
              hint="by avg views"
            />
            <Kpi
              label="Pending"
              value={String(dashboard.pending)}
              hint="awaiting analysis"
            />
          </div>

          {/* Formula breakdown */}
          <Card>
            <CardContent className="p-4">
              <h2 className="mb-3 text-sm font-semibold">
                Formulas — avg views per type
              </h2>
              {dashboard.formulas.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No hooks analyzed yet. Click &ldquo;Analyze pending&rdquo;
                  above to start.
                </div>
              ) : (
                <ul className="space-y-2">
                  {dashboard.formulas.map((f) => (
                    <li key={f.formula} className="flex items-center gap-3">
                      <span className="w-44 shrink-0 text-xs">
                        {FORMULA_LABEL[f.formula]}
                      </span>
                      <div className="relative h-6 flex-1 rounded bg-muted/40">
                        <div
                          className={cn(
                            "h-full rounded transition-all",
                            FORMULA_COLOR[f.formula]
                          )}
                          style={{
                            width: `${(f.avgViews / maxAvgViews) * 100}%`,
                          }}
                        />
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-end px-2 text-[10px] font-medium text-foreground">
                          {fmtCount(f.avgViews)} avg · {f.count} vids ·{" "}
                          {f.avgScore.toFixed(1)}/10
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Score averages across dimensions */}
          {dashboard.overall.analyzed > 0 && (
            <Card>
              <CardContent className="p-4">
                <h2 className="mb-3 text-sm font-semibold">
                  Quality dimensions — averages across all analyzed hooks
                </h2>
                <AverageScoresBars hooks={hooks} />
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ===== RANKINGS ===== */}
      {tab === "rankings" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Sort by:</span>
            <SortPill
              active={orderBy === "score"}
              onClick={() => setOrderBy("score")}
            >
              Score
            </SortPill>
            <SortPill
              active={orderBy === "views"}
              onClick={() => setOrderBy("views")}
            >
              Views
            </SortPill>
            <SortPill
              active={orderBy === "recent"}
              onClick={() => setOrderBy("recent")}
            >
              Recent
            </SortPill>
          </div>
          {hooks.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No hooks analyzed yet.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">Title</th>
                      <th className="px-3 py-2 text-left">Formula</th>
                      <th className="px-3 py-2 text-right">Views</th>
                      <th className="px-3 py-2 text-right">Score</th>
                      <th className="px-3 py-2 text-right">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hooks.map((h, i) => (
                      <tr
                        key={h.video_id}
                        className="border-b border-border/60 hover:bg-accent/30"
                      >
                        <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                        <td className="px-3 py-2">
                          <a
                            href={`/videos/${h.video_id}`}
                            className="hover:text-primary hover:underline"
                          >
                            {h.title}
                          </a>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium text-white",
                              FORMULA_COLOR[h.formula_type]
                            )}
                          >
                            {FORMULA_LABEL[h.formula_type]}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtCount(h.views)}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right font-semibold tabular-nums",
                            h.overall_score >= 8
                              ? "text-emerald-600 dark:text-emerald-400"
                              : h.overall_score >= 6
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-rose-600 dark:text-rose-400"
                          )}
                        >
                          {h.overall_score.toFixed(1)}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                          {fmtDate(h.published_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ===== VIDEO CARDS ===== */}
      {tab === "cards" && (
        <div className="space-y-3">
          {hooks.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No hooks analyzed yet.
              </CardContent>
            </Card>
          ) : (
            hooks.map((h) => (
              <HookCard
                key={h.video_id}
                hook={h}
                reanalyzing={analyzingIds.has(h.video_id)}
                onReanalyze={() => reanalyzeOne(h.video_id)}
              />
            ))
          )}
        </div>
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

function SortPill({
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
        "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="mt-1 truncate text-base font-semibold">{value}</div>
        <div className="text-[10px] text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}

function AverageScoresBars({ hooks }: { hooks: Hook[] }) {
  const averages = useMemo(() => {
    if (!hooks.length) return null;
    const sum: Record<string, number> = {};
    for (const s of SCORE_LABELS) sum[s.key as string] = 0;
    for (const h of hooks) {
      for (const s of SCORE_LABELS) {
        sum[s.key as string] += h[s.key] as number;
      }
    }
    const out: Record<string, number> = {};
    for (const s of SCORE_LABELS) {
      out[s.key as string] = Math.round((sum[s.key as string] / hooks.length) * 10) / 10;
    }
    return out;
  }, [hooks]);

  if (!averages) return null;

  return (
    <ul className="space-y-1.5">
      {SCORE_LABELS.map((s) => {
        const v = averages[s.key as string];
        const color =
          v >= 8 ? "bg-emerald-500" : v >= 6 ? "bg-amber-500" : "bg-rose-500";
        return (
          <li key={s.key as string} className="flex items-center gap-3 text-xs">
            <span className="w-44 shrink-0">
              {s.label}
              {s.cap && (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  ({s.cap})
                </span>
              )}
            </span>
            <div className="relative h-5 flex-1 rounded bg-muted/40">
              <div
                className={cn("h-full rounded", color)}
                style={{ width: `${(v / 10) * 100}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-mono font-semibold">
              {v.toFixed(1)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function HookCard({
  hook,
  reanalyzing,
  onReanalyze,
}: {
  hook: Hook;
  reanalyzing: boolean;
  onReanalyze: () => void;
}) {
  const fortalezas = useMemo<string[]>(() => {
    try {
      return JSON.parse(hook.fortalezas ?? "[]");
    } catch {
      return [];
    }
  }, [hook.fortalezas]);
  const mejoras = useMemo<string[]>(() => {
    try {
      return JSON.parse(hook.mejoras ?? "[]");
    } catch {
      return [];
    }
  }, [hook.mejoras]);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <a
              href={`/videos/${hook.video_id}`}
              className="block truncate text-base font-semibold hover:text-primary hover:underline"
            >
              {hook.title}
            </a>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 font-medium text-white",
                  FORMULA_COLOR[hook.formula_type]
                )}
              >
                {FORMULA_LABEL[hook.formula_type]}
              </span>
              <span>{fmtCount(hook.views)} views</span>
              <span>{fmtDate(hook.published_at)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-right tabular-nums",
                hook.overall_score >= 8
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : hook.overall_score >= 6
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    : "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400"
              )}
            >
              <div className="text-[10px] uppercase tracking-wide opacity-80">
                Overall
              </div>
              <div className="text-lg font-bold">
                {hook.overall_score.toFixed(1)}
              </div>
            </div>
            <button
              type="button"
              onClick={onReanalyze}
              disabled={reanalyzing}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              title="Re-analyze"
            >
              {reanalyzing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Quality scores */}
          <div>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Quality scores
            </h3>
            <ul className="space-y-1">
              {SCORE_LABELS.map((s) => {
                const v = hook[s.key] as number;
                const color =
                  v >= 8 ? "bg-emerald-500" : v >= 6 ? "bg-amber-500" : "bg-rose-500";
                return (
                  <li key={s.key as string} className="flex items-center gap-2 text-xs">
                    <span className="w-32 shrink-0 truncate">
                      {s.label}
                      {s.cap && (
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          ({s.cap})
                        </span>
                      )}
                    </span>
                    <div className="relative h-4 flex-1 rounded bg-muted/40">
                      <div
                        className={cn("h-full rounded", color)}
                        style={{ width: `${(v / 10) * 100}%` }}
                      />
                    </div>
                    <span className="w-6 shrink-0 text-right font-mono font-semibold">
                      {v}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Fortalezas + Mejoras */}
          <div className="space-y-3">
            {fortalezas.length > 0 && (
              <div>
                <h3 className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  Fortalezas
                </h3>
                <ul className="space-y-1 text-xs">
                  {fortalezas.map((s, i) => (
                    <li key={i} className="text-muted-foreground">
                      • {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {mejoras.length > 0 && (
              <div>
                <h3 className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                  <AlertCircle className="h-3 w-3" />
                  Mejoras sugeridas
                </h3>
                <ul className="space-y-1 text-xs">
                  {mejoras.map((s, i) => (
                    <li key={i} className="text-muted-foreground">
                      • {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <details className="mt-3">
          <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
            Show full hook text
          </summary>
          <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border bg-muted/20 p-2 text-[11px] text-foreground">
            {hook.hook_text}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
