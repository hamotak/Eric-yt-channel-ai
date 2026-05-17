import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  getCompetitor,
  getCompetitorVideosByIds,
  getIntegration,
  getOutlierExplanation,
  getSetting,
  getTranscript,
  setSetting,
  upsertOutlierExplanation,
} from "./db";
import { providerModelId } from "./ai-provider-types";
import { extractSection, LEVERS, loadMentorMethod } from "./mentor-method";
import { log } from "./logger";

const RATE_LIMIT_WINDOW_SEC = 24 * 60 * 60;

export type ExplainResult =
  | {
      ok: true;
      videoId: string;
      levers: string[];
      explanation: string;
      cached: boolean;
      generatedAt: number;
    }
  | {
      ok: false;
      status: number; // suggested HTTP status
      error: string;
      retryAfterSec?: number;
    };

/**
 * Get "what made it work" levers + 2-3-sentence explanation for one
 * outlier video. Cache-first; cached responses bypass rate-limit. On
 * cache miss, calls Claude Sonnet 4.6 with §2 + §9 inlined into the
 * system prompt, validates JSON, persists. Never throws — every error
 * mode returns a structured `ok: false` so the caller chooses its own
 * HTTP framing.
 *
 * Used by:
 *   - POST /api/outliers/explain (the side panel on /outliers Library)
 *   - explain_outlier chat tool (lets the agent reason about specific
 *     outliers without a round-trip through the route)
 */
export async function explainOutlier(opts: {
  videoId: string;
  competitorId?: number;
}): Promise<ExplainResult> {
  const videoId = opts.videoId?.trim();
  if (!videoId) {
    return { ok: false, status: 400, error: "videoId required" };
  }

  // Cache hit — no rate-limit check, no Claude call.
  const cached = getOutlierExplanation(videoId);
  if (cached) {
    return {
      ok: true,
      videoId: cached.videoId,
      levers: cached.levers,
      explanation: cached.explanation,
      cached: true,
      generatedAt: cached.generatedAt,
    };
  }

  // Video sanity check.
  const [video] = getCompetitorVideosByIds([videoId]);
  if (!video) {
    return { ok: false, status: 404, error: "video not found" };
  }
  const competitorId = opts.competitorId ?? video.competitorId;
  if (video.competitorId !== competitorId) {
    return {
      ok: false,
      status: 400,
      error: "competitorId does not match this video's row",
    };
  }
  const competitor = getCompetitor(competitorId);
  if (!competitor) {
    return { ok: false, status: 404, error: "competitor not found" };
  }

  // Rate limit (only for non-cached calls).
  const rateKey = `analyze_ai.outlier_explain.last_run.${videoId}`;
  const last = Number(getSetting(rateKey) ?? "0");
  const now = Math.floor(Date.now() / 1000);
  if (last > 0 && now - last < RATE_LIMIT_WINDOW_SEC) {
    return {
      ok: false,
      status: 429,
      error: "Explain is rate-limited per video (1 per 24h)",
      retryAfterSec: RATE_LIMIT_WINDOW_SEC - (now - last),
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

  // Transcripts almost never exist for competitor videos (the
  // transcripts table FKs the user's own videos), but if one happens to
  // exist for this id we pass it along.
  const transcript = getTranscript(videoId);
  const transcriptBlock = transcript?.text
    ? `# Transcript (first ~8K chars)\n${transcript.text.slice(0, 8000)}`
    : "(no transcript available — competitor_videos do not carry transcripts; reasoning will be title-only)";

  const md = loadMentorMethod();
  const sec2 = extractSection(md, 2);
  const sec9 = extractSection(md, 9);

  const systemPrompt = [
    "You are analyzing a single YouTube video that significantly outperformed its own channel's median. Your task: identify which 2–3 \"what made it work\" levers from the taxonomy below the video leans on, and write a brief plain-English explanation grounded in the title (and transcript snippet if provided). Be specific; do not list every plausible lever — pick the dominant 2–3.",
    "",
    "From MENTOR_METHOD.md §2 (Outliers — the engine):",
    sec2 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §9 (The \"what made it work\" lever taxonomy):",
    sec9 || "(section unavailable)",
    "",
    `Allowed lever names (use these exact strings, case-sensitive, in the JSON output): ${LEVERS.map((l) => `"${l}"`).join(", ")}.`,
    "",
    "Return ONLY a JSON object. No prose, no markdown, no code fence.",
    "Shape: { \"levers\": string[2-3], \"explanation\": string }",
    "The explanation must be 2–3 sentences, plain English, no fluff. Cite the specific phrase or number from the title that triggers each lever.",
  ].join("\n");

  const userBody = [
    `# Outlier video`,
    `- Competitor: ${competitor.title ?? "(unknown)"} (${competitor.handle ?? "no handle"}, tier: ${competitor.tier})`,
    `- Title: ${video.title}`,
    `- Views: ${video.views.toLocaleString("en-US")}`,
    `- Published: ${video.publishedAt ? new Date(video.publishedAt * 1000).toISOString().slice(0, 10) : "unknown"}`,
    "",
    transcriptBlock,
  ].join("\n");

  const model = providerModelId("claude");
  let levers: string[] = [];
  let explanation = "";
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: 800,
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const parsed = parseExplanation(text);
    if (!parsed) {
      log.warn(
        "claude",
        `Outlier-explain ${videoId}: could not parse JSON. Raw: ${text.slice(0, 200)}`
      );
      return {
        ok: false,
        status: 502,
        error: "AI returned malformed JSON. Try again.",
      };
    }
    levers = parsed.levers;
    explanation = parsed.explanation;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Claude call failed";
    log.error("claude", `Outlier-explain ${videoId}: ${msg}`, err);
    return { ok: false, status: 502, error: msg };
  }

  upsertOutlierExplanation({
    videoId,
    competitorId,
    levers,
    explanation,
    model,
  });
  setSetting(rateKey, String(now));
  log.info(
    "claude",
    `Outlier-explain ${videoId}: cached ${levers.length} levers from ${model}`
  );

  return {
    ok: true,
    videoId,
    levers,
    explanation,
    cached: false,
    generatedAt: now,
  };
}

function parseExplanation(
  raw: string
): { levers: string[]; explanation: string } | null {
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
  const rawLevers = Array.isArray(obj.levers) ? obj.levers : [];
  const levers = rawLevers
    .filter((v): v is string => typeof v === "string")
    .filter((s) => (LEVERS as readonly string[]).includes(s));
  const explanation =
    typeof obj.explanation === "string" ? obj.explanation.trim() : "";
  if (levers.length === 0 || explanation.length === 0) return null;
  return { levers: levers.slice(0, 3), explanation };
}
