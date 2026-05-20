import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  getChannel,
  getCompetitor,
  getIntegration,
  listCompetitorVideos,
  setCompetitorSimilarityScore,
} from "./db";
import { extractSection, loadMentorMethod } from "./mentor-method";
import { log } from "./logger";

export type ScoreSimilarityResult =
  | {
      ok: true;
      competitorId: number;
      score: number;
      reasoning: string;
      model: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

/**
 * Score how similar a competitor is to the user's own channel — 0..100,
 * grounded in MENTOR_METHOD.md §1. Called by the sync-queued worker
 * after each successful sync, and on demand from POST /api/competitors/
 * [id]/score-similarity. Persists into competitors.similarity_score.
 *
 * No rate limiting at this layer — the worker is already serialised and
 * a user-triggered manual recompute is rare. The route applies a tiny
 * cooldown to avoid spam.
 */
export async function scoreCompetitorSimilarity(
  competitorId: number
): Promise<ScoreSimilarityResult> {
  const competitor = getCompetitor(competitorId);
  if (!competitor) {
    return { ok: false, status: 404, error: "competitor not found" };
  }
  if (!competitor.user_channel_id) {
    return {
      ok: false,
      status: 400,
      error: "competitor is unassigned — assign it to a channel first",
    };
  }
  const channel = getChannel(competitor.user_channel_id);
  if (!channel) {
    return {
      ok: false,
      status: 404,
      error: `user channel ${competitor.user_channel_id} not found`,
    };
  }
  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      error: "Claude API key not configured. Add it on the Integrations page.",
    };
  }

  // Most recent 10 video titles to ground the niche/audience read. Ordered
  // by published_at via the listCompetitorVideos helper, then sliced. Even
  // a freshly-added competitor has these populated after the first sync.
  const videos = listCompetitorVideos(competitor.id, 100)
    .filter((v) => v.published_at != null)
    .sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0))
    .slice(0, 10);
  if (videos.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "no synced videos yet — wait for the first sync to finish",
    };
  }

  const md = loadMentorMethod();
  const sec1 = extractSection(md, 1);

  const systemPrompt = [
    "You are scoring how similar a competitor YouTube channel is to a user's own channel. Output is a single integer 0-100 plus a 1-2 sentence reasoning. Be strict — a score of 80+ means \"same niche, same audience, same content shape\". 30-60 = \"related niche or partial audience overlap\". Below 30 = \"different niche or audience\".",
    "",
    "From MENTOR_METHOD.md §1 (Competitor mapping — the B&S Method):",
    sec1 || "(section unavailable)",
    "",
    "Specifically, use §1's adjacency lens:",
    "- Own niche → score 60-100 depending on positioning overlap.",
    "- Adjacent niche → score 30-60.",
    "- Far niche → score 0-30.",
    "",
    "# Scoring rules",
    "1. The niche line of the user's context is the strongest signal. If the competitor's recent titles all match that niche → 60+. If they cover a related but distinct niche → 30-60. If unrelated → <30.",
    "2. Audience overlap matters secondarily. Same niche but very different audience age/intent → cap at 55.",
    "3. Don't reward channel SIZE — a tiny competitor doing the exact same niche scores as high as a huge one.",
    "4. Don't penalise for production polish or budget — score on niche/audience, not quality.",
    "",
    "Return ONLY a JSON object. No prose, no markdown, no code fence.",
    'Shape: { "score": number, "reasoning": string }',
    "The reasoning is 1-2 sentences naming the specific overlap or divergence you saw.",
  ].join("\n");

  const userBody = [
    "# USER CHANNEL CONTEXT",
    `- Niche: ${channel.niche?.trim() ? channel.niche.trim() : "(empty)"}`,
    `- Positioning: ${channel.positioning?.trim() ? channel.positioning.trim() : "(empty)"}`,
    `- Audience: ${channel.audience?.trim() ? channel.audience.trim() : "(empty)"}`,
    `- Voice: ${channel.voice?.trim() ? channel.voice.trim() : "(empty)"}`,
    "",
    "# COMPETITOR",
    `- Title: ${competitor.title ?? "(unknown)"}`,
    `- Handle: ${competitor.handle ?? "(none)"}`,
    `- Subscribers: ${competitor.subscriber_count ?? "?"}`,
    `- Video count: ${competitor.video_count ?? "?"}`,
    "- Recent 10 video titles:",
    ...videos.map((v) => `  - ${v.title}`),
  ].join("\n");

  const model = "claude-sonnet-4-6";
  let score = 0;
  let reasoning = "";
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: 300,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const parsed = parseScore(text);
    if (!parsed) {
      log.warn(
        "claude",
        `Similarity score ${competitorId}: malformed JSON. Raw: ${text.slice(0, 200)}`
      );
      return {
        ok: false,
        status: 502,
        error: "AI returned malformed JSON. Try again.",
      };
    }
    score = parsed.score;
    reasoning = parsed.reasoning;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Claude call failed";
    log.error("claude", `Similarity score ${competitorId}: ${msg}`, err);
    return { ok: false, status: 502, error: msg };
  }

  setCompetitorSimilarityScore(competitorId, score);
  log.info(
    "claude",
    `Similarity score ${competitorId}: ${score}/100 via ${model}`
  );

  return { ok: true, competitorId, score, reasoning, model };
}

function parseScore(raw: string): { score: number; reasoning: string } | null {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const rawScore = typeof obj.score === "number" ? obj.score : Number(obj.score);
  if (!Number.isFinite(rawScore)) return null;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const reasoning =
    typeof obj.reasoning === "string" ? obj.reasoning.trim() : "";
  if (reasoning.length === 0) return null;
  return { score, reasoning };
}
