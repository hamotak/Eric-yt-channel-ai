import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  competitorMedianViews,
  getCompetitorVideosByIds,
  getIntegration,
  listAllChannels,
  listChannelMemory,
  resolveChannelDescription,
  type Channel,
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
  findOwnCatalogTopicMatches,
  findTopicSimilarOutliers,
  type OwnCatalogMatch,
  type TopicFrequencyResult,
  type TopicSimilarMatch,
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
    | "originality"
    | "topic_dup"
    | "no_anchor"
    | "own_channel";
  detail?: string;
};

/**
 * Anchor check: each idea must be grounded in a trending format OR a
 * cross-channel viral topic (≥2 topicSimilarOutliers from DIFFERENT
 * competitors, each with multiplier ≥3). Both is ideal; neither is a
 * hard drop. Returns the anchor type for the post-LLM filter.
 */
const ANCHOR_TOPIC_MIN_MULTIPLIER = 3;
const ANCHOR_TOPIC_MIN_DISTINCT_COMPETITORS = 2;

// Outliers-primary pool. Soften pass (T2 of follow-up PR): the prior
// format×topic pipeline required ≥5× / 14d outliers AND ≥3-example
// formats — both gates were too strict on HAmo's pool. New shape:
//
//   Outliers are the PRIMARY inspiration. Formats are OPTIONAL
//   remix templates the LLM may use for ~40% of titles, with the
//   remaining ~60% free-form in the channel's voice.
//
// Floor matches the methodology's outlier definition (≥1.5× — the alert
// generation floor in MENTOR_METHOD §2); the 28d window catches anything
// that's broken out in the last month without going so wide that stale
// hits dominate. Source pool is sorted by (multiplier DESC, publishedAt
// DESC) and capped at 30 — same scan cost as the old viral pool.
const OUTLIER_MIN_MULTIPLIER = 1.5;
const OUTLIER_WINDOW_DAYS = 28;
const OUTLIER_LIMIT = 30;
const MIN_OUTLIER_CANDIDATES = 3;

// Formats are now optional flavor — drop the prior MIN_FORMAT_CANDIDATES
// hard floor (extraction can ship 0-2 formats without blocking ideation).
// We still bound the pool size so the prompt body doesn't bloat.
const FORMAT_MIN_EXAMPLES = 2;
const FORMAT_LIMIT = 5;

// Default ideation slate size after all filters (length, banned words,
// banned topics, topic frequency, originality, topic-cluster dedup).
// We over-fetch from the LLM to absorb the drop cascade.
const MAX_IDEAS = 10;
// Over-fetch budget. The new outliers-primary flow asks for 1 idea per
// outlier (rather than clustering them first), so the cap matches the
// source pool size. After all gates the slate is trimmed to MAX_IDEAS.
const OVER_FETCH_IDEAS = 16;

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
  // Soften pass (T2 of follow-up PR): sourceFormat is now nullable. The
  // new outliers-primary pipeline asks the LLM to remix with a format
  // template for ~40% of titles and leave the rest as free-form
  // compositions in the channel's voice; free-form ideas ship with
  // sourceFormat === null and the agent's structured markdown omits
  // the "Format:" line for them.
  sourceFormat: {
    id: number;
    template: string;
    risingRate: number | null;
    exampleCount: number;
  } | null;
  sourceTopicOutliers: Array<{
    videoId: string;
    title: string;
    // T4 forensic-evidence fields. Every outlier surfaces verifiable
    // numbers so the agent's output renders "224K views vs channel
    // median 4K", not just "52×".
    views: number;
    channelMedian: number;
    multiplier: number;
    thumbnailUrl: string | null;
    publishedAt: number | null;
    competitorTitle: string | null;
    competitorHandle: string | null;
    competitorSubscriberCount: number | null;
    performanceBand: PerformanceBand;
  }>;
  // Up to 3 OTHER competitor outliers covering the SAME TOPIC (token
  // overlap on the topicLabel), excluding any id in sourceTopicOutliers.
  // Replaces the prior otherFormatExamples block, which showed format
  // siblings — useful for proving the SHAPE but irrelevant when the
  // user wants to see who else covered the SAME TOPIC and how hard it
  // hit. Falls back to [] when no cross-channel topic siblings exist.
  topicSimilarOutliers: TopicSimilarMatch[];
  // T5: 0-3 of the user's OWN videos that share content nouns with the
  // topic. Surfaces the "Your catalog comparison" block inline in the
  // agent's forensic markdown so HAmo sees instantly whether the channel
  // has touched the topic and how it performed.
  ownCatalogMatches: OwnCatalogMatch[];
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

// Channel context the compose stage actually USES. Description is the
// resolved single-paragraph string (legacy-fallback handled by
// resolveChannelDescription); ideation_rules ships verbatim.
type ChannelCtx = {
  description: string;
  ideation_rules?: string;
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
  // T4: surfaced through to ProposedIdea.sourceTopicOutliers so the
  // forensic markup can render "views vs median" rather than naked
  // multipliers.
  channelMedian: number;
  multiplier: number;
  thumbnailUrl: string | null;
  competitorTitle: string | null;
  competitorHandle: string | null;
  competitorSubscriberCount: number | null;
  // Carried through from listOutliersForActiveChannel so the defense-in-
  // depth own-channel filter below can compare against the active
  // userChannelId. The SQL already excludes self-tracked competitors;
  // this is a belt-and-braces guard per DEF-I1.
  competitorChannelId: string | null;
  tier: string;
  publishedAt: number | null;
};

/**
 * Outliers-primary ideation. Pipeline (post-soften redesign):
 *   1. Pull the source pool: top 30 competitor outliers ≥1.5× channel
 *      median in the last 28 days, sorted (multiplier DESC, publishedAt
 *      DESC). Already-hidden videos + self-tracked-as-competitor rows
 *      are filtered at the SQL layer. Banned-topic substring filter is
 *      applied in JS before the LLM sees the pool.
 *   2. Pull the OPTIONAL format pool: top 5 trending formats by rising
 *      rate (≥2 examples, non-banned). May be empty — that's fine; the
 *      LLM is told formats are optional flavor, not a requirement.
 *   3. One Claude call: 1 idea per outlier (~16 outputs over-fetched).
 *      For each, the LLM may either remix with a format template
 *      (sourceFormatId set) or compose a free-form title in the
 *      channel's voice (sourceFormatId null). Target mix: ~40% format,
 *      ~60% free-form, but the model is told to drop the format entirely
 *      when none fit naturally.
 *   4. Standard post-LLM drop cascade: title length, banned words,
 *      banned topics (re-check post-compose), topic frequency (≥1 hit in
 *      last 20 own uploads), originality. Up to MAX_RETRY_PASSES focused
 *      regenerate passes per flagged slot.
 *   5. Topic-cluster dedup: if ≥2 surviving ideas share a topicLabel,
 *      keep the highest-scoring, drop the rest. Replaces the prior
 *      format-cluster dedup — variety is now measured by topic diversity.
 *   6. validateIdeaAgainstOwnCatalog + findTopicSimilarOutliers per idea.
 *
 * No rate limit. The whole point of the new flow is iterating until the
 * user likes the slate.
 *
 * Caller knobs:
 *   - outlierVideoIds: bypass auto-pick. Trust the caller's curation.
 *   - windowDays / minMultiplier: override the source pool gates.
 *     The chat agent should only set these when the USER explicitly asks
 *     to widen — operating rule 11 enforces that.
 *   - mode: "mixed" (default — ~40% format, ~60% free-form) or
 *     "free-form" (skip format pool entirely; every idea ships
 *     sourceFormat:null). HAmo can request "no format templates" in chat
 *     and the agent passes mode:"free-form".
 */
export async function generateIdeasForChannel(opts: {
  userChannelId: string;
  outlierVideoIds?: string[];
  windowDays?: number;
  minMultiplier?: number;
  mode?: "mixed" | "free-form";
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

  // --- 1. Source pool: outliers ARE the primary inspiration ----------------
  const outlierWindow = opts.windowDays ?? OUTLIER_WINDOW_DAYS;
  const outlierMult = opts.minMultiplier ?? OUTLIER_MIN_MULTIPLIER;
  let outlierLites: OutlierLite[] = [];
  let supplied = false;
  if (opts.outlierVideoIds && opts.outlierVideoIds.length > 0) {
    supplied = true;
    const rows = getCompetitorVideosByIds(opts.outlierVideoIds.slice(0, OUTLIER_LIMIT));
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
        channelMedian: med,
        multiplier: med > 0 ? r.views / med : 0,
        thumbnailUrl: ytThumbnail(r.videoId),
        competitorTitle: r.competitorTitle,
        competitorHandle: r.competitorHandle ?? null,
        // The bulk-fetch helper doesn't carry subscriber_count; users
        // who pass curated outlierVideoIds get null here, which the
        // markup renders as "(unknown subs)". Acceptable for the
        // power-user override path.
        competitorSubscriberCount: null,
        competitorChannelId: r.competitorChannelId ?? null,
        tier: r.tier,
        publishedAt: r.publishedAt,
      };
    });
  } else {
    const { outliers } = listOutliersForActiveChannel({
      userChannelId,
      windowDays: outlierWindow,
      minMultiplier: outlierMult,
      limit: OUTLIER_LIMIT,
    });
    outlierLites = outliers.map((o) => ({
      videoId: o.videoId,
      title: o.title,
      views: o.views,
      channelMedian: o.channelMedian,
      multiplier: o.multiplier,
      thumbnailUrl: o.thumbnailUrl ?? ytThumbnail(o.videoId),
      competitorTitle: o.competitorTitle,
      competitorHandle: o.competitorHandle ?? null,
      competitorSubscriberCount: o.competitorSubscriberCount,
      competitorChannelId: o.competitorChannelId ?? null,
      tier: o.tier,
      publishedAt: o.publishedAt,
    }));
    if (outlierLites.length < MIN_OUTLIER_CANDIDATES) {
      return {
        ok: false,
        status: 409,
        error: `Only ${outlierLites.length} outlier${outlierLites.length === 1 ? "" : "s"} ≥${outlierMult}× in the last ${outlierWindow} days — need ≥${MIN_OUTLIER_CANDIDATES}. Ask the user whether to widen the window or lower the multiplier; do NOT silently lower these thresholds.`,
      };
    }
  }
  // DEF-I1 defense-in-depth: strip any outlier whose competitor channel
  // matches the active user channel. The SQL in listOutliersForActiveChannel
  // already excludes self-tracked-as-competitor rows; this is the second
  // belt in case (a) a caller bypasses that helper, or (b) a future SQL
  // refactor regresses the filter. Drops here are silent — they're a
  // data-hygiene issue, not user-facing.
  const ownChannelDrops = outlierLites.filter(
    (o) => o.competitorChannelId !== null && o.competitorChannelId === userChannelId
  );
  if (ownChannelDrops.length > 0) {
    outlierLites = outlierLites.filter(
      (o) => !(o.competitorChannelId !== null && o.competitorChannelId === userChannelId)
    );
    log.warn(
      "claude",
      `Outlier-ideas ${userChannelId}: stripped ${ownChannelDrops.length} own-channel rows from inspiration pool (self-tracked-as-competitor leak — investigate competitors table)`
    );
  }
  // Soften pass: pre-LLM banned-topic filter. The agent's banned_topics
  // list (channel_memory) used to be applied post-LLM only, after the
  // compose call had already paid for tokens on banned-topic ideas;
  // moving the FIRST pass forward saves cost + keeps the source pool
  // clean. A second pass on (topicLabel, proposedTitle) still runs
  // post-compose below — the LLM can still drift to a banned topic from
  // a clean source.
  const bannedTopics = readBannedTopics(userChannelId);
  if (bannedTopics.length > 0) {
    const beforeBanned = outlierLites.length;
    outlierLites = outlierLites.filter((o) => {
      const haystack = (o.title ?? "").toLowerCase();
      for (const term of bannedTopics) {
        if (term && haystack.includes(term)) return false;
      }
      return true;
    });
    const removed = beforeBanned - outlierLites.length;
    if (removed > 0) {
      log.info(
        "claude",
        `Outlier-ideas ${userChannelId}: pre-LLM banned-topic filter removed ${removed} of ${beforeBanned} outliers`
      );
    }
  }
  if (outlierLites.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "No outliers available for this channel. Add competitors and sync first.",
    };
  }

  // --- 2. Optional format pool (OK to be empty) ----------------------------
  // Free-form mode skips the format pool entirely so every idea ships
  // with sourceFormatId:null. Use when HAmo explicitly asks "no format
  // templates" — operating rule 11 governs threshold widening, not
  // mode-flipping, so this is a normal pass-through.
  const mode: "mixed" | "free-form" = opts.mode === "free-form" ? "free-form" : "mixed";
  const formats: FormatLite[] =
    mode === "free-form"
      ? []
      : getFormatsForChannel(userChannelId, 30)
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

  // --- 3. Claude call: compose 1 idea per outlier (~16 over-fetch) --------
  const md = loadMentorMethod();
  const sec1 = extractSection(md, 1);
  const sec4 = extractSection(md, 4);
  const sec7 = extractSection(md, 7);
  const sec9 = extractSection(md, 9);
  // Resolve channel description via the legacy-fallback helper so old
  // channels without the new column still surface concatenated context.
  const ctx: ChannelCtx = {
    description: resolveChannelDescription(channel as unknown as Channel),
    ideation_rules: (channel as unknown as Channel).ideation_rules,
  };

  const systemPrompt = buildSystemPromptForCompose({
    sec1,
    sec4,
    sec7,
    sec9,
    bannedTopics,
    ideationRules: (ctx.ideation_rules ?? "").trim(),
    mode,
    formatPoolEmpty: formats.length === 0,
  });

  const userBody = buildUserBodyForCompose({
    ctx,
    formats,
    outliers: outlierLites,
    supplied,
    bannedTopics,
    mode,
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
      // The id set is passed so parseComposedIdeas can null out any
      // sourceFormatId the LLM made up. An empty set means every
      // sourceFormatId becomes null — exactly the free-form case.
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
  // Pre-sort survivors by a combined "ship value": confidence weights
  // intent, originalityScore weights novelty. Higher wins.
  const preDedup = annotated
    .filter((a) => !a.flagged)
    .sort(
      (a, b) =>
        (b.confidence ?? 0) * 10 + (b.originalityScore ?? 0)
        - ((a.confidence ?? 0) * 10 + (a.originalityScore ?? 0))
    );

  // Topic-cluster dedup (replaces the prior format-cluster dedup). The
  // outliers-primary pipeline composes 1 idea per outlier, so the LLM
  // can drift into clustering around the same hot topic. We collapse by
  // a normalised topicLabel — keep the highest-scoring, drop the rest.
  // Goal: 10 distinct topics across 10 ideas.
  const normaliseTopic = (t: string): string =>
    t.toLowerCase().replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ").trim().replace(/\s+/g, " ");
  const seenTopics = new Set<string>();
  const afterTopicDedup: typeof preDedup = [];
  for (const a of preDedup) {
    const key = normaliseTopic(a.topicLabel);
    if (seenTopics.has(key)) {
      dropped.push({
        topicLabel: a.topicLabel,
        proposedTitle: a.proposedTitle,
        reason: "topic_dup",
        detail: `topic "${a.topicLabel}" already covered by a higher-scoring idea`,
      });
      continue;
    }
    seenTopics.add(key);
    afterTopicDedup.push(a);
  }
  // Cap surviving slate at MAX_IDEAS.
  const surviving = afterTopicDedup.slice(0, MAX_IDEAS);

  // DEF-I4: per-reason attrition logging. Drives the agent's "Skipped"
  // research-block line and helps HAmo see where the cascade lost ideas.
  const dropCounts: Record<string, number> = {};
  for (const d of dropped) {
    dropCounts[d.reason] = (dropCounts[d.reason] ?? 0) + 1;
  }
  log.info(
    "claude",
    `Outlier-ideas ${userChannelId}: attrition — LLM raw=${rawIdeas.length}, prefilter survived=${prefilter.surviving.length}, post-originality=${annotated.filter((x) => !x.flagged).length}, post-topic-dedup=${afterTopicDedup.length}, shipped=${Math.min(surviving.length, MAX_IDEAS)}; drops=${JSON.stringify(dropCounts)}`
  );

  // --- 5. Validate each surviving idea against own catalog + hydrate
  //        the "Same topic across competitors" block. Replaces the prior
  //        otherFormatExamples (format siblings) — users want to see
  //        who else covered the SAME TOPIC and how hard it hit, not
  //        more videos using the same shape.
  // First map every survivor to its ProposedIdea shape so we can inspect
  // both anchors (sourceFormat + topicSimilarOutliers) in one pass.
  const mapped = surviving.map((a) => {
    const fmt =
      a.sourceFormatId !== null ? formatById.get(a.sourceFormatId) : null;
    const validation = validateIdeaAgainstOwnCatalog({
      topic: a.topicLabel,
      userChannelId,
    });
    const sourceIds = new Set(a.sources.map((s) => s.videoId));
    const topicSimilarOutliers = findTopicSimilarOutliers(
      a.topicLabel,
      userChannelId,
      { limit: 3, excludeVideoIds: [...sourceIds] }
    );
    // T5 — own-channel catalog matches for the forensic "Your catalog
    // comparison" block. Up to 3 of the user's videos that share content
    // nouns with the proposed topic, with full views/median/date so the
    // agent's markdown shows verifiable evidence inline.
    const ownCatalogMatches = findOwnCatalogTopicMatches(
      a.topicLabel,
      userChannelId,
      { limit: 3 }
    );
    return {
      raw: a,
      shaped: {
        sourceOutlierVideoId: a.sources[0]?.videoId ?? "",
        sourceFormat:
          fmt && a.sourceFormatId !== null
            ? {
                id: a.sourceFormatId,
                template: fmt.template,
                risingRate: fmt.risingRate,
                exampleCount: fmt.examples,
              }
            : null,
        sourceTopicOutliers: a.sources.map((s) => {
          const m = Math.round(s.multiplier * 10) / 10;
          // OutlierLite carries views; channelMedian + subs were added
          // to OutlierRow in T4 and now flow through OutlierLite as
          // additional fields.
          return {
            videoId: s.videoId,
            title: s.title,
            views: s.views,
            channelMedian: s.channelMedian,
            multiplier: m,
            thumbnailUrl: s.thumbnailUrl,
            publishedAt: s.publishedAt,
            competitorTitle: s.competitorTitle,
            competitorHandle: s.competitorHandle,
            competitorSubscriberCount: s.competitorSubscriberCount,
            performanceBand: performanceBandFor(m),
          };
        }),
        topicSimilarOutliers,
        ownCatalogMatches,
        topicLabel: a.topicLabel,
        proposedTitle: a.proposedTitle,
        angle: a.angle,
        confidence: a.confidence,
        originalityScore: Math.round(a.originalityScore * 100) / 100,
        validation,
        titleLengthBand:
          titleLengthBandFor(a.proposedTitle) === "ideal" ? "ideal" : "acceptable" as "ideal" | "acceptable",
        topicFrequencyCheck: {
          matches: prefilter.topicFrequency.get(a.topicLabel)?.matches ?? 0,
          matchedVideos:
            prefilter.topicFrequency.get(a.topicLabel)?.matchedVideos ?? [],
        },
      } satisfies ProposedIdea,
    };
  });

  // T5: viral_format × viral_topic enforcement. Every idea must anchor
  // in EITHER a trending format (sourceFormat !== null) OR a cross-
  // channel viral topic (≥2 topicSimilarOutliers from DIFFERENT
  // competitors, each with multiplier ≥3). Drops surface as
  // reason:"no_anchor" so HAmo can see why the slate shrank.
  const hasViralTopicAnchor = (
    sims: ProposedIdea["topicSimilarOutliers"]
  ): boolean => {
    const strong = sims.filter(
      (s) =>
        s.multiplier >= ANCHOR_TOPIC_MIN_MULTIPLIER && !!s.competitorTitle
    );
    if (strong.length < ANCHOR_TOPIC_MIN_DISTINCT_COMPETITORS) return false;
    const distinctChannels = new Set(strong.map((s) => s.competitorTitle));
    return distinctChannels.size >= ANCHOR_TOPIC_MIN_DISTINCT_COMPETITORS;
  };
  const ideas: ProposedIdea[] = [];
  for (const { shaped } of mapped) {
    const hasFormatAnchor = shaped.sourceFormat !== null;
    const hasTopicAnchor = hasViralTopicAnchor(shaped.topicSimilarOutliers);
    if (!hasFormatAnchor && !hasTopicAnchor) {
      dropped.push({
        topicLabel: shaped.topicLabel,
        proposedTitle: shaped.proposedTitle,
        reason: "no_anchor",
        detail: `no trending format AND no cross-channel viral topic (≥2 competitors at ≥${ANCHOR_TOPIC_MIN_MULTIPLIER}×)`,
      });
      continue;
    }
    ideas.push(shaped);
  }

  // The attrition log already fired before mapping survivors — see
  // dropCounts log above. This second info-line just summarises the
  // shipped slate.
  const withFormat = ideas.filter((i) => i.sourceFormat !== null).length;
  log.info(
    "claude",
    `Outlier-ideas ${userChannelId}: shipped ${ideas.length}/${MAX_IDEAS} ideas (${dropped.length} total drops); formats-available=${formats.length}, mode=${mode}, ideas-using-format=${withFormat}/${ideas.length}, outliers-in-pool=${outlierLites.length}`
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
  ideationRules: string;
  mode: "mixed" | "free-form";
  formatPoolEmpty: boolean;
}): string {
  const bannedBlock =
    opts.bannedTopics.length > 0
      ? [
          "# BANNED TOPICS (per channel_memory)",
          "NEVER propose ideas touching the following. If a recent outlier mentions any banned term as a substring (case-insensitive), skip that outlier entirely — do NOT compose a title for it.",
          ...opts.bannedTopics.map((t) => `- ${t}`),
          "",
        ]
      : [];
  const ideationRulesBlock = opts.ideationRules
    ? [
        "# PER-CHANNEL IDEATION RULES (HAmo-authored, HARD enforcement)",
        "The creator has set these rules for THIS channel. They override every other compose heuristic. A title that violates any rule below MUST be regenerated or dropped — do NOT compromise the rule to ship the title.",
        opts.ideationRules,
        "",
      ]
    : [];

  // The mix-mode guidance differs sharply by mode. "free-form" means
  // sourceFormatId MUST be null on every idea; "mixed" leaves the
  // decision to the model, with the explicit target ratio and the
  // freedom to skip the format entirely when no format fits.
  const mixGuidance =
    opts.mode === "free-form" || opts.formatPoolEmpty
      ? [
          "# COMPOSE MODE — FREE-FORM ONLY",
          opts.mode === "free-form"
            ? "The caller has asked for free-form titles only. The TRENDING FORMATS block below is intentionally empty. Every idea MUST set sourceFormatId to null. Compose every title in the channel's voice as a fresh free-form composition — DO NOT invent format ids."
            : "No trending formats are available for this channel right now. Every idea MUST set sourceFormatId to null. Compose every title in the channel's voice as a fresh free-form composition.",
          "",
        ]
      : [
          "# COMPOSE MODE — MIXED (formats are OPTIONAL flavor)",
          "Outliers are the PRIMARY inspiration. Trending formats are AVAILABLE remix templates the model MAY use, but is NOT required to.",
          `Aim for roughly 40% of titles using a format template (sourceFormatId set to that template's id) and 60% as free-form titles in the channel's voice (sourceFormatId null). If no format fits a particular outlier naturally, set sourceFormatId to null and compose free-form — a forced fit is worse than no template.`,
          "Variety is the goal: do NOT pick the same format twice in a row, and prefer using EVERY listed format at least once rather than stacking the most-rising one.",
          "",
        ];
  const outputShape =
    opts.mode === "free-form" || opts.formatPoolEmpty
      ? '      "sourceFormatId": null,'
      : '      "sourceFormatId": number | null,    // a format id from TRENDING FORMATS, OR null for a free-form composition';

  return [
    "You propose NEW YouTube video title ideas. PRIMARY inspiration: the recent viral OUTLIERS below — competitor videos that beat their own channel's median in the last 4 weeks. Each idea MUST be inspired by exactly ONE source outlier (cite its videoId in sourceTopicOutlierIds[0]).",
    "",
    "Workflow:",
    "1. Pick ~16 of the strongest outliers (multiplier × age × topic fit for the channel). One idea per outlier.",
    "2. For each outlier, propose ONE new title in the channel's voice. The new title must NOT share significant phrasing with the source outlier — apply the IDEA, not the phrasing.",
    "3. Use the COMPOSE MODE guidance below to decide whether to remix with a format template or compose free-form.",
    "4. Match the channel's voice — terse vs poetic, tabloid vs measured. Voice trumps style ties.",
    "",
    "# TITLE LANGUAGE — plain words only",
    "Every proposedTitle MUST be readable by a 14-year-old in under 2 seconds. Mirror the lexical register of competitor outliers (\"huge\", \"hiding\", \"hard\", \"real\", \"big\", \"found\", \"moved\"). Prefer Anglo-Saxon over Latinate. NEVER use any of these words/phrases: cinematic, sensory, visceral, profound, desolate expanse, humanity has ever charted, humanity has ever mapped, inexorable, vastest, the most absolute, physically impossible. Server-side regex enforces this — titles containing any banned term will be regenerated or dropped.",
    "",
    "# TITLE LENGTH",
    `Every proposedTitle MUST land in 50-80 characters (ideal 50-70). Titles over 80 chars are regenerated once then dropped if still over. Titles under ${TITLE_LEN_DROP_FLOOR} are dropped outright.`,
    "",
    ...bannedBlock,
    ...ideationRulesBlock,
    ...mixGuidance,
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
    `- Output ${OVER_FETCH_IDEAS} candidate ideas — the server drops some via length / banned-word / banned-topic / topic-frequency / originality / topic-dup / no-anchor filters and ships up to ${MAX_IDEAS}. Quality over quantity.`,
    "- ANCHOR RULE — each idea MUST be anchored in EITHER (a) a trending format (sourceFormatId set to an id from TRENDING FORMATS), OR (b) a cross-channel viral topic (the source outlier has ≥2 cross-channel siblings at ≥3× — the server picks these from competitor data on your behalf, you just need to ensure the topicLabel describes something that's actually moving across multiple channels). Ideally BOTH. Ideas grounded in neither are dropped by the server. If you cannot find either anchor for an outlier you picked, skip it and pick a different one from the pool.",
    "- Each idea cites exactly ONE source outlier in sourceTopicOutlierIds (use exactly one element).",
    "- sourceFormatId is either a numeric id from TRENDING FORMATS or null. NEVER invent a format id.",
    "- topicLabel is 4–8 words, the subject area, NOT the proposed title. Two ideas on the same topic will be deduped — DIVERSIFY topics across the slate.",
    "- proposedTitle is YOUR composed title. Never copy a source title's phrasing. 50-70 chars ideal, 80 chars hard ceiling.",
    "- angle is one §9 lever — the dominant lever the source outlier leans on.",
    "- confidence (0.0–1.0): higher when (a) the source outlier hit ≥3×, (b) the topic naturally fits the channel's niche, (c) when using a format, the format has many examples + high rising rate.",
    "- Authority + Breakthrough tier sources carry more weight than Adjacent + Far.",
    "",
    "Return ONLY a JSON object. No prose, no markdown, no code fence.",
    "Shape:",
    "{",
    '  "ideas": [',
    "    {",
    '      "topicLabel": string,',
    '      "sourceTopicOutlierIds": string[],   // exactly one element',
    outputShape,
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
  mode: "mixed" | "free-form";
}): string {
  const { ctx, formats, outliers, supplied, bannedTopics, mode } = opts;
  const formatBlock =
    mode === "free-form"
      ? [
          `# TRENDING FORMATS — DISABLED (caller requested free-form mode)`,
          `Every idea MUST set sourceFormatId to null.`,
          "",
        ]
      : formats.length > 0
        ? [
            `# TRENDING FORMATS (${formats.length}, ≥${FORMAT_MIN_EXAMPLES} examples, sorted by rising rate)`,
            `OPTIONAL — use a format id ONLY when one fits the outlier's topic naturally. Free-form (sourceFormatId:null) is the right answer when no template fits.`,
            ...formats.map(
              (f) =>
                `- [F-${f.id}] "${f.template}" — ${f.examples} examples — rising_rate=${(f.risingRate ?? 0).toFixed(2)}, avg_mult=${(f.avgMultiplier ?? 0).toFixed(1)}×`
            ),
            "",
          ]
        : [
            `# TRENDING FORMATS — none extracted yet for this channel.`,
            `Every idea MUST set sourceFormatId to null. Compose free-form titles in the channel's voice.`,
            "",
          ];
  return [
    "# USER CHANNEL CONTEXT",
    `## About this channel`,
    ctx.description.length > 0 ? ctx.description : "(not set — ask HAmo to fill /channel-info)",
    "",
    ...(bannedTopics.length > 0
      ? [
          `# BANNED TOPICS (skip outliers touching any of these as substring)`,
          ...bannedTopics.map((t) => `- ${t}`),
          "",
        ]
      : []),
    ...formatBlock,
    `# RECENT OUTLIERS (${outliers.length}${supplied ? ", caller-supplied" : `, ≥${OUTLIER_MIN_MULTIPLIER}× last ${OUTLIER_WINDOW_DAYS}d`}) — the PRIMARY inspiration pool`,
    `Sorted by (multiplier DESC, recency DESC). Compose ONE idea per outlier you pick.`,
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
    sourceFormatId: number | null;
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
    `Your previous titles broke one of two contracts. Rewrite each, keeping the same topicLabel and sourceFormatId (null stays null, a specific id stays that id). Hard constraints:`,
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
      const fmt = f.sourceFormatId !== null ? fmtById.get(f.sourceFormatId) : null;
      return [
        `## ${f.topicLabel}`,
        fmt
          ? `- Format [F-${f.sourceFormatId}]: "${fmt.template}"`
          : `- Format: free-form (no template — keep it that way)`,
        `- BLOCKED previous attempt (${f.detail}): "${f.proposedTitle}"`,
      ].join("\n");
    }),
  ].join("\n");
}

function buildRegenerateBody(
  flagged: Array<{
    topicLabel: string;
    sourceTopicOutlierIds: string[];
    sourceFormatId: number | null;
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
    "# FORCED RETRY — your previous titles echoed the source outlier too closely",
    "",
    "These are forced retries. Your previous attempts mirrored a source outlier's phrasing instead of proposing a new angle on the topic. Be AGGRESSIVE on novelty. For each entry below, generate a TRULY DIFFERENT title for the SAME topic and source outlier but with:",
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
    "Keep the same topicLabel and sourceFormatId (null stays null). Return JSON ONLY:",
    "{",
    '  "regenerated": [',
    '    { "topicLabel": string, "proposedTitle": string, "angle": string, "confidence": number }',
    "  ]",
    "}",
    "",
    ...flagged.map((f) => {
      const fmt = f.sourceFormatId !== null ? fmtById.get(f.sourceFormatId) : null;
      const reasonLabel =
        f.flagReason === "shared-run"
          ? `shared a ${f.longestSharedRun}-word run with a source`
          : f.flagReason === "shared-nouns"
            ? `shared ${f.sharedNouns} content nouns with a source`
            : `overlapped ${(f.maxOverlap * 100).toFixed(0)}% of tokens with a source`;
      return [
        `## ${f.topicLabel}`,
        fmt
          ? `- Format [F-${f.sourceFormatId}]: "${fmt.template}"`
          : `- Format: free-form (no template — stay free-form)`,
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
  // Nullable post-soften-pass: free-form ideas have no format id.
  sourceFormatId: number | null;
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
    // sourceFormatId is now nullable. The LLM is told to set null for
    // free-form ideas; anything that doesn't match a known format id
    // collapses to null too (rather than dropping the whole idea — a
    // free-form composition with a made-up id is still a usable idea).
    const rawFormatId = o.sourceFormatId;
    let sourceFormatId: number | null = null;
    if (rawFormatId === null) {
      sourceFormatId = null;
    } else if (
      typeof rawFormatId === "number" &&
      Number.isFinite(rawFormatId) &&
      knownFormatIds.has(rawFormatId)
    ) {
      sourceFormatId = rawFormatId;
    }
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
