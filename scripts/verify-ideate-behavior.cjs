#!/usr/bin/env node
/**
 * Focused pure-function checks for ideation behavior that can run without
 * network, Next, or Anthropic credentials.
 *
 * Run: node scripts/verify-ideate-behavior.cjs
 */

const assert = require("node:assert/strict");

function allocateIdeaBuckets(mode, count, options = {}) {
  const clamped = Math.max(1, Math.floor(count));
  if (mode === "new_angles") return [{ method: "new_angle", count: clamped }];
  if (mode === "title_tweaks") return [{ method: "title_tweak", count: clamped }];
  if (mode === "reddit_angles") return [{ method: "reddit_angle", count: clamped }];
  const methods =
    options.redditAvailable === false
      ? ["new_angle", "title_tweak"]
      : ["new_angle", "title_tweak", "reddit_angle"];
  const base = Math.floor(clamped / methods.length);
  let remainder = clamped % methods.length;
  return methods.map((method) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { method, count: base + extra };
  });
}

function normalizeSubreddit(input) {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/(?:www\.)?reddit\.com\/r\//i, "")
    .replace(/^\/?r\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{2,21}$/.test(cleaned)) return null;
  return cleaned;
}

function topicKey(input) {
  return input
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function redditDedupeKey(args) {
  return [
    topicKey(args.topic),
    normalizeSubreddit(args.subreddit)?.toLowerCase() ?? args.subreddit.toLowerCase(),
    args.permalink.toLowerCase().replace(/\?.*$/, "").replace(/\/$/, ""),
    topicKey(args.title),
  ].join("|");
}

function parseRedditPermalink(value, expectedSubreddit) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^old\./, "");
  if (hostname !== "reddit.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0]?.toLowerCase() !== "r") return null;
  const subreddit = normalizeSubreddit(parts[1] ?? "");
  if (!subreddit || subreddit.toLowerCase() !== expectedSubreddit.toLowerCase()) return null;
  if (parts[2]?.toLowerCase() !== "comments") return null;
  const redditId = parts[3] ?? "";
  if (!redditId) return null;
  return {
    permalink: `https://www.reddit.com/${parts.join("/")}`,
    subreddit,
    redditId,
  };
}

function normalizeBraveRedditResult(result, expectedSubreddit) {
  const parsed = parseRedditPermalink(result.url, expectedSubreddit);
  if (!parsed) return null;
  return {
    reddit_id: parsed.redditId,
    subreddit: parsed.subreddit,
    title: result.title.replace(/\s+/g, " ").trim(),
    permalink: parsed.permalink,
    provider: "brave_search",
    snippet: [result.description, ...(result.extra_snippets ?? [])]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

function parseProof(v) {
  if (!v || typeof v !== "object") return null;
  if (
    typeof v.source_signal !== "string" ||
    typeof v.fit !== "string" ||
    typeof v.execution !== "string"
  ) {
    return null;
  }
  return {
    source_signal: v.source_signal,
    fit: v.fit,
    execution: v.execution,
    whats_going_on: typeof v.whats_going_on === "string" ? v.whats_going_on : null,
    weak_proof: typeof v.weak_proof === "string" ? v.weak_proof : null,
    sources: Array.isArray(v.sources) ? v.sources : [],
  };
}

const IDEATION_TITLE_RULES_CAP = 4000;
const TOPIC_RECENCY_DAYS = 30;
const MAX_IDEAS_PER_TOPIC_PER_RUN = 3;
const TITLE_MAX_CHARS = 80;
const TITLE_MAX_WORDS = 12;
const HARD_TITLE_LENGTH_RULES = [
  "Title length is a hard rule: 50-70 characters is ideal because it displays fully in search and on mobile.",
  "70-80 characters is acceptable only if the emotional hook lands before the cutoff.",
  "Avoid 80+ character titles because the punchline risks being cut off in search results.",
  "Over 80 characters or over 12 words is not acceptable.",
];

function normalizeTitleRuleLine(line) {
  if (
    /\b45\s*-\s*68\b|\b30\s*-\s*80\b|\bmax\s*80\b|natural title length and rhythm/i.test(
      line
    )
  ) {
    return HARD_TITLE_LENGTH_RULES;
  }
  return [line];
}

function normalizeTitleRulesText(value) {
  const seen = new Set();
  return [
    ...value
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[-*]\s+/, "").trim())
      .flatMap((line) => normalizeTitleRuleLine(line)),
    ...HARD_TITLE_LENGTH_RULES,
  ]
    .filter(Boolean)
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n");
}

function saveTitleRules(store, value) {
  if (typeof value !== "string") throw new Error("rulesText must be a string");
  if (value.length > IDEATION_TITLE_RULES_CAP) {
    throw new Error(`rulesText must be ${IDEATION_TITLE_RULES_CAP} characters or less`);
  }
  const normalized = normalizeTitleRulesText(value);
  if (!normalized) throw new Error("rulesText must include at least one rule");
  store["ideate.title_rules"] = normalized;
}

function readTitleRules(store) {
  return store["ideate.title_rules"] ?? "";
}

function buildPromptSections(titleRules, channelRules) {
  return [
    "## TITLE RULES (HARD)",
    ...normalizeTitleRulesText(titleRules).split("\n").map((rule) => `- ${rule}`),
    "",
    "## Channel-specific ideation rules (/channel-info)",
    channelRules.trim() || "(none)",
  ].join("\n");
}

function sourceAgeDays(source) {
  if (!source) return null;
  if (typeof source.age_days === "number" && Number.isFinite(source.age_days)) return source.age_days;
  if (typeof source.published_at === "number" && source.published_at > 0) {
    return Math.max(0, Math.floor((Date.now() / 1000 - source.published_at) / 86400));
  }
  return null;
}

function topicEvidenceSources(idea) {
  const out = [];
  const seen = new Set();
  const add = (source) => {
    if (!source || seen.has(source.video_id)) return;
    seen.add(source.video_id);
    out.push(source);
  };
  add(idea.source_attribution.topic_source);
  for (const source of idea.source_attribution.topic_evidence_sources ?? []) add(source);
  return out;
}

function hasRecentTopicSignal(sources) {
  return sources.some((source) => {
    const age = sourceAgeDays(source);
    return age !== null && age <= TOPIC_RECENCY_DAYS;
  });
}

function recentTopicSignalCount(sources) {
  return sources.reduce((count, source) => {
    const age = sourceAgeDays(source);
    return age !== null && age <= TOPIC_RECENCY_DAYS ? count + 1 : count;
  }, 0);
}

function confidenceFromEvidence(fitScore, weakProof, idea) {
  if (weakProof && weakProof.trim().length > 0) return "low";
  if (fitScore === null) return "medium";
  const evidence = topicEvidenceSources(idea);
  const evidenceCount = evidence.length;
  const hasRecent = hasRecentTopicSignal(evidence);
  const recentCount = recentTopicSignalCount(evidence);
  if (fitScore >= 8 && recentCount >= 2) return "high";
  const hasRedditProof =
    (idea.proof?.sources ?? []).some((s) => s.type === "reddit" && s.url.includes("reddit.com")) ||
    (idea.research_sources ?? []).some((s) => s.type === "reddit" && s.url.includes("reddit.com"));
  if (fitScore >= 7 && (hasRecent || evidenceCount >= 2 || hasRedditProof)) return "medium";
  return "low";
}

function hardRuleCheckNewAngle(idea, gathered) {
  const outlierIds = new Set();
  const multiplierById = new Map();
  for (const comp of gathered.competitors) {
    for (const video of comp.videos) {
      if (!video.is_outlier) continue;
      outlierIds.add(video.video_id);
      multiplierById.set(video.video_id, video.multiplier);
    }
  }
  const topic = idea.source_attribution.topic_source?.video_id ?? null;
  const format = idea.source_attribution.format_source?.video_id ?? null;
  if (!topic || !format || topic === format) return "new_angle missing valid outlier source";
  if (!outlierIds.has(topic) || !outlierIds.has(format)) return "new_angle missing valid outlier source";
  if ((multiplierById.get(topic) ?? 0) < 2 || (multiplierById.get(format) ?? 0) < 2) {
    return "new_angle missing valid outlier source";
  }
  for (const evidence of idea.source_attribution.topic_evidence_sources ?? []) {
    if (!outlierIds.has(evidence.video_id)) return "topic evidence source is not a known outlier";
  }
  const primaryTopicAge = sourceAgeDays(idea.source_attribution.topic_source);
  if (primaryTopicAge === null) return "topic source is missing upload age/date metadata";
  if (primaryTopicAge > TOPIC_RECENCY_DAYS) return `topic source is older than ${TOPIC_RECENCY_DAYS} days`;
  return null;
}

function confidenceRank(confidence) {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}

function validatedIdeaRank(idea) {
  const recentCount = recentTopicSignalCount(topicEvidenceSources(idea));
  const fitScore = idea.fit_score ?? 0;
  return confidenceRank(idea.confidence_level) * 10000 + recentCount * 100 + fitScore;
}

const TITLE_TWEAK_STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "before",
  "between",
  "could",
  "every",
  "finally",
  "from",
  "have",
  "human",
  "humans",
  "just",
  "like",
  "really",
  "that",
  "their",
  "there",
  "this",
  "through",
  "what",
  "when",
  "where",
  "will",
  "with",
  "would",
  "your",
]);

function contentWords(value) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 3 && !TITLE_TWEAK_STOPWORDS.has(w));
}

function titleTweakDriftReason(title, sourceTitle) {
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedSource = sourceTitle.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalizedSource) return null;
  if (normalizedTitle === normalizedSource) return "title_tweak unchanged from source";

  const srcWords = new Set(contentWords(sourceTitle));
  const newWords = contentWords(title);
  if (srcWords.size === 0 || newWords.length === 0) return null;

  let overlap = 0;
  let added = 0;
  for (const word of newWords) {
    if (srcWords.has(word)) overlap++;
    else added++;
  }
  const overlapRatio = overlap / Math.max(1, Math.min(srcWords.size, newWords.length));
  if (overlapRatio < 0.45 || added > 4) {
    return `title_tweak drifted from source topic (${added} new content words)`;
  }
  return null;
}

function normalizeCooldownTitle(value) {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueUsedTitleCooldowns(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = normalizeCooldownTitle(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function usedTitleSimilarityScore(title, usedTitle) {
  const normalizedTitle = normalizeCooldownTitle(title);
  const normalizedUsed = normalizeCooldownTitle(usedTitle);
  if (!normalizedTitle || !normalizedUsed) return 0;
  if (normalizedTitle === normalizedUsed) return 1;
  const a = new Set(contentWords(normalizedTitle));
  const b = new Set(contentWords(normalizedUsed));
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap++;
  const minSize = Math.min(a.size, b.size);
  const unionSize = new Set([...a, ...b]).size;
  const containment = overlap / Math.max(1, minSize);
  const jaccard = overlap / Math.max(1, unionSize);
  if (overlap >= 4 && containment >= 0.8) return containment;
  return jaccard;
}

function usedTitleCooldownReason(title, usedTitles) {
  const normalizedTitle = normalizeCooldownTitle(title);
  for (const item of uniqueUsedTitleCooldowns(usedTitles)) {
    const normalizedUsed = normalizeCooldownTitle(item.title);
    if (!normalizedUsed) continue;
    if (normalizedTitle === normalizedUsed) return `cooldown: exact copied title already used: ${item.title}`;
    if (usedTitleSimilarityScore(title, item.title) >= 0.8) {
      return `cooldown: too similar to copied title: ${item.title}`;
    }
  }
  return null;
}

function topicCapSignal(idea) {
  const sources = topicEvidenceSources(idea);
  const sourceIds = new Set(sources.map((source) => source.video_id).filter(Boolean));
  const primaryLabel = sources.find((source) => source.title?.trim())?.title?.trim();
  if (primaryLabel) return { label: primaryLabel, sourceIds };
  const redditSource =
    (idea.proof?.sources ?? []).find((source) => source.type === "reddit") ??
    (idea.research_sources ?? []).find((source) => source.type === "reddit");
  if (redditSource?.label?.trim()) return { label: redditSource.label.trim(), sourceIds };
  const signal = idea.proof?.source_signal?.trim();
  if (signal) return { label: signal, sourceIds };
  return idea.title?.trim() ? { label: idea.title.trim(), sourceIds } : null;
}

function sourceIdsOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  for (const id of a) if (b.has(id)) return true;
  return false;
}

function enforceTopicCap(verdicts) {
  const clusters = [];
  const ordered = verdicts
    .map((idea, idx) => ({ idea, idx, rank: validatedIdeaRank(idea) }))
    .filter((item) => item.idea.validation_status === "passed")
    .sort((a, b) => b.rank - a.rank);
  for (const item of ordered) {
    const signal = topicCapSignal(item.idea);
    if (!signal) continue;
    let cluster = clusters.find(
      (candidate) =>
        sourceIdsOverlap(candidate.sourceIds, signal.sourceIds) ||
        usedTitleSimilarityScore(candidate.representative, signal.label) >= 0.68
    );
    if (!cluster) {
      cluster = {
        representative: signal.label,
        label: signal.label,
        sourceIds: new Set(signal.sourceIds),
        count: 0,
      };
      clusters.push(cluster);
    }
    if (cluster.count >= MAX_IDEAS_PER_TOPIC_PER_RUN) {
      item.idea.validation_status = "rejected";
      item.idea.validation_reason = `topic cap: more than ${MAX_IDEAS_PER_TOPIC_PER_RUN} ideas on "${cluster.label}"`;
      continue;
    }
    cluster.count++;
    for (const id of signal.sourceIds) cluster.sourceIds.add(id);
  }
}

function titleWordCount(title) {
  return title.trim().split(/\s+/).filter(Boolean).length;
}

function titleLengthHardRuleReason(title) {
  if (title.length > TITLE_MAX_CHARS) {
    return `title too long: ${title.length} characters; max ${TITLE_MAX_CHARS}`;
  }
  const words = titleWordCount(title);
  if (words > TITLE_MAX_WORDS) {
    return `title too wordy: ${words} words; max ${TITLE_MAX_WORDS}`;
  }
  return null;
}

function hardRuleCheckTitleOnly(title) {
  if (title.trim().length === 0) return "empty title";
  return titleLengthHardRuleReason(title);
}

function parseValidateScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  const clamped = Math.max(0, Math.min(10, score));
  return Math.round(clamped * 10) / 10;
}

function applyValidatorScore(verdict, score) {
  return {
    ...verdict,
    validation_status: verdict.validation_status,
    fit_score: parseValidateScore(score.fit_score),
    fit_reason: score.fit_reason ?? null,
  };
}

function hardRuleFailureCard(reason) {
  return {
    validation_status: "rejected",
    validation_reason: reason,
    fit_score: 0,
  };
}

function completedPayloadFromRows(rows) {
  return {
    ideas: rows.map((row) => ({
      id: row.id,
      title: row.title,
      validation_status: row.validation_status,
      validation_reason: row.validation_reason ?? null,
      fit_score: row.fit_score ?? null,
      fit_reason: row.fit_reason ?? null,
    })),
    rejected: [],
  };
}

assert.deepEqual(allocateIdeaBuckets("auto", 10), [
  { method: "new_angle", count: 4 },
  { method: "title_tweak", count: 3 },
  { method: "reddit_angle", count: 3 },
]);
assert.deepEqual(allocateIdeaBuckets("auto", 11), [
  { method: "new_angle", count: 4 },
  { method: "title_tweak", count: 4 },
  { method: "reddit_angle", count: 3 },
]);
assert.deepEqual(allocateIdeaBuckets("auto", 10, { redditAvailable: false }), [
  { method: "new_angle", count: 5 },
  { method: "title_tweak", count: 5 },
]);
assert.deepEqual(allocateIdeaBuckets("reddit_angles", 10), [
  { method: "reddit_angle", count: 10 },
]);

const keyA = redditDedupeKey({
  topic: "Mars sample return",
  subreddit: "r/space",
  permalink: "https://www.reddit.com/r/space/comments/abc/test/?utm_source=x",
  title: "NASA talks about Mars sample return",
});
const keyB = redditDedupeKey({
  topic: "Mars Sample Return",
  subreddit: "space",
  permalink: "https://www.reddit.com/r/space/comments/abc/test/",
  title: "NASA talks about Mars sample return",
});
assert.equal(keyA, keyB);

const braveHit = normalizeBraveRedditResult(
  {
    title: "Creators are worried about retention",
    url: "https://www.reddit.com/r/NewTubers/comments/abc123/creators_are_worried/?utm_source=brave",
    description: "A thread about audience retention.",
    extra_snippets: ["Several creators compare hooks."],
  },
  "NewTubers"
);
assert.equal(braveHit.provider, "brave_search");
assert.equal(braveHit.subreddit, "NewTubers");
assert.equal(braveHit.reddit_id, "abc123");
assert.equal(
  braveHit.permalink,
  "https://www.reddit.com/r/NewTubers/comments/abc123/creators_are_worried"
);
assert.equal(
  normalizeBraveRedditResult(
    {
      title: "Wrong domain",
      url: "https://example.com/r/NewTubers/comments/abc123/test",
      description: "",
    },
    "NewTubers"
  ),
  null
);
assert.equal(
  normalizeBraveRedditResult(
    {
      title: "Wrong subreddit",
      url: "https://www.reddit.com/r/space/comments/abc123/test",
      description: "",
    },
    "NewTubers"
  ),
  null
);

assert.equal(
  parseProof({
    source_signal: "r/space thread hit 500 upvotes",
    fit: "space audience overlap",
    execution: "rank the scenarios",
    whats_going_on: "On 2026-06-01, Reddit discussed it.",
    weak_proof: null,
    sources: [{ type: "reddit", label: "Thread", url: "https://reddit.com", date: "2026-06-01" }],
  }).sources.length,
  1
);
assert.equal(parseProof({ source_signal: "x" }), null);

const settingsStore = {};
saveTitleRules(settingsStore, "Keep titles simple\n- Use one breath");
assert.equal(
  readTitleRules(settingsStore),
  ["Keep titles simple.", "Use one breath.", ...HARD_TITLE_LENGTH_RULES].join("\n")
);
assert.throws(() => saveTitleRules(settingsStore, "x".repeat(IDEATION_TITLE_RULES_CAP + 1)));
assert.equal(
  normalizeTitleRulesText("Prefer roughly 45-68 characters when natural; 30-80 is allowed."),
  HARD_TITLE_LENGTH_RULES.join("\n")
);

const prompt = buildPromptSections("Use viral simplicity.", "Avoid Mars repeats.");
assert.match(prompt, /TITLE RULES/);
assert.match(prompt, /Use viral simplicity\./);
assert.match(prompt, /Channel-specific ideation rules/);
assert.match(prompt, /Avoid Mars repeats\./);

const ideaWithTwoSignals = {
  source_attribution: {
    topic_source: { video_id: "a", age_days: 12 },
    topic_evidence_sources: [{ video_id: "b", age_days: 21 }],
  },
  proof: { sources: [] },
  research_sources: [],
};
const ideaWithOneRecent = {
  source_attribution: {
    topic_source: { video_id: "a", age_days: 21 },
    topic_evidence_sources: [],
  },
  proof: { sources: [] },
  research_sources: [],
};
const ideaWithOldOnly = {
  source_attribution: {
    topic_source: { video_id: "a", age_days: 92 },
    topic_evidence_sources: [],
  },
  proof: { sources: [] },
  research_sources: [],
};
const ideaWithOneRecentOneOld = {
  source_attribution: {
    topic_source: { video_id: "a", age_days: 12 },
    topic_evidence_sources: [{ video_id: "b", age_days: 92 }],
  },
  proof: { sources: [] },
  research_sources: [],
};
assert.equal(confidenceFromEvidence(8, null, ideaWithTwoSignals), "high");
assert.equal(confidenceFromEvidence(9, null, ideaWithOneRecentOneOld), "medium");
assert.equal(confidenceFromEvidence(9, null, ideaWithOneRecent), "medium");
assert.equal(confidenceFromEvidence(9, null, ideaWithOldOnly), "low");
assert.equal(confidenceFromEvidence(8, "topic proof is weak", ideaWithTwoSignals), "low");

const gatheredForNewAngles = {
  competitors: [
    {
      videos: [
        { video_id: "topic-fresh", multiplier: 4.2, is_outlier: true },
        { video_id: "topic-old", multiplier: 10.8, is_outlier: true },
        { video_id: "topic-evidence", multiplier: 3.1, is_outlier: true },
        { video_id: "format-old", multiplier: 5.5, is_outlier: true },
      ],
    },
  ],
};
const baseNewAngle = {
  source_attribution: {
    topic_source: { video_id: "topic-fresh", age_days: 30 },
    format_source: { video_id: "format-old", age_days: 240 },
    topic_evidence_sources: [],
  },
};
assert.equal(hardRuleCheckNewAngle(baseNewAngle, gatheredForNewAngles), null);
assert.match(
  hardRuleCheckNewAngle(
    {
      source_attribution: {
        topic_source: { video_id: "topic-old", age_days: 31 },
        format_source: { video_id: "format-old", age_days: 240 },
        topic_evidence_sources: [{ video_id: "topic-evidence", age_days: 12 }],
      },
    },
    gatheredForNewAngles
  ),
  /older than 30 days/
);
assert.match(
  hardRuleCheckNewAngle(
    {
      source_attribution: {
        topic_source: { video_id: "topic-fresh" },
        format_source: { video_id: "format-old", age_days: 240 },
        topic_evidence_sources: [],
      },
    },
    gatheredForNewAngles
  ),
  /missing upload age/
);
assert.equal(
  validatedIdeaRank({
    ...ideaWithTwoSignals,
    confidence_level: "high",
    fit_score: 8,
  }) >
    validatedIdeaRank({
      ...ideaWithOneRecent,
      confidence_level: "medium",
      fit_score: 10,
    }),
  true
);

assert.equal(
  titleTweakDriftReason(
    "Why Humans Can't Survive a Trip to Another Star",
    "Why Humans Can Survive a Trip to Another Star"
  ),
  null
);
assert.match(
  titleTweakDriftReason(
    "Why Neptune Is the Deadliest Planet We Ignore",
    "Why Humans Can Survive a Trip to Another Star"
  ),
  /drifted/
);
assert.equal(
  titleTweakDriftReason(
    "Why Humans Can Survive a Trip to Another Star",
    "Why Humans Can Survive a Trip to Another Star"
  ),
  "title_tweak unchanged from source"
);

assert.equal(
  usedTitleCooldownReason("The Last Place Voyager 2 Will Ever Reach", [
    { title: "The Last Place Voyager 2 Will Ever Reach" },
  ]),
  "cooldown: exact copied title already used: The Last Place Voyager 2 Will Ever Reach"
);
assert.match(
  usedTitleCooldownReason("The Last Place Voyager Will Ever Reach", [
    { title: "The Last Place Voyager 2 Will Ever Reach" },
  ]),
  /too similar/
);
assert.equal(
  usedTitleCooldownReason("Why Neptune Is the Most Violent Planet", [
    { title: "The Last Place Voyager 2 Will Ever Reach" },
  ]),
  null
);

const topicCapVerdicts = Array.from({ length: 5 }, (_, idx) => ({
  title: `Variant ${idx}`,
  validation_status: "passed",
  validation_reason: null,
  confidence_level: idx < 3 ? "high" : "medium",
  fit_score: 9 - idx,
  source_attribution: {
    topic_source: { video_id: "moon-topic", title: "Why We Shouldn't Go Back to the Moon" },
    topic_evidence_sources: [],
  },
  proof: { source_signal: "Moon topic proof", sources: [] },
  research_sources: [],
}));
enforceTopicCap(topicCapVerdicts);
assert.equal(
  topicCapVerdicts.filter((idea) => idea.validation_status === "passed").length,
  3
);
assert.equal(
  topicCapVerdicts.filter((idea) => /topic cap/.test(idea.validation_reason ?? "")).length,
  2
);

assert.equal(hardRuleCheckTitleOnly("Tiny"), null);
assert.equal(
  hardRuleCheckTitleOnly(
    "This Is A Very Long But Still Potentially Natural Source-Style Space Title"
  ),
  null
);
assert.match(
  hardRuleCheckTitleOnly(
    "Supermassive Supercluster Boundary Mystery Explained Beyond Observable Universe Forever"
  ),
  /title too long/
);
assert.match(
  hardRuleCheckTitleOnly(
    "Why The Moon Dust Could Still Kill Every Astronaut Who Tries To Return Home"
  ),
  /title too wordy/
);
assert.equal(hardRuleCheckTitleOnly("   "), "empty title");

assert.equal(parseValidateScore(8.64), 8.6);
assert.equal(parseValidateScore(11.2), 10);
assert.equal(parseValidateScore(-1.4), 0);

const lowScoreVerdict = applyValidatorScore(
  { validation_status: "passed", validation_reason: null, fit_score: null },
  { fit_score: 3.4, fit_reason: "The topic is adjacent but not core." }
);
assert.equal(lowScoreVerdict.validation_status, "passed");
assert.equal(lowScoreVerdict.fit_score, 3.4);

const hardFailure = hardRuleFailureCard("empty title");
assert.equal(hardFailure.validation_status, "rejected");
assert.equal(hardFailure.fit_score, 0);

const completedPayload = completedPayloadFromRows([
  {
    id: "good",
    title: "Good idea",
    validation_status: "passed",
    fit_score: 8.6,
    fit_reason: "Strong channel fit.",
  },
  {
    id: "weak",
    title: "Weak idea",
    validation_status: "rejected",
    validation_reason: "duplicate of idx 0",
    fit_score: 4.2,
  },
]);
assert.equal(completedPayload.ideas.length, 2);
assert.equal(completedPayload.ideas[0].fit_score, 8.6);
assert.deepEqual(completedPayload.rejected, []);

console.log("IDEATE BEHAVIOR VERIFY: OK");
