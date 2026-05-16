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
  Globe,
  Bot,
  BarChart3,
  TrendingUp,
  Paperclip,
  Activity,
  ImagePlus,
  AlertCircle,
} from "lucide-react";
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
};

type ToolGroup = "youtube" | "analytics" | "research" | "exa" | "apify" | "yt_analytics" | "strategy";
type IntegrationsStatus = Record<
  "claude" | "youtube" | "exa" | "apify" | "google_gemini",
  { hasKey: boolean } | undefined
>;

const PROVIDER_PREF_KEY = "yt-channel-ai:chat-provider";

const TOOL_DEFS: {
  key: ToolGroup;
  label: string;
  description: string;
  requires: "youtube" | "exa" | "apify" | null;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    key: "youtube",
    label: "YouTube (my channel)",
    description:
      "Local DB about your channel — videos, transcripts, comments. Use for questions about your own catalog.",
    requires: "youtube",
    icon: PlaySquare,
  },
  {
    key: "analytics",
    label: "Analytics & SQL",
    description:
      "Custom SQL over your local data + niche explorer (top channels and outlier videos in any niche). For deeper data work.",
    requires: "youtube",
    icon: BarChart3,
  },
  // YT Analytics needs Google OAuth, not the YouTube Data API key. We let
  // the user enable it regardless — the tool itself returns a clear "not
  // connected" error if OAuth is missing, which is more discoverable than
  // hiding the toggle.
  {
    key: "yt_analytics",
    label: "YouTube Analytics (OAuth)",
    description:
      "Live Studio-grade data: views/watch time over time, retention curves, traffic sources, demographics, revenue. Needs Google OAuth.",
    requires: null,
    icon: Activity,
  },
  {
    key: "research",
    label: "Trends & Suggest",
    description:
      "YouTube autocomplete (what people actually search for) — useful for keyword research and content ideas.",
    requires: null,
    icon: TrendingUp,
  },
  {
    key: "exa",
    label: "Exa (web search)",
    description:
      "Semantic web search outside YouTube — articles, news, industry context, anything Claude needs to know about the world.",
    requires: "exa",
    icon: Globe,
  },
  {
    key: "strategy",
    label: "Strategy (this app's analyses)",
    description:
      "Read-only access to your tracked competitors, outlier alerts, and AI Comment Analysis on your own videos. Use for 'what should I make next', 'what are competitors doing I'm not', 'what does my audience actually want'.",
    requires: null,
    icon: Sparkles,
  },
  {
    key: "apify",
    label: "Apify (scrapers)",
    description:
      "Scrape competitor YouTube channels — videos, transcripts, stats. Use when you need data about creators not in your DB.",
    requires: "apify",
    icon: Bot,
  },
];

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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showToolMenu, setShowToolMenu] = useState(false);
  const [activeTools, setActiveTools] = useState<Set<ToolGroup>>(new Set());
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
  // Refs used by the click-outside handler for the tool menu. The toggle
  // button has its own ref so a click on it isn't treated as "outside" —
  // otherwise the same click would close+reopen the menu instantly.
  const toolMenuRef = useRef<HTMLDivElement>(null);
  const toolToggleRef = useRef<HTMLButtonElement>(null);

  // Close the tool menu when the user clicks anywhere outside of it.
  useEffect(() => {
    if (!showToolMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (toolMenuRef.current?.contains(target)) return; // click inside menu
      if (toolToggleRef.current?.contains(target)) return; // click on the + toggle
      setShowToolMenu(false);
    };
    // mousedown so we close before the click event fires elsewhere — feels
    // snappier than waiting for click and avoids double-events on items
    // that themselves listen for clicks.
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showToolMenu]);

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

  const refreshSessions = useCallback(async () => {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    setSessions(data.sessions ?? []);
    return data.sessions as Session[];
  }, []);

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
        // Without this the AI starts blind — questions like "analyse my
        // comments" returned generic answers because Sonnet didn't even know
        // the comment tools existed in the conversation. User can still
        // disable individual groups via the "+" menu, and we don't override
        // their choice if they've already toggled anything this page-load.
        setActiveTools((prev) => {
          if (prev.size > 0) return prev;
          const defaults = new Set<ToolGroup>();
          defaults.add("yt_analytics"); // surfaces a clear "not connected" if OAuth missing
          defaults.add("research"); // youtube_suggest is keyless
          // Strategy reads everything this app already computed — no
          // external dependency. On by default so the AI immediately
          // knows about hooks, competitors, gap analysis, etc.
          defaults.add("strategy");
          if (ints?.youtube?.hasKey) {
            defaults.add("youtube");
            defaults.add("analytics");
          }
          if (ints?.exa?.hasKey) defaults.add("exa");
          if (ints?.apify?.hasKey) defaults.add("apify");
          return defaults;
        });
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
          tools: Array.from(activeTools),
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
  }, [input, sending, hasKey, activeId, refreshSessions, activeTools, attachments, provider]);

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

  const toggleTool = (key: ToolGroup) => {
    setActiveTools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
    <div className="mx-auto flex h-[calc(100vh-5.5rem)] max-w-[1100px] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Sessions sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border">
        <div className="p-3">
          <Button onClick={newChat} className="w-full justify-start gap-2" size="sm">
            <Plus className="h-4 w-4" />
            {t.chat.newChat}
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {sessions.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t.chat.noSessions}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((s) => (
                <li key={s.id}>
                  <div
                    className={cn(
                      "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                      activeId === s.id
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/60 text-foreground/80"
                    )}
                  >
                    <button
                      onClick={() => loadSession(s.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {s.title ?? t.chat.untitled}
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(t.chat.deleteConfirm)) deleteSession(s.id);
                      }}
                      className="opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
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
            {showToolMenu && (
              <div
                ref={toolMenuRef}
                className="absolute bottom-full left-0 mb-2 w-80 rounded-lg border border-border bg-popover p-2 shadow-lg"
              >
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  {t.chat.tools}
                </div>
                <div className="mt-1 space-y-0.5">
                  {TOOL_DEFS.map((tool) => {
                    const hasToolKey =
                      tool.requires === null ||
                      !!integrations?.[tool.requires]?.hasKey;
                    const available = hasToolKey;
                    const active = activeTools.has(tool.key);
                    const Icon = tool.icon;
                    return (
                      <button
                        key={tool.key}
                        type="button"
                        disabled={!available}
                        onClick={() => toggleTool(tool.key)}
                        className={cn(
                          "flex w-full items-start justify-between gap-2 rounded-md px-2 py-2 text-sm transition-colors text-left",
                          available
                            ? active
                              ? "bg-primary/10 text-foreground"
                              : "text-foreground hover:bg-accent"
                            : "cursor-not-allowed text-muted-foreground"
                        )}
                      >
                        <span className="flex min-w-0 flex-1 gap-2">
                          <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium">{tool.label}</span>
                            <span className="block text-[11px] leading-snug text-muted-foreground">
                              {tool.description}
                            </span>
                          </span>
                        </span>
                        <span className="mt-0.5 shrink-0">
                          {active ? (
                            <Check className="h-3.5 w-3.5 text-primary" />
                          ) : !hasToolKey ? (
                            <span className="text-[10px] text-muted-foreground">
                              {t.chat.noKey}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 border-t border-border px-2 pt-2 text-[10px] text-muted-foreground">
                  {t.chat.toolHint}
                </div>
              </div>
            )}

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
                  ref={toolToggleRef}
                  type="button"
                  size="icon"
                  variant={activeTools.size > 0 ? "default" : "ghost"}
                  className="h-8 w-8 shrink-0 relative"
                  onClick={() => setShowToolMenu((s) => !s)}
                  aria-label="Add tools"
                  title={t.chat.tools}
                >
                  <Plus className="h-4 w-4" />
                  {activeTools.size > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                      {activeTools.size}
                    </span>
                  )}
                </Button>
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
                <Link href="/integrations" className="underline hover:text-foreground">
                  {t.banner.connectCta}
                </Link>
              </p>
            )}
          </div>
        </div>
      </div>
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
          <Link href="/integrations">
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
