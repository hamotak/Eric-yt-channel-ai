import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { db, getIntegration } from "../db";
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
export const IDEATION_COMPOSE_MAX_TOKENS = 32000;
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
export const DAILY_IDEATION_BUDGET_MILLICENTS = 500_000;

export const OUTLIER_AGE_DAYS = 90;
export const OUTLIER_MULTIPLIER = 2.0;
export const RECENT_UPLOAD_VIDEOS_PER_COMPETITOR = 50;
// Compose overshoot — we ask the model for count * factor candidates so
// validate has slack after the fit_score >= 7 filter. Raised from 1.5 to
// 1.7 on 2026-05-20 after smoke showed 9-of-10 outcome at 1.5.
export const COMPOSE_OVERSHOOT_FACTOR = 1.7;
export const FIT_SCORE_PASS_THRESHOLD = 7;

const FORBIDDEN_WORDS = [
  "cinematic",
  "sensory",
  "visceral",
  "profound",
  "inexorable",
  "vastest",
  "physically impossible",
];

const TITLE_LEN_HARD_MAX = 80;
const TITLE_LEN_SOFT_MAX = 70;
const TITLE_LEN_MIN = 30;

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

export type Mode = "auto" | "new_angles" | "title_tweaks";

export interface ChannelContext {
  id: string;
  title: string;
  handle: string | null;
  niche: string | null;
  audience: string | null;
  voice: string | null;
  external_sources: string | null;
  banned_topics: string | null;
  channel_description: string | null;
  ideation_rules_text: string | null;
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
}

export interface VideoEntry {
  video_id: string;
  title: string;
  views: number;
  multiplier: number;
  age_days: number;
  is_outlier: boolean;
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
  yt_calls_made: number;
  dropped_competitors: { channel_id: string; reason: string }[];
}

export interface SourceVideo {
  video_id: string;
  title: string;
  channel_name: string;
  channel_handle: string | null;
  multiplier: number | null;
}

/**
 * Which compose path produced the idea — surfaced as a badge next to FIT.
 *  - new_angle  : two-outlier mashup (topic from outlier A, format from outlier B)
 *  - title_tweak: same topic as an existing high-performer, fresh title/hook
 *  - fresh      : neither — a real-event grounding or pure ideation path
 *
 * Old rows (pre-2026-05) have no method on disk; the UI renders "—" in
 * that case. parseComposeJson hard-fails an idea whose method is set
 * but invalid; missing-method is allowed for read-side back-compat.
 */
export type IdeaMethod = "new_angle" | "title_tweak" | "fresh";
const VALID_METHODS: ReadonlySet<string> = new Set([
  "new_angle",
  "title_tweak",
  "fresh",
]);

export interface SourceAttribution {
  family: string;
  topic_source: SourceVideo | null;
  format_source: SourceVideo | null;
  reasoning: string;
  method?: IdeaMethod;
}

export interface ComposedIdea {
  title: string;
  description: string;
  source_attribution: SourceAttribution;
}

export interface ValidatedIdea {
  id: string;
  title: string;
  description: string;
  source_attribution: SourceAttribution;
  validation_status: "passed" | "rejected";
  validation_reason: string | null;
  fit_score: number | null;
}

/* ------------------------------------------------------------ */
/* Anthropic call dispatcher — stream when max_tokens forces it  */
/* ------------------------------------------------------------ */

type StreamParams = Parameters<Anthropic["messages"]["stream"]>[0];

async function callAnthropic(
  client: Anthropic,
  params: StreamParams
): Promise<Anthropic.Message> {
  // SDK gates non-streaming requests when max_tokens > ANTHROPIC_STREAM_THRESHOLD
  // (~21333). For compose with 24K thinking + 8K JSON room we sit at 32K
  // and MUST stream. validate/distill are well below and use the plain path.
  // See note next to ANTHROPIC_STREAM_THRESHOLD for the math.
  if (typeof params.max_tokens === "number" && params.max_tokens > ANTHROPIC_STREAM_THRESHOLD) {
    return await client.messages.stream(params).finalMessage();
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

export function dailyBudgetSpentMillicents(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_millicents), 0) AS spent
       FROM generations
       WHERE started_at >= datetime('now', '-1 day')`
    )
    .get() as { spent: number };
  return row.spent;
}

export function dailyBudgetResetIso(): string {
  const row = db
    .prepare(
      `SELECT MIN(started_at) AS earliest
       FROM generations
       WHERE started_at >= datetime('now', '-1 day')`
    )
    .get() as { earliest: string | null };
  if (!row.earliest) return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  return new Date(new Date(row.earliest).getTime() + 24 * 3600 * 1000).toISOString();
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
              channel_description, ideation_rules
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
        channel_description: string | null;
        ideation_rules: string | null;
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
    channel_description: channelRow.channel_description,
    ideation_rules_text: channelRow.ideation_rules,
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
      `SELECT id AS video_id, title, views, published_at
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
    { title: string; views: number; publishedAt: number }
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
        return { id, title: meta.title, views: meta.views, age_days };
      })
      .filter((x): x is { id: string; title: string; views: number; age_days: number } => x !== null);

    const allViews = allEntries
      .map((e) => e.views)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const median = allViews.length > 0 ? allViews[Math.floor(allViews.length / 2)] : 0;

    const videos: VideoEntry[] = allEntries
      .filter((e) => e.age_days <= OUTLIER_AGE_DAYS)
      .map((e) => ({
        video_id: e.id,
        title: e.title,
        views: e.views,
        multiplier: median > 0 ? Number((e.views / median).toFixed(2)) : 0,
        age_days: e.age_days,
        is_outlier: median > 0 && e.views >= OUTLIER_MULTIPLIER * median,
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
    yt_calls_made,
    dropped_competitors: dropped,
  };
}

/* ------------------------------------------------------------ */
/* compose()                                                      */
/* ------------------------------------------------------------ */

function buildComposeSystemPrompt(): string {
  const mentor = readMentorMethod();
  const families = FORMULA_FAMILIES.map(
    ([name, example]) => `  - ${name}: e.g. "${example}"`
  ).join("\n");

  return [
    "You are HAmo's YouTube ideation mentor. You generate concrete video ideas",
    "for a specific channel by combining channel context, viral competitor",
    "outliers, and learned-rule constraints — strictly following the method below.",
    "",
    "## METHOD (verbatim, from MENTOR_METHOD.md)",
    mentor || "(method file unavailable — fall back to: outlier-driven, plain-language titles 50-70 chars, grounded in real events)",
    "",
    "## PROVEN FORMULA FAMILIES",
    "Every title you propose MUST map to exactly one of these 7 families. State",
    "the family in source_attribution.family.",
    families,
    "",
    "## TITLE RULES (HARD)",
    "- Length: 50-70 characters strongly preferred; 30-80 acceptable.",
    "- Plain language. Banned forbidden adjectives (will be auto-rejected):",
    `  ${FORBIDDEN_WORDS.map((w) => `"${w}"`).join(", ")}`,
    "- No clickbait that does not deliver. Curiosity gap must resolve in the video.",
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
    "- format_source: the DIFFERENT video whose title STRUCTURE you reused. null for Title Tweaks (no second source).",
    "- Both source objects carry { video_id, title, channel_name, channel_handle, multiplier }.",
    "- video_id MUST be picked from the competitor outliers or own uploads block in the user prompt — do not invent IDs.",
    "",
    "## METHOD TAG (HARD)",
    "Every idea MUST include source_attribution.method, set to ONE of:",
    "  - \"new_angle\"   : a two-outlier mashup. Topic from one competitor outlier,",
    "                    title format from a DIFFERENT competitor outlier. Both",
    "                    source video_ids MUST come from the competitor_outliers",
    "                    block and BOTH outliers MUST have multiplier ≥ 2.0.",
    "                    topic_source and format_source must reference DIFFERENT video_ids.",
    "                    If you cannot satisfy ALL of these constraints for a candidate,",
    "                    do NOT propose it as new_angle — propose it as \"fresh\" instead.",
    "  - \"title_tweak\" : same topic as an existing high-performer (competitor or own",
    "                    upload), restructured with a fresh hook/title format.",
    "  - \"fresh\"       : neither — a real-event grounding, originality-driven pitch,",
    "                    or any idea that doesn't tie back to two outliers.",
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
    '    "reasoning": "Topic from Milky Stellar 5.0× × Late Science\'s own 8.8× format structure.",',
    '    "method": "new_angle"',
    "  }",
    "}",
    "```",
    "Set format_source to null (the literal JSON null) for Title Tweaks where you only borrow a topic.",
  ].join("\n");
}

function buildComposeUserPrompt(gathered: GatherResult, mode: Mode, count: number): string {
  const ctx = gathered.channel_context;
  const overshoot = Math.ceil(count * COMPOSE_OVERSHOOT_FACTOR);

  const lines: string[] = [];
  lines.push(`# Target — generate ${overshoot} ideas (caller will select top ${count})`);
  lines.push(`Mode: ${mode}`);
  lines.push("");
  lines.push("## Channel context");
  lines.push(`- name: ${ctx.title}`);
  if (ctx.niche) lines.push(`- niche: ${ctx.niche}`);
  if (ctx.audience) lines.push(`- audience: ${ctx.audience}`);
  if (ctx.voice) lines.push(`- voice: ${ctx.voice}`);
  if (ctx.external_sources) lines.push(`- external sources: ${ctx.external_sources}`);
  if (ctx.channel_description) lines.push(`- description: ${ctx.channel_description}`);
  if (ctx.banned_topics) lines.push(`- BANNED TOPICS (hard reject — do not propose ideas on these): ${ctx.banned_topics}`);
  lines.push("");

  lines.push("## HAmo's hand-written rules (channel.ideation_rules)");
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

  lines.push("## Competitor outliers (sorted by multiplier within each competitor)");
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
    lines.push(
      "## Mode = auto",
      "Compose a balanced mix:",
      "- ~40% New Angles: Topic from one competitor outlier × format/structure from a different competitor outlier.",
      "- ~30% Fresh proposals grounded in channel context + a single competitor outlier.",
      "- ~30% Title Tweaks: take a recent winning title (own upload above-median OR competitor outlier 3×+), swap 1-2 keywords, keep structure.",
      "Every idea MUST cite the source video_id(s) it draws from."
    );
  } else if (mode === "new_angles") {
    lines.push(
      "## Mode = new_angles",
      "EVERY idea uses Method B (Topic × Format mix).",
      "Pick a TOPIC from one competitor's outlier, then a TITLE STRUCTURE from a DIFFERENT competitor's outlier.",
      "Both source video_ids MUST appear in source_attribution.topic_source_video_id and format_source_video_id."
    );
  } else if (mode === "title_tweaks") {
    lines.push(
      "## Mode = title_tweaks",
      "Take a recent winning title (own upload above-median OR competitor outlier ≥ 3× median) and swap 1-2 keywords while preserving structure. Produce A/B variants.",
      "The source title MUST appear in source_attribution.topic_source_video_id (the upload/outlier you tweaked)."
    );
  }
  lines.push("");
  lines.push(`Return JSON only. ${overshoot} ideas, all valid per the rules above.`);
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
  };
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
    // Fail loud on old shape — the bare *_video_id strings instead of nested
    // SourceVideo objects. Catching this here forces the system-prompt change
    // to actually bite; otherwise stale output silently passes.
    if ("topic_source_video_id" in attr || "format_source_video_id" in attr) {
      oldShapeCount++;
      continue;
    }
    const topicSource = parseSourceVideo(attr.topic_source);
    const formatSource = parseSourceVideo(attr.format_source);
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
        reasoning: attr.reasoning,
        method,
      },
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

function reconcileIdeas(ideas: ComposedIdea[], gathered: GatherResult): ComposedIdea[] {
  const index = buildVideoIndex(gathered);
  return ideas.map((idea) => ({
    ...idea,
    source_attribution: {
      ...idea.source_attribution,
      topic_source: reconcileSourceVideo(idea.source_attribution.topic_source, index),
      format_source: reconcileSourceVideo(idea.source_attribution.format_source, index),
    },
  }));
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
    : `${userPrompt}\n\n[Retry ${attempt}] Your previous output was not valid JSON matching { "ideas": [{ title, description, source_attribution: { family, reasoning, ... } }] }. Return ONLY the JSON object, no prose, no markdown fences.`;

  const resp = await callAnthropic(client, {
    model: IDEATION_MODEL_COMPOSE,
    max_tokens: IDEATION_COMPOSE_MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
    thinking: { type: "enabled", budget_tokens: IDEATION_THINKING_BUDGET },
  });

  const raw = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
  const parsed = parseComposeJson(raw);
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
  clientOverride?: Anthropic
): Promise<{ ideas: ComposedIdea[]; tokensUsed: { input: number; output: number } }> {
  const client = clientOverride ?? getAnthropicClient();
  const systemPrompt = buildComposeSystemPrompt();
  const userPrompt = buildComposeUserPrompt(gathered, mode, count);

  let tokensUsed = { input: 0, output: 0 };
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= MAX_COMPOSE_RETRIES; attempt++) {
    try {
      const result = await callCompose(client, systemPrompt, userPrompt, attempt);
      tokensUsed = {
        input: tokensUsed.input + result.rawTokens.input,
        output: tokensUsed.output + result.rawTokens.output,
      };
      if (result.ideas.length > 0) {
        const reconciled = reconcileIdeas(result.ideas, gathered);
        return { ideas: reconciled, tokensUsed };
      }
      log.warn("ideate", "compose returned no valid ideas, retrying", { attempt });
    } catch (err) {
      lastErr = err;
      log.warn("ideate", "compose call failed", {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw new Error(
    `compose retries exhausted (${MAX_COMPOSE_RETRIES + 1} attempts): ${lastErr instanceof Error ? lastErr.message : String(lastErr ?? "no valid JSON")}`
  );
}

/* ------------------------------------------------------------ */
/* validate()                                                     */
/* ------------------------------------------------------------ */

interface HardRuleVerdict {
  passed: boolean;
  reason: string | null;
}

export function hardRuleCheck(idea: ComposedIdea, gathered: GatherResult): HardRuleVerdict {
  const title = idea.title.trim();
  if (title.length === 0) return { passed: false, reason: "empty title" };
  if (title.length > TITLE_LEN_HARD_MAX) {
    return { passed: false, reason: `title too long: ${title.length} chars` };
  }
  if (title.length < TITLE_LEN_MIN) {
    return { passed: false, reason: `title too short: ${title.length} chars` };
  }
  const lowerTitle = title.toLowerCase();
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
    const outlierIds = new Set(
      gathered.competitors.flatMap((c) =>
        c.videos.filter((v) => v.is_outlier).map((v) => v.video_id)
      )
    );
    const outlierMultiplierById = new Map<string, number>();
    for (const c of gathered.competitors) {
      for (const v of c.videos) {
        if (v.is_outlier) outlierMultiplierById.set(v.video_id, v.multiplier);
      }
    }
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
  }

  // PRIO-7: title_tweak token-diff rule. The whole point of a tweak is a
  // changed title against the same proven topic — if the new title is
  // identical or a near-clone, it's just a copy. Require ≥ 2 distinct
  // content words (length > 3) that don't appear in the source title.
  if (method === "title_tweak") {
    const sourceTitle = idea.source_attribution.topic_source?.title ?? "";
    const srcWords = new Set(
      sourceTitle
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3)
    );
    const newWords = lowerTitle
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3);
    let distinct = 0;
    for (const w of newWords) if (!srcWords.has(w)) distinct++;
    if (sourceTitle.trim().length > 0 && distinct < 2) {
      return {
        passed: false,
        reason: `title_tweak too close to source (${distinct} distinct content words)`,
      };
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
}

function buildValidateSystemPrompt(): string {
  return [
    "You are a YouTube channel-fit validator. For each candidate idea, score 1-10 on",
    "whether THIS topic genuinely fits THIS channel's niche, audience, and voice —",
    "not whether the topic is broadly viral. A generic angle slapped on a hot format",
    "scores 3-4. An idea that uniquely leverages this channel's authority + audience scores 8-10.",
    "",
    "Also flag near-duplicates within the candidate set (same topic, same angle).",
    "",
    "Output ONLY JSON: { \"ideas\": [{ \"idx\": <0-based-index>, \"fit_score\": <1-10>, \"dup_of\": <idx | null>, \"fit_reason\": \"<one sentence>\" }] }",
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
    out.push({
      idx: ii.idx,
      fit_score: Math.max(1, Math.min(10, Math.round(ii.fit_score))),
      dup_of: typeof ii.dup_of === "number" ? ii.dup_of : null,
      fit_reason: typeof ii.fit_reason === "string" ? ii.fit_reason : "",
    });
  }
  return out;
}

export async function validate(
  composed: ComposedIdea[],
  gathered: GatherResult,
  count: number,
  clientOverride?: Anthropic
): Promise<{ ideas: ValidatedIdea[]; tokensUsed: { input: number; output: number } }> {
  const verdicts: ValidatedIdea[] = composed.map((idea) => {
    const verdict = hardRuleCheck(idea, gathered);
    return {
      id: randomUUID(),
      title: idea.title,
      description: idea.description,
      source_attribution: idea.source_attribution,
      validation_status: verdict.passed ? "passed" : "rejected",
      validation_reason: verdict.reason,
      fit_score: null,
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
      });
      tokensUsed = {
        input: tokensUsed.input + (resp.usage?.input_tokens ?? 0),
        output: tokensUsed.output + (resp.usage?.output_tokens ?? 0),
      };
      const raw = resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
      const parsed = parseValidateJson(raw);
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
      continue;
    }
    verdicts[s.idx].fit_score = score.fit_score;
    if (score.fit_score < FIT_SCORE_PASS_THRESHOLD) {
      verdicts[s.idx].validation_status = "rejected";
      verdicts[s.idx].validation_reason = `fit score ${score.fit_score} < ${FIT_SCORE_PASS_THRESHOLD}`;
    } else if (score.dup_of !== null) {
      const dupScore = scoreByIdx.get(score.dup_of);
      if (dupScore && dupScore.fit_score >= score.fit_score && verdicts[score.dup_of].validation_status === "passed") {
        verdicts[s.idx].validation_status = "rejected";
        verdicts[s.idx].validation_reason = `duplicate of idx ${score.dup_of} (higher fit)`;
      }
    }
  }

  const passing = verdicts
    .map((v, i) => ({ v, i, score: v.fit_score ?? 0 }))
    .filter((x) => x.v.validation_status === "passed")
    .sort((a, b) => b.score - a.score);

  if (passing.length > count) {
    for (let i = count; i < passing.length; i++) {
      const idx = passing[i].i;
      verdicts[idx].validation_status = "rejected";
      verdicts[idx].validation_reason = `over count limit (rank ${i + 1})`;
    }
  }

  return { ideas: verdicts, tokensUsed };
}

/* ------------------------------------------------------------ */
/* persist()                                                      */
/* ------------------------------------------------------------ */

export function persist(validated: ValidatedIdea[], generationId: string): void {
  const stmt = db.prepare(
    `INSERT INTO ideas
       (id, generation_id, title, description, source_attribution,
        validation_status, validation_reason, fit_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const idea of validated) {
      stmt.run(
        idea.id,
        generationId,
        idea.title,
        idea.description,
        JSON.stringify(idea.source_attribution),
        idea.validation_status,
        idea.validation_reason,
        idea.fit_score
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

    const composed = await compose(gathered, gen.mode, gen.count, client);
    log.info("ideate", "compose complete", {
      generationId,
      ideas_returned: composed.ideas.length,
      tokens: composed.tokensUsed,
    });

    const validated = await validate(composed.ideas, gathered, gen.count, client);
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
