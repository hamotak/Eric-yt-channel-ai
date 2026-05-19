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
import { getFormatsForChannel } from "./outlier-formats";
import { listOutliersForActiveChannel } from "./outliers";
import { log } from "./logger";
import {
  findOwnCatalogTopicMatches,
  findTopicSimilarOutliers,
  performanceBandFor,
  stripBrandPhrases,
  type OwnCatalogMatch,
  type PerformanceBand,
  type TopicSimilarMatch,
  validateIdeaAgainstOwnCatalog,
  type ValidateResult,
} from "./validate-idea";
import { checkLogicalFit, type LogicalFitInput } from "./logical-fit";

// ---------------------------------------------------------------------------
// Topic × Format mix pipeline (2026-05 rebuild).
//
// Pipeline:
//   1. Pull top 50 competitor outliers ≥1.5× channel median in last 28d.
//   2. JS-side topic clustering — group videos sharing ≥2 content nouns.
//      Keep clusters with ≥2 DISTINCT channels (single-channel topic
//      clusters drop). Rank by (distinct_channels DESC, max_multiplier
//      DESC, recency DESC). Top 10 surviving = TopicCandidates.
//   3. JS-side format pool — top 8 formats (including is_single_channel)
//      ranked by (rising_rate DESC, exampleCount DESC, avg_multiplier
//      DESC). Each carries a primary source video + 2 confirmation
//      examples.
//   4. CLAUDE CALL #1 (Opus 4.7, thinking 6000, temperature 1):
//      compose ONE title per topic candidate by applying a format from
//      the pool. The topic source video and the format source video
//      MUST be different videos — the model picks the format and emits
//      the formatSourceVideoId alongside the proposedTitle.
//   5. JS post-filter — title length 50-80, banned words (op rule 13),
//      per-channel banned topics, topic-frequency vs own catalog. Drops
//      are NOT retried (hard 3-call cap).
//   6. CLAUDE CALL #2 (Haiku 4.5): Logical-Fit validator. Each
//      (topicSource, formatSource, proposedTitle, coherenceRationale)
//      gets a logically_coherent verdict + one-sentence reason. Drops
//      get logged to app_logs as [diag] logical_fit pass/fail entries.
//   7. Optional CLAUDE CALL #3 (Sonnet 4.6): Format-swap retry. For
//      every slot the validator dropped, the model is asked to retry
//      the SAME topic with a DIFFERENT format (max 2 swap attempts per
//      slot — model picks among the next 2 ranked formats). One retry
//      compose call total — failures past it drop the topic.
//   8. Per-survivor hydration: validateIdeaAgainstOwnCatalog +
//      findOwnCatalogTopicMatches + cross-channel proof videos.
//
// Hard rules
//   - Max 3 Claude calls per turn (1 compose + 1 validator + 1 retry).
//   - "Logical coherence is non-negotiable. Format provides STRUCTURE,
//     topic provides SUBJECT. Cannot create fabricated facts."
//   - No schema changes; idempotent.
// ---------------------------------------------------------------------------

const OUTLIER_MIN_MULTIPLIER = 1.5;
const OUTLIER_WINDOW_DAYS = 28;
const OUTLIER_SOURCE_LIMIT = 50;

const TOPIC_CLUSTER_MIN_SHARED_NOUNS = 2;
const TOPIC_CLUSTER_MIN_DISTINCT_CHANNELS = 2;
// Single-channel monster bypass — a topic with only one competitor backing
// it still ships if that one video hit at least this multiplier. The
// magnitude alone is its own cross-channel validation.
const TOPIC_CLUSTER_MONSTER_MULTIPLIER = 10;
const TOPIC_CANDIDATE_LIMIT = 10;
const TOPIC_CONFIRMATION_MIN = 2;
const TOPIC_CONFIRMATION_MAX = 3;
// Catalog-gate thresholds. The per-idea pass averages multipliers across
// the user's matching own videos. Below MIN we drop (dead horse); at or
// above WINNER we tag "covered_recent_winner" so the agent can flag the
// idea as a remix candidate; in between we tag "covered_recent_flop" and
// still ship so HAmo can decide.
const CATALOG_DROP_AVG_MULTIPLIER = 1.5;
const CATALOG_WINNER_AVG_MULTIPLIER = 3.0;
const CATALOG_OLD_DAYS = 90;

const FORMAT_CANDIDATE_LIMIT = 8;
const FORMAT_MIN_EXAMPLES = 2;
const FORMAT_CONFIRMATION_TARGET = 2;

const MAX_FORMAT_SWAPS_PER_SLOT = 2;
const MAX_CLAUDE_CALLS = 3;

const TITLE_LEN_IDEAL_MIN = 50;
const TITLE_LEN_IDEAL_MAX = 70;
const TITLE_LEN_HARD_MAX = 80;
const TITLE_LEN_DROP_FLOOR = 35;

const BANNED_WORDS_RE =
  /(\bcinematic\b|\bsensory\b|\bvisceral\b|\bprofound\b|\bdesolate expanse\b|\bhumanity has ever charted\b|\bhumanity has ever mapped\b|\binexorable\b|\bvastest\b|\bthe most absolute\b|\bphysically impossible\b)/i;

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","in","on","for","to","with",
  "is","are","was","were","be","been","this","that","these","those","i",
  "you","he","she","it","we","they","my","your","his","her","its","our",
  "their","do","does","did","done","have","has","had","not","no","yes",
  "at","by","from","as","than","then","so","very","what","when","where",
  "why","how","who","which","there","here","just","like","get","got",
  "make","made","will","would","can","could","should","shall","may",
  "might","one","two","three","new","video","videos","about","into",
  "over","out","off","up","down",
]);

const IDEATION_THINKING_BUDGET: number = (() => {
  const raw = Number(process.env.ANTHROPIC_THINKING_BUDGET_IDEATION);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6000;
})();

// Compose uses Opus 4.7 for smarter coherence + voice-matching. Validator
// stays on Haiku 4.5 (mechanical check).
const OPUS_COMPOSE_MODEL = "claude-opus-4-7";
const COMPOSE_MAX_TOKENS = 8000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DroppedIdea = {
  topicLabel: string;
  proposedTitle: string;
  reason:
    | "title_too_long"
    | "title_too_short"
    | "banned_word"
    | "banned_topic"
    | "topic_overused"
    | "logical_fit"
    | "topic_dup"
    | "no_format_alternative"
    | "compose_missing"
    | "parse_failure";
  detail?: string;
};

export type SourceVideo = {
  videoId: string;
  title: string;
  youtubeUrl: string;
  thumbnailUrl: string | null;
  competitorTitle: string | null;
  competitorHandle: string | null;
  competitorSubscriberCount: number | null;
  views: number;
  channelMedian: number;
  multiplier: number;
  performanceBand: PerformanceBand;
  publishedAt: number | null;
};

export type ProposedIdea = {
  topicLabel: string;
  proposedTitle: string;
  // One-sentence rationale from the composer — surfaces in the "Why this
  // mix works" line under each idea. NEVER empty post-validator.
  coherenceRationale: string;
  // Logical-fit validator verdict + reason. logicallyCoherent=true is the
  // ship gate; fits where the retry-compose call swapped formats end up
  // here too (we trust the retry output rather than burn a 4th Claude
  // call re-validating).
  logicallyCoherent: boolean;
  logicalFitReason: string;
  // True when the slot's first compose hit a fit failure and a
  // different format from the pool produced the surviving title.
  // Drives the "🔁 Format swapped for fit" prefix in the chat output.
  formatSwapped: boolean;

  // SUBJECT source — same shape used by topicConfirmationVideos so the
  // chat agent's markdown can reuse the same rendering helper.
  topicSource: SourceVideo;
  // STRUCTURE source — same shape. videoId differs from topicSource.videoId
  // by construction (post-LLM check + retry).
  formatSource: SourceVideo;

  format: {
    id: number;
    template: string;
    exampleCount: number;
    distinctChannels: number;
    risingRate: number | null;
    isSingleChannel: boolean;
  };

  // ≥2 cross-channel videos covering the SAME topic (different competitors
  // from topicSource). Server guarantees ≥2 — single-channel clusters
  // never become TopicCandidates.
  topicConfirmationVideos: SourceVideo[];

  // Own-catalog hydration so the chat agent can render the catalog
  // verdict line inline without a second tool call.
  validation: ValidateResult;
  ownCatalogMatches: OwnCatalogMatch[];

  // Winner-aware classification computed in the per-idea pass:
  //   fresh                    no own-catalog matches at all
  //   covered_recent_winner    matches' avg multiplier ≥ 3.0 → remix candidate
  //   covered_recent_flop      matches' avg multiplier in [1.5, 3.0) → borderline
  //   covered_old              matches exist but all >90d old
  // Rows with avg < 1.5 are dropped server-side and never reach the agent.
  catalogTag:
    | "fresh"
    | "covered_recent_winner"
    | "covered_recent_flop"
    | "covered_old";
  // Highest-mult own video — populated when catalogTag is
  // "covered_recent_winner" so the agent can render
  // "remix candidate of [title](url) (3.2× your median)".
  catalogRemixSource: OwnCatalogMatch | null;

  // Optional supplementary cross-channel siblings outside the cluster —
  // used by the chat agent when topicConfirmationVideos is sparse.
  topicSimilarOutliers: TopicSimilarMatch[];
};

export type Idea = ProposedIdea;

// Per-gate attrition counters. Returned alongside ideas:[] when the
// pipeline produces zero survivors so the agent can tell HAmo WHICH gate
// consumed the candidates instead of improvising.
export type PipelineFailure = {
  outliers_pulled: number;
  clusters_after_grouping: number;
  clusters_passing_distinct_or_monster: number;
  clusters_passing_confirmation: number;
  formats_pulled: number;
  compose_returned: number;
  post_filter_survivors: number;
  validator_pass: number;
  validator_total: number;
  fail_reason: string;
};

export type GenerateIdeasResult =
  | {
      ok: true;
      ideas: ProposedIdea[];
      dropped: DroppedIdea[];
      bannedTopics: string[];
      generatedAt: number;
      model: string;
      claudeCallCount: number;
      // Present only when ideas.length === 0. Agent surfaces fail_reason
      // to the user and STOPS instead of improvising.
      pipelineFailure?: PipelineFailure;
    }
  | { ok: false; status: number; error: string; retryAfterSec?: number };

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function generateIdeasForChannel(opts: {
  userChannelId: string;
  outlierVideoIds?: string[];
  windowDays?: number;
  minMultiplier?: number;
  // Legacy knob — retained for chat-tools compatibility, ignored: the
  // Topic × Format mix pipeline always pairs every idea with a format
  // source. "free-form" no longer skips the format pool.
  mode?: "mixed" | "free-form";
}): Promise<GenerateIdeasResult> {
  const userChannelId = opts.userChannelId?.trim();
  if (!userChannelId) {
    return { ok: false, status: 400, error: "userChannelId required" };
  }
  const channel = listAllChannels().find((c) => c.id === userChannelId);
  if (!channel) {
    return {
      ok: false,
      status: 404,
      error: `Unknown userChannelId: ${userChannelId}`,
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

  const now = Math.floor(Date.now() / 1000);
  const bannedTopics = readBannedTopics(userChannelId);
  const dropped: DroppedIdea[] = [];

  // Per-gate attrition counters. Populated through the pipeline; surfaced
  // as `pipelineFailure` when the result ships ideas:[] so the chat agent
  // can tell HAmo which gate consumed the candidates.
  const stats = {
    outliers_pulled: 0,
    clusters_after_grouping: 0,
    clusters_passing_distinct_or_monster: 0,
    clusters_passing_confirmation: 0,
    formats_pulled: 0,
    compose_returned: 0,
    post_filter_survivors: 0,
    validator_pass: 0,
    validator_total: 0,
  };

  // Channel-context diagnostics — verifies the system prompt is actually
  // shipping the full description + rules to the chat agent (and therefore
  // through to the agent's "Why this for {channel}" rationale). Logged at
  // every generate_ideas invocation so HAmo can audit the chars-in vs the
  // chars-rendered in chat.
  {
    const descChars = resolveChannelDescription(
      channel as unknown as Channel
    ).length;
    const rulesChars = (
      (channel as unknown as Channel).ideation_rules ?? ""
    ).trim().length;
    log.info(
      "claude",
      `[diag] ideation_context channel=${userChannelId} description_chars=${descChars} rules_chars=${rulesChars} banned_topics_count=${bannedTopics.length}`
    );
  }

  // Wraps an ideas:[] return with the current attrition counters + a
  // fail-reason string for the chat agent.
  const failPipeline = (reason: string): GenerateIdeasResult => {
    log.info(
      "claude",
      `[diag] ideation_pipeline outliers=${stats.outliers_pulled} clusters_grouped=${stats.clusters_after_grouping} clusters_passing=${stats.clusters_passing_confirmation} formats=${stats.formats_pulled} compose_returned=${stats.compose_returned} survivors=${stats.post_filter_survivors} fail_reason=${JSON.stringify(reason)}`
    );
    return {
      ok: true,
      ideas: [],
      dropped,
      bannedTopics,
      generatedAt: now,
      model: OPUS_COMPOSE_MODEL,
      claudeCallCount: 0,
      pipelineFailure: { ...stats, fail_reason: reason },
    };
  };

  // 1. Source pool ----------------------------------------------------------
  const outlierWindow = opts.windowDays ?? OUTLIER_WINDOW_DAYS;
  const outlierMult = opts.minMultiplier ?? OUTLIER_MIN_MULTIPLIER;
  const outliers = loadOutlierPool({
    userChannelId,
    outlierVideoIds: opts.outlierVideoIds,
    windowDays: outlierWindow,
    minMultiplier: outlierMult,
    bannedTopics,
  });
  stats.outliers_pulled = outliers.length;
  if (outliers.length === 0) {
    return failPipeline(
      "No competitor outliers in the source window. Sync more competitors or widen the window."
    );
  }
  if (!opts.outlierVideoIds && outliers.length < 4) {
    return failPipeline(
      `Only ${outliers.length} outlier${outliers.length === 1 ? "" : "s"} ≥${outlierMult}× in the last ${outlierWindow} days — need ≥4 for topic clustering. Ask HAmo whether to widen the window or lower the multiplier.`
    );
  }

  // 2. Topic clustering -----------------------------------------------------
  const cluster = clusterTopics(outliers);
  stats.clusters_after_grouping = cluster.stats.totalGroups;
  stats.clusters_passing_distinct_or_monster =
    cluster.stats.passedDistinctOrMonster;
  stats.clusters_passing_confirmation = cluster.stats.passedConfirmation;
  const topicCandidates = cluster.candidates.slice(0, TOPIC_CANDIDATE_LIMIT);
  log.info(
    "claude",
    `[diag] ideation_clusters channel=${userChannelId} outliers=${outliers.length} groups=${cluster.stats.totalGroups} pass_distinct_or_monster=${cluster.stats.passedDistinctOrMonster} pass_confirmation=${cluster.stats.passedConfirmation} candidates=${topicCandidates.length}`
  );
  if (topicCandidates.length === 0) {
    return failPipeline(
      `All ${cluster.stats.totalGroups} topic clusters fell below the survival gate: need ≥${TOPIC_CLUSTER_MIN_DISTINCT_CHANNELS} distinct channels OR a single-channel monster (≥${TOPIC_CLUSTER_MONSTER_MULTIPLIER}× multiplier). Sync more competitors or widen the outlier window.`
    );
  }

  // 3. Format pool ----------------------------------------------------------
  const formatCandidates = buildFormatPool(userChannelId).slice(
    0,
    FORMAT_CANDIDATE_LIMIT
  );
  stats.formats_pulled = formatCandidates.length;
  if (formatCandidates.length === 0) {
    return failPipeline(
      "No format templates available for this channel. Run 'Re-extract trending formats' on the /outliers Trending Formats tab first."
    );
  }

  // 4. Compose call ---------------------------------------------------------
  const ctx = {
    description: resolveChannelDescription(channel as unknown as Channel),
    ideationRules: ((channel as unknown as Channel).ideation_rules ?? "").trim(),
  };
  // Compose uses Opus 4.7 for smarter coherence + voice-matching. Validator
  // stays on Haiku 4.5 (mechanical check). Cost delta per compose ~$0.20-
  // $0.40 vs ~$0.06 on Sonnet — per ideation turn worst-case ~$0.50.
  const model = OPUS_COMPOSE_MODEL;

  let claudeCallCount = 0;
  const composeResult = await runComposeCall({
    apiKey,
    model,
    topicCandidates,
    formatCandidates,
    ctx,
    bannedTopics,
  });
  claudeCallCount++;
  if (!composeResult.ok) {
    log.error("claude", `[diag] ideation_compose failed: ${composeResult.error}`);
    return { ok: false, status: 502, error: composeResult.error };
  }
  stats.compose_returned = composeResult.ideas.length;
  log.info(
    "claude",
    `[diag] ideation_call_1_compose ok=true ideas_raw=${composeResult.ideas.length}/${topicCandidates.length}`
  );

  // 5. Post-LLM JS filters --------------------------------------------------
  const topicByLabel = new Map(topicCandidates.map((t) => [t.topicLabel, t]));
  const formatById = new Map(formatCandidates.map((f) => [f.formatId, f]));

  type ComposedSlot = {
    topicLabel: string;
    proposedTitle: string;
    coherenceRationale: string;
    topicSourceVideoId: string;
    formatId: number;
    formatSourceVideoId: string;
    formatSwapped: boolean;
    // Winner-aware catalog classification — see ProposedIdea.catalogTag
    // doc for the threshold logic (avg multiplier across own-catalog
    // matches: <1.5 drops, ≥3.0 winner, in between flop).
    catalogTag:
      | "fresh"
      | "covered_recent_winner"
      | "covered_recent_flop"
      | "covered_old";
    catalogRemixSource: OwnCatalogMatch | null;
  };

  const prelim: ComposedSlot[] = [];
  for (const idea of composeResult.ideas) {
    const topic = topicByLabel.get(idea.topicLabel);
    const format = formatById.get(idea.formatId);
    if (!topic || !format) continue;

    // Re-anchor to a known source pair. Trust the model's choice when
    // it matches the candidate pool; otherwise pin to the candidate's
    // declared sources.
    const topicSourceVideoId =
      idea.topicSourceVideoId === topic.topicSourceVideo.videoId ||
      topic.topicConfirmationVideos.some(
        (v) => v.videoId === idea.topicSourceVideoId
      )
        ? idea.topicSourceVideoId
        : topic.topicSourceVideo.videoId;
    const formatSourceVideoId =
      idea.formatSourceVideoId === format.formatSourceVideo.videoId ||
      format.formatConfirmationVideos.some(
        (v) => v.videoId === idea.formatSourceVideoId
      )
        ? idea.formatSourceVideoId
        : format.formatSourceVideo.videoId;

    if (topicSourceVideoId === formatSourceVideoId) {
      dropped.push({
        topicLabel: idea.topicLabel,
        proposedTitle: idea.proposedTitle,
        reason: "logical_fit",
        detail: "topic source and format source resolved to the same video — discarded",
      });
      continue;
    }

    // Length + banned-word + banned-topic + frequency drops (no retry).
    const lenBand = titleLengthBandFor(idea.proposedTitle);
    if (lenBand === "rejected" || lenBand === "too_long") {
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
    const bannedWord = bannedWordMatch(idea.proposedTitle);
    if (bannedWord) {
      dropped.push({
        topicLabel: idea.topicLabel,
        proposedTitle: idea.proposedTitle,
        reason: "banned_word",
        detail: `contains banned term "${bannedWord}"`,
      });
      continue;
    }
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
    // Winner-aware catalog gate. Drops only when the user's matching
    // own videos averaged below CATALOG_DROP_AVG_MULTIPLIER (dead-horse
    // topic). Above that floor, ships with a tag the agent surfaces:
    //   - no matches            → fresh
    //   - all matches >90d old  → covered_old (cooled but safe to revisit)
    //   - avg ≥ 3.0             → covered_recent_winner (remix candidate)
    //   - 1.5 ≤ avg < 3.0       → covered_recent_flop (borderline; HAmo decides)
    //   - avg < 1.5             → drop (dead horse)
    const ownMatches = findOwnCatalogTopicMatches(
      idea.topicLabel,
      userChannelId,
      { limit: 5 }
    );
    let catalogTag: ComposedSlot["catalogTag"] = "fresh";
    let catalogRemixSource: OwnCatalogMatch | null = null;
    if (ownMatches.length > 0) {
      const recentCutoff = now - CATALOG_OLD_DAYS * 86400;
      const recent = ownMatches.filter(
        (m) => m.publishedAt !== null && m.publishedAt >= recentCutoff
      );
      if (recent.length === 0) {
        catalogTag = "covered_old";
      } else {
        const avg =
          recent.reduce((a, m) => a + m.multiplier, 0) / recent.length;
        if (avg < CATALOG_DROP_AVG_MULTIPLIER) {
          dropped.push({
            topicLabel: idea.topicLabel,
            proposedTitle: idea.proposedTitle,
            reason: "topic_overused",
            detail: `recent own coverage averaged ${avg.toFixed(1)}× — dead horse (e.g. "${recent[0].title}" at ${recent[0].multiplier}×)`,
          });
          continue;
        }
        if (avg >= CATALOG_WINNER_AVG_MULTIPLIER) {
          catalogTag = "covered_recent_winner";
          catalogRemixSource = recent.reduce((acc, m) =>
            m.multiplier > acc.multiplier ? m : acc
          );
        } else {
          catalogTag = "covered_recent_flop";
        }
      }
    }

    prelim.push({
      topicLabel: idea.topicLabel,
      proposedTitle: idea.proposedTitle,
      coherenceRationale: idea.coherenceRationale,
      topicSourceVideoId,
      formatId: idea.formatId,
      formatSourceVideoId,
      formatSwapped: false,
      catalogTag,
      catalogRemixSource,
    });
  }

  stats.post_filter_survivors = prelim.length;

  // 6. Logical-fit validator -----------------------------------------------
  const validatorInputs: LogicalFitInput[] = prelim.map((slot, idx) => {
    const topic = topicByLabel.get(slot.topicLabel)!;
    const format = formatById.get(slot.formatId)!;
    const topicSource =
      topic.topicSourceVideo.videoId === slot.topicSourceVideoId
        ? topic.topicSourceVideo
        : topic.topicConfirmationVideos.find(
            (v) => v.videoId === slot.topicSourceVideoId
          ) ?? topic.topicSourceVideo;
    const formatSource =
      format.formatSourceVideo.videoId === slot.formatSourceVideoId
        ? format.formatSourceVideo
        : format.formatConfirmationVideos.find(
            (v) => v.videoId === slot.formatSourceVideoId
          ) ?? format.formatSourceVideo;
    return {
      ideaIndex: idx,
      topicSourceTitle: topicSource.title,
      formatSourceTitle: formatSource.title,
      proposedTitle: slot.proposedTitle,
      coherenceRationale: slot.coherenceRationale,
    };
  });

  const verdicts = new Map<number, { logicallyCoherent: boolean; reason: string }>();
  if (validatorInputs.length > 0 && claudeCallCount < MAX_CLAUDE_CALLS) {
    const fit = await checkLogicalFit(validatorInputs);
    claudeCallCount++;
    if (!fit.ok) {
      // Validator failure → ship all prelim slots with logicallyCoherent=true
      // (better than no ideas at all). Diagnostic already logged.
      for (const i of validatorInputs) {
        verdicts.set(i.ideaIndex, {
          logicallyCoherent: true,
          reason: "validator unavailable",
        });
      }
      log.warn(
        "claude",
        `[diag] ideation_call_2_validator failed; defaulting all=pass: ${fit.error}`
      );
    } else {
      for (const v of fit.verdicts) {
        verdicts.set(v.ideaIndex, {
          logicallyCoherent: v.logicallyCoherent,
          reason: v.reason,
        });
      }
      const passes = fit.verdicts.filter((v) => v.logicallyCoherent).length;
      stats.validator_total = fit.verdicts.length;
      stats.validator_pass = passes;
      log.info(
        "claude",
        `[diag] ideation_call_2_validator total=${fit.verdicts.length} pass=${passes} fail=${fit.verdicts.length - passes}`
      );
    }
  }

  // Slots that passed validation flow straight to surviving; slots that
  // failed enter the retry queue (with their current format banned so the
  // retry picks a different one).
  const survivors: ComposedSlot[] = [];
  const failedSlots: Array<{ slot: ComposedSlot; failedFormatIds: Set<number>; reason: string }> = [];
  for (let i = 0; i < prelim.length; i++) {
    const slot = prelim[i];
    const v = verdicts.get(i);
    if (!v) {
      // Validator wasn't called (call cap or empty input) — trust compose.
      survivors.push({ ...slot, formatSwapped: false });
      continue;
    }
    if (v.logicallyCoherent) {
      survivors.push({ ...slot, formatSwapped: false });
    } else {
      failedSlots.push({
        slot,
        failedFormatIds: new Set([slot.formatId]),
        reason: v.reason,
      });
    }
  }

  // 7. Format-swap retry compose -------------------------------------------
  if (failedSlots.length > 0 && claudeCallCount < MAX_CLAUDE_CALLS) {
    const retryPayload = failedSlots
      .map(({ slot, failedFormatIds, reason }) => {
        const topic = topicByLabel.get(slot.topicLabel);
        if (!topic) return null;
        const alternatives = formatCandidates
          .filter((f) => !failedFormatIds.has(f.formatId))
          .slice(0, MAX_FORMAT_SWAPS_PER_SLOT);
        if (alternatives.length === 0) return null;
        return {
          slot,
          topic,
          alternatives,
          reason,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    if (retryPayload.length > 0) {
      const retry = await runRetryComposeCall({
        apiKey,
        model,
        payload: retryPayload,
        ctx,
      });
      claudeCallCount++;
      if (retry.ok) {
        log.info(
          "claude",
          `[diag] ideation_call_3_retry returned=${retry.ideas.length}/${retryPayload.length}`
        );
        const retryByLabel = new Map(retry.ideas.map((r) => [r.topicLabel, r]));
        for (const { slot, failedFormatIds } of failedSlots) {
          const r = retryByLabel.get(slot.topicLabel);
          if (!r) {
            dropped.push({
              topicLabel: slot.topicLabel,
              proposedTitle: slot.proposedTitle,
              reason: "logical_fit",
              detail: "retry produced no replacement",
            });
            continue;
          }
          if (failedFormatIds.has(r.formatId)) {
            dropped.push({
              topicLabel: slot.topicLabel,
              proposedTitle: slot.proposedTitle,
              reason: "no_format_alternative",
              detail: "retry returned the same banned format id",
            });
            continue;
          }
          const format = formatById.get(r.formatId);
          const topic = topicByLabel.get(slot.topicLabel);
          if (!format || !topic) continue;
          // Re-validate JS-side filters on the retry title.
          const lenBand = titleLengthBandFor(r.proposedTitle);
          if (lenBand === "rejected" || lenBand === "too_long") {
            dropped.push({
              topicLabel: slot.topicLabel,
              proposedTitle: r.proposedTitle,
              reason: "title_too_long",
              detail: `retry ${r.proposedTitle.length} chars`,
            });
            continue;
          }
          if (bannedWordMatch(r.proposedTitle)) {
            dropped.push({
              topicLabel: slot.topicLabel,
              proposedTitle: r.proposedTitle,
              reason: "banned_word",
              detail: "retry contained banned term",
            });
            continue;
          }
          const bannedHit = bannedTopicMatch(
            slot.topicLabel,
            r.proposedTitle,
            bannedTopics
          );
          if (bannedHit) {
            dropped.push({
              topicLabel: slot.topicLabel,
              proposedTitle: r.proposedTitle,
              reason: "banned_topic",
              detail: `retry matched banned term "${bannedHit}"`,
            });
            continue;
          }
          // Resolve source ids on the retry. topic source stays the
          // cluster's primary; format source resolves to the new format's
          // primary example. We do NOT re-call the validator on retry
          // output (would exceed the 3-call cap).
          const topicSourceVideoId =
            r.topicSourceVideoId === topic.topicSourceVideo.videoId ||
            topic.topicConfirmationVideos.some(
              (v) => v.videoId === r.topicSourceVideoId
            )
              ? r.topicSourceVideoId
              : topic.topicSourceVideo.videoId;
          const formatSourceVideoId =
            r.formatSourceVideoId === format.formatSourceVideo.videoId ||
            format.formatConfirmationVideos.some(
              (v) => v.videoId === r.formatSourceVideoId
            )
              ? r.formatSourceVideoId
              : format.formatSourceVideo.videoId;
          if (topicSourceVideoId === formatSourceVideoId) {
            dropped.push({
              topicLabel: slot.topicLabel,
              proposedTitle: r.proposedTitle,
              reason: "logical_fit",
              detail: "retry pair resolved to same video",
            });
            continue;
          }
          survivors.push({
            topicLabel: slot.topicLabel,
            proposedTitle: r.proposedTitle,
            coherenceRationale: r.coherenceRationale,
            topicSourceVideoId,
            formatId: r.formatId,
            formatSourceVideoId,
            formatSwapped: true,
            // Carry through the original slot's catalog classification —
            // the topic didn't change, only the format did.
            catalogTag: slot.catalogTag,
            catalogRemixSource: slot.catalogRemixSource,
          });
        }
      } else {
        log.warn(
          "claude",
          `[diag] ideation_call_3_retry failed: ${retry.error}; dropping ${failedSlots.length} slots`
        );
        for (const { slot, reason } of failedSlots) {
          dropped.push({
            topicLabel: slot.topicLabel,
            proposedTitle: slot.proposedTitle,
            reason: "logical_fit",
            detail: `retry call errored — original fail reason: ${reason}`,
          });
        }
      }
    } else {
      // No alternatives available — drop without burning the call.
      for (const { slot, reason } of failedSlots) {
        dropped.push({
          topicLabel: slot.topicLabel,
          proposedTitle: slot.proposedTitle,
          reason: "no_format_alternative",
          detail: `no alternative format in pool — fit fail: ${reason}`,
        });
      }
    }
  } else if (failedSlots.length > 0) {
    // Call cap reached — drop all failures.
    for (const { slot, reason } of failedSlots) {
      dropped.push({
        topicLabel: slot.topicLabel,
        proposedTitle: slot.proposedTitle,
        reason: "logical_fit",
        detail: `call cap reached — fail reason: ${reason}`,
      });
    }
  }

  // Topic-cluster dedup: keep one survivor per topicLabel.
  const seen = new Set<string>();
  const deduped: ComposedSlot[] = [];
  for (const s of survivors) {
    const key = s.topicLabel.toLowerCase().trim();
    if (seen.has(key)) {
      dropped.push({
        topicLabel: s.topicLabel,
        proposedTitle: s.proposedTitle,
        reason: "topic_dup",
        detail: `topic "${s.topicLabel}" already shipped`,
      });
      continue;
    }
    seen.add(key);
    deduped.push(s);
  }

  // 8. Hydrate per-idea -----------------------------------------------------
  const ideas: ProposedIdea[] = [];
  for (const slot of deduped) {
    const topic = topicByLabel.get(slot.topicLabel);
    const format = formatById.get(slot.formatId);
    if (!topic || !format) continue;
    const topicSource =
      topic.topicSourceVideo.videoId === slot.topicSourceVideoId
        ? topic.topicSourceVideo
        : topic.topicConfirmationVideos.find(
            (v) => v.videoId === slot.topicSourceVideoId
          ) ?? topic.topicSourceVideo;
    const formatSource =
      format.formatSourceVideo.videoId === slot.formatSourceVideoId
        ? format.formatSourceVideo
        : format.formatConfirmationVideos.find(
            (v) => v.videoId === slot.formatSourceVideoId
          ) ?? format.formatSourceVideo;

    // Topic confirmation = all cluster siblings EXCEPT topicSource,
    // capped at TOPIC_CONFIRMATION_MAX. Spec requires ≥2 cross-channel
    // proofs; the cluster filter already guarantees ≥2 distinct
    // channels in the cluster, so this is non-empty.
    const topicConfirmationVideos = topic.topicConfirmationVideos
      .filter((v) => v.videoId !== topicSource.videoId)
      .slice(0, TOPIC_CONFIRMATION_MAX);

    const validation = validateIdeaAgainstOwnCatalog({
      topic: slot.topicLabel,
      userChannelId,
    });
    const ownCatalogMatches = findOwnCatalogTopicMatches(
      slot.topicLabel,
      userChannelId,
      { limit: 3 }
    );
    const topicSimilarOutliers = findTopicSimilarOutliers(
      slot.topicLabel,
      userChannelId,
      {
        limit: 3,
        excludeVideoIds: [topicSource.videoId, formatSource.videoId],
      }
    );

    const verdict = verdicts.get(
      prelim.findIndex((p) => p.topicLabel === slot.topicLabel)
    );
    const idea: ProposedIdea = {
      topicLabel: slot.topicLabel,
      proposedTitle: slot.proposedTitle,
      coherenceRationale: slot.coherenceRationale,
      logicallyCoherent: true,
      logicalFitReason: slot.formatSwapped
        ? "swapped format after first compose failed fit"
        : verdict?.reason ?? "passed logical fit on first compose",
      formatSwapped: slot.formatSwapped,
      topicSource,
      formatSource,
      format: {
        id: format.formatId,
        template: format.template,
        exampleCount: format.exampleCount,
        distinctChannels: format.distinctChannels,
        risingRate: format.risingRate,
        isSingleChannel: format.isSingleChannel,
      },
      topicConfirmationVideos,
      validation,
      ownCatalogMatches,
      catalogTag: slot.catalogTag,
      catalogRemixSource: slot.catalogRemixSource,
      topicSimilarOutliers,
    };
    ideas.push(idea);
  }

  const dropCounts: Record<string, number> = {};
  for (const d of dropped) {
    dropCounts[d.reason] = (dropCounts[d.reason] ?? 0) + 1;
  }
  log.info(
    "claude",
    `[diag] ideation_done channel=${userChannelId} shipped=${ideas.length} dropped=${dropped.length} drops=${JSON.stringify(dropCounts)} calls=${claudeCallCount}/${MAX_CLAUDE_CALLS}`
  );
  log.info(
    "claude",
    `[diag] ideation_pipeline outliers=${stats.outliers_pulled} clusters_grouped=${stats.clusters_after_grouping} clusters_passing=${stats.clusters_passing_confirmation} formats=${stats.formats_pulled} compose_returned=${stats.compose_returned} survivors=${stats.post_filter_survivors} shipped=${ideas.length}`
  );

  // Empty-pipeline branch: attach the attrition + a human-readable
  // fail_reason so the chat agent can report which gate consumed the
  // candidates rather than improvising.
  let pipelineFailure: PipelineFailure | undefined;
  if (ideas.length === 0) {
    let reason: string;
    if (stats.compose_returned === 0) {
      reason = "Claude compose returned 0 ideas. Re-run; if persistent, the topic/format pool may be too sparse — sync more competitors or widen the outlier window.";
    } else if (stats.post_filter_survivors === 0) {
      const topReason = Object.entries(dropCounts).sort(
        (a, b) => b[1] - a[1]
      )[0];
      reason = `All ${stats.compose_returned} composed ideas dropped in the post-filter (top reason: ${topReason ? `${topReason[0]} × ${topReason[1]}` : "unknown"}).`;
    } else if (stats.validator_total > 0 && stats.validator_pass === 0) {
      reason = `Logical-fit validator rejected all ${stats.validator_total} composed ideas and the format-swap retry didn't recover any. The topic × format pairings produced fabrications the validator couldn't accept.`;
    } else {
      reason = "Pipeline drained candidates across multiple gates without surfacing a dominant cause. See dropped[] for per-idea reasons.";
    }
    pipelineFailure = { ...stats, fail_reason: reason };
  }

  return {
    ok: true,
    ideas,
    dropped,
    bannedTopics,
    generatedAt: now,
    model,
    claudeCallCount,
    ...(pipelineFailure ? { pipelineFailure } : {}),
  };
}

// ---------------------------------------------------------------------------
// Source pool
// ---------------------------------------------------------------------------

type OutlierLite = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  views: number;
  channelMedian: number;
  multiplier: number;
  publishedAt: number | null;
  competitorId: number | null;
  competitorTitle: string | null;
  competitorHandle: string | null;
  competitorChannelId: string | null;
  competitorSubscriberCount: number | null;
  performanceBand: PerformanceBand;
};

function loadOutlierPool(opts: {
  userChannelId: string;
  outlierVideoIds?: string[];
  windowDays: number;
  minMultiplier: number;
  bannedTopics: string[];
}): OutlierLite[] {
  const { userChannelId, outlierVideoIds, windowDays, minMultiplier, bannedTopics } = opts;
  let rows: OutlierLite[] = [];
  if (outlierVideoIds && outlierVideoIds.length > 0) {
    const fetched = getCompetitorVideosByIds(
      outlierVideoIds.slice(0, OUTLIER_SOURCE_LIMIT)
    );
    const medians = new Map<number, number>();
    for (const cid of new Set(fetched.map((r) => r.competitorId))) {
      medians.set(cid, competitorMedianViews(cid));
    }
    rows = fetched.map((r) => {
      const median = medians.get(r.competitorId) ?? 0;
      const mult = median > 0 ? r.views / median : 0;
      return {
        videoId: r.videoId,
        title: r.title,
        thumbnailUrl: ytThumbnail(r.videoId),
        views: r.views,
        channelMedian: median,
        multiplier: Math.round(mult * 10) / 10,
        publishedAt: r.publishedAt,
        competitorId: r.competitorId,
        competitorTitle: r.competitorTitle,
        competitorHandle: r.competitorHandle ?? null,
        competitorChannelId: r.competitorChannelId ?? null,
        competitorSubscriberCount: null,
        performanceBand: performanceBandFor(mult),
      };
    });
  } else {
    const { outliers } = listOutliersForActiveChannel({
      userChannelId,
      windowDays,
      minMultiplier,
      limit: OUTLIER_SOURCE_LIMIT,
    });
    rows = outliers.map((o) => ({
      videoId: o.videoId,
      title: o.title,
      thumbnailUrl: o.thumbnailUrl ?? ytThumbnail(o.videoId),
      views: o.views,
      channelMedian: o.channelMedian,
      multiplier: o.multiplier,
      publishedAt: o.publishedAt,
      competitorId: o.competitorId,
      competitorTitle: o.competitorTitle,
      competitorHandle: o.competitorHandle ?? null,
      competitorChannelId: o.competitorChannelId ?? null,
      competitorSubscriberCount: o.competitorSubscriberCount,
      performanceBand: performanceBandFor(o.multiplier),
    }));
  }

  // Defense-in-depth: strip own-channel rows and banned-topic rows.
  rows = rows.filter(
    (r) =>
      !(r.competitorChannelId !== null && r.competitorChannelId === userChannelId)
  );
  if (bannedTopics.length > 0) {
    rows = rows.filter((r) => {
      const haystack = (r.title ?? "").toLowerCase();
      for (const term of bannedTopics) {
        if (term && haystack.includes(term)) return false;
      }
      return true;
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Topic clustering — JS-only
// ---------------------------------------------------------------------------

type TopicCandidate = {
  topicLabel: string;
  // Highest-multiplier video in the cluster.
  topicSourceVideo: SourceVideo;
  // Remaining cluster members from different competitors. Always ≥2 by
  // construction (cluster wouldn't survive otherwise).
  topicConfirmationVideos: SourceVideo[];
  distinctChannels: number;
  maxMultiplier: number;
  mostRecent: number;
  sharedNouns: string[];
};

function tokenize(s: string): string[] {
  // Strip brand phrases ("james webb", "voyager 2", "nasa", etc.) so
  // same-instrument titles don't collapse to the same topic. The brand
  // list lives in validate-idea.ts (shared with the frequency/own-catalog
  // helpers).
  const stripped = stripBrandPhrases(
    s.toLowerCase().replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of stripped.split(/\s+/)) {
    if (!raw || raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function clusterTopics(
  outliers: OutlierLite[]
): { candidates: TopicCandidate[]; stats: ClusterStats } {
  if (outliers.length === 0) {
    return {
      candidates: [],
      stats: { totalGroups: 0, passedDistinctOrMonster: 0, passedConfirmation: 0 },
    };
  }
  const tokens = outliers.map((o) => new Set(tokenize(o.title)));

  // Union-find: edge when two videos share ≥TOPIC_CLUSTER_MIN_SHARED_NOUNS.
  const parent = outliers.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < outliers.length; i++) {
    for (let j = i + 1; j < outliers.length; j++) {
      let shared = 0;
      for (const t of tokens[i]) {
        if (tokens[j].has(t)) shared++;
        if (shared >= TOPIC_CLUSTER_MIN_SHARED_NOUNS) break;
      }
      if (shared >= TOPIC_CLUSTER_MIN_SHARED_NOUNS) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < outliers.length; i++) {
    const root = find(i);
    const g = groups.get(root) ?? [];
    g.push(i);
    groups.set(root, g);
  }

  const candidates: TopicCandidate[] = [];
  let passedDistinctOrMonster = 0;
  let passedConfirmation = 0;
  for (const [, indices] of groups) {
    const members = indices.map((i) => outliers[i]);
    // distinct_channels — use competitorChannelId when present, else
    // competitor_id (numeric). Both keyed on the competitor row.
    const channelKey = (m: OutlierLite) =>
      m.competitorChannelId ?? `cid:${m.competitorId ?? "?"}`;
    const distinctChannels = new Set(members.map(channelKey)).size;
    const maxMultiplier = members.reduce(
      (acc, m) => (m.multiplier > acc ? m.multiplier : acc),
      0
    );

    // Survival gate: ≥2 distinct channels OR a single-channel monster
    // (≥10× — magnitude alone is its own cross-channel validation).
    const isMonster =
      distinctChannels < TOPIC_CLUSTER_MIN_DISTINCT_CHANNELS &&
      maxMultiplier >= TOPIC_CLUSTER_MONSTER_MULTIPLIER;
    if (distinctChannels < TOPIC_CLUSTER_MIN_DISTINCT_CHANNELS && !isMonster) {
      continue;
    }
    passedDistinctOrMonster++;

    // Token aggregation → topicLabel. For multi-member clusters, require
    // a noun to appear in ≥2 members; for single-member monsters, fall
    // back to the source video's own (brand-stripped) tokens so the
    // topic still has a recognizable label.
    const tokenCounts = new Map<string, number>();
    for (const idx of indices) {
      for (const t of tokens[idx]) {
        tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
      }
    }
    const sharedNouns =
      indices.length >= 2
        ? [...tokenCounts.entries()]
            .filter(([, n]) => n >= 2)
            .sort((a, b) => b[1] - a[1])
            .map(([t]) => t)
            .slice(0, 5)
        : [...tokens[indices[0]]].slice(0, 5);
    if (sharedNouns.length === 0) continue;
    const topicLabel = sharedNouns.slice(0, 3).join(" ");

    members.sort((a, b) => b.multiplier - a.multiplier);
    const topicSourceLite = members[0];
    const topicSourceVideo = toSourceVideo(topicSourceLite);
    const remainingByChannel = new Map<string, SourceVideo[]>();
    for (const m of members.slice(1)) {
      const key = channelKey(m);
      if (key === channelKey(topicSourceLite)) continue;
      const arr = remainingByChannel.get(key) ?? [];
      arr.push(toSourceVideo(m));
      remainingByChannel.set(key, arr);
    }
    const topicConfirmationVideos: SourceVideo[] = [];
    for (const arr of remainingByChannel.values()) {
      if (topicConfirmationVideos.length >= TOPIC_CONFIRMATION_MAX) break;
      topicConfirmationVideos.push(arr[0]);
    }
    // Confirmation requirement: cross-channel clusters need ≥2 sibling
    // videos from different competitors. Monsters bypass this — the
    // ≥10× multiplier IS the validation.
    if (!isMonster && topicConfirmationVideos.length < TOPIC_CONFIRMATION_MIN) {
      continue;
    }
    passedConfirmation++;

    const mostRecent = members.reduce(
      (acc, m) => Math.max(acc, m.publishedAt ?? 0),
      0
    );

    candidates.push({
      topicLabel,
      topicSourceVideo,
      topicConfirmationVideos,
      distinctChannels,
      maxMultiplier,
      mostRecent,
      sharedNouns,
    });
  }

  // Prefer cross-channel clusters first; monsters fill in below them.
  candidates.sort((a, b) => {
    if (b.distinctChannels !== a.distinctChannels)
      return b.distinctChannels - a.distinctChannels;
    if (b.maxMultiplier !== a.maxMultiplier)
      return b.maxMultiplier - a.maxMultiplier;
    return b.mostRecent - a.mostRecent;
  });
  return {
    candidates,
    stats: {
      totalGroups: groups.size,
      passedDistinctOrMonster,
      passedConfirmation,
    },
  };
}

export type ClusterStats = {
  totalGroups: number;
  passedDistinctOrMonster: number;
  passedConfirmation: number;
};

function toSourceVideo(o: OutlierLite): SourceVideo {
  return {
    videoId: o.videoId,
    title: o.title,
    youtubeUrl: `https://www.youtube.com/watch?v=${o.videoId}`,
    thumbnailUrl: o.thumbnailUrl,
    competitorTitle: o.competitorTitle,
    competitorHandle: o.competitorHandle,
    competitorSubscriberCount: o.competitorSubscriberCount,
    views: o.views,
    channelMedian: o.channelMedian,
    multiplier: o.multiplier,
    performanceBand: o.performanceBand,
    publishedAt: o.publishedAt,
  };
}

// ---------------------------------------------------------------------------
// Format pool
// ---------------------------------------------------------------------------

type FormatCandidate = {
  formatId: number;
  template: string;
  exampleCount: number;
  distinctChannels: number;
  risingRate: number | null;
  avgMultiplier: number | null;
  isSingleChannel: boolean;
  formatSourceVideo: SourceVideo;
  formatConfirmationVideos: SourceVideo[];
};

function buildFormatPool(userChannelId: string): FormatCandidate[] {
  const formats = getFormatsForChannel(userChannelId, 50);
  const out: FormatCandidate[] = [];
  for (const f of formats) {
    if (f.examples.length < FORMAT_MIN_EXAMPLES) continue;
    const sorted = [...f.examples].sort(
      (a, b) => (b.multiplierAtExtract || 0) - (a.multiplierAtExtract || 0)
    );
    const formatSourceLite = sorted[0];
    const formatSourceVideo = formatExampleToSource(formatSourceLite);
    const confirmations: SourceVideo[] = sorted
      .slice(1, 1 + FORMAT_CONFIRMATION_TARGET)
      .map(formatExampleToSource);
    const distinctChannels = new Set(
      f.examples.map((e) => e.competitorTitle ?? `cid:${e.competitorId}`)
    ).size;
    out.push({
      formatId: f.id,
      template: f.template,
      exampleCount: f.examples.length,
      distinctChannels,
      risingRate: f.risingRate,
      avgMultiplier: f.avgMultiplier,
      isSingleChannel: f.isSingleChannel,
      formatSourceVideo,
      formatConfirmationVideos: confirmations,
    });
  }
  out.sort((a, b) => {
    if ((b.risingRate ?? 0) !== (a.risingRate ?? 0))
      return (b.risingRate ?? 0) - (a.risingRate ?? 0);
    if (b.exampleCount !== a.exampleCount)
      return b.exampleCount - a.exampleCount;
    return (b.avgMultiplier ?? 0) - (a.avgMultiplier ?? 0);
  });
  return out;
}

function formatExampleToSource(
  e: ReturnType<typeof getFormatsForChannel>[number]["examples"][number]
): SourceVideo {
  const mult = e.multiplierAtExtract ?? 0;
  return {
    videoId: e.videoId,
    title: e.title,
    youtubeUrl: `https://www.youtube.com/watch?v=${e.videoId}`,
    thumbnailUrl: e.thumbnailUrl ?? ytThumbnail(e.videoId),
    competitorTitle: e.competitorTitle,
    competitorHandle: e.competitorHandle,
    competitorSubscriberCount: e.competitorSubs,
    views: e.views,
    // The format-example row doesn't carry the competitor's own median;
    // best-effort fallback is to back-compute median = views / multiplier
    // when multiplier > 0. Renders close enough for the markdown — when
    // multiplier is 0 we leave channelMedian at 0 and the chat agent
    // renders "(unknown)".
    channelMedian: mult > 0 ? Math.round(e.views / mult) : 0,
    multiplier: Math.round(mult * 10) / 10,
    performanceBand: performanceBandFor(mult),
    publishedAt: e.publishedAt,
  };
}

// ---------------------------------------------------------------------------
// Claude #1 — compose
// ---------------------------------------------------------------------------

type ComposeOutput = {
  topicLabel: string;
  topicSourceVideoId: string;
  formatId: number;
  formatSourceVideoId: string;
  proposedTitle: string;
  coherenceRationale: string;
};

type ComposeResult =
  | { ok: true; ideas: ComposeOutput[] }
  | { ok: false; error: string };

async function runComposeCall(opts: {
  apiKey: string;
  model: string;
  topicCandidates: TopicCandidate[];
  formatCandidates: FormatCandidate[];
  ctx: { description: string; ideationRules: string };
  bannedTopics: string[];
}): Promise<ComposeResult> {
  const { apiKey, model, topicCandidates, formatCandidates, ctx, bannedTopics } = opts;
  const systemPrompt = buildComposeSystemPrompt({
    ideationRules: ctx.ideationRules,
    bannedTopics,
  });
  const userBody = buildComposeUserBody({
    ctx,
    topicCandidates,
    formatCandidates,
  });
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: COMPOSE_MAX_TOKENS,
      temperature: 1,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
      // Opus 4.7 requires the adaptive thinking shape (per the SDK
      // 400 error: "thinking.type.enabled is not supported for this
      // model"). "summarized" display matches the prior reasoning
      // surface; "effort=high" caps the thinking budget at the high
      // tier, roughly equivalent to the prior 6000-token budget on
      // Sonnet 4.6.
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const parsed = parseComposeOutput(
      text,
      new Set(topicCandidates.map((t) => t.topicLabel)),
      new Set(formatCandidates.map((f) => f.formatId))
    );
    if (!parsed) {
      return { ok: false, error: "compose returned malformed JSON" };
    }
    return { ok: true, ideas: parsed };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "compose call failed",
    };
  }
}

function buildComposeSystemPrompt(opts: {
  ideationRules: string;
  bannedTopics: string[];
}): string {
  const ideationRulesBlock = opts.ideationRules
    ? [
        "# PER-CHANNEL IDEATION RULES (HARD enforcement)",
        opts.ideationRules,
        "",
      ]
    : [];
  const bannedBlock =
    opts.bannedTopics.length > 0
      ? [
          "# BANNED TOPICS",
          "NEVER propose a title touching any term below as a substring (case-insensitive). Skip the slot rather than ship a banned-topic title.",
          ...opts.bannedTopics.map((t) => `- ${t}`),
          "",
        ]
      : [];
  return [
    "You compose NEW YouTube video title ideas by MIXING a TOPIC from one viral video with a FORMAT (title-shape template) from a DIFFERENT viral video.",
    "",
    "# THE NON-NEGOTIABLE RULE",
    "Topic provides SUBJECT. Format provides STRUCTURE. They cannot create FABRICATED facts together. A title that says \"James Webb Found a Black Hole\" when the topic source is Webb biosignatures and the format source is a Sagittarius A* video is INCOHERENT — Webb did not find a black hole. The mix must describe a video a viewer could plausibly watch on the topic source's subject.",
    "",
    "# WORKFLOW",
    "1. For EACH topic candidate listed below, compose EXACTLY ONE new title.",
    "2. Pick the BEST-FITTING format from the trending-formats pool. The topic source video and the format source video MUST BE DIFFERENT videos — your output's topicSourceVideoId and formatSourceVideoId cannot match.",
    "3. Apply the format's structure to the topic's subject. Do NOT copy the topic source's phrasing. Do NOT invent facts the topic source doesn't support.",
    "4. Produce a one-sentence coherenceRationale explaining WHY the mix works — what about the format's structure transfers cleanly onto the topic's subject without fabricating a connection.",
    "",
    "# OUTPUT CONSTRAINTS",
    `- proposedTitle: 50-70 chars ideal, 80 chars hard ceiling, ${TITLE_LEN_DROP_FLOOR}+ floor.`,
    "- Plain words a 14-year-old reads in <2 seconds. NEVER use: cinematic, sensory, visceral, profound, desolate expanse, humanity has ever charted, humanity has ever mapped, inexorable, vastest, the most absolute, physically impossible.",
    "- Mirror the lexical register of the topic source's competitor outliers.",
    "- topicLabel MUST match a topic candidate's label below.",
    "- formatId MUST be one of the numeric ids listed in the format pool.",
    "- topicSourceVideoId MUST be the topic candidate's primary source OR one of its confirmation video ids.",
    "- formatSourceVideoId MUST be the chosen format's primary source OR one of its confirmation video ids.",
    "- topicSourceVideoId !== formatSourceVideoId. ALWAYS.",
    "- coherenceRationale: 1 short sentence (≤180 chars). NEVER empty.",
    "- STALE-TOPIC RULE: if the chosen topic source is older than 30 days (see the `age_days` field below each topic candidate), the proposedTitle MUST be a fresh STRUCTURAL REFRAME — not a paraphrase of the source title. Swap the rhetorical move, change the verb, invert the angle. State the transformation explicitly in coherenceRationale (e.g. \"reframes the 60-day-old detection story as a forensic re-investigation\").",
    "",
    ...ideationRulesBlock,
    ...bannedBlock,
    "Return ONLY a JSON object. No prose, no markdown, no code fence.",
    "{",
    '  "ideas": [',
    "    {",
    '      "topicLabel": string,',
    '      "topicSourceVideoId": string,',
    '      "formatId": number,',
    '      "formatSourceVideoId": string,',
    '      "proposedTitle": string,',
    '      "coherenceRationale": string',
    "    }",
    "  ]",
    "}",
  ].join("\n");
}

function buildComposeUserBody(opts: {
  ctx: { description: string; ideationRules: string };
  topicCandidates: TopicCandidate[];
  formatCandidates: FormatCandidate[];
}): string {
  const { ctx, topicCandidates, formatCandidates } = opts;
  const lines: string[] = [];
  lines.push("# USER CHANNEL CONTEXT");
  lines.push("## About this channel");
  lines.push(
    ctx.description.length > 0
      ? ctx.description
      : "(not set — ask the user to fill /channel-info or the Brain panel in /chat)"
  );
  lines.push("");
  lines.push(`# TOPIC CANDIDATES (${topicCandidates.length})`);
  lines.push(
    "Each topic is a cluster of cross-channel outliers sharing content nouns. Compose EXACTLY ONE title per topicLabel."
  );
  for (const t of topicCandidates) {
    lines.push("");
    lines.push(`## ${t.topicLabel}`);
    lines.push(
      `- distinct_channels=${t.distinctChannels}, max_multiplier=${t.maxMultiplier.toFixed(1)}×, shared_nouns=${t.sharedNouns.join(",")}`
    );
    const topicAge = ageDaysOrUnknown(t.topicSourceVideo.publishedAt);
    lines.push(
      `- primary source [${t.topicSourceVideo.videoId}] "${t.topicSourceVideo.title}" — ${t.topicSourceVideo.competitorTitle ?? "(unknown)"} (${t.topicSourceVideo.multiplier.toFixed(1)}×, ${t.topicSourceVideo.views.toLocaleString("en-US")} views, age_days=${topicAge})`
    );
    for (const c of t.topicConfirmationVideos) {
      lines.push(
        `- confirmation [${c.videoId}] "${c.title}" — ${c.competitorTitle ?? "(unknown)"} (${c.multiplier.toFixed(1)}×, age_days=${ageDaysOrUnknown(c.publishedAt)})`
      );
    }
  }
  lines.push("");
  lines.push(`# FORMAT POOL (${formatCandidates.length})`);
  lines.push(
    "Each format is a structural template with proven examples. Pick the BEST-FITTING format per topic. The format source video id MUST NOT equal the topic source video id."
  );
  for (const f of formatCandidates) {
    lines.push("");
    lines.push(`## format_id=${f.formatId}`);
    lines.push(
      `- template: ${JSON.stringify(f.template)}${f.isSingleChannel ? " (single-channel pattern)" : ""}`
    );
    lines.push(
      `- example_count=${f.exampleCount}, distinct_channels=${f.distinctChannels}, rising_rate=${(f.risingRate ?? 0).toFixed(2)}, avg_multiplier=${(f.avgMultiplier ?? 0).toFixed(1)}×`
    );
    lines.push(
      `- primary source [${f.formatSourceVideo.videoId}] "${f.formatSourceVideo.title}" — ${f.formatSourceVideo.competitorTitle ?? "(unknown)"} (${f.formatSourceVideo.multiplier.toFixed(1)}×)`
    );
    for (const c of f.formatConfirmationVideos) {
      lines.push(
        `- example [${c.videoId}] "${c.title}" — ${c.competitorTitle ?? "(unknown)"} (${c.multiplier.toFixed(1)}×)`
      );
    }
  }
  return lines.join("\n");
}

function parseComposeOutput(
  raw: string,
  knownTopicLabels: Set<string>,
  knownFormatIds: Set<number>
): ComposeOutput[] | null {
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const arr = (parsed as { ideas?: unknown }).ideas;
  if (!Array.isArray(arr)) return null;
  const out: ComposeOutput[] = [];
  const seenLabels = new Set<string>();
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const topicLabel =
      typeof o.topicLabel === "string" ? o.topicLabel.trim() : "";
    if (!topicLabel || !knownTopicLabels.has(topicLabel)) continue;
    if (seenLabels.has(topicLabel)) continue;
    const topicSourceVideoId =
      typeof o.topicSourceVideoId === "string"
        ? o.topicSourceVideoId.trim()
        : "";
    const formatSourceVideoId =
      typeof o.formatSourceVideoId === "string"
        ? o.formatSourceVideoId.trim()
        : "";
    const proposedTitle =
      typeof o.proposedTitle === "string" ? o.proposedTitle.trim() : "";
    const coherenceRationale =
      typeof o.coherenceRationale === "string"
        ? o.coherenceRationale.trim()
        : "";
    const formatId =
      typeof o.formatId === "number" && Number.isFinite(o.formatId)
        ? Math.floor(o.formatId)
        : -1;
    if (
      !topicSourceVideoId ||
      !formatSourceVideoId ||
      topicSourceVideoId === formatSourceVideoId ||
      !proposedTitle ||
      !coherenceRationale ||
      !knownFormatIds.has(formatId)
    ) {
      continue;
    }
    seenLabels.add(topicLabel);
    out.push({
      topicLabel,
      topicSourceVideoId,
      formatId,
      formatSourceVideoId,
      proposedTitle,
      coherenceRationale,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claude #3 — retry compose (format swap)
// ---------------------------------------------------------------------------

type RetryComposeOutput = {
  topicLabel: string;
  topicSourceVideoId: string;
  formatId: number;
  formatSourceVideoId: string;
  proposedTitle: string;
  coherenceRationale: string;
};

type RetryResult =
  | { ok: true; ideas: RetryComposeOutput[] }
  | { ok: false; error: string };

async function runRetryComposeCall(opts: {
  apiKey: string;
  model: string;
  payload: Array<{
    slot: {
      topicLabel: string;
      proposedTitle: string;
      formatId: number;
    };
    topic: TopicCandidate;
    alternatives: FormatCandidate[];
    reason: string;
  }>;
  ctx: { description: string; ideationRules: string };
}): Promise<RetryResult> {
  const { apiKey, model, payload, ctx } = opts;
  const systemPrompt = [
    "You are retrying YouTube title compositions that failed a logical-fit check.",
    "",
    "For each slot below: the original mix was rejected as INCOHERENT (topic and format combined to imply a fabricated fact). Compose a NEW title for the SAME topic using ONE of the ALTERNATIVE formats listed. The new title must:",
    "  - keep the topic's subject intact,",
    "  - apply only the alternative format's STRUCTURE,",
    "  - NOT fabricate a connection — the alternative format's structure must transfer cleanly to the topic's subject.",
    "",
    "OUTPUT CONSTRAINTS (same as initial compose):",
    `  - proposedTitle 50-80 chars, ${TITLE_LEN_DROP_FLOOR}+ floor, plain words, banned words barred.`,
    "  - formatId MUST be one of the listed alternatives — NOT the banned format.",
    "  - topicSourceVideoId !== formatSourceVideoId.",
    "  - coherenceRationale: 1 short sentence (≤180 chars) explaining the new structure-to-subject mapping.",
    "",
    "Return ONLY a JSON object. No prose.",
    "{",
    '  "ideas": [',
    "    {",
    '      "topicLabel": string,',
    '      "topicSourceVideoId": string,',
    '      "formatId": number,',
    '      "formatSourceVideoId": string,',
    '      "proposedTitle": string,',
    '      "coherenceRationale": string',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  const knownFormatIds = new Set<number>();
  const knownTopicLabels = new Set<string>();

  const body: string[] = [];
  body.push("# USER CHANNEL CONTEXT");
  body.push("## About this channel");
  body.push(
    ctx.description.length > 0
      ? ctx.description
      : "(not set)"
  );
  body.push("");
  body.push("# RETRY SLOTS");
  for (const { slot, topic, alternatives, reason } of payload) {
    knownTopicLabels.add(slot.topicLabel);
    body.push("");
    body.push(`## topicLabel=${JSON.stringify(slot.topicLabel)}`);
    body.push(`- previously banned format_id=${slot.formatId}`);
    body.push(`- previous failed title: ${JSON.stringify(slot.proposedTitle)}`);
    body.push(`- fit failure reason: ${JSON.stringify(reason)}`);
    body.push(
      `- topic primary source [${topic.topicSourceVideo.videoId}] "${topic.topicSourceVideo.title}" — ${topic.topicSourceVideo.competitorTitle ?? "(unknown)"}`
    );
    for (const c of topic.topicConfirmationVideos) {
      body.push(
        `- topic confirmation [${c.videoId}] "${c.title}" — ${c.competitorTitle ?? "(unknown)"}`
      );
    }
    body.push("- ALTERNATIVE formats (pick ONE):");
    for (const alt of alternatives) {
      knownFormatIds.add(alt.formatId);
      body.push(
        `  - format_id=${alt.formatId}: ${JSON.stringify(alt.template)}${alt.isSingleChannel ? " (single-channel pattern)" : ""}`
      );
      body.push(
        `    primary source [${alt.formatSourceVideo.videoId}] "${alt.formatSourceVideo.title}" — ${alt.formatSourceVideo.competitorTitle ?? "(unknown)"}`
      );
      for (const c of alt.formatConfirmationVideos) {
        body.push(
          `    example [${c.videoId}] "${c.title}" — ${c.competitorTitle ?? "(unknown)"}`
        );
      }
    }
  }

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: 8000,
      temperature: 1,
      system: systemPrompt,
      messages: [{ role: "user", content: body.join("\n") }],
      // Opus 4.7 retry — adaptive thinking + lower effort tier since
      // retries do less work (a handful of titles, not the whole slate).
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const parsed = parseComposeOutput(text, knownTopicLabels, knownFormatIds);
    if (!parsed) return { ok: false, error: "retry returned malformed JSON" };
    return { ok: true, ideas: parsed };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "retry call failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ageDaysOrUnknown(ts: number | null): string {
  if (!ts || !Number.isFinite(ts)) return "unknown";
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff <= 0) return "0";
  return String(Math.floor(diff / 86400));
}

function ytThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

function readBannedTopics(channelId: string): string[] {
  const rows = listChannelMemory(channelId);
  const row = rows.find((r) => r.key === "banned_topics");
  if (!row || !row.value) return [];
  return row.value
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

function titleLengthBandFor(
  title: string
): "ideal" | "acceptable" | "too_long" | "rejected" {
  const len = title.length;
  if (len < TITLE_LEN_DROP_FLOOR) return "rejected";
  if (len > TITLE_LEN_HARD_MAX) return "too_long";
  if (len >= TITLE_LEN_IDEAL_MIN && len <= TITLE_LEN_IDEAL_MAX) return "ideal";
  return "acceptable";
}

function bannedWordMatch(title: string): string | null {
  const m = title.match(BANNED_WORDS_RE);
  return m ? m[0] : null;
}

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
