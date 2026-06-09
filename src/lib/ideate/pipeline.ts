import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { db, getIntegration, getSetting } from "../db";
import {
  collectRedditResearch,
  hasRedditSignalProvider,
  parseSubredditSources,
  type RedditResearchItem,
} from "../reddit";
import { listUploadIds, fetchVideos, YouTubeApiError } from "../youtube";
import { log } from "../logger";
import { costMillicents } from "../claude-pricing";

/* ------------------------------------------------------------ */
/* Model + ceiling constants                                     */
/* ------------------------------------------------------------ */

export const IDEATION_MODEL_COMPOSE = "claude-sonnet-4-6";
export const IDEATION_MODEL_VALIDATE = "claude-sonnet-4-6";
export const IDEATION_MODEL_DISTILL = "claude-sonnet-4-6";

export const IDEATION_THINKING_BUDGET = 24000;
export const IDEATION_COMPOSE_MAX_TOKENS = 18000;
export const IDEATION_VALIDATE_MAX_TOKENS = 4000;
export const IDEATION_DISTILL_MAX_TOKENS = 2000;

// Wall-time ceiling for a single generation. Personal tool, quality > latency —
// the UI shows a progress bar so a multi-minute run is acceptable. Smoke
// baseline at 24K thinking budget + 3 competitors was 4m20s.
export const IDEATION_WALLTIME_CEILING_MS = 360_000;

// Anthropic SDK gate: max_tokens > ~21333 trips the "Streaming is required
// for operations that may take longer than 10 minutes" pre-flight check.
// (Derived from sdk/client.mjs: expectedTime = 60*60*1000 * maxTokens / 128000;
//  errors when expectedTime > 10*60*1000 ⇒ maxTokens > 21333.) Any call above
// this MUST use messages.stream — getMessageOrStream() below enforces that.
// DO NOT remove the guard: removing it brings back the smoke-test failure
// observed on 2026-05-20.
export const ANTHROPIC_STREAM_THRESHOLD = 21333;

export const MAX_YT_CALLS_PER_GATHER = 30;
export const MAX_COMPOSE_RETRIES = 3;
export const MAX_VALIDATE_RETRIES = 2;
export const MAX_DISTILL_RETRIES = 1;
export const MAX_QUEUED_GENERATIONS = 2;

export const OUTLIER_AGE_DAYS = 90;
export const TOPIC_RECENCY_DAYS = 30;
export const OUTLIER_MULTIPLIER = 2.0;
export const RECENT_UPLOAD_VIDEOS_PER_COMPETITOR = 50;
export const USED_TITLE_COOLDOWN_DAYS = 14;
// The UI now shows validation quality inline instead of hiding weak ideas,
// so the model should produce exactly the requested count. Keeping this at
// 1.0 also keeps Sonnet output cost predictable for 10-title runs.
export const COMPOSE_OVERSHOOT_FACTOR = 1.0;
export const MAX_COMPOSE_TARGET_IDEAS_PER_CALL = 5;
export const FIT_SCORE_PASS_THRESHOLD = 7;
export const MAX_IDEAS_PER_TOPIC_PER_RUN = 3;
export const TITLE_IDEAL_MIN_CHARS = 50;
export const TITLE_IDEAL_MAX_CHARS = 70;
export const TITLE_MAX_CHARS = 80;
export const TITLE_MAX_WORDS = 12;
export const IDEATION_TITLE_RULES_SETTING = "ideate.title_rules";
export const IDEATION_TITLE_RULES_CAP = 4000;

export const FORBIDDEN_WORDS = [
  "cinematic",
  "sensory",
  "visceral",
  "profound",
  "inexorable",
  "vastest",
  "physically impossible",
];

export const DEFAULT_IDEATION_TITLE_RULES = [
  "Write for a smart 14-year-old space enthusiast.",
  "Make the title easy to read in one breath.",
  "Prefer concrete nouns and simple verbs.",
  "Use one clear idea per title.",
  "Avoid stacked abstract phrases unless the meaning is immediately clear.",
  "Stay as easy to understand as the viral source title; never make the wording harder.",
  "Borrow the simplicity of viral space outliers: short subject, clear danger/mystery, no tangled clauses.",
  "Title length is a hard rule: 50-70 characters is ideal because it displays fully in search and on mobile.",
  "70-80 characters is acceptable only if the emotional hook lands before the cutoff.",
  "Avoid 80+ character titles because the punchline risks being cut off in search results.",
  "Over 80 characters or over 12 words is not acceptable.",
  "No clickbait that does not deliver; curiosity gaps must resolve in the video.",
] as const;

const HARD_TITLE_LENGTH_RULES = [
  "Title length is a hard rule: 50-70 characters is ideal because it displays fully in search and on mobile.",
  "70-80 characters is acceptable only if the emotional hook lands before the cutoff.",
  "Avoid 80+ character titles because the punchline risks being cut off in search results.",
  "Over 80 characters or over 12 words is not acceptable.",
] as const;

function normalizeIdeationTitleRuleLine(line: string): string[] {
  if (
    /\b45\s*-\s*68\b|\b30\s*-\s*80\b|\bmax\s*80\b|natural title length and rhythm/i.test(
      line
    )
  ) {
    return [...HARD_TITLE_LENGTH_RULES];
  }
  return [line];
}

export function normalizeIdeationTitleRulesText(value: string): string {
  const seen = new Set<string>();
  return [
    ...value
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[-*]\s+/, "").trim())
      .flatMap((line) => normalizeIdeationTitleRuleLine(line)),
    ...HARD_TITLE_LENGTH_RULES,
  ]
    .filter((line) => line.length > 0)
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n");
}

export function defaultIdeationTitleRulesText(): string {
  return DEFAULT_IDEATION_TITLE_RULES.join("\n");
}

export function getIdeationTitleRulesText(): string {
  const saved = getSetting(IDEATION_TITLE_RULES_SETTING);
  return normalizeIdeationTitleRulesText(saved?.trim() ? saved : defaultIdeationTitleRulesText());
}

export function getIdeationTitleRules(): string[] {
  return getIdeationTitleRulesText().split("\n").filter((line) => line.trim().length > 0);
}

export const IDEATION_TITLE_RULES = DEFAULT_IDEATION_TITLE_RULES;

const FORMULA_FAMILIES = [
  ["Specific Numbers", "I Spent 7 Days Tracking the Voyager Probe"],
  ["Curiosity Gap", "What's Inside the World's Deepest Hole?"],
  ["Authority-Led", "NASA Just Confirmed Something Strange About Mars"],
  ["Value-in-Time", "Watch This Before You Buy a New Telescope"],
  ["Emotional Trigger", "The Astronaut Who Cried in Space"],
  ["Pain-Point", "Why Your Solar Panel Setup Is Failing (And How To Fix It)"],
  ["Personal-Mentorship", "How I Read Scientific Papers Without a Degree"],
] as const;

/* ------------------------------------------------------------ */
/* Types                                                          */
/* ------------------------------------------------------------ */

export type Mode = "auto" | "new_angles" | "title_tweaks" | "reddit_angles";

export interface ChannelContext {
  id: string;
  title: string;
  handle: string | null;
  niche: string | null;
  audience: string | null;
  voice: string | null;
  external_sources: string | null;
  banned_topics: string | null;
  reddit_sources: string | null;
  channel_description: string | null;
  ideation_rules_text: string | null;
  topic_analysis_json: string | null;
}

export interface LearnedRule {
  id: number;
  rule_type: string;
  rule_value: string;
}

export interface OwnUpload {
  video_id: string;
  title: string;
  views: number;
  published_at: number | null;
  thumbnail_url: string | null;
}

export interface UsedTitleCooldown {
  id: string;
  title: string;
  used_at: string | null;
}

export interface VideoEntry {
  video_id: string;
  title: string;
  views: number;
  multiplier: number;
  age_days: number;
  is_outlier: boolean;
  published_at: number | null;
  thumbnail_url: string | null;
}

export interface CompetitorPayload {
  competitor_id: number;
  channel_id: string;
  channel_name: string;
  handle: string | null;
  note: string | null;
  subscriber_count: number | null;
  median_views: number;
  videos: VideoEntry[];
}

export interface GatherResult {
  channel_context: ChannelContext;
  learned_rules: LearnedRule[];
  own_recent_uploads: OwnUpload[];
  own_median_views: number;
  competitors: CompetitorPayload[];
  used_title_cooldowns: UsedTitleCooldown[];
  yt_calls_made: number;
  dropped_competitors: { channel_id: string; reason: string }[];
}

export interface SourceVideo {
  video_id: string;
  title: string;
  channel_name: string;
  channel_handle: string | null;
  multiplier: number | null;
  thumbnail_url?: string | null;
  views?: number | null;
  published_at?: number | null;
  age_days?: number | null;
}

/**
 * Which compose path produced the idea — surfaced as a badge next to FIT.
 *  - new_angle  : two-outlier mashup (topic from outlier A, format from outlier B)
 *  - title_tweak: same topic as an existing high-performer, fresh title/hook
 *  - reddit_angle: topic demand from Reddit web signals + YouTube format proof
 *
 * Old rows (pre-2026-05) have no method on disk; the UI renders "—" in
 * that case. parseComposeJson hard-fails an idea whose method is set
 * but invalid; missing-method is allowed for read-side back-compat.
 */
export type IdeaMethod = "new_angle" | "title_tweak" | "reddit_angle" | "fresh";
const VALID_METHODS: ReadonlySet<string> = new Set([
  "new_angle",
  "title_tweak",
  "reddit_angle",
  "fresh",
]);

export interface SourceAttribution {
  family: string;
  topic_source: SourceVideo | null;
  format_source: SourceVideo | null;
  topic_evidence_sources: SourceVideo[];
  reasoning: string;
  method?: IdeaMethod;
}

export interface IdeaSourceLink {
  type: "youtube" | "reddit";
  label: string;
  url: string;
  date?: string | null;
}

export interface IdeaProof {
  source_signal: string;
  fit: string;
  execution: string;
  whats_going_on?: string | null;
  weak_proof?: string | null;
  sources: IdeaSourceLink[];
}

export interface ComposedIdea {
  title: string;
  description: string;
  source_attribution: SourceAttribution;
  proof: IdeaProof;
  confidence_level: "high" | "medium" | "low";
  research_sources: IdeaSourceLink[];
}

export interface ValidatedIdea {
  id: string;
  title: string;
  description: string;
  source_attribution: SourceAttribution;
  proof: IdeaProof;
  confidence_level: "high" | "medium" | "low";
  research_sources: IdeaSourceLink[];
  validation_status: "passed" | "rejected";
  validation_reason: string | null;
  fit_score: number | null;
  fit_reason: string | null;
}

export interface IdeaAllocation {
  method: Exclude<IdeaMethod, "fresh">;
  count: number;
}

type ComposeStructuredOutput = {
  ideas: Array<{
    title: string;
    description: string;
    confidence_level: "high" | "medium" | "low";
    source_attribution: {
      family: string;
      topic_source: SourceVideo | null;
      format_source: SourceVideo | null;
      topic_evidence_sources: SourceVideo[];
      reasoning: string;
      method: IdeaMethod;
    };
    proof: IdeaProof;
    research_sources?: IdeaSourceLink[];
  }>;
};

type ValidateStructuredOutput = {
  ideas: Array<{
    idx: number;
    fit_score: number;
    dup_of: number;
    fit_reason: string;
    weak_proof: string;
  }>;
};

const SOURCE_VIDEO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["video_id", "title", "channel_name", "channel_handle", "multiplier"],
  properties: {
    video_id: { type: "string" },
    title: { type: "string" },
    channel_name: { type: "string" },
    channel_handle: { type: "string" },
    multiplier: { type: "number" },
    thumbnail_url: { type: "string" },
    views: { type: "number" },
    published_at: { type: "number" },
    age_days: { type: "number" },
  },
} as const;

const SOURCE_LINK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "label", "url", "date"],
  properties: {
    type: { type: "string", enum: ["youtube", "reddit"] },
    label: { type: "string" },
    url: { type: "string" },
    date: { type: "string" },
  },
} as const;

const COMPOSE_OUTPUT_FORMAT = jsonSchemaOutputFormat({
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "description",
          "confidence_level",
          "source_attribution",
          "proof",
          "research_sources",
        ],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          confidence_level: { type: "string", enum: ["high", "medium", "low"] },
          source_attribution: {
            type: "object",
            additionalProperties: false,
            required: [
              "family",
              "topic_source",
              "format_source",
              "topic_evidence_sources",
              "reasoning",
              "method",
            ],
            properties: {
              family: { type: "string" },
              topic_source: SOURCE_VIDEO_SCHEMA,
              format_source: SOURCE_VIDEO_SCHEMA,
              topic_evidence_sources: {
                type: "array",
                items: SOURCE_VIDEO_SCHEMA,
              },
              reasoning: { type: "string" },
              method: {
                type: "string",
                enum: ["new_angle", "title_tweak", "reddit_angle"],
              },
            },
          },
          proof: {
            type: "object",
            additionalProperties: false,
            required: [
              "source_signal",
              "fit",
              "execution",
              "whats_going_on",
              "weak_proof",
              "sources",
            ],
            properties: {
              source_signal: { type: "string" },
              fit: { type: "string" },
              execution: { type: "string" },
              whats_going_on: { type: "string" },
              weak_proof: { type: "string" },
              sources: { type: "array", items: SOURCE_LINK_SCHEMA },
            },
          },
          research_sources: {
            type: "array",
            items: SOURCE_LINK_SCHEMA,
          },
        },
      },
    },
  },
} as const);

const VALIDATE_OUTPUT_FORMAT = jsonSchemaOutputFormat({
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["idx", "fit_score", "dup_of", "fit_reason", "weak_proof"],
        properties: {
          idx: { type: "number" },
          fit_score: { type: "number" },
          dup_of: { type: "number" },
          fit_reason: { type: "string" },
          weak_proof: { type: "string" },
        },
      },
    },
  },
} as const);

/* ------------------------------------------------------------ */
/* Anthropic call dispatcher — stream when max_tokens forces it  */
/* ------------------------------------------------------------ */

type StreamParams = Parameters<Anthropic["messages"]["stream"]>[0];

async function callAnthropic(
  client: Anthropic,
  params: StreamParams
): Promise<Anthropic.Message> {
  // SDK gates non-streaming requests when max_tokens > ANTHROPIC_STREAM_THRESHOLD
  // (~21333). Keep compose below this when possible so structured outputs
  // can use messages.parse instead of a fragile very-long stream. validate
  // and distill are well below and use the plain path.
  // See note next to ANTHROPIC_STREAM_THRESHOLD for the math.
  if (typeof params.max_tokens === "number" && params.max_tokens > ANTHROPIC_STREAM_THRESHOLD) {
    return await client.messages.stream(params).finalMessage();
  }
  if (params.output_config?.format) {
    return (await client.messages.parse(
      params as Parameters<Anthropic["messages"]["parse"]>[0]
    )) as Anthropic.Message;
  }
  return (await client.messages.create(
    params as Parameters<Anthropic["messages"]["create"]>[0]
  )) as Anthropic.Message;
}

/* ------------------------------------------------------------ */
/* MENTOR_METHOD.md loader (cached)                              */
/* ------------------------------------------------------------ */

let cachedMentorMethod: string | null = null;
function readMentorMethod(): string {
  if (cachedMentorMethod !== null) return cachedMentorMethod;
  try {
    const path = resolvePath(process.cwd(), "MENTOR_METHOD.md");
    cachedMentorMethod = readFileSync(path, "utf-8");
  } catch (err) {
    log.warn("ideate", "could not read MENTOR_METHOD.md", { error: String(err) });
    cachedMentorMethod = "";
  }
  return cachedMentorMethod;
}

/* ------------------------------------------------------------ */
/* Batched channels.list helper (not in shared youtube.ts —      */
/* this is the only call site that needs the batched form).     */
/* ------------------------------------------------------------ */

interface YtChannelsListItem {
  id: string;
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
  statistics?: { viewCount?: string; subscriberCount?: string };
}

async function ytChannelsBatch(
  channelIds: string[],
  apiKey: string
): Promise<YtChannelsListItem[]> {
  if (channelIds.length === 0) return [];
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails,statistics");
  url.searchParams.set("id", channelIds.join(","));
  url.searchParams.set("key", apiKey);
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? "";
    } catch {
      /* ignore */
    }
    throw new YouTubeApiError(
      `YouTube channels.list ${res.status}: ${detail || res.statusText}`,
      res.status
    );
  }
  const json = (await res.json()) as { items?: YtChannelsListItem[] };
  return json.items ?? [];
}

/* ------------------------------------------------------------ */
/* Budget + concurrency precheck (callable from POST route)     */
/* ------------------------------------------------------------ */

export function estimateCostMillicents(count: number): number {
  const clamped = Math.max(10, Math.min(25, count));
  return 50_000 + (clamped - 10) * 700;
}

export function allocateIdeaBuckets(
  mode: Mode,
  count: number,
  options: { redditAvailable?: boolean } = {}
): IdeaAllocation[] {
  const clamped = Math.max(1, Math.floor(count));
  if (mode === "new_angles") return [{ method: "new_angle", count: clamped }];
  if (mode === "title_tweaks") return [{ method: "title_tweak", count: clamped }];
  if (mode === "reddit_angles") return [{ method: "reddit_angle", count: clamped }];

  const methods: IdeaAllocation["method"][] =
    options.redditAvailable === false
      ? ["new_angle", "title_tweak"]
      : ["new_angle", "title_tweak", "reddit_angle"];
  const base = Math.floor(clamped / methods.length);
  let remainder = clamped % methods.length;
  return methods.map((method) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { method, count: base + extra };
  });
}

function overshootAllocations(allocations: IdeaAllocation[]): IdeaAllocation[] {
  return allocations.map((a) => ({
    method: a.method,
    count: Math.max(a.count, Math.ceil(a.count * COMPOSE_OVERSHOOT_FACTOR)),
  }));
}

function modeForMethod(method: IdeaAllocation["method"]): Mode {
  if (method === "new_angle") return "new_angles";
  if (method === "title_tweak") return "title_tweaks";
  return "reddit_angles";
}

function splitComposeAllocations(allocations: IdeaAllocation[]): IdeaAllocation[] {
  const chunks: IdeaAllocation[] = [];
  for (const allocation of allocations) {
    let remaining = allocation.count;
    while (remaining > 0) {
      const count = Math.min(MAX_COMPOSE_TARGET_IDEAS_PER_CALL, remaining);
      chunks.push({ method: allocation.method, count });
      remaining -= count;
    }
  }
  return chunks;
}

export function countProcessingGenerations(): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM generations WHERE status = 'processing'`)
    .get() as { n: number };
  return row.n;
}

export function hasProcessingForChannel(userChannelId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM generations
       WHERE user_channel_id = ? AND status = 'processing'
       LIMIT 1`
    )
    .get(userChannelId) as { x: number } | undefined;
  return !!row;
}

/* ------------------------------------------------------------ */
/* Persistence helpers                                            */
/* ------------------------------------------------------------ */

export interface CreateGenerationInput {
  userChannelId: string;
  mode: Mode;
  count: number;
}

export function createGeneration(input: CreateGenerationInput): string {
  const id = randomUUID();
  const cost = estimateCostMillicents(input.count);
  db.prepare(
    `INSERT INTO generations (id, user_channel_id, mode, count, status, estimated_cost_millicents)
     VALUES (?, ?, ?, ?, 'processing', ?)`
  ).run(id, input.userChannelId, input.mode, input.count, cost);
  return id;
}

function markGenerationFailed(generationId: string, errorMsg: string): void {
  db.prepare(
    `UPDATE generations SET status='failed', error=?, completed_at=datetime('now')
     WHERE id = ? AND status = 'processing'`
  ).run(errorMsg.slice(0, 4000), generationId);
}

function markGenerationCompleted(generationId: string): void {
  db.prepare(
    `UPDATE generations SET status='completed', completed_at=datetime('now')
     WHERE id = ? AND status = 'processing'`
  ).run(generationId);
}

function recordAttrition(generationId: string, dropped: { channel_id: string; reason: string }[]): void {
  if (dropped.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO gather_attrition_log (generation_id, dropped_competitor_id, reason)
     VALUES (?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const d of dropped) stmt.run(generationId, d.channel_id, d.reason);
  });
  tx();
}

/* ------------------------------------------------------------ */
/* gather()                                                       */
/* ------------------------------------------------------------ */

export interface GatherOptions {
  competitorLimit?: number;
}

export async function gather(
  userChannelId: string,
  _mode: Mode,
  generationId: string | null = null,
  options: GatherOptions = {}
): Promise<GatherResult> {
  const channelRow = db
    .prepare(
      `SELECT id, title, handle, niche, audience, voice, external_sources, banned_topics,
              reddit_sources, channel_description, ideation_rules, topic_analysis_json
       FROM channels WHERE id = ?`
    )
    .get(userChannelId) as
    | {
        id: string;
        title: string | null;
        handle: string | null;
        niche: string | null;
        audience: string | null;
        voice: string | null;
        external_sources: string | null;
        banned_topics: string | null;
        reddit_sources: string | null;
        channel_description: string | null;
        ideation_rules: string | null;
        topic_analysis_json: string | null;
      }
    | undefined;
  if (!channelRow) throw new Error(`channel not found: ${userChannelId}`);

  const channel_context: ChannelContext = {
    id: channelRow.id,
    title: channelRow.title ?? "",
    handle: channelRow.handle,
    niche: channelRow.niche,
    audience: channelRow.audience,
    voice: channelRow.voice,
    external_sources: channelRow.external_sources,
    banned_topics: channelRow.banned_topics,
    reddit_sources: channelRow.reddit_sources,
    channel_description: channelRow.channel_description,
    ideation_rules_text: channelRow.ideation_rules,
    topic_analysis_json: channelRow.topic_analysis_json,
  };

  const learned_rules = db
    .prepare(
      `SELECT id, rule_type, rule_value FROM ideation_rules
       WHERE user_channel_id = ? AND pending = 0
       ORDER BY created_at DESC LIMIT 50`
    )
    .all(userChannelId) as LearnedRule[];

  const own_recent_uploads = db
    .prepare(
      `SELECT id AS video_id, title, views, published_at, thumbnail_url
       FROM videos WHERE channel_id = ?
       ORDER BY published_at DESC LIMIT 20`
    )
    .all(userChannelId) as OwnUpload[];

  const ownSortedViews = own_recent_uploads
    .map((v) => v.views ?? 0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const own_median_views =
    ownSortedViews.length > 0
      ? ownSortedViews[Math.floor(ownSortedViews.length / 2)]
      : 0;

  const used_title_cooldowns = db
    .prepare(
      `SELECT i.id, i.title, i.used_at
       FROM ideas i
       JOIN generations g ON g.id = i.generation_id
       WHERE g.user_channel_id = ?
         AND i.used_by_user = 1
         AND i.title IS NOT NULL
         AND datetime(COALESCE(i.used_at, i.created_at)) >= datetime('now', ?)
       ORDER BY COALESCE(i.used_at, i.created_at) DESC
       LIMIT 100`
    )
    .all(userChannelId, `-${USED_TITLE_COOLDOWN_DAYS} days`) as UsedTitleCooldown[];

  const competitorLimit = options.competitorLimit ?? -1;
  const competitorsQuery =
    competitorLimit > 0
      ? `SELECT id, channel_id, title, handle, note, subscriber_count
         FROM competitors
         WHERE user_channel_id = ? AND channel_id IS NOT NULL
         ORDER BY added_at DESC
         LIMIT ${Math.floor(competitorLimit)}`
      : `SELECT id, channel_id, title, handle, note, subscriber_count
         FROM competitors
         WHERE user_channel_id = ? AND channel_id IS NOT NULL
         ORDER BY added_at DESC`;
  const competitors = db.prepare(competitorsQuery).all(userChannelId) as Array<{
    id: number;
    channel_id: string;
    title: string | null;
    handle: string | null;
    note: string | null;
    subscriber_count: number | null;
  }>;

  if (competitors.length === 0) {
    throw new Error("no competitors");
  }

  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    throw new Error("YouTube API key missing — set it in /settings/integrations");
  }

  // Budget plan: 1 batched channels.list + N playlistItems.list + ceil(totalVids/50) batched videos.list
  // For 50 videos × N competitors, that's 1 + N + N = 2N + 1.
  // 2N + 1 ≤ MAX_YT_CALLS_PER_GATHER (30) → N ≤ 14.
  const maxCompetitorsForBudget = Math.floor((MAX_YT_CALLS_PER_GATHER - 1) / 2);
  let active = competitors;
  const dropped: { channel_id: string; reason: string }[] = [];
  if (active.length > maxCompetitorsForBudget) {
    const drop = active.slice(maxCompetitorsForBudget);
    for (const c of drop) {
      dropped.push({
        channel_id: c.channel_id,
        reason: `YT API budget — would exceed ${MAX_YT_CALLS_PER_GATHER} calls`,
      });
    }
    active = active.slice(0, maxCompetitorsForBudget);
  }

  let yt_calls_made = 0;

  // 1. Batched channels.list for uploads playlists
  let channelsItems: YtChannelsListItem[];
  try {
    channelsItems = await ytChannelsBatch(
      active.map((c) => c.channel_id),
      apiKey
    );
    yt_calls_made++;
  } catch (err) {
    throw new Error(
      `gather: channels.list failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const uploadsByChannel = new Map<string, string>();
  for (const item of channelsItems) {
    const uploads = item.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) uploadsByChannel.set(item.id, uploads);
  }

  // 2. playlistItems.list per competitor (uploads → recent video IDs)
  const videoIdsByCompetitor = new Map<string, string[]>();
  for (const comp of active) {
    if (yt_calls_made >= MAX_YT_CALLS_PER_GATHER) {
      dropped.push({
        channel_id: comp.channel_id,
        reason: "YT API budget exhausted mid-gather",
      });
      continue;
    }
    const playlistId = uploadsByChannel.get(comp.channel_id);
    if (!playlistId) {
      dropped.push({ channel_id: comp.channel_id, reason: "no uploads playlist" });
      continue;
    }
    try {
      const ids = await listUploadIds(playlistId, apiKey, {
        max: RECENT_UPLOAD_VIDEOS_PER_COMPETITOR,
      });
      yt_calls_made++;
      videoIdsByCompetitor.set(comp.channel_id, ids);
    } catch (err) {
      dropped.push({
        channel_id: comp.channel_id,
        reason: `playlistItems error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 3. Batched videos.list across all collected IDs
  const allVideoIds: string[] = [];
  for (const ids of videoIdsByCompetitor.values()) allVideoIds.push(...ids);

  const videoMeta = new Map<
    string,
    {
      title: string;
      views: number;
      publishedAt: number;
      thumbnailUrl: string | null;
    }
  >();
  for (let i = 0; i < allVideoIds.length; i += 50) {
    if (yt_calls_made >= MAX_YT_CALLS_PER_GATHER) {
      log.warn("ideate", "hit YT API ceiling during videos.list batch", {
        yt_calls_made,
        unprocessed: allVideoIds.length - i,
      });
      break;
    }
    const chunk = allVideoIds.slice(i, i + 50);
    try {
      const vids = await fetchVideos(chunk, apiKey);
      yt_calls_made++;
      for (const v of vids) {
        videoMeta.set(v.id, {
          title: v.title,
          views: v.views,
          publishedAt: v.publishedAt,
          thumbnailUrl: v.thumbnail,
        });
      }
    } catch (err) {
      log.warn("ideate", "videos.list batch failed", {
        offset: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);

  const competitorPayloads: CompetitorPayload[] = [];
  for (const comp of active) {
    const ids = videoIdsByCompetitor.get(comp.channel_id) ?? [];
    if (ids.length === 0) continue;

    const allEntries = ids
      .map((id) => {
        const meta = videoMeta.get(id);
        if (!meta) return null;
        const ageSec = meta.publishedAt > 0 ? nowSec - meta.publishedAt : Number.POSITIVE_INFINITY;
        const age_days = Math.floor(ageSec / 86400);
        return {
          id,
          title: meta.title,
          views: meta.views,
          age_days,
          published_at: meta.publishedAt,
          thumbnail_url: meta.thumbnailUrl,
        };
      })
      .filter(
        (
          x
        ): x is {
          id: string;
          title: string;
          views: number;
          age_days: number;
          published_at: number;
          thumbnail_url: string | null;
        } => x !== null
      );

    const allViews = allEntries
      .map((e) => e.views)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const median = allViews.length > 0 ? allViews[Math.floor(allViews.length / 2)] : 0;

    const videos: VideoEntry[] = allEntries
      .map((e) => ({
        video_id: e.id,
        title: e.title,
        views: e.views,
        multiplier: median > 0 ? Number((e.views / median).toFixed(2)) : 0,
        age_days: e.age_days,
        is_outlier: median > 0 && e.views >= OUTLIER_MULTIPLIER * median,
        published_at: e.published_at,
        thumbnail_url: e.thumbnail_url,
      }))
      .sort((a, b) => b.multiplier - a.multiplier);

    competitorPayloads.push({
      competitor_id: comp.id,
      channel_id: comp.channel_id,
      channel_name: comp.title ?? "",
      handle: comp.handle,
      note: comp.note,
      subscriber_count: comp.subscriber_count,
      median_views: median,
      videos,
    });
  }

  if (generationId) recordAttrition(generationId, dropped);

  return {
    channel_context,
    learned_rules,
    own_recent_uploads,
    own_median_views,
    competitors: competitorPayloads,
    used_title_cooldowns,
    yt_calls_made,
    dropped_competitors: dropped,
  };
}

/* ------------------------------------------------------------ */
/* compose()                                                      */
/* ------------------------------------------------------------ */

function buildComposeSystemPrompt(): string {
  const mentor = readMentorMethod();
  const titleRules = getIdeationTitleRules();
  const families = FORMULA_FAMILIES.map(
    ([name, example]) => `  - ${name}: e.g. "${example}"`
  ).join("\n");

  return [
    "You are HAmo's YouTube ideation mentor. You generate concrete video ideas",
    "for a specific channel by combining channel context, viral competitor",
    "outliers, and learned-rule constraints — strictly following the method below.",
    "",
    "## METHOD (verbatim, from MENTOR_METHOD.md)",
    mentor || "(method file unavailable — fall back to: outlier-driven, plain-language, one-breath titles grounded in real events)",
    "",
    "## PROVEN FORMULA FAMILIES",
    "Every title you propose MUST map to exactly one of these 7 families. State",
    "the family in source_attribution.family.",
    families,
    "",
    "## TITLE RULES (HARD)",
    ...titleRules.map((rule) => `- ${rule}`),
    "- Plain language. Banned forbidden adjectives (will be auto-rejected):",
    `  ${FORBIDDEN_WORDS.map((w) => `"${w}"`).join(", ")}`,
    "",
    "## DESCRIPTION RULES (HARD)",
    "- 2 short sentences: where the idea came from + why it works for THIS channel.",
    "- Reference source videos by SHORT PARAPHRASE only — NEVER by video ID.",
    "- Example CORRECT: \"Fresh topic from SPACE BEFOREAFTER's life-chemistry outlier, cross-validated by Late Science's own life-signal performer.\"",
    "- Example WRONG: \"cross-validated by the channel's own 2.22× life-signal performer (MjTKtXGMIMA).\"",
    "- All structured source IDs belong in source_attribution, NEVER in the description prose.",
    "",
    "## ATTRIBUTION RULES (HARD)",
    "- topic_source: the competitor outlier (or own upload, for Title Tweaks) whose TOPIC you reused.",
    "- format_source: the DIFFERENT video whose title STRUCTURE you reused. Use an empty source object for Title Tweaks (no second source).",
    "- topic_evidence_sources: additional YouTube outliers on the SAME topic, excluding topic_source. Use [] when there is no second same-topic signal.",
    "- Both source objects carry { video_id, title, channel_name, channel_handle, multiplier }, plus optional thumbnail_url, views, published_at, and age_days when known.",
    "- Empty source object means { video_id: \"\", title: \"\", channel_name: \"\", channel_handle: \"\", multiplier: 0 }.",
    "- video_id MUST be picked from the competitor source bank or own uploads block in the user prompt — do not invent IDs.",
    "",
    "## METHOD TAG (HARD)",
    "Every idea MUST include source_attribution.method, set to ONE of:",
    "  - \"new_angle\"   : a two-outlier mashup. Topic from one competitor outlier,",
    "                    title format from a DIFFERENT competitor outlier. Both",
    "                    source video_ids MUST come from the competitor source bank",
    "                    and BOTH sources MUST be marked as outliers with multiplier ≥ 2.0.",
    "                    topic_source and format_source must reference DIFFERENT video_ids.",
    `                    Primary topic_source MUST be uploaded within ${TOPIC_RECENCY_DAYS} days.`,
    "                    Older same-topic videos are historical proof only; put them in topic_evidence_sources, never as primary topic_source.",
    "                    Prefer topics that recently went viral more than once.",
    "                    Format source may be older because title structures are evergreen.",
    "                    Stay close to the readable structure of the format source, but simplify the words.",
    "                    If you cannot satisfy ALL of these constraints for a candidate,",
    "                    do NOT propose it.",
    "  - \"title_tweak\" : same topic as an existing high-performer (competitor or own",
    "                    upload), with only small wording/synonym/clarity changes.",
    "                    Do not swap the main subject, add a new premise, or change the topic.",
    "  - \"reddit_angle\": demand signal from Reddit web signals, paired with a",
    "                    YouTube outlier or own winner as the format_source. topic_source",
    "                    may be the empty source object because Reddit supplies the topic; proof.sources",
    "                    MUST include at least one Reddit link and one YouTube link.",
    "",
    "## PROOF RULES (HARD)",
    "- Every idea includes proof: { source_signal, fit, execution, whats_going_on, weak_proof, sources }.",
    "- source_signal: compact evidence, including outlier multipliers or Reddit web-search snippets.",
    "- fit: why this channel's audience and voice can own the topic.",
    "- execution: the actual video treatment, not vague strategy.",
    "- whats_going_on: empty string unless Reddit is involved. For Reddit ideas, 3-4 short sentences max with concrete dates from the Reddit web signals.",
    "- weak_proof: empty string for strong evidence; otherwise name the weak link while keeping the idea usable.",
    "- sources: source links used by the proof. Use YouTube watch links and Reddit permalinks.",
    "- Use an empty string for unknown source-link dates.",
    "- Keep source_signal, fit, and execution to one sentence each. Keep each idea compact.",
    `- Confidence rule: high only when fit is very strong and the topic has 2+ same-topic outliers within ${TOPIC_RECENCY_DAYS} days.`,
    "- Use medium for one recent topic source or repeated older evidence with weaker fit. Use low for old-only, single weak, or uncertain topic proof.",
    "",
    "## OUTPUT",
    'Return ONLY a single JSON object: { "ideas": [...] }. No prose, no markdown.',
    "Each idea has this exact shape (1-shot example):",
    "```json",
    "{",
    '  "title": "Why the Voyager Signal Just Skipped a Frame Last Tuesday",',
    '  "description": "Topic from Milky Stellar\'s Voyager signal outlier, paired with Late Science\'s own quietly-panicking title format. Both topic and structure are already proven on the channel\'s audience.",',
    '  "source_attribution": {',
    '    "family": "Curiosity Gap",',
    '    "topic_source": {',
    '      "video_id": "Wtb1uMbllgg",',
    '      "title": "What\'s Inside the Voyager Probe\'s Final Signal?",',
    '      "channel_name": "Milky Stellar",',
    '      "channel_handle": "@MilkyStellarSpace",',
    '      "multiplier": 5.0',
    '    },',
    '    "format_source": {',
    '      "video_id": "j_F0S4nPoxk",',
    '      "title": "Scientists Are Quietly Panicking About Betelgeuse Right Now",',
    '      "channel_name": "Late Science",',
    '      "channel_handle": "@late_science",',
    '      "multiplier": 8.8',
    '    },',
    '    "topic_evidence_sources": [],',
    '    "reasoning": "Topic from Milky Stellar 5.0× × Late Science\'s own 8.8× format structure.",',
    '    "method": "new_angle"',
    "  },",
    '  "confidence_level": "high",',
    '  "proof": {',
    '    "source_signal": "Milky Stellar hit 5.0× on Voyager-signal curiosity; Late Science hit 8.8× with quiet-panic framing.",',
    '    "fit": "The channel already converts space-anomaly stories when the audience gets a clear technical hook.",',
    '    "execution": "Open with the timestamped signal anomaly, explain the possible causes, then rank what scientists can actually verify.",',
    '    "whats_going_on": "",',
    '    "weak_proof": "",',
    '    "sources": [',
    '      { "type": "youtube", "label": "Voyager topic outlier", "url": "https://www.youtube.com/watch?v=Wtb1uMbllgg", "date": "" },',
    '      { "type": "youtube", "label": "Quiet-panic format outlier", "url": "https://www.youtube.com/watch?v=j_F0S4nPoxk", "date": "" }',
    "    ]",
    "  },",
    '  "research_sources": []',
    "}",
    "```",
    "Set format_source to the empty source object for Title Tweaks where you only borrow a topic.",
  ].join("\n");
}

function allocationLabel(method: IdeaAllocation["method"]): string {
  if (method === "new_angle") return "New Angles";
  if (method === "title_tweak") return "Title Tweaks";
  return "Reddit Angles";
}

function buildResearchContext(redditResearch: RedditResearchItem[]): string[] {
  if (redditResearch.length === 0) return ["(none)"];
  return redditResearch.map((item) => {
    const date = item.created_utc
      ? new Date(item.created_utc * 1000).toISOString().slice(0, 10)
      : "unknown date";
    const reuse = item.reused ? "reused library signal" : "new signal";
    const metric =
      item.score > 0 || item.comments > 0
        ? `${item.score} upvotes | ${item.comments} comments`
        : "Brave web signal";
    return [
      `- topic=${item.topic} | r/${item.subreddit} | ${date} | ${metric} | ${reuse}`,
      `  title: ${item.title}`,
      `  summary: ${item.summary}`,
      `  permalink: ${item.permalink}`,
    ].join("\n");
  });
}

function buildComposeUserPrompt(
  gathered: GatherResult,
  mode: Mode,
  count: number,
  redditResearch: RedditResearchItem[],
  redditAvailable = true
): string {
  const ctx = gathered.channel_context;
  const targetAllocations = allocateIdeaBuckets(mode, count, { redditAvailable });
  const composeAllocations = overshootAllocations(targetAllocations);
  const composeCount = composeAllocations.reduce((sum, a) => sum + a.count, 0);

  const lines: string[] = [];
  lines.push(`# Target - generate exactly ${composeCount} ideas`);
  lines.push(`Mode: ${mode}`);
  lines.push("Exact candidate mix:");
  for (const a of composeAllocations) {
    lines.push(`- ${allocationLabel(a.method)} (${a.method}): ${a.count}`);
  }
  lines.push("Final selected mix target:");
  for (const a of targetAllocations) {
    lines.push(`- ${allocationLabel(a.method)} (${a.method}): ${a.count}`);
  }
  lines.push(`Hard variety cap: no more than ${MAX_IDEAS_PER_TOPIC_PER_RUN} ideas may use the same topic/source topic in this run.`);
  lines.push("");
  lines.push("## Channel context");
  lines.push(`- name: ${ctx.title}`);
  if (ctx.niche) lines.push(`- niche: ${ctx.niche}`);
  if (ctx.audience) lines.push(`- audience: ${ctx.audience}`);
  if (ctx.voice) lines.push(`- voice: ${ctx.voice}`);
  if (ctx.external_sources) lines.push(`- external sources: ${ctx.external_sources}`);
  if (ctx.reddit_sources) lines.push(`- curated Reddit web-signal sources: ${ctx.reddit_sources}`);
  if (ctx.channel_description) lines.push(`- description: ${ctx.channel_description}`);
  if (ctx.banned_topics) lines.push(`- BANNED TOPICS (hard reject — do not propose ideas on these): ${ctx.banned_topics}`);
  lines.push("");

  lines.push("## Reddit web-signal research library");
  lines.push(...buildResearchContext(redditResearch));
  lines.push("");

  lines.push("## Channel-specific ideation rules (/channel-info)");
  lines.push(ctx.ideation_rules_text?.trim() || "(none)");
  lines.push("");

  lines.push("## AI-distilled learned rules (approved)");
  if (gathered.learned_rules.length === 0) {
    lines.push("(none)");
  } else {
    for (const r of gathered.learned_rules) {
      lines.push(`- [${r.rule_type}] ${r.rule_value}`);
    }
  }
  lines.push("");

  lines.push(`## Used title cooldown (${USED_TITLE_COOLDOWN_DAYS} days)`);
  const usedCooldownTitles = uniqueUsedTitleCooldowns(gathered.used_title_cooldowns).slice(0, 30);
  if (usedCooldownTitles.length === 0) {
    lines.push("(none)");
  } else {
    lines.push("The user copied/marked these titles green, so they are likely being used.");
    lines.push("Do not propose the exact same title or a very similar title. The topic can return later only with clearly different wording and structure.");
    for (const item of usedCooldownTitles) {
      const date = item.used_at ? item.used_at.slice(0, 10) : "unknown date";
      lines.push(`- ${date} | ${item.title}`);
    }
  }
  lines.push("");

  lines.push("## Channel's own recent uploads (last 20, for frequency check + title-tweak source)");
  if (gathered.own_recent_uploads.length === 0) {
    lines.push("(none)");
  } else {
    for (const u of gathered.own_recent_uploads) {
      const ageDays = u.published_at
        ? Math.floor((Date.now() / 1000 - u.published_at) / 86400)
        : null;
      const multiplier =
        gathered.own_median_views > 0
          ? (u.views / gathered.own_median_views).toFixed(2)
          : "—";
      lines.push(
        `- ${u.video_id} | ${multiplier}× median | ${ageDays ?? "?"}d ago | ${u.views.toLocaleString()} views | ${u.title}`
      );
    }
  }
  lines.push("");

  lines.push("## Competitor source bank (recent topics + evergreen formats, sorted by multiplier)");
  for (const comp of gathered.competitors) {
    const handleLabel = comp.handle ?? comp.channel_id;
    lines.push(
      `\n### ${comp.channel_name} (${handleLabel}, median ${comp.median_views.toLocaleString()})`
    );
    if (comp.note) lines.push(`  Note: ${comp.note}`);
    const top = comp.videos.slice(0, 12);
    for (const v of top) {
      const flag = v.is_outlier ? "★" : " ";
      lines.push(
        `  ${flag} [${v.video_id}] ${v.multiplier.toFixed(1)}× | ${v.age_days}d | ${v.views.toLocaleString()} views | ${v.title}`
      );
    }
  }
  lines.push("");

  // Mode-specific instruction
  if (mode === "auto") {
    lines.push("## Mode = auto");
    if (redditAvailable) {
      lines.push("Compose the exact candidate mix above across new_angle, title_tweak, and reddit_angle.");
    } else {
      lines.push("Compose the exact candidate mix above across new_angle and title_tweak only.");
      lines.push("Reddit web signals are unavailable for this run; do not produce reddit_angle ideas.");
    }
    lines.push("No fresh ideas in Auto. Every idea MUST cite nested source objects and proof.sources.");
    lines.push(`Do not create more than ${MAX_IDEAS_PER_TOPIC_PER_RUN} candidates from the same topic source, same Reddit topic, or same main subject.`);
  } else if (mode === "new_angles") {
    lines.push(
      "## Mode = new_angles",
      "EVERY idea uses Method B (Topic × Format mix).",
      `Pick a TOPIC from a competitor outlier uploaded within ${TOPIC_RECENCY_DAYS} days.`,
      "Prefer topics that recently went viral more than once; put additional same-topic outliers in topic_evidence_sources.",
      `Use any one primary topic source for at most ${MAX_IDEAS_PER_TOPIC_PER_RUN} ideas in this run.`,
      "Pick a TITLE STRUCTURE from a DIFFERENT proven outlier. This format source may be older because formats are evergreen.",
      "Stay close to the simple readable structure of the format source, but use simpler words.",
      "Both source video_ids MUST appear as nested source_attribution.topic_source and source_attribution.format_source objects."
    );
  } else if (mode === "title_tweaks") {
    lines.push(
      "## Mode = title_tweaks",
      "Take a winning title (own upload above-median OR competitor outlier ≥ 3× median) and make a small same-topic tweak.",
      `Use any one source title/topic for at most ${MAX_IDEAS_PER_TOPIC_PER_RUN} tweaks in this run.`,
      "Keep the exact same main subject and premise. Change only a few words for clarity, synonyms, or one-breath readability.",
      "Reject your own candidate if it swaps the subject, adds an abstract premise, or becomes harder to read than the source.",
      "The source title MUST appear as nested source_attribution.topic_source. format_source must be the empty source object."
    );
  } else if (mode === "reddit_angles") {
    lines.push(
      "## Mode = reddit_angles",
      "EVERY idea uses reddit_angle.",
      "Use Reddit web signals as the topic signal and a YouTube outlier or own winner as format_source.",
      `Use any one Reddit topic/source theme for at most ${MAX_IDEAS_PER_TOPIC_PER_RUN} ideas in this run.`,
      "topic_source may be the empty source object. proof.sources and research_sources MUST include Reddit permalinks."
    );
  }
  lines.push("");
  lines.push(`Return JSON only. Exactly ${composeCount} ideas, all valid per the rules above.`);
  return lines.join("\n");
}

function parseSourceVideo(v: unknown): SourceVideo | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  if (typeof rec.video_id !== "string" || rec.video_id.length === 0) return null;
  if (typeof rec.title !== "string") return null;
  if (typeof rec.channel_name !== "string") return null;
  return {
    video_id: rec.video_id,
    title: rec.title,
    channel_name: rec.channel_name,
    channel_handle: typeof rec.channel_handle === "string" ? rec.channel_handle : null,
    multiplier: typeof rec.multiplier === "number" ? rec.multiplier : null,
    thumbnail_url: typeof rec.thumbnail_url === "string" ? rec.thumbnail_url : null,
    views: typeof rec.views === "number" ? rec.views : null,
    published_at: typeof rec.published_at === "number" ? rec.published_at : null,
    age_days: typeof rec.age_days === "number" ? rec.age_days : null,
  };
}

function parseSourceVideoArray(v: unknown): SourceVideo[] {
  if (!Array.isArray(v)) return [];
  const out: SourceVideo[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const source = parseSourceVideo(item);
    if (!source || seen.has(source.video_id)) continue;
    seen.add(source.video_id);
    out.push(source);
  }
  return out;
}

function parseSourceLink(v: unknown): IdeaSourceLink | null {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  const type = rec.type === "youtube" || rec.type === "reddit" ? rec.type : null;
  if (!type || typeof rec.label !== "string" || typeof rec.url !== "string") return null;
  const date = typeof rec.date === "string" && rec.date.trim().length > 0
    ? rec.date
    : null;
  return {
    type,
    label: rec.label,
    url: rec.url,
    date,
  };
}

function parseProof(v: unknown): IdeaProof | null {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  if (
    typeof rec.source_signal !== "string" ||
    typeof rec.fit !== "string" ||
    typeof rec.execution !== "string"
  ) {
    return null;
  }
  const sources = Array.isArray(rec.sources)
    ? rec.sources.map(parseSourceLink).filter((s): s is IdeaSourceLink => !!s)
    : [];
  return {
    source_signal: rec.source_signal,
    fit: rec.fit,
    execution: rec.execution,
    whats_going_on:
      typeof rec.whats_going_on === "string" && rec.whats_going_on.trim().length > 0
        ? rec.whats_going_on
        : null,
    weak_proof:
      typeof rec.weak_proof === "string" && rec.weak_proof.trim().length > 0
        ? rec.weak_proof
        : null,
    sources,
  };
}

function normalizeConfidence(v: unknown): "high" | "medium" | "low" {
  return v === "high" || v === "medium" || v === "low" ? v : "medium";
}

export function parseComposeJson(raw: string): ComposedIdea[] | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const obj = parsed as { ideas?: unknown };
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.ideas)) return null;
  const out: ComposedIdea[] = [];
  let oldShapeCount = 0;
  for (const item of obj.ideas) {
    if (!item || typeof item !== "object") continue;
    const ii = item as Record<string, unknown>;
    if (typeof ii.title !== "string" || typeof ii.description !== "string") continue;
    const attr = ii.source_attribution as Record<string, unknown> | undefined;
    if (!attr || typeof attr.family !== "string" || typeof attr.reasoning !== "string") continue;
    const proof = parseProof(ii.proof);
    if (!proof) continue;
    const researchSources = Array.isArray(ii.research_sources)
      ? ii.research_sources
          .map(parseSourceLink)
          .filter((s): s is IdeaSourceLink => !!s)
      : [];
    // Fail loud on old shape — the bare *_video_id strings instead of nested
    // SourceVideo objects. Catching this here forces the system-prompt change
    // to actually bite; otherwise stale output silently passes.
    if ("topic_source_video_id" in attr || "format_source_video_id" in attr) {
      oldShapeCount++;
      continue;
    }
    const topicSource = parseSourceVideo(attr.topic_source);
    const formatSource = parseSourceVideo(attr.format_source);
    const topicEvidenceSources = parseSourceVideoArray(attr.topic_evidence_sources);
    // method is required on new output; if the model returned something
    // unrecognised, drop the idea outright — better to ship 9 valid ones
    // than 10 with a junk badge. Missing entirely is also rejected
    // (caller's prompt explicitly demands it).
    let method: IdeaMethod;
    if (typeof attr.method === "string" && VALID_METHODS.has(attr.method)) {
      method = attr.method as IdeaMethod;
    } else {
      continue;
    }
    out.push({
      title: ii.title,
      description: ii.description,
      source_attribution: {
        family: attr.family,
        topic_source: topicSource,
        format_source: formatSource,
        topic_evidence_sources: topicEvidenceSources,
        reasoning: attr.reasoning,
        method,
      },
      proof,
      confidence_level: normalizeConfidence(ii.confidence_level),
      research_sources: researchSources,
    });
  }
  if (oldShapeCount > 0) {
    log.error("ideate", "compose returned old-shape source_attribution", undefined, {
      oldShapeCount,
      total: obj.ideas.length,
    });
    return null;
  }
  return out;
}

/**
 * Build a video_id → SourceVideo index from gathered data. Covers all
 * competitor outliers AND the user's own recent uploads (the latter are
 * valid topic sources in Title Tweaks mode). Used to overwrite the
 * model's source attribution with canonical title/channel/multiplier
 * values — the model only needs to pick the video_id correctly.
 */
function buildVideoIndex(gathered: GatherResult): Map<string, SourceVideo> {
  const index = new Map<string, SourceVideo>();
  for (const comp of gathered.competitors) {
    for (const v of comp.videos) {
      index.set(v.video_id, {
        video_id: v.video_id,
        title: v.title,
        channel_name: comp.channel_name,
        channel_handle: comp.handle,
        multiplier: v.multiplier,
        thumbnail_url: v.thumbnail_url,
        views: v.views,
        published_at: v.published_at,
        age_days: v.age_days,
      });
    }
  }
  const ownChannelName = gathered.channel_context.title || "(your channel)";
  const ownChannelHandle = gathered.channel_context.handle;
  const ownMedian = gathered.own_median_views;
  for (const own of gathered.own_recent_uploads) {
    if (!index.has(own.video_id)) {
      index.set(own.video_id, {
        video_id: own.video_id,
        title: own.title,
        channel_name: ownChannelName,
        channel_handle: ownChannelHandle,
        multiplier:
          ownMedian > 0 ? Number((own.views / ownMedian).toFixed(2)) : null,
        thumbnail_url: own.thumbnail_url,
        views: own.views,
        published_at: own.published_at,
        age_days: own.published_at
          ? Math.max(0, Math.floor((Date.now() / 1000 - own.published_at) / 86400))
          : null,
      });
    }
  }
  return index;
}

function reconcileSourceVideo(
  raw: SourceVideo | null,
  index: Map<string, SourceVideo>
): SourceVideo | null {
  if (!raw) return null;
  const canonical = index.get(raw.video_id);
  if (canonical) return canonical;
  // Model picked an ID we don't have authoritative data for (rare —
  // probably a hallucination). Drop it rather than show the model's
  // potentially-wrong fields.
  log.warn("ideate", "compose source video_id not in gathered index", {
    video_id: raw.video_id,
  });
  return null;
}

function reconcileSourceVideoArray(
  raw: SourceVideo[],
  index: Map<string, SourceVideo>,
  excludeIds: Iterable<string | null | undefined> = []
): SourceVideo[] {
  const excluded = new Set(
    [...excludeIds].filter((id): id is string => typeof id === "string" && id.length > 0)
  );
  const seen = new Set<string>();
  const out: SourceVideo[] = [];
  for (const item of raw) {
    if (excluded.has(item.video_id) || seen.has(item.video_id)) continue;
    const reconciled = reconcileSourceVideo(item, index);
    if (!reconciled) continue;
    seen.add(reconciled.video_id);
    out.push(reconciled);
  }
  return out;
}

function reconcileIdeas(ideas: ComposedIdea[], gathered: GatherResult): ComposedIdea[] {
  const index = buildVideoIndex(gathered);
  return ideas.map((idea) => {
    const topicSource = reconcileSourceVideo(idea.source_attribution.topic_source, index);
    const formatSource = reconcileSourceVideo(idea.source_attribution.format_source, index);
    return {
      ...idea,
      source_attribution: {
        ...idea.source_attribution,
        topic_source: topicSource,
        format_source: formatSource,
        topic_evidence_sources: reconcileSourceVideoArray(
          idea.source_attribution.topic_evidence_sources ?? [],
          index,
          [topicSource?.video_id, formatSource?.video_id]
        ),
      },
    };
  });
}

interface ComposeCallResult {
  ideas: ComposedIdea[];
  rawTokens: { input: number; output: number };
}

async function callCompose(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string,
  attempt: number
): Promise<ComposeCallResult> {
  const userContent = attempt === 0
    ? userPrompt
    : `${userPrompt}\n\n[Retry ${attempt}] Your previous output did not produce valid parsed ideas. Return ONLY compact JSON matching { "ideas": [{ title, description, confidence_level, source_attribution: { family, topic_source, format_source, topic_evidence_sources, reasoning, method }, proof, research_sources }] }. No prose, no markdown fences. Keep every proof field to one sentence. Use [] for topic_evidence_sources when there is no second topic signal. Use empty strings and empty source objects instead of null.`;

  const resp = await callAnthropic(client, {
    model: IDEATION_MODEL_COMPOSE,
    max_tokens: IDEATION_COMPOSE_MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { format: COMPOSE_OUTPUT_FORMAT, effort: "low" },
  });

  const parsedResp = resp as Anthropic.Message & {
    parsed_output?: ComposeStructuredOutput | null;
  };
  const parsedContent = resp.content as Array<{
    type: string;
    text?: string;
    parsed_output?: ComposeStructuredOutput | null;
  }>;
  const structured =
    parsedResp.parsed_output ??
    parsedContent.find((b) => b.type === "text" && b.parsed_output)?.parsed_output ??
    null;
  const raw = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
  const parsed = structured
    ? parseComposeJson(JSON.stringify(structured))
    : parseComposeJson(raw);
  if (!parsed || parsed.length === 0) {
    log.warn("ideate", "compose parse produced zero usable ideas", {
      attempt,
      structuredPresent: !!structured,
      rawLength: raw.length,
      contentTypes: resp.content.map((b) => b.type),
      rawPreview: raw.slice(0, 300),
    });
  }
  return {
    ideas: parsed ?? [],
    rawTokens: {
      input: resp.usage?.input_tokens ?? 0,
      output: resp.usage?.output_tokens ?? 0,
    },
  };
}

function getAnthropicClient(): Anthropic {
  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) throw new Error("Anthropic API key missing — set it in /settings/integrations");
  return new Anthropic({ apiKey });
}

export async function compose(
  gathered: GatherResult,
  mode: Mode,
  count: number,
  redditResearch: RedditResearchItem[] = [],
  clientOverride?: Anthropic,
  redditAvailable = true
): Promise<{ ideas: ComposedIdea[]; tokensUsed: { input: number; output: number } }> {
  const client = clientOverride ?? getAnthropicClient();
  const systemPrompt = buildComposeSystemPrompt();
  let tokensUsed = { input: 0, output: 0 };
  const ideas: ComposedIdea[] = [];
  const allocations = allocateIdeaBuckets(mode, count, { redditAvailable });
  const chunks = splitComposeAllocations(allocations);

  for (const chunk of chunks) {
    const chunkMode = modeForMethod(chunk.method);
    const userPrompt = buildComposeUserPrompt(
      gathered,
      chunkMode,
      chunk.count,
      chunk.method === "reddit_angle" ? redditResearch : [],
      chunk.method === "reddit_angle"
    );
    let lastErr: unknown = null;
    let chunkIdeas: ComposedIdea[] = [];

    log.info("ideate", "compose chunk start", {
      method: chunk.method,
      target: chunk.count,
    });

    for (let attempt = 0; attempt <= MAX_COMPOSE_RETRIES; attempt++) {
      try {
        const result = await callCompose(client, systemPrompt, userPrompt, attempt);
        tokensUsed = {
          input: tokensUsed.input + result.rawTokens.input,
          output: tokensUsed.output + result.rawTokens.output,
        };
        if (result.ideas.length > 0) {
          chunkIdeas = reconcileIdeas(result.ideas, gathered).slice(0, chunk.count);
          break;
        }
        log.warn("ideate", "compose returned no valid ideas, retrying", {
          attempt,
          method: chunk.method,
        });
      } catch (err) {
        lastErr = err;
        log.warn("ideate", "compose call failed", {
          attempt,
          method: chunk.method,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (chunkIdeas.length === 0) {
      throw new Error(
        `compose ${chunk.method} chunk exhausted (${MAX_COMPOSE_RETRIES + 1} attempts): ${lastErr instanceof Error ? lastErr.message : String(lastErr ?? "no valid JSON")}`
      );
    }

    ideas.push(...chunkIdeas);
    log.info("ideate", "compose chunk complete", {
      method: chunk.method,
      ideas_returned: chunkIdeas.length,
    });
  }

  return { ideas, tokensUsed };
}

/* ------------------------------------------------------------ */
/* validate()                                                     */
/* ------------------------------------------------------------ */

interface HardRuleVerdict {
  passed: boolean;
  reason: string | null;
}

function sourceAgeDays(source: SourceVideo | null | undefined): number | null {
  if (!source) return null;
  if (typeof source.age_days === "number" && Number.isFinite(source.age_days)) {
    return source.age_days;
  }
  if (typeof source.published_at === "number" && source.published_at > 0) {
    return Math.max(0, Math.floor((Date.now() / 1000 - source.published_at) / 86400));
  }
  return null;
}

function topicEvidenceSources(idea: Pick<ComposedIdea, "source_attribution">): SourceVideo[] {
  const out: SourceVideo[] = [];
  const seen = new Set<string>();
  const add = (source: SourceVideo | null | undefined) => {
    if (!source || seen.has(source.video_id)) return;
    seen.add(source.video_id);
    out.push(source);
  };
  add(idea.source_attribution.topic_source);
  for (const source of idea.source_attribution.topic_evidence_sources ?? []) add(source);
  return out;
}

function hasRecentTopicSignal(sources: SourceVideo[]): boolean {
  return sources.some((source) => {
    const age = sourceAgeDays(source);
    return age !== null && age <= TOPIC_RECENCY_DAYS;
  });
}

function recentTopicSignalCount(sources: SourceVideo[]): number {
  return sources.reduce((count, source) => {
    const age = sourceAgeDays(source);
    return age !== null && age <= TOPIC_RECENCY_DAYS ? count + 1 : count;
  }, 0);
}

const TITLE_TWEAK_STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "before",
  "between",
  "could",
  "every",
  "finally",
  "from",
  "have",
  "human",
  "humans",
  "just",
  "like",
  "really",
  "that",
  "their",
  "there",
  "this",
  "through",
  "what",
  "when",
  "where",
  "will",
  "with",
  "would",
  "your",
]);

function contentWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 3 && !TITLE_TWEAK_STOPWORDS.has(w));
}

function normalizeCooldownTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueUsedTitleCooldowns(items: UsedTitleCooldown[]): UsedTitleCooldown[] {
  const seen = new Set<string>();
  const out: UsedTitleCooldown[] = [];
  for (const item of items) {
    const key = normalizeCooldownTitle(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function usedTitleSimilarityScore(title: string, usedTitle: string): number {
  const normalizedTitle = normalizeCooldownTitle(title);
  const normalizedUsed = normalizeCooldownTitle(usedTitle);
  if (!normalizedTitle || !normalizedUsed) return 0;
  if (normalizedTitle === normalizedUsed) return 1;

  const a = new Set(contentWords(normalizedTitle));
  const b = new Set(contentWords(normalizedUsed));
  if (a.size === 0 || b.size === 0) return 0;

  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap++;
  const minSize = Math.min(a.size, b.size);
  const unionSize = new Set([...a, ...b]).size;
  const containment = overlap / Math.max(1, minSize);
  const jaccard = overlap / Math.max(1, unionSize);

  if (overlap >= 4 && containment >= 0.8) return containment;
  return jaccard;
}

function usedTitleCooldownReason(
  title: string,
  usedTitles: UsedTitleCooldown[]
): string | null {
  const normalizedTitle = normalizeCooldownTitle(title);
  for (const item of uniqueUsedTitleCooldowns(usedTitles)) {
    const normalizedUsed = normalizeCooldownTitle(item.title);
    if (!normalizedUsed) continue;
    if (normalizedTitle === normalizedUsed) {
      return `cooldown: exact copied title already used: ${item.title}`;
    }
    const score = usedTitleSimilarityScore(title, item.title);
    if (score >= 0.8) {
      return `cooldown: too similar to copied title: ${item.title}`;
    }
  }
  return null;
}

function topicCapSignal(
  idea: Pick<ComposedIdea, "title" | "source_attribution" | "proof" | "research_sources">
): { label: string; sourceIds: Set<string> } | null {
  const sources = topicEvidenceSources(idea);
  const sourceIds = new Set(
    sources
      .map((source) => source.video_id)
      .filter((id) => id && id.trim().length > 0)
  );
  const primaryLabel = sources.find((source) => source.title?.trim())?.title?.trim();
  if (primaryLabel) return { label: primaryLabel, sourceIds };

  const redditSource =
    idea.proof.sources.find((source) => source.type === "reddit") ??
    idea.research_sources.find((source) => source.type === "reddit");
  if (redditSource?.label?.trim()) {
    return { label: redditSource.label.trim(), sourceIds };
  }

  const signal = idea.proof.source_signal?.trim();
  if (signal) return { label: signal, sourceIds };
  return idea.title.trim() ? { label: idea.title.trim(), sourceIds } : null;
}

function sourceIdsOverlap(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const id of a) if (b.has(id)) return true;
  return false;
}

function enforceTopicCap(verdicts: ValidatedIdea[]): void {
  const clusters: Array<{
    representative: string;
    label: string;
    sourceIds: Set<string>;
    count: number;
  }> = [];
  const ordered = verdicts
    .map((idea, idx) => ({ idea, idx, rank: validatedIdeaRank(idea) }))
    .filter((item) => item.idea.validation_status === "passed")
    .sort((a, b) => b.rank - a.rank);

  for (const item of ordered) {
    const signal = topicCapSignal(item.idea);
    if (!signal) continue;
    let cluster = clusters.find(
      (candidate) =>
        sourceIdsOverlap(candidate.sourceIds, signal.sourceIds) ||
        usedTitleSimilarityScore(candidate.representative, signal.label) >= 0.68
    );
    if (!cluster) {
      cluster = {
        representative: signal.label,
        label: signal.label,
        sourceIds: new Set(signal.sourceIds),
        count: 0,
      };
      clusters.push(cluster);
    }
    if (cluster.count >= MAX_IDEAS_PER_TOPIC_PER_RUN) {
      verdicts[item.idx].validation_status = "rejected";
      verdicts[item.idx].validation_reason =
        `topic cap: more than ${MAX_IDEAS_PER_TOPIC_PER_RUN} ideas on "${cluster.label}"`;
      continue;
    }
    cluster.count++;
    for (const id of signal.sourceIds) cluster.sourceIds.add(id);
  }
}

export function titleTweakDriftReason(title: string, sourceTitle: string): string | null {
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedSource = sourceTitle.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalizedSource) return null;
  if (normalizedTitle === normalizedSource) {
    return "title_tweak unchanged from source";
  }

  const srcWords = new Set(contentWords(sourceTitle));
  const newWords = contentWords(title);
  if (srcWords.size === 0 || newWords.length === 0) return null;

  let overlap = 0;
  let added = 0;
  for (const word of newWords) {
    if (srcWords.has(word)) overlap++;
    else added++;
  }
  const overlapRatio = overlap / Math.max(1, Math.min(srcWords.size, newWords.length));
  if (overlapRatio < 0.45 || added > 4) {
    return `title_tweak drifted from source topic (${added} new content words)`;
  }
  return null;
}

function knownOutlierIndex(gathered: GatherResult): {
  ids: Set<string>;
  multiplierById: Map<string, number>;
} {
  const ids = new Set<string>();
  const multiplierById = new Map<string, number>();
  for (const c of gathered.competitors) {
    for (const v of c.videos) {
      if (!v.is_outlier) continue;
      ids.add(v.video_id);
      multiplierById.set(v.video_id, v.multiplier);
    }
  }
  return { ids, multiplierById };
}

export function titleWordCount(title: string): number {
  return title.trim().split(/\s+/).filter((word) => word.length > 0).length;
}

export function titleLengthHardRuleReason(title: string): string | null {
  if (title.length > TITLE_MAX_CHARS) {
    return `title too long: ${title.length} characters; max ${TITLE_MAX_CHARS}`;
  }
  const words = titleWordCount(title);
  if (words > TITLE_MAX_WORDS) {
    return `title too wordy: ${words} words; max ${TITLE_MAX_WORDS}`;
  }
  return null;
}

export function hardRuleCheck(idea: ComposedIdea, gathered: GatherResult): HardRuleVerdict {
  const title = idea.title.trim();
  if (title.length === 0) return { passed: false, reason: "empty title" };
  const titleLengthReason = titleLengthHardRuleReason(title);
  if (titleLengthReason) return { passed: false, reason: titleLengthReason };
  const lowerTitle = title.toLowerCase();
  const cooldownReason = usedTitleCooldownReason(
    title,
    gathered.used_title_cooldowns ?? []
  );
  if (cooldownReason) {
    return { passed: false, reason: cooldownReason };
  }
  for (const w of FORBIDDEN_WORDS) {
    if (lowerTitle.includes(w.toLowerCase())) {
      return { passed: false, reason: `forbidden word: ${w}` };
    }
  }
  const bannedRaw = gathered.channel_context.banned_topics;
  if (bannedRaw) {
    const tokens = bannedRaw
      .split(/[,;\n]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    for (const t of tokens) {
      if (lowerTitle.includes(t) || idea.description.toLowerCase().includes(t)) {
        return { passed: false, reason: `matches banned topic: ${t}` };
      }
    }
  }
  for (const rule of gathered.learned_rules) {
    if (rule.rule_type !== "banned_topic" && rule.rule_type !== "banned_substitution" && rule.rule_type !== "banned_pattern") continue;
    const v = rule.rule_value.trim().toLowerCase();
    if (v.length === 0) continue;
    if (lowerTitle.includes(v) || idea.description.toLowerCase().includes(v)) {
      return { passed: false, reason: `violates learned rule: ${rule.rule_value}` };
    }
  }

  const method = idea.source_attribution.method;

  // PRIO-4: new_angle gate. Both source video_ids must come from the
  // competitor_outliers context (not own uploads, not invented), must be
  // distinct, and both must clear the 2.0× multiplier bar. The compose
  // prompt already pushes the model to fall back to "fresh" when these
  // can't be satisfied — this is the back-stop that fails loudly when
  // the model ignores the instruction.
  if (method === "new_angle") {
    const { ids: outlierIds, multiplierById: outlierMultiplierById } =
      knownOutlierIndex(gathered);
    const topic = idea.source_attribution.topic_source?.video_id ?? null;
    const fmt = idea.source_attribution.format_source?.video_id ?? null;
    if (!topic || !fmt) {
      return { passed: false, reason: "new_angle missing valid outlier source" };
    }
    if (topic === fmt) {
      return { passed: false, reason: "new_angle missing valid outlier source" };
    }
    if (!outlierIds.has(topic) || !outlierIds.has(fmt)) {
      return { passed: false, reason: "new_angle missing valid outlier source" };
    }
    const tMult = outlierMultiplierById.get(topic) ?? 0;
    const fMult = outlierMultiplierById.get(fmt) ?? 0;
    if (tMult < 2.0 || fMult < 2.0) {
      return { passed: false, reason: "new_angle missing valid outlier source" };
    }
    for (const evidence of idea.source_attribution.topic_evidence_sources ?? []) {
      if (!outlierIds.has(evidence.video_id)) {
        return { passed: false, reason: "topic evidence source is not a known outlier" };
      }
    }
    const primaryTopicAge = sourceAgeDays(idea.source_attribution.topic_source);
    if (primaryTopicAge === null) {
      return {
        passed: false,
        reason: "topic source is missing upload age/date metadata",
      };
    }
    if (primaryTopicAge > TOPIC_RECENCY_DAYS) {
      return {
        passed: false,
        reason: `topic source is older than ${TOPIC_RECENCY_DAYS} days`,
      };
    }
  }

  if (method === "reddit_angle") {
    const hasRedditSource =
      idea.proof.sources.some((s) => s.type === "reddit" && s.url.includes("reddit.com")) ||
      idea.research_sources.some((s) => s.type === "reddit" && s.url.includes("reddit.com"));
    if (!hasRedditSource) {
      return { passed: false, reason: "reddit_angle missing Reddit source" };
    }
    const format = idea.source_attribution.format_source;
    if (!format) {
      return { passed: false, reason: "reddit_angle missing YouTube format source" };
    }
    const sourceIds = new Set<string>();
    for (const comp of gathered.competitors) {
      for (const v of comp.videos) {
        if (v.is_outlier) sourceIds.add(v.video_id);
      }
    }
    for (const own of gathered.own_recent_uploads) {
      if (gathered.own_median_views > 0 && own.views >= gathered.own_median_views) {
        sourceIds.add(own.video_id);
      }
    }
    if (!sourceIds.has(format.video_id)) {
      return { passed: false, reason: "reddit_angle format source is not a YouTube outlier or own winner" };
    }
  }

  // PRIO-7: title_tweak token-diff rule. The whole point of a tweak is a
  // small same-topic edit. Reject unchanged copies and subject drift, but
  // allow close readable variants.
  if (method === "title_tweak") {
    const sourceTitle = idea.source_attribution.topic_source?.title ?? "";
    const driftReason = titleTweakDriftReason(title, sourceTitle);
    if (driftReason) {
      return { passed: false, reason: driftReason };
    }
  }

  // PRIO-7: relax the duplicate-of-recent-upload gate for title_tweak
  // when the source upload was a winner (≥ 3× channel median). The mode
  // exists exactly to tweak proven winners; without this skip, every
  // legitimate tweak got rejected by the freq check. Other methods
  // (fresh, new_angle) keep the original frequency check.
  const skipFreqCheck =
    method === "title_tweak" &&
    (() => {
      const src = idea.source_attribution.topic_source;
      if (!src) return false;
      const own = gathered.own_recent_uploads.find(
        (u) => u.video_id === src.video_id
      );
      if (!own) return false;
      const m =
        gathered.own_median_views > 0 ? own.views / gathered.own_median_views : 0;
      return m >= 3;
    })();

  if (!skipFreqCheck) {
    for (const own of gathered.own_recent_uploads) {
      const ownTitle = (own.title ?? "").toLowerCase();
      if (!ownTitle) continue;
      const ownWords = new Set(ownTitle.split(/\s+/).filter((w) => w.length > 4));
      const newWords = lowerTitle.split(/\s+/).filter((w) => w.length > 4);
      let overlap = 0;
      for (const w of newWords) if (ownWords.has(w)) overlap++;
      if (newWords.length >= 3 && overlap >= 3) {
        const multiplier = gathered.own_median_views > 0 ? own.views / gathered.own_median_views : 0;
        if (multiplier < 3) {
          return { passed: false, reason: `duplicate of recent upload: ${own.title}` };
        }
      }
    }
  }
  return { passed: true, reason: null };
}

export interface ValidatorScore {
  idx: number;
  fit_score: number;
  dup_of: number | null;
  fit_reason: string;
  weak_proof: string | null;
}

function buildValidateSystemPrompt(): string {
  return [
    "You are a YouTube channel-fit validator. For each candidate idea, score 0-10 on",
    "whether THIS topic genuinely fits THIS channel's niche, audience, and voice —",
    "not whether the topic is broadly viral. A generic angle slapped on a hot format",
    "scores 3-4. An idea that uniquely leverages this channel's authority + audience scores 8-10.",
    "",
    "Also flag near-duplicates within the candidate set (same topic, same angle).",
    "Do not reject weak-but-plausible ideas yourself. If proof is weak but the idea",
    "still fits, score it 5-6 and name the weak proof in weak_proof.",
    "Decimals are allowed; use them when a candidate sits between two quality levels.",
    "",
    "Output ONLY JSON: { \"ideas\": [{ \"idx\": <0-based-index>, \"fit_score\": <0-10 decimal allowed>, \"dup_of\": <idx or -1>, \"fit_reason\": \"<one sentence>\", \"weak_proof\": \"\" }] }",
  ].join("\n");
}

function buildValidateUserPrompt(survivors: { idx: number; idea: ComposedIdea }[], gathered: GatherResult): string {
  const ctx = gathered.channel_context;
  const lines: string[] = [];
  lines.push("## Channel");
  lines.push(`name: ${ctx.title}`);
  if (ctx.niche) lines.push(`niche: ${ctx.niche}`);
  if (ctx.audience) lines.push(`audience: ${ctx.audience}`);
  if (ctx.voice) lines.push(`voice: ${ctx.voice}`);
  if (ctx.channel_description) lines.push(`description: ${ctx.channel_description}`);
  lines.push("");

  lines.push("## Channel's own recent winners (above-median uploads)");
  const ownWinners = gathered.own_recent_uploads.filter(
    (u) => gathered.own_median_views > 0 && u.views >= gathered.own_median_views
  );
  if (ownWinners.length === 0) lines.push("(none above median yet)");
  for (const w of ownWinners) lines.push(`- ${w.title}`);
  lines.push("");

  lines.push("## Candidate ideas to score");
  for (const s of survivors) {
    lines.push(`[idx=${s.idx}] ${s.idea.title}`);
    lines.push(`  description: ${s.idea.description}`);
    lines.push(`  family: ${s.idea.source_attribution.family}`);
    lines.push(`  method: ${s.idea.source_attribution.method ?? "unknown"}`);
    const topicSignals = topicEvidenceSources(s.idea);
    if (topicSignals.length > 0) {
      lines.push(
        `  topic_signals: ${topicSignals
          .map((source) => `${source.title} (${source.multiplier ?? "?"}×, ${sourceAgeDays(source) ?? "?"}d)`)
          .join(" | ")}`
      );
    }
    lines.push(`  source_signal: ${s.idea.proof.source_signal}`);
    lines.push(`  fit: ${s.idea.proof.fit}`);
    lines.push(`  execution: ${s.idea.proof.execution}`);
    if (s.idea.proof.whats_going_on) {
      lines.push(`  whats_going_on: ${s.idea.proof.whats_going_on}`);
    }
    if (s.idea.proof.weak_proof) {
      lines.push(`  weak_proof: ${s.idea.proof.weak_proof}`);
    }
    lines.push("");
  }
  lines.push("Score each. Output JSON only.");
  return lines.join("\n");
}

export function parseValidateJson(raw: string): ValidatorScore[] | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end < 0) return null;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const obj = parsed as { ideas?: unknown };
  if (!obj || !Array.isArray(obj.ideas)) return null;
  const out: ValidatorScore[] = [];
  for (const item of obj.ideas) {
    if (!item || typeof item !== "object") continue;
    const ii = item as Record<string, unknown>;
    if (typeof ii.idx !== "number" || typeof ii.fit_score !== "number") continue;
    const clampedScore = Math.max(0, Math.min(10, ii.fit_score));
    out.push({
      idx: ii.idx,
      fit_score: Math.round(clampedScore * 10) / 10,
      dup_of: typeof ii.dup_of === "number" && ii.dup_of >= 0 ? ii.dup_of : null,
      fit_reason: typeof ii.fit_reason === "string" ? ii.fit_reason : "",
      weak_proof:
        typeof ii.weak_proof === "string" && ii.weak_proof.trim().length > 0
          ? ii.weak_proof
          : null,
    });
  }
  return out;
}

export function confidenceFromFitScore(
  fitScore: number | null,
  weakProof?: string | null
): "high" | "medium" | "low" {
  if (weakProof && weakProof.trim().length > 0) return "low";
  if (fitScore === null) return "medium";
  if (fitScore >= 9) return "high";
  if (fitScore >= FIT_SCORE_PASS_THRESHOLD) return "medium";
  return "low";
}

export function confidenceFromEvidence(
  fitScore: number | null,
  weakProof: string | null | undefined,
  idea: Pick<ComposedIdea, "source_attribution" | "proof" | "research_sources">
): "high" | "medium" | "low" {
  if (weakProof && weakProof.trim().length > 0) return "low";
  if (fitScore === null) return "medium";

  const evidence = topicEvidenceSources(idea);
  const evidenceCount = evidence.length;
  const hasRecent = hasRecentTopicSignal(evidence);
  const recentCount = recentTopicSignalCount(evidence);

  if (fitScore >= 8 && recentCount >= 2) return "high";

  const hasRedditProof =
    idea.proof.sources.some((s) => s.type === "reddit" && s.url.includes("reddit.com")) ||
    idea.research_sources.some((s) => s.type === "reddit" && s.url.includes("reddit.com"));
  if (fitScore >= FIT_SCORE_PASS_THRESHOLD && (hasRecent || evidenceCount >= 2 || hasRedditProof)) {
    return "medium";
  }

  return "low";
}

function confidenceRank(confidence: "high" | "medium" | "low"): number {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}

function validatedIdeaRank(idea: ValidatedIdea): number {
  const recentCount = recentTopicSignalCount(topicEvidenceSources(idea));
  const fitScore = idea.fit_score ?? 0;
  return confidenceRank(idea.confidence_level) * 10_000 + recentCount * 100 + fitScore;
}

function selectBalancedPassing(
  verdicts: ValidatedIdea[],
  mode: Mode,
  count: number,
  redditAvailable = true
): Set<number> {
  const target = allocateIdeaBuckets(mode, count, { redditAvailable });
  const passing = verdicts
    .map((v, i) => ({ v, i, score: validatedIdeaRank(v) }))
    .filter((x) => x.v.validation_status === "passed")
    .sort((a, b) => b.score - a.score);
  const selected = new Set<number>();

  for (const bucket of target) {
    const matches = passing.filter(
      (x) => x.v.source_attribution.method === bucket.method && !selected.has(x.i)
    );
    for (const item of matches.slice(0, bucket.count)) selected.add(item.i);
  }
  for (const item of passing) {
    if (selected.size >= count) break;
    selected.add(item.i);
  }
  return selected;
}

export async function validate(
  composed: ComposedIdea[],
  gathered: GatherResult,
  count: number,
  mode: Mode = "auto",
  clientOverride?: Anthropic,
  redditAvailable = true
): Promise<{ ideas: ValidatedIdea[]; tokensUsed: { input: number; output: number } }> {
  const verdicts: ValidatedIdea[] = composed.map((idea) => {
    const verdict = hardRuleCheck(idea, gathered);
    return {
      id: randomUUID(),
      title: idea.title,
      description: idea.description,
      source_attribution: idea.source_attribution,
      proof: idea.proof,
      confidence_level: idea.confidence_level,
      research_sources: idea.research_sources,
      validation_status: verdict.passed ? "passed" : "rejected",
      validation_reason: verdict.reason,
      fit_score: verdict.passed ? null : 0,
      fit_reason: null,
    };
  });

  const survivors = verdicts
    .map((v, idx) => ({ v, idx, idea: composed[idx] }))
    .filter((x) => x.v.validation_status === "passed");

  let tokensUsed = { input: 0, output: 0 };

  if (survivors.length === 0) {
    return { ideas: verdicts, tokensUsed };
  }

  const client = clientOverride ?? getAnthropicClient();
  const systemPrompt = buildValidateSystemPrompt();
  const userPrompt = buildValidateUserPrompt(
    survivors.map((s) => ({ idx: s.idx, idea: s.idea })),
    gathered
  );

  let scores: ValidatorScore[] = [];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_VALIDATE_RETRIES; attempt++) {
    try {
      const content =
        attempt === 0
          ? userPrompt
          : `${userPrompt}\n\n[Retry ${attempt}] Return ONLY a JSON object { "ideas": [...] }.`;
      const resp = await callAnthropic(client, {
        model: IDEATION_MODEL_VALIDATE,
        max_tokens: IDEATION_VALIDATE_MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content }],
        output_config: { format: VALIDATE_OUTPUT_FORMAT },
      });
      tokensUsed = {
        input: tokensUsed.input + (resp.usage?.input_tokens ?? 0),
        output: tokensUsed.output + (resp.usage?.output_tokens ?? 0),
      };
      const structured = (resp as Anthropic.Message & {
        parsed_output?: ValidateStructuredOutput | null;
      }).parsed_output;
      const raw = resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
      const parsed = structured
        ? parseValidateJson(JSON.stringify(structured))
        : parseValidateJson(raw);
      if (parsed && parsed.length > 0) {
        scores = parsed;
        break;
      }
      log.warn("ideate", "validate returned no scores, retrying", { attempt });
    } catch (err) {
      lastErr = err;
      log.warn("ideate", "validate call failed", {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (scores.length === 0) {
    throw new Error(
      `validate retries exhausted: ${lastErr instanceof Error ? lastErr.message : "no valid JSON"}`
    );
  }

  const scoreByIdx = new Map<number, ValidatorScore>();
  for (const s of scores) scoreByIdx.set(s.idx, s);

  for (const s of survivors) {
    const score = scoreByIdx.get(s.idx);
    if (!score) {
      verdicts[s.idx].validation_status = "rejected";
      verdicts[s.idx].validation_reason = "validator did not score";
      verdicts[s.idx].fit_score = 0;
      verdicts[s.idx].fit_reason = null;
      continue;
    }
    verdicts[s.idx].fit_score = score.fit_score;
    verdicts[s.idx].fit_reason = score.fit_reason.trim() || null;
    const weakProof = score.weak_proof?.trim() || null;
    if (weakProof) {
      verdicts[s.idx].proof = {
        ...verdicts[s.idx].proof,
        weak_proof: weakProof,
      };
    }
    verdicts[s.idx].confidence_level = confidenceFromEvidence(
      score.fit_score,
      weakProof,
      verdicts[s.idx]
    );
    if (score.dup_of !== null) {
      const dupScore = scoreByIdx.get(score.dup_of);
      if (dupScore && dupScore.fit_score >= score.fit_score && verdicts[score.dup_of].validation_status === "passed") {
        verdicts[s.idx].validation_status = "rejected";
        verdicts[s.idx].validation_reason = `duplicate of idx ${score.dup_of} (higher fit)`;
      }
    }
  }

  enforceTopicCap(verdicts);

  return { ideas: verdicts, tokensUsed };
}

/* ------------------------------------------------------------ */
/* persist()                                                      */
/* ------------------------------------------------------------ */

export function persist(validated: ValidatedIdea[], generationId: string): void {
  const stmt = db.prepare(
    `INSERT INTO ideas
       (id, generation_id, title, description, source_attribution,
        proof_json, confidence_level, research_sources_json,
        validation_status, validation_reason, fit_score, fit_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const idea of validated) {
      stmt.run(
        idea.id,
        generationId,
        idea.title,
        idea.description,
        JSON.stringify(idea.source_attribution),
        JSON.stringify(idea.proof),
        idea.confidence_level,
        JSON.stringify(idea.research_sources),
        idea.validation_status,
        idea.validation_reason,
        idea.fit_score,
        idea.fit_reason
      );
    }
  });
  tx();
}

/* ------------------------------------------------------------ */
/* distillFeedback()                                              */
/* ------------------------------------------------------------ */

interface DistilledRuleProposal {
  rule_type: "banned_topic" | "banned_substitution" | "banned_pattern" | "preferred_format" | "preferred_topic";
  rule_value: string;
  source_idea_id: string;
}

function buildDistillSystemPrompt(): string {
  return [
    "You distill user feedback notes on YouTube video ideas into structured rules",
    "that will guide future ideation for this channel.",
    "",
    "Each note is a free-text comment HAmo wrote on a specific idea. Read each note,",
    "decide if it suggests a generalizable rule, and propose 0 or 1 rules per note.",
    "Skip ambiguous notes (do not output anything for them).",
    "",
    "Rule types:",
    "- banned_topic: a topic to avoid (e.g. 'fermi paradox')",
    "- banned_substitution: a phrase that should never be swapped in (e.g. 'satire')",
    "- banned_pattern: a structural pattern to avoid (e.g. 'rhetorical question titles')",
    "- preferred_format: a format pattern HAmo wants more of",
    "- preferred_topic: a topic area HAmo wants more of",
    "",
    "rule_value: short token ≤ 50 chars.",
    "",
    "Output ONLY JSON: { \"rules\": [{ \"rule_type\", \"rule_value\", \"source_idea_id\" }] }",
  ].join("\n");
}

export async function distillFeedback(userChannelId: string, clientOverride?: Anthropic): Promise<void> {
  // PRIO-10: read structured feedback (feedback + feedback_reason)
  // instead of free-text user_note. Pending = feedback present AND
  // note_distilled_at not yet stamped. Positive feedback with no reason
  // is still useful: the distiller maps the idea's family/topic into a
  // preferred_* rule. Negative feedback always carries a reason (the UI
  // requires one before submitting NO).
  // The old user_note column is preserved for back-compat but no longer
  // drives any rule generation.
  const pending = db
    .prepare(
      `SELECT i.id, i.title, i.feedback, COALESCE(i.feedback_reason, '') AS reason
       FROM ideas i
       JOIN generations g ON g.id = i.generation_id
       WHERE g.user_channel_id = ?
         AND i.feedback IS NOT NULL
         AND i.note_distilled_at IS NULL
       ORDER BY i.created_at DESC
       LIMIT 50`
    )
    .all(userChannelId) as {
    id: string;
    title: string;
    feedback: "positive" | "negative";
    reason: string;
  }[];

  if (pending.length === 0) return;

  let client: Anthropic;
  if (clientOverride) {
    client = clientOverride;
  } else {
    const apiKey = getIntegration("claude")?.api_key;
    if (!apiKey) {
      log.warn("ideate", "distillFeedback skipped — no Anthropic key");
      return;
    }
    client = new Anthropic({ apiKey });
  }
  const systemPrompt = buildDistillSystemPrompt();
  const userPrompt = [
    "## Feedback to distill",
    "Each entry has feedback (positive|negative) and optionally a one-line",
    "reason. Map POSITIVE → preferred_topic / preferred_format. Map",
    "NEGATIVE → banned_topic / banned_substitution / banned_pattern.",
    "",
    ...pending.map(
      (p) =>
        `- idea_id=${p.id} | "${p.title}" — ${p.feedback}${p.reason ? ` — reason: ${p.reason}` : " (no reason given)"}`
    ),
    "",
    "Return JSON only.",
  ].join("\n");

  let proposals: DistilledRuleProposal[] = [];
  for (let attempt = 0; attempt <= MAX_DISTILL_RETRIES; attempt++) {
    try {
      const resp = await callAnthropic(client, {
        model: IDEATION_MODEL_DISTILL,
        max_tokens: IDEATION_DISTILL_MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });
      const raw = resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const parsed = JSON.parse(cleaned) as { rules?: DistilledRuleProposal[] };
      if (parsed && Array.isArray(parsed.rules)) {
        proposals = parsed.rules.filter(
          (r) =>
            r &&
            typeof r.rule_type === "string" &&
            typeof r.rule_value === "string" &&
            typeof r.source_idea_id === "string" &&
            r.rule_value.length <= 50
        );
        break;
      }
    } catch (err) {
      log.warn("ideate", "distill call failed", {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (proposals.length === 0) {
    log.info("ideate", "distillFeedback produced no proposals", { count: pending.length });
    db.prepare(
      `UPDATE ideas SET note_distilled_at = datetime('now')
       WHERE id IN (${pending.map(() => "?").join(",")})`
    ).run(...pending.map((p) => p.id));
    return;
  }

  const allowedTypes = new Set([
    "banned_topic",
    "banned_substitution",
    "banned_pattern",
    "preferred_format",
    "preferred_topic",
  ]);

  const insertRule = db.prepare(
    `INSERT INTO ideation_rules (user_channel_id, rule_type, rule_value, source_idea_id, pending)
     VALUES (?, ?, ?, ?, 1)`
  );
  const markDistilled = db.prepare(
    `UPDATE ideas SET note_distilled_at = datetime('now') WHERE id = ?`
  );
  const tx = db.transaction(() => {
    for (const r of proposals) {
      if (!allowedTypes.has(r.rule_type)) continue;
      insertRule.run(userChannelId, r.rule_type, r.rule_value, r.source_idea_id);
    }
    for (const p of pending) markDistilled.run(p.id);
  });
  tx();
  log.info("ideate", "distillFeedback inserted pending rules", {
    inserted: proposals.length,
    notes: pending.length,
  });
}

/* ------------------------------------------------------------ */
/* runPipeline() — orchestrator                                   */
/* ------------------------------------------------------------ */

function extractTopicSeeds(gathered: GatherResult): string[] {
  const seeds: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean.length < 4 || clean.length > 120) return;
    const key = clean.toLowerCase();
    if (seeds.some((s) => s.toLowerCase() === key)) return;
    seeds.push(clean);
  };

  try {
    const raw = gathered.channel_context.topic_analysis_json;
    if (raw) {
      const parsed = JSON.parse(raw) as {
        crossCompetitorPatterns?: Array<{ topic?: string; label?: string }>;
        topicClusters?: Array<{ topic?: string; label?: string }>;
        clusters?: Array<{ topic?: string; label?: string }>;
      };
      for (const cluster of parsed.crossCompetitorPatterns ?? []) {
        push(cluster.topic ?? cluster.label);
      }
      for (const cluster of parsed.topicClusters ?? parsed.clusters ?? []) {
        push(cluster.topic ?? cluster.label);
      }
    }
  } catch {
    /* ignore cached shape drift */
  }

  for (const own of gathered.own_recent_uploads.slice(0, 8)) push(own.title);
  for (const comp of gathered.competitors) {
    for (const v of comp.videos.filter((x) => x.is_outlier).slice(0, 4)) {
      push(v.title);
    }
  }

  return seeds.slice(0, 8);
}

function modeNeedsReddit(mode: Mode, redditAvailable: boolean): boolean {
  return mode === "reddit_angles" || (mode === "auto" && redditAvailable);
}

export async function runPipeline(
  generationId: string,
  options: GatherOptions = {}
): Promise<void> {
  const gen = db
    .prepare(
      `SELECT id, user_channel_id, mode, count FROM generations WHERE id = ?`
    )
    .get(generationId) as
    | { id: string; user_channel_id: string; mode: Mode; count: number }
    | undefined;
  if (!gen) {
    log.error("ideate", "runPipeline called with unknown generationId", { generationId });
    return;
  }

  const started = Date.now();
  try {
    log.info("ideate", "pipeline start", {
      generationId,
      user_channel_id: gen.user_channel_id,
      mode: gen.mode,
      count: gen.count,
    });

    const client = getAnthropicClient();

    // distillFeedback never blocks the generation. Failures log + continue.
    try {
      await distillFeedback(gen.user_channel_id, client);
    } catch (err) {
      log.warn("ideate", "distillFeedback errored — continuing", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const gathered = await gather(gen.user_channel_id, gen.mode, generationId, options);
    log.info("ideate", "gather complete", {
      generationId,
      competitors: gathered.competitors.length,
      yt_calls: gathered.yt_calls_made,
      dropped: gathered.dropped_competitors.length,
    });

    let redditResearch: RedditResearchItem[] = [];
    const subreddits = parseSubredditSources(gathered.channel_context.reddit_sources);
    let redditAvailable = hasRedditSignalProvider() && subreddits.length > 0;

    if (gen.mode === "reddit_angles" && !redditAvailable) {
      throw new Error(
        !hasRedditSignalProvider()
          ? "Brave Search API key missing — add it in /settings/integrations"
          : "No Reddit sources configured for this channel — add one subreddit per line in /channel-info"
      );
    }

    if (modeNeedsReddit(gen.mode, redditAvailable)) {
      const topics = extractTopicSeeds(gathered);
      try {
        redditResearch = await collectRedditResearch({
          userChannelId: gen.user_channel_id,
          generationId,
          topics,
          subreddits,
          maxItems: Math.max(12, Math.ceil(gen.count * 1.5)),
        });
      } catch (err) {
        if (gen.mode === "reddit_angles") throw err;
        redditAvailable = false;
        log.warn("ideate", "reddit web signals failed — continuing Auto without Reddit bucket", {
          generationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (redditResearch.length === 0) {
        if (gen.mode === "reddit_angles") {
          throw new Error("No usable Reddit web signals found in the configured subreddits for this channel");
        }
        redditAvailable = false;
      }
      log.info("ideate", "reddit research complete", {
        generationId,
        items: redditResearch.length,
        reused: redditResearch.filter((item) => item.reused).length,
      });
    }

    const composed = await compose(gathered, gen.mode, gen.count, redditResearch, client, redditAvailable);
    log.info("ideate", "compose complete", {
      generationId,
      ideas_returned: composed.ideas.length,
      tokens: composed.tokensUsed,
    });

    const validated = await validate(composed.ideas, gathered, gen.count, gen.mode, client, redditAvailable);
    const passed = validated.ideas.filter((v) => v.validation_status === "passed").length;
    log.info("ideate", "validate complete", {
      generationId,
      passed,
      rejected: validated.ideas.length - passed,
      tokens: validated.tokensUsed,
    });

    persist(validated.ideas, generationId);
    markGenerationCompleted(generationId);

    const totalCost =
      costMillicents(IDEATION_MODEL_COMPOSE, {
        inputFresh: composed.tokensUsed.input,
        inputCacheWrite: 0,
        inputCacheRead: 0,
        output: composed.tokensUsed.output,
      }) +
      costMillicents(IDEATION_MODEL_VALIDATE, {
        inputFresh: validated.tokensUsed.input,
        inputCacheWrite: 0,
        inputCacheRead: 0,
        output: validated.tokensUsed.output,
      });

    log.info("ideate", "pipeline complete", {
      generationId,
      total_cost_millicents: totalCost,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("ideate", "pipeline failed", err, { generationId, msg });
    markGenerationFailed(generationId, msg);
  }
}
