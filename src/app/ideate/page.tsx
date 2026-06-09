"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { YouTubeThumbnail } from "@/components/youtube-thumbnail";
import { cn } from "@/lib/utils";

type Mode = "auto" | "new_angles" | "title_tweaks" | "reddit_angles";

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
  fit_reason?: string | null;
  validation_status?: "passed" | "rejected";
  validation_reason?: string | null;
  user_note: string | null;
  used?: boolean;
  feedback?: "positive" | "negative" | null;
  feedback_reason?: string | null;
  confidence_level?: "high" | "medium" | "low" | null;
  proof: IdeaProof | null;
  research_sources: IdeaSourceLink[];
  source_attribution: {
    family: string;
    topic_source: SourceVideo | null;
    format_source: SourceVideo | null;
    topic_evidence_sources?: SourceVideo[];
    reasoning: string;
    method?: "new_angle" | "title_tweak" | "reddit_angle" | "fresh";
    // Legacy fields — kept for old generations that pre-date FIX-A and
    // weren't picked up by the backfill. UI renders them as a bare link
    // when the new-shape fields are absent.
    topic_source_video_id?: string;
    format_source_video_id?: string;
  } | null;
};

type IdeaSourceLink = {
  type: "youtube" | "reddit";
  label: string;
  url: string;
  date?: string | null;
};

type IdeaProof = {
  source_signal: string;
  fit: string;
  execution: string;
  whats_going_on?: string | null;
  weak_proof?: string | null;
  sources: IdeaSourceLink[];
};

type SourceVideo = {
  video_id: string;
  title: string;
  channel_name: string;
  channel_handle: string | null;
  multiplier: number | null;
  thumbnail_url?: string | null;
  views?: number | null;
  published_at?: number | null;
  age_days?: number | null;
};

type TitleSettings = {
  model: string;
  rules: string[];
  defaultRulesText: string;
  rulesText: string;
  rulesCap: number;
  forbiddenWords: string[];
};

type GenerationStatus =
  | { status: "processing"; request_id: string; mode: string; count: number; started_at: string; elapsed_seconds: number; is_active_channel: boolean }
  | { status: "completed"; request_id: string; mode: string; count: number; started_at: string; completed_at: string; estimated_cost_millicents: number; ideas: Idea[]; rejected?: [] }
  | { status: "failed"; request_id: string; mode: string; count: number; error: string; started_at: string; completed_at: string | null };

const MODE_LABEL: Record<Mode, string> = {
  auto: "Auto",
  new_angles: "New Angles",
  title_tweaks: "Title Tweaks",
  reddit_angles: "Reddit Angles",
};

const MODE_DESCRIPTION: Record<Mode, string> = {
  auto: "Balanced mix. The AI picks the strongest moves per run.",
  new_angles: "Topic from one viral video + format from another. Cross-pollination.",
  title_tweaks: "Take a recent winning title, swap 1-2 keywords. A/B variants.",
  reddit_angles: "Brave-powered subreddit signal + proven YouTube format.",
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
  const [activeChannelRedditSources, setActiveChannelRedditSources] = useState("");
  const [braveSearchReady, setBraveSearchReady] = useState(false);
  const [titleSettings, setTitleSettings] = useState<TitleSettings | null>(null);
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
      const me = (all.channels ?? []).find(
        (c: { channelId: string; title: string | null; redditSources?: string }) =>
          c.channelId === ch.activeId
      );
      setActiveChannelName(me?.title ?? null);
      setActiveChannelRedditSources(me?.redditSources ?? "");

      const integrations = await fetch("/api/integrations")
        .then((r) => r.json())
        .catch(() => ({ integrations: {} }));
      if (cancelled) return;
      setBraveSearchReady(!!integrations.integrations?.brave?.hasKey);

      const settings = await fetch("/api/ideate/settings")
        .then((r) => r.json())
        .catch(() => null);
      if (cancelled) return;
      if (settings?.titleSettings) setTitleSettings(settings.titleSettings);

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
  const redditSourcesConfigured = activeChannelRedditSources.trim().length > 0;
  const redditReady = redditSourcesConfigured && braveSearchReady;
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
              redditReady={redditReady}
              redditSourcesConfigured={redditSourcesConfigured}
              braveSearchReady={braveSearchReady}
              titleSettings={titleSettings}
              onTitleSettingsChange={setTitleSettings}
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
  redditReady,
  redditSourcesConfigured,
  braveSearchReady,
  titleSettings,
  onTitleSettingsChange,
}: {
  mode: Mode;
  count: number;
  onModeChange: (m: Mode) => void;
  onCountChange: (n: number) => void;
  onGenerate: () => void;
  disabled: boolean;
  redditReady: boolean;
  redditSourcesConfigured: boolean;
  braveSearchReady: boolean;
  titleSettings: TitleSettings | null;
  onTitleSettingsChange: (settings: TitleSettings) => void;
}) {
  const showRedditNote = mode === "auto" || mode === "reddit_angles";
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
          <option value="reddit_angles">Reddit Angles</option>
        </select>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {MODE_DESCRIPTION[mode]}
        </p>
        {showRedditNote && !redditSourcesConfigured && (
          <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
            Reddit inactive: add subreddit sources in{" "}
            <Link href="/channel-info" className="underline-offset-2 hover:underline">
              Channel Info
            </Link>
            .
          </p>
        )}
        {showRedditNote && redditSourcesConfigured && !braveSearchReady && (
          <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
            Reddit inactive: add a Brave Search key in Settings.
          </p>
        )}
        {showRedditNote && redditReady && (
          <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            Reddit active: Auto can include Reddit Angles.
          </p>
        )}
      </div>

      {titleSettings && (
        <details className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium text-foreground">
            Title rules sent to Claude
          </summary>
          <div className="mt-2 space-y-2 text-muted-foreground">
            <div className="font-mono text-[10px] uppercase tracking-wider">
              {titleSettings.model}
            </div>
            <TitleRulesEditor
              titleSettings={titleSettings}
              onSaved={onTitleSettingsChange}
            />
          </div>
        </details>
      )}

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

function TitleRulesEditor({
  titleSettings,
  onSaved,
}: {
  titleSettings: TitleSettings;
  onSaved: (settings: TitleSettings) => void;
}) {
  const [value, setValue] = useState(titleSettings.rulesText ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(titleSettings.rulesText ?? "");
    setStatus(null);
    setError(null);
  }, [titleSettings.rulesText]);

  const cap = titleSettings.rulesCap;
  const overCap = value.length > cap;
  const dirty = value !== (titleSettings.rulesText ?? "");

  const save = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const r = await fetch("/api/ideate/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rulesText: value }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        titleSettings?: TitleSettings;
      };
      if (!r.ok || !j.titleSettings) {
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      onSaved(j.titleSettings);
      setStatus("Saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }, [onSaved, value]);

  return (
    <div className="mt-3 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="font-medium text-foreground">Editable title rules</div>
          <p className="mt-0.5 text-muted-foreground">
            One rule per line. These are sent to Claude on every ideation run.
          </p>
        </div>
        <span className={cn("shrink-0 tabular-nums", overCap && "text-destructive")}>
          {value.length}/{cap}
        </span>
      </div>

      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setStatus(null);
          setError(null);
        }}
        rows={5}
        className={cn(
          "mt-2 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground",
          "focus:outline-none focus:ring-2 focus:ring-ring"
        )}
        placeholder="One title rule per line"
      />

      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setValue(titleSettings.defaultRulesText);
            setStatus(null);
            setError(null);
          }}
          disabled={saving || value === titleSettings.defaultRulesText}
          className="shrink-0"
        >
          Reset
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={saving || overCap || !dirty}
          className="shrink-0"
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      {(status || error) && (
        <p className={cn("mt-2", error ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")}>
          {error ?? status}
        </p>
      )}
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

function CompletedSection({ ideas }: { ideas: Idea[] }) {
  return (
    <>
      <div className="mb-4 flex items-baseline justify-between text-sm">
        <h2 className="font-medium text-foreground">
          {ideas.length} {ideas.length === 1 ? "idea" : "ideas"}
        </h2>
      </div>

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
  const [copied, setCopied] = useState(false);
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

  const copyTitle = useCallback(async () => {
    const prior = used;
    const next = !used;
    try {
      await copyToClipboard(idea.title);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Browser focus/permission quirks should not block the "mark green"
      // action. The visible UI stays quiet and minimal.
    }
    setUsed(next);
    const ok = await patch({ used: next });
    if (!ok) {
      setUsed(prior);
      return;
    }
    setActionError(null);
  }, [idea.title, patch, used]);

  return (
    <li className="border-b border-border py-7">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <h3 className="min-w-0 text-xl font-medium leading-snug">
          <button
            type="button"
            onClick={copyTitle}
            className={cn(
              "inline text-left leading-snug underline-offset-2 hover:underline",
              used ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"
            )}
          >
            {idea.title}
          </button>
        </h3>
        <button
          type="button"
          onClick={copyTitle}
          aria-label="Copy title"
          title={copied ? "Copied" : "Copy title"}
          className={cn(
            "inline-flex translate-y-[2px] shrink-0 rounded-none bg-transparent p-0.5 text-muted-foreground",
            "opacity-70 transition-opacity hover:text-foreground hover:opacity-100"
          )}
        >
          <Copy className="h-4 w-4 stroke-[2.25]" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-1.5">
        <MethodBadge method={idea.source_attribution?.method ?? null} />
        <ValidationScoreBadge
          score={idea.fit_score}
          status={idea.validation_status ?? "passed"}
        />
        {idea.confidence_level && (
          <span
            className={cn(
              "ml-2 font-mono text-[10px] uppercase tracking-wider",
              idea.confidence_level === "high"
                ? "text-emerald-600 dark:text-emerald-400"
                : idea.confidence_level === "medium"
                  ? "text-muted-foreground"
                  : "text-amber-600 dark:text-amber-400"
            )}
          >
            {idea.confidence_level} confidence
          </span>
        )}
      </div>

      <InspirationStrip idea={idea} />

      <div className="mt-4 flex items-center gap-4 text-xs">
        <button
          type="button"
          onClick={() => setWhyOpen((v) => !v)}
          className="text-primary hover:underline"
        >
          {whyOpen ? "Hide why" : "Why this works"}
        </button>
      </div>

      {actionError && (
        <p className="mt-2 text-xs text-destructive">{actionError}</p>
      )}

      {whyOpen && (
        <div className="mt-3 space-y-4 text-sm">
          {idea.source_attribution?.family && (
            <div className="font-mono text-[10px] tracking-wider text-muted-foreground">
              {idea.source_attribution.family.toUpperCase()}
            </div>
          )}
          <ValidationReview idea={idea} />
          {idea.proof && <ProofBlock proof={idea.proof} researchSources={idea.research_sources ?? []} />}
        </div>
      )}
    </li>
  );
}

function ValidationScoreBadge({
  score,
  status,
}: {
  score: number | null;
  status: "passed" | "rejected";
}) {
  const value = typeof score === "number" && Number.isFinite(score) ? score : null;
  const normalized = value === null ? 0 : Math.max(0, Math.min(10, value));
  const hue =
    normalized <= 5
      ? (normalized / 5) * 42
      : 42 + ((normalized - 5) / 5) * 98;
  const label = value === null ? "—" : normalized.toFixed(1);
  return (
    <span
      className={cn(
        "ml-2 inline-flex min-w-[2.35rem] justify-center rounded px-1.5 py-0.5",
        "border font-mono text-[10px] tabular-nums",
        status === "rejected" && "ring-1 ring-inset ring-current/10"
      )}
      style={{
        color: `hsl(${hue}, 55%, 58%)`,
        backgroundColor: `hsla(${hue}, 65%, 45%, 0.14)`,
        borderColor: `hsla(${hue}, 55%, 48%, 0.28)`,
      }}
      title={status === "rejected" ? "Weak or rejected by validation" : "Validation score"}
    >
      {label}
    </span>
  );
}

function ValidationReview({ idea }: { idea: Idea }) {
  const good = idea.fit_reason?.trim();
  const weak =
    idea.proof?.weak_proof?.trim() ||
    idea.validation_reason?.trim() ||
    null;
  if (!good && !weak) return null;
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/15 p-3 text-xs">
      {good && (
        <div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            Good
          </span>
          <p className="mt-1 text-muted-foreground">{good}</p>
        </div>
      )}
      {weak && (
        <div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400">
            Weak
          </span>
          <p className="mt-1 text-muted-foreground">{weak}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Small uppercase mono badge next to the score. "New Angle" gets the
 * primary (red) text colour to telegraph the high-effort, outlier-grounded
 * path; "Title Tweak" and "Fresh" sit in muted text to avoid competing
 * with the validation score visually. Old rows (pre-2026-05) have no `method`
 * field on disk — they render as a literal em-dash so the right rail
 * doesn't collapse and the user can tell "no data" from a real value.
 */
function MethodBadge({
  method,
}: {
  method: "new_angle" | "title_tweak" | "reddit_angle" | "fresh" | null | undefined;
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
      : method === "reddit_angle"
        ? "REDDIT ANGLE"
      : method === "title_tweak"
        ? "TITLE TWEAK"
        : "FRESH";
  const tone =
    method === "new_angle" || method === "reddit_angle"
      ? "text-primary"
      : "text-muted-foreground";
  return (
    <span className={`font-mono text-[10px] uppercase tracking-wider ${tone}`}>
      {label}
    </span>
  );
}

async function copyToClipboard(text: string): Promise<void> {
  window.focus();
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the textarea path for browser focus/permission quirks.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!ok) throw new Error("copy failed");
}

function ytLink(id: string | undefined | null): string | null {
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

function compactNumber(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
}

function formatUnixDate(value: number | null | undefined): string | null {
  if (typeof value !== "number" || value <= 0) return null;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value * 1000));
}

function uploadAgeLabel(source: SourceVideo): string | null {
  if (typeof source.age_days === "number") {
    if (source.age_days < 1) return "today";
    if (source.age_days < 30) return `${source.age_days}d ago`;
    if (source.age_days < 365) return `${Math.round(source.age_days / 30)}mo ago`;
    return `${Math.round(source.age_days / 365)}y ago`;
  }
  if (typeof source.published_at === "number" && source.published_at > 0) {
    const days = Math.max(
      0,
      Math.floor((Date.now() / 1000 - source.published_at) / 86400)
    );
    return uploadAgeLabel({ ...source, age_days: days });
  }
  return null;
}

function channelLabel(source: SourceVideo): string | null {
  const parts: string[] = [];
  if (source.channel_name) parts.push(source.channel_name);
  if (
    source.channel_handle &&
    source.channel_handle.toLowerCase() !== source.channel_name?.toLowerCase()
  ) {
    parts.push(source.channel_handle);
  }
  return parts.length ? parts.join(" · ") : null;
}

function sourceMetaParts(source: SourceVideo): string[] {
  const parts: string[] = [];
  const channel = channelLabel(source);
  const views = compactNumber(source.views);
  const age = uploadAgeLabel(source);
  const date = formatUnixDate(source.published_at);
  if (channel) parts.push(channel);
  if (views) parts.push(`${views} views`);
  if (source.multiplier !== null && source.multiplier !== undefined && source.multiplier > 0) {
    parts.push(`${source.multiplier.toFixed(1)}× outlier`);
  }
  if (age) parts.push(age);
  if (date) parts.push(date);
  return parts;
}

function dedupeSourceLinks(sources: IdeaSourceLink[]): IdeaSourceLink[] {
  const seen = new Set<string>();
  const out: IdeaSourceLink[] = [];
  for (const source of sources) {
    const key = source.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

function youtubeSourcesForIdea(
  idea: Idea
): Array<{ label: string; source: SourceVideo }> {
  const attr = idea.source_attribution;
  if (!attr) return [];
  const sources: Array<{ label: string; source: SourceVideo }> = [];
  const seen = new Set<string>();
  const add = (label: string, source: SourceVideo | null | undefined) => {
    if (!source || seen.has(source.video_id)) return;
    seen.add(source.video_id);
    sources.push({ label, source });
  };
  add(attr.method === "title_tweak" ? "Inspiration" : "Topic source", attr.topic_source);
  add("Format source", attr.format_source);
  return sources;
}

function topicSignalsForIdea(idea: Idea): SourceVideo[] {
  const attr = idea.source_attribution;
  if (!attr) return [];
  const out: SourceVideo[] = [];
  const seen = new Set<string>();
  const add = (source: SourceVideo | null | undefined) => {
    if (!source || seen.has(source.video_id)) return;
    seen.add(source.video_id);
    out.push(source);
  };
  add(attr.topic_source);
  for (const source of attr.topic_evidence_sources ?? []) add(source);
  return out;
}

function redditSourcesForIdea(idea: Idea): IdeaSourceLink[] {
  return dedupeSourceLinks([
    ...(idea.proof?.sources ?? []),
    ...(idea.research_sources ?? []),
  ]).filter((source) => source.type === "reddit");
}

function InspirationStrip({ idea }: { idea: Idea }) {
  const attr = idea.source_attribution;
  const topicSignals = topicSignalsForIdea(idea);
  const youtubeSources = youtubeSourcesForIdea(idea);
  const redditSources = redditSourcesForIdea(idea);
  const legacyTopicId =
    !attr?.topic_source && typeof attr?.topic_source_video_id === "string"
      ? attr.topic_source_video_id
      : null;
  const legacyFormatId =
    !attr?.format_source && typeof attr?.format_source_video_id === "string"
      ? attr.format_source_video_id
      : null;

  if (
    youtubeSources.length === 0 &&
    redditSources.length === 0 &&
    !legacyTopicId &&
    !legacyFormatId
  ) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2">
      {youtubeSources.map(({ label, source }, idx) => (
        <div key={`${label}-${source.video_id}`}>
          <YouTubeInspiration label={label} source={source} />
          {idx === 0 && topicSignals.length > 1 && (
            <TopicSignalsDisclosure sources={topicSignals} />
          )}
        </div>
      ))}
      {redditSources.slice(0, 2).map((source) => (
        <RedditInspiration key={source.url} source={source} />
      ))}
      {legacyTopicId && <LegacyYouTubeSource label="Topic source" videoId={legacyTopicId} />}
      {legacyFormatId && <LegacyYouTubeSource label="Format source" videoId={legacyFormatId} />}
    </div>
  );
}

function TopicSignalsDisclosure({ sources }: { sources: SourceVideo[] }) {
  const [open, setOpen] = useState(false);
  const extras = sources.slice(1);
  if (extras.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-2 border-l border-border py-1 pl-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="font-mono uppercase tracking-wider">
          {sources.length} topic signals
        </span>
        <span className="text-primary">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {extras.map((source, idx) => (
            <YouTubeInspiration
              key={source.video_id}
              label={`Topic signal ${idx + 2}`}
              source={source}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function YouTubeInspiration({
  label,
  source,
}: {
  label: string;
  source: SourceVideo;
}) {
  const href = ytLink(source.video_id) ?? "#";
  const meta = sourceMetaParts(source);
  return (
    <div className="flex min-h-[74px] gap-3 rounded-md border border-border bg-muted/15 p-2.5">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="relative block aspect-video h-[64px] shrink-0 overflow-hidden rounded bg-black"
        aria-label={`Open ${source.title}`}
      >
        <YouTubeThumbnail
          videoId={source.video_id}
          src={source.thumbnail_url}
          className="h-full w-full"
        />
      </a>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 block line-clamp-2 text-sm font-medium leading-snug text-foreground hover:text-primary"
        >
          {source.title}
        </a>
        {meta.length > 0 && (
          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {meta.join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

function RedditInspiration({ source }: { source: IdeaSourceLink }) {
  return (
    <div className="rounded-md border border-border bg-muted/15 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        Reddit signal
      </div>
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-0.5 block text-sm font-medium text-foreground hover:text-primary"
      >
        {source.label}
      </a>
      {source.date && (
        <div className="mt-1 text-xs text-muted-foreground">{source.date}</div>
      )}
    </div>
  );
}

function LegacyYouTubeSource({
  label,
  videoId,
}: {
  label: string;
  videoId: string;
}) {
  const href = ytLink(videoId) ?? "#";
  return (
    <div className="rounded-md border border-border bg-muted/15 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-0.5 block text-sm text-primary hover:underline"
      >
        {videoId}
      </a>
    </div>
  );
}

function ProofBlock({
  proof,
  researchSources,
}: {
  proof: IdeaProof;
  researchSources: IdeaSourceLink[];
}) {
  const sources = [...proof.sources, ...researchSources].filter(
    (source, idx, arr) => arr.findIndex((s) => s.url === source.url) === idx
  );
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      {proof.whats_going_on && (
        <div>
          <div className="text-[10px] font-mono tracking-wider text-muted-foreground">
            WHAT&apos;S GOING ON
          </div>
          <p className="mt-0.5 text-sm text-foreground/90">
            {proof.whats_going_on}
          </p>
        </div>
      )}
      <ProofLine label="Signal" value={proof.source_signal} />
      <ProofLine label="Fit" value={proof.fit} />
      <ProofLine label="Execution" value={proof.execution} />
      {proof.weak_proof && (
        <ProofLine label="Weak proof" value={proof.weak_proof} muted />
      )}
      {sources.length > 0 && (
        <div>
          <div className="text-[10px] font-mono tracking-wider text-muted-foreground">
            SOURCES
          </div>
          <div className="mt-1 flex flex-wrap gap-2">
            {sources.map((source) => (
              <a
                key={`${source.type}-${source.url}`}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded border border-border bg-background px-2 py-1 text-xs text-primary hover:underline"
              >
                {source.label}
                {source.date ? ` · ${source.date}` : ""}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProofLine({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-mono tracking-wider text-muted-foreground">
        {label.toUpperCase()}
      </div>
      <p className={cn("mt-0.5 text-sm", muted ? "text-muted-foreground" : "text-foreground/90")}>
        {value}
      </p>
    </div>
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
