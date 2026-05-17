import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  getExampleVideosForFormat,
  getFormatWeeklyHistogram,
  getIntegration,
  listFormatsForChannel,
  rebuildFormatVideoLinks,
  upsertOutlierFormat,
  wipeFormatsForChannel,
  type OutlierFormat,
} from "./db";
import { providerModelId } from "./ai-provider-types";
import { extractSection, loadMentorMethod } from "./mentor-method";
import { listOutliersForActiveChannel } from "./outliers";
import { log } from "./logger";

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
 * No rate limit — re-extract is a user-triggered, cost-aware action.
 * If perf or cost becomes an issue we'll add real queueing.
 * Never throws — every error mode returns a structured `ok: false`.
 */
export async function extractFormatsFromOutliers(
  userChannelId: string
): Promise<ExtractResult> {
  const channelId = userChannelId?.trim();
  if (!channelId) {
    return { ok: false, status: 400, error: "userChannelId required" };
  }

  const now = Math.floor(Date.now() / 1000);
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
  const rawParsed = parseFormats(raw);
  if (!rawParsed || rawParsed.length === 0) {
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
  const titleByVideo = new Map(outliers.map((o) => [o.videoId, o.title]));
  const multByVideo = new Map(outliers.map((o) => [o.videoId, o.multiplier]));
  const viewsByVideo = new Map(outliers.map((o) => [o.videoId, o.views]));
  const publishedByVideo = new Map(
    outliers.map((o) => [o.videoId, o.publishedAt ?? 0])
  );

  // DEF-F1/F2/F3/F4: combined post-LLM validation pass.
  //   F3 — drop templates with <2 slot variables (no [X] markers).
  //   F2/F4 — per (template, example) grammar-fit: literal anchors must
  //          appear as whole words in the example; ≥60% of structural
  //          markers must appear in order. Misfit examples drop.
  //   F1 — cross-format dedup: each videoId can belong to at most one
  //          template (the one with highest fit score). Ties broken by
  //          earliest LLM-output index.
  // Final pruning: any template with <3 surviving examples is dropped
  // (raised from 2 — matches the trending-formats UI/chat-tool's
  // "proven" threshold).
  const parsed = validateAndDedupFormats(rawParsed, titleByVideo, knownIds);
  if (parsed.length === 0) {
    log.warn(
      "claude",
      `Format-extract ${channelId}: 0 templates survived dedup/validation. Raw: ${raw.slice(0, 200)}`
    );
    return {
      ok: false,
      status: 502,
      error: "Extracted templates failed validation (grammar/dedup). Try again.",
    };
  }

  // Re-extract is meant to be a clean slate: wipe the channel's prior
  // formats + their video links so stale entries from older runs (which
  // the new dedup pass would have removed) don't linger. Cascade through
  // outlier_format_videos via FK.
  const wipe = wipeFormatsForChannel(channelId);
  if (wipe.formatsDeleted > 0) {
    log.info(
      "claude",
      `Format-extract ${channelId}: wiped ${wipe.formatsDeleted} stale formats + ${wipe.linksDeleted} links before re-extract`
    );
  }

  let formatsCreated = 0;
  let videosLinked = 0;
  const nowMs = Date.now();
  const thirtyDaysAgo = Math.floor(nowMs / 1000) - 30 * 86400;
  const sevenDaysAgo = Math.floor(nowMs / 1000) - 7 * 86400;
  const fourteenDaysAgo = Math.floor(nowMs / 1000) - 14 * 86400;

  for (const f of parsed) {
    const validIds = f.videoIds.filter((id) => knownIds.has(id));
    // ≥3 raised from ≥2 to match the "proven" trending-formats threshold
    // surfaced in the UI + chat tool. Anything thinner is "emerging",
    // not proven, and shouldn't ship as a stored format row.
    if (validIds.length < 3) continue;

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

/**
 * Post-LLM validation + dedup for extracted formats. Four jobs:
 *
 *   DEF-F3 — drop any template with fewer than 2 [X] slot markers. The
 *            "James Webb Just Found What Scientists Were Afraid Of" kind
 *            of literal-string non-template gets caught here.
 *
 *   DEF-F2 — literal-anchor enforcement. Words outside [X] brackets that
 *            are ≥4 chars (e.g. "James", "Webb", "Detected") must appear
 *            as whole words in the example title. A "James Webb [Verb-ed]"
 *            template cannot accept a CERN example.
 *
 *   DEF-F4 — structural-marker order. Short connector words inside the
 *            template (Is, And, Has, About, From, etc.) must appear in
 *            the example in the same order. Cheap order-preserving cursor.
 *            ≥60% of markers must match.
 *
 *   DEF-F1 — cross-format dedup. After per-example fit pruning, each
 *            videoId belongs to AT MOST ONE template — the one with the
 *            highest fit score. Ties broken by LLM-output order (first
 *            wins, since the model usually returns its strongest match
 *            first when it duplicates).
 *
 * After all four passes, any template with fewer than 3 surviving
 * examples is dropped entirely (the "proven" threshold the trending-
 * formats UI + chat tool surface).
 */
function validateAndDedupFormats(
  parsed: Array<{ template: string; videoIds: string[] }>,
  titleByVideo: Map<string, string>,
  knownIds: Set<string>
): Array<{ template: string; videoIds: string[] }> {
  const slotCount = (template: string): number =>
    (template.match(/\[[^\]]+\]/g) || []).length;

  // Literal anchors: words OUTSIDE [X] brackets, length ≥4, lowercased.
  // Strip the bracket placeholders entirely before tokenizing.
  const literalAnchors = (template: string): string[] => {
    const withoutSlots = template.replace(/\[[^\]]+\]/g, " ");
    return withoutSlots
      .toLowerCase()
      .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4);
  };

  // Structural markers: short connector words OUTSIDE [X] brackets that
  // anchor sentence structure. Tracked for order, not just presence.
  const STRUCTURAL = new Set([
    "is", "are", "was", "were", "be", "been", "and", "or", "but",
    "of", "in", "on", "for", "to", "with", "as", "than", "then",
    "has", "have", "had", "does", "did", "do", "about", "from",
    "into", "over", "under", "after", "before", "by",
  ]);
  const structuralMarkers = (template: string): string[] => {
    const withoutSlots = template.replace(/\[[^\]]+\]/g, " ");
    return withoutSlots
      .toLowerCase()
      .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
      .split(/\s+/)
      .filter((w) => STRUCTURAL.has(w));
  };

  // Whole-word lookup on a title (lowercased).
  const titleHasWord = (titleLower: string, word: string): boolean => {
    // Escape regex metachars in word (defensive — shouldn't happen here).
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(titleLower);
  };

  // Order-preserving cursor: do the markers appear in the title in the
  // same order they appear in the template? Returns (matched, total).
  const markerOrderFit = (
    markers: string[],
    titleLower: string
  ): { matched: number; total: number } => {
    if (markers.length === 0) return { matched: 0, total: 0 };
    let cursor = 0;
    let matched = 0;
    for (const m of markers) {
      const re = new RegExp(`\\b${m}\\b`);
      const slice = titleLower.slice(cursor);
      const found = slice.search(re);
      if (found >= 0) {
        matched++;
        cursor += found + m.length;
      }
    }
    return { matched, total: markers.length };
  };

  // Fit score per (template, example). Higher = better fit. Used both
  // as the gate (literal anchors must ALL match) and as the dedup
  // tiebreaker (anchor-count + marker-fraction).
  type Fit = {
    pass: boolean;
    anchorHits: number;
    anchorTotal: number;
    markerFraction: number;
    score: number;
  };
  const fitFor = (template: string, title: string): Fit => {
    const titleLower = title.toLowerCase();
    const anchors = literalAnchors(template);
    let anchorHits = 0;
    for (const a of anchors) {
      if (titleHasWord(titleLower, a)) anchorHits++;
    }
    const allAnchorsMatch = anchors.length === 0 || anchorHits === anchors.length;
    const markers = structuralMarkers(template);
    const { matched, total } = markerOrderFit(markers, titleLower);
    const markerFraction = total === 0 ? 1 : matched / total;
    const pass = allAnchorsMatch && markerFraction >= 0.6;
    // Score for dedup tiebreaker: weight anchors more than markers.
    const score = anchorHits * 2 + markerFraction;
    return { pass, anchorHits, anchorTotal: anchors.length, markerFraction, score };
  };

  // --- DEF-F3 pass: drop zero-slot templates.
  const slotPassed = parsed.filter((f) => slotCount(f.template) >= 2);
  const droppedF3 = parsed.length - slotPassed.length;

  // --- DEF-F2 + DEF-F4 pass: per-example grammar fit. Build a parallel
  //     array of {template, examples:[{videoId, fit}]} so we can dedup
  //     by fit score in the next pass.
  type ExWithFit = { videoId: string; fit: Fit };
  type FmtWithFits = {
    template: string;
    llmIndex: number; // position in original LLM output (tiebreaker)
    examples: ExWithFit[];
  };
  const fitsByFormat: FmtWithFits[] = slotPassed.map((f, i) => {
    const examples: ExWithFit[] = [];
    for (const vid of f.videoIds) {
      if (!knownIds.has(vid)) continue;
      const title = titleByVideo.get(vid);
      if (!title) continue;
      const fit = fitFor(f.template, title);
      if (!fit.pass) continue;
      examples.push({ videoId: vid, fit });
    }
    return { template: f.template, llmIndex: i, examples };
  });

  // --- DEF-F1 pass: cross-format dedup. For each videoId, pick the
  //     format-index with the highest fit score; remove from others.
  const bestByVideo = new Map<string, { fmtIdx: number; score: number; llmIdx: number }>();
  for (let i = 0; i < fitsByFormat.length; i++) {
    for (const ex of fitsByFormat[i].examples) {
      const prev = bestByVideo.get(ex.videoId);
      const cand = {
        fmtIdx: i,
        score: ex.fit.score,
        llmIdx: fitsByFormat[i].llmIndex,
      };
      const winner =
        !prev ||
        cand.score > prev.score ||
        (cand.score === prev.score && cand.llmIdx < prev.llmIdx)
          ? cand
          : prev;
      bestByVideo.set(ex.videoId, winner);
    }
  }
  for (let i = 0; i < fitsByFormat.length; i++) {
    fitsByFormat[i].examples = fitsByFormat[i].examples.filter(
      (ex) => bestByVideo.get(ex.videoId)?.fmtIdx === i
    );
  }

  // --- Final size gate: ≥3 examples per template after all the above.
  const final = fitsByFormat.filter((f) => f.examples.length >= 3);
  const droppedSizeAfter = fitsByFormat.length - final.length;

  log.info(
    "claude",
    `Format-validate: ${parsed.length} → ${slotPassed.length} (after F3) → ${final.length} survived (F1 dedup + ≥3 examples). F3 dropped ${droppedF3}, final size cut ${droppedSizeAfter}.`
  );

  return final.map((f) => ({
    template: f.template,
    videoIds: f.examples.map((e) => e.videoId),
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
