"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Pencil, Sparkles, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChannelAudience } from "@/components/channel-audience";
import { ChannelRevenue } from "@/components/channel-revenue";
import {
  AboutCard,
  ChannelDetailAnalytics,
  MetaCard,
  ThemesCard,
  TranscriptsCoverageCard,
} from "@/components/channel-detail-widgets";

type FieldKey =
  | "niche"
  | "positioning"
  | "audience"
  | "voice"
  | "externalSources";

type ChannelContext = {
  id: string;
  channelId: string;
  title: string | null;
  handle: string | null;
  subscriberCount: number | null;
  niche: string;
  positioning: string;
  audience: string;
  voice: string;
  externalSources: string;
};

type FieldDef = {
  key: FieldKey;
  label: string;
  description: string;
  placeholder: string;
  multiline: boolean;
};

const FIELDS: FieldDef[] = [
  {
    key: "niche",
    label: "Niche",
    description: "One line — what this channel is about, in 5–15 words.",
    placeholder:
      "e.g. Cinematic sleep stories about the cosmos and deep space.",
    multiline: false,
  },
  {
    key: "positioning",
    label: "Positioning",
    description:
      "What makes this channel different from competitors in the same niche.",
    placeholder:
      "e.g. Slow narration, no music spikes, all original astronomy facts.",
    multiline: true,
  },
  {
    key: "audience",
    label: "Audience",
    description: "Who watches this channel and why.",
    placeholder:
      "e.g. Insomniacs aged 25–45 who like science. Want to learn while drifting off.",
    multiline: true,
  },
  {
    key: "voice",
    label: "Voice",
    description: "Tone, pacing, signature stylistic elements.",
    placeholder:
      "e.g. Calm, measured, no hype words, no emojis, no AI-cliché phrases.",
    multiline: true,
  },
  {
    key: "externalSources",
    label: "External sources",
    description:
      "Off-YouTube sources the AI should reference during ideation. One per line.",
    placeholder:
      "r/Space\nr/AskAstronomy\nNASA mission archives\nScientific American",
    multiline: true,
  },
];

const ANALYZE_CACHE_TTL_MS = 5 * 60 * 1000;
const VIEW_MODE_KEY = "dashboard.viewMode";

function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000)
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

export default function ChannelInfoPage() {
  // useSearchParams needs Suspense in Next 16's strict prerender. The
  // inner component does all the work; this thin outer is just the
  // boundary, mirroring /chat/page.tsx's wrapper pattern.
  return (
    <Suspense fallback={null}>
      <ChannelInfoInner />
    </Suspense>
  );
}

function ChannelInfoInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusParam = searchParams.get("focus");

  const [channels, setChannels] = useState<ChannelContext[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"all" | "channel">("channel");
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);

  // Read view mode from localStorage (set by the top-right channel
  // picker — Prompt 4.6 contract). ?focus=<id> overrides for one page
  // load; the param is intentionally not persisted to localStorage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(VIEW_MODE_KEY);
    if (saved === "all" || saved === "channel") setViewMode(saved);
  }, []);

  // The server-side active-channel pointer lets us decide which row to
  // render in single-channel mode (when there's no ?focus override).
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

  // Decide which channel(s) to show. ?focus wins; otherwise viewMode.
  const focusChannel = useMemo(() => {
    if (!channels) return null;
    if (focusParam) return channels.find((c) => c.channelId === focusParam) ?? null;
    if (viewMode === "all") return null;
    return channels.find((c) => c.channelId === activeChannelId) ?? channels[0] ?? null;
  }, [channels, focusParam, viewMode, activeChannelId]);

  const showSummaryTable =
    !focusParam && viewMode === "all" && (channels?.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Channel Info</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Channel context. Every AI feature reads from this.
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
      ) : showSummaryTable ? (
        <SummaryTable
          channels={channels}
          onRowClick={(id) => router.push(`/channel-info?focus=${encodeURIComponent(id)}`)}
        />
      ) : focusChannel ? (
        <SingleChannelCard
          channel={focusChannel}
          onUpdated={handleUpdated}
          backToAll={
            focusParam && viewMode === "all"
              ? () => router.push("/channel-info")
              : undefined
          }
        />
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

/* ---------------- Single-channel card ---------------- */

function SingleChannelCard({
  channel,
  onUpdated,
  backToAll,
}: {
  channel: ChannelContext;
  onUpdated: (next: ChannelContext) => void;
  backToAll?: () => void;
}) {
  const [analytics, setAnalytics] = useState<ChannelDetailAnalytics | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiProposal, setAiProposal] = useState<Record<FieldKey, string> | null>(
    null
  );
  const [aiApplying, setAiApplying] = useState(false);

  // Load /api/channel to populate the detail widgets (themes, transcripts
  // coverage, about, meta). The endpoint reads the active channel; we
  // accept whatever it returns for now. In a follow-up the API could
  // accept ?channelId= to scope explicitly.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/channel", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setAnalytics(d.analytics ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [channel.channelId]);

  const detailChannel = {
    id: channel.channelId,
    title: channel.title,
    handle: channel.handle,
    description: null, // /api/channel-info doesn't include description today
    imported_at: 0,
  };

  const initial = (channel.title ?? channel.handle ?? "?").slice(0, 1).toUpperCase();

  const cacheKey = `analyze_ai.cache.${channel.channelId}`;

  const openAi = async () => {
    setAiError(null);
    setAiOpen(true);

    // Check client-side cache first.
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(cacheKey);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            at: number;
            proposal: Record<FieldKey, string>;
          };
          if (Date.now() - parsed.at < ANALYZE_CACHE_TTL_MS) {
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
        proposal?: Record<FieldKey, string>;
        error?: string;
        retryAfterSec?: number;
      };
      if (!r.ok || !d.proposal) {
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

  const acceptAll = async () => {
    if (!aiProposal) return;
    setAiApplying(true);
    let lastUpdated: ChannelContext | null = null;
    try {
      for (const field of FIELDS) {
        const proposed = aiProposal[field.key];
        if (proposed === undefined || proposed === channel[field.key]) continue;
        const r = await fetch("/api/channel-info", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channelId: channel.channelId,
            field: field.key,
            value: proposed,
          }),
        });
        const d = (await r.json().catch(() => ({}))) as {
          channel?: ChannelContext;
        };
        if (d.channel) lastUpdated = d.channel;
      }
      if (lastUpdated) onUpdated(lastUpdated);
      setAiOpen(false);
      setAiProposal(null);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Apply failed.");
    } finally {
      setAiApplying(false);
    }
  };

  return (
    <>
      {backToAll && (
        <button
          type="button"
          onClick={backToAll}
          className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to all channels
        </button>
      )}

      <Card className="mb-4">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                {initial}
              </div>
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
        <CardContent className="space-y-5">
          <SectionDivider label="Channel context" />
          {FIELDS.map((field) => (
            <ContextField
              key={field.key}
              channelId={channel.channelId}
              field={field}
              value={channel[field.key]}
              onUpdated={onUpdated}
            />
          ))}
        </CardContent>
      </Card>

      <SectionDivider label="Channel details" />
      <AboutCard channel={detailChannel} />
      <MetaCard channel={detailChannel} />
      <ChannelAudience />
      <ChannelRevenue />
      {analytics && <ThemesCard analytics={analytics} />}
      {analytics && <TranscriptsCoverageCard analytics={analytics} />}

      {aiOpen && (
        <AnalyzeModal
          current={channel}
          proposal={aiProposal}
          loading={aiLoading}
          applying={aiApplying}
          error={aiError}
          onClose={closeAi}
          onAccept={acceptAll}
        />
      )}
    </>
  );
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="mb-3 mt-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      <span>{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/* ---------------- Context field with inline edit ---------------- */

function ContextField({
  channelId,
  field,
  value,
  onUpdated,
}: {
  channelId: string;
  field: FieldDef;
  value: string;
  onUpdated: (next: ChannelContext) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const startEdit = () => {
    setDraft(value);
    setSaveError(null);
    setEditing(true);
  };

  const cancel = () => {
    if (saving) return;
    setEditing(false);
    setSaveError(null);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch("/api/channel-info", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, field: field.key, value: draft }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        channel?: ChannelContext;
        error?: string;
      };
      if (!r.ok || !d.channel) {
        setSaveError(d.error ?? "Save failed.");
        return;
      }
      onUpdated(d.channel);
      setEditing(false);
    } catch {
      setSaveError("Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{field.label}</div>
          <div className="text-xs text-muted-foreground">{field.description}</div>
        </div>
        {!editing && (
          <Button
            variant="ghost"
            size="icon"
            onClick={startEdit}
            aria-label={`Edit ${field.label}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            placeholder={field.placeholder}
            rows={field.key === "externalSources" ? 6 : field.multiline ? 4 : 2}
            className={cn(
              "w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
              "focus:outline-none focus:ring-2 focus:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          />
          {saveError && (
            <div className="text-xs text-destructive">{saveError}</div>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              <Check className="mr-1 h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={cancel}
              disabled={saving}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <ReadValue value={value} field={field} />
      )}
    </div>
  );
}

function ReadValue({ value, field }: { value: string; field: FieldDef }) {
  if (value.length === 0) {
    return (
      <div className="text-sm italic text-muted-foreground/70">
        Empty — click the pencil to add.
      </div>
    );
  }
  if (field.key === "externalSources") {
    const lines = value.split("\n").filter((l) => l.trim().length > 0);
    return (
      <ul className="space-y-1 text-sm">
        {lines.map((line, i) => (
          <li key={i} className="font-mono text-xs text-foreground/90">
            {line}
          </li>
        ))}
      </ul>
    );
  }
  return <div className="whitespace-pre-wrap text-sm">{value}</div>;
}

/* ---------------- Summary table (all-channels mode) ---------------- */

function SummaryTable({
  channels,
  onRowClick,
}: {
  channels: ChannelContext[];
  onRowClick: (channelId: string) => void;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30">
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium w-10"></th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Handle</th>
                <th className="px-3 py-2 font-medium">Subs</th>
                <th className="px-3 py-2 font-medium">Niche</th>
                <th className="px-3 py-2 font-medium">Positioning</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {channels.map((c) => {
                const filled =
                  c.niche.length > 0 &&
                  c.positioning.length > 0 &&
                  c.audience.length > 0 &&
                  c.voice.length > 0 &&
                  c.externalSources.length > 0;
                const initial = (c.title ?? c.handle ?? "?")
                  .slice(0, 1)
                  .toUpperCase();
                return (
                  <tr
                    key={c.channelId}
                    onClick={() => onRowClick(c.channelId)}
                    className="cursor-pointer transition-colors hover:bg-accent/40"
                  >
                    <td className="px-3 py-2 align-middle">
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                        {initial}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-middle font-medium">
                      {c.title ?? "(no title)"}
                    </td>
                    <td className="px-3 py-2 align-middle font-mono text-xs text-muted-foreground">
                      {c.handle ?? "—"}
                    </td>
                    <td className="px-3 py-2 align-middle tabular-nums">
                      {fmtCount(c.subscriberCount)}
                    </td>
                    <td
                      className="max-w-[180px] truncate px-3 py-2 align-middle text-xs text-muted-foreground"
                      title={c.niche}
                    >
                      {c.niche || <span className="italic">—</span>}
                    </td>
                    <td
                      className="max-w-[220px] truncate px-3 py-2 align-middle text-xs text-muted-foreground"
                      title={c.positioning}
                    >
                      {c.positioning || <span className="italic">—</span>}
                    </td>
                    <td className="px-3 py-2 align-middle">
                      {filled ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                          Context filled
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                          Needs context
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
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
  proposal: Record<FieldKey, string> | null;
  loading: boolean;
  applying: boolean;
  error: string | null;
  onClose: () => void;
  onAccept: () => void;
}) {
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
                AI proposal — channel context
              </CardTitle>
              <CardDescription>
                Claude analyzed this channel&apos;s recent videos +
                transcripts. Review each field before accepting.
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
              Analyzing recent videos and transcripts…
            </div>
          )}
          {!loading && proposal && (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              {FIELDS.map((field) => {
                const cur = current[field.key];
                const next = proposal[field.key] ?? "";
                return (
                  <div
                    key={field.key}
                    className="rounded-md border border-border/60 p-3"
                  >
                    <div className="mb-1 text-xs font-medium">{field.label}</div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div>
                        <div className="mb-1 text-[10px] uppercase text-muted-foreground">
                          Current
                        </div>
                        <div
                          className={cn(
                            "whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs",
                            cur.length === 0 && "italic text-muted-foreground"
                          )}
                        >
                          {cur || "Empty"}
                        </div>
                      </div>
                      <div>
                        <div className="mb-1 text-[10px] uppercase text-primary">
                          Proposed
                        </div>
                        <div className="whitespace-pre-wrap rounded bg-primary/5 p-2 text-xs">
                          {next || (
                            <span className="italic text-muted-foreground">
                              (no proposal)
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
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
              disabled={!proposal || applying || loading}
              className="gap-1.5"
            >
              {applying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              {applying ? "Applying…" : "Accept all"}
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
