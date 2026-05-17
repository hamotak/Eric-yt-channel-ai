"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Loader2,
  MessageCircle,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Preview = {
  total: number;
  videos: { id: string; title: string }[];
  activeJob: CommentSyncJob | null;
};

type CommentSyncJob = {
  id: number;
  started_at: number;
  completed_at: number | null;
  total: number;
  done: number;
  failed: number;
  comments_added: number;
  current_video_id: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  last_error: string | null;
};

type Candidate = {
  id: string;
  title: string;
  views: number;
  publishedAt: number | null;
  commentsCount: number;
  lastSyncedAt: number | null;
};

type SortKey = "recent" | "views" | "oldest";
type PickerMode = "all" | "top-n" | "specific" | "only-missing";

type StartArgs =
  | { mode: "all" }
  | { mode: "only-missing" }
  | { mode: "top-n"; topN: number; orderBy: SortKey; onlyMissing: boolean }
  | { mode: "specific"; videoIds: string[] };

/**
 * Bulk comment-sync entrypoint on /videos. Same shape and runtime
 * states as the transcribe banner — running progress / finished result
 * / CTA — except the job pulls YouTube comments instead of Deepgram
 * transcripts. Picker modal lets the user choose between every video
 * on the channel, only videos that have no comments synced yet,
 * top-N by some sort, or a hand-picked list.
 */
export function SyncAllCommentsBanner() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<CommentSyncJob | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [youtubeReady, setYoutubeReady] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Count of videos that have NEVER been synced yet (drives the "X new
  // videos need comments" hint).
  const [missingCount, setMissingCount] = useState<number | null>(null);

  const loadPreview = useCallback(async () => {
    try {
      const [p, missing, integ] = await Promise.all([
        fetch("/api/comments/sync-all").then((r) => r.json() as Promise<Preview>),
        fetch("/api/comments/sync-all?onlyMissing=1").then(
          (r) => r.json() as Promise<Preview>
        ),
        fetch("/api/integrations").then((r) => r.json()),
      ]);
      setPreview(p);
      setMissingCount(missing.total);
      setYoutubeReady(!!integ?.integrations?.youtube?.hasKey);
      if (p.activeJob) setJob(p.activeJob);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/comments/jobs/latest");
        if (!res.ok) return;
        const data = (await res.json()) as { job: CommentSyncJob | null };
        if (cancelled) return;
        if (data.job) {
          setJob(data.job);
          if (data.job.status !== "running") loadPreview();
        }
      } catch {
        /* transient */
      }
    };
    const id = window.setInterval(tick, 2500);
    tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [job, loadPreview]);

  const startBatch = useCallback(async (args: StartArgs) => {
    setStarting(true);
    try {
      let body: Record<string, unknown> = {};
      if (args.mode === "only-missing") body = { onlyMissing: true };
      else if (args.mode === "top-n")
        body = { topN: args.topN, orderBy: args.orderBy, onlyMissing: args.onlyMissing };
      else if (args.mode === "specific") body = { videoIds: args.videoIds };

      const res = await fetch("/api/comments/sync-all", {
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
          comments_added: 0,
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
  }, []);

  const finishedJob =
    job && job.status !== "running" && !dismissed ? job : null;

  // YouTube key missing → nothing to do here (we depend on it for
  // commentThreads.list).
  if (!youtubeReady) return null;

  // Finished
  if (finishedJob) {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-green-500/5 p-3 text-sm">
        <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
        <div className="flex-1">
          <div className="font-medium">
            Comment sync finished: {finishedJob.done} / {finishedJob.total} videos
            {finishedJob.failed > 0 && (
              <span className="ml-2 text-destructive">({finishedJob.failed} failed)</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {finishedJob.comments_added.toLocaleString()} new comments added across the batch.
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

  // Running
  if (job && job.status === "running") {
    const pct = job.total > 0 ? (job.done / job.total) * 100 : 0;
    const cancelJob = async () => {
      if (!confirm("Stop the running comment sync? Already-fetched comments stay saved; the rest are skipped.")) return;
      try {
        const r = await fetch("/api/comments/jobs/cancel", { method: "POST" });
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
            Syncing comments: {job.done} / {job.total} videos
            {job.failed > 0 && (
              <span className="text-destructive">({job.failed} failed)</span>
            )}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {job.comments_added.toLocaleString()} new comments so far
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
          Pulling top-relevance comment threads from YouTube. ~1 second per video, runs in the background.
        </p>
      </div>
    );
  }

  if (!preview) return null;

  // CTA
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3">
        <MessageCircle className="h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium">
            {missingCount !== null && missingCount > 0
              ? `${missingCount} video${missingCount === 1 ? "" : "s"} on this channel have no comments synced yet`
              : `${preview.total} video${preview.total === 1 ? "" : "s"} on this channel`}
          </div>
          <div className="text-xs text-muted-foreground">
            Sync comments in bulk so the AI chat and comment analysis can read them — costs YouTube API quota (≈1 unit per video).
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
          {missingCount !== null && missingCount > 0 && (
            <Button
              size="sm"
              onClick={() => startBatch({ mode: "only-missing" })}
              disabled={starting}
              className="gap-2"
            >
              <MessageCircle className="h-4 w-4" />
              Sync {missingCount} missing
            </Button>
          )}
        </div>
      </div>

      {pickerOpen && (
        <PickerModal
          onClose={() => setPickerOpen(false)}
          onConfirm={startBatch}
          starting={starting}
          defaultTotal={preview.total}
          defaultMissing={missingCount ?? 0}
        />
      )}
    </>
  );
}

function PickerModal({
  onClose,
  onConfirm,
  starting,
  defaultTotal,
  defaultMissing,
}: {
  onClose: () => void;
  onConfirm: (args: StartArgs) => void;
  starting: boolean;
  defaultTotal: number;
  defaultMissing: number;
}) {
  const [mode, setMode] = useState<PickerMode>(
    defaultMissing > 0 ? "only-missing" : "all"
  );

  // top-n
  const [topN, setTopN] = useState<number>(10);
  const [orderBy, setOrderBy] = useState<SortKey>("recent");
  const [onlyMissingTop, setOnlyMissingTop] = useState(true);

  // specific
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  // server-computed preview (count only — no cost dimension for comments)
  const [previewCount, setPreviewCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const url = new URL("/api/comments/sync-all", window.location.origin);
      if (mode === "only-missing") url.searchParams.set("onlyMissing", "1");
      else if (mode === "top-n") {
        url.searchParams.set("topN", String(topN));
        url.searchParams.set("orderBy", orderBy);
        if (onlyMissingTop) url.searchParams.set("onlyMissing", "1");
      } else if (mode === "specific") {
        if (selected.size === 0) {
          if (!cancelled) setPreviewCount(0);
          return;
        }
        url.searchParams.set("videoIds", Array.from(selected).join(","));
      }
      try {
        const res = await fetch(url.toString());
        if (!res.ok) return;
        const data = (await res.json()) as { total: number };
        if (cancelled) return;
        setPreviewCount(data.total);
      } catch {
        /* ignore */
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [mode, topN, orderBy, onlyMissingTop, selected]);

  useEffect(() => {
    if (mode !== "specific" || candidates !== null || loadingCandidates) return;
    setLoadingCandidates(true);
    fetch("/api/comments/sync-all?candidates=1&orderBy=recent&limit=500")
      .then((r) => r.json() as Promise<{ candidates: Candidate[] }>)
      .then((d) => setCandidates(d.candidates ?? []))
      .catch(() => setCandidates([]))
      .finally(() => setLoadingCandidates(false));
  }, [mode, candidates, loadingCandidates]);

  const filteredCandidates = useMemo(() => {
    if (!candidates) return [];
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => c.title.toLowerCase().includes(q));
  }, [candidates, search]);

  const canConfirm =
    !starting &&
    ((mode === "all" && defaultTotal > 0) ||
      (mode === "only-missing" && defaultMissing > 0) ||
      (mode === "top-n" && topN > 0 && (previewCount ?? 0) > 0) ||
      (mode === "specific" && selected.size > 0));

  const handleConfirm = () => {
    if (mode === "all") onConfirm({ mode: "all" });
    else if (mode === "only-missing") onConfirm({ mode: "only-missing" });
    else if (mode === "top-n")
      onConfirm({ mode: "top-n", topN, orderBy, onlyMissing: onlyMissingTop });
    else onConfirm({ mode: "specific", videoIds: Array.from(selected) });
  };

  const displayN =
    mode === "all"
      ? defaultTotal
      : mode === "only-missing"
        ? defaultMissing
        : previewCount ?? 0;

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
          <h2 className="text-lg font-semibold">Sync comments</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose which videos to pull comments for. YouTube Data API quota: ≈1 unit per video.
          </p>
        </header>

        <div className="flex flex-wrap gap-1 rounded-md border border-border bg-muted/30 p-1">
          <ModeTab
            label={`Only missing${defaultMissing > 0 ? ` (${defaultMissing})` : ""}`}
            active={mode === "only-missing"}
            onClick={() => setMode("only-missing")}
          />
          <ModeTab
            label={`All on this channel${defaultTotal > 0 ? ` (${defaultTotal})` : ""}`}
            active={mode === "all"}
            onClick={() => setMode("all")}
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

        <div className="min-h-[160px]">
          {mode === "only-missing" && (
            <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
              <div className="font-medium">
                {defaultMissing > 0
                  ? `Sync comments for ${defaultMissing} video${defaultMissing === 1 ? "" : "s"} that have no comments in the local DB yet.`
                  : "Every video on this channel already has comments synced."}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Useful after a channel sync brought in new uploads. Skips anything already in your local DB.
              </p>
            </div>
          )}

          {mode === "all" && (
            <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
              <div className="font-medium">
                {defaultTotal > 0
                  ? `Re-sync comments for all ${defaultTotal} video${defaultTotal === 1 ? "" : "s"} on this channel.`
                  : "No videos on this channel yet."}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Overwrites any existing comments with the freshest top-relevance list from YouTube. Use this when you want recent reply counts and like counts updated.
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
                    id="cs-topn-only-missing"
                    checked={onlyMissingTop}
                    onChange={(e) => setOnlyMissingTop(e.target.checked)}
                    className="h-4 w-4 cursor-pointer rounded border-input"
                  />
                  <label
                    htmlFor="cs-topn-only-missing"
                    className="cursor-pointer text-xs"
                  >
                    Skip videos that already have comments
                  </label>
                </div>
              </div>
            </div>
          )}

          {mode === "specific" && (
            <div className="space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter titles…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8"
                />
              </div>

              {loadingCandidates ? (
                <div className="flex items-center justify-center rounded-md border border-border bg-muted/20 p-8 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading videos…
                </div>
              ) : filteredCandidates.length === 0 ? (
                <div className="rounded-md border border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
                  {search ? "No videos match." : "No videos found."}
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {filteredCandidates.length} videos · {selected.size} selected
                    </span>
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
                              {c.commentsCount > 0 && (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] text-green-700 dark:text-green-400">
                                  <Check className="h-2.5 w-2.5" />
                                  {c.commentsCount}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {c.views.toLocaleString()} views
                              {c.lastSyncedAt && (
                                <> · last synced {new Date(c.lastSyncedAt * 1000).toLocaleDateString()}</>
                              )}
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

        <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground">Videos to sync</span>
            <span className="font-semibold tabular-nums">{displayN}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Estimated YouTube API quota: ≈{Math.max(0, displayN * 2)} units
            ({displayN} videos × ~2 calls each). Daily free quota is 10,000 units.
          </div>
        </div>

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
            Start syncing
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
