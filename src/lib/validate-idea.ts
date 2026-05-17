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

function tokenize(topic: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of topic
    .toLowerCase()
    .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
    .split(/\s+/)) {
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
function ownChannelMedian(channelId: string): number {
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
  const keywords = (function tokenize(s: string): string[] {
    // Reuse the file's tokenizer logic — exported separately would be
    // nicer but the closure keeps the existing function private.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of s
      .toLowerCase()
      .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
      .split(/\s+/)) {
      if (!raw || raw.length < 4) continue;
      if (STOPWORDS.has(raw)) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
    }
    return out;
  })(topic);

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
