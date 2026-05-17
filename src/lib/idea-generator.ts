import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  competitorMedianViews,
  getCompetitorVideosByIds,
  getExampleVideosForFormat,
  getIntegration,
  listAllChannels,
} from "./db";
import { providerModelId } from "./ai-provider-types";
import {
  extractSection,
  isLever,
  LEVERS,
  loadMentorMethod,
} from "./mentor-method";
import { listOutliersForActiveChannel } from "./outliers";
import { getFormatsForChannel } from "./outlier-formats";
import { log } from "./logger";
import {
  validateIdeaAgainstOwnCatalog,
  type ValidateResult,
} from "./validate-idea";
import { scoreOriginality } from "./idea-originality";

// Ideation-only tightening (NOT a methodology change — MENTOR_METHOD §2
// stays at 2× as the outlier definition). Viral-topic pool uses ≥5× /
// 14d to surface what's working RIGHT NOW. Trending formats are pulled
// from the channel's extracted patterns (last 60d window) so the format
// slot structures are recent. The agent should never silently relax
// these — 409 with an explicit ask instead.
const VIRAL_MIN_MULTIPLIER = 5;
const VIRAL_WINDOW_DAYS = 14;
const VIRAL_LIMIT = 30;
const MIN_VIRAL_CANDIDATES = 3;

const FORMAT_MIN_EXAMPLES = 3;
const FORMAT_LIMIT = 6;
const MIN_FORMAT_CANDIDATES = 2;

// Originality guard. Thresholds live in idea-originality.ts (token-overlap
// ratio, shared-noun count, longest consecutive-word run — three independent
// gates). Up to MAX_RETRY_PASSES focused regenerate calls per flagged slot;
// surviving flagged slots are DROPPED rather than shipped. Dropping is the
// right tradeoff: better to return 3 strong ideas than 5 echoes.
const MAX_RETRY_PASSES = 3;

import {
  performanceBandFor,
  type PerformanceBand,
} from "./validate-idea";

export type ProposedIdea = {
  // Compatibility hedge: keep the singular sourceOutlierVideoId field
  // populated to the first entry of sourceTopicOutliers. Anything still
  // reading the old shape keeps working until we clean up.
  sourceOutlierVideoId: string;
  sourceFormat: {
    id: number;
    template: string;
    risingRate: number | null;
    exampleCount: number;
  };
  sourceTopicOutliers: Array<{
    videoId: string;
    title: string;
    multiplier: number;
    thumbnailUrl: string | null;
    competitorTitle: string | null;
    competitorHandle: string | null;
    performanceBand: PerformanceBand;
  }>;
  // Up to 2 OTHER outliers exemplifying the same format (excluding any id
  // in sourceTopicOutliers). Drives the "Other outliers in this format"
  // block in the agent's structured markdown output.
  otherFormatExamples: Array<{
    videoId: string;
    title: string;
    thumbnailUrl: string | null;
    multiplier: number;
    performanceBand: PerformanceBand;
  }>;
  topicLabel: string;
  proposedTitle: string;
  angle: string;
  confidence: number;
  originalityScore: number;
  validation: ValidateResult;
};

export type GenerateIdeasResult =
  | {
      ok: true;
      ideas: ProposedIdea[];
      generatedAt: number;
      model: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      retryAfterSec?: number;
    };

// Legacy alias — some external callers (if any) imported Idea by name.
export type Idea = ProposedIdea;

type ChannelCtx = {
  niche?: string;
  positioning?: string;
  audience?: string;
  voice?: string;
  external_sources?: string;
};

type FormatLite = {
  id: number;
  template: string;
  examples: number;
  risingRate: number | null;
  avgMultiplier: number | null;
};

type OutlierLite = {
  videoId: string;
  title: string;
  views: number;
  multiplier: number;
  thumbnailUrl: string | null;
  competitorTitle: string | null;
  competitorHandle: string | null;
  tier: string;
  publishedAt: number | null;
};

/**
 * Format × Topic ideation. Pipeline:
 *   1. Pull top trending formats (≥3 examples, last 60d, sorted by rising
 *      rate). These are the structural skeletons.
 *   2. Pull viral outliers (≥5× their channel median, last 14d). These
 *      are the topic raw material.
 *   3. One Claude call: cluster the outliers by topic theme, then for
 *      each top cluster pick the best-fit format and compose a NEW title
 *      applying the format's slot structure to the topic. Never mirror a
 *      source outlier's specific phrasing.
 *   4. Server-side originality scorer: token-overlap between each
 *      proposed title and every source outlier title in its cluster. If
 *      > MAX_OVERLAP, mark for regenerate. Up to MAX_RETRY_PASSES focused
 *      regenerate calls; surviving flagged slots are dropped.
 *   5. validateIdeaAgainstOwnCatalog per idea — same as before — so the
 *      chat agent gets ground-truth "you already covered this" data.
 *
 * No rate limit. The whole point of the new flow is iterating until the
 * user likes the slate.
 */
export async function generateIdeasForChannel(opts: {
  userChannelId: string;
  // Caller-supplied outliers bypass auto-pick and the ≥5× / 14d filter.
  outlierVideoIds?: string[];
  // Overrides — agent leaves undefined for the defaults. Wider-window
  // requires explicit user request per the operating rules.
  windowDays?: number;
  minMultiplier?: number;
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

  const now = Math.floor(Date.now() / 1000);
  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      error: "Claude API key not configured. Add it on the Integrations page.",
    };
  }

  // --- 1. Trending formats -------------------------------------------------
  const formats: FormatLite[] = getFormatsForChannel(userChannelId, 30)
    .filter((f) => f.examples.length >= FORMAT_MIN_EXAMPLES)
    .sort((a, b) => (b.risingRate ?? 0) - (a.risingRate ?? 0))
    .slice(0, FORMAT_LIMIT)
    .map((f) => ({
      id: f.id,
      template: f.template,
      examples: f.examples.length,
      risingRate: f.risingRate,
      avgMultiplier: f.avgMultiplier,
    }));

  if (formats.length < MIN_FORMAT_CANDIDATES) {
    return {
      ok: false,
      status: 409,
      error: `No trending formats available (need ≥${MIN_FORMAT_CANDIDATES} formats with ≥${FORMAT_MIN_EXAMPLES} examples each). Tell the user to run 'Re-extract trending formats' on the /outliers Trending Formats tab first, then retry.`,
    };
  }

  // --- 2. Viral outliers ---------------------------------------------------
  const viralWindow = opts.windowDays ?? VIRAL_WINDOW_DAYS;
  const viralMult = opts.minMultiplier ?? VIRAL_MIN_MULTIPLIER;
  let outlierLites: OutlierLite[] = [];
  let supplied = false;
  if (opts.outlierVideoIds && opts.outlierVideoIds.length > 0) {
    supplied = true;
    const rows = getCompetitorVideosByIds(opts.outlierVideoIds.slice(0, 30));
    // Hydrate multiplier per row using all-time competitor median (the
    // bookkeeping table used by the alert generator). Caller-supplied
    // IDs bypass the multiplier filter — we trust the caller's curation.
    const medians = new Map<number, number>();
    for (const cid of new Set(rows.map((r) => r.competitorId))) {
      medians.set(cid, competitorMedianViews(cid));
    }
    outlierLites = rows.map((r) => {
      const med = medians.get(r.competitorId) ?? 0;
      return {
        videoId: r.videoId,
        title: r.title,
        views: r.views,
        multiplier: med > 0 ? r.views / med : 0,
        thumbnailUrl: ytThumbnail(r.videoId),
        competitorTitle: r.competitorTitle,
        competitorHandle: r.competitorHandle ?? null,
        tier: r.tier,
        publishedAt: r.publishedAt,
      };
    });
  } else {
    const { outliers } = listOutliersForActiveChannel({
      userChannelId,
      windowDays: viralWindow as 7 | 30 | 60 | 90,
      minMultiplier: viralMult,
      limit: VIRAL_LIMIT,
    });
    outlierLites = outliers.map((o) => ({
      videoId: o.videoId,
      title: o.title,
      views: o.views,
      multiplier: o.multiplier,
      thumbnailUrl: o.thumbnailUrl ?? ytThumbnail(o.videoId),
      competitorTitle: o.competitorTitle,
      competitorHandle: o.competitorHandle ?? null,
      tier: o.tier,
      publishedAt: o.publishedAt,
    }));
    if (outlierLites.length < MIN_VIRAL_CANDIDATES) {
      return {
        ok: false,
        status: 409,
        error: `No strong outliers (≥${viralMult}×) in the last ${viralWindow} days — only ${outlierLites.length} candidate${outlierLites.length === 1 ? "" : "s"} pass${outlierLites.length === 1 ? "es" : ""}, need ≥${MIN_VIRAL_CANDIDATES}. Ask the user whether to widen the window or lower the multiplier; do NOT silently lower these thresholds.`,
      };
    }
  }
  if (outlierLites.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "No outliers available for this channel. Add competitors and sync first.",
    };
  }

  // --- 3. Claude call: cluster + compose ----------------------------------
  const md = loadMentorMethod();
  const sec1 = extractSection(md, 1);
  const sec4 = extractSection(md, 4);
  const sec7 = extractSection(md, 7);
  const sec9 = extractSection(md, 9);
  const ctx = channel as unknown as ChannelCtx;

  const systemPrompt = buildSystemPromptForCompose({
    sec1,
    sec4,
    sec7,
    sec9,
  });

  const userBody = buildUserBodyForCompose({
    ctx,
    formats,
    outliers: outlierLites,
    supplied,
  });

  const model = providerModelId("claude");
  let rawIdeas: RawComposedIdea[] = [];
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: 3000,
      temperature: 0.8,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const parsed = parseComposedIdeas(
      text,
      new Set(formats.map((f) => f.id)),
      new Set(outlierLites.map((o) => o.videoId))
    );
    if (!parsed || parsed.length === 0) {
      log.warn(
        "claude",
        `Outlier-ideas ${userChannelId}: could not parse ideas. Raw: ${text.slice(0, 240)}`
      );
      return {
        ok: false,
        status: 502,
        error: "AI returned malformed JSON. Try again.",
      };
    }
    rawIdeas = parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Claude call failed";
    log.error("claude", `Outlier-ideas ${userChannelId}: ${msg}`, err);
    return { ok: false, status: 502, error: msg };
  }

  // --- 4. Originality guard + regenerate passes ---------------------------
  const outlierByVideoId = new Map(outlierLites.map((o) => [o.videoId, o]));
  const formatById = new Map(formats.map((f) => [f.id, f]));

  type Annotated = RawComposedIdea & {
    sources: OutlierLite[];
    originalityScore: number;
    maxOverlap: number;
    sharedNouns: number;
    longestSharedRun: number;
    worstSourceTitle: string | null;
    flagged: boolean;
    flagReason: string | null;
  };
  const score = (idea: RawComposedIdea): Annotated => {
    const sources = idea.sourceTopicOutlierIds
      .map((id) => outlierByVideoId.get(id))
      .filter((x): x is OutlierLite => x !== undefined);
    const verdict = scoreOriginality(
      idea.proposedTitle,
      sources.map((s) => s.title)
    );
    return {
      ...idea,
      sources,
      originalityScore: verdict.originalityScore,
      maxOverlap: verdict.maxOverlap,
      sharedNouns: verdict.sharedNouns,
      longestSharedRun: verdict.longestSharedRun,
      worstSourceTitle:
        verdict.worstSourceIndex >= 0
          ? sources[verdict.worstSourceIndex]?.title ?? null
          : null,
      flagged: verdict.flagged,
      flagReason: verdict.reason,
    };
  };

  let annotated: Annotated[] = rawIdeas.map(score);

  for (let pass = 0; pass < MAX_RETRY_PASSES; pass++) {
    const flagged = annotated.filter((a) => a.flagged);
    if (flagged.length === 0) break;
    log.debug(
      "claude",
      `Outlier-ideas ${userChannelId}: regenerate pass ${pass + 1} — ${flagged.length} flagged (${flagged.map((f) => f.flagReason).join(",")})`
    );
    const regenBody = buildRegenerateBody(
      flagged.map((f) => ({
        topicLabel: f.topicLabel,
        sourceTopicOutlierIds: f.sourceTopicOutlierIds,
        sourceFormatId: f.sourceFormatId,
        proposedTitle: f.proposedTitle,
        originalityScore: f.originalityScore,
        maxOverlap: f.maxOverlap,
        sharedNouns: f.sharedNouns,
        longestSharedRun: f.longestSharedRun,
        worstSourceTitle: f.worstSourceTitle,
        flagReason: f.flagReason,
      })),
      formats
    );
    try {
      const client = new Anthropic({ apiKey });
      const resp = await client.messages.create({
        model,
        max_tokens: 1500,
        temperature: 0.9, // bump temp for novelty on the retry
        system: systemPrompt,
        messages: [{ role: "user", content: regenBody }],
      });
      const text = resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();
      const parsedRetry = parseRegenerated(text);
      if (!parsedRetry) {
        log.warn(
          "claude",
          `Outlier-ideas ${userChannelId}: regenerate pass ${pass + 1} returned malformed JSON; dropping flagged slots`
        );
        break;
      }
      // Replace flagged slots in-place by topicLabel match.
      const retryByLabel = new Map(parsedRetry.map((r) => [r.topicLabel, r]));
      annotated = annotated.map((a) => {
        if (!a.flagged) return a;
        const replacement = retryByLabel.get(a.topicLabel);
        if (!replacement) return a;
        const merged: RawComposedIdea = {
          ...a,
          proposedTitle: replacement.proposedTitle,
          angle: replacement.angle || a.angle,
          confidence: replacement.confidence ?? a.confidence,
        };
        return score(merged);
      });
    } catch (err) {
      log.warn(
        "claude",
        `Outlier-ideas ${userChannelId}: regenerate pass ${pass + 1} failed: ${err instanceof Error ? err.message : "?"}`
      );
      break;
    }
  }

  // Drop slots that still overlap too much after retries.
  const surviving = annotated.filter((a) => !a.flagged);

  // --- 5. Validate each surviving idea against own catalog + hydrate
  //        secondary citation block (otherFormatExamples) ----------------
  const ideas: ProposedIdea[] = surviving.map((a) => {
    const fmt = formatById.get(a.sourceFormatId);
    const validation = validateIdeaAgainstOwnCatalog({
      topic: a.topicLabel,
      userChannelId,
    });
    // Other outliers exemplifying THIS format, excluding any video that
    // already appears in the idea's sources (avoid duplicate citations).
    const sourceIds = new Set(a.sources.map((s) => s.videoId));
    const otherFormatExamples = getExampleVideosForFormat(a.sourceFormatId, 5)
      .filter((e) => !sourceIds.has(e.videoId))
      .slice(0, 2)
      .map((e) => {
        const m = Math.round((e.multiplierAtExtract || 0) * 10) / 10;
        return {
          videoId: e.videoId,
          title: e.title,
          thumbnailUrl: e.thumbnailUrl ?? ytThumbnail(e.videoId),
          multiplier: m,
          performanceBand: performanceBandFor(m),
        };
      });
    return {
      sourceOutlierVideoId: a.sources[0]?.videoId ?? "",
      sourceFormat: {
        id: a.sourceFormatId,
        template: fmt?.template ?? "(unknown)",
        risingRate: fmt?.risingRate ?? null,
        exampleCount: fmt?.examples ?? 0,
      },
      sourceTopicOutliers: a.sources.map((s) => {
        const m = Math.round(s.multiplier * 10) / 10;
        return {
          videoId: s.videoId,
          title: s.title,
          multiplier: m,
          thumbnailUrl: s.thumbnailUrl,
          competitorTitle: s.competitorTitle,
          competitorHandle: s.competitorHandle,
          performanceBand: performanceBandFor(m),
        };
      }),
      otherFormatExamples,
      topicLabel: a.topicLabel,
      proposedTitle: a.proposedTitle,
      angle: a.angle,
      confidence: a.confidence,
      originalityScore: Math.round(a.originalityScore * 100) / 100,
      validation,
    };
  });

  log.info(
    "claude",
    `Outlier-ideas ${userChannelId}: ${ideas.length} ideas (${formats.length} formats × ${outlierLites.length} viral outliers; ${annotated.length - surviving.length} dropped for overlap)`
  );

  return { ok: true, ideas, generatedAt: now, model };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSystemPromptForCompose(opts: {
  sec1: string;
  sec4: string;
  sec7: string;
  sec9: string;
}): string {
  return [
    "You compose NEW YouTube video titles by APPLYING trending title formats to currently-viral topics. The format is a structural skeleton; the topic is the subject. Your job is to glue them — never to paraphrase a source outlier's specific phrasing.",
    "",
    "Workflow (in order):",
    "1. Group the VIRAL OUTLIERS by topic theme. Same topic across multiple channels → ONE cluster. Two videos on the same topic with different angles still cluster together. Quality of clustering matters: a sloppy cluster makes a sloppy title.",
    "2. For each top cluster (pick the 5-8 strongest), select ONE format from TRENDING FORMATS that best fits the topic's natural structure.",
    "3. Compose ONE new title that fills the format's slots with the topic. The new title must NOT share significant phrasing with any source outlier in the cluster — apply the format anew, don't echo.",
    "4. Match the channel's voice — terse vs poetic, tabloid vs measured. Voice trumps style ties.",
    "",
    "From MENTOR_METHOD.md §1 (Competitor mapping — the B&S Method):",
    opts.sec1 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §4 (Title formats — structural patterns, not literal titles):",
    opts.sec4 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §7 (Ideation — synthesizing the inputs):",
    opts.sec7 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §9 (The \"what made it work\" lever taxonomy):",
    opts.sec9 || "(section unavailable)",
    "",
    `# Allowed angle values (use these exact strings)`,
    LEVERS.map((l) => `"${l}"`).join(", "),
    "",
    "# Hard rules",
    "- Output 5–8 ideas. Quality over quantity.",
    "- Each idea cites the SOURCE FORMAT (by id) and the SOURCE OUTLIER VIDEO IDS (up to 3) the topic cluster came from.",
    "- topicLabel is 4–8 words, the subject area, NOT the proposed title.",
    "- proposedTitle is YOUR composed title applying the format's slots to the topic. Never copy a source title's phrasing.",
    "- angle is one §9 lever — the dominant lever the source cluster leans on, applied through the format.",
    "- confidence (0.0–1.0): higher when (a) the format has many examples + high rising rate, (b) the topic cluster has multiple sources, (c) the topic naturally fits the channel's niche.",
    "- Authority + Breakthrough tier sources carry more weight than Adjacent + Far.",
    "",
    "Return ONLY a JSON object. No prose, no markdown, no code fence.",
    "Shape:",
    "{",
    '  "ideas": [',
    "    {",
    '      "topicLabel": string,',
    '      "sourceTopicOutlierIds": string[],',
    '      "sourceFormatId": number,',
    '      "proposedTitle": string,',
    '      "angle": string,',
    '      "confidence": number',
    "    }",
    "  ]",
    "}",
  ].join("\n");
}

function buildUserBodyForCompose(opts: {
  ctx: ChannelCtx;
  formats: FormatLite[];
  outliers: OutlierLite[];
  supplied: boolean;
}): string {
  const { ctx, formats, outliers, supplied } = opts;
  return [
    "# USER CHANNEL CONTEXT",
    `- Niche: ${ctx.niche || "(empty)"}`,
    `- Positioning: ${ctx.positioning || "(empty)"}`,
    `- Audience: ${ctx.audience || "(empty)"}`,
    `- Voice: ${ctx.voice || "(empty)"}`,
    `- External sources: ${ctx.external_sources || "(empty)"}`,
    "",
    `# TRENDING FORMATS (${formats.length}, ≥${FORMAT_MIN_EXAMPLES} examples, sorted by rising rate)`,
    ...formats.map(
      (f) =>
        `- [F-${f.id}] "${f.template}" — ${f.examples} examples — rising_rate=${(f.risingRate ?? 0).toFixed(2)}, avg_mult=${(f.avgMultiplier ?? 0).toFixed(1)}×`
    ),
    "",
    `# VIRAL OUTLIERS (${outliers.length}${supplied ? ", caller-supplied" : `, ≥${VIRAL_MIN_MULTIPLIER}× last ${VIRAL_WINDOW_DAYS}d`})`,
    ...outliers.map(
      (o) =>
        `- [${o.videoId}] "${o.title}" — ${o.competitorTitle ?? "(unknown)"} (${o.tier}) — ${o.multiplier.toFixed(1)}× median — ${o.views.toLocaleString("en-US")} views — ${o.publishedAt ? fmtAge(o.publishedAt) : "unknown"}`
    ),
  ].join("\n");
}

function buildRegenerateBody(
  flagged: Array<{
    topicLabel: string;
    sourceTopicOutlierIds: string[];
    sourceFormatId: number;
    proposedTitle: string;
    originalityScore: number;
    maxOverlap: number;
    sharedNouns: number;
    longestSharedRun: number;
    worstSourceTitle: string | null;
    flagReason: string | null;
  }>,
  formats: FormatLite[]
): string {
  const fmtById = new Map(formats.map((f) => [f.id, f]));
  return [
    "# FORCED RETRY — your previous titles echoed sources too closely",
    "",
    "These are forced retries. Your previous attempts mirrored source outlier phrasing instead of applying the format anew. Be AGGRESSIVE on novelty: the format is the skeleton, the topic is the subject, but the surface phrasing must NOT mirror any source title. For each entry below, generate a TRULY DIFFERENT title that applies the SAME format to the SAME topic but with:",
    "  - different subject phrasing,",
    "  - different verb choice,",
    "  - swap at least 2 content nouns for synonyms, related concepts, or oblique references.",
    "",
    "Examples of how to remix (illustrative — invent your own; do NOT reuse these literally):",
    "  • instead of \"CERN Just Detected Two Timelines\" → \"A CERN Detector Quietly Logged Something Impossible\"",
    "  • or → \"Two Timelines Appeared at CERN — and No One Will Discuss It\"",
    "  • instead of \"James Webb Found Galaxies That Shouldn't Exist\" → \"Webb's Deep Field Holds a Geometry That Breaks the Models\"",
    "  • or → \"There Are Galaxies in Webb's Data That Pre-Date the Universe\"",
    "",
    "Keep the same topicLabel and sourceFormatId. Return JSON ONLY:",
    "{",
    '  "regenerated": [',
    '    { "topicLabel": string, "proposedTitle": string, "angle": string, "confidence": number }',
    "  ]",
    "}",
    "",
    ...flagged.map((f) => {
      const fmt = fmtById.get(f.sourceFormatId);
      const reasonLabel =
        f.flagReason === "shared-run"
          ? `shared a ${f.longestSharedRun}-word run with a source`
          : f.flagReason === "shared-nouns"
            ? `shared ${f.sharedNouns} content nouns with a source`
            : `overlapped ${(f.maxOverlap * 100).toFixed(0)}% of tokens with a source`;
      return [
        `## ${f.topicLabel}`,
        `- Format [F-${f.sourceFormatId}]: "${fmt?.template ?? "(unknown)"}"`,
        `- BLOCKED previous attempt: "${f.proposedTitle}"`,
        `- Reason: ${reasonLabel} (originalityScore=${f.originalityScore.toFixed(2)}, maxOverlap=${f.maxOverlap.toFixed(2)}, sharedNouns=${f.sharedNouns}, longestSharedRun=${f.longestSharedRun})`,
        f.worstSourceTitle
          ? `- Closest source: "${f.worstSourceTitle}"`
          : `- Source ids: ${f.sourceTopicOutlierIds.join(", ")}`,
      ].join("\n");
    }),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type RawComposedIdea = {
  topicLabel: string;
  sourceTopicOutlierIds: string[];
  sourceFormatId: number;
  proposedTitle: string;
  angle: string;
  confidence: number;
};

function fmtAge(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

// YouTube's static thumbnail convention. Used when a row didn't carry an
// explicit thumbnail_url — every published video has /vi/<id>/mqdefault.jpg.
function ytThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

function parseJsonObject(raw: string): unknown {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseComposedIdeas(
  raw: string,
  knownFormatIds: Set<number>,
  knownVideoIds: Set<string>
): RawComposedIdea[] | null {
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const rawIdeas = (parsed as { ideas?: unknown }).ideas;
  if (!Array.isArray(rawIdeas)) return null;
  const out: RawComposedIdea[] = [];
  for (const r of rawIdeas) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const topicLabel =
      typeof o.topicLabel === "string" ? o.topicLabel.trim() : "";
    const proposedTitle =
      typeof o.proposedTitle === "string" ? o.proposedTitle.trim() : "";
    const angle = typeof o.angle === "string" ? o.angle.trim() : "";
    const confidence =
      typeof o.confidence === "number"
        ? Math.max(0, Math.min(1, o.confidence))
        : 0;
    const sourceFormatId =
      typeof o.sourceFormatId === "number" ? o.sourceFormatId : NaN;
    const sourceTopicOutlierIdsRaw = Array.isArray(o.sourceTopicOutlierIds)
      ? o.sourceTopicOutlierIds
          .filter((v): v is string => typeof v === "string")
          .slice(0, 3)
      : [];
    const sourceTopicOutlierIds = sourceTopicOutlierIdsRaw.filter((id) =>
      knownVideoIds.has(id)
    );
    if (
      !topicLabel ||
      !proposedTitle ||
      !isLever(angle) ||
      !Number.isFinite(sourceFormatId) ||
      !knownFormatIds.has(sourceFormatId) ||
      sourceTopicOutlierIds.length === 0
    ) {
      continue;
    }
    out.push({
      topicLabel,
      sourceTopicOutlierIds,
      sourceFormatId,
      proposedTitle,
      angle,
      confidence,
    });
  }
  return out.length > 0 ? out : null;
}

function parseRegenerated(
  raw: string
): Array<{
  topicLabel: string;
  proposedTitle: string;
  angle: string;
  confidence: number;
}> | null {
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const arr = (parsed as { regenerated?: unknown }).regenerated;
  if (!Array.isArray(arr)) return null;
  const out: Array<{
    topicLabel: string;
    proposedTitle: string;
    angle: string;
    confidence: number;
  }> = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const topicLabel =
      typeof o.topicLabel === "string" ? o.topicLabel.trim() : "";
    const proposedTitle =
      typeof o.proposedTitle === "string" ? o.proposedTitle.trim() : "";
    const angle = typeof o.angle === "string" ? o.angle.trim() : "";
    const confidence =
      typeof o.confidence === "number"
        ? Math.max(0, Math.min(1, o.confidence))
        : 0;
    if (!topicLabel || !proposedTitle) continue;
    out.push({ topicLabel, proposedTitle, angle, confidence });
  }
  return out;
}
