"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Copy,
  Check,
  Eye,
  ThumbsUp,
  MessageCircle,
  Clock,
  Calendar,
  ExternalLink,
  Search,
  Sparkles,
  FileText,
  Loader2,
  AlertCircle,
  Mic,
  RotateCw,
  BarChart3,
  Upload,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import { VideoCommentsPanel } from "@/components/video-comments-panel";
import { VideoAnalyticsPanel } from "@/components/video-analytics-panel";

type Video = {
  id: string;
  channel_id: string | null;
  title: string;
  description: string | null;
  published_at: number | null;
  duration_seconds: number | null;
  views: number;
  likes: number;
  comments: number;
  thumbnail_url: string | null;
  tags: string | null;
};

type Channel = { id: string; title: string | null; handle: string | null };

type Detail = {
  video: Video;
  channel: Channel | null;
  transcript: { text: string; language: string | null } | null;
  commentSummary: { total: number; topLevel: number; fetchedAt: number | null };
};

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

function fmtDuration(sec: number | null | undefined): string {
  if (!sec) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(ts: number | null): string {
  if (!ts) return "";
  // Force en-US to keep month names in English regardless of OS locale
  // (a Ukrainian Windows would otherwise render "квіт. 25, 2026").
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function daysSince(ts: number | null): number | null {
  if (!ts) return null;
  return Math.max(1, Math.floor((Date.now() / 1000 - ts) / 86400));
}

export default function VideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "transcript" | "comments" | "analytics">(
    "overview"
  );
  const [transcriptQ, setTranscriptQ] = useState("");
  const [copied, setCopied] = useState(false);

  // ===== Transcription state (lifted from TranscriptPanel) =====
  // We keep this here at the page level so it survives tab switches —
  // TranscriptPanel unmounts when you click Overview/Comments, so any state
  // it owns (including "transcribing…") gets blown away. The user's fetch
  // is still running on the server, the UI just forgets it. Owning the
  // state at the page makes the spinner persist as long as you don't
  // navigate off the video page entirely.
  const [transcribing, setTranscribing] = useState(false);
  const [tcError, setTcError] = useState<string | null>(null);
  const [deepgramReady, setDeepgramReady] = useState<boolean | null>(null);
  // Free-captions tier — separate spinner so the user can see which path
  // is running. `captionsUnavailable` flips to true after a 404 from
  // /captions; we use it to grey out the free button after we know YouTube
  // has nothing for this video, so the user doesn't keep poking it.
  const [fetchingCaptions, setFetchingCaptions] = useState(false);
  const [captionsUnavailable, setCaptionsUnavailable] = useState(false);

  useEffect(() => {
    fetch("/api/integrations")
      .then((r) => r.json())
      .then((d) => setDeepgramReady(!!d?.integrations?.deepgram?.hasKey))
      .catch(() => setDeepgramReady(false));
  }, []);

  // Pulled out so TranscriptPanel can re-fetch after a successful Deepgram
  // run without forcing the whole page to reload.
  const loadDetail = useCallback(async () => {
    try {
      const r = await fetch(`/api/videos/${id}`);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      const d = (await r.json()) as Detail;
      setDetail(d);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "failed");
    }
  }, [id]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const transcribe = useCallback(async () => {
    setTranscribing(true);
    setTcError(null);
    try {
      const res = await fetch(`/api/videos/${id}/transcribe`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await loadDetail();
    } catch (e) {
      setTcError(e instanceof Error ? e.message : "failed");
    } finally {
      setTranscribing(false);
    }
  }, [id, loadDetail]);

  // YouTube timedtext fetch. On 404 unavailable, hold onto the debug
  // payload so the UI can expand it for power users to see what
  // YouTube actually returned — way more useful than a vague
  // "no captions" message when something IS clearly captioned on
  // youtube.com but we can't pull it.
  const [tcDebug, setTcDebug] = useState<unknown | null>(null);
  // Upload / URL paths — independent state from the captions path so
  // their spinners and errors don't interfere with each other.
  const [uploading, setUploading] = useState(false);
  const [uploadingProgress, setUploadingProgress] = useState<number | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [transcribingUrl, setTranscribingUrl] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  // Upload a local audio/video file. Browser POSTs multipart, server
  // buffers it in RAM, streams to Deepgram, persists the text. Nothing
  // touches disk on the server.
  const uploadFile = useCallback(
    async (file: File) => {
      setUploading(true);
      setUploadingProgress(0);
      setTcError(null);
      try {
        // XHR over fetch only because XHR exposes upload progress
        // events which fetch still doesn't (mid-2026). The transcript
        // round-trip itself is short, but the upload phase isn't.
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `/api/videos/${id}/transcribe-upload`);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setUploadingProgress(Math.round((e.loaded / e.total) * 100));
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              let msg = `HTTP ${xhr.status}`;
              try {
                const parsed = JSON.parse(xhr.responseText);
                if (parsed?.error) msg = parsed.error;
              } catch {
                /* ignore */
              }
              reject(new Error(msg));
            }
          };
          xhr.onerror = () => reject(new Error("Network error"));
          const form = new FormData();
          form.append("audio", file);
          xhr.send(form);
        });
        await loadDetail();
      } catch (e) {
        setTcError(e instanceof Error ? e.message : "upload failed");
      } finally {
        setUploading(false);
        setUploadingProgress(null);
      }
    },
    [id, loadDetail]
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer.files?.[0];
      if (file) uploadFile(file);
    },
    [uploadFile]
  );

  const transcribeViaUrl = useCallback(async () => {
    if (!urlInput.trim()) return;
    setTranscribingUrl(true);
    setTcError(null);
    try {
      const r = await fetch(`/api/videos/${id}/transcribe-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioUrl: urlInput.trim() }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setUrlInput("");
      await loadDetail();
    } catch (e) {
      setTcError(e instanceof Error ? e.message : "URL transcription failed");
    } finally {
      setTranscribingUrl(false);
    }
  }, [id, urlInput, loadDetail]);

  const fetchCaptions = useCallback(async () => {
    setFetchingCaptions(true);
    setTcError(null);
    setTcDebug(null);
    try {
      const res = await fetch(`/api/videos/${id}/captions`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        unavailable?: boolean;
        debug?: unknown;
      };
      if (res.status === 404 && data.unavailable) {
        setCaptionsUnavailable(true);
        setTcError(
          data.error ??
            "YouTube did not return captions for this video through any probed language. See debug below for raw probe responses."
        );
        if (data.debug) setTcDebug(data.debug);
        return;
      }
      if (!res.ok) {
        if (data.debug) setTcDebug(data.debug);
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await loadDetail();
    } catch (e) {
      setTcError(e instanceof Error ? e.message : "failed");
    } finally {
      setFetchingCaptions(false);
    }
  }, [id, loadDetail]);

  const tags = useMemo(() => {
    if (!detail?.video.tags) return [];
    try {
      const parsed = JSON.parse(detail.video.tags);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }, [detail?.video.tags]);

  const avgPerDay = useMemo(() => {
    if (!detail?.video.published_at) return null;
    const d = daysSince(detail.video.published_at);
    return d ? Math.round(detail.video.views / d) : null;
  }, [detail]);

  const engagementRate = useMemo(() => {
    if (!detail || detail.video.views === 0) return null;
    return ((detail.video.likes + detail.video.comments) / detail.video.views) * 100;
  }, [detail]);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl">
        <Link href="/videos" className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t.videos.title}
        </Link>
        <Card>
          <CardContent className="flex items-center gap-3 p-8 text-destructive">
            <AlertCircle className="h-5 w-5" />
            {error}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }

  const { video, transcript } = detail;
  const ytUrl = `https://www.youtube.com/watch?v=${video.id}`;

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/videos"
        className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t.videos.title}
      </Link>

      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row">
        {video.thumbnail_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={video.thumbnail_url}
            alt=""
            className="h-48 w-full rounded-lg object-cover sm:h-32 sm:w-56"
            referrerPolicy="no-referrer"
          />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{video.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {fmtDate(video.published_at)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {fmtDuration(video.duration_seconds)}
            </span>
            <a
              href={ytUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {t.videoDetail.openOnYouTube}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          {tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {tags.slice(0, 12).map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  #{tag}
                </span>
              ))}
              {tags.length > 12 && (
                <span className="text-[11px] text-muted-foreground">+{tags.length - 12}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* KPIs */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi icon={Eye} label={t.videoDetail.views} value={fmt(video.views)} />
        <Kpi icon={ThumbsUp} label={t.videoDetail.likes} value={fmt(video.likes)} />
        <Kpi icon={MessageCircle} label={t.videoDetail.comments} value={fmt(video.comments)} />
        <Kpi
          icon={Sparkles}
          label={t.videoDetail.engagementRate}
          value={engagementRate !== null ? `${engagementRate.toFixed(2)}%` : "—"}
        />
      </div>

      {avgPerDay !== null && (
        <p className="mb-4 text-xs text-muted-foreground">
          {t.videoDetail.avgViewsPerDay.replace("{n}", fmt(avgPerDay))}
        </p>
      )}

      {/* Ask Claude hint */}
      <Card className="mb-4 border-primary/20 bg-primary/5">
        <CardContent className="flex items-start gap-3 p-4 text-sm">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <div className="font-medium">{t.videoDetail.askClaudeTitle}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t.videoDetail.askClaudeHint}
            </p>
            <Link href={`/chat?attachVideo=${video.id}`}>
              <Button size="sm" variant="outline" className="mt-2 gap-2">
                <Sparkles className="h-3.5 w-3.5" />
                {t.videoDetail.attachToChat}
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <div className="mb-3 flex flex-wrap gap-1 border-b border-border">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
          {t.videoDetail.tabOverview}
        </TabButton>
        <TabButton active={tab === "analytics"} onClick={() => setTab("analytics")}>
          <BarChart3 className="h-3.5 w-3.5" />
          Analytics
        </TabButton>
        <TabButton active={tab === "transcript"} onClick={() => setTab("transcript")}>
          <FileText className="h-3.5 w-3.5" />
          {t.videoDetail.tabTranscript}
          {transcript && (
            <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
              {transcript.language ?? "?"}
            </span>
          )}
        </TabButton>
        <TabButton active={tab === "comments"} onClick={() => setTab("comments")}>
          <MessageCircle className="h-3.5 w-3.5" />
          {t.videoDetail.tabComments}
          {detail.commentSummary.topLevel > 0 && (
            <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
              {detail.commentSummary.topLevel}
            </span>
          )}
        </TabButton>
      </div>

      {tab === "overview" && (
        <Card>
          <CardContent className="space-y-3 p-5 text-sm">
            <h2 className="font-medium">{t.videoDetail.description}</h2>
            <div className="whitespace-pre-wrap text-muted-foreground">
              {video.description?.trim() || <em>{t.videoDetail.noDescription}</em>}
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "transcript" && (
        <TranscriptPanel
          durationSeconds={video.duration_seconds}
          transcript={transcript}
          query={transcriptQ}
          setQuery={setTranscriptQ}
          copied={copied}
          onCopy={async () => {
            if (!transcript) return;
            await navigator.clipboard.writeText(transcript.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          transcribing={transcribing}
          tcError={tcError}
          tcDebug={tcDebug}
          deepgramReady={deepgramReady}
          onTranscribe={transcribe}
          fetchingCaptions={fetchingCaptions}
          captionsUnavailable={captionsUnavailable}
          onFetchCaptions={fetchCaptions}
          uploading={uploading}
          uploadingProgress={uploadingProgress}
          onUploadFile={uploadFile}
          fileInputRef={fileInputRef}
          onDrop={onDrop}
          dragActive={dragActive}
          setDragActive={setDragActive}
          urlInput={urlInput}
          setUrlInput={setUrlInput}
          transcribingUrl={transcribingUrl}
          onTranscribeUrl={transcribeViaUrl}
        />
      )}

      {tab === "comments" && (
        <VideoCommentsPanel videoId={video.id} initialSummary={detail.commentSummary} />
      )}

      {tab === "analytics" && <VideoAnalyticsPanel videoId={video.id} />}
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="truncate text-base font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function TabButton({
  children,
  active,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
        disabled && "cursor-not-allowed opacity-60 hover:text-muted-foreground"
      )}
    >
      {children}
    </button>
  );
}

function TranscriptPanel({
  durationSeconds,
  transcript,
  query,
  setQuery,
  copied,
  onCopy,
  transcribing,
  tcError,
  tcDebug,
  deepgramReady,
  onTranscribe,
  fetchingCaptions,
  captionsUnavailable,
  onFetchCaptions,
  uploading,
  uploadingProgress,
  onUploadFile,
  fileInputRef,
  onDrop,
  dragActive,
  setDragActive,
  urlInput,
  setUrlInput,
  transcribingUrl,
  onTranscribeUrl,
}: {
  durationSeconds: number | null;
  transcript: { text: string; language: string | null } | null;
  query: string;
  setQuery: (s: string) => void;
  copied: boolean;
  onCopy: () => void;
  transcribing: boolean;
  tcError: string | null;
  tcDebug: unknown | null;
  deepgramReady: boolean | null;
  onTranscribe: () => void;
  fetchingCaptions: boolean;
  captionsUnavailable: boolean;
  onFetchCaptions: () => void;
  uploading: boolean;
  uploadingProgress: number | null;
  onUploadFile: (file: File) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  dragActive: boolean;
  setDragActive: (b: boolean) => void;
  urlInput: string;
  setUrlInput: (s: string) => void;
  transcribingUrl: boolean;
  onTranscribeUrl: () => void;
}) {
  const { t } = useI18n();
  const highlighted = useHighlightedText(transcript?.text ?? "", query);

  // Estimate Deepgram cost (cents). Nova-3 = $0.0043/min, ceil to a cent.
  const estCostCents = durationSeconds
    ? Math.max(1, Math.ceil((durationSeconds / 60) * 0.43))
    : null;
  const estCostUsd =
    estCostCents !== null ? `$${(estCostCents / 100).toFixed(2)}` : null;

  // ===== Empty state — no transcript yet =====
  if (!transcript) {
    return (
      <Card>
        <CardContent className="space-y-4 p-8 text-center text-sm">
          <div className="text-muted-foreground">{t.videoDetail.noTranscript}</div>

          {/*
            Three ways to get a transcript (local-first ordering):
              1. YouTube captions (free, via timedtext + Innertube). First try.
              2. Deepgram (recommended for this local build). yt-dlp pulls audio
                 into RAM on this machine, streams it to Deepgram, transcript
                 lands in the local DB. Costs ≈$0.0043/min ($0.26/hour).
              3. Apify fallback — useful if yt-dlp is blocked or you'd rather
                 not run the binary locally; ≈$0.02 per video.
          */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              onClick={onFetchCaptions}
              disabled={fetchingCaptions || captionsUnavailable}
              size="sm"
              variant={captionsUnavailable ? "outline" : "default"}
              className="gap-2"
            >
              {fetchingCaptions ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Fetching captions…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  {captionsUnavailable
                    ? "No captions on YouTube"
                    : "Get YouTube captions"}
                  {!captionsUnavailable && (
                    <span className="ml-1 rounded bg-primary-foreground/15 px-1.5 py-0.5 text-[10px] font-mono">
                      free
                    </span>
                  )}
                </>
              )}
            </Button>
            {deepgramReady && (
              <Button
                onClick={onTranscribe}
                disabled={transcribing}
                size="sm"
                variant={captionsUnavailable ? "default" : "outline"}
                className="gap-2"
              >
                {transcribing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Transcribing via Deepgram…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    Transcribe with Deepgram
                    {estCostUsd && (
                      <span className="ml-1 rounded bg-primary-foreground/15 px-1.5 py-0.5 text-[10px] font-mono">
                        ≈{estCostUsd}
                      </span>
                    )}
                  </>
                )}
              </Button>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground">
            Free path tries YouTube&apos;s [CC] feed (~80% of videos work).
            Deepgram path runs locally — yt-dlp grabs the audio, streams it
            to Deepgram (≈$0.0043 / min), transcript lands in your local DB.
            {deepgramReady === false && (
              <>
                {" "}
                <Link href="/settings/integrations" className="text-primary hover:underline">
                  Add Deepgram key
                </Link>{" "}
                to enable transcription.
              </>
            )}
          </p>


          {tcError && (
            <div className="mx-auto max-w-2xl space-y-2 text-left">
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{tcError}</span>
              </div>
              {tcDebug !== null && tcDebug !== undefined && (
                <details className="rounded-md border border-border bg-muted/20 p-2 text-[11px]">
                  <summary className="cursor-pointer select-none font-medium text-muted-foreground">
                    Show technical details (probe responses)
                  </summary>
                  <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-muted-foreground">
                    {JSON.stringify(tcDebug, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ===== Has transcript — show + small "re-transcribe" option =====
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder={t.videoDetail.searchTranscript}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button variant="outline" size="sm" onClick={onCopy} className="gap-1.5">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t.videoDetail.copied : t.videoDetail.copy}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onFetchCaptions}
            disabled={fetchingCaptions}
            className="gap-1.5"
            title="Re-fetch the transcript from YouTube captions"
          >
            {fetchingCaptions ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
            {fetchingCaptions ? "Fetching…" : "Re-fetch captions"}
          </Button>
          {deepgramReady && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const cost = estCostUsd ? ` (≈${estCostUsd})` : "";
                if (!confirm(`Re-transcribe via Deepgram${cost}?`)) return;
                onTranscribe();
              }}
              disabled={transcribing}
              className="gap-1.5"
              title="Re-transcribe via Deepgram (yt-dlp pulls audio locally, streams to Deepgram)"
            >
              {transcribing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {transcribing ? "Deepgram…" : "Deepgram"}
            </Button>
          )}
        </div>
        {tcError && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{tcError}</span>
          </div>
        )}
        <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4 text-sm leading-relaxed">
          {highlighted}
        </div>
      </CardContent>
    </Card>
  );
}

function useHighlightedText(text: string, query: string): React.ReactNode {
  return useMemo(() => {
    const q = query.trim();
    if (!q) return text;
    try {
      const rx = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
      const parts = text.split(rx);
      return parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-yellow-300/60 px-0.5 dark:bg-yellow-500/40">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      );
    } catch {
      return text;
    }
  }, [text, query]);
}
