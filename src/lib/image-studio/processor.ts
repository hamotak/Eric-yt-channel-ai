import "server-only";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DATA_DIR,
  db,
  getActiveChannelId,
  getChannel,
  resolveChannelDescription,
} from "@/lib/db";
import { log } from "@/lib/logger";
import { directImageDirections, planImageDirections } from "./planner";
import { pickPrimaryImageReference, selectImageReferences } from "./references";
import {
  chooseImageModel,
  downloadImageJob,
  formatImageJobFailure,
  getImageLimits,
  getImageJobStatus,
  imageJobFailureMessage,
  isTerminalImageStatus,
  submitImageJob,
} from "./sixty-nine-labs";
import type {
  ImageAttachment,
  ImageCandidateRow,
  ImageDirection,
  ImageFeedback,
  ImageFeedbackRuleRow,
  ImageGenerationMode,
  ImagePlannerUsage,
  ImagePlanningResult,
  ImageProviderAttempt,
  ImageReference,
  ImageRunErrorCategory,
  ImageRunMode,
  ImageRunPhase,
  ImageRunRow,
  ImageRunStatus,
} from "./types";

const POLL_INTERVAL_MS = 3500;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_IMAGE_URLS_PER_CANDIDATE = 2;
const MAX_PROVIDER_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCE_PROVIDER_PROMPT_CHARS = 350;
const IMAGE_PROVIDER_SUBMIT_SPACING_MS = 4000;
const IMAGE_PROVIDER_RATE_LIMIT_RETRY_MS = 10000;
const IMAGE_PROVIDER_MAX_RATE_LIMIT_RETRIES = 36;
const IMAGE_PROVIDER_RATE_LIMIT_RETRY_MAX_MS = 2 * 60 * 1000;
const IMAGE_PROVIDER_BUSY_MESSAGE =
  "Image provider is busy. Wait for current image jobs to finish, then retry.";
const IMAGE_PROVIDER_RATE_LIMIT_MESSAGE =
  "Image provider rate-limited this request. Wait a moment, then retry.";
const INTERRUPTED_RUN_RESUME_MS = 45 * 1000;

const ASPECT_RATIOS = new Set(["16:9", "1:1", "9:16", "4:5", "3:2", "2:3"]);
const RESOLUTIONS = new Set(["1k", "2k", "4k"]);
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const activeImageRunPipelines = new Set<string>();

type UploadedAttachment = {
  fileName: string;
  contentType: string;
  bytes: Buffer;
};

type CreateRunInput = {
  prompt: string;
  sourceIdeaId?: string | null;
  sampleCount?: number;
  aspectRatio?: string;
  resolution?: string;
  aiAssist?: boolean;
  generationMode?: ImageGenerationMode;
  attachments?: UploadedAttachment[];
};

export type ImageRunHistoryEntry = {
  id: string;
  mode: ImageRunMode;
  status: ImageRunRow["status"];
  phase: ImageRunPhase;
  errorCategory: ImageRunErrorCategory | null;
  title: string;
  sampleCount: number;
  startedAt: string;
  completedAt: string | null;
};

export type ImageRunView = {
  id: string;
  status: ImageRunRow["status"];
  phase: ImageRunPhase;
  errorCategory: ImageRunErrorCategory | null;
  mode: ImageRunMode;
  generationMode: ImageGenerationMode;
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
  attachments: Array<ImageAttachment & { previewUrl: string }>;
  learnedRules: ImageFeedbackRuleRow[];
  candidates: Array<{
    id: string;
    rank: number;
    status: ImageCandidateRow["status"];
    imageUrl: string | null;
    sourceImages: ImageReference[];
    prompt: string | null;
    rationale: string | null;
    changes: string | null;
    critique: string | null;
    feedback: ImageFeedback | null;
    feedbackReason: string | null;
    error: string | null;
    model: string | null;
    resolution: string | null;
    jobId: string | null;
    providerAttempts: ImageProviderAttempt[];
  }>;
};

export type ImagePlanPreview = {
  status: "planned";
  renderer: {
    provider: "69labs";
    submitted: false;
  };
  mode: ImageRunMode;
  generationMode: ImageGenerationMode;
  prompt: string;
  title: string | null;
  sampleCount: number;
  aspectRatio: string;
  resolution: string;
  references: ImageReference[];
  directions: ImageDirection[];
  plannerUsage: ImagePlannerUsage | null;
};

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function normalizeRunPhase(value: string | null | undefined, status: ImageRunStatus): ImageRunPhase {
  if (
    value === "planning" ||
    value === "rendering" ||
    value === "reviewing" ||
    value === "completed" ||
    value === "failed"
  ) {
    return value;
  }
  if (status === "failed") return "failed";
  if (status === "completed") return "reviewing";
  return "planning";
}

function normalizeErrorCategory(
  value: string | null | undefined
): ImageRunErrorCategory | null {
  if (
    value === "planner_timeout" ||
    value === "planner_failed" ||
    value === "provider_capacity" ||
    value === "provider_rejected" ||
    value === "provider_timeout" ||
    value === "download_failed" ||
    value === "provider_failed" ||
    value === "unknown"
  ) {
    return value;
  }
  return null;
}

function isPlannerTimeoutMessage(message: string): boolean {
  return /image planner timed out|anthropic.*timed out|request timed out|planner.*timeout/i.test(
    message
  );
}

function classifyImageRunError(input: {
  message: string;
  phase?: ImageRunPhase | null;
  candidatesCreated?: boolean;
}): ImageRunErrorCategory {
  const message = input.message;
  const lower = message.toLowerCase();
  const beforeProvider = !input.candidatesCreated && input.phase !== "rendering";
  if (beforeProvider && isPlannerTimeoutMessage(message)) return "planner_timeout";
  if (beforeProvider && lower.includes("claude")) return "planner_failed";
  if (isProviderRateLimitError(message)) return "provider_capacity";
  if (lower.includes("download")) return "download_failed";
  if (
    lower.includes("took too long") ||
    lower.includes("polling timeout") ||
    lower.includes("job exceeded") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return beforeProvider ? "planner_timeout" : "provider_timeout";
  }
  if (
    lower.includes("restricted") ||
    lower.includes("misclassified") ||
    lower.includes("censored") ||
    lower.includes("internal generation pipeline")
  ) {
    return "provider_rejected";
  }
  if (lower.includes("image provider") || lower.includes("69labs")) {
    return "provider_failed";
  }
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampSampleCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(4, Math.round(value ?? 1)));
}

function normalizeAspectRatio(value: string | undefined): string {
  const ratio = value?.trim() || "16:9";
  return ASPECT_RATIOS.has(ratio) ? ratio : "16:9";
}

function normalizeResolution(value: string | undefined): string {
  const resolution = value?.trim().toLowerCase() || "1k";
  return RESOLUTIONS.has(resolution) ? resolution : "1k";
}

function runRequiresReference(run: Pick<ImageRunRow, "mode" | "generation_mode">): boolean {
  return run.mode === "ideate" || run.generation_mode === "remix";
}

function runNeedsPlanning(run: Pick<ImageRunRow, "ai_assist" | "mode">): boolean {
  return run.ai_assist === 1 || run.mode === "ideate";
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("gif")) return "gif";
  return "png";
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\n+/)[0]?.trim() ?? "";
  return firstLine.length > 64 ? `${firstLine.slice(0, 61).trimEnd()}...` : firstLine;
}

function getIdeaTitle(sourceIdeaId: string | null): string | null {
  if (!sourceIdeaId) return null;
  const row = db
    .prepare(`SELECT title FROM ideas WHERE id = ?`)
    .get(sourceIdeaId) as { title: string } | undefined;
  return row?.title ?? null;
}

async function saveAttachments(
  runId: string,
  uploads: UploadedAttachment[]
): Promise<ImageAttachment[]> {
  const saved: ImageAttachment[] = [];
  for (const upload of uploads.slice(0, 4)) {
    if (!upload.contentType.startsWith("image/")) continue;
    if (upload.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${upload.fileName} exceeds the 8MB attachment limit`);
    }
    const id = crypto.randomUUID();
    const ext = extensionForContentType(upload.contentType);
    const relativeDir = path.join("image-attachments", runId);
    const dir = path.join(DATA_DIR, relativeDir);
    await fs.mkdir(dir, { recursive: true });
    const relativePath = path.join(relativeDir, `${id}.${ext}`);
    await fs.writeFile(path.join(DATA_DIR, relativePath), upload.bytes);
    saved.push({
      id,
      fileName: upload.fileName,
      contentType: upload.contentType,
      size: upload.bytes.length,
      path: relativePath,
    });
  }
  return saved;
}

function insertRun(input: {
  id: string;
  userChannelId: string;
  prompt: string;
  title: string | null;
  sourceIdeaId: string | null;
  sampleCount: number;
  aspectRatio: string;
  resolution: string;
  aiAssist: boolean;
  mode: ImageRunMode;
  generationMode: ImageGenerationMode;
  attachments: ImageAttachment[];
}): void {
  db.prepare(
    `INSERT INTO image_runs
     (id, user_channel_id, source_idea_id, mode, generation_mode, input_prompt,
        title, sample_count, aspect_ratio, resolution, ai_assist, attachments_json, status, phase, error_category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 'planning', NULL)`
  ).run(
    input.id,
    input.userChannelId,
    input.sourceIdeaId,
    input.mode,
    input.generationMode,
    input.prompt,
    input.title,
    input.sampleCount,
    input.aspectRatio,
    input.resolution,
    input.aiAssist ? 1 : 0,
    JSON.stringify(input.attachments)
  );
}

function updateRunProcessingContext(input: {
  runId: string;
  references: ImageReference[];
  channelSnapshot: unknown;
  learnedRules: ImageFeedbackRuleRow[];
}): void {
  db.prepare(
    `UPDATE image_runs
     SET selected_references_json = ?,
         channel_snapshot_json = ?,
         learned_rules_json = ?,
         phase = 'rendering',
         error_category = NULL,
         error = NULL
     WHERE id = ?`
  ).run(
    JSON.stringify(input.references),
    JSON.stringify(input.channelSnapshot),
    JSON.stringify(input.learnedRules),
    input.runId
  );
}

function markRunPhase(runId: string, phase: ImageRunPhase): void {
  db.prepare(
    `UPDATE image_runs
     SET phase = ?,
         error_category = NULL
     WHERE id = ?`
  ).run(phase, runId);
}

function markRunProcessing(runId: string): void {
  db.prepare(
    `UPDATE image_runs
     SET status = 'processing',
         phase = 'rendering',
         completed_at = NULL,
         error = NULL,
         error_category = NULL
     WHERE id = ?`
  ).run(runId);
}

function markRunCompleted(runId: string): void {
  db.prepare(
    `UPDATE image_runs
     SET status = 'completed', phase = 'reviewing', completed_at = ?, error = NULL, error_category = NULL
     WHERE id = ?`
  ).run(nowSql(), runId);
}

function markRunFailed(
  runId: string,
  error: string,
  category: ImageRunErrorCategory = "unknown"
): void {
  db.prepare(
    `UPDATE image_runs
     SET status = 'failed', phase = 'failed', completed_at = ?, error = ?, error_category = ?
     WHERE id = ?`
  ).run(nowSql(), normalizeImageErrorText(error).slice(0, 1000), category, runId);
}

function readLearnedRules(userChannelId: string): ImageFeedbackRuleRow[] {
  return db
    .prepare(
      `SELECT * FROM image_feedback_rules
       WHERE user_channel_id = ?
       ORDER BY created_at DESC
       LIMIT 30`
    )
    .all(userChannelId) as ImageFeedbackRuleRow[];
}

function readCurrentVideos(userChannelId: string): Array<{
  title: string;
  views: number | null;
  thumbnailUrl: string | null;
}> {
  return db
    .prepare(
      `SELECT title, views, thumbnail_url AS thumbnailUrl
       FROM videos
       WHERE channel_id = ?
       ORDER BY COALESCE(published_at, imported_at) DESC
       LIMIT 12`
    )
    .all(userChannelId) as Array<{
    title: string;
    views: number | null;
    thumbnailUrl: string | null;
  }>;
}

function readRecentIdeas(userChannelId: string): Array<{
  title: string;
  score: number | null;
  method: string | null;
}> {
  const rows = db
    .prepare(
      `SELECT i.title, i.fit_score AS score, i.source_attribution
       FROM ideas i
       JOIN generations g ON g.id = i.generation_id
       WHERE g.user_channel_id = ?
       ORDER BY i.created_at DESC
       LIMIT 12`
    )
    .all(userChannelId) as Array<{
    title: string;
    score: number | null;
    source_attribution: string | null;
  }>;
  return rows.map((row) => {
    let method: string | null = null;
    try {
      const parsed = row.source_attribution
        ? (JSON.parse(row.source_attribution) as { method?: unknown })
        : null;
      method = typeof parsed?.method === "string" ? parsed.method : null;
    } catch {
      method = null;
    }
    return { title: row.title, score: row.score, method };
  });
}

type ChannelStyleExample = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  views: number;
  medianViews: number;
  multiplier: number;
  publishedAt: number | null;
  outcome: "winner" | "loser";
};

function readChannelStyleExamples(userChannelId: string): ChannelStyleExample[] {
  const medianRow = db
    .prepare(
      `WITH ordered AS (
         SELECT views,
                ROW_NUMBER() OVER (ORDER BY views) AS rn,
                COUNT(*) OVER () AS cnt
         FROM videos
         WHERE channel_id = ?
           AND views > 0
       )
       SELECT AVG(views) AS median
       FROM ordered
       WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)`
    )
    .get(userChannelId) as { median: number | null } | undefined;
  const medianViews = Math.round(medianRow?.median ?? 0);
  if (medianViews <= 0) return [];
  const rows = db
    .prepare(
      `SELECT id, title, thumbnail_url AS thumbnailUrl,
              COALESCE(views, 0) AS views,
              published_at AS publishedAt,
              (COALESCE(views, 0) * 1.0 / ?) AS multiplier
       FROM videos
       WHERE channel_id = ?
         AND published_at IS NOT NULL
         AND published_at >= strftime('%s','now') - 30 * 86400
         AND views > 0
       ORDER BY published_at DESC`
    )
    .all(medianViews, userChannelId) as Array<{
    id: string;
    title: string;
    thumbnailUrl: string | null;
    views: number;
    publishedAt: number | null;
    multiplier: number;
  }>;
  const toExample = (
    row: (typeof rows)[number],
    outcome: ChannelStyleExample["outcome"]
  ): ChannelStyleExample => ({
    videoId: row.id,
    title: row.title,
    thumbnailUrl: row.thumbnailUrl,
    views: row.views,
    medianViews,
    multiplier: Number(row.multiplier.toFixed(2)),
    publishedAt: row.publishedAt,
    outcome,
  });
  const winners = rows
    .filter((row) => row.multiplier >= 1)
    .sort((a, b) => b.multiplier - a.multiplier || b.views - a.views)
    .slice(0, 6)
    .map((row) => toExample(row, "winner"));
  const losers = rows
    .filter((row) => row.multiplier < 1)
    .sort((a, b) => a.multiplier - b.multiplier || a.views - b.views)
    .slice(0, 6)
    .map((row) => toExample(row, "loser"));
  return [...winners, ...losers];
}

function insertCandidate(input: {
  id: string;
  runId: string;
  direction: ImageDirection;
  refs: ImageReference[];
}): void {
  db.prepare(
    `INSERT INTO image_candidates
       (id, run_id, rank, status, source_images_json, prompt, rationale, changes, critique)
     VALUES (?, ?, ?, 'processing', ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.runId,
    input.direction.rank,
    JSON.stringify(input.refs),
    input.direction.prompt,
    input.direction.rationale,
    input.direction.changes,
    input.direction.critique
  );
}

function markCandidateJob(input: {
  candidateId: string;
  jobId: string;
  model: string;
  resolution: string;
}): void {
  db.prepare(
    `UPDATE image_candidates
     SET job_id = ?, model = ?, resolution = ?
     WHERE id = ?`
  ).run(input.jobId, input.model, input.resolution, input.candidateId);
}

function providerPromptHash(prompt: string): string {
  return crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

type ProviderImagePayload = NonNullable<ImageProviderAttempt["imagePayloads"]>[number];

async function providerImagePayloadFromUrl(url: string): Promise<{
  submittedUrl: string;
  metadata: ProviderImagePayload;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
        "User-Agent": "ytmanager-image-studio/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`source thumbnail fetch failed (${response.status})`);
    }
    const mimeType = (response.headers.get("content-type") ?? "image/jpeg")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith("image/")) {
      throw new Error(`source thumbnail did not return an image (${mimeType || "unknown"})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("source thumbnail fetch returned empty bytes");
    if (bytes.length > MAX_PROVIDER_REFERENCE_BYTES) {
      throw new Error("source thumbnail exceeds provider reference image size limit");
    }
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const submittedUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
    return {
      submittedUrl,
      metadata: {
        sourceUrl: url,
        submittedKind: "data_url",
        mimeType,
        byteSize: bytes.length,
        sha256,
        submittedPreview: `data:${mimeType};base64,sha256:${sha256.slice(0, 16)}`,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "source thumbnail fetch failed";
    throw new Error(`Could not attach source thumbnail for provider: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function prepareProviderImagePayloads(imageUrls: string[]): Promise<{
  submittedUrls: string[];
  metadata: ProviderImagePayload[];
}> {
  const payloads = await Promise.all(
    imageUrls.map((url) => providerImagePayloadFromUrl(url))
  );
  return {
    submittedUrls: payloads.map((payload) => payload.submittedUrl),
    metadata: payloads.map((payload) => payload.metadata),
  };
}

async function waitForProviderCreationSlot(input: {
  candidateId: string;
  attemptType: ImageProviderAttempt["attemptType"];
}): Promise<void> {
  let logged = false;
  for (let attempt = 0; attempt < IMAGE_PROVIDER_MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const limits = await getImageLimits().catch(() => null);
    if (
      !limits ||
      typeof limits.remainingJobs !== "number" ||
      limits.remainingJobs > 0
    ) {
      return;
    }
    if (!logged) {
      log.warn("image-studio", "69labs image slots are full; waiting before creating another job", {
        candidateId: input.candidateId,
        attemptType: input.attemptType,
        activeJobs: limits.activeJobs,
        maxConcurrentJobs: limits.maxConcurrentJobs,
      });
      logged = true;
    }
    await sleep(5000);
  }
}

function appendProviderAttempt(input: {
  candidateId: string;
  attemptType: ImageProviderAttempt["attemptType"];
  model: string;
  prompt: string;
  imageUrls: string[];
  referenceIds: string[];
  imagePayloads?: ProviderImagePayload[];
}): void {
  const row = db
    .prepare(`SELECT provider_attempts_json FROM image_candidates WHERE id = ?`)
    .get(input.candidateId) as { provider_attempts_json: string | null } | undefined;
  const attempts = safeJson<ImageProviderAttempt[]>(
    row?.provider_attempts_json,
    []
  );
  const attempt: ImageProviderAttempt = {
    attemptType: input.attemptType,
    model: input.model,
    promptPreview: compactPromptText(input.prompt, 300),
    promptHash: providerPromptHash(input.prompt),
    imageUrls: input.imageUrls,
    referenceIds: input.referenceIds,
    imagePayloads: input.imagePayloads ?? [],
    submittedAt: nowSql(),
    jobId: null,
  };
  db.prepare(
    `UPDATE image_candidates
     SET provider_attempts_json = ?
     WHERE id = ?`
  ).run(JSON.stringify([...attempts, attempt]), input.candidateId);
}

function markLatestProviderAttemptJob(input: {
  candidateId: string;
  jobId: string;
}): void {
  const row = db
    .prepare(`SELECT provider_attempts_json FROM image_candidates WHERE id = ?`)
    .get(input.candidateId) as { provider_attempts_json: string | null } | undefined;
  const attempts = safeJson<ImageProviderAttempt[]>(
    row?.provider_attempts_json,
    []
  );
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]?.jobId) continue;
    attempts[index] = { ...attempts[index], jobId: input.jobId };
    break;
  }
  db.prepare(
    `UPDATE image_candidates
     SET provider_attempts_json = ?
     WHERE id = ?`
  ).run(JSON.stringify(attempts), input.candidateId);
}

function markLatestProviderAttemptPayloads(input: {
  candidateId: string;
  imagePayloads: ProviderImagePayload[];
}): void {
  const row = db
    .prepare(`SELECT provider_attempts_json FROM image_candidates WHERE id = ?`)
    .get(input.candidateId) as { provider_attempts_json: string | null } | undefined;
  const attempts = safeJson<ImageProviderAttempt[]>(
    row?.provider_attempts_json,
    []
  );
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if ((attempts[index]?.imagePayloads ?? []).length > 0) continue;
    attempts[index] = { ...attempts[index], imagePayloads: input.imagePayloads };
    break;
  }
  db.prepare(
    `UPDATE image_candidates
     SET provider_attempts_json = ?
     WHERE id = ?`
  ).run(JSON.stringify(attempts), input.candidateId);
}

function markLatestProviderAttemptError(input: {
  candidateId: string;
  error: string;
}): void {
  const row = db
    .prepare(`SELECT provider_attempts_json FROM image_candidates WHERE id = ?`)
    .get(input.candidateId) as { provider_attempts_json: string | null } | undefined;
  const attempts = safeJson<ImageProviderAttempt[]>(
    row?.provider_attempts_json,
    []
  );
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]?.error) continue;
    attempts[index] = {
      ...attempts[index],
      error: compactPromptText(normalizeImageErrorText(input.error), 300),
    };
    break;
  }
  db.prepare(
    `UPDATE image_candidates
     SET provider_attempts_json = ?
     WHERE id = ?`
  ).run(JSON.stringify(attempts), input.candidateId);
}

function markCandidateCompleted(input: {
  candidateId: string;
  imagePath: string;
}): void {
  db.prepare(
    `UPDATE image_candidates
     SET status = 'completed', image_path = ?, completed_at = ?, error = NULL
     WHERE id = ?`
  ).run(input.imagePath, nowSql(), input.candidateId);
}

function markCandidateProcessing(candidateId: string): void {
  db.prepare(
    `UPDATE image_candidates
     SET status = 'processing', job_id = NULL, model = NULL, resolution = NULL,
         completed_at = NULL, error = NULL
     WHERE id = ?`
  ).run(candidateId);
}

function markCandidateWaitingForCapacity(candidateId: string): void {
  db.prepare(
    `UPDATE image_candidates
     SET status = 'processing', completed_at = NULL, error = NULL
     WHERE id = ?`
  ).run(candidateId);
}

function markCandidateFailed(candidateId: string, error: string): void {
  db.prepare(
    `UPDATE image_candidates
     SET status = 'failed', completed_at = ?, error = ?
     WHERE id = ?`
  ).run(nowSql(), normalizeImageErrorText(error).slice(0, 1000), candidateId);
}

function markCandidateRetry(input: {
  candidateId: string;
  note?: string;
}): void {
  db.prepare(
    `UPDATE image_candidates
     SET changes = ?
     WHERE id = ?`
  ).run(
    input.note ??
      "Simplified source-free retry after the provider failed the reference attempt.",
    input.candidateId
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value || "image job failed");
}

function normalizeProviderRateLimitText(message: string): string {
  return message
    .replace(
      /69labs\s+403:\s*Concurrent image generation limit reached(?:\s*\(\d+\))?\.?\s*Please wait for current jobs to complete\.?/gi,
      IMAGE_PROVIDER_BUSY_MESSAGE
    )
    .replace(
      /69labs\s+429:\s*Too many requests\.?/gi,
      IMAGE_PROVIDER_RATE_LIMIT_MESSAGE
    );
}

function basicNormalizeImageErrorText(message: string): string {
  return normalizeProviderRateLimitText(message)
    .replace(/Fallback model [^:]+ failed: .*? Retry failed:/g, "Retry failed:")
    .replace(/\.\s*\.\s*First attempt:/g, ". First attempt:")
    .trim();
}

function trimTrailingSentencePunctuation(message: string): string {
  return basicNormalizeImageErrorText(message).replace(/[.!?]+$/g, "").trim();
}

function equivalentImageErrorMessages(left: string, right: string): boolean {
  return (
    trimTrailingSentencePunctuation(left).toLowerCase() ===
    trimTrailingSentencePunctuation(right).toLowerCase()
  );
}

function normalizeImageErrorText(message: string): string {
  const normalized = basicNormalizeImageErrorText(message);
  const prefix = "Retry failed: ";
  const separator = ". First attempt: ";
  const prefixIndex = normalized.indexOf(prefix);
  if (prefixIndex > -1) {
    const separatorIndex = normalized.indexOf(separator, prefixIndex + prefix.length);
    if (separatorIndex > -1) {
      const retryMessage = normalized.slice(prefixIndex + prefix.length, separatorIndex);
      const firstMessage = normalized.slice(separatorIndex + separator.length);
      if (equivalentImageErrorMessages(retryMessage, firstMessage)) {
        return `${normalized.slice(0, prefixIndex)}Retry failed with the same provider message as the first attempt: ${basicNormalizeImageErrorText(firstMessage)}`;
      }
    }
  }
  return normalized;
}

export function formatRetryFailureMessage(input: {
  retryMessage: string;
  firstMessage: string;
}): string {
  return normalizeImageErrorText(
    `Retry failed: ${trimTrailingSentencePunctuation(input.retryMessage)}. First attempt: ${basicNormalizeImageErrorText(input.firstMessage)}`
  );
}

function hasProviderDetail(message: string): boolean {
  return !/without details|no details/i.test(message);
}

function isStoredFailureMissingDetails(candidate: ImageCandidateRow): boolean {
  if (candidate.status !== "failed" || !candidate.job_id) return false;
  return /without details|no details|69labs job failed/i.test(candidate.error ?? "");
}

function runFailureMessageFromCandidates(candidates: ImageCandidateRow[]): string | null {
  const failed = candidates
    .filter((candidate) => candidate.status === "failed")
    .map(
      (candidate) =>
        `Option ${candidate.rank}: ${candidate.error?.trim() || "image job failed"}`
    );
  if (failed.length === 0) return null;
  return `${failed.length} image candidate job failed: ${failed.join("; ")}`;
}

function finalizeRunFromCandidates(
  runId: string,
  candidates: ImageCandidateRow[]
): ImageRunRow["status"] {
  if (candidates.some((candidate) => candidate.status === "processing")) {
    return "processing";
  }
  if (candidates.some((candidate) => candidate.status === "completed")) {
    markRunCompleted(runId);
    return "completed";
  }
  const nextRunError = runFailureMessageFromCandidates(candidates);
  const message = nextRunError ?? "image run failed";
  markRunFailed(
    runId,
    message,
    classifyImageRunError({
      message,
      phase: "rendering",
      candidatesCreated: candidates.length > 0,
    })
  );
  return "failed";
}

export function isRetryableImageGenerationError(message: string): boolean {
  const lower = message.toLowerCase();
  if (
    lower.includes("api key missing") ||
    lower.includes("no non-pro 69labs") ||
    lower.includes("no 69labs") ||
    lower.includes("did not return a job id") ||
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("auth") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("invalid payload") ||
    lower.includes("bad request")
  ) {
    return false;
  }
  return (
    lower.includes("took too long") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("internal generation pipeline") ||
    lower.includes("restricted") ||
    lower.includes("misclassified") ||
    lower.includes("without details")
  );
}

function isProviderConcurrencyLimitMessage(lowerMessage: string): boolean {
  return (
    lowerMessage.includes("provider is busy") ||
    lowerMessage.includes("concurrent image generation limit") ||
    (lowerMessage.includes("concurrent") && lowerMessage.includes("generation limit")) ||
    lowerMessage.includes("current image jobs")
  );
}

function providerCapacityMessage(message: string): string {
  const lower = message.toLowerCase();
  return isProviderConcurrencyLimitMessage(lower)
    ? IMAGE_PROVIDER_BUSY_MESSAGE
    : IMAGE_PROVIDER_RATE_LIMIT_MESSAGE;
}

function providerRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(value, IMAGE_PROVIDER_RATE_LIMIT_RETRY_MAX_MS);
}

export function isProviderRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("provider is busy") ||
    isProviderConcurrencyLimitMessage(lower)
  );
}

function compactPromptText(value: string | null | undefined, max = 420): string {
  const cleaned = (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:x|×)\+?\b/gi, "")
    .replace(/\b(?:outlier|outliers|video id|score|model)\b/gi, "reference")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3).trimEnd()}...`;
}

const ACTION_PROVIDER_PROMPT_RE =
  /^(?:Replace|Recolor|Remove|Add|Boost|Darken|Brighten|Enlarge|Reduce|Shift|Simplify|Crop|Highlight|Dim|Use|Turn|Swap|Lower|Raise|Make|Change)\b/i;

const BANNED_REFERENCE_PROVIDER_PROMPT_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
}> = [
  { pattern: /\bedit\s+(?:the\s+)?attached\s+thumbnail\b/i, label: "old edit wrapper" },
  { pattern: /\b(?:keep|preserve|maintain|retain|remain|still)\b/i, label: "generic preserve wording" },
  { pattern: /\bsame\b/i, label: "generic sameness wording" },
  { pattern: /\bdo not create\b/i, label: "negative wrapper wording" },
  { pattern: /\breference thumbnail\b/i, label: "reference-title wording" },
  { pattern: /\btarget title\b/i, label: "target-title wording" },
  { pattern: /\bfocal hierarchy\b/i, label: "internal thumbnail analysis" },
  { pattern: /\boverall YouTube thumbnail psychology\b/i, label: "internal thumbnail analysis" },
  { pattern: /\b(?:69labs|nano banana|claude|fable|sonnet|openai|chatgpt|gpt)\b/i, label: "model/provider wording" },
  { pattern: /\b\d+(?:\.\d+)?\s*(?:x|×)\+?\b/i, label: "source analytics" },
  { pattern: /\b(?:sickly|organic|veins?|vein-like|alive|living|biological|flesh|blood|infected|diseased|corpse|rotting)\b/i, label: "provider-filter-prone biological wording" },
];

function sentenceFragments(value: string): string[] {
  const matches = value.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  return (matches ?? [value]).map((sentence) => sentence.trim()).filter(Boolean);
}

function providerSafePromptText(value: string): string {
  return value
    .replace(/\bsickly\b/gi, "electric")
    .replace(/\bbioluminescent\b/gi, "luminous")
    .replace(/\borganic\s+veins?\b/gi, "electric signal lines")
    .replace(/\bvein-like\s+patterns?\b/gi, "glowing fracture pattern")
    .replace(/\bveins?\b/gi, "signal lines")
    .replace(/\borganic\b/gi, "luminous")
    .replace(/\bbiological\b/gi, "anomaly")
    .replace(/\b(?:alive|living)\b/gi, "anomalous")
    .replace(/\b(?:flesh|blood|infected|diseased|corpse|rotting)\b/gi, "anomaly")
    .replace(/\bhinting it is anomalous\b/gi, "with a clear anomaly cue")
    .replace(/\bhinting it is\b/gi, "showing")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildReferenceEditPrompt(input: {
  targetTitle: string;
  aspectRatio: string;
  directionPrompt: string;
  referenceTitle?: string | null;
}): string {
  const target = compactPromptText(input.targetTitle, 220);
  const referenceTitle = compactPromptText(input.referenceTitle, 220);
  const stripped = compactPromptText(input.directionPrompt, 520)
    .replace(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
    .replace(
      referenceTitle
        ? new RegExp(referenceTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
        : /$a/,
      ""
    )
    .replace(/^edit (?:the )?attached thumbnail[:.]?\s*/i, "")
    .replace(/^edit attached thumbnail[:.]?\s*/i, "")
    .replace(/reference thumbnail title\/style cue:[^.]*\./gi, "")
    .replace(/reference title:[^.]*\./gi, "")
    .replace(/target title:.*?(?=(?:preserve the original|replace|change|swap|keep)\b|$)/gi, "")
    .replace(/do not create (?:a )?new unrelated thumbnail\.?/gi, "")
    .replace(/preserve the original layout, structure, composition[^.]*\.?/gi, "")
    .replace(/overall YouTube thumbnail psychology\.?/gi, "")
    .replace(/focal hierarchy,?\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const actionSentences = sentenceFragments(stripped)
    .map((sentence) =>
      providerSafePromptText(sentence)
        .replace(/[,;]\s*[^,;.!?]*\b(?:keep|preserve|maintain|retain|remain|still|same)\b[^.;!?]*/gi, "")
        .replace(/(?:^|[,;]\s*)\b(?:keep|preserve|maintain)\b[^.;!?]*(?=[,;.!?]|$)/gi, "")
        .replace(/(?:^|[,;]\s*)\b(?:retain|remain|still)\b[^.;!?]*(?=[,;.!?]|$)/gi, "")
        .replace(/(?:^|[,;]\s*)\b(?:the\s+)?same\b[^.;!?]*(?=[,;.!?]|$)/gi, "")
        .replace(/^[,;:\s]+/g, "")
        .replace(/\s+([,.!?])/g, "$1")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(
      (sentence) =>
        ACTION_PROVIDER_PROMPT_RE.test(sentence) &&
        !/\b(?:keep|preserve|maintain|retain|remain|still)\b/i.test(sentence) &&
        !/\bsame\b/i.test(sentence) &&
        !/\b(?:reference thumbnail|target title|do not create|focal hierarchy|overall YouTube thumbnail psychology)\b/i.test(sentence) &&
        !/\b(?:sickly|organic|veins?|vein-like|alive|living|biological|flesh|blood|infected|diseased|corpse|rotting)\b/i.test(sentence)
    )
    .slice(0, 4);
  const body =
    actionSentences.join(" ") ||
    "Replace the thumbnail text with 2-4 punchy words. Boost the main subject with saturated rim light and lower background contrast. Remove extra clutter.";
  const safeBody = providerSafePromptText(body);
  return safeBody.length > MAX_REFERENCE_PROVIDER_PROMPT_CHARS
    ? `${safeBody.slice(0, MAX_REFERENCE_PROVIDER_PROMPT_CHARS - 3).trimEnd()}...`
    : safeBody;
}

export function validateReferenceProviderPrompt(prompt: string): void {
  const cleaned = compactPromptText(prompt, MAX_REFERENCE_PROVIDER_PROMPT_CHARS + 80);
  if (!cleaned) {
    throw new Error("Image Studio remix prompt failed validation: prompt is empty");
  }
  if (cleaned.length > MAX_REFERENCE_PROVIDER_PROMPT_CHARS) {
    throw new Error(
      `Image Studio remix prompt failed validation: prompt exceeds ${MAX_REFERENCE_PROVIDER_PROMPT_CHARS} characters`
    );
  }
  if (!ACTION_PROVIDER_PROMPT_RE.test(cleaned)) {
    throw new Error(
      "Image Studio remix prompt failed validation: prompt must start with a concrete action verb"
    );
  }
  const banned = BANNED_REFERENCE_PROVIDER_PROMPT_PATTERNS.find((rule) =>
    rule.pattern.test(cleaned)
  );
  if (banned) {
    throw new Error(
      `Image Studio remix prompt failed validation: remove ${banned.label}`
    );
  }
}

export function buildSimplifiedRetryPrompt(input: {
  title: string;
  aspectRatio: string;
  resolution: string;
}): string {
  const prompt = [
    "Clean science-news thumbnail illustration.",
    "Dark map or sky background, one bright safe glowing anomaly, and clear circular signal rings.",
    "Use high contrast cyan and amber lighting with a single uncluttered focal point.",
    `Clean high contrast composition, ${input.aspectRatio} wide layout.`,
    "Text-free image with no readable words, captions, labels, logos, or typography.",
  ].join(" ");
  return prompt.length > 700 ? `${prompt.slice(0, 697).trimEnd()}...` : prompt;
}

export function buildSimplifiedReferenceRetryPrompt(): string {
  return [
    "Replace thumbnail text with 2-4 bold words.",
    "Boost one clear focal point with clean cyan and amber light.",
    "Darken the background and remove visual clutter.",
  ].join(" ");
}

function formatReferenceRecoveryFailureMessage(input: {
  firstMessage: string;
  referenceRetryMessage: string;
  sourceFreeMessage: string;
}): string {
  return normalizeImageErrorText(
    [
      `Source-free retry failed: ${trimTrailingSentencePunctuation(input.sourceFreeMessage)}.`,
      `Reference retry failed: ${basicNormalizeImageErrorText(input.referenceRetryMessage)}`,
      `First attempt: ${basicNormalizeImageErrorText(input.firstMessage)}`,
    ].join(" ")
  );
}

async function saveCandidateImage(input: {
  runId: string;
  candidateId: string;
  jobId: string;
}): Promise<string> {
  const image = await downloadImageJob(input.jobId);
  const ext = extensionForContentType(image.contentType);
  const relativeDir = path.join("image-generations", input.runId);
  const dir = path.join(DATA_DIR, relativeDir);
  await fs.mkdir(dir, { recursive: true });
  const relativePath = path.join(relativeDir, `${input.candidateId}.${ext}`);
  await fs.writeFile(path.join(DATA_DIR, relativePath), image.bytes);
  return relativePath;
}

async function waitForCandidate(input: {
  runId: string;
  candidateId: string;
  jobId: string;
}): Promise<void> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let status;
    try {
      status = await getImageJobStatus(input.jobId);
    } catch (err) {
      const message = errorMessage(err);
      if (isProviderRateLimitError(message)) {
        const waitMs =
          providerRetryAfterMs(err) ?? Math.min(POLL_INTERVAL_MS * 4, IMAGE_PROVIDER_RATE_LIMIT_RETRY_MAX_MS);
        log.warn("image-studio", "69labs status capacity/rate limit; continuing to poll existing job", {
          candidateId: input.candidateId,
          jobId: input.jobId,
          waitMs,
          reason: providerCapacityMessage(message),
        });
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
    if (!isTerminalImageStatus(status.status)) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }
	    if (status.status !== "COMPLETED") {
	      throw new Error(formatImageJobFailure(status));
	    }
	    try {
	      const imagePath = await saveCandidateImage(input);
	      markCandidateCompleted({ candidateId: input.candidateId, imagePath });
	      return;
	    } catch (err) {
	      const row = db
	        .prepare(`SELECT image_path FROM image_candidates WHERE id = ?`)
	        .get(input.candidateId) as { image_path: string | null } | undefined;
	      if (row?.image_path) {
	        markCandidateCompleted({
	          candidateId: input.candidateId,
	          imagePath: row.image_path,
	        });
	        return;
	      }
	      log.warn("image-studio", "completed image job download failed; retrying", {
	        candidateId: input.candidateId,
	        jobId: input.jobId,
	        error: errorMessage(err),
	      });
	      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	    }
	  }
	  throw new Error("69labs image job exceeded polling/download timeout");
	}

async function submitAndPollCandidate(input: {
  runId: string;
  candidateId: string;
  model: string;
  maxImageUrls: number | null;
  aspectRatio: string;
  resolution: string;
  title: string;
  direction: ImageDirection;
}): Promise<void> {
  const submitAttempt = async (
    prompt: string,
    imageUrls: string[],
    model = input.model,
    attemptType: ImageProviderAttempt["attemptType"]
  ) => {
    appendProviderAttempt({
      candidateId: input.candidateId,
      attemptType,
      model,
      prompt,
      imageUrls,
      referenceIds:
        imageUrls.length > 0
          ? input.direction.referenceIds.slice(0, imageUrls.length)
          : [],
    });
    const providerPayloads =
      imageUrls.length > 0
        ? await prepareProviderImagePayloads(imageUrls)
        : { submittedUrls: [], metadata: [] };
    if (providerPayloads.metadata.length > 0) {
      markLatestProviderAttemptPayloads({
        candidateId: input.candidateId,
        imagePayloads: providerPayloads.metadata,
      });
    }
    await waitForProviderCreationSlot({
      candidateId: input.candidateId,
      attemptType,
    });
    const submitted = await submitImageJob({
      prompt,
      model,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      imageUrls: providerPayloads.submittedUrls,
    });
    markLatestProviderAttemptJob({
      candidateId: input.candidateId,
      jobId: submitted.jobId,
    });
    markCandidateJob({
      candidateId: input.candidateId,
      jobId: submitted.jobId,
      model,
      resolution: input.resolution,
    });
    await waitForCandidate({
      runId: input.runId,
      candidateId: input.candidateId,
      jobId: submitted.jobId,
    });
  };

  const submitAttemptWithRateLimitRetry = async (
    prompt: string,
    imageUrls: string[],
    model = input.model,
    attemptType: ImageProviderAttempt["attemptType"]
  ) => {
    let rateLimitRetries = 0;
    while (true) {
      try {
        await submitAttempt(prompt, imageUrls, model, attemptType);
        return;
      } catch (err) {
        const message = errorMessage(err);
        markLatestProviderAttemptError({
          candidateId: input.candidateId,
          error: message,
        });
        if (
          !isProviderRateLimitError(message) ||
          rateLimitRetries >= IMAGE_PROVIDER_MAX_RATE_LIMIT_RETRIES
        ) {
          throw err;
        }
        rateLimitRetries += 1;
        const waitMs =
          providerRetryAfterMs(err) ??
          Math.min(
            IMAGE_PROVIDER_RATE_LIMIT_RETRY_MAX_MS,
            IMAGE_PROVIDER_RATE_LIMIT_RETRY_MS * rateLimitRetries
          );
        log.warn("image-studio", "69labs capacity limit; retrying same provider payload", {
          candidateId: input.candidateId,
          attemptType,
          retry: rateLimitRetries,
          waitMs,
          reason: providerCapacityMessage(message),
        });
        await sleep(waitMs);
      }
    }
  };

  const imageUrlLimit = Math.max(
    0,
    Math.min(
      MAX_IMAGE_URLS_PER_CANDIDATE,
      input.maxImageUrls ?? input.direction.imageUrls.length
    )
  );
  const firstImageUrls = input.direction.imageUrls.slice(0, imageUrlLimit);

  try {
    await submitAttemptWithRateLimitRetry(
      input.direction.prompt,
      firstImageUrls,
      input.model,
      firstImageUrls.length > 0 ? "reference" : "generate"
    );
  } catch (firstErr) {
    const firstMessage = errorMessage(firstErr);
    markLatestProviderAttemptError({
      candidateId: input.candidateId,
      error: firstMessage,
    });
    if (isProviderRateLimitError(firstMessage)) {
      const capacityMessage = providerCapacityMessage(firstMessage);
      markCandidateWaitingForCapacity(input.candidateId);
      throw new Error(capacityMessage);
    }
    if (firstImageUrls.length > 0) {
      if (!isRetryableImageGenerationError(firstMessage)) {
        markCandidateFailed(input.candidateId, firstMessage);
        throw firstErr;
      }

      const referenceRetryPrompt = buildSimplifiedReferenceRetryPrompt();
      markCandidateRetry({
        candidateId: input.candidateId,
        note: "Simplified reference retry after the provider rejected the first reference attempt.",
      });

      try {
        await submitAttemptWithRateLimitRetry(
          referenceRetryPrompt,
          firstImageUrls,
          input.model,
          "reference"
        );
        return;
      } catch (referenceRetryErr) {
        const referenceRetryMessage = errorMessage(referenceRetryErr);
        markLatestProviderAttemptError({
          candidateId: input.candidateId,
          error: referenceRetryMessage,
        });
        if (isProviderRateLimitError(referenceRetryMessage)) {
          const capacityMessage = providerCapacityMessage(referenceRetryMessage);
          markCandidateWaitingForCapacity(input.candidateId);
          throw new Error(capacityMessage);
        }
        if (!isRetryableImageGenerationError(referenceRetryMessage)) {
          const combined = formatRetryFailureMessage({
            retryMessage: referenceRetryMessage,
            firstMessage,
          });
          markCandidateFailed(input.candidateId, combined);
          throw new Error(combined);
        }

        const sourceFreePrompt = buildSimplifiedRetryPrompt({
          title: input.title,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
        });
        markCandidateRetry({
          candidateId: input.candidateId,
          note: "Source-free retry after the provider rejected the reference image.",
        });

        try {
          await submitAttemptWithRateLimitRetry(
            sourceFreePrompt,
            [],
            input.model,
            "source_free_retry"
          );
          return;
        } catch (sourceFreeErr) {
          const sourceFreeMessage = errorMessage(sourceFreeErr);
          markLatestProviderAttemptError({
            candidateId: input.candidateId,
            error: sourceFreeMessage,
          });
          if (isProviderRateLimitError(sourceFreeMessage)) {
            const capacityMessage = providerCapacityMessage(sourceFreeMessage);
            markCandidateWaitingForCapacity(input.candidateId);
            throw new Error(capacityMessage);
          }
          const combined = formatReferenceRecoveryFailureMessage({
            firstMessage,
            referenceRetryMessage,
            sourceFreeMessage,
          });
          markCandidateFailed(input.candidateId, combined);
          throw new Error(combined);
        }
      }
    }
    if (!isRetryableImageGenerationError(firstMessage)) {
      markCandidateFailed(input.candidateId, firstMessage);
      throw firstErr;
    }

    const retryPrompt = buildSimplifiedRetryPrompt({
      title: input.title,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
    });
    markCandidateRetry({ candidateId: input.candidateId });

    try {
      await submitAttemptWithRateLimitRetry(
        retryPrompt,
        [],
        input.model,
        "source_free_retry"
      );
    } catch (retryErr) {
      const retryMessage = errorMessage(retryErr);
      markLatestProviderAttemptError({
        candidateId: input.candidateId,
        error: retryMessage,
      });
      if (isProviderRateLimitError(retryMessage)) {
        const capacityMessage = providerCapacityMessage(retryMessage);
        markCandidateWaitingForCapacity(input.candidateId);
        throw new Error(capacityMessage);
      }
      const combined = formatRetryFailureMessage({ retryMessage, firstMessage });
      markCandidateFailed(input.candidateId, combined);
      throw new Error(combined);
    }
  }
}

function referencesForDirection(
  direction: ImageDirection,
  references: ImageReference[]
): ImageReference[] {
  const byId = new Map(references.map((ref) => [ref.id, ref]));
  const picked = direction.referenceIds
    .map((id) => byId.get(id))
    .filter((ref): ref is ImageReference => !!ref);
  if (picked.length > 0) return picked.slice(0, MAX_IMAGE_URLS_PER_CANDIDATE);
  const byUrl = new Map(references.map((ref) => [ref.thumbnailUrl, ref]));
  return direction.imageUrls
    .map((url) => byUrl.get(url))
    .filter((ref): ref is ImageReference => !!ref)
    .slice(0, MAX_IMAGE_URLS_PER_CANDIDATE);
}

function directionFromCandidate(
  candidate: ImageCandidateRow,
  run: ImageRunRow
): ImageDirection {
  const sourceImages = safeJson<ImageReference[]>(candidate.source_images_json, []);
  return {
    rank: Math.min(4, Math.max(1, candidate.rank)) as ImageDirection["rank"],
    label: `Option ${candidate.rank}`,
    rationale: candidate.rationale ?? "",
    prompt: candidate.prompt ?? run.input_prompt,
    changes: candidate.changes ?? "",
    critique: candidate.critique ?? "",
    imageUrls: sourceImages.map((ref) => ref.thumbnailUrl).filter(Boolean),
    referenceIds: sourceImages.map((ref) => ref.id).filter(Boolean),
  };
}

function repairCandidateImagePathStatuses(
  candidates: ImageCandidateRow[]
): ImageCandidateRow[] {
  return candidates.map((candidate) => {
    if (!candidate.image_path || candidate.status === "completed") return candidate;
    markCandidateCompleted({
      candidateId: candidate.id,
      imagePath: candidate.image_path,
    });
    return {
      ...candidate,
      status: "completed",
      error: null,
      completed_at: nowSql(),
    };
  });
}

function candidateProviderAttempts(candidate: ImageCandidateRow): ImageProviderAttempt[] {
  return safeJson<ImageProviderAttempt[]>(candidate.provider_attempts_json, []);
}

function isRecoverableFailedCandidate(candidate: ImageCandidateRow): boolean {
  if (candidate.status !== "failed" || candidate.image_path) return false;
  if (!candidate.error || !isRetryableImageGenerationError(candidate.error)) return false;
  const attempts = candidateProviderAttempts(candidate);
  if (attempts.some((attempt) => attempt.attemptType === "source_free_retry")) return false;
  return attempts.length < 3;
}

function directionForProvider(input: {
  direction: ImageDirection;
  references: ImageReference[];
  run: ImageRunRow;
}): ImageDirection {
  const shouldEditReference =
    runRequiresReference(input.run) && input.references.length > 0;
  if (!shouldEditReference) return input.direction;

  const pickedRefs = referencesForDirection(input.direction, input.references);
  const primaryRef = pickedRefs[0] ?? pickPrimaryImageReference(input.references);
  if (!primaryRef) {
    throw new Error("Ideate/remix image planning requires a source thumbnail reference");
  }
  const prompt = buildReferenceEditPrompt({
    targetTitle: input.run.title ?? input.run.input_prompt,
    aspectRatio: input.run.aspect_ratio,
    directionPrompt: input.direction.prompt,
    referenceTitle: primaryRef.title,
  });
  validateReferenceProviderPrompt(prompt);
  return {
    ...input.direction,
    prompt,
    changes: input.direction.changes,
    imageUrls: [primaryRef.thumbnailUrl],
    referenceIds: [primaryRef.id],
  };
}

function assertProviderDirectionsHaveRequiredReferences(input: {
  run: ImageRunRow;
  references: ImageReference[];
  directions: ImageDirection[];
}): void {
  if (!runRequiresReference(input.run)) return;
  if (input.references.length === 0) {
    throw new Error(
      "Ideate/remix image planning requires a source thumbnail reference, but none were available"
    );
  }
  const missing = input.directions.find((direction) => direction.imageUrls.length === 0);
  if (missing) {
    throw new Error(
      `Ideate/remix direction ${missing.rank} did not include the required source thumbnail`
    );
  }
}

async function buildImageRunPlan(run: ImageRunRow): Promise<{
  attachments: ImageAttachment[];
  references: ImageReference[];
  learnedRules: ImageFeedbackRuleRow[];
  channelSnapshot: Record<string, unknown>;
  directions: ImageDirection[];
  plannerUsage: ImagePlannerUsage | null;
}> {
  const channel = getChannel(run.user_channel_id);
  if (!channel) throw new Error("Image Studio channel not found");
  const attachments = safeJson<ImageAttachment[]>(run.attachments_json, []);
  const references = runRequiresReference(run)
    ? selectImageReferences({
        userChannelId: run.user_channel_id,
        title: run.title,
        prompt: run.input_prompt,
        sourceIdeaId: run.source_idea_id,
        requireMinimum: false,
      })
    : [];
  const learnedRules = readLearnedRules(run.user_channel_id);
  const channelBrief = resolveChannelDescription(channel);
  const thumbnailStyleGoals = (channel.thumbnail_style_goals ?? "").trim();
  const thumbnailDesignRules = (channel.thumbnail_design_rules ?? "").trim();
  const currentVideos = readCurrentVideos(run.user_channel_id);
  const recentIdeas = readRecentIdeas(run.user_channel_id);
  const channelStyleExamples = readChannelStyleExamples(run.user_channel_id);
  const planning: ImagePlanningResult = runNeedsPlanning(run)
    ? await planImageDirections({
        userChannelId: run.user_channel_id,
        prompt: run.input_prompt,
        title: run.title,
        mode: run.mode,
        generationMode: run.generation_mode,
        sampleCount: run.sample_count,
        aspectRatio: run.aspect_ratio,
        resolution: run.resolution,
        channelTitle: channel.title,
        channelBrief,
        thumbnailStyleGoals,
        thumbnailDesignRules,
        learnedRules,
        references,
        attachments,
        currentVideos,
        recentIdeas,
        channelStyleExamples,
      })
    : directImageDirections({
        prompt: run.input_prompt,
        sampleCount: run.sample_count,
        aspectRatio: run.aspect_ratio,
        resolution: run.resolution,
      });
  const directions = planning.directions.map((direction) =>
    directionForProvider({ direction, references, run })
  );
  assertProviderDirectionsHaveRequiredReferences({ run, references, directions });
  return {
    attachments,
    references,
    learnedRules,
    channelSnapshot: {
      id: channel.id,
      title: channel.title,
      handle: channel.handle,
      channelBrief,
      thumbnailStyleGoals,
      thumbnailDesignRules,
      currentVideos,
      recentIdeas,
      channelStyleExamples,
      attachmentNote:
        attachments.length > 0
          ? "Local image uploads were available to the AI planner for analysis. 69labs only receives external reference URLs."
          : null,
    },
    directions,
    plannerUsage: planning.usage,
  };
}

export async function createImageRun(input: CreateRunInput): Promise<string> {
  const activeChannelId = getActiveChannelId();
  if (!activeChannelId) {
    throw new Error("no active channel — connect one from the top-right channel switcher");
  }
  const sourceIdeaId = input.sourceIdeaId?.trim() || null;
  const ideaTitle = getIdeaTitle(sourceIdeaId);
  const prompt = input.prompt.trim() || ideaTitle || "";
  if (!prompt) throw new Error("prompt is required");
  const runId = crypto.randomUUID();
  const sampleCount = clampSampleCount(input.sampleCount);
  const aspectRatio = normalizeAspectRatio(input.aspectRatio);
  const resolution = normalizeResolution(input.resolution);
  const attachments = await saveAttachments(runId, input.attachments ?? []);
  const aiAssist = !!input.aiAssist || !!sourceIdeaId || attachments.length > 0;
  const mode: ImageRunMode = sourceIdeaId ? "ideate" : aiAssist ? "assist" : "prompt";
  const generationMode: ImageGenerationMode =
    input.generationMode ?? (sourceIdeaId ? "remix" : "generate");

  insertRun({
    id: runId,
    userChannelId: activeChannelId,
    prompt,
    title: ideaTitle ?? titleFromPrompt(prompt),
    sourceIdeaId,
    sampleCount,
    aspectRatio,
    resolution,
    aiAssist,
    mode,
    generationMode,
    attachments,
  });
  return runId;
}

export async function previewImageRunPlan(
  input: CreateRunInput
): Promise<ImagePlanPreview> {
  const activeChannelId = getActiveChannelId();
  if (!activeChannelId) {
    throw new Error("no active channel — connect one from the top-right channel switcher");
  }
  const sourceIdeaId = input.sourceIdeaId?.trim() || null;
  const ideaTitle = getIdeaTitle(sourceIdeaId);
  const prompt = input.prompt.trim() || ideaTitle || "";
  if (!prompt) throw new Error("prompt is required");
  const sampleCount = clampSampleCount(input.sampleCount);
  const aspectRatio = normalizeAspectRatio(input.aspectRatio);
  const resolution = normalizeResolution(input.resolution);
  const aiAssist = !!input.aiAssist || !!sourceIdeaId || (input.attachments ?? []).length > 0;
  const mode: ImageRunMode = sourceIdeaId ? "ideate" : aiAssist ? "assist" : "prompt";
  const generationMode: ImageGenerationMode =
    input.generationMode ?? (sourceIdeaId ? "remix" : "generate");
  const run: ImageRunRow = {
    id: "prompt-only-preview",
    user_channel_id: activeChannelId,
    source_idea_id: sourceIdeaId,
    mode,
    generation_mode: generationMode,
    input_prompt: prompt,
    title: ideaTitle ?? titleFromPrompt(prompt),
    sample_count: sampleCount,
    aspect_ratio: aspectRatio,
    resolution,
    ai_assist: aiAssist ? 1 : 0,
    status: "processing",
    phase: "planning",
    error_category: null,
    selected_references_json: "[]",
    attachments_json: "[]",
    channel_snapshot_json: null,
    learned_rules_json: "[]",
    error: null,
    started_at: nowSql(),
    completed_at: null,
  };
  const plan = await buildImageRunPlan(run);
  return {
    status: "planned",
    renderer: {
      provider: "69labs",
      submitted: false,
    },
    mode,
    generationMode,
    prompt,
    title: run.title,
    sampleCount,
    aspectRatio,
    resolution,
    references: plan.references,
    directions: plan.directions,
    plannerUsage: plan.plannerUsage,
  };
}

export async function runImagePipeline(runId: string): Promise<void> {
  const run = db
    .prepare(`SELECT * FROM image_runs WHERE id = ?`)
    .get(runId) as ImageRunRow | undefined;
  if (!run) return;

  try {
    markRunPhase(runId, "planning");
    const existingCandidates = repairCandidateImagePathStatuses(
      db
      .prepare(
        `SELECT * FROM image_candidates
         WHERE run_id = ?
         ORDER BY rank ASC`
      )
      .all(runId) as ImageCandidateRow[]
    );
    let jobs: Array<{
      candidate?: ImageCandidateRow;
      candidateId: string;
      providerDirection: ImageDirection;
    }>;

    if (existingCandidates.length > 0) {
      markRunPhase(runId, "rendering");
      jobs = existingCandidates.map((candidate) => ({
        candidate,
        candidateId: candidate.id,
        providerDirection: directionFromCandidate(candidate, run),
      }));
    } else {
      const plan = await buildImageRunPlan(run);
      updateRunProcessingContext({
        runId,
        references: plan.references,
        channelSnapshot: plan.channelSnapshot,
        learnedRules: plan.learnedRules,
      });
      jobs = plan.directions.map((providerDirection) => {
        const candidateId = crypto.randomUUID();
        insertCandidate({
          id: candidateId,
          runId,
          direction: providerDirection,
          refs: referencesForDirection(providerDirection, plan.references),
        });
        return {
          candidateId,
          providerDirection,
        };
      });
    }

    const failed = jobs
      .filter((job) => job.candidate?.status === "failed")
      .map(
        (job) =>
          `Option ${job.providerDirection.rank}: ${
            job.candidate?.error?.trim() || "image job failed"
          }`
      );
    const candidateJobs = jobs
      .map((job) => {
        const recoverableFailed = job.candidate
          ? isRecoverableFailedCandidate(job.candidate)
          : false;
        if (
          job.candidate?.status === "completed" ||
          (job.candidate?.status === "failed" && !recoverableFailed)
        ) {
          return null;
        }
        return {
          ...job,
          recoverableFailed,
        };
      })
      .filter(
        (job): job is (typeof jobs)[number] & { recoverableFailed: boolean } =>
          Boolean(job)
      );
    const model =
      candidateJobs.length > 0
        ? await chooseImageModel({
            needsImageInput: candidateJobs.some(
              (job) => job.providerDirection.imageUrls.length > 0
            ),
            aspectRatio: run.aspect_ratio,
            resolution: run.resolution,
          })
        : null;

    const runCandidateJob = async (
      job: (typeof jobs)[number] & { recoverableFailed: boolean },
      launchOffsetMs: number
    ) => {
      if (launchOffsetMs > 0) {
        await sleep(launchOffsetMs);
      }
      try {
        if (job.recoverableFailed) {
          markCandidateProcessing(job.candidateId);
        }
        const providerDirection =
          job.recoverableFailed && job.providerDirection.imageUrls.length > 0
            ? {
                ...job.providerDirection,
                prompt: buildSimplifiedReferenceRetryPrompt(),
                changes:
                  "Simplified reference retry after the provider rejected the first attempt.",
              }
            : job.providerDirection;
        if (job.candidate?.job_id && !job.recoverableFailed) {
          await waitForCandidate({
            runId,
            candidateId: job.candidateId,
            jobId: job.candidate.job_id,
          });
        } else if (model) {
          await submitAndPollCandidate({
            runId,
            candidateId: job.candidateId,
            model: model.id,
            maxImageUrls:
              model.supportsImageInput && typeof model.maxImageUrls === "number"
                ? model.maxImageUrls
                : model.supportsImageInput
                  ? null
                  : 0,
            aspectRatio: run.aspect_ratio,
            resolution: run.resolution,
            title: run.title ?? run.input_prompt,
            direction: providerDirection,
          });
        }
      } catch (err) {
        const message = errorMessage(err);
        failed.push(`Option ${job.providerDirection.rank}: ${message}`);
        if (isProviderRateLimitError(message)) {
          markCandidateWaitingForCapacity(job.candidateId);
          log.warn(
            "image-studio",
            "69labs capacity interrupted image run; leaving pending candidates resumable",
            {
              runId,
              candidateId: job.candidateId,
              reason: providerCapacityMessage(message),
            }
          );
          return;
        }
        markCandidateFailed(job.candidateId, message);
      }
    };
    await Promise.all(
      candidateJobs.map((job, index) =>
        runCandidateJob(job, index * IMAGE_PROVIDER_SUBMIT_SPACING_MS)
      )
    );
    const finalCandidates = repairCandidateImagePathStatuses(
      db
        .prepare(
          `SELECT * FROM image_candidates
           WHERE run_id = ?
           ORDER BY rank ASC`
        )
        .all(runId) as ImageCandidateRow[]
    );
    const finalStatus = finalizeRunFromCandidates(runId, finalCandidates);
    if (finalStatus === "failed" && failed.length > 0) {
      throw new Error(`${failed.length} image candidate job failed: ${failed.join("; ")}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "image run failed";
    const row = db
      .prepare(`SELECT phase FROM image_runs WHERE id = ?`)
      .get(runId) as { phase: string | null } | undefined;
    const candidateCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM image_candidates WHERE run_id = ?`)
        .get(runId) as { n: number }
    ).n;
    const currentCandidates = db
      .prepare(
        `SELECT status FROM image_candidates
         WHERE run_id = ?`
      )
      .all(runId) as Array<{ status: ImageCandidateRow["status"] }>;
    if (currentCandidates.some((candidate) => candidate.status === "processing")) {
      markRunProcessing(runId);
      log.warn("image-studio", "image run hit an error with live candidates still processing", {
        runId,
        error: message,
      });
      return;
    }
    const phase = normalizeRunPhase(row?.phase, "processing");
    markRunFailed(
      runId,
      message,
      classifyImageRunError({
        message,
        phase,
        candidatesCreated: candidateCount > 0,
      })
    );
    log.error("image-studio", "runImagePipeline failed", err, { runId });
  }
}

export function startImagePipeline(runId: string): boolean {
  if (activeImageRunPipelines.has(runId)) return false;
  activeImageRunPipelines.add(runId);
  void runImagePipeline(runId)
    .catch((err) => {
      log.error("image-studio", "background image run crashed", err, { runId });
    })
    .finally(() => {
      activeImageRunPipelines.delete(runId);
    });
  return true;
}

function sqlDateMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldResumeInterruptedRun(
  run: ImageRunRow,
  candidates: ImageCandidateRow[]
): boolean {
  if (run.status !== "processing" || activeImageRunPipelines.has(run.id)) return false;
  if (
    !candidates.some(
      (candidate) =>
        (candidate.status === "processing" && !candidate.job_id) ||
        isRecoverableFailedCandidate(candidate)
    )
  ) {
    return false;
  }
  if (candidates.some((candidate) => candidate.status === "processing" && candidate.job_id)) {
    return false;
  }
  const latestActivityMs = Math.max(
    sqlDateMs(run.started_at),
    ...candidates.map((candidate) =>
      Math.max(sqlDateMs(candidate.completed_at), sqlDateMs(candidate.created_at))
    )
  );
  return Date.now() - latestActivityMs > INTERRUPTED_RUN_RESUME_MS;
}

function repairRunStatusFromCandidates(
  run: ImageRunRow,
  candidates: ImageCandidateRow[]
): ImageRunRow {
  if (candidates.length === 0) {
    return run;
  }
  if (candidates.some((candidate) => candidate.status === "processing")) {
    if (
      run.status !== "processing" ||
      normalizeRunPhase(run.phase, run.status) !== "rendering"
    ) {
      markRunProcessing(run.id);
    }
    return {
      ...run,
      status: "processing",
      phase: "rendering",
      error_category: null,
      error: null,
      completed_at: null,
    };
  }
  if (candidates.some((candidate) => candidate.status === "completed")) {
    if (run.status !== "completed" || run.error) {
      markRunCompleted(run.id);
    }
    return {
      ...run,
      status: "completed",
      error: null,
      completed_at: run.completed_at ?? nowSql(),
    };
  }
  if (run.status === "processing") {
    const nextRunError = runFailureMessageFromCandidates(candidates) ?? "image run failed";
    markRunFailed(
      run.id,
      nextRunError,
      classifyImageRunError({
        message: nextRunError,
        phase: normalizeRunPhase(run.phase, run.status),
        candidatesCreated: candidates.length > 0,
      })
    );
    return {
      ...run,
      status: "failed",
      phase: "failed",
      error_category: classifyImageRunError({
        message: nextRunError,
        phase: normalizeRunPhase(run.phase, run.status),
        candidatesCreated: candidates.length > 0,
      }),
      error: normalizeImageErrorText(nextRunError),
      completed_at: nowSql(),
    };
  }
  return run;
}

export function listImageRunHistory(): ImageRunHistoryEntry[] {
  const activeChannelId = getActiveChannelId();
  if (!activeChannelId) return [];
  const rows = db
    .prepare(
      `SELECT id, mode, status, phase, error_category, title, input_prompt, sample_count, started_at, completed_at
       FROM image_runs
       WHERE user_channel_id = ?
       ORDER BY started_at DESC
       LIMIT 50`
    )
    .all(activeChannelId) as Array<{
    id: string;
    mode: ImageRunMode;
    status: ImageRunStatus;
    phase: ImageRunPhase | null;
    error_category: ImageRunErrorCategory | null;
    title: string | null;
    input_prompt: string;
    sample_count: number;
    started_at: string;
    completed_at: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    mode: row.mode,
    status: row.status,
    phase: normalizeRunPhase(row.phase, row.status),
    errorCategory: normalizeErrorCategory(row.error_category),
    title: row.title || titleFromPrompt(row.input_prompt),
    sampleCount: row.sample_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

async function refreshStoredFailureDetails(
  run: ImageRunRow,
  candidates: ImageCandidateRow[]
): Promise<{ run: ImageRunRow; candidates: ImageCandidateRow[] }> {
  let changed = false;
  const refreshed = [...candidates];

  for (let index = 0; index < refreshed.length; index += 1) {
    const candidate = refreshed[index];
    if (!isStoredFailureMissingDetails(candidate) || !candidate.job_id) continue;
    try {
      const status = await getImageJobStatus(candidate.job_id);
      const detail = imageJobFailureMessage(status);
      if (!hasProviderDetail(detail)) continue;
      const nextError = formatImageJobFailure(status);
      if (nextError === candidate.error) continue;
      db.prepare(`UPDATE image_candidates SET error = ? WHERE id = ?`).run(
        nextError.slice(0, 1000),
        candidate.id
      );
      refreshed[index] = { ...candidate, error: nextError.slice(0, 1000) };
      changed = true;
    } catch (err) {
      log.warn("image-studio", "could not refresh stored image failure detail", {
        candidateId: candidate.id,
        jobId: candidate.job_id,
        error: errorMessage(err),
      });
    }
  }

  if (!changed || run.status !== "failed") return { run, candidates: refreshed };
  const nextRunError = runFailureMessageFromCandidates(refreshed);
  if (!nextRunError || nextRunError === run.error) {
    return { run, candidates: refreshed };
  }
  const storedRunError = nextRunError.slice(0, 1000);
  const errorCategory = classifyImageRunError({
    message: storedRunError,
    phase: normalizeRunPhase(run.phase, run.status),
    candidatesCreated: refreshed.length > 0,
  });
  db.prepare(`UPDATE image_runs SET error = ?, error_category = ? WHERE id = ?`).run(
    storedRunError,
    errorCategory,
    run.id
  );
  return {
    run: { ...run, error: storedRunError, error_category: errorCategory },
    candidates: refreshed,
  };
}

async function refreshProcessingCandidates(
  run: ImageRunRow,
  candidates: ImageCandidateRow[]
): Promise<{ run: ImageRunRow; candidates: ImageCandidateRow[] }> {
  const hasProcessingCandidate = candidates.some(
    (candidate) => candidate.status === "processing"
  );
  if (run.status !== "processing" && !hasProcessingCandidate) {
    return { run, candidates };
  }

  let nextRun = run;
  if (run.status !== "processing" && hasProcessingCandidate) {
    markRunProcessing(run.id);
    nextRun = {
      ...run,
      status: "processing",
      phase: "rendering",
      error_category: null,
      error: null,
      completed_at: null,
    };
  }

  let changed = false;
  const refreshed = [...candidates];

  for (let index = 0; index < refreshed.length; index += 1) {
    const candidate = refreshed[index];
    if (candidate.status !== "processing" || !candidate.job_id) continue;
    try {
      const status = await getImageJobStatus(candidate.job_id);
      if (!isTerminalImageStatus(status.status)) continue;
      if (status.status === "COMPLETED") {
        const imagePath = await saveCandidateImage({
          runId: run.id,
          candidateId: candidate.id,
          jobId: candidate.job_id,
        });
        markCandidateCompleted({ candidateId: candidate.id, imagePath });
        refreshed[index] = {
          ...candidate,
          status: "completed",
          image_path: imagePath,
          error: null,
          completed_at: nowSql(),
        };
      } else {
        const nextError = formatImageJobFailure(status);
        markCandidateFailed(candidate.id, nextError);
        refreshed[index] = {
          ...candidate,
          status: "failed",
          error: normalizeImageErrorText(nextError).slice(0, 1000),
          completed_at: nowSql(),
        };
      }
      changed = true;
    } catch (err) {
      log.warn("image-studio", "could not refresh processing image candidate", {
        candidateId: candidate.id,
        jobId: candidate.job_id,
        error: errorMessage(err),
      });
    }
  }

  if (!changed) return { run: nextRun, candidates: refreshed };
  if (refreshed.some((candidate) => candidate.status === "processing")) {
    return { run: nextRun, candidates: refreshed };
  }

  const finalStatus = finalizeRunFromCandidates(nextRun.id, refreshed);
  const nextError = runFailureMessageFromCandidates(refreshed) ?? "image run failed";
  const nextCategory =
    finalStatus === "failed"
      ? classifyImageRunError({
          message: nextError,
          phase: "rendering",
          candidatesCreated: refreshed.length > 0,
        })
      : null;
  return {
    run: {
      ...nextRun,
      status: finalStatus,
      phase:
        finalStatus === "failed"
          ? "failed"
          : finalStatus === "completed"
            ? "reviewing"
            : nextRun.phase,
      error_category: nextCategory,
      error:
        finalStatus === "failed"
          ? normalizeImageErrorText(nextError)
          : null,
      completed_at: finalStatus === "processing" ? nextRun.completed_at : nowSql(),
    },
    candidates: refreshed,
  };
}

export async function getImageRunView(runId: string): Promise<ImageRunView | null> {
  let run = db
    .prepare(`SELECT * FROM image_runs WHERE id = ?`)
    .get(runId) as ImageRunRow | undefined;
  if (!run) return null;
	  let candidates = db
	    .prepare(
	      `SELECT * FROM image_candidates
	       WHERE run_id = ?
	       ORDER BY rank ASC`
	    )
	    .all(runId) as ImageCandidateRow[];
	  candidates = repairCandidateImagePathStatuses(candidates);
	  ({ run, candidates } = await refreshProcessingCandidates(run, candidates));
  if (shouldResumeInterruptedRun(run, candidates)) {
    startImagePipeline(run.id);
  }
  ({ run, candidates } = await refreshStoredFailureDetails(run, candidates));
  run = repairRunStatusFromCandidates(run, candidates);
  const references = safeJson<ImageReference[]>(
    run.selected_references_json,
    []
  );
  const learnedRules = safeJson<ImageFeedbackRuleRow[]>(
    run.learned_rules_json,
    []
  );
  const attachments = safeJson<ImageAttachment[]>(
    run.attachments_json,
    []
  ).map((attachment) => ({
    ...attachment,
    previewUrl: `/api/image-attachments/${attachment.id}`,
  }));
  return {
    id: run.id,
    status: run.status,
    phase: normalizeRunPhase(run.phase, run.status),
    errorCategory: normalizeErrorCategory(run.error_category),
    mode: run.mode,
    generationMode: run.generation_mode,
    prompt: run.input_prompt,
    title: run.title,
    channelId: run.user_channel_id,
    sourceIdeaId: run.source_idea_id,
    sampleCount: run.sample_count,
    aspectRatio: run.aspect_ratio,
    resolution: run.resolution,
    aiAssist: run.ai_assist === 1,
    error: run.error ? normalizeImageErrorText(run.error) : null,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    references,
    attachments,
    learnedRules,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      rank: candidate.rank,
      status: candidate.status,
      imageUrl:
        candidate.status === "completed" && candidate.image_path
          ? `/api/image-candidates/${candidate.id}/image`
          : null,
      sourceImages: safeJson<ImageReference[]>(
        candidate.source_images_json,
        []
      ),
      prompt: candidate.prompt,
      rationale: candidate.rationale,
      changes: candidate.changes,
      critique: candidate.critique,
      feedback: candidate.feedback,
      feedbackReason: candidate.feedback_reason,
      error: candidate.error ? normalizeImageErrorText(candidate.error) : null,
      model: candidate.model,
      resolution: candidate.resolution,
      jobId: candidate.job_id,
      providerAttempts: safeJson<ImageProviderAttempt[]>(
        candidate.provider_attempts_json,
        []
      ),
    })),
  };
}

export function setImageCandidateFeedback(input: {
  candidateId: string;
  feedback: ImageFeedback;
  reason?: string | null;
}): void {
  const candidate = db
    .prepare(
      `SELECT ic.*, ir.user_channel_id
       FROM image_candidates ic
       JOIN image_runs ir ON ir.id = ic.run_id
       WHERE ic.id = ?`
    )
    .get(input.candidateId) as
    | (ImageCandidateRow & { user_channel_id: string })
    | undefined;
  if (!candidate) throw new Error("candidate not found");

  const reason = input.reason?.trim() || null;
  db.prepare(
    `UPDATE image_candidates
     SET feedback = ?, feedback_reason = ?, feedback_at = ?
     WHERE id = ?`
  ).run(input.feedback, reason, nowSql(), input.candidateId);

  const sourceRefs = safeJson<ImageReference[]>(
    candidate.source_images_json,
    []
  );
  const referenceSummary = sourceRefs
    .slice(0, 3)
    .map((ref) => `${ref.kind}: "${ref.title}" (${ref.multiplier ?? "n/a"}x)`)
    .join("; ");
  const ruleValue = [
    input.feedback === "accepted" ? "Prefer" : "Avoid",
    candidate.rationale?.trim() || "this image direction",
    candidate.changes?.trim() ? `Changes: ${candidate.changes.trim()}` : null,
    reason ? `Feedback: ${reason}` : null,
    referenceSummary ? `Sources: ${referenceSummary}` : null,
  ]
    .filter(Boolean)
    .join(". ");

  db.prepare(
    `INSERT INTO image_feedback_rules
       (user_channel_id, rule_type, rule_value, source_candidate_id, source_feedback)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    candidate.user_channel_id,
    input.feedback === "accepted" ? "accepted_pattern" : "rejected_pattern",
    ruleValue.slice(0, 1200),
    input.candidateId,
    reason
  );

  if (input.feedback === "accepted") {
    markRunPhase(candidate.run_id, "completed");
  }
}

export function setImageSourceFeedback(input: {
  source: ImageReference;
  feedback: "liked" | "disliked";
  reason?: string | null;
  topicKey?: string | null;
}): void {
  const activeChannelId = getActiveChannelId();
  if (!activeChannelId) {
    throw new Error("no active channel — connect one from the top-right channel switcher");
  }
  const reason = input.reason?.trim() || null;
  const topicKey = input.topicKey?.trim() || null;
  db.prepare(
    `INSERT INTO image_source_feedback
       (user_channel_id, source_id, source_video_id, source_url, source_title,
        source_channel_name, source_channel_handle, feedback, reason, topic_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_channel_id, source_url) DO UPDATE SET
       source_id = excluded.source_id,
       source_video_id = excluded.source_video_id,
       source_title = excluded.source_title,
       source_channel_name = excluded.source_channel_name,
       source_channel_handle = excluded.source_channel_handle,
       feedback = excluded.feedback,
       reason = excluded.reason,
       topic_key = excluded.topic_key,
       updated_at = datetime('now')`
  ).run(
    activeChannelId,
    input.source.id,
    input.source.videoId,
    input.source.thumbnailUrl,
    input.source.title,
    input.source.channelName,
    input.source.channelHandle,
    input.feedback,
    reason,
    topicKey
  );

  const sourceSummary = [
    input.source.kind,
    `"${input.source.title}"`,
    input.source.channelName ? `from ${input.source.channelName}` : null,
    typeof input.source.multiplier === "number"
      ? `${input.source.multiplier.toFixed(1)}x outlier`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  const ruleValue = [
    input.feedback === "liked" ? "Prefer thumbnail source pattern" : "Avoid thumbnail source pattern",
    sourceSummary,
    reason ? `Feedback: ${reason}` : null,
    topicKey ? `Topic: ${topicKey}` : null,
  ]
    .filter(Boolean)
    .join(". ");
  db.prepare(
    `INSERT INTO image_feedback_rules
       (user_channel_id, rule_type, rule_value, source_candidate_id, source_feedback)
     VALUES (?, ?, ?, NULL, ?)`
  ).run(
    activeChannelId,
    input.feedback === "liked" ? "accepted_pattern" : "rejected_pattern",
    ruleValue.slice(0, 1200),
    reason
  );
}

function resolveDataPath(relativePath: string | null): string | null {
  if (!relativePath) return null;
  const absolute = path.resolve(DATA_DIR, relativePath);
  const root = path.resolve(DATA_DIR);
  if (!absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

function contentTypeForPath(absolute: string): string {
  const ext = path.extname(absolute).toLowerCase();
  return ext === ".webp"
    ? "image/webp"
    : ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".gif"
        ? "image/gif"
        : "image/png";
}

export function resolveCandidateImagePath(candidateId: string): {
  path: string;
  contentType: string;
} | null {
  const row = db
    .prepare(`SELECT image_path FROM image_candidates WHERE id = ?`)
    .get(candidateId) as { image_path: string | null } | undefined;
  const absolute = resolveDataPath(row?.image_path ?? null);
  if (!absolute) return null;
  return { path: absolute, contentType: contentTypeForPath(absolute) };
}

export function resolveAttachmentPath(attachmentId: string): {
  path: string;
  contentType: string;
} | null {
  const rows = db
    .prepare(`SELECT attachments_json FROM image_runs WHERE attachments_json != '[]'`)
    .all() as { attachments_json: string }[];
  for (const row of rows) {
    const attachments = safeJson<ImageAttachment[]>(row.attachments_json, []);
    const attachment = attachments.find((item) => item.id === attachmentId);
    if (!attachment) continue;
    const absolute = resolveDataPath(attachment.path);
    if (!absolute) return null;
    return { path: absolute, contentType: attachment.contentType };
  }
  return null;
}
