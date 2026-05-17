import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  getExampleVideosForFormat,
  getFormatWeeklyHistogram,
  getIntegration,
  getSetting,
  listFormatsForChannel,
  rebuildFormatVideoLinks,
  setSetting,
  upsertOutlierFormat,
  type OutlierFormat,
} from "./db";
import { providerModelId } from "./ai-provider-types";
import { extractSection, loadMentorMethod } from "./mentor-method";
import { listOutliersForActiveChannel } from "./outliers";
import { log } from "./logger";

const EXTRACT_RATE_LIMIT_SEC = 30 * 60; // 1 re-extract per channel per 30 min

export type ExtractResult =
  | {
      ok: true;
      formatsCreated: number;
      videosLinked: number;
      lastExtractedAt: number;
    }
  | { ok: false; status: number; error: string; retryAfterSec?: number };

/**
 * Extract title-format templates from the user channel's current top
 * outliers via Claude Sonnet 4.6, per MENTOR_METHOD §4 (formats are
 * structural patterns, not literal titles).
 *
 * Flow:
 *   1. Load up to 50 current outliers (the same set the Library tab
 *      shows) via listOutliersForActiveChannel.
 *   2. Send their titles to Claude in one batch with §4 + placeholder
 *      vocab + the 8–20 format target.
 *   3. For each format Claude returns: drop singletons, drop unknown
 *      video ids; compute metrics; upsert into outlier_formats + rebuild
 *      its link table with multiplier snapshots.
 *
 * Rate-limited to 1 call per channel per 30 min via the settings table.
 * Never throws — every error mode returns a structured `ok: false`.
 */
export async function extractFormatsFromOutliers(
  userChannelId: string
): Promise<ExtractResult> {
  const channelId = userChannelId?.trim();
  if (!channelId) {
    return { ok: false, status: 400, error: "userChannelId required" };
  }

  const rateKey = `outlier_formats.last_extract.${channelId}`;
  const last = Number(getSetting(rateKey) ?? "0");
  const now = Math.floor(Date.now() / 1000);
  if (last > 0 && now - last < EXTRACT_RATE_LIMIT_SEC) {
    return {
      ok: false,
      status: 429,
      error: "Format extraction is rate-limited per channel (1 per 30 min)",
      retryAfterSec: EXTRACT_RATE_LIMIT_SEC - (now - last),
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

  const { outliers } = listOutliersForActiveChannel({
    userChannelId: channelId,
    limit: 50,
  });
  if (outliers.length < 4) {
    return {
      ok: false,
      status: 400,
      error: `Not enough outliers to extract patterns (need ≥4, have ${outliers.length}). Sync more competitors or widen the window.`,
    };
  }

  const md = loadMentorMethod();
  const sec4 = extractSection(md, 4);
  const systemPrompt = [
    "You are extracting structural title-format templates from a batch of competitor outlier titles. Per MENTOR_METHOD.md §4, title formats are STRUCTURES (templates with placeholders), not literal titles. Multiple titles share the same format when they have the same structural skeleton, even if the specific topic, number, or subject differs.",
    "",
    "From MENTOR_METHOD.md §4 (Title formats — structural patterns, not literal titles):",
    sec4 || "(section unavailable)",
    "",
    "# Placeholder vocabulary (use SQUARE BRACKETS for every variable)",
    "Use simple, descriptive placeholder names. Prefer this vocabulary when applicable:",
    "[Place], [Person], [Topic], [Thing], [Adjective], [Number], [Duration], [Action], [Verb-ed], [Age], [Era], [Authority figure], [Consequence], [Quantity], [Subject].",
    "If a placeholder doesn't fit any of those, invent a new one — keep it ≤2 words, capitalised.",
    "",
    "# Rules",
    "1. Aim for 8–20 distinct formats from the batch. Quality over quantity — if only 6 are real, return 6.",
    "2. Each title maps to EXACTLY ONE format (best fit). Don't double-assign.",
    "3. A format must cover at least 2 titles. Singletons are noise — drop them.",
    "4. Templates should be reusable — they describe the *shape* of a successful title, not its content. \"I went to [Place]'s most [Adjective] [Thing]\" is a format; \"I went to Japan's most haunted shrine\" is not.",
    "5. Preserve the original casing convention of typical YouTube titles in the template (title case usually).",
    "",
    "Return ONLY a JSON object. No prose, no markdown, no code fence.",
    "Shape:",
    "{",
    '  "formats": [',
    "    {",
    '      "template": string,        // e.g. "I went to [Place]\'s most [Adjective] [Thing]"',
    '      "videoIds": string[]       // 2+ video IDs from the batch that fit this template',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  const userBody = [
    "# Outlier batch",
    ...outliers.map((o) => `- [${o.videoId}] ${o.title}`),
  ].join("\n");

  const model = providerModelId("claude");
  let raw: string;
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: 3000,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
    });
    raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Claude call failed";
    log.error("claude", `Format-extract ${channelId}: ${msg}`, err);
    return { ok: false, status: 502, error: msg };
  }

  // Parse + validate.
  const parsed = parseFormats(raw);
  if (!parsed || parsed.length === 0) {
    log.warn(
      "claude",
      `Format-extract ${channelId}: could not parse formats. Raw: ${raw.slice(0, 200)}`
    );
    return {
      ok: false,
      status: 502,
      error: "AI returned malformed JSON. Try again.",
    };
  }

  const knownIds = new Set(outliers.map((o) => o.videoId));
  const multByVideo = new Map(outliers.map((o) => [o.videoId, o.multiplier]));
  const viewsByVideo = new Map(outliers.map((o) => [o.videoId, o.views]));
  const publishedByVideo = new Map(
    outliers.map((o) => [o.videoId, o.publishedAt ?? 0])
  );

  let formatsCreated = 0;
  let videosLinked = 0;
  const nowMs = Date.now();
  const thirtyDaysAgo = Math.floor(nowMs / 1000) - 30 * 86400;
  const sevenDaysAgo = Math.floor(nowMs / 1000) - 7 * 86400;
  const fourteenDaysAgo = Math.floor(nowMs / 1000) - 14 * 86400;

  for (const f of parsed) {
    const validIds = f.videoIds.filter((id) => knownIds.has(id));
    if (validIds.length < 2) continue;

    const multipliers = validIds.map((id) => multByVideo.get(id) ?? 0);
    const avgMult =
      multipliers.length > 0
        ? Number(
            (
              multipliers.reduce((s, m) => s + m, 0) / multipliers.length
            ).toFixed(2)
          )
        : null;

    // total_views_month: SUM(views) for videos published in last 30d
    let totalViewsMonth = 0;
    for (const id of validIds) {
      const pub = publishedByVideo.get(id) ?? 0;
      if (pub >= thirtyDaysAgo) totalViewsMonth += viewsByVideo.get(id) ?? 0;
    }

    // rising_rate: recent / prev, capped at 30, 0/0 → 1, 0/x → 30
    let recent = 0;
    let prev = 0;
    for (const id of validIds) {
      const pub = publishedByVideo.get(id) ?? 0;
      if (pub >= sevenDaysAgo) recent++;
      else if (pub >= fourteenDaysAgo) prev++;
    }
    let risingRate: number;
    if (prev === 0 && recent === 0) risingRate = 1.0;
    else if (prev === 0) risingRate = 30.0;
    else risingRate = Math.min(30.0, recent / prev);

    const formatId = upsertOutlierFormat({
      userChannelId: channelId,
      template: f.template,
      avgMultiplier: avgMult,
      totalViewsMonth,
      risingRate: Number(risingRate.toFixed(2)),
      model,
    });
    if (formatId < 0) continue;

    rebuildFormatVideoLinks(
      formatId,
      validIds.map((id) => ({
        videoId: id,
        multiplierAtExtract: multByVideo.get(id) ?? 0,
      }))
    );
    formatsCreated++;
    videosLinked += validIds.length;
  }

  setSetting(rateKey, String(now));
  log.info(
    "claude",
    `Format-extract ${channelId}: ${formatsCreated} formats, ${videosLinked} video links, from ${outliers.length} outliers`
  );

  return {
    ok: true,
    formatsCreated,
    videosLinked,
    lastExtractedAt: now,
  };
}

/**
 * Read-facade for the Patterns tab + the list_format_patterns chat
 * tool. Hydrates each format with up to 5 example videos AND its
 * weekly chart histogram (videos count + avg multiplier per week, last
 * 10 weeks). Returns "" for charts when data is too sparse — the UI
 * renders a "not enough data" fallback below 4 buckets.
 */
export type FormatWithExamples = OutlierFormat & {
  examples: ReturnType<typeof getExampleVideosForFormat>;
  weekly: { weekIndex: number; n: number; avgMult: number }[];
};

export function getFormatsForChannel(
  userChannelId: string,
  limit = 50
): FormatWithExamples[] {
  const formats = listFormatsForChannel(userChannelId, limit);
  return formats.map((f) => ({
    ...f,
    examples: getExampleVideosForFormat(f.id, 5),
    weekly: getFormatWeeklyHistogram(f.id),
  }));
}

function parseFormats(
  raw: string
): Array<{ template: string; videoIds: string[] }> | null {
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
  const rawFormats = (parsed as { formats?: unknown }).formats;
  if (!Array.isArray(rawFormats)) return null;
  const out: Array<{ template: string; videoIds: string[] }> = [];
  for (const f of rawFormats) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const template = typeof r.template === "string" ? r.template.trim() : "";
    const videoIds = Array.isArray(r.videoIds)
      ? r.videoIds.filter((v): v is string => typeof v === "string")
      : [];
    if (template && videoIds.length >= 2) {
      out.push({ template, videoIds });
    }
  }
  return out;
}
