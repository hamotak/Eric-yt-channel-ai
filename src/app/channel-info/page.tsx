"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  BannedTopicsEditor,
  DescriptionEditor,
  IdeationRulesEditor,
  RedditSourcesEditor,
} from "@/components/agent-brain-editors";
import { LearnedRulesPanel } from "@/components/learned-rules-panel";
import { YouTubeThumbnail } from "@/components/youtube-thumbnail";

// Wire shape for the redesigned 2-field model. Legacy fields preserved
// so older clients reading the GET response don't break; the page no
// longer surfaces them (migration concatenated their text into the new
// channel_description column on first boot).
type ChannelContext = {
  id: string;
  channelId: string;
  title: string | null;
  handle: string | null;
  subscriberCount: number | null;
  avatarUrl: string | null;
  channelDescription: string;
  ideationRules: string;
  bannedTopics: string;
  redditSources: string;
  // Legacy — kept for type completeness, never rendered.
  niche: string;
  positioning: string;
  audience: string;
  voice: string;
  externalSources: string;
};

type ChannelVideo = {
  id: string;
  title: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  published_at: number | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
};

// v2 cache key — flips when the proposal shape went from {niche,…} to
// {description}. Stale v1 entries are ignored.
const ANALYZE_CACHE_TTL_MS = 5 * 60 * 1000;
const ANALYZE_CACHE_VERSION = "v2";

export default function ChannelInfoPage() {
  // FIX-I: scope to the active channel only. Multi-channel summary table
  // removed; the top-right channel switcher is the single source of truth
  // for which channel renders here. Switching there triggers a full
  // window.location.reload() (see channel-switcher.tsx), which re-runs
  // these useEffects and swaps the editor naturally — no extra
  // revalidation wiring needed.
  const [channels, setChannels] = useState<ChannelContext[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/channels/active", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { activeId: string | null }) => {
        if (cancelled) return;
        setActiveChannelId(d.activeId ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const loadChannels = useCallback(async () => {
    try {
      const r = await fetch("/api/channel-info", { cache: "no-store" });
      const d = (await r.json()) as { channels?: ChannelContext[] };
      setChannels(d.channels ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load channels.");
      setChannels([]);
    }
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  const handleUpdated = useCallback((next: ChannelContext) => {
    setChannels((prev) =>
      prev
        ? prev.map((c) => (c.channelId === next.channelId ? next : c))
        : prev
    );
  }, []);

  const activeChannel =
    channels && activeChannelId
      ? channels.find((c) => c.channelId === activeChannelId) ?? null
      : null;

  // Status signal preserved from the deleted multi-channel table: green
  // when description AND ideation rules are both populated, amber when
  // anything is missing.
  const contextFilled = !!activeChannel &&
    activeChannel.channelDescription.trim().length > 0 &&
    activeChannel.ideationRules.trim().length > 0;

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Channel Info</h1>
          {activeChannel && (
            <span
              className={
                contextFilled
                  ? "inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
                  : "inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
              }
            >
              {contextFilled ? "Context filled" : "Needs context"}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {activeChannel
            ? `Channel context for ${activeChannel.title ?? activeChannel.handle ?? "this channel"}. Every AI feature reads from this.`
            : "Pick a channel from the top-right picker."}
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {channels === null ? (
        <SkeletonCard />
      ) : channels.length === 0 ? (
        <EmptyState />
      ) : activeChannel ? (
        <SingleChannelCard channel={activeChannel} onUpdated={handleUpdated} />
      ) : (
        <NoActiveChannelHint />
      )}
    </div>
  );
}

/* ---------------- Single-channel card ---------------- */

function SingleChannelCard({
  channel,
  onUpdated,
}: {
  channel: ChannelContext;
  onUpdated: (next: ChannelContext) => void;
}) {
  const [aiOpen, setAiOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiProposal, setAiProposal] = useState<{ description: string } | null>(
    null
  );
  const [aiApplying, setAiApplying] = useState(false);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  // 3-second auto-dismiss for the inline save toast.
  useEffect(() => {
    if (!savedToast) return;
    const id = window.setTimeout(() => setSavedToast(null), 3000);
    return () => window.clearTimeout(id);
  }, [savedToast]);

  const initial = (channel.title ?? channel.handle ?? "?").slice(0, 1).toUpperCase();

  const cacheKey = `analyze_ai_${ANALYZE_CACHE_VERSION}.cache.${channel.channelId}`;

  const openAi = async () => {
    setAiError(null);
    setAiOpen(true);

    // Check client-side cache first. v2 cache holds {description} only;
    // older v1 entries (5-field shape) live under a different key and
    // are silently ignored.
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(cacheKey);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            at: number;
            proposal: { description: string };
          };
          if (
            Date.now() - parsed.at < ANALYZE_CACHE_TTL_MS &&
            typeof parsed.proposal?.description === "string"
          ) {
            setAiProposal(parsed.proposal);
            return;
          }
        }
      } catch {
        /* ignore */
      }
    }

    setAiLoading(true);
    try {
      const r = await fetch("/api/channel-info/analyze-with-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: channel.channelId }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        proposal?: { description: string };
        error?: string;
        retryAfterSec?: number;
      };
      if (!r.ok || !d.proposal?.description) {
        const detail = d.retryAfterSec
          ? `${d.error ?? "rate limited"} (try again in ${d.retryAfterSec}s)`
          : (d.error ?? `HTTP ${r.status}`);
        setAiError(detail);
        return;
      }
      setAiProposal(d.proposal);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            cacheKey,
            JSON.stringify({ at: Date.now(), proposal: d.proposal })
          );
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Analyze failed.");
    } finally {
      setAiLoading(false);
    }
  };

  const closeAi = () => {
    if (aiApplying) return;
    setAiOpen(false);
    setAiProposal(null);
    setAiError(null);
  };

  // Single Apply step: overwrite channel_description with the AI's draft.
  const acceptDescription = async () => {
    if (!aiProposal) return;
    setAiApplying(true);
    try {
      const r = await fetch("/api/channel-info", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: channel.channelId,
          field: "channelDescription",
          value: aiProposal.description,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        channel?: ChannelContext;
        error?: string;
      };
      if (!r.ok || !d.channel) {
        setAiError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      onUpdated(d.channel);
      setSavedToast("AI-drafted description applied.");
      setAiOpen(false);
      setAiProposal(null);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Apply failed.");
    } finally {
      setAiApplying(false);
    }
  };

  // Single-field save callback used by the editors. Refetches the row
  // server-side so derived state (e.g. analytics widget channel info)
  // stays in sync.
  const handleFieldSaved = useCallback(
    (field: "channelDescription" | "ideationRules" | "bannedTopics" | "redditSources", value: string) => {
      const next: ChannelContext = { ...channel, [field]: value };
      onUpdated(next);
      setSavedToast("Saved — the agent will use this on the next message.");
    },
    [channel, onUpdated]
  );

  return (
    <>
      <Card className="mb-4">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              {channel.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={channel.avatarUrl}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-full"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                  {initial}
                </div>
              )}
              <div className="min-w-0">
                <CardTitle className="text-lg">
                  {channel.title ?? channel.channelId}
                </CardTitle>
                <CardDescription>
                  {channel.handle ? (
                    <span className="font-mono">{channel.handle}</span>
                  ) : (
                    <span className="text-muted-foreground/70">No handle</span>
                  )}
                  {channel.subscriberCount !== null && (
                    <>
                      <span className="mx-2 text-muted-foreground/50">·</span>
                      <span>
                        {channel.subscriberCount.toLocaleString()} subscribers
                      </span>
                    </>
                  )}
                </CardDescription>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={openAi}
              disabled={aiLoading}
              className="shrink-0 gap-1.5"
            >
              {aiLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Analyze with AI
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {savedToast && (
            <div
              className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400"
              data-testid="channel-info-toast"
            >
              {savedToast}
            </div>
          )}
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Channel description</h3>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              One paragraph the agent reads before every job. Cover: what the channel is, who watches (age + region), what makes you different, voice + pacing. Plain words. The shorter the better — long fluff dilutes the agent&apos;s focus.
            </p>
            <DescriptionEditor
              channelId={channel.channelId}
              initialValue={channel.channelDescription}
              onSaved={(v) => handleFieldSaved("channelDescription", v)}
            />
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Banned topics</h3>
            </div>
            <BannedTopicsEditor
              channelId={channel.channelId}
              initialValue={channel.bannedTopics}
              onSaved={(v) => handleFieldSaved("bannedTopics", v)}
            />
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Ideation rules <span className="text-xs font-normal text-muted-foreground">(HARD)</span></h3>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              Non-negotiable rules the ideation agent must follow when composing titles. Injected verbatim into the compose prompt. One rule per line — voice constraints, banned shapes, format-bias overrides, anything you never want bent.
            </p>
            <IdeationRulesEditor
              channelId={channel.channelId}
              initialValue={channel.ideationRules}
              onSaved={(v) => handleFieldSaved("ideationRules", v)}
            />
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Reddit sources</h3>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              One subreddit per line. Auto and Reddit Angles use Brave Search to find dated web signals from these communities.
            </p>
            <RedditSourcesEditor
              channelId={channel.channelId}
              initialValue={channel.redditSources}
              onSaved={(v) => handleFieldSaved("redditSources", v)}
            />
          </div>
        </CardContent>
      </Card>

      <CurrentVideosPanel channelId={channel.channelId} />

      <SectionDivider label="Learned rules" />
      <div className="rounded-lg border border-border bg-card p-6">
        <p className="mb-4 text-xs text-muted-foreground">
          Rules the AI distilled from your notes on past ideas. Pending rows wait for you to Apply or Reject — nothing affects the next generation until you decide.
        </p>
        <LearnedRulesPanel channelId={channel.channelId} />
      </div>

      {aiOpen && (
        <AnalyzeModal
          current={channel}
          proposal={aiProposal}
          loading={aiLoading}
          applying={aiApplying}
          error={aiError}
          onClose={closeAi}
          onAccept={acceptDescription}
        />
      )}
    </>
  );
}

function CurrentVideosPanel({ channelId }: { channelId: string }) {
  const [videos, setVideos] = useState<ChannelVideo[] | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadVideos = useCallback(async () => {
    try {
      const r = await fetch("/api/channel-videos?limit=50", { cache: "no-store" });
      const d = (await r.json().catch(() => ({}))) as {
        videos?: ChannelVideo[];
        lastSyncAt?: string | null;
        error?: string;
      };
      if (!r.ok) {
        setError(d.error ?? `HTTP ${r.status}`);
        setVideos([]);
        return;
      }
      setVideos(d.videos ?? []);
      setLastSyncAt(d.lastSyncAt ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load videos.");
      setVideos([]);
    }
  }, []);

  useEffect(() => {
    void loadVideos();
  }, [channelId, loadVideos]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await fetch("/api/sync/user-videos", { method: "POST" });
      await loadVideos();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }, [loadVideos]);

  return (
    <>
      <SectionDivider label="Current videos" />
      <div className="mb-4 rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Current channel videos</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Synced public uploads used as your own-channel source material.
              {lastSyncAt ? ` Last synced ${formatDateTime(lastSyncAt)}.` : ""}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={refreshing}
            className="shrink-0 gap-1.5"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {videos === null ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[68px] animate-pulse rounded bg-muted/50" />
            ))}
          </div>
        ) : videos.length === 0 ? (
          <p className="rounded-md bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
            No videos synced yet. Use Refresh, or re-sync the channel from Integrations.
          </p>
        ) : (
          <ul className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {videos.map((video) => (
              <li key={video.id}>
                <a
                  href={`https://www.youtube.com/watch?v=${video.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex gap-3 rounded-md p-2 transition-colors hover:bg-muted/35"
                >
                  <YouTubeThumbnail
                    videoId={video.id}
                    src={video.thumbnail_url}
                    className="h-[56px] rounded"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                      {video.title}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {videoMeta(video).join(" · ")}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function compactCount(value: number | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
}

function formatPublishedAt(value: number | null): string | null {
  if (!value || value <= 0) return null;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value * 1000));
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function videoMeta(video: ChannelVideo): string[] {
  const parts: string[] = [];
  const views = compactCount(video.views);
  const comments = compactCount(video.comments);
  const date = formatPublishedAt(video.published_at);
  if (views) parts.push(`${views} views`);
  if (comments) parts.push(`${comments} comments`);
  if (date) parts.push(date);
  return parts.length ? parts : ["No public stats yet"];
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="mb-3 mt-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      <span>{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/* ---------------- AI proposal modal ---------------- */

function AnalyzeModal({
  current,
  proposal,
  loading,
  applying,
  error,
  onClose,
  onAccept,
}: {
  current: ChannelContext;
  proposal: { description: string } | null;
  loading: boolean;
  applying: boolean;
  error: string | null;
  onClose: () => void;
  onAccept: () => void;
}) {
  const currentDesc = current.channelDescription.trim();
  const proposedDesc = proposal?.description?.trim() ?? "";
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" />
                AI-drafted channel description
              </CardTitle>
              <CardDescription>
                Claude analyzed this channel&apos;s recent videos, comment
                signals, and (when connected) Studio demographics. One
                paragraph the agent will read before every job.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              disabled={applying}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {loading && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Analyzing recent videos and comments…
            </div>
          )}
          {!loading && proposal && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 max-h-[60vh] overflow-y-auto pr-1">
              <div>
                <div className="mb-1 text-[10px] uppercase text-muted-foreground">
                  Current
                </div>
                <div
                  className={
                    currentDesc.length === 0
                      ? "rounded bg-muted/30 p-2 text-xs italic text-muted-foreground"
                      : "rounded bg-muted/30 p-2 text-xs whitespace-pre-wrap"
                  }
                >
                  {currentDesc || "(empty — Apply will write the AI draft into this field)"}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase text-primary">
                  Proposed ({proposedDesc.length} chars)
                </div>
                <div className="rounded bg-primary/5 p-2 text-xs whitespace-pre-wrap">
                  {proposedDesc || (
                    <span className="italic text-muted-foreground">
                      (no proposal)
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={applying}
            >
              Reject
            </Button>
            <Button
              size="sm"
              onClick={onAccept}
              disabled={!proposal || applying || loading || proposedDesc.length === 0}
              className="gap-1.5"
            >
              {applying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              {applying ? "Applying…" : "Apply"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------- Empty / loading states ---------------- */

function SkeletonCard() {
  return (
    <Card>
      <CardHeader>
        <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-3 w-24 animate-pulse rounded bg-muted" />
      </CardHeader>
      <CardContent className="space-y-3">
        {[0, 1, 2, 3, 4].map((j) => (
          <div key={j} className="h-8 animate-pulse rounded bg-muted/60" />
        ))}
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-sm text-muted-foreground">
          No channels yet. Add your first YouTube channel on the{" "}
          <Link
            href="/settings/integrations"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Integrations page
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

function NoActiveChannelHint() {
  // Distinct from EmptyState: there ARE channels in the DB, but no active
  // pointer is set. Steer the user to the top-right picker; don't push
  // them back to /settings/integrations.
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-sm text-muted-foreground">
          Pick a channel from the top-right picker to view its context.
        </p>
      </CardContent>
    </Card>
  );
}
