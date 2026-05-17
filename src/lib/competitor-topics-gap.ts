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

const CACHE_TTL_SEC = 4 * 60 * 60; // 4 hours per (channel, window)

// Allowed windows for the Gaps pill row on /outliers. null = no time filter.
export type GapsWindowDays = 14 | 30 | 90 | null;
export const GAPS_WINDOWS: readonly GapsWindowDays[] = [14, 30, 90, null];

function windowSlug(w: GapsWindowDays): string {
  return w === null ? "all" : `w${w}`;
}

function windowLabel(w: GapsWindowDays): string {
  return w === null ? "all time" : `${w} days`;
}

// outliersForUserChannel requires a numeric windowDays. For "all" we
// pass a value generous enough to cover everything we'd realistically
// hold in competitor_videos (Apify pulls cap at 50 per channel, so
// 365 days easily contains the entire catalogue).
function effectiveWindowDays(w: GapsWindowDays): number {
  return w === null ? 365 : w;
}

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
      /**
       * Set when caller passed cacheOnly:true and no fresh cache existed.
       * The client uses this to distinguish "click Generate" (no cache)
       * from "we generated and there were zero qualifying topics".
       */
      cacheMiss?: boolean;
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

// Cache key includes the window so each (channel, window) pair keeps
// its own 4h-fresh cache. Pre-windowed keys from earlier builds
// (`competitor_topics_gap.cache.${userChannelId}` with no suffix) become
// orphans — harmless; they expire on TTL and no logic walks the key space.
function cacheKey(userChannelId: string, windowDays: GapsWindowDays): string {
  return `competitor_topics_gap.cache.${userChannelId}.${windowSlug(windowDays)}`;
}

function readCache(
  userChannelId: string,
  windowDays: GapsWindowDays
): CachePayload | null {
  const raw = getSetting(cacheKey(userChannelId, windowDays));
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

function writeCache(
  userChannelId: string,
  windowDays: GapsWindowDays,
  payload: CachePayload
): void {
  setSetting(cacheKey(userChannelId, windowDays), JSON.stringify(payload));
}

/**
 * AI Topics Gap analysis grounded in MENTOR_METHOD §4 (title formats are
 * structural, NOT topics — this endpoint is about TOPICS specifically).
 * Cached for 4h per (user channel, window). The chat tool still uses
 * competitorGapAnalysis() in db.ts for keyword-level reasoning —
 * different lens, different surface.
 *
 * Inputs:
 *   - competitor outliers (≥2× their channel median, within `windowDays`)
 *   - the user's own video catalogue titles (within `windowDays`)
 *
 * `windowDays` defaults to 14 — surfaces what's CURRENTLY working,
 * not what worked a quarter ago. Pass null for "all time".
 *
 * Output: 5-15 topic gaps with example competitor video ids + reasoning.
 */
export async function competitorTopicsGap(opts: {
  userChannelId: string;
  refresh?: boolean;
  windowDays?: GapsWindowDays;
  /**
   * When true: return the fresh cache if one exists; otherwise return a
   * cacheMiss result WITHOUT calling Claude. The TopicsGap tab uses this
   * mode on tab/window mount so opening the tab never auto-generates.
   * Mutually exclusive with refresh — refresh wins if both are set
   * (refresh is the explicit Generate-button path).
   */
  cacheOnly?: boolean;
}): Promise<TopicsGapResult> {
  const { userChannelId } = opts;
  if (!userChannelId) {
    return { ok: false, status: 400, error: "userChannelId required" };
  }
  const windowDays: GapsWindowDays = opts.windowDays ?? 14;
  const cacheOnly = opts.cacheOnly === true && opts.refresh !== true;

  if (!opts.refresh) {
    const cached = readCache(userChannelId, windowDays);
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

  // Cache-only mode: never calls Claude. Returns an empty result tagged
  // cacheMiss:true so the client can render the "Click Generate" state.
  if (cacheOnly) {
    return {
      ok: true,
      userChannelId,
      gaps: [],
      cached: false,
      generatedAt: 0,
      cacheMiss: true,
    };
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

  // Competitor outliers — within the chosen window, ≥2× their median,
  // all tiers (per MENTOR_METHOD §2). Null window uses a generous numeric
  // bound that effectively covers the whole catalogue.
  const { outliers } = outliersForUserChannel({
    userChannelId,
    windowDays: effectiveWindowDays(windowDays),
    minMultiplier: 2,
    tiers: [...COMPETITOR_TIERS],
    limit: 60,
  });
  if (outliers.length === 0) {
    return {
      ok: false,
      status: 409,
      error: `No competitor outliers in the last ${windowLabel(windowDays)}. Add competitors and sync first, or widen the window.`,
    };
  }

  // User's own videos (titles only) within the same window. Direct SQL
  // against the shared db connection — no dedicated helper because every
  // other reader of this table wants the full Video record.
  // null window drops the time filter so the comparison sees the user's
  // whole catalogue.
  const userVideos =
    windowDays === null
      ? (db
          .prepare(
            `SELECT title, views FROM videos
             WHERE channel_id = ?
               AND published_at IS NOT NULL
             ORDER BY views DESC
             LIMIT 100`
          )
          .all(userChannelId) as Array<{ title: string; views: number | null }>)
      : (db
          .prepare(
            `SELECT title, views FROM videos
             WHERE channel_id = ?
               AND published_at IS NOT NULL
               AND published_at >= strftime('%s','now') - ? * 86400
             ORDER BY views DESC
             LIMIT 100`
          )
          .all(userChannelId, windowDays) as Array<{
          title: string;
          views: number | null;
        }>);

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

  const windowHeader = `(last ${windowLabel(windowDays)})`;
  const userBody = [
    `# COMPETITOR OUTLIERS ${windowHeader}`,
    ...outliers.map(
      (o) =>
        `- [${o.videoId}] "${o.title}" — ${o.competitorTitle ?? o.competitorHandle ?? "?"} (${o.tier}) — ${o.multiplier.toFixed(1)}× median (median ${o.channelMedian.toLocaleString("en-US")} views, total ${o.views.toLocaleString("en-US")})`
    ),
    "",
    `# USER VIDEOS ${windowHeader}`,
    userVideos.length > 0
      ? userVideos.map((v) => `- "${v.title}" — ${v.views?.toLocaleString("en-US") ?? "?"}`).join("\n")
      : `(no user videos in the last ${windowLabel(windowDays)})`,
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
  writeCache(userChannelId, windowDays, { generatedAt: now, gaps });
  log.info(
    "claude",
    `Topics-gap ${userChannelId} ${windowSlug(windowDays)}: ${gaps.length} gaps cached for 4h`
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
