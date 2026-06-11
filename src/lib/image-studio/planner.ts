import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputContent,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { costMillicents } from "@/lib/ai-pricing";
import {
  DATA_DIR,
  getImagePlannerStyleProfile,
  getIntegration,
  recordAiUsage,
  upsertImagePlannerStyleProfile,
} from "@/lib/db";
import type {
  ImageAttachment,
  ImageDirection,
  ImageFeedbackRuleRow,
  ImageGenerationMode,
  ImagePlanningResult,
  ImagePlannerUsage,
  ImageReference,
  ImageRunMode,
} from "./types";

export const IMAGE_STUDIO_PLANNER_PROVIDER = "openai";
export const IMAGE_STUDIO_PLANNER_MODEL = "gpt-5.5";
export const IMAGE_STUDIO_FALLBACK_PROVIDER = "anthropic";
export const IMAGE_STUDIO_FALLBACK_MODEL = "claude-sonnet-4-6";
const MAX_REFERENCE_IMAGES_PER_DIRECTION = 2;
const MAX_SELECTED_REFERENCE_INPUT_IMAGES = 10;
const MAX_STYLE_IMAGE_INPUTS_PER_OUTCOME = 4;
const PLANNER_REQUEST_TIMEOUT_MS = 60000;
const PLANNER_CONNECTION_RETRIES = 4;
const PLANNER_CONNECTION_FAILURE_MESSAGE =
  "Image planner timed out before rendering started. Please retry in a moment.";

const SOP_BRAIN = `
Image Studio SOP for YouTube thumbnail work:
- Never start from random creativity when a YouTube idea/outlier is available.
- Study title + thumbnail together, then reuse proven click psychology without naming it in the renderer prompt.
- Use 2x+ outliers as proof and prefer 3x+ outliers.
- Look for layout, text placement, colors, main object, contrast, emotion, and curiosity hook.
- Recreate the same psychology while changing topic, colors, objects, details, and composition enough to be original.
- For Ideate launches, think "edit/remix the proven structure" before "generate a random new image."
- Use AI for execution and iteration, not for random strategy.
- Science thumbnail defaults: bright saturated focal point on a dark or duller background, highlighted subject edges, complementary color contrast, and clean separation.
- Hooks: familiar science subject plus a shocking or impossible detail that creates a question.
- Simplicity: one focal point, two to four words, curiosity over information, readable at mobile/TV size.
- Channel consistency: match recurring font logic, color logic, composition habits, and recognizable visual structure privately; do not write generic preservation instructions in the renderer prompt.
- Final output must be HD, sharp, uncluttered, and readable when zoomed out.
- Public thumbnail references encoded in this SOP: YouTube Help thumbnail tips, high-contrast/simple-subject guidance, background de-emphasis and scaling advice, and contrast/color/text-limit guidance.
`;

type PlannerJson = {
  referenceAnalysis?: unknown;
  styleProfile?: unknown;
  directions?: Array<{
    rank?: number;
    label?: string;
    rationale?: string;
    prompt?: string;
    providerPrompt?: string;
    visualRead?: string;
    visibleElements?: unknown;
    sourceInventory?: unknown;
    editReason?: string;
    thumbnailRuleCheck?: string;
    changes?: string;
    critique?: string;
    imageUrl?: string;
    imageUrls?: string[];
    selectedReferenceId?: string;
    referenceIds?: string[];
  }>;
};

type ContextVideo = {
  title: string;
  views: number | null;
  thumbnailUrl: string | null;
};

type ContextIdea = {
  title: string;
  score: number | null;
  method: string | null;
};

type ContextStyleExample = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  views: number;
  medianViews: number;
  multiplier: number;
  publishedAt: number | null;
  outcome: "winner" | "loser";
};

function getOpenAIClient(): OpenAI {
  const apiKey = getIntegration("openai")?.api_key?.trim();
  if (!apiKey) {
    throw new Error("OpenAI API key missing — set it in /settings/integrations");
  }
  return new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: PLANNER_REQUEST_TIMEOUT_MS,
  });
}

function getAnthropicClient(): Anthropic {
  const apiKey = getIntegration("claude")?.api_key?.trim();
  if (!apiKey) {
    throw new Error("Anthropic API key missing — set it in /settings/integrations");
  }
  return new Anthropic({
    apiKey,
    maxRetries: 0,
    timeout: PLANNER_REQUEST_TIMEOUT_MS,
  });
}

function isPlannerConnectionError(error: unknown): boolean {
  const name =
    typeof (error as { name?: unknown })?.name === "string"
      ? ((error as { name: string }).name)
      : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return (
    name === "APIConnectionError" ||
    /connection error|fetch failed|network|timeout|timed out|request timed out|econnreset|etimedout/i.test(message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createAnthropicPlannerMessage(
  client: Anthropic,
  body: MessageCreateParamsNonStreaming
): Promise<Message> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PLANNER_CONNECTION_RETRIES; attempt += 1) {
    try {
      return await client.messages.create(body);
    } catch (error) {
      lastError = error;
      if (!isPlannerConnectionError(error) || attempt === PLANNER_CONNECTION_RETRIES) {
        if (isPlannerConnectionError(error)) {
          const wrapped = new Error(PLANNER_CONNECTION_FAILURE_MESSAGE) as Error & {
            cause?: unknown;
          };
          wrapped.cause = error;
          throw wrapped;
        }
        throw error;
      }
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError;
}

async function createOpenAIPlannerResponse(
  client: OpenAI,
  body: ResponseCreateParamsNonStreaming
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PLANNER_CONNECTION_RETRIES; attempt += 1) {
    try {
      return await client.responses.create(body);
    } catch (error) {
      lastError = error;
      if (!isPlannerConnectionError(error) || attempt === PLANNER_CONNECTION_RETRIES) {
        if (isPlannerConnectionError(error)) {
          const wrapped = new Error(PLANNER_CONNECTION_FAILURE_MESSAGE) as Error & {
            cause?: unknown;
          };
          wrapped.cause = error;
          throw wrapped;
        }
        throw error;
      }
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError;
}

function buildSystemPrompt(): string {
  return [
    "You are a senior image generation prompt director and YouTube thumbnail strategist.",
    "You follow the user's SOP exactly when the run is for a YouTube idea.",
    "Output only strict JSON. No markdown.",
    "For ideation-sourced runs, create edit/remix prompts from the best proven reference thumbnail.",
    "For direct image-generation runs, create production-ready 69labs prompts while respecting the user's prompt.",
  ].join("\n");
}

function referenceText(refs: ImageReference[]): string {
  if (refs.length === 0) return "(none)";
  return refs
    .map((ref) => {
      const mult =
        typeof ref.multiplier === "number" ? `${ref.multiplier.toFixed(2)}x` : "n/a";
      const views = typeof ref.views === "number" ? ref.views.toLocaleString("en-US") : "n/a";
      return [
        `ID: ${ref.id}`,
        `kind: ${ref.kind}`,
        `title: ${ref.title}`,
        `channel: ${ref.channelName ?? "unknown"} ${ref.channelHandle ?? ""}`.trim(),
        `performance: ${mult}, views ${views}`,
        `relevance: ${ref.relevanceScore ?? "n/a"} (${(ref.relevanceLabels ?? []).join(", ") || "unlabeled"})`,
        ref.feedback ? `user_source_feedback: ${ref.feedback}${ref.feedbackReason ? ` — ${ref.feedbackReason}` : ""}` : null,
        `reason: ${ref.reason}`,
        `thumbnail_url: ${ref.thumbnailUrl}`,
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function scrubInternalText(value: string): string {
  return value
    .replace(
      /\(\b(?=[A-Za-z0-9_-]{8,}\b)(?:(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+|(?=[A-Za-z0-9_-]*_)[A-Za-z0-9_-]+|(?=[A-Za-z0-9_-]*-)(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]+)\b\)/g,
      ""
    )
    .replace(
      /\b(?=[A-Za-z0-9_-]{8,}\b)(?:(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+|(?=[A-Za-z0-9_-]*_)[A-Za-z0-9_-]+|(?=[A-Za-z0-9_-]*-)(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]+)\b/g,
      ""
    )
    .replace(/\b\d+(?:\.\d+)?\s*(?:x|×)\+?\b/gi, "")
    .replace(/\b(?:outlier|outliers)\b/gi, "reference")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function compactText(value: string | undefined, fallback: string, max = 220): string {
  const cleaned = scrubInternalText(value?.trim() || fallback);
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3).trimEnd()}...`;
}

function rulesText(rules: ImageFeedbackRuleRow[]): string {
  if (rules.length === 0) return "(none yet)";
  return rules
    .map((rule) => `- ${rule.rule_type}: ${rule.rule_value}`)
    .join("\n");
}

function videosText(videos: ContextVideo[]): string {
  if (videos.length === 0) return "(none synced)";
  return videos
    .map((video) => {
      const views =
        typeof video.views === "number"
          ? video.views.toLocaleString("en-US")
          : "views n/a";
      return `- ${video.title} (${views})`;
    })
    .join("\n");
}

function ideasText(ideas: ContextIdea[]): string {
  if (ideas.length === 0) return "(none yet)";
  return ideas
    .map((idea) => {
      const score = typeof idea.score === "number" ? `${idea.score}/10` : "n/a";
      return `- ${idea.title} (${idea.method ?? "unknown method"}, score ${score})`;
    })
    .join("\n");
}

function styleExamplesText(examples: ContextStyleExample[]): string {
  if (examples.length === 0) return "(none synced in the last 30 days)";
  return examples
    .map((example) => {
      const views = example.views.toLocaleString("en-US");
      const median = example.medianViews.toLocaleString("en-US");
      return [
        `- ${example.outcome.toUpperCase()}: ${example.title}`,
        `  video_id: ${example.videoId}`,
        `  performance: ${example.multiplier.toFixed(2)}x, views ${views}, median ${median}`,
        example.thumbnailUrl ? `  thumbnail_url: ${example.thumbnailUrl}` : null,
      ].filter(Boolean).join("\n");
    })
    .join("\n");
}

function savedStyleProfileText(value: unknown): string {
  if (!value) return "(none yet)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "(unreadable saved profile)";
  }
}

function attachmentText(attachments: ImageAttachment[]): string {
  if (attachments.length === 0) return "(none)";
  return attachments
    .map((file) => `- ${file.fileName} (${file.contentType}, ${file.size} bytes)`)
    .join("\n");
}

function buildUserText(input: {
  prompt: string;
  title: string | null;
  mode: ImageRunMode;
  generationMode: ImageGenerationMode;
  sampleCount: number;
  aspectRatio: string;
  resolution: string;
  channelTitle: string | null;
  channelBrief: string;
  thumbnailStyleGoals: string;
  thumbnailDesignRules: string;
  learnedRules: ImageFeedbackRuleRow[];
  references: ImageReference[];
  attachments: ImageAttachment[];
  currentVideos: ContextVideo[];
  recentIdeas: ContextIdea[];
  channelStyleExamples: ContextStyleExample[];
  savedStyleProfile: unknown;
}): string {
  const isRemix = input.mode === "ideate" || input.generationMode === "remix";
  return `
${SOP_BRAIN}

Run mode: ${input.mode}
Generation mode: ${input.generationMode}
Aspect ratio: ${input.aspectRatio}
Resolution: ${input.resolution.toUpperCase()}
Sample count requested: ${input.sampleCount}

User prompt / target title:
${input.prompt}

Target video title, if this came from Ideate:
${input.title ?? "(not an Ideate run)"}

Active channel:
${input.channelTitle ?? "Unknown channel"}

Channel brief:
${input.channelBrief || "(none set)"}

Channel thumbnail notes:
Style goals:
${input.thumbnailStyleGoals || "(none set)"}

Design rules:
${input.thumbnailDesignRules || "(none set)"}

Current channel videos:
${videosText(input.currentVideos)}

Recent ideas:
${ideasText(input.recentIdeas)}

Saved channel thumbnail style profile:
${savedStyleProfileText(input.savedStyleProfile)}

Last-30-day channel winners and losers:
${styleExamplesText(input.channelStyleExamples)}

Learned Image Studio feedback rules:
${rulesText(input.learnedRules)}

Attached images:
${attachmentText(input.attachments)}

Selected outlier/reference thumbnails:
${referenceText(input.references)}

Return JSON only, with this exact shape:
{
  "styleProfile": {
    "winningPatterns": ["compact channel thumbnail traits that worked"],
    "losingPatterns": ["compact channel thumbnail traits that underperformed"],
    "applyNext": ["compact action rules for future Image Studio planning"]
  },
  "directions": [
    {
      "rank": 1,
      "label": "short name",
      "selectedReferenceId": "one best reference ID",
      "imageUrl": "matching image URL",
      "visualRead": "private: what visually works or fails in that source thumbnail",
      "visibleElements": ["private: only objects, text, colors, and layout features you can actually see in the selected source"],
      "thumbnailRuleCheck": "private: how the edit handles color pop, simplicity, curiosity, and mobile readability",
      "visualBrainstorm": "private: 2-3 possible visual moves considered before choosing this direction",
      "visibleDifference": "private: what will be obviously different from the other returned directions",
      "editReason": "private: why this source fits the target title",
      "providerPrompt": "short provider instruction sent to the image renderer",
      "changes": "one short sentence describing the visible edit",
      "critique": "one short risk to watch",
      "imageUrls": ["same single image URL"],
      "referenceIds": ["same single reference ID"]
    }
  ]
}

Rules:
- Return exactly ${input.sampleCount} directions with ranks 1 through ${input.sampleCount}.
- Before choosing, visually inspect the source thumbnails: layout, focal object, colors, text, weirdness, clarity, and whether the structure can carry the target idea.
- Internally compare recent channel winners and losers before writing directions. Reuse the saved style profile when it agrees with visible evidence.
- Return a compact top-level styleProfile so future runs can start from learned channel-specific thumbnail patterns.
- Make every direction meaningfully different: different source choice, camera angle/crop, color system, subject treatment, text, outline/glow treatment, or curiosity hook.
- If ${input.sampleCount} is 4, produce four clearly distinct edits, not four near-duplicates. Prefer four different source thumbnails when four viable sources exist.
- If fewer than four viable source thumbnails exist, reuse the strongest source only when needed and vary angle/crop, focal scale, color palette, outline/glow, text phrase, object placement, and hook.
- For every direction, privately answer visibleDifference with what will be obviously different from the other directions.
- If run mode is ideate or generation mode is remix, this is an edit/remix task, not a fresh image task.
- For ideate/remix with any selected references, use exactly 1 best imageUrl and matching referenceId.
- ${isRemix ? "For ideate/remix, providerPrompt is an action-only edit brief for the attached source image. Do not write the phrase \"Edit attached thumbnail\"." : "For source-free/direct generation, write a fresh generation prompt."}
- providerPrompt is the only text sent to 69labs. Keep it punchy: 2-4 short sentences, max 350 characters.
- providerPrompt must include only concrete edits: text replacement, subject swap, color/contrast/style shift, object placement, expression/shape/detail change.
- Start providerPrompt with an action verb such as Replace, Recolor, Remove, Add, Boost, Darken, Brighten, Enlarge, Lower, Highlight, Shift, Simplify, Crop, Make, or Turn.
- The renderer receives the image separately, so do not mention attaching, references, analytics, strategy, source titles, or model/provider names.
- Hard-ban these words/phrases in providerPrompt for ideate/remix: keep, preserve, maintain, retain, remain, still, same, "Edit attached thumbnail", "Do not create", "reference thumbnail", "target title", "focal hierarchy", "overall YouTube thumbnail psychology".
- Avoid provider-filter-prone biological/body wording in providerPrompt: sickly, organic, vein/veins, alive, living, biological, flesh, blood, infected, diseased, corpse, rotting.
- Use safer visual language instead: electric signal lines, glowing fracture pattern, warning glow, anomaly mark, saturated rim light, cyan/orange contrast, clean scan line.
- Do not use lazy generic visualizations like waveform, signal waveform, pulse line, or abstract data wave unless the selected source visibly uses that motif or the target topic specifically demands it.
- Think through the final image before writing providerPrompt: imagine whether the thumbnail would still look readable, curiosity-driven, source-aware, and visually different from the other candidates.
- Apply the channel thumbnail notes privately when choosing source thumbnails and visual edits. Do not quote those notes in providerPrompt; turn them into concrete actions only when relevant.
- If you name an object in providerPrompt, it must be visibly present in visibleElements/sourceInventory or be introduced by an action like Add, Replace, Swap, or Remove.
- Do not say "keep the telescope" or any similar claim unless the object is visible, and prefer action wording instead.
- Keep thumbnail text short and similar in rhythm/style when useful, e.g. source text "THIS IS SCARY" can become "THIS IS STRANGE".
- Use the target title only as context. Do not repeat the full video title in providerPrompt.
- Never put reference titles, target titles, analytics, model names, IDs, scores, or internal reasoning in providerPrompt.
- Do not write phrases like "Do not create a new unrelated thumbnail", "preserve the original layout, structure, composition", "focal hierarchy", or "overall YouTube thumbnail psychology" in providerPrompt.
- Use exactly 2 imageUrls only when the user explicitly asks to mix two references.
- If no source image exists, imageUrls must be [] and the prompt must clearly say it is a fresh generation.
- Use only imageUrls and referenceIds from the selected reference list.
- Do not use more than ${MAX_REFERENCE_IMAGES_PER_DIRECTION} imageUrls or referenceIds in any direction.
- For YouTube thumbnails, use 0-4 words and make the text complement the title, not repeat it.
- Keep rationale, changes, and critique short. Do not mention video IDs, multipliers, model names, scores, or internal analysis.
- Prompts must be practical for an image model and must not include source analytics, video IDs, multipliers, or internal reasoning.
`.trim();
}

function parsePlannerJson(text: string): PlannerJson | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as PlannerJson;
  } catch {
    const match = /\{[\s\S]*\}/.exec(trimmed);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as PlannerJson;
    } catch {
      return null;
    }
  }
}

const OPENAI_PLANNER_TEXT_FORMAT = {
  format: {
    type: "json_schema" as const,
    name: "image_studio_plan",
    description: "Image Studio thumbnail planning output",
    strict: false,
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        styleProfile: {
          type: "object",
          additionalProperties: true,
        },
        directions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              rank: { type: "number" },
              label: { type: "string" },
              selectedReferenceId: { type: "string" },
              imageUrl: { type: "string" },
              visualRead: { type: "string" },
              visibleElements: { type: "array", items: { type: "string" } },
              thumbnailRuleCheck: { type: "string" },
              visualBrainstorm: { type: "string" },
              visibleDifference: { type: "string" },
              editReason: { type: "string" },
              providerPrompt: { type: "string" },
              changes: { type: "string" },
              critique: { type: "string" },
              imageUrls: { type: "array", items: { type: "string" } },
              referenceIds: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      required: ["directions"],
    },
  },
};

function normalizeDirections(
  parsed: PlannerJson | null,
  references: ImageReference[],
  sampleCount: number,
  requireReference: boolean
): ImageDirection[] {
  const urlSet = new Set(references.map((ref) => ref.thumbnailUrl));
  const idSet = new Set(references.map((ref) => ref.id));
  const refById = new Map(references.map((ref) => [ref.id, ref]));
  const refByUrl = new Map(references.map((ref) => [ref.thumbnailUrl, ref]));
  const directions = Array.isArray(parsed?.directions) ? parsed!.directions : [];
  const normalized: ImageDirection[] = [];

  for (const raw of directions) {
    const rankNumber =
      typeof raw.rank === "number"
        ? raw.rank
        : typeof raw.rank === "string"
          ? Number(raw.rank)
          : NaN;
    const rank =
      rankNumber === 1 || rankNumber === 2 || rankNumber === 3 || rankNumber === 4
        ? rankNumber
        : null;
    const prompt = (raw.providerPrompt ?? raw.prompt)?.trim();
    const rationale = (raw.editReason ?? raw.rationale)?.trim();
    if (!rank || rank > sampleCount || !prompt) continue;
    const candidateIds = [
      raw.selectedReferenceId,
      ...(raw.referenceIds ?? []),
    ]
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter((id) => idSet.has(id));
    const idsFromUrls = [
      raw.imageUrl,
      ...(raw.imageUrls ?? []),
    ]
      .filter((url): url is string => typeof url === "string")
      .map((url) => url.trim())
      .filter((url) => urlSet.has(url))
      .map((url) => refByUrl.get(url)?.id)
      .filter((id): id is string => !!id);
    const referenceIds = [...new Set([...candidateIds, ...idsFromUrls])]
      .slice(0, MAX_REFERENCE_IMAGES_PER_DIRECTION);
    if (requireReference && referenceIds.length === 0 && references[0]) {
      referenceIds.push(references[0].id);
    }
    const imageUrls = referenceIds
      .map((id) => refById.get(id)?.thumbnailUrl)
      .filter((url): url is string => !!url);
    normalized.push({
      rank,
      label: raw.label?.trim() || `Direction ${rank}`,
      rationale: compactText(rationale, "Reference-aware remix direction."),
      prompt: scrubInternalText(prompt),
      changes: compactText(
        raw.changes ?? raw.visualRead,
        "Visual edit based on the selected source thumbnail."
      ),
      critique: compactText(raw.critique, "Check mobile readability and focal clarity.", 180),
      imageUrls,
      referenceIds,
    });
  }

  const byRank = new Map<number, ImageDirection>();
  for (const direction of normalized) byRank.set(direction.rank, direction);
  return Array.from({ length: sampleCount }, (_, i) => i + 1)
    .map((rank) => byRank.get(rank))
    .filter((direction): direction is ImageDirection => !!direction);
}

async function attachmentImageBlocks(
  attachments: ImageAttachment[]
): Promise<ContentBlockParam[]> {
  const blocks: ContentBlockParam[] = [];
  for (const attachment of attachments.slice(0, 4)) {
    if (!attachment.contentType.startsWith("image/")) continue;
    const absolute = path.resolve(DATA_DIR, attachment.path);
    const root = path.resolve(DATA_DIR);
    if (!absolute.startsWith(root + path.sep)) continue;
    const bytes = await fs.readFile(absolute);
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.contentType,
        data: bytes.toString("base64"),
      },
    } as ContentBlockParam);
  }
  return blocks;
}

async function attachmentOpenAIImageBlocks(
  attachments: ImageAttachment[]
): Promise<ResponseInputContent[]> {
  const blocks: ResponseInputContent[] = [];
  for (const attachment of attachments.slice(0, 4)) {
    if (!attachment.contentType.startsWith("image/")) continue;
    const absolute = path.resolve(DATA_DIR, attachment.path);
    const root = path.resolve(DATA_DIR);
    if (!absolute.startsWith(root + path.sep)) continue;
    const bytes = await fs.readFile(absolute);
    blocks.push({
      type: "input_image",
      image_url: `data:${attachment.contentType};base64,${bytes.toString("base64")}`,
      detail: "high",
    });
  }
  return blocks;
}

function styleImageUrls(
  examples: ContextStyleExample[],
  selectedReferences: ImageReference[]
): string[] {
  const used = new Set(selectedReferences.map((ref) => ref.thumbnailUrl));
  const pick = (outcome: ContextStyleExample["outcome"]) =>
    examples
      .filter((example) => example.outcome === outcome && example.thumbnailUrl)
      .slice(0, MAX_STYLE_IMAGE_INPUTS_PER_OUTCOME)
      .map((example) => example.thumbnailUrl!)
      .filter((url) => {
        if (used.has(url)) return false;
        used.add(url);
        return true;
      });
  return [...pick("winner"), ...pick("loser")];
}

function openAIUsageTokens(response: {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  } | null;
}) {
  const input = response.usage?.input_tokens ?? 0;
  const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputFresh: Math.max(0, input - cached),
    inputCacheRead: cached,
    inputCacheWrite: 0,
    output: response.usage?.output_tokens ?? 0,
  };
}

function parseSavedStyleProfile(userChannelId: string): unknown {
  const row = getImagePlannerStyleProfile(userChannelId);
  if (!row?.profile_json) return null;
  try {
    return JSON.parse(row.profile_json);
  } catch {
    return null;
  }
}

type PlanImageDirectionsInput = {
  userChannelId: string;
  prompt: string;
  title: string | null;
  mode: ImageRunMode;
  generationMode: ImageGenerationMode;
  sampleCount: number;
  aspectRatio: string;
  resolution: string;
  channelTitle: string | null;
  channelBrief: string;
  thumbnailStyleGoals: string;
  thumbnailDesignRules: string;
  learnedRules: ImageFeedbackRuleRow[];
  references: ImageReference[];
  attachments: ImageAttachment[];
  currentVideos: ContextVideo[];
  recentIdeas: ContextIdea[];
  channelStyleExamples: ContextStyleExample[];
};

export function directImageDirections(input: {
  prompt: string;
  sampleCount: number;
  aspectRatio: string;
  resolution: string;
}): ImagePlanningResult {
  const directions = Array.from({ length: input.sampleCount }, (_, index) => {
    const rank = (index + 1) as 1 | 2 | 3 | 4;
    return {
      rank,
      label: `Variation ${rank}`,
      rationale: "Direct generation from the user prompt.",
      prompt: `${input.prompt.trim()}\n\nAspect ratio: ${input.aspectRatio}. Resolution target: ${input.resolution.toUpperCase()}. High quality, sharp details, clean composition.`,
      changes: "Direct generation from the prompt.",
      critique: "Review whether the image follows the prompt closely enough.",
      imageUrls: [],
      referenceIds: [],
    };
  });
  return { directions, usage: null };
}

function assertValidPlannerDirections(input: {
  directions: ImageDirection[];
  sampleCount: number;
  requireReference: boolean;
  providerLabel: string;
}): void {
  if (input.directions.length !== input.sampleCount) {
    throw new Error(
      `${input.providerLabel} did not return the requested number of valid image directions`
    );
  }
  if (
    input.requireReference &&
    input.directions.some((direction) => direction.imageUrls.length === 0)
  ) {
    throw new Error(
      `${input.providerLabel} image planning did not keep the required reference thumbnail`
    );
  }
}

function persistStyleProfile(input: {
  userChannelId: string;
  provider: string;
  model: string;
  parsed: PlannerJson | null;
  channelStyleExamples: ContextStyleExample[];
}): void {
  if (!input.parsed?.styleProfile || typeof input.parsed.styleProfile !== "object") return;
  upsertImagePlannerStyleProfile({
    userChannelId: input.userChannelId,
    provider: input.provider,
    model: input.model,
    sourceWindowDays: 30,
    sourceVideoIds: input.channelStyleExamples.map((example) => example.videoId),
    profile: input.parsed.styleProfile,
  });
}

async function planWithOpenAI(input: PlanImageDirectionsInput): Promise<ImagePlanningResult> {
  const client = getOpenAIClient();
  const savedStyleProfile = parseSavedStyleProfile(input.userChannelId);
  const requireReference =
    (input.mode === "ideate" || input.generationMode === "remix") &&
    input.references.length > 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = Date.now();
    const repairNote =
      attempt === 0
        ? ""
        : "\n\nRepair instruction: the previous response was invalid. Return only valid JSON, exactly the requested number of directions, and use only allowed selected reference IDs/URLs.";
    const textInput = buildUserText({
      ...input,
      savedStyleProfile,
    }) + repairNote;
    const content: ResponseInputContent[] = [
      { type: "input_text", text: textInput },
      ...input.references.slice(0, MAX_SELECTED_REFERENCE_INPUT_IMAGES).map((ref) => ({
        type: "input_image" as const,
        image_url: ref.thumbnailUrl,
        detail: "high" as const,
      })),
      ...styleImageUrls(input.channelStyleExamples, input.references).map((url) => ({
        type: "input_image" as const,
        image_url: url,
        detail: "high" as const,
      })),
      ...(await attachmentOpenAIImageBlocks(input.attachments)),
    ];
    const body = {
      model: IMAGE_STUDIO_PLANNER_MODEL,
      instructions: buildSystemPrompt(),
      input: [
        {
          role: "user",
          content,
        },
      ] satisfies ResponseInputItem[],
      reasoning: { effort: "high" as const },
      max_output_tokens: 7000,
      prompt_cache_key: `image-studio:${input.userChannelId}`,
      prompt_cache_retention: "24h" as const,
      text: OPENAI_PLANNER_TEXT_FORMAT,
      store: false,
    };
    const response = await createOpenAIPlannerResponse(client, body);
    const durationMs = Date.now() - started;
    const tokens = openAIUsageTokens(response);
    const usage: ImagePlannerUsage = {
      provider: IMAGE_STUDIO_PLANNER_PROVIDER,
      model: IMAGE_STUDIO_PLANNER_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheWriteTokens: 0,
      cacheReadTokens: tokens.inputCacheRead,
      durationMs,
      costMillicents: costMillicents(IMAGE_STUDIO_PLANNER_MODEL, tokens),
    };
    recordAiUsage({
      sessionId: null,
      provider: IMAGE_STUDIO_PLANNER_PROVIDER,
      executorModel: IMAGE_STUDIO_PLANNER_MODEL,
      advisorModel: null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheReadTokens: usage.cacheReadTokens,
      advisorInputTokens: 0,
      advisorOutputTokens: 0,
      advisorCalls: 0,
      costMillicents: usage.costMillicents,
      durationMs,
      iterations: attempt + 1,
      firstUserMsg: `Image Studio: ${input.prompt.slice(0, 160)}`,
      activeTools: ["image_studio", "openai_planner"],
    });
    const parsed = parsePlannerJson(response.output_text ?? "");
    const directions = normalizeDirections(
      parsed,
      input.references,
      input.sampleCount,
      requireReference
    );
    try {
      assertValidPlannerDirections({
        directions,
        sampleCount: input.sampleCount,
        requireReference,
        providerLabel: "OpenAI GPT-5.5",
      });
      persistStyleProfile({
        userChannelId: input.userChannelId,
        provider: IMAGE_STUDIO_PLANNER_PROVIDER,
        model: IMAGE_STUDIO_PLANNER_MODEL,
        parsed,
        channelStyleExamples: input.channelStyleExamples,
      });
      return { directions, usage };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OpenAI planner failed");
}

async function planWithAnthropic(input: PlanImageDirectionsInput): Promise<ImagePlanningResult> {
  const client = getAnthropicClient();
  const savedStyleProfile = parseSavedStyleProfile(input.userChannelId);
  const started = Date.now();
  const requireReference =
    (input.mode === "ideate" || input.generationMode === "remix") &&
    input.references.length > 0;
  const content: ContentBlockParam[] = [
    { type: "text", text: buildUserText({ ...input, savedStyleProfile }) },
    ...input.references.slice(0, MAX_SELECTED_REFERENCE_INPUT_IMAGES).map((ref) => ({
      type: "image" as const,
      source: { type: "url" as const, url: ref.thumbnailUrl },
    })),
    ...styleImageUrls(input.channelStyleExamples, input.references).map((url) => ({
      type: "image" as const,
      source: { type: "url" as const, url },
    })),
    ...(await attachmentImageBlocks(input.attachments)),
  ];

  const response = await createAnthropicPlannerMessage(client, {
    model: IMAGE_STUDIO_FALLBACK_MODEL,
    max_tokens: 7000,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content }],
  });
  const durationMs = Date.now() - started;
  const usage: ImagePlannerUsage = {
    provider: IMAGE_STUDIO_FALLBACK_PROVIDER,
    model: IMAGE_STUDIO_FALLBACK_MODEL,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
    durationMs,
    costMillicents: costMillicents(IMAGE_STUDIO_FALLBACK_MODEL, {
      inputFresh: response.usage?.input_tokens ?? 0,
      inputCacheWrite: response.usage?.cache_creation_input_tokens ?? 0,
      inputCacheRead: response.usage?.cache_read_input_tokens ?? 0,
      output: response.usage?.output_tokens ?? 0,
    }),
  };

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  recordAiUsage({
    sessionId: null,
    provider: IMAGE_STUDIO_FALLBACK_PROVIDER,
    executorModel: IMAGE_STUDIO_FALLBACK_MODEL,
    advisorModel: null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheReadTokens: usage.cacheReadTokens,
    advisorInputTokens: 0,
    advisorOutputTokens: 0,
    advisorCalls: 0,
    costMillicents: usage.costMillicents,
    durationMs,
    iterations: 1,
    firstUserMsg: `Image Studio: ${input.prompt.slice(0, 160)}`,
    activeTools: ["image_studio", "anthropic_fallback"],
  });

  const parsed = parsePlannerJson(text);
  const directions = normalizeDirections(
    parsed,
    input.references,
    input.sampleCount,
    requireReference
  );
  assertValidPlannerDirections({
    directions,
    sampleCount: input.sampleCount,
    requireReference,
    providerLabel: "Claude Sonnet 4.6",
  });
  persistStyleProfile({
    userChannelId: input.userChannelId,
    provider: IMAGE_STUDIO_FALLBACK_PROVIDER,
    model: IMAGE_STUDIO_FALLBACK_MODEL,
    parsed,
    channelStyleExamples: input.channelStyleExamples,
  });
  return { directions, usage };
}

export async function planImageDirections(
  input: PlanImageDirectionsInput
): Promise<ImagePlanningResult> {
  let openAIError: unknown = null;
  try {
    return await planWithOpenAI(input);
  } catch (error) {
    openAIError = error;
  }
  try {
    return await planWithAnthropic(input);
  } catch (anthropicError) {
    const openAIMessage =
      openAIError instanceof Error ? openAIError.message : "OpenAI planner unavailable";
    const anthropicMessage =
      anthropicError instanceof Error ? anthropicError.message : "Claude fallback unavailable";
    throw new Error(
      `OpenAI GPT-5.5 planner failed and Claude Sonnet fallback failed. OpenAI: ${openAIMessage}. Claude: ${anthropicMessage}`
    );
  }
}
