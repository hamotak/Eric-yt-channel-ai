"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";

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

/**
 * Progress + completion banner for the Hook Lab batch analyser.
 *
 * Same shape and runtime states as SyncAllCommentsBanner:
 *   - Hidden when there's no recent job.
 *   - "Analysing X / Y videos" with a progress bar + Cancel while running.
 *   - Done/failed summary with a dismiss X afterwards.
 *
 * The "Analyze N pending" button on the Hook Lab page still owns the
 * "start a batch" action — this component is read-only on the start
 * side: it polls /api/hooks/jobs/latest and reacts to whatever job
 * shows up there. That keeps the page header logic unchanged and
 * means a job started from any tab (or restored after a tab reload)
 * still surfaces here.
 *
 * Callbacks:
 *   onJobChange  — fires whenever the polled job row changes. The
 *     parent uses this to refresh the dashboard counts when a batch
 *     finishes, and to keep its own "analyzing" button state in sync
 *     with what the server thinks is running.
 */
export function HookAnalysisBanner({
  onJobChange,
}: {
  onJobChange?: (job: HookAnalysisJob | null) => void;
}) {
  const [job, setJob] = useState<HookAnalysisJob | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const loadLatest = useCallback(async () => {
    try {
      const res = await fetch("/api/hooks/jobs/latest", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { job: HookAnalysisJob | null };
      setJob(data.job);
      onJobChange?.(data.job);
    } catch {
      /* transient */
    }
  }, [onJobChange]);

  useEffect(() => {
    loadLatest();
  }, [loadLatest]);

  // Reset the "user dismissed the completion summary" flag whenever a
  // new job kicks off — otherwise the next batch's completion summary
  // would silently be hidden because the user dismissed the previous
  // one.
  useEffect(() => {
    if (job?.status === "running") setDismissed(false);
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/hooks/jobs/latest", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { job: HookAnalysisJob | null };
        if (cancelled) return;
        setJob(data.job);
        onJobChange?.(data.job);
      } catch {
        /* transient */
      }
    };
    const id = window.setInterval(tick, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [job, onJobChange]);

  const cancelJob = useCallback(async () => {
    if (
      !confirm(
        "Stop the running hook analysis? Hooks already scored stay saved; the rest are skipped."
      )
    )
      return;
    try {
      const r = await fetch("/api/hooks/jobs/cancel", { method: "POST" });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        alert(d.error ?? "Failed to cancel.");
        return;
      }
      loadLatest();
    } catch {
      alert("Failed to cancel — couldn't reach the server.");
    }
  }, [loadLatest]);

  if (!job) return null;

  // Running
  if (job.status === "running") {
    const pct = job.total > 0 ? (job.done / job.total) * 100 : 0;
    return (
      <div className="mb-4 space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="inline-flex items-center gap-2 font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Analysing hooks: {job.done} / {job.total} videos
            {job.failed > 0 && (
              <span className="text-destructive">({job.failed} failed)</span>
            )}
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
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${pct.toFixed(1)}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Sending each hook to Claude — ~5-15 seconds per video. Runs in the background; you can leave this page.
        </p>
      </div>
    );
  }

  // Dismissed? Hide the completion summary.
  if (dismissed) return null;

  // Finished (completed / failed / cancelled)
  const tone =
    job.status === "completed"
      ? "border-border bg-green-500/5"
      : job.status === "cancelled"
        ? "border-border bg-muted/30"
        : "border-destructive/30 bg-destructive/5";
  const icon =
    job.status === "completed" ? (
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
    ) : (
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
    );
  const headline =
    job.status === "completed"
      ? `Hook analysis finished: ${job.done} / ${job.total} videos`
      : job.status === "cancelled"
        ? `Hook analysis cancelled: ${job.done} / ${job.total} scored before stop`
        : `Hook analysis failed: ${job.done} / ${job.total} scored`;

  return (
    <div className={`mb-4 flex items-start gap-3 rounded-lg border p-3 text-sm ${tone}`}>
      {icon}
      <div className="flex-1">
        <div className="font-medium">
          {headline}
          {job.failed > 0 && (
            <span className="ml-2 text-destructive">({job.failed} failed)</span>
          )}
        </div>
        {job.last_error && job.status !== "completed" && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            Last error: {job.last_error}
          </div>
        )}
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
