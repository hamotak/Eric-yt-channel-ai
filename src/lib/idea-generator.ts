import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  competitorMedianViews,
  getCompetitorVideosByIds,
  getExampleVideosForFormat,
  getIntegration,
  listAllChannels,
  listChannelMemory,
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
  checkTopicFrequency,
  type TopicFrequencyResult,
  validateIdeaAgainstOwnCatalog,
  type ValidateResult,
} from "./validate-idea";
import { scoreOriginality } from "./idea-originality";

// Drop reasons accumulated server-side during the post-LLM pass. Returned
// to the chat tool so the agent's "Skipped" research-block bullet can
// surface what got filtered + why. Visibility = trust.
export type DroppedIdea = {
  topicLabel: string;
  proposedTitle: string;
  reason:
    | "title_too_long"
    | "title_too_short"
    | "banned_word"
    | "banned_topic"
    | "topic_overused"
    | "originality";
  detail?: string;
};

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

// Default ideation slate size after all filters (length, banned words,
// banned topics, topic frequency, originality). We over-fetch from the
// LLM to absorb the drop cascade — see OVER_FETCH_CLUSTERS.
const MAX_IDEAS = 10;
// Ask the LLM for this many candidate clusters so the post-pass has room
// to drop weak slots without leaving the user with 4 ideas. 12 keeps
// the compose call within the 12k max_tokens budget below.
const OVER_FETCH_CLUSTERS = 12;

// Title-length contract (T1). Proposed titles land in one of three
// bands; only "ideal" + "acceptable" survive, anything over 100 chars
// drops outright after one regenerate attempt.
const TITLE_LEN_IDEAL_MIN = 50;
const TITLE_LEN_IDEAL_MAX = 70;
const TITLE_LEN_HARD_MAX = 80;
const TITLE_LEN_RETRY_MAX = 100;
const TITLE_LEN_DROP_FLOOR = 35; // anything <35 chars is also dropped

// Banned-words contract (T2). Single regex catches all 11 banned terms
// listed in operating rule 13. `\b` word boundaries handle multi-word
// phrases (the inner space is matched literally; boundaries land at
// the outer letter↔non-letter transitions). Any match forces regenerate
// (max 1 retry) or drop.
const BANNED_WORDS_RE =
  /(\bcinematic\b|\bsensory\b|\bvisceral\b|\bprofound\b|\bdesolate expanse\b|\bhumanity has ever charted\b|\bhumanity has ever mapped\b|\binexorable\b|\bvastest\b|\bthe most absolute\b|\bphysically impossible\b)/i;

// Originality guard. Thresholds live in idea-originality.ts (token-overlap
// ratio, shared-noun count, longest consecutive-word run — three independent
// gates). Up to MAX_RETRY_PASSES focused regenerate calls per flagged slot;
// surviving flagged slots are DROPPED rather than shipped. Dropping is the
// right tradeoff: better to return 3 strong ideas than 5 echoes.
const MAX_RETRY_PASSES = 3;

// Extended-thinking budget for the format×topic compose call. Sonnet 4.6
// supports thinking natively. Ideation benefits more from reasoning than a
// chat turn does (clustering outliers, picking the right format, composing
// a novel title that survives the originality guard) — so the default is
// fatter than the chat budget. Override via env if needed.
const IDEATION_THINKING_BUDGET: number = (() => {
  const raw = Number(process.env.ANTHROPIC_THINKING_BUDGET_IDEATION);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6000;
})();
// Retries do less work (a handful of titles, not the whole slate) — half
// budget keeps cost in check across up to MAX_RETRY_PASSES passes.
const IDEATION_RETRY_THINKING_BUDGET = Math.max(
  1024,
  Math.floor(IDEATION_THINKING_BUDGET / 2)
);

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
  // T1: which length band this title sits in. Both "ideal" and "acceptable"
  // ship; "rejected" is filtered out of the surviving slate (kept on the
  // dropped-ideas accumulator so the agent's Skipped section can report it).
  titleLengthBand: "ideal" | "acceptable" | "rejected";
  // T4: own-catalog frequency check. matches=N means the topic overlaps
  // N of the channel's last 20 uploads. overused=true (≥2 matches)
  // drops the slot; surviving ideas always have overused=false.
  topicFrequencyCheck: {
    matches: number;
    matchedVideos: TopicFrequencyResult["matchedVideos"];
  };
};

export type GenerateIdeasResult =
  | {
      ok: true;
      ideas: ProposedIdea[];
      // What was filtered out and why. The chat agent surfaces this in
      // the pre-ideation research block's "Skipped" line so the user
      // sees the cost of the guardrails (not just the survivors).
      dropped: DroppedIdea[];
      // The per-channel banned-topics list as parsed from channel_memory.
      // Drives the "Skipped" line's banned-topic explanation.
      bannedTopics: string[];
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

  // T5: per-channel banned topics from channel_memory. Parsed at the top
  // of the call so we can (a) inject them into the compose prompt as an
  // explicit NEVER-propose constraint, (b) drop any cluster whose
  // topicLabel or proposedTitle matches a banned term as substring.
  const bannedTopics = readBannedTopics(userChannelId);

  const systemPrompt = buildSystemPromptForCompose({
    sec1,
    sec4,
    sec7,
    sec9,
    bannedTopics,
  });

  const userBody = buildUserBodyForCompose({
    ctx,
    formats,
    outliers: outlierLites,
    supplied,
    bannedTopics,
  });

  const model = providerModelId("claude");
  let rawIdeas: RawComposedIdea[] = [];
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      // 12k = 6k thinking + ~6k for the JSON output. Bumped from 8000
      // when the default slate grew to 10 ideas (T3) + 12-cluster
      // over-fetch — at ~300 output tokens per cluster the previous
      // 2k headroom over thinking would overflow.
      max_tokens: 12000,
      // Extended thinking REQUIRES temperature=1 (the default). Setting
      // any other value returns 400 "thinking.* requires temperature=1".
      // We previously ran at 0.8 for tighter outputs; we trade that off
      // for the reasoning quality thinking delivers.
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
      thinking: {
        type: "enabled",
        budget_tokens: IDEATION_THINKING_BUDGET,
      },
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

  // Accumulator for every slot the post-LLM pass drops. The chat agent
  // surfaces this in the "Skipped" line of the pre-ideation research
  // block so the user sees the guardrails' cost, not just survivors.
  const dropped: DroppedIdea[] = [];

  // --- Pre-originality filters (T1 length, T2 banned words, T5 banned
  //     topics, T4 topic frequency). Banned-topic + topic-frequency are
  //     hard drops; length + banned-words allow one regenerate pass via
  //     the existing originality retry loop (flagReason markers).
  type PreFilterResult = {
    surviving: RawComposedIdea[];
    titleRetry: Array<RawComposedIdea & { reason: "title_too_long" | "banned_word"; detail: string }>;
    topicFrequency: Map<string, TopicFrequencyResult>;
  };
  const prefilter = ((): PreFilterResult => {
    const surviving: RawComposedIdea[] = [];
    const titleRetry: PreFilterResult["titleRetry"] = [];
    const topicFrequency = new Map<string, TopicFrequencyResult>();

    for (const idea of rawIdeas) {
      // T5: banned topics (substring match on topicLabel + proposedTitle).
      const bannedHit = bannedTopicMatch(
        idea.topicLabel,
        idea.proposedTitle,
        bannedTopics
      );
      if (bannedHit) {
        dropped.push({
          topicLabel: idea.topicLabel,
          proposedTitle: idea.proposedTitle,
          reason: "banned_topic",
          detail: `matched banned term "${bannedHit}"`,
        });
        continue;
      }

      // T4: topic frequency (≥2 matching titles in last 20 own-channel
      // uploads). Cache the result so survivors can carry it through.
      const freq = checkTopicFrequency(idea.topicLabel, userChannelId, 20);
      topicFrequency.set(idea.topicLabel, freq);
      if (freq.overused) {
        dropped.push({
          topicLabel: idea.topicLabel,
          proposedTitle: idea.proposedTitle,
          reason: "topic_overused",
          detail: `${freq.matches} of your last 20 uploads cover this`,
        });
        continue;
      }

      // T1: title length. Reject < floor or > retry-max outright;
      // 81-100 chars → one regenerate via the existing retry loop;
      // 50-80 chars → ship.
      const band = titleLengthBandFor(idea.proposedTitle);
      if (band === "rejected") {
        dropped.push({
          topicLabel: idea.topicLabel,
          proposedTitle: idea.proposedTitle,
          reason:
            idea.proposedTitle.length < TITLE_LEN_DROP_FLOOR
              ? "title_too_short"
              : "title_too_long",
          detail: `${idea.proposedTitle.length} chars`,
        });
        continue;
      }
      if (band === "too_long") {
        titleRetry.push({
          ...idea,
          reason: "title_too_long",
          detail: `${idea.proposedTitle.length} chars > ${TITLE_LEN_HARD_MAX} hard ceiling`,
        });
        continue;
      }

      // T2: banned words. Single regen attempt — if it sneaks back, drop.
      const bannedWord = bannedWordMatch(idea.proposedTitle);
      if (bannedWord) {
        titleRetry.push({
          ...idea,
          reason: "banned_word",
          detail: `contains banned term "${bannedWord}"`,
        });
        continue;
      }

      surviving.push(idea);
    }
    return { surviving, titleRetry, topicFrequency };
  })();

  let annotated: Annotated[] = prefilter.surviving.map(score);

  // Run the title-length / banned-word regenerate pass through the same
  // originality retry plumbing — mark slots flagged with the appropriate
  // reason so buildRegenerateBody can emit a custom remix instruction.
  // After this single forced retry, anything still failing length or
  // banned-words is moved to `dropped` and not retried again.
  if (prefilter.titleRetry.length > 0) {
    log.debug(
      "claude",
      `Outlier-ideas ${userChannelId}: title/banned-word regenerate — ${prefilter.titleRetry.length} slots`
    );
    const titleRegenBody = buildTitleRetryBody(prefilter.titleRetry, formats);
    try {
      const client = new Anthropic({ apiKey });
      const resp = await client.messages.create({
        model,
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: "user", content: titleRegenBody }],
        thinking: {
          type: "enabled",
          budget_tokens: IDEATION_RETRY_THINKING_BUDGET,
        },
      });
      const text = resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();
      const parsedRetry = parseRegenerated(text);
      if (parsedRetry) {
        const retryByLabel = new Map(parsedRetry.map((r) => [r.topicLabel, r]));
        for (const f of prefilter.titleRetry) {
          const replacement = retryByLabel.get(f.topicLabel);
          if (!replacement) {
            dropped.push({
              topicLabel: f.topicLabel,
              proposedTitle: f.proposedTitle,
              reason: f.reason,
              detail: `${f.detail}; retry produced no replacement`,
            });
            continue;
          }
          const merged: RawComposedIdea = {
            ...f,
            proposedTitle: replacement.proposedTitle,
            angle: replacement.angle || f.angle,
            confidence: replacement.confidence ?? f.confidence,
          };
          // Re-check: length, banned-word, banned-topic on the new title.
          const reBanned = bannedTopicMatch(
            merged.topicLabel,
            merged.proposedTitle,
            bannedTopics
          );
          if (reBanned) {
            dropped.push({
              topicLabel: merged.topicLabel,
              proposedTitle: merged.proposedTitle,
              reason: "banned_topic",
              detail: `regen drifted into banned term "${reBanned}"`,
            });
            continue;
          }
          const reBand = titleLengthBandFor(merged.proposedTitle);
          if (reBand === "rejected" || reBand === "too_long") {
            dropped.push({
              topicLabel: merged.topicLabel,
              proposedTitle: merged.proposedTitle,
              reason: "title_too_long",
              detail: `${merged.proposedTitle.length} chars after retry`,
            });
            continue;
          }
          const reBannedWord = bannedWordMatch(merged.proposedTitle);
          if (reBannedWord) {
            dropped.push({
              topicLabel: merged.topicLabel,
              proposedTitle: merged.proposedTitle,
              reason: "banned_word",
              detail: `regen still contains "${reBannedWord}"`,
            });
            continue;
          }
          annotated.push(score(merged));
        }
      } else {
        log.warn(
          "claude",
          `Outlier-ideas ${userChannelId}: title-retry returned malformed JSON; dropping ${prefilter.titleRetry.length} slots`
        );
        for (const f of prefilter.titleRetry) {
          dropped.push({
            topicLabel: f.topicLabel,
            proposedTitle: f.proposedTitle,
            reason: f.reason,
            detail: `${f.detail}; retry parse failed`,
          });
        }
      }
    } catch (err) {
      log.warn(
        "claude",
        `Outlier-ideas ${userChannelId}: title-retry call failed: ${err instanceof Error ? err.message : "?"}`
      );
      for (const f of prefilter.titleRetry) {
        dropped.push({
          topicLabel: f.topicLabel,
          proposedTitle: f.proposedTitle,
          reason: f.reason,
          detail: `${f.detail}; retry call errored`,
        });
      }
    }
  }

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
        // Bumped from 1500 → 5000 to fit the retry thinking budget plus a
        // few hundred tokens for the regenerated JSON. Temperature MUST be
        // 1 (the default) when thinking is enabled — we previously ran at
        // 0.9 for retry novelty; thinking compensates by reasoning through
        // the remix instructions explicitly.
        max_tokens: 5000,
        system: systemPrompt,
        messages: [{ role: "user", content: regenBody }],
        thinking: {
          type: "enabled",
          budget_tokens: IDEATION_RETRY_THINKING_BUDGET,
        },
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

  // Drop slots that still overlap too much after retries. Accumulate the
  // dropped originality slots for the Skipped research-block line.
  for (const a of annotated.filter((x) => x.flagged)) {
    dropped.push({
      topicLabel: a.topicLabel,
      proposedTitle: a.proposedTitle,
      reason: "originality",
      detail: a.flagReason ?? `overlap=${a.maxOverlap.toFixed(2)}`,
    });
  }
  // Cap surviving slate at MAX_IDEAS (T3). Sort by confidence so we keep
  // the strongest survivors when the over-fetch overshoots.
  const survivingSorted = annotated
    .filter((a) => !a.flagged)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const surviving = survivingSorted.slice(0, MAX_IDEAS);

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
      titleLengthBand:
        titleLengthBandFor(a.proposedTitle) === "ideal" ? "ideal" : "acceptable",
      topicFrequencyCheck: {
        matches: prefilter.topicFrequency.get(a.topicLabel)?.matches ?? 0,
        matchedVideos:
          prefilter.topicFrequency.get(a.topicLabel)?.matchedVideos ?? [],
      },
    };
  });

  log.info(
    "claude",
    `Outlier-ideas ${userChannelId}: ${ideas.length} ideas (target ${MAX_IDEAS}, ${dropped.length} dropped — ${dropped
      .map((d) => d.reason)
      .reduce(
        (acc: Record<string, number>, r) => {
          acc[r] = (acc[r] ?? 0) + 1;
          return acc;
        },
        {}
      )
      .toString?.() ?? "{}"}); formats=${formats.length}, viralOutliers=${outlierLites.length}`
  );

  return {
    ok: true,
    ideas,
    dropped,
    bannedTopics,
    generatedAt: now,
    model,
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSystemPromptForCompose(opts: {
  sec1: string;
  sec4: string;
  sec7: string;
  sec9: string;
  bannedTopics: string[];
}): string {
  const bannedBlock =
    opts.bannedTopics.length > 0
      ? [
          "# BANNED TOPICS (per channel_memory)",
          "NEVER propose ideas touching the following. If a viral outlier cluster matches any banned term as a substring (case-insensitive), skip that cluster entirely — do NOT compose a title for it.",
          ...opts.bannedTopics.map((t) => `- ${t}`),
          "",
        ]
      : [];
  return [
    "You compose NEW YouTube video titles by APPLYING trending title formats to currently-viral topics. The format is a structural skeleton; the topic is the subject. Your job is to glue them — never to paraphrase a source outlier's specific phrasing.",
    "",
    "Workflow (in order):",
    `1. Group the VIRAL OUTLIERS by topic theme. Same topic across multiple channels → ONE cluster. Two videos on the same topic with different angles still cluster together. Quality of clustering matters: a sloppy cluster makes a sloppy title.`,
    `2. Pick the TOP ${OVER_FETCH_CLUSTERS} strongest clusters (we'll filter down to ${MAX_IDEAS} after server-side guards run). For each, select ONE format from TRENDING FORMATS that best fits the topic's natural structure.`,
    "3. Compose ONE new title per cluster that fills the format's slots with the topic. The new title must NOT share significant phrasing with any source outlier in the cluster — apply the format anew, don't echo.",
    "4. Match the channel's voice — terse vs poetic, tabloid vs measured. Voice trumps style ties.",
    "",
    "# TITLE LANGUAGE — plain words only",
    "Every proposedTitle MUST be readable by a 14-year-old in under 2 seconds. Mirror the lexical register of competitor outliers (\"huge\", \"hiding\", \"hard\", \"real\", \"big\", \"found\", \"moved\"). Prefer Anglo-Saxon over Latinate. NEVER use any of these words/phrases: cinematic, sensory, visceral, profound, desolate expanse, humanity has ever charted, humanity has ever mapped, inexorable, vastest, the most absolute, physically impossible. Server-side regex enforces this — titles containing any banned term will be regenerated or dropped.",
    "",
    "# TITLE LENGTH",
    `Every proposedTitle MUST land in 50-80 characters (ideal 50-70). Titles over 80 chars are regenerated once then dropped if still over. Titles under ${TITLE_LEN_DROP_FLOOR} are dropped outright.`,
    "",
    ...bannedBlock,
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
    `- Output ${OVER_FETCH_CLUSTERS} candidate ideas — the server will drop some via length/banned-word/banned-topic/topic-frequency/originality filters and ship up to ${MAX_IDEAS}. Quality over quantity.`,
    "- Each idea cites the SOURCE FORMAT (by id) and the SOURCE OUTLIER VIDEO IDS (up to 3) the topic cluster came from.",
    "- topicLabel is 4–8 words, the subject area, NOT the proposed title.",
    "- proposedTitle is YOUR composed title applying the format's slots to the topic. Never copy a source title's phrasing. 50-70 chars ideal, 80 chars hard ceiling.",
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
  bannedTopics: string[];
}): string {
  const { ctx, formats, outliers, supplied, bannedTopics } = opts;
  return [
    "# USER CHANNEL CONTEXT",
    `- Niche: ${ctx.niche || "(empty)"}`,
    `- Positioning: ${ctx.positioning || "(empty)"}`,
    `- Audience: ${ctx.audience || "(empty)"}`,
    `- Voice: ${ctx.voice || "(empty)"}`,
    `- External sources: ${ctx.external_sources || "(empty)"}`,
    "",
    ...(bannedTopics.length > 0
      ? [
          `# BANNED TOPICS (skip clusters touching any of these as substring)`,
          ...bannedTopics.map((t) => `- ${t}`),
          "",
        ]
      : []),
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

/**
 * Title-length / banned-word forced retry body. Sent ONCE per turn for
 * any slot that violated T1 (length > 80) or T2 (banned word in title).
 * The model rewrites just those titles; surviving slots flow through the
 * downstream originality pass unchanged.
 */
function buildTitleRetryBody(
  flagged: Array<{
    topicLabel: string;
    sourceFormatId: number;
    proposedTitle: string;
    reason: "title_too_long" | "banned_word";
    detail: string;
  }>,
  formats: FormatLite[]
): string {
  const fmtById = new Map(formats.map((f) => [f.id, f]));
  return [
    "# FORCED RETRY — title-length or banned-word violations",
    "",
    `Your previous titles broke one of two contracts. Rewrite each, keeping the same topicLabel and sourceFormatId. Hard constraints:`,
    `  - Length: 50-70 chars ideal, 80 chars hard ceiling. < 35 or > 100 = dropped.`,
    `  - Language: NEVER use cinematic, sensory, visceral, profound, desolate expanse, humanity has ever charted, humanity has ever mapped, inexorable, vastest, the most absolute, physically impossible. Plain words a 14-year-old reads in <2 seconds. Mirror competitor outlier register ("huge", "hiding", "real", "found").`,
    "",
    "Return JSON ONLY:",
    "{",
    '  "regenerated": [',
    '    { "topicLabel": string, "proposedTitle": string, "angle": string, "confidence": number }',
    "  ]",
    "}",
    "",
    ...flagged.map((f) => {
      const fmt = fmtById.get(f.sourceFormatId);
      return [
        `## ${f.topicLabel}`,
        `- Format [F-${f.sourceFormatId}]: "${fmt?.template ?? "(unknown)"}"`,
        `- BLOCKED previous attempt (${f.detail}): "${f.proposedTitle}"`,
      ].join("\n");
    }),
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

/**
 * Parse the per-channel banned_topics row from channel_memory into a
 * normalized lowercase list. Tolerant of trailing commas + whitespace.
 * Returns [] when no row exists or value is empty.
 */
function readBannedTopics(channelId: string): string[] {
  const rows = listChannelMemory(channelId);
  const row = rows.find((r) => r.key === "banned_topics");
  if (!row || !row.value) return [];
  return row.value
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * T1 — title-length classifier. Returns the band a title falls into:
 *   ideal       50-70 chars
 *   acceptable  71-80 chars (no retry needed but flagged)
 *   too_short   <50 chars but ≥TITLE_LEN_DROP_FLOOR (will be regenerated)
 *   too_long    81-100 chars (will be regenerated once)
 *   rejected    <TITLE_LEN_DROP_FLOOR or >100 (drop, no retry)
 */
function titleLengthBandFor(
  title: string
): "ideal" | "acceptable" | "too_short" | "too_long" | "rejected" {
  const len = title.length;
  if (len > TITLE_LEN_RETRY_MAX || len < TITLE_LEN_DROP_FLOOR) return "rejected";
  if (len <= TITLE_LEN_IDEAL_MAX && len >= TITLE_LEN_IDEAL_MIN) return "ideal";
  if (len <= TITLE_LEN_HARD_MAX) return "acceptable";
  if (len < TITLE_LEN_IDEAL_MIN) return "too_short";
  return "too_long";
}

/**
 * T2 — banned-words check. Single regex covers all 11 terms from
 * operating rule 13 (the word-boundary anchors handle multi-word phrases
 * because the inner space is matched literally, with boundaries at the
 * outer letter↔non-letter transitions). Returns the offending term so
 * the retry prompt can quote it back to the model.
 */
function bannedWordMatch(title: string): string | null {
  const m = title.match(BANNED_WORDS_RE);
  return m ? m[0] : null;
}

/**
 * T5 — per-channel banned-topic substring scan. Returns the first
 * matching term so the drop accumulator can surface "why".
 */
function bannedTopicMatch(
  topicLabel: string,
  proposedTitle: string,
  bannedTopics: string[]
): string | null {
  if (bannedTopics.length === 0) return null;
  const haystack = `${topicLabel} ${proposedTitle}`.toLowerCase();
  for (const t of bannedTopics) {
    if (t && haystack.includes(t)) return t;
  }
  return null;
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
