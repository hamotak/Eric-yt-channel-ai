import "server-only";

import { getIntegration } from "@/lib/db";

const BASE_URL = "https://69labs.vip/api/v1";
const MODEL_CACHE_MS = 60_000;
const LIMIT_CACHE_MS = 10_000;

export type SixtyNineModel = {
  id: string;
  name?: string;
  supportsImageInput?: boolean;
  maxImageUrls?: number;
  aspectRatios?: Array<string | { label?: string; value?: string }>;
  resolutions?: Array<string | { label?: string; value?: string }>;
};

export type SixtyNineImageLimits = {
  maxConcurrentJobs?: number;
  activeJobs?: number;
  remainingJobs?: number;
  priorityLevel?: number;
  maxPerGeneration?: number;
};

export type SixtyNineJobStatus =
  | "PENDING"
  | "PROCESSING"
  | "FINALIZING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "CENSORED";

type ModelsResponse = {
  models?: SixtyNineModel[];
  defaultModelId?: string;
};

type FullModelsResponse = {
  images?: {
    enabled?: boolean;
    limits?: SixtyNineImageLimits;
    models?: SixtyNineModel[];
    defaultModelId?: string;
  };
};

type GenerateResponse = {
  id?: string;
  jobId?: string;
  queuePosition?: number;
};

export type ImageJobStatusResponse = {
  id?: string;
  status: SixtyNineJobStatus;
  code?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
  error?: unknown;
  message?: unknown;
  userMessage?: unknown;
  failureReason?: unknown;
  providerMessage?: unknown;
  outputMetadata?: unknown;
};

type SixtyNineApiError = Error & {
  status?: number;
  retryAfterMs?: number;
  detail?: string;
};

let modelCache:
  | {
      apiKeyFingerprint: string;
      expiresAt: number;
      models: SixtyNineModel[];
    }
  | null = null;

let imageLimitsCache:
  | {
      apiKeyFingerprint: string;
      expiresAt: number;
      limits: SixtyNineImageLimits | null;
    }
  | null = null;

function getApiKey(): string {
  const key = getIntegration("69labs")?.api_key?.trim();
  if (!key) {
    throw new Error("69labs API key missing — add it in /settings/integrations");
  }
  return key;
}

function apiKeyFingerprint(key = getApiKey()): string {
  return `${key.length}:${key.slice(0, 4)}:${key.slice(-4)}`;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

export function retryAfterMsFromHeader(value: string | null): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, 5 * 60 * 1000);
}

export function isProviderCapacityDetail(status: number, detail: string): boolean {
  return (
    status === 403 &&
    /\bconcurrent\b|active jobs?|provider full|please wait for current jobs?|capacity|slots?/i.test(
      detail
    )
  );
}

function detailFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of [
    "code",
    "errorCode",
    "errorMessage",
    "error",
    "message",
    "userMessage",
    "failureReason",
    "providerMessage",
    "detail",
    "details",
    "reason",
    "statusText",
  ]) {
    const detail = detailFromUnknown(record[key]);
    if (detail) return detail;
  }
  try {
    const compact = JSON.stringify(value);
    return compact && compact !== "{}" ? compact.slice(0, 500) : null;
  } catch {
    return null;
  }
}

async function call69<T>(
  path: string,
  init: RequestInit = {}
): Promise<{ data: T; response: Response }> {
  const apiKey = getApiKey();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = detailFromUnknown(await response.json()) ?? "";
    } catch {
      detail = await response.text().catch(() => "");
    }
    const error = new Error(
      `69labs ${response.status}: ${detail || response.statusText}`
    ) as SixtyNineApiError;
    error.status = response.status;
    error.detail = detail || response.statusText;
    const retryAfterMs = retryAfterMsFromHeader(response.headers.get("Retry-After"));
    if (retryAfterMs) {
      error.retryAfterMs = retryAfterMs;
    }
    throw error;
  }
  return { data: (await response.json()) as T, response };
}

export async function listImageModels(): Promise<SixtyNineModel[]> {
  const fingerprint = apiKeyFingerprint();
  if (
    modelCache &&
    modelCache.apiKeyFingerprint === fingerprint &&
    modelCache.expiresAt > Date.now()
  ) {
    return modelCache.models;
  }
  const { data } = await call69<ModelsResponse>("/images/models");
  const models = Array.isArray(data.models) ? data.models : [];
  modelCache = {
    apiKeyFingerprint: fingerprint,
    expiresAt: Date.now() + MODEL_CACHE_MS,
    models,
  };
  return models;
}

export async function getImageLimits(): Promise<SixtyNineImageLimits | null> {
  const fingerprint = apiKeyFingerprint();
  if (
    imageLimitsCache &&
    imageLimitsCache.apiKeyFingerprint === fingerprint &&
    imageLimitsCache.expiresAt > Date.now()
  ) {
    return imageLimitsCache.limits;
  }
  const { data } = await call69<FullModelsResponse>("/models");
  const limits = data.images?.limits
    ? {
        maxConcurrentJobs: positiveInt(data.images.limits.maxConcurrentJobs),
        activeJobs: positiveInt(data.images.limits.activeJobs),
        remainingJobs: positiveInt(data.images.limits.remainingJobs),
        priorityLevel: positiveInt(data.images.limits.priorityLevel),
        maxPerGeneration: positiveInt(data.images.limits.maxPerGeneration),
      }
    : null;
  imageLimitsCache = {
    apiKeyFingerprint: fingerprint,
    expiresAt: Date.now() + LIMIT_CACHE_MS,
    limits,
  };
  return limits;
}

function optionValues(
  options: Array<string | { label?: string; value?: string }> | undefined
): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => (typeof option === "string" ? option : option.value ?? option.label ?? ""))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function supportsRatio(model: SixtyNineModel, aspectRatio: string): boolean {
  const values = optionValues(model.aspectRatios);
  if (values.length === 0) {
    return true;
  }
  return values.includes(aspectRatio.toLowerCase());
}

function supportsResolution(model: SixtyNineModel, resolution: string): boolean {
  const values = optionValues(model.resolutions);
  if (values.length === 0) {
    return true;
  }
  return values.includes(resolution.toLowerCase());
}

function modelName(model: SixtyNineModel): string {
  return `${model.id} ${model.name ?? ""}`.toLowerCase();
}

function normalizedModelName(model: SixtyNineModel): string {
  return modelName(model).replace(/[-_]+/g, " ");
}

function isPro(model: SixtyNineModel): boolean {
  return modelName(model).includes("pro");
}

function isNanoBananaPro(model: SixtyNineModel): boolean {
  const name = normalizedModelName(model);
  return name.includes("nano banana") && isPro(model);
}

export async function chooseImageModel(input: {
  needsImageInput: boolean;
  aspectRatio: string;
  resolution: string;
}): Promise<SixtyNineModel> {
  const models = await listImageModels();
  const eligible = models.filter((model) => {
    if (!supportsRatio(model, input.aspectRatio)) return false;
    if (!supportsResolution(model, input.resolution)) return false;
    if (input.needsImageInput && !model.supportsImageInput) return false;
    return true;
  });
  const chosen = eligible.find((model) => isNanoBananaPro(model)) ?? null;
  if (!chosen) {
    throw new Error(
      input.needsImageInput
        ? `No 69labs Nano Banana Pro image-input model supports ${input.aspectRatio} at ${input.resolution.toUpperCase()}`
        : `No 69labs Nano Banana Pro image model supports ${input.aspectRatio} at ${input.resolution.toUpperCase()}`
    );
  }
  return chosen;
}

export async function assertImageModelCompatible(input: {
  model: string;
  needsImageInput: boolean;
  aspectRatio: string;
  resolution: string;
}): Promise<SixtyNineModel> {
  const models = await listImageModels();
  const model = models.find((item) => item.id === input.model);
  if (!model) {
    throw new Error(`69labs image model is not available: ${input.model}`);
  }
  if (!isNanoBananaPro(model)) {
    throw new Error(`Image Studio is configured to use Nano Banana Pro only, got ${input.model}`);
  }
  if (!supportsRatio(model, input.aspectRatio)) {
    throw new Error(
      `69labs Nano Banana Pro does not support aspect ratio ${input.aspectRatio}`
    );
  }
  if (!supportsResolution(model, input.resolution)) {
    throw new Error(
      `69labs Nano Banana Pro does not support ${input.resolution.toUpperCase()} resolution`
    );
  }
  if (input.needsImageInput && !model.supportsImageInput) {
    throw new Error("69labs Nano Banana Pro does not support image input on this account");
  }
  return model;
}

export function imageJobFailureMessage(status: ImageJobStatusResponse): string {
  return (
    detailFromUnknown(status.error) ??
    detailFromUnknown(status.message) ??
    detailFromUnknown(status.errorMessage) ??
    detailFromUnknown(status.errorCode) ??
    detailFromUnknown(status.code) ??
    detailFromUnknown(status.userMessage) ??
    detailFromUnknown(status.failureReason) ??
    detailFromUnknown(status.providerMessage) ??
    detailFromUnknown(status.outputMetadata) ??
    "Image provider failed without details"
  );
}

export function formatImageJobFailure(status: ImageJobStatusResponse): string {
  const detail = imageJobFailureMessage(status);
  if (/^image provider\b/i.test(detail)) return detail;
  const statusLabel = status.status.toLowerCase();
  return status.status === "FAILED"
    ? `Image provider failed: ${detail}`
    : `Image provider ${statusLabel}: ${detail}`;
}

export async function submitImageJob(input: {
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution?: string | null;
  imageUrls: string[];
}): Promise<{ jobId: string; queuePosition: number | null }> {
  await assertImageModelCompatible({
    model: input.model,
    needsImageInput: input.imageUrls.length > 0,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution ?? "1k",
  });
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    model: input.model,
    aspectRatio: input.aspectRatio,
    imageUrls: input.imageUrls,
  };
  if (input.resolution) {
    body.resolution = input.resolution;
  }
  const { data } = await call69<GenerateResponse>("/images/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const jobId = data.id ?? data.jobId;
  if (!jobId) throw new Error("69labs did not return a job id");
  return {
    jobId,
    queuePosition:
      typeof data.queuePosition === "number" ? data.queuePosition : null,
  };
}

export async function getImageJobStatus(
  jobId: string
): Promise<ImageJobStatusResponse> {
  const { data } = await call69<ImageJobStatusResponse>(
    `/images/status/${encodeURIComponent(jobId)}`
  );
  return data;
}

export async function downloadImageJob(jobId: string): Promise<{
  bytes: Buffer;
  contentType: string;
}> {
  const apiKey = getApiKey();
  const response = await fetch(
    `${BASE_URL}/images/download/${encodeURIComponent(jobId)}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      redirect: "follow",
    }
  );
  if (!response.ok) {
    throw new Error(`69labs download ${response.status}: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    bytes: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type") ?? "image/png",
  };
}

export function isTerminalImageStatus(status: SixtyNineJobStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "CENSORED"
  );
}
