import "server-only";
import { db } from "./db";

/**
 * Per-band names for performance — matches the operating-rule plain-English
 * dictionary the chat agent uses when reporting any video's performance.
 * Drives both validateIdeaAgainstOwnCatalog's match annotations and
 * (indirectly via the LLM operating rules) the agent's outgoing copy.
 *
 * Bands:
 *   ≥ 5×       → "hit hard"
 *   2× to < 5× → "above average"
 *   0.8× to < 2× → "average"
 *   < 0.8×     → "underperformed"
 */
export type PerformanceBand =
  | "hit hard"
  | "above average"
  | "average"
  | "underperformed";

export function performanceBandFor(multiplier: number): PerformanceBand {
  if (!Number.isFinite(multiplier)) return "average";
  if (multiplier >= 5) return "hit hard";
  if (multiplier >= 2) return "above average";
  if (multiplier >= 0.8) return "average";
  return "underperformed";
}

export type CatalogMatch = {
  videoId: string;
  title: string;
  publishedAt: number | null;
  views: number;
  multiplier: number;
  performanceBand: PerformanceBand;
  matchedKeywords: string[];
};

export type ValidateVerdict =
  | "fresh"
  | "covered_recently"
  | "covered_old"
  | "covered_underperformed";

export type ValidateResult = {
  topic: string;
  primaryWindowDays: number;
  secondaryWindowDays: number;
  primaryMatches: CatalogMatch[];
  adjacentMatches: CatalogMatch[];
  verdict: ValidateVerdict;
  verdictCopy: string;
};

// Lo-fi tokenizer for topic strings — drops common English connectors and
// short tokens. Matches the spirit of the legacy db.ts STOPWORDS list but
// doesn't need to be exhaustive: we require ≥2 keyword hits per match, so
// stopword leakage rarely creates false positives.
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

// Brand stop list — instrument/agency/mission names that act like proper
// nouns across topics. Without this scrub, "James Webb finds biosignatures
// on K2-18b" and "James Webb finds Planet Nine" both tokenize to
// {james,webb,finds,…} — the topic-similarity check collapses both to
// the same topic and the per-channel frequency gate eats them.
//
// Order matters: longer phrases first so "voyager 2" wins before
// "voyager" turns it into a bare "2". Multi-word phrases are stripped
// with word-boundary anchors so partial matches don't leak.
const BRAND_PHRASES: readonly string[] = [
  "james webb space telescope",
  "james webb",
  "webb telescope",
  "jwst",
  "voyager 1",
  "voyager 2",
  "voyager",
  "mars rover",
  "perseverance",
  "curiosity",
  "ingenuity",
  "hubble",
  "kepler",
  "tess",
  "chandra",
  "starship",
  "spacex",
  "nasa",
  "esa",
  "cern",
  "lhc",
  "iss",
];

/**
 * Strip brand phrases from a lowercase string. Exported so the
 * idea-generator's local tokenizer can reuse the same brand list —
 * single source of truth across topic clustering, frequency checks,
 * and per-idea catalog lookup.
 */
export function stripBrandPhrases(s: string): string {
  let out = s;
  for (const phrase of BRAND_PHRASES) {
    // \b boundaries work across the inner spaces because the boundaries
    // land at the outer letter↔non-letter transitions.
    out = out.replace(new RegExp(`\\b${phrase}\\b`, "g"), " ");
  }
  return out;
}

/**
 * Returns the content-noun tokens of a string AFTER stripping brand
 * phrases. Used by every topic-overlap calculation in this file so the
 * brand list applies uniformly: same-instrument titles no longer
 * collapse to the same topic just because they share "james webb".
 */
function tokenize(topic: string): string[] {
  const stripped = stripBrandPhrases(
    topic.toLowerCase().replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of stripped.split(/\s+/)) {
    if (!raw) continue;
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

// Own-channel median over all videos with views > 0. Used as the stable
// baseline for performance bands. No window — the band should reflect
// each video's place in the creator's overall catalogue distribution,
// not a transient 60d window.
export function ownChannelMedian(channelId: string): number {
  const row = db
    .prepare(
      `WITH ordered AS (
         SELECT views,
                ROW_NUMBER() OVER (ORDER BY views) AS rn,
                COUNT(*)     OVER ()              AS cnt
         FROM videos
         WHERE channel_id = ?
           AND views > 0
       )
       SELECT AVG(views) AS median
       FROM ordered
       WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)`
    )
    .get(channelId) as { median: number | null } | undefined;
  return Math.round(row?.median ?? 0);
}

// Pull videos within `withinDays` days for the given channel. Inline SQL
// rather than reusing listVideos() — that helper scopes by active channel,
// which would silently mis-target if the agent's intended channel differs
// from the active pointer.
type VideoLite = {
  id: string;
  title: string;
  published_at: number | null;
  views: number;
};

function videosInWindow(
  channelId: string,
  withinDays: number
): VideoLite[] {
  return db
    .prepare(
      `SELECT id, title, published_at, COALESCE(views, 0) AS views
       FROM videos
       WHERE channel_id = ?
         AND published_at IS NOT NULL
         AND published_at >= strftime('%s','now') - ? * 86400
       ORDER BY published_at DESC`
    )
    .all(channelId, withinDays) as VideoLite[];
}

// Most-recent N videos for a channel by published/imported date desc.
// Inline SQL (rather than reusing listVideos) so we can scope by explicit
// channelId — listVideos is active-channel-scoped and would silently
// mis-target if the generator's intended channel differs from the
// active pointer.
function ownChannelLastN(
  channelId: string,
  limit: number
): VideoLite[] {
  return db
    .prepare(
      `SELECT id, title, published_at, COALESCE(views, 0) AS views
       FROM videos
       WHERE channel_id = ?
       ORDER BY COALESCE(published_at, imported_at) DESC
       LIMIT ?`
    )
    .all(channelId, limit) as VideoLite[];
}

/**
 * Topic-frequency guardrail. Checks whether the user has covered a topic
 * 2+ times across their last N uploads — if so, propose-again is overuse
 * and the slot should be dropped before the originality guard even runs.
 *
 * Same tokenization rules as validateIdeaAgainstOwnCatalog (4+ char tokens,
 * stopwords stripped). Match rule: ≥2 keyword hits between the topic and
 * a video title counts that video. overused := matches >= 1.
 *
 * Threshold flipped from ≥2 to ≥1: HAmo's complaint was that a SINGLE
 * recent overlap (e.g. a Betelgeuse idea proposed days after he shipped
 * a Betelgeuse video) shouldn't survive. The Skipped research-block
 * line surfaces every drop so the user sees what got filtered and can
 * loosen the constraint per-channel via banned_topics later if desired.
 */
export type TopicFrequencyResult = {
  matches: number;
  matchedVideos: Array<{
    videoId: string;
    title: string;
    publishedAt: number | null;
  }>;
  overused: boolean;
};

export function checkTopicFrequency(
  topic: string,
  channelId: string,
  lookbackVideos: number = 20
): TopicFrequencyResult {
  // Use the file's shared tokenize() so the brand-phrase strip applies
  // uniformly here too — "James Webb" in the topic and in a recent own
  // video both reduce to no-brand tokens before the keyword overlap is
  // counted.
  const keywords = tokenize(topic);

  if (keywords.length === 0 || !channelId) {
    return { matches: 0, matchedVideos: [], overused: false };
  }

  const videos = ownChannelLastN(channelId, Math.max(1, lookbackVideos));
  const matched: TopicFrequencyResult["matchedVideos"] = [];
  for (const v of videos) {
    const titleLower = v.title.toLowerCase();
    let hits = 0;
    for (const kw of keywords) {
      if (titleLower.includes(kw)) hits++;
    }
    if (hits >= 2) {
      matched.push({
        videoId: v.id,
        title: v.title,
        publishedAt: v.published_at,
      });
    }
  }
  return {
    matches: matched.length,
    matchedVideos: matched,
    overused: matched.length >= 1,
  };
}

function transcriptTextFor(videoIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (videoIds.length === 0) return out;
  // Build a (?, ?, ...) placeholder list. Sqlite handles thousands of
  // bound params fine — but realistic channels are <500 videos so this
  // never gets large.
  const placeholders = videoIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT video_id, text FROM transcripts
       WHERE video_id IN (${placeholders})`
    )
    .all(...videoIds) as Array<{ video_id: string; text: string }>;
  for (const r of rows) out.set(r.video_id, r.text);
  return out;
}

function scoreMatch(
  video: VideoLite,
  transcript: string | undefined,
  keywords: string[]
): { hits: string[]; titleHits: number } {
  const hits: string[] = [];
  let titleHits = 0;
  const titleLower = video.title.toLowerCase();
  const transcriptLower = transcript?.toLowerCase() ?? "";
  for (const kw of keywords) {
    const inTitle = titleLower.includes(kw);
    const inTranscript = !inTitle && transcriptLower.includes(kw);
    if (inTitle) titleHits++;
    if (inTitle || inTranscript) hits.push(kw);
  }
  return { hits, titleHits };
}

/**
 * Search the user's catalog for videos that overlap a proposed topic.
 * Returns a verdict + a plain-English summary line + match details with
 * performance bands. The verdictCopy is what the chat agent echoes —
 * operating rule 8 forbids naked multipliers in user-facing text.
 *
 * Primary window (default 60d) covers "you just did this — anything you
 * make now competes with it". Secondary window (default 90d) catches
 * topics covered 2-3 months ago that are evergreen-adjacent but not
 * actively competing.
 *
 * Match rule: at least 2 keyword hits between title + transcript. Single
 * keyword overlap is too noisy. Keywords drop stopwords + tokens <4 chars.
 */
export function validateIdeaAgainstOwnCatalog(opts: {
  topic: string;
  userChannelId: string;
  primaryWindowDays?: number;
  secondaryWindowDays?: number;
}): ValidateResult {
  const topic = opts.topic.trim();
  const primaryWindowDays = opts.primaryWindowDays ?? 60;
  const secondaryWindowDays = opts.secondaryWindowDays ?? 90;
  const keywords = tokenize(topic);

  if (!topic || keywords.length === 0 || !opts.userChannelId) {
    return {
      topic,
      primaryWindowDays,
      secondaryWindowDays,
      primaryMatches: [],
      adjacentMatches: [],
      verdict: "fresh",
      verdictCopy:
        "Fresh territory for you — couldn't extract searchable keywords from this topic.",
    };
  }

  // Pull both windows. secondaryWindowDays should be >= primaryWindowDays —
  // adjacent matches are computed by set-subtraction below.
  const wideWindow = Math.max(primaryWindowDays, secondaryWindowDays);
  const videos = videosInWindow(opts.userChannelId, wideWindow);
  if (videos.length === 0) {
    return {
      topic,
      primaryWindowDays,
      secondaryWindowDays,
      primaryMatches: [],
      adjacentMatches: [],
      verdict: "fresh",
      verdictCopy: `Fresh territory for you — no own-channel videos in the last ${wideWindow} days.`,
    };
  }

  const transcripts = transcriptTextFor(videos.map((v) => v.id));
  const median = ownChannelMedian(opts.userChannelId);

  type Scored = {
    video: VideoLite;
    hits: string[];
    titleHits: number;
  };
  const scored: Scored[] = [];
  for (const v of videos) {
    const { hits, titleHits } = scoreMatch(
      v,
      transcripts.get(v.id),
      keywords
    );
    if (hits.length >= 2) {
      scored.push({ video: v, hits, titleHits });
    }
  }

  // Convert to CatalogMatch with multiplier + band. Use median=1 as a
  // safe denominator when own-median couldn't be computed (no qualifying
  // videos for the median window — banding falls back to "average" via
  // the helper, which is the right default for a brand-new channel).
  const toMatch = (s: Scored): CatalogMatch => {
    const multiplier = median > 0 ? s.video.views / median : 1;
    return {
      videoId: s.video.id,
      title: s.video.title,
      publishedAt: s.video.published_at,
      views: s.video.views,
      multiplier: Math.round(multiplier * 10) / 10,
      performanceBand: performanceBandFor(multiplier),
      matchedKeywords: s.hits,
    };
  };

  // Rank by (keyword hits, title hits, multiplier). Title hits matter
  // more than transcript hits — a title match means the video IS that
  // topic, not just mentions it. Multiplier breaks ties toward big wins.
  scored.sort((a, b) => {
    if (b.hits.length !== a.hits.length) return b.hits.length - a.hits.length;
    if (b.titleHits !== a.titleHits) return b.titleHits - a.titleHits;
    const am = median > 0 ? a.video.views / median : 0;
    const bm = median > 0 ? b.video.views / median : 0;
    return bm - am;
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const primaryCutoff = nowSec - primaryWindowDays * 86400;
  const primary: CatalogMatch[] = [];
  const adjacent: CatalogMatch[] = [];
  for (const s of scored) {
    const ts = s.video.published_at;
    if (ts === null) continue;
    if (ts >= primaryCutoff) primary.push(toMatch(s));
    else adjacent.push(toMatch(s));
  }

  // Cap each bucket at 5 to keep payloads (and downstream LLM context)
  // bounded. The top-N here is what the chat agent will quote.
  const primaryMatches = primary.slice(0, 5);
  const adjacentMatches = adjacent.slice(0, 5);

  // Verdict + copy.
  let verdict: ValidateVerdict;
  let verdictCopy: string;
  if (primaryMatches.length === 0 && adjacentMatches.length === 0) {
    verdict = "fresh";
    verdictCopy = `Fresh territory for you — no matching videos in your last ${primaryWindowDays} days.`;
  } else if (primaryMatches.length > 0) {
    const best = primaryMatches[0];
    if (best.multiplier < 0.8) {
      verdict = "covered_underperformed";
      verdictCopy = `You covered this recently — "${truncate(best.title, 80)}" underperformed (${best.multiplier.toFixed(1)}×). A fresh angle/framing could rescue the topic.`;
    } else {
      verdict = "covered_recently";
      verdictCopy = `You covered this recently — "${truncate(best.title, 80)}" ${best.performanceBand} (${best.multiplier.toFixed(1)}×). A new video would compete with it; pivot the angle if you proceed.`;
    }
  } else {
    verdict = "covered_old";
    const best = adjacentMatches[0];
    verdictCopy = `You touched this in the ${primaryWindowDays}–${secondaryWindowDays}d window ("${truncate(best.title, 80)}", ${best.performanceBand}, ${best.multiplier.toFixed(1)}×) but nothing inside the last ${primaryWindowDays} days. Likely safe to revisit.`;
  }

  return {
    topic,
    primaryWindowDays,
    secondaryWindowDays,
    primaryMatches,
    adjacentMatches,
    verdict,
    verdictCopy,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Find competitor outliers whose titles overlap a proposed topic. Powers
 * the "Same topic across competitors" block in the agent's structured
 * ideation output (replaces the prior "Same format proven" block, which
 * showed format siblings — useful for proving the SHAPE but irrelevant
 * when the user wants to see who else covered the SAME TOPIC and how
 * hard it hit).
 *
 * Scope: competitor_videos owned by the active channel's competitors,
 * within the same 60d window the outliers SQL uses, with ≥2 keyword hits.
 * Ranked by (overlap DESC, multiplier DESC). Single-keyword overlap is
 * too noisy. Returns up to `limit` results.
 *
 * Tokenisation matches checkTopicFrequency + validateIdeaAgainstOwnCatalog
 * (4+ char tokens, stopwords stripped) so the three helpers see topics
 * the same way.
 */
export type TopicSimilarMatch = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  // T4: forensic-evidence fields. Every reference to an outlier in the
  // agent's output must include views + median + subs + absolute date so
  // the multiplier is verifiable (no naked "52×" — must be paired with
  // "224K views vs channel median 4K"). These get surfaced inline in
  // the agent's structured markdown by the OUTPUT FORMAT spec.
  views: number;
  channelMedian: number;
  multiplier: number;
  performanceBand: PerformanceBand;
  publishedAt: number | null;
  competitorTitle: string | null;
  competitorHandle: string | null;
  competitorSubscriberCount: number | null;
  matchedKeywords: string[];
};

export function findTopicSimilarOutliers(
  topic: string,
  activeChannelId: string,
  opts: { limit?: number; excludeVideoIds?: string[] } = {}
): TopicSimilarMatch[] {
  const trimmed = topic.trim();
  if (!trimmed || !activeChannelId) return [];
  const keywords = tokenize(trimmed);
  if (keywords.length === 0) return [];

  const limit = Math.max(1, Math.min(20, opts.limit ?? 3));
  const exclude = new Set(opts.excludeVideoIds ?? []);

  // Pull recent competitor videos for the active channel's competitors,
  // alongside their channel median so we can compute multiplier without
  // a second pass. Mirrors the scoped_videos CTE in outliersForUserChannel
  // (60d window, excludes self-tracked-as-competitor rows, respects
  // competitor_video_excludes) but skips the median-rank/qualification
  // step — we want ALL recent competitor videos that match the topic,
  // ranked by overlap + multiplier, not just methodology outliers.
  const rows = db
    .prepare(
      `WITH scoped AS (
         SELECT
           cv.video_id,
           cv.title,
           cv.thumbnail_url,
           cv.published_at,
           COALESCE(cv.views, 0) AS views,
           cv.competitor_id,
           c.title              AS competitor_title,
           c.handle             AS competitor_handle,
           c.subscriber_count   AS competitor_subscriber_count,
           c.user_channel_id,
           ROW_NUMBER() OVER (PARTITION BY cv.competitor_id ORDER BY cv.views) AS rn,
           COUNT(*)     OVER (PARTITION BY cv.competitor_id)                  AS n_in_window
         FROM competitor_videos cv
         JOIN competitors c ON c.id = cv.competitor_id
         LEFT JOIN competitor_video_excludes e
           ON e.user_channel_id = c.user_channel_id
          AND e.video_id        = cv.video_id
         WHERE cv.published_at IS NOT NULL
           AND cv.published_at >= strftime('%s','now') - 60 * 86400
           AND c.user_channel_id = ?
           AND e.video_id IS NULL
           AND (c.channel_id IS NULL OR c.channel_id != c.user_channel_id)
       ),
       medians AS (
         SELECT competitor_id, AVG(views) AS median_views
         FROM scoped
         WHERE n_in_window >= 5
           AND rn IN ((n_in_window + 1) / 2, (n_in_window + 2) / 2)
         GROUP BY competitor_id
       )
       SELECT
         s.video_id,
         s.title,
         s.thumbnail_url,
         s.views,
         s.published_at,
         s.competitor_title,
         s.competitor_handle,
         s.competitor_subscriber_count,
         COALESCE(m.median_views, 0) AS median_views
       FROM scoped s
       LEFT JOIN medians m ON m.competitor_id = s.competitor_id`
    )
    .all(activeChannelId) as Array<{
    video_id: string;
    title: string;
    thumbnail_url: string | null;
    views: number;
    published_at: number | null;
    competitor_title: string | null;
    competitor_handle: string | null;
    competitor_subscriber_count: number | null;
    median_views: number;
  }>;

  type Scored = {
    videoId: string;
    title: string;
    thumbnailUrl: string | null;
    views: number;
    channelMedian: number;
    publishedAt: number | null;
    competitorTitle: string | null;
    competitorHandle: string | null;
    competitorSubscriberCount: number | null;
    matchedKeywords: string[];
    overlap: number;
    multiplier: number;
  };
  const scored: Scored[] = [];
  for (const r of rows) {
    if (exclude.has(r.video_id)) continue;
    const titleLower = r.title.toLowerCase();
    const hits: string[] = [];
    for (const kw of keywords) {
      if (titleLower.includes(kw)) hits.push(kw);
    }
    if (hits.length < 2) continue;
    const multiplier =
      r.median_views > 0
        ? Math.round((r.views / r.median_views) * 10) / 10
        : 0;
    scored.push({
      videoId: r.video_id,
      title: r.title,
      thumbnailUrl: r.thumbnail_url,
      views: r.views,
      channelMedian: Math.round(r.median_views),
      publishedAt: r.published_at,
      competitorTitle: r.competitor_title,
      competitorHandle: r.competitor_handle,
      competitorSubscriberCount: r.competitor_subscriber_count,
      matchedKeywords: hits,
      overlap: hits.length,
      multiplier,
    });
  }

  scored.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    return b.multiplier - a.multiplier;
  });

  return scored.slice(0, limit).map((s) => ({
    videoId: s.videoId,
    title: s.title,
    thumbnailUrl:
      s.thumbnailUrl ?? `https://i.ytimg.com/vi/${s.videoId}/mqdefault.jpg`,
    views: s.views,
    channelMedian: s.channelMedian,
    multiplier: s.multiplier,
    performanceBand: performanceBandFor(s.multiplier),
    publishedAt: s.publishedAt,
    competitorTitle: s.competitorTitle,
    competitorHandle: s.competitorHandle,
    competitorSubscriberCount: s.competitorSubscriberCount,
    matchedKeywords: s.matchedKeywords,
  }));
}

/**
 * T4 — own-channel topic siblings. Sibling of findTopicSimilarOutliers
 * but scoped to the USER's own catalog. Powers the "Your catalog
 * comparison" block in the agent's forensic ideation output: for each
 * proposed idea, surface 0-3 of the user's own videos that share content
 * nouns with the topic, so the user can see at a glance whether they've
 * already covered it.
 *
 * Match rule mirrors validateIdeaAgainstOwnCatalog: ≥2 keyword overlap
 * on the title (transcript scan is skipped — too slow for the per-idea
 * cost). Ranked by (overlap DESC, multiplier DESC).
 */
export type OwnCatalogMatch = {
  videoId: string;
  title: string;
  views: number;
  channelMedian: number;
  multiplier: number;
  performanceBand: PerformanceBand;
  publishedAt: number | null;
  matchedKeywords: string[];
};

export function findOwnCatalogTopicMatches(
  topic: string,
  channelId: string,
  opts: { limit?: number; lookbackDays?: number } = {}
): OwnCatalogMatch[] {
  const trimmed = topic.trim();
  if (!trimmed || !channelId) return [];
  const keywords = tokenize(trimmed);
  if (keywords.length === 0) return [];
  const limit = Math.max(1, Math.min(10, opts.limit ?? 3));
  // Default lookback is "last 365 days" — generous enough to surface
  // anything still on the channel's relevant history horizon.
  const lookbackDays = Math.max(7, Math.min(3650, opts.lookbackDays ?? 365));

  const median = ownChannelMedian(channelId);
  const rows = db
    .prepare(
      `SELECT id, title, COALESCE(views, 0) AS views, published_at
       FROM videos
       WHERE channel_id = ?
         AND published_at IS NOT NULL
         AND published_at >= strftime('%s','now') - ? * 86400
       ORDER BY COALESCE(published_at, imported_at) DESC`
    )
    .all(channelId, lookbackDays) as Array<{
    id: string;
    title: string;
    views: number;
    published_at: number | null;
  }>;

  type Scored = {
    row: { id: string; title: string; views: number; published_at: number | null };
    hits: string[];
    multiplier: number;
  };
  const scored: Scored[] = [];
  for (const r of rows) {
    const titleLower = r.title.toLowerCase();
    const hits: string[] = [];
    for (const kw of keywords) {
      if (titleLower.includes(kw)) hits.push(kw);
    }
    if (hits.length < 2) continue;
    const multiplier =
      median > 0
        ? Math.round((r.views / median) * 10) / 10
        : 0;
    scored.push({ row: r, hits, multiplier });
  }
  scored.sort((a, b) => {
    if (b.hits.length !== a.hits.length) return b.hits.length - a.hits.length;
    return b.multiplier - a.multiplier;
  });

  return scored.slice(0, limit).map((s) => ({
    videoId: s.row.id,
    title: s.row.title,
    views: s.row.views,
    channelMedian: median,
    multiplier: s.multiplier,
    performanceBand: performanceBandFor(s.multiplier),
    publishedAt: s.row.published_at,
    matchedKeywords: s.hits,
  }));
}
