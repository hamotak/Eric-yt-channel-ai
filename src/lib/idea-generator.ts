import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  competitorMedianViews,
  getCompetitorVideosByIds,
  getIntegration,
  getSetting,
  listAllChannels,
  setSetting,
} from "./db";
import { providerModelId } from "./ai-provider-types";
import {
  extractSection,
  isLever,
  LEVERS,
  loadMentorMethod,
} from "./mentor-method";
import { listOutliersForActiveChannel } from "./outliers";
import { log } from "./logger";

const RATE_LIMIT_WINDOW_SEC = 5 * 60;

export type Idea = {
  topic: string;
  suggestedTitle: string;
  angle: string;
  confidence: number;
  sourceOutlierVideoId: string;
};

export type GenerateIdeasResult =
  | {
      ok: true;
      ideas: Idea[];
      generatedAt: number;
      model: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      retryAfterSec?: number;
    };

/**
 * Synthesise 5–10 new video ideas for a user channel from real outlier
 * videos. Each idea references a specific source outlier and applies
 * one lever from §9. System prompt quotes §1 + §7 + §9 verbatim.
 *
 * If `outlierVideoIds` is omitted, auto-picks the top 10 outliers by
 * multiplier in the channel's scope. Rate-limited 1 per channel per 5
 * min. Never throws — every error mode returns a structured `ok: false`.
 *
 * Used by:
 *   - generate_ideas chat tool (the central ideation agent in /chat)
 *   - (previously, the deleted /api/outliers/generate-ideas endpoint)
 */
export async function generateIdeasForChannel(opts: {
  userChannelId: string;
  outlierVideoIds?: string[];
}): Promise<GenerateIdeasResult> {
  const userChannelId = opts.userChannelId?.trim();
  if (!userChannelId) {
    return { ok: false, status: 400, error: "userChannelId required" };
  }
  const all = listAllChannels();
  const channel = all.find((c) => c.id === userChannelId);
  if (!channel) {
    return {
      ok: false,
      status: 404,
      error: `Unknown userChannelId: ${userChannelId}`,
    };
  }

  // Rate limit (per channel, not per video sample — fresh batches cost
  // the same and shouldn't be gated by trivial sample-set differences).
  const rateKey = `analyze_ai.ideas.last_run.${userChannelId}`;
  const last = Number(getSetting(rateKey) ?? "0");
  const now = Math.floor(Date.now() / 1000);
  if (last > 0 && now - last < RATE_LIMIT_WINDOW_SEC) {
    return {
      ok: false,
      status: 429,
      error: "Idea generation is rate-limited per channel (1 per 5min)",
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

  // Pick the outlier sample. Caller-supplied IDs win; otherwise auto-pick
  // the channel's current top 10 outliers by multiplier.
  let outlierIds = opts.outlierVideoIds?.filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  if (!outlierIds || outlierIds.length === 0) {
    const auto = listOutliersForActiveChannel({
      userChannelId,
      limit: 10,
    });
    outlierIds = auto.outliers.map((o) => o.videoId);
  } else {
    outlierIds = outlierIds.slice(0, 20);
  }
  if (outlierIds.length === 0) {
    return {
      ok: false,
      status: 400,
      error:
        "No outliers available for this channel. Add competitors and sync first.",
    };
  }

  const outlierRows = getCompetitorVideosByIds(outlierIds);
  if (outlierRows.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "None of the supplied outlier video ids exist in the DB.",
    };
  }

  // Each row needs its competitor's median for the prompt context. We
  // compute medians per unique competitor (small set in practice).
  const medians = new Map<number, number>();
  const uniqueCompIds = Array.from(new Set(outlierRows.map((r) => r.competitorId)));
  for (const cid of uniqueCompIds) {
    medians.set(cid, competitorMedianViews(cid));
  }

  const md = loadMentorMethod();
  const sec1 = extractSection(md, 1);
  const sec7 = extractSection(md, 7);
  const sec9 = extractSection(md, 9);

  const systemPrompt = [
    "You are proposing 5–10 new video ideas for a YouTube creator, grounded in their existing channel context AND in real outlier videos that just over-performed in their competitive set. Every idea you propose must be traceable to a specific outlier — don't invent topics out of thin air.",
    "",
    "From MENTOR_METHOD.md §1 (Competitor mapping — the B&S Method):",
    sec1 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §7 (Ideation — synthesizing the inputs):",
    sec7 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §9 (The \"what made it work\" lever taxonomy):",
    sec9 || "(section unavailable)",
    "",
    `# Allowed angle values (use these exact strings in the "angle" field)`,
    LEVERS.map((l) => `"${l}"`).join(", "),
    "",
    "# Rules",
    "1. Propose 5–10 ideas. Quality over quantity — if only 5 are strong, return 5.",
    "2. Each idea must reference exactly one outlier from the SAMPLE block as its source.",
    "3. The suggested title must apply a methodology-grounded title format to the topic — NOT a literal copy of the source outlier's title. The user's channel voice (below) wins style ties.",
    "4. The \"angle\" is one lever from the taxonomy above — the dominant lever the source outlier leans on, applied to the new topic.",
    "5. Confidence (0.0–1.0): higher when the source outlier has a high multiplier AND the topic naturally fits the user's channel context. Lower when the lever is borrowed across far-niche tiers without modification.",
    "6. Authority-tier and Breakthrough-tier outliers carry more weight than Adjacent/Far. Far-tier outliers are best for thumbnail/structure inspiration, not topic reuse.",
    "",
    "Return ONLY a JSON object. No prose, no markdown, no code fence.",
    "Shape:",
    "{",
    '  "ideas": [',
    "    {",
    '      "topic": string,',
    '      "suggestedTitle": string,',
    '      "angle": string,',
    '      "confidence": number,',
    '      "sourceOutlierVideoId": string',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  type ChannelCtx = {
    niche?: string;
    positioning?: string;
    audience?: string;
    voice?: string;
    external_sources?: string;
  };
  const ctx = channel as unknown as ChannelCtx;

  const userBody = [
    "# USER CHANNEL CONTEXT",
    `- Niche: ${ctx.niche || "(empty)"}`,
    `- Positioning: ${ctx.positioning || "(empty)"}`,
    `- Audience: ${ctx.audience || "(empty)"}`,
    `- Voice: ${ctx.voice || "(empty)"}`,
    `- External sources: ${ctx.external_sources || "(empty)"}`,
    "",
    `# OUTLIER SAMPLE (${outlierRows.length} videos)`,
    ...outlierRows.map((r) => {
      const median = medians.get(r.competitorId) ?? 0;
      const mult = median > 0 ? (r.views / median).toFixed(1) : "?";
      const age = r.publishedAt ? fmtAge(r.publishedAt) : "unknown";
      return `- [${r.videoId}] "${r.title}" — ${r.competitorTitle ?? "(unknown)"} (${r.tier}) — ${mult}× median (${median.toLocaleString("en-US")} median, ${r.views.toLocaleString("en-US")} views) — ${age}`;
    }),
  ].join("\n");

  const model = providerModelId("claude");
  let ideas: Idea[] = [];
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: 2500,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const parsed = parseIdeas(text, new Set(outlierRows.map((r) => r.videoId)));
    if (!parsed || parsed.length === 0) {
      log.warn(
        "claude",
        `Outlier-ideas ${userChannelId}: could not parse ideas. Raw: ${text.slice(0, 200)}`
      );
      return {
        ok: false,
        status: 502,
        error: "AI returned malformed JSON. Try again.",
      };
    }
    ideas = parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Claude call failed";
    log.error("claude", `Outlier-ideas ${userChannelId}: ${msg}`, err);
    return { ok: false, status: 502, error: msg };
  }

  setSetting(rateKey, String(now));
  log.info(
    "claude",
    `Outlier-ideas ${userChannelId}: ${ideas.length} ideas (${outlierRows.length} outlier sample)`
  );

  return { ok: true, ideas, generatedAt: now, model };
}

function fmtAge(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

function parseIdeas(raw: string, knownIds: Set<string>): Idea[] | null {
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
  const rawIdeas = (parsed as { ideas?: unknown }).ideas;
  if (!Array.isArray(rawIdeas)) return null;
  const ideas: Idea[] = [];
  for (const raw of rawIdeas) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const topic = typeof r.topic === "string" ? r.topic.trim() : "";
    const suggestedTitle =
      typeof r.suggestedTitle === "string" ? r.suggestedTitle.trim() : "";
    const angle = typeof r.angle === "string" ? r.angle.trim() : "";
    const confidence =
      typeof r.confidence === "number"
        ? Math.max(0, Math.min(1, r.confidence))
        : 0;
    const sourceOutlierVideoId =
      typeof r.sourceOutlierVideoId === "string"
        ? r.sourceOutlierVideoId.trim()
        : "";
    if (
      !topic ||
      !suggestedTitle ||
      !isLever(angle) ||
      !sourceOutlierVideoId ||
      !knownIds.has(sourceOutlierVideoId)
    ) {
      continue;
    }
    ideas.push({ topic, suggestedTitle, angle, confidence, sourceOutlierVideoId });
  }
  return ideas;
}
