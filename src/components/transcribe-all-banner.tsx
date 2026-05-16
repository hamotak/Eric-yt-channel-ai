"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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

/**
 * The "Transcribe all missing" entrypoint on /videos. Three states:
 *   1. There's an active batch job running → show progress bar, poll.
 *   2. Batch just finished (completed/failed) → show brief result summary
 *      until the user dismisses it.
 *   3. There are videos without transcripts → show the call-to-action.
 *   4. No missing videos + no recent job → render nothing (banner is
 *      invisible when there's no work to do).
 */
export function TranscribeAllBanner() {
  const { t } = useI18n();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [usage, setUsage] = useState<UsageLite | null>(null);
  const [job, setJob] = useState<TranscriptionJob | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
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

  // Poll for job progress while one is running. We fetch the latest job,
  // not a specific id — a new job replaces the current view automatically.
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
          // When the job transitions from running → completed/failed, also
          // refresh the preview so "missing videos" count drops to 0.
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

  const startBatch = async () => {
    setStarting(true);
    try {
      const res = await fetch("/api/deepgram/transcribe-batch", { method: "POST" });
      const data = await res.json();
      if (data.jobId) {
        // Bootstrap a minimal job record so polling picks up.
        setJob({
          id: data.jobId,
          started_at: Math.floor(Date.now() / 1000),
          completed_at: null,
          total: data.total ?? preview?.missing ?? 0,
          done: 0,
          failed: 0,
          cost_cents: 0,
          current_video_id: null,
          status: "running",
          last_error: null,
        });
        setModalOpen(false);
      } else if (data.error) {
        alert(data.error);
      }
    } finally {
      setStarting(false);
    }
  };

  // A finished job lingers as a result summary until dismissed OR until
  // a new one starts. Hide it automatically once the user acknowledges.
  const finishedJob = job && job.status !== "running" && !dismissed ? job : null;

  // Deepgram not configured — don't show CTA, but show a soft hint if there
  // ARE missing transcripts (so user knows the feature exists).
  if (!deepgramReady) {
    if (!preview || preview.missing === 0) return null;
    return (
      <div className="mb-4 flex items-start gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-3 text-sm">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <div className="font-medium">{t.deepgram.missingHint.replace("{n}", String(preview.missing))}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{t.deepgram.notConfiguredHint}</div>
        </div>
        <a href="/settings/integrations" className="shrink-0 text-xs font-medium text-primary hover:underline">
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
    return (
      <div className="mb-4 space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-center justify-between text-sm">
          <span className="inline-flex items-center gap-2 font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {t.deepgram.runningTitle}: {job.done} / {job.total}
            {job.failed > 0 && (
              <span className="text-destructive">({job.failed} {t.deepgram.failed})</span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            {t.deepgram.spentSoFar.replace("{amount}", `$${spent}`)}
          </span>
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

  // Nothing to do
  if (!preview || preview.missing === 0) return null;

  // CTA
  const costUsd = (preview.estimatedCostCents / 100).toFixed(2);
  const hours = Math.floor(preview.totalSeconds / 3600);
  const minutes = Math.floor((preview.totalSeconds % 3600) / 60);
  const durationLabel = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  return (
    <>
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-card p-3">
        <FileText className="h-5 w-5 shrink-0 text-primary" />
        <div className="flex-1 text-sm">
          <div className="font-medium">
            {t.deepgram.missingTitle.replace("{n}", String(preview.missing))}
          </div>
          <div className="text-xs text-muted-foreground">
            {t.deepgram.ctaHint
              .replace("{duration}", durationLabel)
              .replace("{amount}", `$${costUsd}`)}
          </div>
        </div>
        <Button size="sm" onClick={() => setModalOpen(true)} className="shrink-0 gap-2">
          <Sparkles className="h-4 w-4" />
          {t.deepgram.ctaButton}
        </Button>
      </div>

      {modalOpen && (
        <ConfirmModal
          onClose={() => setModalOpen(false)}
          onConfirm={startBatch}
          starting={starting}
          preview={preview}
          usage={usage}
        />
      )}
    </>
  );
}

function ConfirmModal({
  onClose,
  onConfirm,
  starting,
  preview,
  usage,
}: {
  onClose: () => void;
  onConfirm: () => void;
  starting: boolean;
  preview: Preview;
  usage: UsageLite | null;
}) {
  const { t } = useI18n();
  const costUsd = (preview.estimatedCostCents / 100).toFixed(2);
  const hours = Math.floor(preview.totalSeconds / 3600);
  const minutes = Math.floor((preview.totalSeconds % 3600) / 60);
  const durationLabel = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  // Sanity: would this batch overrun the user's credit? Warn if so.
  const willOverrun = usage
    ? preview.estimatedCostCents > usage.remainingCents
    : false;

  const afterCents = usage
    ? Math.max(0, usage.remainingCents - preview.estimatedCostCents)
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md space-y-4 rounded-lg border border-border bg-background p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 className="text-lg font-semibold">{t.deepgram.modalTitle}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t.deepgram.modalSubtitle}</p>
        </header>

        <dl className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <Row label={t.deepgram.modalRowVideos} value={String(preview.missing)} />
          <Row label={t.deepgram.modalRowDuration} value={durationLabel} />
          <Row
            label={t.deepgram.modalRowCost}
            value={`~$${costUsd}`}
            valueClass="font-semibold"
          />
          {usage && (
            <>
              <Row
                label={t.deepgram.modalRowRemaining}
                value={`$${(usage.remainingCents / 100).toFixed(2)}`}
              />
              {afterCents !== null && (
                <Row
                  label={t.deepgram.modalRowAfter}
                  value={`$${(afterCents / 100).toFixed(2)}`}
                  valueClass={cn(willOverrun && "text-destructive font-semibold")}
                />
              )}
            </>
          )}
        </dl>

        {willOverrun && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {t.deepgram.overrunWarning}
          </div>
        )}

        {preview.videos.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {t.deepgram.firstFew}
            </summary>
            <ul className="mt-1.5 space-y-1">
              {preview.videos.map((v) => (
                <li key={v.id} className="truncate text-muted-foreground">
                  • {v.title}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={starting}>
            {t.deepgram.cancel}
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={starting} className="gap-2">
            {starting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t.deepgram.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("tabular-nums", valueClass)}>{value}</dd>
    </div>
  );
}
