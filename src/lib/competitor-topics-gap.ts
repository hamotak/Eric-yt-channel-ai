import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  COMPETITOR_TIERS,
  db,
  getChannel,
  getIntegration,
  getSetting,
  outliersForUserChannel,
  setSetting,
} from "./db";
import { providerModelId } from "./ai-provider-types";
import { extractSection, loadMentorMethod } from "./mentor-method";
import { log } from "./logger";

const CACHE_TTL_SEC = 4 * 60 * 60; // 4 hours per active channel

export type TopicGap = {
  topic: string;
  exampleCompetitorVideoIds: string[];
  avgMultiplier: number;
  totalViews: number;
  reason: string;
};

export type TopicsGapResult =
  | {
      ok: true;
      userChannelId: string;
      gaps: TopicGap[];
      cached: boolean;
      generatedAt: number;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

type CachePayload = {
  generatedAt: number;
  gaps: TopicGap[];
};

function cacheKey(userChannelId: string): string {
  return `competitor_topics_gap.cache.${userChannelId}`;
}

function readCache(userChannelId: string): CachePayload | null {
  const raw = getSetting(cacheKey(userChannelId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachePayload;
    if (
      typeof parsed?.generatedAt !== "number" ||
      !Array.isArray(parsed.gaps)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(userChannelId: string, payload: CachePayload): void {
  setSetting(cacheKey(userChannelId), JSON.stringify(payload));
}

/**
 * AI Topics Gap analysis grounded in MENTOR_METHOD §4 (title formats are
 * structural, NOT topics — this endpoint is about TOPICS specifically).
 * Cached for 4h per user channel. Replaces the legacy word-frequency
 * /api/competitors/gaps endpoint at the page level. The chat tool still
 * uses competitorGapAnalysis() in db.ts for keyword-level reasoning —
 * different lens, different surface.
 *
 * Inputs:
 *   - competitor outliers (≥3× their channel median, last 60d)
 *   - the user's own video catalogue titles (last 60d)
 *
 * Output: 5-15 topic gaps with example competitor video ids + reasoning.
 */
export async function competitorTopicsGap(opts: {
  userChannelId: string;
  refresh?: boolean;
}): Promise<TopicsGapResult> {
  const { userChannelId } = opts;
  if (!userChannelId) {
    return { ok: false, status: 400, error: "userChannelId required" };
  }

  if (!opts.refresh) {
    const cached = readCache(userChannelId);
    if (cached && Date.now() / 1000 - cached.generatedAt < CACHE_TTL_SEC) {
      return {
        ok: true,
        userChannelId,
        gaps: cached.gaps,
        cached: true,
        generatedAt: cached.generatedAt,
      };
    }
  }

  const channel = getChannel(userChannelId);
  if (!channel) {
    return { ok: false, status: 404, error: "user channel not found" };
  }

  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      error: "Claude API key not configured. Add it on the Integrations page.",
    };
  }

  // Competitor outliers — last 60 days, ≥3× their median, all tiers.
  const { outliers } = outliersForUserChannel({
    userChannelId,
    windowDays: 60,
    minMultiplier: 3,
    tiers: [...COMPETITOR_TIERS],
    limit: 60,
  });
  if (outliers.length === 0) {
    return {
      ok: false,
      status: 409,
      error:
        "No competitor outliers in the last 60 days. Add competitors and sync first.",
    };
  }

  // User's own videos (last 60d, titles only). Direct SQL against the
  // shared db connection — no dedicated helper because every other reader
  // of this table wants the full Video record.
  const userVideos = db
    .prepare(
      `SELECT title, views FROM videos
       WHERE channel_id = ?
         AND published_at IS NOT NULL
         AND published_at >= strftime('%s','now') - 60 * 86400
       ORDER BY views DESC
       LIMIT 100`
    )
    .all(userChannelId) as Array<{ title: string; views: number | null }>;

  const md = loadMentorMethod();
  const sec4 = extractSection(md, 4);

  const systemPrompt = [
    "You are identifying TOPIC-LEVEL gaps between a creator's catalogue and their competitors' outliers — what topics are working for competitors that the user hasn't covered yet. Topics are subject areas (e.g. \"James Webb early-universe galaxies\", \"Voyager interstellar mission updates\"), NOT keywords or single words.",
    "",
    "From MENTOR_METHOD.md §4 (Title formats — structural patterns, not literal titles):",
    sec4 || "(section unavailable)",
    "",
    "Topic-level analysis IS different from format-level analysis. Formats are how you say it (the §4 templates). Topics are what you say it about. Two videos can share a topic with different formats; two videos can share a format with different topics. THIS endpoint is about topics.",
    "",
    "# Rules",
    "1. Group competitor outliers by topic. A topic is a subject area, not a phrase. \"James Webb shows galaxies that shouldn't exist\" and \"Hubble vs JWST on the early universe\" → same topic (\"early-universe JWST findings\").",
    "2. A topic is a GAP only if (a) ≥ 2 competitor outliers cover it AND (b) NONE of the user's videos covers it.",
    "3. Rank gaps by aggregate competitor multiplier × view count. Drop topics where the only competitor outlier is from a Far-tier channel (per §1) — those signals are too weak for direct reuse.",
    "4. Return 5-15 gaps. Quality over quantity.",
    "",
    "Return ONLY a JSON object. No prose, no markdown, no code fence.",
    "Shape:",
    "{",
    '  "gaps": [',
    "    {",
    '      "topic": string,                            // 4-8 word topic label',
    '      "exampleCompetitorVideoIds": string[],      // up to 3 source competitor outlier ids',
    '      "avgMultiplier": number,                    // avg across the source outliers',
    '      "totalViews": number,                       // sum of the source outliers\' views',
    '      "reason": string                            // 1 sentence on WHY this topic is performing',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  const userBody = [
    "# COMPETITOR OUTLIERS (last 60 days)",
    ...outliers.map(
      (o) =>
        `- [${o.videoId}] "${o.title}" — ${o.competitorTitle ?? o.competitorHandle ?? "?"} (${o.tier}) — ${o.multiplier.toFixed(1)}× median (median ${o.channelMedian.toLocaleString("en-US")} views, total ${o.views.toLocaleString("en-US")})`
    ),
    "",
    "# USER VIDEOS (last 60 days)",
    userVideos.length > 0
      ? userVideos.map((v) => `- "${v.title}" — ${v.views?.toLocaleString("en-US") ?? "?"}`).join("\n")
      : "(no user videos in the last 60 days)",
  ].join("\n");

  const model = providerModelId("claude");
  let gaps: TopicGap[] = [];
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: 2000,
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const parsed = parseGaps(text);
    if (!parsed) {
      log.warn(
        "claude",
        `Topics-gap ${userChannelId}: malformed JSON. Raw: ${text.slice(0, 300)}`
      );
      return {
        ok: false,
        status: 502,
        error: "AI returned malformed JSON. Try again.",
      };
    }
    gaps = parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Claude call failed";
    log.error("claude", `Topics-gap ${userChannelId}: ${msg}`, err);
    return { ok: false, status: 502, error: msg };
  }

  const now = Math.floor(Date.now() / 1000);
  writeCache(userChannelId, { generatedAt: now, gaps });
  log.info(
    "claude",
    `Topics-gap ${userChannelId}: ${gaps.length} gaps cached for 4h`
  );

  return {
    ok: true,
    userChannelId,
    gaps,
    cached: false,
    generatedAt: now,
  };
}

function parseGaps(raw: string): TopicGap[] | null {
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
  const rawGaps = Array.isArray(obj.gaps) ? obj.gaps : [];
  const gaps: TopicGap[] = [];
  for (const g of rawGaps) {
    if (!g || typeof g !== "object") continue;
    const o = g as Record<string, unknown>;
    const topic = typeof o.topic === "string" ? o.topic.trim() : "";
    const ids = Array.isArray(o.exampleCompetitorVideoIds)
      ? o.exampleCompetitorVideoIds.filter((v): v is string => typeof v === "string").slice(0, 3)
      : [];
    const avgMultiplier =
      typeof o.avgMultiplier === "number" ? o.avgMultiplier : Number(o.avgMultiplier);
    const totalViews =
      typeof o.totalViews === "number" ? o.totalViews : Number(o.totalViews);
    const reason = typeof o.reason === "string" ? o.reason.trim() : "";
    if (!topic || ids.length === 0 || !reason) continue;
    gaps.push({
      topic,
      exampleCompetitorVideoIds: ids,
      avgMultiplier: Number.isFinite(avgMultiplier) ? avgMultiplier : 0,
      totalViews: Number.isFinite(totalViews) ? totalViews : 0,
      reason,
    });
  }
  return gaps.length > 0 ? gaps : null;
}
