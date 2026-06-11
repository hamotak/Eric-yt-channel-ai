"use client";

import {
  DragEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Paperclip,
  ThumbsDown,
  ThumbsUp,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { YouTubeThumbnail } from "@/components/youtube-thumbnail";
import { cn } from "@/lib/utils";

type ImageReference = {
  id: string;
  kind: string;
  videoId: string | null;
  title: string;
  channelName: string | null;
  channelHandle: string | null;
  thumbnailUrl: string;
  views: number | null;
  medianViews: number | null;
  multiplier: number | null;
  reason: string;
  relevanceScore?: number;
  relevanceLabels?: string[];
  feedback?: "liked" | "disliked" | null;
  feedbackReason?: string | null;
};

type AttachmentView = {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  previewUrl: string;
};

type Candidate = {
  id: string;
  rank: number;
  status: "processing" | "completed" | "failed";
  imageUrl: string | null;
  sourceImages: ImageReference[];
  prompt: string | null;
  rationale: string | null;
  changes: string | null;
  critique: string | null;
  feedback: "accepted" | "rejected" | null;
  feedbackReason: string | null;
  error: string | null;
  model: string | null;
  resolution: string | null;
  jobId: string | null;
  providerAttempts?: ProviderAttempt[];
};

type ProviderAttempt = {
  attemptType: "generate" | "reference" | "source_free_retry";
  model: string;
  promptPreview: string;
  promptHash: string;
  imageUrls: string[];
  referenceIds: string[];
  imagePayloads?: Array<{
    sourceUrl: string;
    submittedKind: "data_url" | "remote_url";
    mimeType: string | null;
    byteSize: number | null;
    sha256: string | null;
    submittedPreview: string;
  }>;
  submittedAt: string;
  jobId: string | null;
  error?: string | null;
};

type RunView = {
  id: string;
  status: "processing" | "completed" | "failed";
  phase: "planning" | "rendering" | "reviewing" | "completed" | "failed";
  errorCategory:
    | "planner_timeout"
    | "planner_failed"
    | "provider_capacity"
    | "provider_rejected"
    | "provider_timeout"
    | "download_failed"
    | "provider_failed"
    | "unknown"
    | null;
  mode: "prompt" | "assist" | "ideate";
  generationMode: "generate" | "remix";
  prompt: string;
  title: string | null;
  channelId: string;
  sourceIdeaId: string | null;
  sampleCount: number;
  aspectRatio: string;
  resolution: string;
  aiAssist: boolean;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  references: ImageReference[];
  attachments: AttachmentView[];
  learnedRules: unknown[];
  candidates: Candidate[];
};

type HistoryEntry = {
  id: string;
  mode: "prompt" | "assist" | "ideate";
  status: "processing" | "completed" | "failed";
  phase?: RunView["phase"];
  errorCategory?: RunView["errorCategory"];
  title: string;
  sampleCount: number;
  startedAt: string;
  completedAt: string | null;
};

const ASPECT_OPTIONS = ["16:9", "1:1", "9:16", "4:5", "3:2", "2:3"] as const;
const RESOLUTION_OPTIONS = [
  { label: "1K", value: "1k" },
  { label: "2K", value: "2k" },
  { label: "4K", value: "4k" },
] as const;

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

function formatViews(value: number | null): string {
  if (typeof value !== "number") return "views n/a";
  return new Intl.NumberFormat("en-US", { notation: "compact" }).format(value);
}

function sourceChannelText(ref: ImageReference): string {
  return [ref.channelName, ref.channelHandle].filter(Boolean).join(" · ") ||
    "Channel unknown";
}

function sourceScoreText(ref: ImageReference): string {
  const parts = [
    sourceChannelText(ref),
    typeof ref.views === "number" ? `${formatViews(ref.views)} views` : "views n/a",
    typeof ref.multiplier === "number"
      ? `${ref.multiplier.toFixed(1)}x outlier`
      : null,
    typeof ref.medianViews === "number" && ref.medianViews > 0
      ? `${formatViews(ref.medianViews)} median`
      : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function sourceLabel(kind: string): string {
  return kind
    .replace(/^idea_/, "")
    .replace(/outlier/g, "reference")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function cssAspectRatio(value: string): string {
  const [w, h] = value.split(":").map(Number);
  if (!w || !h) return "16 / 9";
  return `${w} / ${h}`;
}

function displayImageError(message: string): string {
  const normalized = message
    .replace(/^1 image candidate job failed$/i, "1 image option failed")
    .replace(/^1 image candidate job failed:/i, "1 image option failed:")
    .replace(/^(\d+) image candidate job failed$/i, "$1 image options failed")
    .replace(/^(\d+) image candidate job failed:/i, "$1 image options failed:")
    .replace(/69labs job failed:\s*no details/gi, "Image provider failed without details")
    .replace(/^69labs\b/i, "Image provider");
  if (
    /provider is busy|concurrent image generation limit|current image jobs/i.test(
      normalized
    )
  ) {
    return "Image provider is busy. Wait for current image jobs to finish, then retry.";
  }
  if (/429|too many requests|rate limit|rate-limit/i.test(normalized)) {
    return "Image provider rate-limited this request. Wait a moment, then retry.";
  }
  return normalized;
}

function displayRunError(run: Pick<RunView, "error" | "errorCategory" | "phase" | "candidates">): string {
  const message = run.error ?? "";
  if (run.errorCategory === "planner_timeout") {
    return "Image planner timed out before rendering started. No 69labs image job was created for this run.";
  }
  if (run.errorCategory === "planner_failed") {
    return "Image planner failed before rendering started. No 69labs image job was created for this run.";
  }
  if (run.errorCategory === "provider_capacity") {
    return "Image provider capacity was full after retries. Wait for current image jobs to finish, then retry.";
  }
  if (run.errorCategory === "provider_timeout") {
    return "Image provider took too long while rendering. Retry with the same prompt or simplify the request.";
  }
  if (run.errorCategory === "download_failed") {
    return "Image rendered but the app could not download the provider output. Retry the run.";
  }
  if (run.candidates.length === 0 && /request timed out|planner timed out/i.test(message)) {
    return "Image planner timed out before rendering started. No 69labs image job was created for this run.";
  }
  return displayImageError(message);
}

function runErrorSummary(run: Pick<RunView, "error" | "errorCategory" | "candidates">): string {
  if (run.errorCategory === "planner_timeout") return "Planner timed out";
  if (run.errorCategory === "planner_failed") return "Planner failed";
  if (run.errorCategory === "provider_capacity") return "Image provider busy";
  if (run.errorCategory === "provider_rejected") return "Image provider rejected a render";
  if (run.errorCategory === "provider_timeout") return "Image provider timed out";
  if (run.errorCategory === "download_failed") return "Image download failed";
  if (run.candidates.length === 0 && /request timed out|planner timed out/i.test(run.error ?? "")) {
    return "Planner timed out";
  }
  return imageErrorSummary(run.error ?? "Image run failed");
}

function isImageProviderCapacityError(message: string): boolean {
  return /provider is busy|rate-limited/i.test(displayImageError(message));
}

function imageErrorBoxClass(message: string): string {
  return isImageProviderCapacityError(message)
    ? "border-amber-500/45 bg-amber-500/5"
    : "border-destructive/35 bg-background";
}

function imageErrorSummaryClass(message: string): string {
  return isImageProviderCapacityError(message)
    ? "text-amber-700 dark:text-amber-300"
    : "text-destructive";
}

function imageErrorSummary(message: string): string {
  const normalized = displayImageError(message);
  if (/provider is busy/i.test(normalized)) {
    return "Image provider busy";
  }
  if (/rate-limited/i.test(normalized)) {
    return "Image provider rate-limited";
  }
  if (/internal generation pipeline|restricted|misclassified/i.test(normalized)) {
    return "Image provider failed";
  }
  return normalized.length > 90 ? `${normalized.slice(0, 87).trimEnd()}...` : normalized;
}

function displayChangeNote(changes: string | null): string | null {
  if (!changes) return null;
  const cleaned = changes
    .replace(/\([^)]*(?:[A-Za-z0-9_-]{8,}|\d+(?:\.\d+)?\s*(?:x|×))[^)]*\)/gi, "")
    .replace(
      /\b(?=[A-Za-z0-9_-]{8,}\b)(?:(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+|(?=[A-Za-z0-9_-]*_)[A-Za-z0-9_-]+|(?=[A-Za-z0-9_-]*-)(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]+)\b/g,
      ""
    )
    .replace(/\b\d+(?:\.\d+)?\s*(?:x|×)\+?\b/gi, "")
    .replace(/\b(?:outlier|outliers|format outlier|video id|thumbnail id)\b/gi, "reference")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned];
  const compact = sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  return compact.length > 220 ? `${compact.slice(0, 217).trimEnd()}...` : compact;
}

function displaySourceLabels(refItem: ImageReference): string[] {
  const labels = refItem.relevanceLabels?.length
    ? refItem.relevanceLabels
    : [sourceLabel(refItem.kind)];
  const cleaned = labels
    .map((label) => label.replace(/\boutliers?\b/gi, "Reference").trim())
    .filter((label) => label && !/\d+(?:\.\d+)?\s*(?:x|×)\+?/i.test(label));
  return cleaned.length > 0 ? cleaned.slice(0, 3) : ["Reference"];
}

export default function ImageStudioPage() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyOverlayMode, setHistoryOverlayMode] = useState(true);
  const [historyOverlayOpen, setHistoryOverlayOpen] = useState(false);

  const [prompt, setPrompt] = useState("");
  const [sampleCount, setSampleCount] = useState(1);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("1k");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);

  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    runIdRef.current = runId;
  }, [runId]);

  const loadHistory = useCallback(async () => {
    const res = await fetch("/api/image-runs", { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as {
      history?: HistoryEntry[];
    };
    const items = data.history ?? [];
    setHistory(items);
    setHistoryLoading(false);
    return items;
  }, []);

  const pollRun = useCallback(async (id: string) => {
    const res = await fetch(`/api/image-runs/${id}`, { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as {
      run?: RunView;
      error?: string;
    };
    if (!res.ok || !data.run) {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    if (runIdRef.current === id) {
      setRun(data.run);
    }
    return data.run;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const queryRun = params.get("runId");
    const queryPrompt = params.get("prompt") ?? params.get("title");
    if (queryPrompt) setPrompt(queryPrompt);
    if (queryRun) setRunId(queryRun);

    let cancelled = false;
    loadHistory().then((items) => {
      if (cancelled || queryRun || queryPrompt) return;
      const mostRecent = items[0];
      if (mostRecent) setRunId(mostRecent.id);
    });
    return () => {
      cancelled = true;
    };
  }, [loadHistory]);

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

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await pollRun(runId);
        if (!cancelled && next.status === "processing") {
          window.setTimeout(tick, 3000);
        } else if (!cancelled) {
          void loadHistory();
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not load run");
        }
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [loadHistory, pollRun, runId]);

  const attachmentPreviews = useMemo(
    () =>
      attachments.map((file) => ({
        file,
        url: URL.createObjectURL(file),
      })),
    [attachments]
  );

  useEffect(() => {
    return () => {
      for (const item of attachmentPreviews) URL.revokeObjectURL(item.url);
    };
  }, [attachmentPreviews]);

  const addImageFiles = useCallback((files: Iterable<File>) => {
    const imageFiles = Array.from(files).filter((file) =>
      file.type.startsWith("image/")
    );
    if (imageFiles.length === 0) return false;
    setAttachments((prev) => {
      const next = [...prev];
      for (const file of imageFiles) {
        if (next.length >= 4) break;
        next.push(file);
      }
      return next;
    });
    return true;
  }, []);

  const addClipboardImages = useCallback(
    (clipboard: DataTransfer | null) => {
      if (!clipboard) return false;
      const files: File[] = [];
      for (const item of Array.from(clipboard.items ?? [])) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (files.length === 0) {
        files.push(
          ...Array.from(clipboard.files ?? []).filter((file) =>
            file.type.startsWith("image/")
          )
        );
      }
      return addImageFiles(files);
    },
    [addImageFiles]
  );

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (addClipboardImages(event.clipboardData)) {
        event.preventDefault();
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addClipboardImages]);

  const dragHasImage = (event: DragEvent<HTMLElement>): boolean => {
    const types = Array.from(event.dataTransfer.types ?? []);
    if (!types.includes("Files")) return false;
    const files = Array.from(event.dataTransfer.files ?? []);
    return files.length === 0 || files.some((file) => file.type.startsWith("image/"));
  };

  const onDragEnter = (event: DragEvent<HTMLFormElement>) => {
    if (!dragHasImage(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const onDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!dragHasImage(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  };

  const onDragLeave = (event: DragEvent<HTMLFormElement>) => {
    if (!dragHasImage(event)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!dragHasImage(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    addImageFiles(event.dataTransfer.files);
  };

  const canGenerate = prompt.trim().length > 0 && !starting;

  const newImage = useCallback(() => {
    runIdRef.current = null;
    setRunId(null);
    setRun(null);
    setPrompt("");
    setAttachments([]);
    setError(null);
    setSampleCount(1);
    setAspectRatio("16:9");
    setResolution("1k");
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/image-studio");
    }
  }, []);

  const startRun = useCallback(async () => {
    if (!canGenerate) return;
    setStarting(true);
    setError(null);
    try {
      const hasFiles = attachments.length > 0;
      const init: RequestInit = { method: "POST" };
      if (hasFiles) {
        const form = new FormData();
        form.set("prompt", prompt);
        form.set("sampleCount", String(sampleCount));
        form.set("aspectRatio", aspectRatio);
        form.set("resolution", resolution);
        form.set("aiAssist", "true");
        form.set("generationMode", "generate");
        for (const file of attachments) form.append("attachments", file);
        init.body = form;
      } else {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify({
          prompt,
          sampleCount,
          aspectRatio,
          resolution,
          aiAssist: false,
          generationMode: "generate",
        });
      }
      const res = await fetch("/api/image-runs", init);
      const data = (await res.json().catch(() => ({}))) as {
        request_id?: string;
        error?: string;
      };
      if (!res.ok || !data.request_id) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      runIdRef.current = data.request_id;
      setRunId(data.request_id);
      setRun(null);
      setAttachments([]);
      await loadHistory();
      if (typeof window !== "undefined") {
        window.history.replaceState(
          null,
          "",
          `/image-studio?runId=${encodeURIComponent(data.request_id)}`
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start run");
    } finally {
      setStarting(false);
    }
  }, [
    aspectRatio,
    attachments,
    canGenerate,
    loadHistory,
    prompt,
    resolution,
    sampleCount,
  ]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void startRun();
  };

  const progressText = useMemo(() => {
    if (!run) return null;
    if (run.status === "processing") {
      const done = run.candidates.filter((c) => c.status !== "processing").length;
      if (run.phase === "planning") {
        return "Planning image prompts";
      }
      return run.candidates.length > 0
        ? `${done}/${run.candidates.length} images finished`
        : run.aiAssist
          ? "Studying context and planning prompts"
          : "Sending prompt to 69labs";
    }
    if (run.phase === "completed") return "Image accepted";
    if (run.status === "completed") return "Ready for review";
    return "Run failed";
  }, [run]);

  return (
    <div className="-mx-6 -mb-6 -mt-20 flex h-[calc(100vh-3.5rem)]">
      {historyOverlayMode && historyOverlayOpen && (
        <button
          aria-label="Close history"
          type="button"
          onClick={() => setHistoryOverlayOpen(false)}
          className="fixed inset-y-0 left-60 right-0 z-30 bg-black/40"
        />
      )}
      <HistoryRail
        history={history}
        loading={historyLoading}
        selectedId={runId}
        overlayMode={historyOverlayMode}
        overlayOpen={historyOverlayOpen}
        onSelect={(id) => {
          setRunId(id);
          setError(null);
          if (historyOverlayMode) setHistoryOverlayOpen(false);
          window.history.replaceState(null, "", `/image-studio?runId=${encodeURIComponent(id)}`);
        }}
        onNew={newImage}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 pb-10 pt-20">
          {historyOverlayMode && (
            <button
              type="button"
              onClick={() => setHistoryOverlayOpen(true)}
              className="mb-6 text-xs text-primary hover:underline"
            >
              History →
            </button>
          )}

          <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Image Studio</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={newImage}>
                <ImagePlus className="h-4 w-4" />
                New Image
              </Button>
              {progressText && (
                <div
                  className={cn(
                    "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
                    run?.status === "failed"
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-border bg-muted/30 text-muted-foreground"
                  )}
                >
                  {run?.status === "processing" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {run?.status === "completed" && <Check className="h-3.5 w-3.5 text-emerald-600" />}
                  {run?.status === "failed" && <XCircle className="h-3.5 w-3.5" />}
                  {progressText}
                </div>
              )}
            </div>
          </header>

          {error && (
            <ImageErrorBanner message={error} className="mb-6" />
          )}
          {run?.error && (
            <ImageErrorBanner
              message={run.error}
              summary={runErrorSummary(run)}
              detail={displayRunError(run)}
              className="mb-6"
            />
          )}

          {run ? (
            <RunResults run={run} aspectRatio={run.aspectRatio} onRefresh={async () => {
              if (runId) await pollRun(runId);
            }} />
          ) : runId ? (
            <PendingRun />
          ) : (
            <form
              onSubmit={submit}
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              className={cn(
                "relative mb-8 overflow-hidden rounded-lg border border-border bg-card p-3 shadow-sm",
                "transition-[border-color,background-color,box-shadow,transform] duration-200",
                dragActive && "scale-[1.002] border-primary/70 bg-primary/5 shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]"
              )}
            >
              {dragActive && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/70 bg-background/70 backdrop-blur-sm">
                  <span className="sr-only">Drop images to attach</span>
                  <span className="inline-flex h-14 w-14 animate-in zoom-in-95 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary shadow-sm">
                    <ImagePlus className="h-7 w-7 animate-pulse" />
                  </span>
                </div>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={attachments.length >= 4}
                  className="mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                  title="Attach image"
                  aria-label="Attach image"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                  <Textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Prompt or reference..."
                    rows={3}
                    className="min-h-[5.25rem] resize-none border-0 bg-transparent px-0 py-1 text-base shadow-none focus-visible:ring-0"
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []).slice(0, 4);
                      addImageFiles(files);
                      event.currentTarget.value = "";
                    }}
                  />
                  {attachmentPreviews.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {attachmentPreviews.map((item, index) => (
                        <div
                          key={`${item.file.name}-${index}`}
                          className="animate-in fade-in zoom-in-95 relative h-16 w-24 overflow-hidden rounded-md border border-border bg-muted transition-transform duration-200 hover:-translate-y-0.5"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={item.url}
                            alt={item.file.name}
                            className="h-full w-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              setAttachments((prev) => prev.filter((_, i) => i !== index));
                            }}
                            className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/65 text-white"
                            aria-label="Remove attachment"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedCount value={sampleCount} onChange={setSampleCount} />
                  <select
                    value={aspectRatio}
                    onChange={(event) => setAspectRatio(event.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    title="Aspect ratio"
                  >
                    {ASPECT_OPTIONS.map((ratio) => (
                      <option key={ratio} value={ratio}>
                        {ratio}
                      </option>
                    ))}
                  </select>
                  <select
                    value={resolution}
                    onChange={(event) => setResolution(event.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    title="Resolution"
                  >
                    {RESOLUTION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="submit" disabled={!canGenerate} className="min-w-28 gap-2">
                  {starting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ImageIcon className="h-4 w-4" />
                  )}
                  Generate
                </Button>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}

function PendingRun() {
  return (
    <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
      <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
      <p className="mt-3 text-sm text-muted-foreground">Preparing image run...</p>
    </div>
  );
}

function ImageErrorBanner({
  message,
  summary,
  detail,
  className,
}: {
  message: string;
  summary?: string;
  detail?: string;
  className?: string;
}) {
  return (
    <details
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        imageErrorBoxClass(message),
        className
      )}
    >
      <summary className={cn("cursor-pointer", imageErrorSummaryClass(message))}>
        {summary ?? imageErrorSummary(message)}
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">{detail ?? displayImageError(message)}</p>
    </details>
  );
}

function HistoryRail({
  history,
  loading,
  selectedId,
  overlayMode,
  overlayOpen,
  onSelect,
  onNew,
}: {
  history: HistoryEntry[];
  loading: boolean;
  selectedId: string | null;
  overlayMode: boolean;
  overlayOpen: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const overlayClosed = overlayMode && !overlayOpen;

  return (
    <aside
      className={cn(
        "flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-background/40",
        "transition-transform duration-200 ease-in-out",
        overlayMode
          ? overlayOpen
            ? "fixed inset-y-0 left-0 z-40 translate-x-0 bg-background"
            : "fixed inset-y-0 left-0 z-40 -translate-x-full bg-background"
          : "translate-x-0",
        overlayClosed && "pointer-events-none"
      )}
      aria-hidden={overlayClosed}
      inert={overlayClosed ? true : undefined}
    >
      <div className="px-4 py-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            History
          </h2>
          <button
            type="button"
            onClick={onNew}
            className="rounded border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-primary transition-colors hover:bg-muted"
          >
            New
          </button>
        </div>
      </div>
      {loading ? (
        <p className="px-4 text-xs text-muted-foreground">Loading...</p>
      ) : history.length === 0 ? (
        <p className="px-4 text-xs text-muted-foreground">
          No image runs yet for this channel.
        </p>
      ) : (
        <ul>
          {history.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => onSelect(entry.id)}
                className={cn(
                  "block w-full px-4 py-3 text-left text-sm transition-colors hover:bg-accent/40",
                  selectedId === entry.id && "bg-accent/60"
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="line-clamp-1 text-foreground">{entry.title}</span>
                  {entry.status !== "completed" && (
                    <span
                      className={cn(
                        "font-mono text-[10px] uppercase tracking-wider",
                        entry.status === "failed"
                          ? "text-destructive"
                          : "text-amber-600 dark:text-amber-400"
                      )}
                    >
                      {entry.status}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{entry.mode}</span>
                  <span>{entry.sampleCount} sample{entry.sampleCount === 1 ? "" : "s"}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {relTime(entry.startedAt)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function SegmentedCount({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="inline-flex h-8 rounded-md border border-border p-0.5">
      {[1, 2, 3, 4].map((count) => (
        <button
          key={count}
          type="button"
          onClick={() => onChange(count)}
          className={cn(
            "h-7 min-w-7 rounded px-2 text-xs transition-colors",
            value === count
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted"
          )}
          title={`${count} sample${count === 1 ? "" : "s"}`}
        >
          {count}
        </button>
      ))}
    </div>
  );
}

function RunResults({
  run,
  aspectRatio,
  onRefresh,
}: {
  run: RunView;
  aspectRatio: string;
  onRefresh: () => void | Promise<void>;
}) {
  const maxRank = Math.max(run.sampleCount, ...run.candidates.map((c) => c.rank), 1);
  const runTitle = run.title ?? run.prompt;
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-muted/10 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">{runTitle}</h2>
          </div>
          <span className="text-xs text-muted-foreground">
            {run.candidates.length}/{run.sampleCount} planned
          </span>
        </div>
        <RunPipelineStatus run={run} />
        {run.attachments.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {run.attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="animate-in fade-in zoom-in-95 overflow-hidden rounded-md border border-border bg-card"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={attachment.previewUrl}
                  alt={attachment.fileName}
                  className="h-16 w-24 object-cover"
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: maxRank }, (_, index) => index + 1).map((rank) => {
          const candidate = run.candidates.find((c) => c.rank === rank) ?? null;
          return (
            <CandidateCard
              key={rank}
              rank={rank}
              candidate={candidate}
              aspectRatio={aspectRatio}
              runTitle={runTitle}
              sampleCount={maxRank}
              onFeedbackSaved={onRefresh}
            />
          );
        })}
      </div>

      <ReferenceStrip references={run.references} topicKey={run.title ?? run.prompt} onRefresh={onRefresh} />
    </div>
  );
}

function RunPipelineStatus({ run }: { run: RunView }) {
  const completed = run.candidates.filter((candidate) => candidate.status === "completed").length;
  const failed = run.candidates.filter((candidate) => candidate.status === "failed").length;
  const sourceCount = Math.max(
    run.references.length,
    ...run.candidates.map((candidate) => candidate.sourceImages.length),
    0
  );
  const planned = run.candidates.length;
  const total = run.sampleCount;
  const renderLabel = total === 4 ? "Rendering 4 edits" : `Rendering ${total} edits`;
  const plannerFailed =
    run.status === "failed" &&
    (run.errorCategory === "planner_timeout" ||
      run.errorCategory === "planner_failed" ||
      run.candidates.length === 0);
  const renderFailed = run.status === "failed" && !plannerFailed;
  const stages: Array<{
    label: string;
    detail: string;
    state: "done" | "active" | "pending" | "failed";
  }> = [
    {
      label: "Sources found",
      detail: sourceCount > 0 ? `${sourceCount} thumbnail${sourceCount === 1 ? "" : "s"}` : "choosing",
      state: sourceCount > 0 ? "done" : plannerFailed ? "failed" : run.phase === "planning" ? "active" : "pending",
    },
    {
      label: "Prompts planned",
      detail: `${planned}/${total} ready`,
      state:
        planned >= total
          ? "done"
          : plannerFailed
            ? "failed"
            : run.phase === "planning"
              ? "active"
              : "pending",
    },
    {
      label: renderLabel,
      detail: `${completed + failed}/${total} finished`,
      state:
        renderFailed
          ? "failed"
          : completed >= total
            ? "done"
            : run.phase === "rendering" && planned > 0
              ? "active"
              : "pending",
    },
    {
      label: "Review results",
      detail:
        run.phase === "completed"
          ? "accepted"
          : run.status === "completed"
            ? "ready"
            : run.status === "failed"
              ? "needs attention"
              : "waiting",
      state:
        run.phase === "completed" || run.status === "completed"
          ? "done"
          : renderFailed
            ? "failed"
            : "pending",
    },
  ];

  return (
    <div className="mt-4 border-t border-border/70 pt-4" aria-label="Thumbnail pipeline">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        Thumbnail pipeline
      </div>
      <div className="grid gap-2 md:grid-cols-4">
        {stages.map((stage) => (
          <div
            key={stage.label}
            className={cn(
              "rounded-md border bg-background px-2.5 py-2",
              stage.state === "done" && "border-border",
              stage.state === "active" && "border-border shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.04)]",
              stage.state === "failed" && "border-destructive/35",
              stage.state === "pending" && "border-border bg-background/40"
            )}
          >
            <div className="flex items-center gap-2">
              {stage.state === "done" ? (
                <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : stage.state === "failed" ? (
                <XCircle className="h-3.5 w-3.5 text-destructive" />
              ) : stage.state === "active" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              ) : (
                <span className="h-3.5 w-3.5 rounded-full border border-muted-foreground/40" />
              )}
              <span className="text-xs font-medium text-foreground">{stage.label}</span>
            </div>
            <div className="mt-1 pl-5 text-[11px] text-muted-foreground">{stage.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReferenceStrip({
  references,
  topicKey,
  onRefresh,
}: {
  references: ImageReference[];
  topicKey: string;
  onRefresh: () => void | Promise<void>;
}) {
  if (references.length === 0) return null;
  return (
    <section className="rounded-md border border-border bg-muted/10 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Source candidates
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {references.length} found
        </span>
      </div>
      <div className="grid items-stretch gap-2 min-[520px]:grid-cols-2 xl:grid-cols-4">
        {references.slice(0, 8).map((ref) => (
          <SourceCard
            key={ref.id}
            refItem={ref}
            topicKey={topicKey}
            onRefresh={onRefresh}
          />
        ))}
      </div>
    </section>
  );
}

function SourceCard({
  refItem,
  topicKey,
  onRefresh,
}: {
  refItem: ImageReference;
  topicKey: string;
  onRefresh: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState(refItem.feedbackReason ?? "");
  const [localFeedback, setLocalFeedback] = useState<
    "liked" | "disliked" | null
  >(refItem.feedback ?? null);
  const [saving, setSaving] = useState<"liked" | "disliked" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const metaText = sourceScoreText(refItem);

  const save = async (feedback: "liked" | "disliked") => {
    setSaving(feedback);
    setError(null);
    try {
      const res = await fetch("/api/image-sources/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: refItem,
          feedback,
          reason,
          topicKey,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setLocalFeedback(feedback);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "source feedback failed");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div
      className={cn(
        "flex h-full min-h-[17rem] flex-col overflow-hidden rounded-md border bg-card transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-0.5",
        localFeedback === "liked"
          ? "border-emerald-500/45 shadow-[0_0_0_1px_rgba(16,185,129,0.18)]"
          : localFeedback === "disliked"
            ? "border-destructive/45 opacity-70"
            : "border-border"
      )}
    >
      <YouTubeThumbnail
        videoId={refItem.videoId ?? ""}
        src={refItem.thumbnailUrl}
        alt={refItem.title}
        className="aspect-video w-full border-b border-border object-cover"
      />
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <div className="flex min-h-5 flex-wrap content-start gap-1">
          {displaySourceLabels(refItem).map((label) => (
            <span
              key={label}
              className="rounded border border-border bg-muted/30 px-1.5 py-0.5 text-[9px] font-medium uppercase text-muted-foreground"
            >
              {label}
            </span>
          ))}
        </div>
        <div className="line-clamp-2 min-h-8 text-[11px] font-medium leading-snug">{refItem.title}</div>
        <div className="line-clamp-2 min-h-8 text-[10px] leading-snug text-muted-foreground">
          {metaText}
        </div>
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Note"
          rows={1}
          className="mt-auto min-h-[2.25rem] resize-none text-[11px]"
        />
        <div className="flex gap-1.5">
          <Button
            type="button"
            size="sm"
            variant={localFeedback === "liked" ? "default" : "outline"}
            className="h-6 flex-1 text-[11px]"
            onClick={() => save("liked")}
            disabled={!!saving}
          >
            {saving === "liked" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ThumbsUp className="h-3.5 w-3.5" />
            )}
            Like
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={cn(
              "h-6 flex-1 text-[11px]",
              localFeedback === "disliked" && "border-destructive/50 text-destructive"
            )}
            onClick={() => save("disliked")}
            disabled={!!saving}
          >
            {saving === "disliked" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ThumbsDown className="h-3.5 w-3.5" />
            )}
            Dislike
          </Button>
        </div>
        {error && <p className="text-[11px] text-destructive">{error}</p>}
      </div>
    </div>
  );
}

function CandidateCard({
  rank,
  candidate,
  aspectRatio,
  runTitle,
  sampleCount,
  onFeedbackSaved,
}: {
  rank: number;
  candidate: Candidate | null;
  aspectRatio: string;
  runTitle: string;
  sampleCount: number;
  onFeedbackSaved: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState<"accepted" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saveFeedback = async (feedback: "accepted" | "rejected") => {
    if (!candidate) return;
    setSaving(feedback);
    setError(null);
    try {
      const res = await fetch(`/api/image-candidates/${candidate.id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback, reason }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setReason("");
      await onFeedbackSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Feedback failed");
    } finally {
      setSaving(null);
    }
  };

  return (
    <article className="overflow-hidden rounded-md border border-border bg-card">
      <div className="relative bg-black" style={{ aspectRatio: cssAspectRatio(aspectRatio) }}>
        {candidate?.imageUrl ? (
          // Generated images are local API responses; plain img keeps this simple and cacheable.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={candidate.imageUrl}
            alt={runTitle}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-white/70">
            {candidate?.status === "failed" ? (
              <XCircle className="h-6 w-6" />
            ) : candidate?.status === "processing" ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <ImageIcon className="h-6 w-6" />
            )}
            <span className="text-[11px]">
              {candidate?.status === "failed"
                ? sampleCount > 1
                  ? "Option failed"
                  : "Generation failed"
                : candidate?.status === "processing"
                  ? "Generating"
                  : "Waiting"}
            </span>
          </div>
        )}
      </div>

      <div className="space-y-2.5 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">
              {sampleCount > 1 ? `Option ${rank}` : "Result"}
            </h3>
          </div>
          {candidate?.feedback && (
            <span
              className={cn(
                "rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                candidate.feedback === "accepted"
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "bg-destructive/10 text-destructive"
              )}
            >
              {candidate.feedback}
            </span>
          )}
        </div>

        {candidate?.error && (
          <details
            className={cn(
              "rounded-md border px-2 py-1.5 text-[11px]",
              imageErrorBoxClass(candidate.error)
            )}
          >
            <summary className={cn("cursor-pointer", imageErrorSummaryClass(candidate.error))}>
              {imageErrorSummary(candidate.error)}
            </summary>
            <p className="mt-2 text-muted-foreground">
              {displayImageError(candidate.error)}
            </p>
          </details>
        )}

        {candidate && <ProcessPanel candidate={candidate} />}

        {candidate?.status === "completed" && (
          <div className="space-y-1.5">
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Feedback"
              rows={1}
              className="min-h-[2.25rem] resize-none text-[11px]"
            />
            <div className="flex gap-1.5">
              <Button
                type="button"
                size="sm"
                className="h-7 flex-1 text-xs"
                onClick={() => saveFeedback("accepted")}
                disabled={!!saving}
              >
                {saving === "accepted" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ThumbsUp className="h-4 w-4" />
                )}
                Accept
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 flex-1 text-xs"
                onClick={() => saveFeedback("rejected")}
                disabled={!!saving}
              >
                {saving === "rejected" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ThumbsDown className="h-4 w-4" />
                )}
                Reject
              </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}
      </div>
    </article>
  );
}

function ProcessPanel({ candidate }: { candidate: Candidate }) {
  const plannedPrompt = candidate.prompt?.trim() || "";
  const attempts = candidate.providerAttempts ?? [];
  const primarySource = candidate.sourceImages[0] ?? null;
  const primarySourceMeta = primarySource ? sourceScoreText(primarySource) : "";
  const finalAttempt =
    attempts
      .slice()
      .reverse()
      .find((attempt) => attempt.jobId && attempt.jobId === candidate.jobId) ??
    attempts.at(-1) ??
    null;
  const promptUsed = plannedPrompt || finalAttempt?.promptPreview?.trim() || "";
  const sourceFreeRetry = finalAttempt?.attemptType === "source_free_retry";
  const providerLine = finalAttempt
    ? [
        finalAttempt.model || candidate.model,
        finalAttempt.jobId ? `job ${finalAttempt.jobId.slice(0, 8)}` : null,
        finalAttempt.attemptType.replace(/_/g, " "),
      ]
        .filter(Boolean)
        .join(" · ")
    : candidate.model || candidate.jobId
      ? [candidate.model, candidate.jobId ? `job ${candidate.jobId.slice(0, 8)}` : null]
          .filter(Boolean)
          .join(" · ")
      : "";
  const hasDetails =
    !!promptUsed ||
    sourceFreeRetry ||
    !!providerLine ||
    !!finalAttempt?.error ||
    candidate.sourceImages.length > 0;
  if (!hasDetails) return null;
  return (
    <div className="rounded-md border border-border bg-muted/15 p-2 text-[11px]">
      {providerLine && (
        <div className="mb-1 font-mono text-[9px] uppercase text-muted-foreground">
          {providerLine}
        </div>
      )}
      {sourceFreeRetry && (
        <p className="text-amber-600 dark:text-amber-300">Source-free retry after reference failure.</p>
      )}
      {finalAttempt?.error && (
        <p className={cn("text-muted-foreground", sourceFreeRetry ? "mt-2" : "")}>
          Last provider message: {displayImageError(finalAttempt.error)}
        </p>
      )}
      {promptUsed && (
        <div className={sourceFreeRetry || finalAttempt?.error ? "mt-2" : ""}>
          <div className="mb-1 font-mono text-[9px] uppercase text-muted-foreground">
            Prompt used
          </div>
          <p className="max-h-16 overflow-auto text-muted-foreground">
            {promptUsed}
          </p>
        </div>
      )}
      {primarySource && (
        <div className={promptUsed || sourceFreeRetry ? "mt-2" : ""}>
          <div className="grid grid-cols-[5.25rem_1fr] gap-2">
            <YouTubeThumbnail
              videoId={primarySource.videoId ?? ""}
              src={primarySource.thumbnailUrl}
              alt={primarySource.title}
              className="aspect-video rounded border border-border object-cover"
            />
            <div className="min-w-0">
              <div className="font-mono text-[9px] uppercase text-muted-foreground">
                Original thumbnail
              </div>
              <div className="line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                {primarySourceMeta}
              </div>
              <div className="line-clamp-1 text-[10px] font-medium text-foreground/80">
                {primarySource.title}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
