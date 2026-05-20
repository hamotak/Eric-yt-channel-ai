"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Mode = "auto" | "new_angles" | "title_tweaks";

type HistoryEntry = {
  id: string;
  mode: Mode;
  count: number;
  status: "processing" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
};

type Idea = {
  id: string;
  title: string;
  description: string;
  fit_score: number | null;
  user_note: string | null;
  used?: boolean;
  feedback?: "positive" | "negative" | null;
  feedback_reason?: string | null;
  source_attribution: {
    family: string;
    topic_source: SourceVideo | null;
    format_source: SourceVideo | null;
    reasoning: string;
    method?: "new_angle" | "title_tweak" | "fresh";
    // Legacy fields — kept for old generations that pre-date FIX-A and
    // weren't picked up by the backfill. UI renders them as a bare link
    // when the new-shape fields are absent.
    topic_source_video_id?: string;
    format_source_video_id?: string;
  } | null;
};

type SourceVideo = {
  video_id: string;
  title: string;
  channel_name: string;
  channel_handle: string | null;
  multiplier: number | null;
};

type RejectedIdea = {
  id: string;
  title: string;
  reason: string | null;
  fit_score: number | null;
};

type GenerationStatus =
  | { status: "processing"; request_id: string; mode: string; count: number; started_at: string; elapsed_seconds: number; is_active_channel: boolean }
  | { status: "completed"; request_id: string; mode: string; count: number; started_at: string; completed_at: string; estimated_cost_millicents: number; ideas: Idea[]; rejected: RejectedIdea[] }
  | { status: "failed"; request_id: string; mode: string; count: number; error: string; started_at: string; completed_at: string | null };

const MODE_LABEL: Record<Mode, string> = {
  auto: "Auto",
  new_angles: "New Angles",
  title_tweaks: "Title Tweaks",
};

const MODE_DESCRIPTION: Record<Mode, string> = {
  auto: "Balanced mix. The AI picks the strongest moves per run.",
  new_angles: "Topic from one viral video + format from another. Cross-pollination.",
  title_tweaks: "Take a recent winning title, swap 1-2 keywords. A/B variants.",
};

function stepFromElapsed(elapsed: number): { label: string; pct: number } {
  // Heuristic from smoke baseline (gather 2s, compose ~234s, validate ~24s,
  // total ~260s). Caps at 95% to avoid 100% before the server says completed.
  if (elapsed < 3) return { label: "Gathering competitor data", pct: 3 };
  if (elapsed < 240) {
    const ramp = 5 + ((elapsed - 3) / 237) * 75;
    return { label: "Composing candidate ideas", pct: ramp };
  }
  if (elapsed < 300) {
    const ramp = 80 + ((elapsed - 240) / 60) * 15;
    return { label: "Validating and scoring channel-fit", pct: ramp };
  }
  return { label: "Finalizing", pct: 95 };
}

function relTime(iso: string): string {
  const d = new Date(iso + (iso.endsWith("Z") ? "" : "Z"));
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export default function IdeatePage() {
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [activeChannelName, setActiveChannelName] = useState<string | null>(null);
  const [competitorCount, setCompetitorCount] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const [mode, setMode] = useState<Mode>("auto");
  const [count, setCount] = useState(10);

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [generation, setGeneration] = useState<GenerationStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalMs = useRef(5000);

  // Initial load: active channel + competitor count + history. Then
  // auto-load the most recent completed generation so a refresh doesn't
  // drop the user into empty state — they can still click Generate to
  // start a new run (the composer stays at top regardless).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ch = await fetch("/api/channels/active").then((r) => r.json());
      if (cancelled) return;
      setActiveChannelId(ch.activeId ?? null);
      // Fetch channel name from /api/channel-info (lists all channels)
      const all = await fetch("/api/channel-info").then((r) => r.json()).catch(() => ({ channels: [] }));
      if (cancelled) return;
      const me = (all.channels ?? []).find((c: { channelId: string; title: string | null }) => c.channelId === ch.activeId);
      setActiveChannelName(me?.title ?? null);

      const comp = await fetch("/api/competitors").then((r) => r.json()).catch(() => ({ competitors: [] }));
      if (cancelled) return;
      setCompetitorCount(comp.competitors?.length ?? 0);

      const hist = await fetch("/api/ideate/history").then((r) => r.json()).catch(() => ({ history: [] }));
      if (cancelled) return;
      const items: HistoryEntry[] = hist.history ?? [];
      setHistory(items);
      setHistoryLoading(false);

      const mostRecent = items.find((h) => h.status === "completed") ?? items[0];
      if (mostRecent && !cancelled) {
        setCurrentId(mostRecent.id);
        void poll(mostRecent.id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const poll = useCallback(async (id: string) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    const tick = async () => {
      try {
        const r = await fetch(`/api/ideate/${id}`, { cache: "no-store" });
        const j = (await r.json()) as GenerationStatus;
        setGeneration(j);
        if (j.status === "processing") {
          pollIntervalMs.current = Math.min(15000, pollIntervalMs.current + 2000);
          pollTimer.current = setTimeout(tick, pollIntervalMs.current);
        } else {
          // Terminal — refresh history once
          const hist = await fetch("/api/ideate/history").then((r) => r.json());
          setHistory(hist.history ?? []);
        }
      } catch {
        pollTimer.current = setTimeout(tick, 5000);
      }
    };
    pollIntervalMs.current = 5000;
    tick();
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const onGenerate = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    setGeneration(null);
    try {
      const r = await fetch("/api/ideate/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, count }),
      });
      const j = await r.json();
      if (!r.ok) {
        setSubmitError(j.error ?? "could not start");
        return;
      }
      setCurrentId(j.request_id);
      void poll(j.request_id);
      // Refresh history right away so the new row shows
      const hist = await fetch("/api/ideate/history").then((r) => r.json());
      setHistory(hist.history ?? []);
    } finally {
      setSubmitting(false);
    }
  }, [mode, count, poll]);

  const loadHistoryEntry = useCallback(
    (id: string) => {
      setCurrentId(id);
      void poll(id);
    },
    [poll]
  );

  const hasCompetitors = (competitorCount ?? 0) > 0;
  const showProgress = generation?.status === "processing";
  const showCompleted = generation?.status === "completed";
  const showFailed = generation?.status === "failed";

  // History sidebar collapses to a slide-in panel at <1280px (xl). At
  // wider widths it stays docked. The user can also explicitly toggle
  // via the "History →" link in the main canvas.
  const [historyOverlayMode, setHistoryOverlayMode] = useState(false);
  const [historyOverlayOpen, setHistoryOverlayOpen] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1279.98px)");
    const sync = () => {
      setHistoryOverlayMode(mq.matches);
      if (!mq.matches) setHistoryOverlayOpen(false);
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return (
    <div className="-mx-6 -mb-6 -mt-20 flex h-[calc(100vh-3.5rem)]">
      {historyOverlayMode && historyOverlayOpen && (
        <button
          aria-label="Close history"
          type="button"
          onClick={() => setHistoryOverlayOpen(false)}
          className="fixed inset-0 z-30 bg-black/40"
        />
      )}
      {/* History sidebar */}
      <aside
        className={cn(
          "flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-background/40",
          "transition-transform duration-200 ease-in-out",
          historyOverlayMode
            ? historyOverlayOpen
              ? "fixed inset-y-0 left-0 z-40 translate-x-0 bg-background"
              : "fixed inset-y-0 left-0 z-40 -translate-x-full bg-background"
            : "translate-x-0"
        )}
      >
        <div className="px-4 py-5">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            History
          </h2>
        </div>
        {historyLoading ? (
          <p className="px-4 text-xs text-muted-foreground">Loading…</p>
        ) : history.length === 0 ? (
          <p className="px-4 text-xs text-muted-foreground">
            No runs yet for this channel.
          </p>
        ) : (
          <ul>
            {history.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => {
                    loadHistoryEntry(h.id);
                    if (historyOverlayMode) setHistoryOverlayOpen(false);
                  }}
                  className={cn(
                    "block w-full px-4 py-3 text-left text-sm transition-colors",
                    "hover:bg-accent/40",
                    currentId === h.id && "bg-accent/60"
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-foreground">
                      {MODE_LABEL[h.mode]} · {h.count}
                    </span>
                    {h.status !== "completed" && (
                      <span className={cn(
                        "font-mono text-[10px] uppercase tracking-wider",
                        h.status === "failed" ? "text-destructive" : "text-amber-600 dark:text-amber-400"
                      )}>
                        {h.status}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {relTime(h.startedAt)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Main canvas */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-6 pb-10 pt-20 leading-relaxed">
          {historyOverlayMode && (
            <button
              type="button"
              onClick={() => setHistoryOverlayOpen(true)}
              className="mb-6 text-xs text-primary hover:underline"
            >
              History →
            </button>
          )}
          <header className="mb-8">
            <h1 className="text-2xl font-semibold tracking-tight">
              Generate ideas for {activeChannelName ?? "this channel"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Sonnet 4.6 with extended thinking, grounded in your competitors&apos; recent outliers and your channel context.
            </p>
          </header>

          {!hasCompetitors ? (
            <p className="text-sm text-muted-foreground">
              <Link href="/competitors" className="text-primary hover:underline">
                Add at least 1 competitor first →
              </Link>
            </p>
          ) : (
            <Composer
              mode={mode}
              count={count}
              onModeChange={setMode}
              onCountChange={setCount}
              onGenerate={onGenerate}
              disabled={submitting || showProgress}
            />
          )}

          {submitError && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {submitError}
            </p>
          )}

          {showProgress && generation && generation.status === "processing" && (
            <ProgressSection elapsed={generation.elapsed_seconds} count={generation.count} />
          )}

          {showFailed && generation && generation.status === "failed" && (
            <FailedSection
              error={generation.error}
              onRetry={onGenerate}
            />
          )}

          {showCompleted && generation && generation.status === "completed" && (
            <CompletedSection
              ideas={generation.ideas}
              rejected={generation.rejected}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Composer({
  mode,
  count,
  onModeChange,
  onCountChange,
  onGenerate,
  disabled,
}: {
  mode: Mode;
  count: number;
  onModeChange: (m: Mode) => void;
  onCountChange: (n: number) => void;
  onGenerate: () => void;
  disabled: boolean;
}) {
  return (
    <div className="mb-10 space-y-5">
      <div>
        <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Mode
        </label>
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value as Mode)}
          disabled={disabled}
          className={cn(
            "mt-1.5 h-9 w-full rounded-md border border-input bg-background px-3 text-sm",
            "focus:outline-none focus:ring-2 focus:ring-ring"
          )}
        >
          <option value="auto">Auto</option>
          <option value="new_angles">New Angles</option>
          <option value="title_tweaks">Title Tweaks</option>
        </select>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {MODE_DESCRIPTION[mode]}
        </p>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Count
          </label>
          <span className="text-sm tabular-nums text-foreground">{count}</span>
        </div>
        <input
          type="range"
          min={10}
          max={25}
          step={1}
          value={count}
          disabled={disabled}
          onChange={(e) => onCountChange(Number(e.target.value))}
          className="mt-1.5 w-full accent-primary"
        />
      </div>

      <Button
        onClick={onGenerate}
        disabled={disabled}
        size="lg"
        className="w-full"
      >
        {disabled ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating…
          </>
        ) : (
          "Generate"
        )}
      </Button>
    </div>
  );
}

function ProgressSection({ elapsed, count }: { elapsed: number; count: number }) {
  const { label, pct } = stepFromElapsed(elapsed);
  return (
    <div className="mt-2 space-y-4" aria-live="polite">
      <div>
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-foreground">{label}…</span>
          <span className="tabular-nums text-muted-foreground">
            {Math.floor(elapsed)}s
          </span>
        </div>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          This takes ~3-5 minutes. You can leave this tab open.
        </p>
      </div>

      <ul className="mt-8 border-t border-border">
        {Array.from({ length: count }).map((_, i) => (
          <li key={i} className="border-b border-border py-6">
            <div className="h-5 w-3/4 animate-pulse rounded bg-muted/70" />
            <div className="mt-3 h-3 w-full animate-pulse rounded bg-muted/40" />
            <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-muted/40" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FailedSection({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="mt-6 space-y-3">
      <p className="text-sm text-destructive">Generation failed: {error}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function CompletedSection({
  ideas,
  rejected,
}: {
  ideas: Idea[];
  rejected: RejectedIdea[];
}) {
  const [showRejected, setShowRejected] = useState(false);
  return (
    <>
      <div className="mb-4 flex items-baseline justify-between text-sm">
        <h2 className="font-medium text-foreground">
          {ideas.length} {ideas.length === 1 ? "idea" : "ideas"}
        </h2>
        {rejected.length > 0 && (
          <button
            type="button"
            onClick={() => setShowRejected((v) => !v)}
            className="text-primary hover:underline"
          >
            {showRejected ? "Hide" : `${rejected.length} filtered, see why →`}
          </button>
        )}
      </div>

      {showRejected && rejected.length > 0 && (
        <div className="mb-8 rounded-md border border-border bg-muted/20 px-4 py-3">
          <ul className="space-y-2 text-sm">
            {rejected.map((r) => (
              <li key={r.id}>
                <div className="text-foreground">{r.title}</div>
                <div className="text-xs text-muted-foreground">
                  {r.reason ?? "—"}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="border-t border-border">
        {ideas.map((idea) => (
          <IdeaCard key={idea.id} idea={idea} />
        ))}
      </ul>
    </>
  );
}

function IdeaCard({ idea }: { idea: Idea }) {
  const [whyOpen, setWhyOpen] = useState(false);
  // Local mirrors of the server-truth fields. Optimistic — we flip the
  // local state immediately, then post; on failure we revert.
  const [used, setUsed] = useState(!!idea.used);
  const [feedback, setFeedback] = useState<"positive" | "negative" | null>(
    idea.feedback ?? null
  );
  const [feedbackReason, setFeedbackReason] = useState<string | null>(
    idea.feedback_reason ?? null
  );
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [draftReason, setDraftReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const patch = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      try {
        const r = await fetch(`/api/ideas/${idea.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          setActionError(j.error ?? `HTTP ${r.status}`);
          return false;
        }
        setActionError(null);
        return true;
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "save failed");
        return false;
      }
    },
    [idea.id]
  );

  const toggleUsed = useCallback(async () => {
    const next = !used;
    setUsed(next);
    const ok = await patch({ used: next });
    if (!ok) setUsed(!next);
  }, [used, patch]);

  const markYes = useCallback(async () => {
    const prior = feedback;
    setFeedback("positive");
    setFeedbackReason(null);
    setFeedbackOpen(false);
    const ok = await patch({ feedback: "positive" });
    if (!ok) setFeedback(prior);
  }, [feedback, patch]);

  const openNo = useCallback(() => {
    setFeedbackOpen(true);
    setDraftReason(feedbackReason ?? "");
  }, [feedbackReason]);

  const submitNo = useCallback(async () => {
    const reason = draftReason.trim();
    if (!reason) {
      setActionError("Give a one-line reason so the AI learns from it.");
      return;
    }
    const prior = feedback;
    const priorReason = feedbackReason;
    setFeedback("negative");
    setFeedbackReason(reason);
    setFeedbackOpen(false);
    const ok = await patch({ feedback: "negative", reason });
    if (!ok) {
      setFeedback(prior);
      setFeedbackReason(priorReason);
    }
  }, [draftReason, feedback, feedbackReason, patch]);

  const ytLink = (id: string | undefined) =>
    id ? `https://www.youtube.com/watch?v=${id}` : null;

  return (
    <li className="border-b border-border py-7">
      <h3
        className={cn(
          "text-xl font-medium leading-snug",
          used ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"
        )}
      >
        {idea.title}
      </h3>
      <div className="mt-1.5">
        <MethodBadge method={idea.source_attribution?.method ?? null} />
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {idea.description}
      </p>

      <div className="mt-4 flex items-center gap-4 text-xs">
        <button
          type="button"
          onClick={() => setWhyOpen((v) => !v)}
          className="text-primary hover:underline"
        >
          {whyOpen ? "Hide why" : "Why this works"}
        </button>

        {/* PRIO-9: I-shipped-this toggle. */}
        <button
          type="button"
          onClick={toggleUsed}
          aria-pressed={used}
          title={used ? "Mark as not used" : "Mark as used"}
          className={cn(
            "inline-flex items-center gap-1 hover:text-foreground",
            used
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
          )}
        >
          <Check className={cn("h-3.5 w-3.5", used ? "stroke-[3]" : "stroke-2")} />
          Used it
        </button>

        {/* PRIO-10: structured Yes/No feedback. */}
        <button
          type="button"
          onClick={markYes}
          aria-pressed={feedback === "positive"}
          title="This idea worked for me"
          className={cn(
            "inline-flex items-center gap-1 hover:text-foreground",
            feedback === "positive"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
          )}
        >
          <ThumbsUp
            className={cn(
              "h-3.5 w-3.5",
              feedback === "positive" && "fill-current"
            )}
          />
          YES
        </button>
        <button
          type="button"
          onClick={openNo}
          aria-pressed={feedback === "negative"}
          title="This idea doesn't work — tell the AI why"
          className={cn(
            "inline-flex items-center gap-1 hover:text-destructive",
            feedback === "negative"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          <ThumbsDown
            className={cn(
              "h-3.5 w-3.5",
              feedback === "negative" && "fill-current"
            )}
          />
          NO
        </button>

        {idea.fit_score !== null && (
          <span className="ml-auto font-mono text-[10px] tracking-wider text-muted-foreground">
            FIT {idea.fit_score}/10
          </span>
        )}
      </div>

      {feedbackOpen && (
        <div className="mt-3 space-y-1">
          <textarea
            value={draftReason}
            onChange={(e) => setDraftReason(e.target.value)}
            rows={2}
            placeholder="Why doesn't this work? E.g. 'satire substitution', 'topic too narrow'"
            className={cn(
              "w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
              "focus:outline-none focus:ring-2 focus:ring-ring"
            )}
          />
          <div className="flex items-center gap-2">
            <Button onClick={submitNo} size="sm" variant="destructive">
              Submit
            </Button>
            <button
              type="button"
              onClick={() => setFeedbackOpen(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {feedback === "negative" && feedbackReason && !feedbackOpen && (
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-destructive">Marked NO:</span>{" "}
          {feedbackReason}{" "}
          <button
            type="button"
            onClick={openNo}
            className="ml-1 underline-offset-2 hover:underline"
          >
            edit
          </button>
        </p>
      )}

      {actionError && (
        <p className="mt-2 text-xs text-destructive">{actionError}</p>
      )}

      {whyOpen && idea.source_attribution && (
        <div className="mt-3 space-y-4 text-sm">
          <div className="font-mono text-[10px] tracking-wider text-muted-foreground">
            {idea.source_attribution.family.toUpperCase()}
          </div>
          {idea.source_attribution.topic_source && (
            <SourceBlock
              label="Topic source"
              source={idea.source_attribution.topic_source}
            />
          )}
          {idea.source_attribution.format_source && (
            <SourceBlock
              label="Format source"
              source={idea.source_attribution.format_source}
            />
          )}
          {/* Legacy fallback for pre-FIX-A rows the backfill couldn't repair. */}
          {!idea.source_attribution.topic_source &&
            idea.source_attribution.topic_source_video_id && (
              <div className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Topic source: </span>
                <a
                  href={ytLink(idea.source_attribution.topic_source_video_id) ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {idea.source_attribution.topic_source_video_id}
                </a>
              </div>
            )}
          {!idea.source_attribution.format_source &&
            idea.source_attribution.format_source_video_id && (
              <div className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Format source: </span>
                <a
                  href={ytLink(idea.source_attribution.format_source_video_id) ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {idea.source_attribution.format_source_video_id}
                </a>
              </div>
            )}
        </div>
      )}
    </li>
  );
}

/**
 * Small uppercase mono badge next to FIT score. "New Angle" gets the
 * primary (red) text colour to telegraph the high-effort, outlier-grounded
 * path; "Title Tweak" and "Fresh" sit in muted text to avoid competing
 * with the FIT score visually. Old rows (pre-2026-05) have no `method`
 * field on disk — they render as a literal em-dash so the right rail
 * doesn't collapse and the user can tell "no data" from a real value.
 */
function MethodBadge({
  method,
}: {
  method: "new_angle" | "title_tweak" | "fresh" | null | undefined;
}) {
  if (!method) {
    return (
      <span className="font-mono text-[10px] tracking-wider text-muted-foreground/60">
        —
      </span>
    );
  }
  const label =
    method === "new_angle"
      ? "NEW ANGLE"
      : method === "title_tweak"
        ? "TITLE TWEAK"
        : "FRESH";
  const tone =
    method === "new_angle" ? "text-primary" : "text-muted-foreground";
  return (
    <span className={`font-mono text-[10px] uppercase tracking-wider ${tone}`}>
      {label}
    </span>
  );
}

function SourceBlock({ label, source }: { label: string; source: SourceVideo }) {
  const href = `https://www.youtube.com/watch?v=${source.video_id}`;
  // Name + handle (if present) + multiplier (if known). The handle is
  // de-duplicated when channel_name and channel_handle are effectively
  // the same string (some YT channels expose the @handle as the title).
  const channelParts: string[] = [];
  if (source.channel_name) channelParts.push(source.channel_name);
  if (
    source.channel_handle &&
    source.channel_handle.toLowerCase() !== source.channel_name?.toLowerCase()
  ) {
    channelParts.push(source.channel_handle);
  }
  return (
    <div>
      <div className="text-[10px] font-mono tracking-wider text-muted-foreground">
        {label.toUpperCase()}
      </div>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-0.5 inline-block text-sm text-primary hover:underline"
      >
        {source.title}
      </a>
      <div className="mt-0.5 text-xs text-muted-foreground">
        {channelParts.join(" · ")}
        {source.multiplier !== null && source.multiplier > 0 && (
          <> · {source.multiplier.toFixed(1)}×</>
        )}
      </div>
    </div>
  );
}
