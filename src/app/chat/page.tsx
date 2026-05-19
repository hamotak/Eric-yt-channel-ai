"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Plus,
  Send,
  Sparkles,
  Trash2,
  MessageSquare,
  Loader2,
  Wrench,
  Check,
  PlaySquare,
  Paperclip,
  ImagePlus,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Brain,
  MoreHorizontal,
  X,
} from "lucide-react";
import {
  DescriptionEditor,
  IdeationRulesEditor,
} from "@/components/agent-brain-editors";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import {
  AttachmentChip,
  ChatAttachmentPicker,
  type AttachmentRef,
} from "@/components/chat-attachment-picker";
import { ChannelSwitcher } from "@/components/channel-switcher";
import {
  DEFAULT_PROVIDER,
  PROVIDER_CHOICES,
  providerLabel,
  type ProviderChoice,
} from "@/lib/ai-provider-types";

type Session = {
  id: string;
  title: string | null;
  channel_id: string | null;
  created_at: number;
  last_message_at: number;
  message_count: number;
};

type ToolCall = {
  name: string;
  ok?: boolean;
  preview?: string;
};

type Message = {
  id: number | string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  toolCalls?: ToolCall[];
  attachments?: AttachmentRef[];
  // Anthropic extended-thinking text accumulated across the assistant
  // turn. Populated either from the SSE `thinking` event at end-of-
  // stream OR from the persisted column when the session is re-hydrated
  // on page load. Drives the "Show thinking" pill in MessageBubble.
  thinking?: string;
};

type IntegrationsStatus = Record<
  "claude" | "youtube" | "exa" | "apify" | "google_gemini",
  { hasKey: boolean } | undefined
>;

const PROVIDER_PREF_KEY = "yt-channel-ai:chat-provider";
const CHAT_MODE_KEY = "yt-channel-ai:chat-mode";

// T1 mode picker — three modes drive WHAT the agent does on the turn.
// See chat-tools.ts ChatMode for the full semantics; this UI just sets
// the body.mode field on POST /api/chat. Default is "ideate".
type ChatMode = "ideate" | "research" | "validate";
const CHAT_MODES: {
  key: ChatMode;
  emoji: string;
  label: string;
  description: string;
}[] = [
  {
    key: "ideate",
    emoji: "💡",
    label: "Ideate",
    description: "10 fresh ideas grounded in your outliers + own-channel winners.",
  },
  {
    key: "research",
    emoji: "🔬",
    label: "Research",
    description: "Deep dive — outlier WHY analysis + 10 ideas + web search when local data is thin.",
  },
  {
    key: "validate",
    emoji: "✓",
    label: "Validate",
    description: "Go/no-go check on a topic. No new ideas — cross-channel evidence + own-catalog status + verdict.",
  },
];

// Starter prompts shown above the input when a session is empty. Click
// fills the input; the user can edit before sending. Tuned for the new
// mode picker — first three map to Ideate/Research/Validate flows.
const STARTER_PROMPTS = [
  "Give me 5 video ideas from my current outliers",
  "Why did the top outlier in my niche perform so well?",
  "Validate this topic: voyager probes hitting interstellar weather",
  "What are my audience's top complaints about my last video?",
] as const;

/**
 * Top-level wrapper that satisfies Next 16's strict prerender requirement
 * for `useSearchParams()` consumers — the inner ChatPageInner uses it to
 * pick up the `?attachVideo=...` deeplink, and Next refuses to build
 * without a Suspense boundary above any `useSearchParams` call site.
 */
export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatPageInner />
    </Suspense>
  );
}

function ChatPageInner() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const [integrations, setIntegrations] = useState<IntegrationsStatus | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [untaggedSessions, setUntaggedSessions] = useState<Session[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [activeChannelTitle, setActiveChannelTitle] = useState<string | null>(null);
  const [showUntagged, setShowUntagged] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // T1 mode picker — drives WHICH tools and system prompt the agent
  // uses on each turn. Persisted in localStorage so the user's pick
  // survives reloads.
  const [activeMode, setActiveMode] = useState<ChatMode>("ideate");
  // T4 — Agent Brain panel. Right-side collapsible drawer rendering the
  // active channel's description + ideation rules + memory. localStorage
  // persists open/closed per device. The panel's content lifts directly
  // from /channel-info via the shared editors in components/agent-brain-editors.
  const [brainOpen, setBrainOpen] = useState(false);
  const [brainData, setBrainData] = useState<{
    channelDescription: string;
    ideationRules: string;
  } | null>(null);
  const [brainSaved, setBrainSaved] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Persist the user's last-used provider choice in localStorage so opening
  // a fresh tab tomorrow doesn't reset them back to Claude. Falls back to
  // DEFAULT_PROVIDER on first load. We intentionally don't pin per-session
  // — within an existing conversation switching providers mid-stream would
  // require re-converting history, which we sidestep by always sending the
  // current pick on each /api/chat call.
  const [provider, setProvider] = useState<ProviderChoice>(DEFAULT_PROVIDER);
  // Surface upload errors (file too big, unsupported type) to the user. Set
  // by the file input's onChange handler; cleared after 5 s or when the
  // user starts typing again.
  const [imageError, setImageError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  // True whenever the server reports this session has a chat turn in progress.
  // We use it to show a "generating…" placeholder even when the user navigates
  // away and comes back (the stream state in React is lost on unmount, but the
  // server keeps going and eventually writes the answer to the DB).
  const [sessionPending, setSessionPending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Hydrate the saved mode pick once on mount.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CHAT_MODE_KEY);
      if (saved === "ideate" || saved === "research" || saved === "validate") {
        setActiveMode(saved as ChatMode);
      }
    } catch {
      /* swallow */
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_MODE_KEY, activeMode);
    } catch {
      /* swallow */
    }
  }, [activeMode]);

  // Hydrate the saved provider pick once on mount. Wrapped in try/catch
  // because some Safari/private-mode sessions throw on localStorage access.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(PROVIDER_PREF_KEY);
      if (saved && (PROVIDER_CHOICES as string[]).includes(saved)) {
        setProvider(saved as ProviderChoice);
      }
    } catch {
      /* localStorage unavailable — stick with DEFAULT_PROVIDER */
    }
  }, []);

  // Hydrate Brain-panel open/closed state. Defaults closed so first-load
  // doesn't trip the layout out the gate.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("yt-channel-ai:chat-brain-open");
      if (saved === "1") setBrainOpen(true);
    } catch {
      /* swallow */
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "yt-channel-ai:chat-brain-open",
        brainOpen ? "1" : "0"
      );
    } catch {
      /* swallow */
    }
  }, [brainOpen]);

  // Auto-dismiss Brain save toast.
  useEffect(() => {
    if (!brainSaved) return;
    const id = window.setTimeout(() => setBrainSaved(null), 3000);
    return () => window.clearTimeout(id);
  }, [brainSaved]);

  // Refetch the active channel's description + ideation rules whenever
  // either (a) the panel opens, or (b) the active channel changes. Keeps
  // the Brain view in sync after the user switches channels via the
  // top-right picker without a full page reload.
  useEffect(() => {
    if (!brainOpen || !activeChannelId) return;
    let cancelled = false;
    fetch("/api/channel-info", { cache: "no-store" })
      .then((r) => r.json())
      .then(
        (d: {
          channels?: {
            channelId: string;
            channelDescription: string;
            ideationRules: string;
          }[];
        }) => {
          if (cancelled) return;
          const row = (d.channels ?? []).find(
            (c) => c.channelId === activeChannelId
          );
          if (row) {
            setBrainData({
              channelDescription: row.channelDescription ?? "",
              ideationRules: row.ideationRules ?? "",
            });
          }
        }
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [brainOpen, activeChannelId]);

  // Persist on change.
  useEffect(() => {
    try {
      window.localStorage.setItem(PROVIDER_PREF_KEY, provider);
    } catch {
      /* swallow — UX still works without persistence */
    }
  }, [provider]);

  // Auto-grow the composer textarea upward as the user types, clamped to a
  // max so the chat area doesn't get squeezed out. `auto` first so shrinking
  // after deletion works; scrollHeight then gives us the natural content height.
  const COMPOSER_MAX_PX = 240; // ~10 lines at current font/line-height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, COMPOSER_MAX_PX);
    el.style.height = `${next}px`;
  }, [input]);

  // Resolve the server-side active channel once so the sidebar can scope
  // its list. Falls back to "all sessions" if the channels endpoint
  // doesn't return an active id (no channel bound yet, fresh install).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/channels", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { activeId?: string | null; channels?: Array<{ id: string; title: string | null }> }) => {
        if (cancelled) return;
        setActiveChannelId(d.activeId ?? null);
        const match = d.channels?.find((c) => c.id === d.activeId);
        setActiveChannelTitle(match?.title ?? null);
      })
      .catch(() => {
        /* silent — sidebar will show all sessions */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshSessions = useCallback(async () => {
    // Two parallel fetches: active-channel sessions (the primary list)
    // and untagged sessions (legacy rows that pre-date the per-channel
    // migration). If no active channel is bound, fall back to "all".
    const scopedUrl = activeChannelId
      ? `/api/sessions?channelId=${encodeURIComponent(activeChannelId)}`
      : "/api/sessions";
    const [scoped, untagged] = await Promise.all([
      fetch(scopedUrl).then((r) => r.json()),
      activeChannelId
        ? fetch("/api/sessions?channelId=untagged").then((r) => r.json())
        : Promise.resolve({ sessions: [] }),
    ]);
    setSessions(scoped.sessions ?? []);
    setUntaggedSessions(untagged.sessions ?? []);
    return scoped.sessions as Session[];
  }, [activeChannelId]);

  const loadSession = useCallback(async (id: string) => {
    setActiveId(id);
    const res = await fetch(`/api/sessions/${id}`);
    const data = await res.json();
    setMessages(data.messages ?? []);
    setSessionPending(!!data.pending);
  }, []);

  useEffect(() => {
    fetch("/api/integrations")
      .then((r) => r.json())
      .then((d) => {
        const ints = d.integrations ?? null;
        setIntegrations(ints);
        // Auto-enable every tool group whose required integration is set up.
        // Tool exposure is now mode-driven (see ChatMode picker). The
        // server defaults all three legacy groups on and the mode
        // whitelist narrows from there — no per-group toggle state on
        // the client.
      })
      .catch(() => setIntegrations({} as IntegrationsStatus));
    refreshSessions();
  }, [refreshSessions]);

  // The chat needs a key for *whichever provider is currently selected*. Null
  // while integrations are still loading (so the composer stays disabled
  // briefly on first paint), boolean once we've heard back. Recomputes when
  // the user switches model in the header.
  const hasKey = useMemo<boolean | null>(() => {
    if (integrations === null) return null;
    if (provider === "claude") return !!integrations.claude?.hasKey;
    return !!integrations.google_gemini?.hasKey;
  }, [integrations, provider]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Poll the session endpoint while the server reports a turn is still in
  // progress AND this React instance isn't the one streaming it. Covers:
  //   - user sent a message, switched to /logs, came back → picks up result
  //   - user refreshed the browser mid-turn → sees "generating…" + result
  // Stops immediately once `pending: false` comes back from the server.
  useEffect(() => {
    if (!activeId || !sessionPending || sending) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/sessions/${activeId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (!data.pending) {
          // Turn finished on the server — pull in the fresh messages and stop.
          setMessages(data.messages ?? []);
          setSessionPending(false);
          refreshSessions();
        }
      } catch {
        /* transient network error — keep polling */
      }
    };
    const id = window.setInterval(tick, 3000);
    // Also fire once immediately so the user doesn't wait a full 3s on return.
    tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeId, sessionPending, sending, refreshSessions]);

  // Support ?attachVideo=<id> from the video detail page's "Ask Claude" button.
  // We resolve the video details once and auto-attach it, then clear the query param.
  useEffect(() => {
    const vid = searchParams?.get("attachVideo");
    if (!vid) return;
    (async () => {
      try {
        const res = await fetch(`/api/videos/${vid}`);
        if (!res.ok) return;
        const d = (await res.json()) as {
          video: { id: string; title: string; thumbnail_url: string | null };
        };
        setAttachments((prev) =>
          prev.some((a) => a.id === d.video.id)
            ? prev
            : [
                ...prev,
                {
                  type: "video",
                  id: d.video.id,
                  title: d.video.title,
                  thumbnail: d.video.thumbnail_url,
                },
              ]
        );
        // Strip the query param so a refresh doesn't re-trigger.
        const url = new URL(window.location.href);
        url.searchParams.delete("attachVideo");
        window.history.replaceState({}, "", url.toString());
      } catch {
        /* ignore */
      }
    })();
  }, [searchParams]);

  const newChat = useCallback(async () => {
    const res = await fetch("/api/sessions", { method: "POST" });
    const { id } = await res.json();
    setActiveId(id);
    setMessages([]);
    await refreshSessions();
  }, [refreshSessions]);

  const deleteSession = useCallback(
    async (id: string) => {
      await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      const updated = await refreshSessions();
      if (activeId === id) {
        if (updated.length > 0) {
          loadSession(updated[0].id);
        } else {
          setActiveId(null);
          setMessages([]);
        }
      }
    },
    [activeId, refreshSessions, loadSession]
  );

  // T3: workspace-level sidebar action — sweep every chat session with
  // no user messages. Confirmed via window.confirm because it's a
  // destructive batch op. Server scopes to the active channel by default
  // (so the user only nukes the chats they actually see).
  const clearEmptyChats = useCallback(async () => {
    if (!confirm("Delete every empty chat (sessions with no messages you've sent)?")) {
      return;
    }
    const r = await fetch("/api/sessions/clear-empty", { method: "POST" });
    const d = (await r.json().catch(() => ({}))) as { removed?: number };
    await refreshSessions();
    if (typeof d.removed === "number" && d.removed > 0) {
      // No toast component here; use the alert hop. Cheap; rarely fired.
      window.setTimeout(() => {
        alert(`Cleared ${d.removed} empty chat${d.removed === 1 ? "" : "s"}.`);
      }, 0);
    }
  }, [refreshSessions]);

  const send = useCallback(async () => {
    const content = input.trim();
    // Allow sending if there's either text or at least one attachment.
    if ((!content && attachments.length === 0) || sending || !hasKey) return;

    let sessionId = activeId;
    if (!sessionId) {
      const res = await fetch("/api/sessions", { method: "POST" });
      const { id } = await res.json();
      sessionId = id;
      setActiveId(id);
    }

    const sentAttachments = attachments;
    setInput("");
    setAttachments([]);
    setSending(true);

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content,
      attachments: sentAttachments,
    };
    const assistantMsg: Message = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: "",
      pending: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          content,
          mode: activeMode,
          attachments: sentAttachments.map((a) =>
            a.type === "image"
              ? { type: "image", data: a.data, mediaType: a.mediaType }
              : { type: a.type, id: a.id }
          ),
          provider,
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: `⚠️ ${err.error ?? "Request failed"}`,
                  pending: false,
                }
              : m
          )
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload) continue;
          try {
            const event = JSON.parse(payload) as
              | { type: "delta"; text: string }
              | { type: "tool_use"; name: string; input: unknown }
              | { type: "tool_result"; name: string; ok: boolean; preview: string }
              | { type: "reset_text" }
              | { type: "thinking"; text: string }
              | { type: "done" }
              | { type: "error"; message: string };

            if (event.type === "delta") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: m.content + event.text }
                    : m
                )
              );
            } else if (event.type === "thinking") {
              // End-of-turn signal carrying the accumulated thinking text.
              // The server sends this right before "done" so the pill
              // appears as soon as the final answer is on screen.
              const thinkingText = String(event.text ?? "");
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, thinking: thinkingText }
                    : m
                )
              );
            } else if (event.type === "reset_text") {
              // Server tells us: "everything streamed so far was narration
              // between tool calls — the forced-synthesis round is about to
              // emit the actual final answer. Wipe the visible bubble so
              // the user only sees the answer, not the thinking-out-loud."
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id ? { ...m, content: "" } : m
                )
              );
            } else if (event.type === "tool_use") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? {
                        ...m,
                        toolCalls: [
                          ...(m.toolCalls ?? []),
                          { name: event.name },
                        ],
                      }
                    : m
                )
              );
            } else if (event.type === "tool_result") {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantMsg.id) return m;
                  const calls = [...(m.toolCalls ?? [])];
                  // Mark last unmatched call with this name as done
                  for (let i = calls.length - 1; i >= 0; i--) {
                    if (calls[i].name === event.name && calls[i].ok === undefined) {
                      calls[i] = { ...calls[i], ok: event.ok, preview: event.preview };
                      break;
                    }
                  }
                  return { ...m, toolCalls: calls };
                })
              );
            } else if (event.type === "error") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: `⚠️ ${event.message}`, pending: false }
                    : m
                )
              );
            }
          } catch {
            /* ignore malformed line */
          }
        }
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsg.id ? { ...m, pending: false } : m))
      );
      refreshSessions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id ? { ...m, content: `⚠️ ${msg}`, pending: false } : m
        )
      );
    } finally {
      setSending(false);
    }
  }, [input, sending, hasKey, activeId, refreshSessions, activeMode, attachments, provider]);

  // Maximum bytes per uploaded image. 5 MB matches Anthropic's per-image
  // limit on the messages API (Gemini's is higher but enforcing the lower
  // bound keeps both providers happy). Reject anything larger before the
  // file even touches the wire.
  const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  const SUPPORTED_IMAGE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
  ]);

  const onPickImage = useCallback(async (file: File) => {
    if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
      setImageError(`Unsupported image type: ${file.type || "unknown"}. Use PNG, JPG, WebP, or GIF.`);
      window.setTimeout(() => setImageError(null), 5000);
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setImageError(
        `Image is ${(file.size / 1024 / 1024).toFixed(1)} MB — max is 5 MB. Resize first.`
      );
      window.setTimeout(() => setImageError(null), 5000);
      return;
    }
    // FileReader → DataURL → strip the `data:image/...;base64,` prefix.
    // We need the raw base64 because both Anthropic and Gemini SDKs want
    // it without the URI scheme wrapper.
    const dataUrl: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result ?? ""));
      r.onerror = () => reject(r.error ?? new Error("read failed"));
      r.readAsDataURL(file);
    });
    const commaAt = dataUrl.indexOf(",");
    const base64 = commaAt >= 0 ? dataUrl.slice(commaAt + 1) : "";
    if (!base64) {
      setImageError("Couldn't read the image file.");
      window.setTimeout(() => setImageError(null), 5000);
      return;
    }
    // The dataUrl itself is a perfectly fine `<img src="…">` thumbnail —
    // saves us creating + revoking object URLs on every attach.
    setAttachments((prev) => [
      ...prev,
      {
        type: "image",
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: file.name || "Image",
        thumbnail: dataUrl,
        data: base64,
        mediaType: file.type,
      },
    ]);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const activeTitle = useMemo(() => {
    const s = sessions.find((x) => x.id === activeId);
    return s?.title ?? "New chat";
  }, [activeId, sessions]);

  return (
    <div className="mx-auto flex h-[calc(100vh-5.5rem)] max-w-[1400px] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Sessions sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-1.5 p-3">
          <Button onClick={newChat} className="flex-1 justify-start gap-2" size="sm">
            <Plus className="h-4 w-4" />
            {t.chat.newChat}
          </Button>
          <button
            type="button"
            onClick={() => void clearEmptyChats()}
            title="Clear empty chats (sessions with no user messages)"
            aria-label="Clear empty chats"
            className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {/* Active-channel hint — clarifies the sidebar is scoped. Only
              renders when there IS an active channel; on fresh installs
              the sidebar shows everything and this label would lie. */}
          {activeChannelId && (
            <div
              className="px-3 pb-1 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground"
              data-testid="chat-sidebar-channel-label"
            >
              {activeChannelTitle ?? "Active channel"}
            </div>
          )}
          {sessions.length === 0 && untaggedSessions.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t.chat.noSessions}
            </div>
          ) : (
            <>
              {sessions.length > 0 ? (
                <SessionBuckets
                  sessions={sessions}
                  activeId={activeId}
                  onSelect={loadSession}
                  onDelete={(id) => {
                    if (confirm(t.chat.deleteConfirm)) deleteSession(id);
                  }}
                  untitledLabel={t.chat.untitled}
                />
              ) : (
                activeChannelId && (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No chats yet for this channel.
                  </div>
                )
              )}
              {/* Untagged: pre-migration chats. Collapsed by default once
                  there are more than 5 so they don't clutter day-to-day. */}
              {untaggedSessions.length > 0 && (
                <UntaggedSection
                  sessions={untaggedSessions}
                  activeId={activeId}
                  onSelect={loadSession}
                  onDelete={(id) => {
                    if (confirm(t.chat.deleteConfirm)) deleteSession(id);
                  }}
                  untitledLabel={t.chat.untitled}
                  defaultOpen={showUntagged}
                  onToggle={() => setShowUntagged((v) => !v)}
                />
              )}
            </>
          )}
        </div>
      </aside>

      {/* Main chat */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{activeTitle}</div>
          </div>
          {/*
            AI model selector. Per-user preference (localStorage) — applies to
            new turns immediately so the user can pivot Claude ↔ Gemini between
            messages in the same chat. Gemini options are disabled until a
            Gemini API key is saved in /integrations; we show "(no key)" so the
            disabled state isn't a mystery.
          */}
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderChoice)}
            disabled={sending}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            aria-label="AI model"
          >
            {PROVIDER_CHOICES.map((p) => {
              const requiresGemini = p !== "claude";
              const hasProviderKey = requiresGemini
                ? !!integrations?.google_gemini?.hasKey
                : !!integrations?.claude?.hasKey;
              return (
                <option key={p} value={p} disabled={!hasProviderKey}>
                  {providerLabel(p)}
                  {!hasProviderKey ? " (no key)" : ""}
                </option>
              );
            })}
          </select>
          {/*
            Inline channel picker so the user can pivot between channels without
            leaving the chat — previously they had to navigate to the dashboard,
            switch there, and come back. The component hides itself if there's
            only zero or one channel, so single-channel users see no clutter.
          */}
          <ChannelSwitcher />
          <button
            type="button"
            onClick={() => setBrainOpen((v) => !v)}
            aria-label="Toggle Agent Brain panel"
            title="Agent Brain — channel description, ideation rules, memory"
            data-testid="chat-brain-toggle"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
              brainOpen
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <Brain className="h-3.5 w-3.5" />
            Brain
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!activeId && messages.length === 0 ? (
            <EmptyState hasKey={hasKey} />
          ) : (
            <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {/*
                Reconnected-pending placeholder. Shown only when the server
                still has a turn in flight and THIS React instance isn't the
                one streaming it (`sending` would be true for the live path,
                and the live path already appends a pending bubble itself).
                Reason: user navigated away / refreshed — the stream state
                in React was lost, but the turn is still generating.
              */}
              {sessionPending &&
                !sending &&
                (messages.length === 0 ||
                  messages[messages.length - 1].role !== "assistant") && (
                  <ReconnectedPendingBubble />
                )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="border-t border-border bg-background p-3">
          <div className="relative mx-auto max-w-3xl">
            {/* Starter prompt chips — visible only when the current
                conversation is empty AND the user has a working setup.
                Clicking a chip places its text into the input but does
                NOT auto-send, so the user can edit before firing. */}
            {messages.length === 0 && activeId && hasKey && !sending && (
              <div className="mb-3 flex flex-wrap gap-2">
                {STARTER_PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setInput(p);
                      textareaRef.current?.focus();
                    }}
                    className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
            {/* T1: Mode picker — three pill buttons pinned above the
                composer. Active mode persists in localStorage. The
                selected mode determines which tools the agent sees +
                which system-prompt block injects on each turn. */}
            <div
              className="mb-2 flex items-center gap-2"
              data-testid="chat-mode-picker"
            >
              {CHAT_MODES.map((m) => {
                const active = activeMode === m.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setActiveMode(m.key)}
                    title={m.description}
                    aria-pressed={active}
                    data-mode={m.key}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    <span>{m.emoji}</span>
                    <span>{m.label}</span>
                  </button>
                );
              })}
              <span className="ml-2 text-[10px] text-muted-foreground">
                Mode determines what tools and context the agent uses.
              </span>
            </div>

            {imageError && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                {imageError}
              </div>
            )}
            <div className="flex flex-col gap-1.5 rounded-xl border border-input bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
              {attachments.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 px-1">
                  {attachments.map((a) => (
                    <AttachmentChip
                      key={a.id}
                      attachment={a}
                      onRemove={() =>
                        setAttachments((prev) => prev.filter((x) => x.id !== a.id))
                      }
                    />
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <Button
                  type="button"
                  size="icon"
                  variant={attachments.length > 0 ? "default" : "ghost"}
                  className="h-8 w-8 shrink-0 relative"
                  onClick={() => setPickerOpen(true)}
                  aria-label={t.chat.attach}
                  title={t.chat.attach}
                >
                  <Paperclip className="h-4 w-4" />
                  {attachments.length > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                      {attachments.length}
                    </span>
                  )}
                </Button>
                {/*
                  Inline image upload. Hidden <input type=file> driven by a
                  visible button so we can style it consistently with the
                  other composer controls. Multi-file is allowed; images
                  flow through the same `attachments` state as videos and
                  comments — the difference is they ship the base64 payload
                  rather than a DB id and are not persisted across reloads.
                */}
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = e.target.files;
                    if (!files) return;
                    Array.from(files).forEach((f) => onPickImage(f));
                    // Reset so picking the same file twice in a row still fires.
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  onClick={() => imageInputRef.current?.click()}
                  aria-label="Attach image"
                  title="Attach image (PNG/JPG/WebP/GIF, ≤5 MB)"
                >
                  <ImagePlus className="h-4 w-4" />
                </Button>
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={hasKey ? t.chat.placeholder : t.chat.missingKey}
                  disabled={!hasKey || sending}
                  rows={1}
                  className="min-h-[36px] max-h-[240px] resize-none overflow-y-auto border-0 bg-transparent px-1 py-1.5 shadow-none focus-visible:ring-0"
                />
                <Button
                  type="button"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={send}
                  disabled={!hasKey || (!input.trim() && attachments.length === 0) || sending}
                  aria-label="Send"
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            <ChatAttachmentPicker
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              onPick={(ref) => {
                setAttachments((prev) =>
                  prev.some((a) => a.id === ref.id) ? prev : [...prev, ref]
                );
              }}
              alreadyAttachedIds={new Set(attachments.map((a) => a.id))}
            />
            {!hasKey && (
              <p className="mt-2 text-center text-xs text-muted-foreground">
                <Link href="/settings/integrations" className="underline hover:text-foreground">
                  {t.banner.connectCta}
                </Link>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* T4: Agent Brain panel (right side, collapsible). Renders when
          the toggle is on AND there's an active channel — without a
          channel the editors have no scope to write to. The aside hides
          on <lg viewport to keep mobile layouts sane. */}
      {brainOpen && activeChannelId && (
        <aside
          className="hidden w-80 shrink-0 flex-col border-l border-border lg:flex"
          data-testid="chat-brain-panel"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Brain className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Agent Brain</span>
            </div>
            <button
              type="button"
              onClick={() => setBrainOpen(false)}
              aria-label="Close Brain panel"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
            {brainSaved && (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                {brainSaved}
              </div>
            )}
            {brainData === null ? (
              <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading channel context…
              </div>
            ) : (
              <>
                <div>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Description
                  </div>
                  <DescriptionEditor
                    channelId={activeChannelId}
                    initialValue={brainData.channelDescription}
                    variant="preview"
                    onSaved={(v) => {
                      setBrainData((prev) =>
                        prev ? { ...prev, channelDescription: v } : prev
                      );
                      setBrainSaved("Saved · agent will use this on next message.");
                    }}
                  />
                </div>
                <div>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Ideation rules (HARD)
                  </div>
                  <IdeationRulesEditor
                    channelId={activeChannelId}
                    initialValue={brainData.ideationRules}
                    onSaved={(v) => {
                      setBrainData((prev) =>
                        prev ? { ...prev, ideationRules: v } : prev
                      );
                      setBrainSaved("Saved · agent will use this on next message.");
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

/** Truncate a chat title for sidebar display. Full title surfaces via title attr. */
function truncateTitle(s: string | null | undefined, fallback: string): string {
  const v = (s ?? "").trim();
  if (!v) return fallback;
  return v.length > 30 ? `${v.slice(0, 30).trimEnd()}…` : v;
}

/**
 * T3: Date buckets for sidebar sessions. Today / This week / Older — with
 * "Older" collapsible (default closed once it has anything). Within each
 * bucket, sessions stay in their original (server-sorted by created_at
 * DESC) order so the active one floats to the top.
 */
function SessionBuckets({
  sessions,
  activeId,
  onSelect,
  onDelete,
  untitledLabel,
}: {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  untitledLabel: string;
}) {
  const [olderOpen, setOlderOpen] = useState(false);
  const nowSec = Math.floor(Date.now() / 1000);
  const todayCutoff = nowSec - 24 * 3600;
  const weekCutoff = nowSec - 7 * 24 * 3600;
  const today: Session[] = [];
  const week: Session[] = [];
  const older: Session[] = [];
  for (const s of sessions) {
    if (s.created_at >= todayCutoff) today.push(s);
    else if (s.created_at >= weekCutoff) week.push(s);
    else older.push(s);
  }
  return (
    <div data-testid="chat-sidebar-sessions">
      {today.length > 0 && (
        <SessionGroup
          label="Today"
          sessions={today}
          activeId={activeId}
          onSelect={onSelect}
          onDelete={onDelete}
          untitledLabel={untitledLabel}
        />
      )}
      {week.length > 0 && (
        <SessionGroup
          label="This week"
          sessions={week}
          activeId={activeId}
          onSelect={onSelect}
          onDelete={onDelete}
          untitledLabel={untitledLabel}
        />
      )}
      {older.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOlderOpen((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            <span>Older ({older.length})</span>
            <span>{olderOpen ? "−" : "+"}</span>
          </button>
          {olderOpen && (
            <SessionGroup
              label={null}
              sessions={older}
              activeId={activeId}
              onSelect={onSelect}
              onDelete={onDelete}
              untitledLabel={untitledLabel}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SessionGroup({
  label,
  sessions,
  activeId,
  onSelect,
  onDelete,
  untitledLabel,
}: {
  label: string | null;
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  untitledLabel: string;
}) {
  return (
    <div className="mt-1">
      {label && (
        <div className="px-3 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
      )}
      <ul className="space-y-0.5">
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={activeId === s.id}
            onSelect={() => onSelect(s.id)}
            onDelete={() => onDelete(s.id)}
            untitledLabel={untitledLabel}
          />
        ))}
      </ul>
    </div>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onDelete,
  untitledLabel,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  untitledLabel: string;
}) {
  const full = (session.title ?? "").trim() || untitledLabel;
  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent/60 text-foreground/80"
        )}
      >
        <button
          onClick={onSelect}
          title={full}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{truncateTitle(session.title, untitledLabel)}</span>
        </button>
        <button
          onClick={onDelete}
          className="opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
          aria-label="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

function UntaggedSection({
  sessions,
  activeId,
  onSelect,
  onDelete,
  untitledLabel,
  defaultOpen,
  onToggle,
}: {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  untitledLabel: string;
  defaultOpen: boolean;
  onToggle: () => void;
}) {
  // Spec: collapsed by default when more than 5 entries. defaultOpen
  // here is the parent's persistent flag; we honor it but layer the
  // "auto-collapse when large" rule on top so first-load doesn't drown
  // the sidebar.
  const autoCollapsed = sessions.length > 5;
  const open = autoCollapsed ? defaultOpen : true;
  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <span>Untagged ({sessions.length})</span>
        {autoCollapsed && <span>{open ? "−" : "+"}</span>}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={activeId === s.id}
              onSelect={() => onSelect(s.id)}
              onDelete={() => onDelete(s.id)}
              untitledLabel={untitledLabel}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState({ hasKey }: { hasKey: boolean | null }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="h-5 w-5" />
      </div>
      {hasKey === false ? (
        <>
          <div className="text-sm text-muted-foreground">{t.chat.missingKey}</div>
          <Link href="/settings/integrations">
            <Button size="sm">{t.banner.connectCta}</Button>
          </Link>
        </>
      ) : (
        <div className="max-w-md text-sm text-muted-foreground">{t.chat.emptyHint}</div>
      )}
    </div>
  );
}

function ReconnectedPendingBubble() {
  const { t } = useI18n();
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[85%] items-center gap-3 rounded-2xl border border-dashed border-border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <div className="space-y-0.5">
          <div className="font-medium">{t.chat.reconnectedPendingTitle}</div>
          <div className="text-xs">{t.chat.reconnectedPendingHint}</div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        )}
      >
        {isUser ? (
          <div className="space-y-1.5">
            {message.attachments && message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {message.attachments.map((a) => (
                  <span
                    key={a.id}
                    className="inline-flex max-w-[220px] items-center gap-1 rounded-full bg-primary-foreground/20 py-0.5 pl-0.5 pr-2 text-[11px]"
                  >
                    {a.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.thumbnail}
                        alt=""
                        className="h-4 w-6 rounded-sm object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <PlaySquare className="h-3 w-3" />
                    )}
                    <span className="truncate">{a.title}</span>
                  </span>
                ))}
              </div>
            )}
            {message.content && <div className="whitespace-pre-wrap">{message.content}</div>}
          </div>
        ) : (
          <>
            {message.thinking && message.thinking.length > 0 && (
              <ThinkingPill text={message.thinking} />
            )}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="mb-2 space-y-1">
                {message.toolCalls.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-md border border-border/50 bg-background/50 px-2 py-1 text-xs"
                  >
                    {c.ok === undefined ? (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                    ) : c.ok ? (
                      <Check className="h-3 w-3 shrink-0 text-green-600 dark:text-green-400" />
                    ) : (
                      <Wrench className="h-3 w-3 shrink-0 text-destructive" />
                    )}
                    <span className="font-mono text-[11px]">{c.name}</span>
                    {c.preview && (
                      <span className="truncate text-muted-foreground">
                        {c.preview}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <MarkdownBody content={message.content} pending={!!message.pending} />
          </>
        )}
      </div>
    </div>
  );
}

function MarkdownBody({ content, pending }: { content: string; pending: boolean }) {
  if (!content && pending) {
    return (
      <span className="inline-flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="text-xs">…</span>
      </span>
    );
  }
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:bg-background [&_pre]:text-foreground [&_code]:text-xs">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

/**
 * Collapsed pill above an assistant message that surfaces the model's
 * extended-thinking trace. Click to expand inline; click again to hide.
 *
 * Token count is an estimate (≈ chars/4) because Anthropic's usage
 * stats lump thinking into output_tokens without a separate breakout.
 * The tilde in the label signals approximation.
 */
function ThinkingPill({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const tokens = Math.ceil(text.length / 4);
  return (
    <div className="mb-2" data-testid="thinking-pill">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Brain className="h-3 w-3" />
        {open ? "Hide thinking" : "Show thinking"}
        <span className="text-muted-foreground/60">
          · ~{tokens.toLocaleString()} tokens
        </span>
      </button>
      {open && (
        <div
          className="mt-2 max-h-[420px] overflow-y-auto rounded-md border border-border/40 bg-background/40 p-3 text-[11px] italic leading-relaxed text-muted-foreground/90 whitespace-pre-wrap"
          data-testid="thinking-pill-content"
        >
          {text}
        </div>
      )}
    </div>
  );
}
