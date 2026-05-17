"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, FileText, Loader2, Search, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type Preview = {
  missing: number;
  totalSeconds: number;
  estimatedCostCents: number;
  videos: { id: string; title: string; durationSeconds: number }[];
  activeJob: TranscriptionJob | null;
};

type TranscriptionJob = {
  id: number;
  started_at: number;
  completed_at: number | null;
  total: number;
  done: number;
  failed: number;
  cost_cents: number;
  current_video_id: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  last_error: string | null;
};

type UsageLite = {
  limitCents: number;
  totalCostCents: number;
  remainingCents: number;
};

type Candidate = {
  id: string;
  title: string;
  views: number;
  durationSeconds: number;
  publishedAt: number | null;
  hasTranscript: boolean;
  estimatedCostCents: number;
};

type SortKey = "recent" | "views" | "oldest";

type PickerMode = "all-missing" | "top-n" | "specific";

type StartArgs =
  | { mode: "all-missing" }
  | { mode: "top-n"; topN: number; orderBy: SortKey; onlyMissing: boolean }
  | { mode: "specific"; videoIds: string[]; onlyMissing: boolean };

/**
 * The "Transcribe missing" entrypoint on /videos. Four runtime states:
 *   1. There's an active batch job running → progress bar, polls /jobs/latest.
 *   2. Batch just finished (completed/failed) → result summary until
 *      the user dismisses it.
 *   3. There are videos without transcripts → CTA + picker modal.
 *   4. No missing videos + no recent job → render nothing.
 *
 * Picker modal (Phase 1 rework): three modes for what gets transcribed
 *   - "all-missing": legacy default — every missing-transcript video
 *   - "top-n":       top N by views / recency / oldest, with a toggle
 *                    for whether to skip already-transcribed
 *   - "specific":    hand-picked checkbox list with search
 */
export function TranscribeAllBanner() {
  const { t } = useI18n();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [usage, setUsage] = useState<UsageLite | null>(null);
  const [job, setJob] = useState<TranscriptionJob | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deepgramReady, setDeepgramReady] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const loadPreview = useCallback(async () => {
    try {
      const [p, u, i] = await Promise.all([
        fetch("/api/deepgram/transcribe-batch").then((r) => r.json()),
        fetch("/api/deepgram/usage").then((r) => r.json()).catch(() => null),
        fetch("/api/integrations").then((r) => r.json()),
      ]);
      setPreview(p);
      setUsage(u);
      setDeepgramReady(!!i?.integrations?.deepgram?.hasKey);
      if (p.activeJob) setJob(p.activeJob);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  // Poll for job progress while one is running.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/deepgram/jobs/latest");
        if (!res.ok) return;
        const data = (await res.json()) as { job: TranscriptionJob | null };
        if (cancelled) return;
        if (data.job) {
          setJob(data.job);
          if (data.job.status !== "running") {
            loadPreview();
          }
        }
      } catch {
        /* transient */
      }
    };
    const id = window.setInterval(tick, 2000);
    tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [job, loadPreview]);

  const startBatch = useCallback(
    async (args: StartArgs) => {
      setStarting(true);
      try {
        const body =
          args.mode === "all-missing"
            ? {}
            : args.mode === "top-n"
              ? {
                  topN: args.topN,
                  orderBy: args.orderBy,
                  onlyMissing: args.onlyMissing,
                }
              : {
                  videoIds: args.videoIds,
                  onlyMissing: args.onlyMissing,
                };
        const res = await fetch("/api/deepgram/transcribe-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.jobId) {
          setJob({
            id: data.jobId,
            started_at: Math.floor(Date.now() / 1000),
            completed_at: null,
            total: data.total ?? 0,
            done: 0,
            failed: 0,
            cost_cents: 0,
            current_video_id: null,
            status: "running",
            last_error: null,
          });
          setPickerOpen(false);
        } else if (data.error) {
          alert(data.error);
        }
      } finally {
        setStarting(false);
      }
    },
    []
  );

  const finishedJob = job && job.status !== "running" && !dismissed ? job : null;

  // Deepgram not configured — soft hint, but don't waste sidebar space if
  // there's nothing missing anyway.
  if (!deepgramReady) {
    if (!preview || preview.missing === 0) return null;
    return (
      <div className="mb-4 flex items-start gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-3 text-sm">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <div className="font-medium">{t.deepgram.missingHint.replace("{n}", String(preview.missing))}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{t.deepgram.notConfiguredHint}</div>
        </div>
        <a href="/integrations" className="shrink-0 text-xs font-medium text-primary hover:underline">
          {t.deepgram.goToIntegrations} →
        </a>
      </div>
    );
  }

  // Finished job summary
  if (finishedJob) {
    const ok = finishedJob.done;
    const bad = finishedJob.failed;
    const spent = (finishedJob.cost_cents / 100).toFixed(2);
    return (
      <div className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-green-500/5 p-3 text-sm">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
        <div className="flex-1">
          <div className="font-medium">
            {t.deepgram.doneTitle}: {ok} / {finishedJob.total}
            {bad > 0 && (
              <span className="ml-2 text-destructive">
                ({bad} {t.deepgram.failed})
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t.deepgram.doneSpent.replace("{amount}", `$${spent}`)}
          </div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // Running job — progress bar
  if (job && job.status === "running") {
    const pct = job.total > 0 ? (job.done / job.total) * 100 : 0;
    const spent = (job.cost_cents / 100).toFixed(2);
    const cancelJob = async () => {
      if (!confirm("Stop the running transcribe batch? The video currently in flight finishes; everything queued behind it gets skipped.")) return;
      try {
        const r = await fetch("/api/deepgram/jobs/cancel", { method: "POST" });
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { error?: string };
          alert(d.error ?? "Failed to cancel.");
          return;
        }
        loadPreview();
      } catch {
        alert("Failed to cancel — couldn't reach the server.");
      }
    };
    return (
      <div className="mb-4 space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="inline-flex items-center gap-2 font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {t.deepgram.runningTitle}: {job.done} / {job.total}
            {job.failed > 0 && (
              <span className="text-destructive">({job.failed} {t.deepgram.failed})</span>
            )}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {t.deepgram.spentSoFar.replace("{amount}", `$${spent}`)}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={cancelJob}
              className="h-7 gap-1 px-2 text-xs"
              title="Cancel this running batch (use if it's stuck from a previous server run)"
            >
              <X className="h-3 w-3" />
              Cancel
            </Button>
          </div>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${pct.toFixed(1)}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t.deepgram.runningHint}
        </p>
      </div>
    );
  }

  // Nothing to do (no missing transcripts). Still expose the picker
  // entry though — the user may want to re-transcribe a specific video.
  if (!preview || preview.missing === 0) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 p-3 text-sm">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 text-xs text-muted-foreground">
          Every video on this channel already has a transcript. Open the
          picker if you want to re-transcribe specific ones.
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPickerOpen(true)}
          className="shrink-0 gap-1.5"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Pick videos
        </Button>
        {pickerOpen && (
          <PickerModal
            onClose={() => setPickerOpen(false)}
            onConfirm={startBatch}
            starting={starting}
            usage={usage}
            defaultMissing={preview?.missing ?? 0}
          />
        )}
      </div>
    );
  }

  // CTA — show missing count + two buttons (quick "all missing" + picker)
  const costUsd = (preview.estimatedCostCents / 100).toFixed(2);
  const hours = Math.floor(preview.totalSeconds / 3600);
  const minutes = Math.floor((preview.totalSeconds % 3600) / 60);
  const durationLabel = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3">
        <FileText className="h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium">
            {t.deepgram.missingTitle.replace("{n}", String(preview.missing))}
          </div>
          <div className="text-xs text-muted-foreground">
            {t.deepgram.ctaHint
              .replace("{duration}", durationLabel)
              .replace("{amount}", `$${costUsd}`)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPickerOpen(true)}
            className="gap-1.5"
          >
            Pick videos
          </Button>
          <Button size="sm" onClick={() => setPickerOpen(true)} className="gap-2">
            <Sparkles className="h-4 w-4" />
            {t.deepgram.ctaButton}
          </Button>
        </div>
      </div>

      {pickerOpen && (
        <PickerModal
          onClose={() => setPickerOpen(false)}
          onConfirm={startBatch}
          starting={starting}
          usage={usage}
          defaultMissing={preview.missing}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------------------
 * PickerModal — three modes for choosing what to transcribe.
 * --------------------------------------------------------------------------- */

function PickerModal({
  onClose,
  onConfirm,
  starting,
  usage,
  defaultMissing,
}: {
  onClose: () => void;
  onConfirm: (args: StartArgs) => void;
  starting: boolean;
  usage: UsageLite | null;
  defaultMissing: number;
}) {
  const [mode, setMode] = useState<PickerMode>("all-missing");

  // -- top-n state --
  const [topN, setTopN] = useState<number>(10);
  const [orderBy, setOrderBy] = useState<SortKey>("recent");
  const [onlyMissingTop, setOnlyMissingTop] = useState(true);

  // -- specific state --
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [includeAlreadyTranscribed, setIncludeAlreadyTranscribed] = useState(false);

  // -- shared preview (server-computed, accurate cost incl. all-missing default) --
  const [previewCost, setPreviewCost] = useState<{
    n: number;
    seconds: number;
    cents: number;
  } | null>(null);

  // Recompute preview from the server whenever the mode or its params change.
  // The all-missing default doesn't depend on inputs, so we can pre-cache it
  // with what was passed in (defaultMissing) — the user sees the same N as
  // the banner showed.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const url = new URL("/api/deepgram/transcribe-batch", window.location.origin);
      if (mode === "top-n") {
        url.searchParams.set("topN", String(topN));
        url.searchParams.set("orderBy", orderBy);
        if (!onlyMissingTop) url.searchParams.set("onlyMissing", "0");
      } else if (mode === "specific") {
        if (selected.size === 0) {
          if (!cancelled) setPreviewCost({ n: 0, seconds: 0, cents: 0 });
          return;
        }
        url.searchParams.set("videoIds", Array.from(selected).join(","));
        if (includeAlreadyTranscribed) url.searchParams.set("onlyMissing", "0");
      }
      try {
        const res = await fetch(url.toString());
        if (!res.ok) return;
        const data = (await res.json()) as {
          missing: number;
          totalSeconds: number;
          estimatedCostCents: number;
        };
        if (cancelled) return;
        setPreviewCost({
          n: data.missing,
          seconds: data.totalSeconds,
          cents: data.estimatedCostCents,
        });
      } catch {
        /* ignore */
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [mode, topN, orderBy, onlyMissingTop, selected, includeAlreadyTranscribed]);

  // Lazy-load candidates the first time the user opens the "specific" tab.
  useEffect(() => {
    if (mode !== "specific" || candidates !== null || loadingCandidates) return;
    setLoadingCandidates(true);
    fetch(
      `/api/deepgram/transcribe-batch?candidates=1&orderBy=recent&limit=500${includeAlreadyTranscribed ? "&onlyMissing=0" : ""}`
    )
      .then((r) => r.json() as Promise<{ candidates: Candidate[] }>)
      .then((d) => setCandidates(d.candidates ?? []))
      .catch(() => setCandidates([]))
      .finally(() => setLoadingCandidates(false));
  }, [mode, candidates, loadingCandidates, includeAlreadyTranscribed]);

  // Re-fetch when the user flips "include already transcribed" — the
  // candidate set changes shape (more entries appear with a checkmark).
  useEffect(() => {
    if (mode !== "specific") return;
    setCandidates(null); // forces the loader above to refetch
    setSelected(new Set());
  }, [includeAlreadyTranscribed, mode]);

  const filteredCandidates = useMemo(() => {
    if (!candidates) return [];
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => c.title.toLowerCase().includes(q));
  }, [candidates, search]);

  const canConfirm =
    !starting &&
    ((mode === "all-missing" && defaultMissing > 0) ||
      (mode === "top-n" && topN > 0 && (previewCost?.n ?? 0) > 0) ||
      (mode === "specific" && selected.size > 0));

  const handleConfirm = () => {
    if (mode === "all-missing") {
      onConfirm({ mode: "all-missing" });
    } else if (mode === "top-n") {
      onConfirm({ mode: "top-n", topN, orderBy, onlyMissing: onlyMissingTop });
    } else {
      onConfirm({
        mode: "specific",
        videoIds: Array.from(selected),
        onlyMissing: !includeAlreadyTranscribed,
      });
    }
  };

  // Display values for the preview line at the bottom.
  const displayN =
    mode === "all-missing"
      ? defaultMissing
      : previewCost?.n ?? 0;
  const displaySeconds =
    mode === "all-missing"
      ? null // we'd need a separate fetch — leave blank for legacy default
      : previewCost?.seconds ?? 0;
  const displayCents =
    mode === "all-missing"
      ? null
      : previewCost?.cents ?? 0;

  const formatDuration = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const willOverrun =
    usage && displayCents !== null
      ? displayCents > usage.remainingCents
      : false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl space-y-4 rounded-lg border border-border bg-background p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 className="text-lg font-semibold">Choose what to transcribe</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a strategy below. Cost is estimated at $0.0043 per audio minute against your Deepgram credit.
          </p>
        </header>

        {/* Mode tabs */}
        <div className="flex gap-1 rounded-md border border-border bg-muted/30 p-1">
          <ModeTab
            label={`All missing${defaultMissing > 0 ? ` (${defaultMissing})` : ""}`}
            active={mode === "all-missing"}
            onClick={() => setMode("all-missing")}
          />
          <ModeTab
            label="Top N"
            active={mode === "top-n"}
            onClick={() => setMode("top-n")}
          />
          <ModeTab
            label="Pick specific"
            active={mode === "specific"}
            onClick={() => setMode("specific")}
          />
        </div>

        {/* Mode body */}
        <div className="min-h-[160px]">
          {mode === "all-missing" && (
            <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
              <div className="font-medium">
                {defaultMissing > 0
                  ? `Transcribe all ${defaultMissing} videos missing a transcript.`
                  : "Nothing is missing a transcript right now."}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Uses the same heuristic as the dashboard: any video with no transcript at all, plus any video whose transcript looks suspiciously short for its duration (likely a previous broken transcribe).
              </p>
            </div>
          )}

          {mode === "top-n" && (
            <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3 text-sm">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">How many</label>
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={topN}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setTopN(Number.isFinite(n) && n > 0 ? Math.floor(n) : 1);
                    }}
                    className="w-24"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Order by</label>
                  <select
                    value={orderBy}
                    onChange={(e) => setOrderBy(e.target.value as SortKey)}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="recent">Newest first</option>
                    <option value="views">Most-watched first</option>
                    <option value="oldest">Oldest first</option>
                  </select>
                </div>
                <div className="flex flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    id="topn-only-missing"
                    checked={onlyMissingTop}
                    onChange={(e) => setOnlyMissingTop(e.target.checked)}
                    className="h-4 w-4 cursor-pointer rounded border-input"
                  />
                  <label
                    htmlFor="topn-only-missing"
                    className="cursor-pointer text-xs"
                  >
                    Skip videos that already have a transcript
                  </label>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {orderBy === "views" && "Picks the highest-viewed videos first — useful when you want transcripts where the audience actually shows up."}
                {orderBy === "recent" && "Picks the newest videos first — useful for keeping up with recent uploads."}
                {orderBy === "oldest" && "Picks the oldest videos first — useful for back-filling a whole catalogue from scratch."}
              </p>
            </div>
          )}

          {mode === "specific" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Filter titles…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-8"
                  />
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    id="specific-include-done"
                    checked={includeAlreadyTranscribed}
                    onChange={(e) =>
                      setIncludeAlreadyTranscribed(e.target.checked)
                    }
                    className="h-4 w-4 cursor-pointer rounded border-input"
                  />
                  <label
                    htmlFor="specific-include-done"
                    className="cursor-pointer whitespace-nowrap"
                  >
                    Show already-transcribed
                  </label>
                </div>
              </div>

              {loadingCandidates ? (
                <div className="flex items-center justify-center rounded-md border border-border bg-muted/20 p-8 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading videos…
                </div>
              ) : filteredCandidates.length === 0 ? (
                <div className="rounded-md border border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
                  {search ? "No videos match that filter." : "No videos found on this channel."}
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{filteredCandidates.length} videos · {selected.size} selected</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          setSelected(
                            new Set([
                              ...selected,
                              ...filteredCandidates.map((c) => c.id),
                            ])
                          )
                        }
                        className="text-primary hover:underline"
                      >
                        Select all visible
                      </button>
                      <span>·</span>
                      <button
                        onClick={() => setSelected(new Set())}
                        className="text-primary hover:underline"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="max-h-[320px] overflow-y-auto rounded-md border border-border">
                    {filteredCandidates.map((c) => {
                      const checked = selected.has(c.id);
                      return (
                        <label
                          key={c.id}
                          className={cn(
                            "flex cursor-pointer items-center gap-3 border-b border-border/50 px-3 py-2 text-sm hover:bg-accent/50",
                            checked && "bg-primary/5"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(c.id);
                              else next.delete(c.id);
                              setSelected(next);
                            }}
                            className="h-4 w-4 shrink-0 cursor-pointer rounded border-input"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <div className="truncate font-medium">{c.title}</div>
                              {c.hasTranscript && (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] text-green-700 dark:text-green-400">
                                  <Check className="h-2.5 w-2.5" />
                                  done
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {c.views.toLocaleString()} views · ~$
                              {(c.estimatedCostCents / 100).toFixed(2)} ·{" "}
                              {formatDuration(c.durationSeconds)}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Preview line + confirm */}
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground">Videos to transcribe</span>
            <span className="font-semibold tabular-nums">{displayN}</span>
          </div>
          {displaySeconds !== null && (
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Total duration</span>
              <span className="tabular-nums">{formatDuration(displaySeconds)}</span>
            </div>
          )}
          {displayCents !== null && (
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Estimated cost</span>
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  willOverrun && "text-destructive"
                )}
              >
                ~${(displayCents / 100).toFixed(2)}
              </span>
            </div>
          )}
          {usage && (
            <div className="flex items-baseline justify-between text-xs text-muted-foreground">
              <span>Deepgram credit remaining</span>
              <span className="tabular-nums">
                ${(usage.remainingCents / 100).toFixed(2)}
              </span>
            </div>
          )}
        </div>

        {willOverrun && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            This batch will exceed your remaining Deepgram credit. Add credit at console.deepgram.com or reduce the selection first.
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="gap-2"
          >
            {starting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Start transcribing
          </Button>
        </div>
      </div>
    </div>
  );
}

function ModeTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}
