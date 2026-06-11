import "server-only";
import fs from "node:fs";
import path from "node:path";

import {
  getBraveSearchConfig,
  searchBraveWeb,
  type BraveWebResult,
} from "./brave-search";
import { db } from "./db";
import { log } from "./logger";

export const REDDIT_RECENCY_DAYS = 30;
export const REDDIT_VIRAL_SCORE_MIN = 500;
export const REDDIT_VIRAL_COMMENTS_MIN = 100;
export const REDDIT_FALLBACK_BRAVE_RANK_LIMIT = 3;

export type RedditSignalStrength = "metrics" | "fallback";

export interface RedditSearchHit {
  reddit_id: string;
  subreddit: string;
  title: string;
  permalink: string;
  url: string | null;
  score: number;
  comments: number;
  created_utc: number | null;
  selftext: string | null;
  provider: "brave_search";
  snippet: string;
  signal_strength: RedditSignalStrength;
  brave_rank: number;
}

export interface RedditResearchItem {
  id: number;
  topic_key: string;
  topic: string;
  subreddit: string;
  title: string;
  permalink: string;
  score: number;
  comments: number;
  created_utc: number | null;
  summary: string;
  signal_strength: RedditSignalStrength;
  reused: boolean;
}

interface SearchOptions {
  userChannelId: string;
  generationId?: string | null;
  topics: string[];
  subreddits: string[];
  maxItems?: number;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeSubreddit(input: string): string | null {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/(?:www\.)?reddit\.com\/r\//i, "")
    .replace(/^\/?r\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{2,21}$/.test(cleaned)) return null;
  return cleaned;
}

export function parseSubredditSources(input: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (input ?? "").split(/\r?\n|,/)) {
    const sub = normalizeSubreddit(raw);
    if (!sub) continue;
    const key = sub.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sub);
  }
  return out;
}

export function topicKey(input: string): string {
  return cleanText(input)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function redditDedupeKey(args: {
  topic: string;
  subreddit: string;
  permalink: string;
  title: string;
}): string {
  return [
    topicKey(args.topic),
    normalizeSubreddit(args.subreddit)?.toLowerCase() ?? args.subreddit.toLowerCase(),
    args.permalink.toLowerCase().replace(/\?.*$/, "").replace(/\/$/, ""),
    topicKey(args.title),
  ].join("|");
}

export function hasRedditSignalProvider(): boolean {
  return !!getBraveSearchConfig();
}

function shortDate(createdUtc: number | null): string {
  if (!createdUtc) return new Date().toISOString().slice(0, 10);
  return new Date(createdUtc * 1000).toISOString().slice(0, 10);
}

export function createdUtcFromAge(age: string | null, nowMs = Date.now()): number | null {
  if (!age) return null;
  const value = age.trim().toLowerCase();
  const relative = value.match(
    /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/
  );
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const seconds =
      unit === "second"
        ? amount
        : unit === "minute"
          ? amount * 60
          : unit === "hour"
            ? amount * 3600
            : unit === "day"
              ? amount * 86400
              : unit === "week"
                ? amount * 7 * 86400
                : unit === "month"
                  ? amount * 30 * 86400
                  : amount * 365 * 86400;
    return Math.floor(nowMs / 1000 - seconds);
  }
  if (value === "yesterday") return Math.floor(nowMs / 1000 - 86400);

  const parsed = Date.parse(age);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1000);
}

export function redditSignalAgeDays(
  createdUtc: number | null,
  nowSec = Math.floor(Date.now() / 1000)
): number | null {
  if (!createdUtc || createdUtc <= 0) return null;
  return Math.max(0, Math.floor((nowSec - createdUtc) / 86400));
}

export function hasViralRedditMetrics(
  signal: Pick<RedditSearchHit | RedditResearchItem, "score" | "comments">
): boolean {
  return (
    signal.score >= REDDIT_VIRAL_SCORE_MIN ||
    signal.comments >= REDDIT_VIRAL_COMMENTS_MIN
  );
}

export function isUsableRedditSignal(
  signal: Pick<
    RedditSearchHit | RedditResearchItem,
    "score" | "comments" | "created_utc" | "signal_strength"
  > & { brave_rank?: number },
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  const ageDays = redditSignalAgeDays(signal.created_utc, nowSec);
  if (ageDays === null || ageDays > REDDIT_RECENCY_DAYS) return false;
  if (hasViralRedditMetrics(signal)) return true;
  return (
    signal.signal_strength === "fallback" &&
    typeof signal.brave_rank === "number" &&
    signal.brave_rank <= REDDIT_FALLBACK_BRAVE_RANK_LIMIT
  );
}

function parseRedditPermalink(
  value: string,
  expectedSubreddit: string
): { permalink: string; subreddit: string; redditId: string } | null {
  let url: URL;
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

  const canonicalPath = `/${parts.join("/")}`.replace(/\/+$/, "");
  return {
    permalink: `https://www.reddit.com${canonicalPath}`,
    subreddit,
    redditId,
  };
}

export function normalizeBraveRedditResult(
  result: BraveWebResult,
  expectedSubreddit: string,
  braveRank = 1
): RedditSearchHit | null {
  const parsed = parseRedditPermalink(result.url, expectedSubreddit);
  if (!parsed) return null;
  const snippet = cleanText(
    [result.description, ...result.extra_snippets].filter(Boolean).join(" ")
  ).slice(0, 700);
  return {
    reddit_id: parsed.redditId,
    subreddit: parsed.subreddit,
    title: cleanText(result.title),
    permalink: parsed.permalink,
    url: result.url,
    score: 0,
    comments: 0,
    created_utc: createdUtcFromAge(result.age),
    selftext: snippet || null,
    provider: "brave_search",
    snippet,
    signal_strength: "fallback",
    brave_rank: braveRank,
  };
}

async function fetchRedditThreadMetrics(
  permalink: string
): Promise<{
  title: string | null;
  score: number;
  comments: number;
  created_utc: number | null;
  selftext: string | null;
} | null> {
  const url = new URL(`${permalink}.json`);
  url.searchParams.set("raw_json", "1");
  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "ytmanager/0.1 reddit-signal-enrichment",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Reddit thread JSON ${res.status}`);
  }

  const json = (await res.json()) as unknown;
  const firstListing = Array.isArray(json) ? json[0] : null;
  const firstChild =
    firstListing &&
    typeof firstListing === "object" &&
    "data" in firstListing
      ? (firstListing as { data?: { children?: unknown[] } }).data?.children?.[0]
      : null;
  const data =
    firstChild && typeof firstChild === "object" && "data" in firstChild
      ? (firstChild as { data?: Record<string, unknown> }).data
      : null;
  if (!data) return null;

  const score = typeof data.score === "number" ? data.score : 0;
  const comments = typeof data.num_comments === "number" ? data.num_comments : 0;
  const created =
    typeof data.created_utc === "number" ? Math.floor(data.created_utc) : null;
  return {
    title: typeof data.title === "string" ? cleanText(data.title) : null,
    score,
    comments,
    created_utc: created,
    selftext: typeof data.selftext === "string" ? cleanText(data.selftext) : null,
  };
}

async function enrichRedditSearchHit(hit: RedditSearchHit): Promise<RedditSearchHit> {
  try {
    const metrics = await fetchRedditThreadMetrics(hit.permalink);
    if (!metrics) return hit;
    return {
      ...hit,
      title: metrics.title || hit.title,
      score: metrics.score,
      comments: metrics.comments,
      created_utc: metrics.created_utc ?? hit.created_utc,
      selftext: metrics.selftext || hit.selftext,
      signal_strength: "metrics",
    };
  } catch (err) {
    log.warn("reddit", "Reddit permalink metric enrichment failed", {
      permalink: hit.permalink,
      error: err instanceof Error ? err.message : String(err),
    });
    return hit;
  }
}

function buildSummary(topic: string, hit: RedditSearchHit): string {
  const date = shortDate(hit.created_utc);
  const snippet = hit.snippet ? ` The search snippet says: "${hit.snippet.slice(0, 260)}"` : "";
  const metric =
    hit.signal_strength === "metrics"
      ? ` Reddit metrics show ${hit.score} upvotes and ${hit.comments} comments.`
      : ` Reddit score/comment metrics were unavailable, so this is accepted only as a recent top Brave result.`;
  return `On ${date}, Brave Search surfaced a Reddit thread in r/${hit.subreddit} while researching ${topic}: "${hit.title}".${metric}${snippet} This is a topic-demand signal only; YouTube outliers must still supply the format.`;
}

function projectRoot(): string {
  let cur = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(cur, "package.json"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

function appendResearchUpdates(items: RedditResearchItem[]): void {
  const fresh = items.filter((item) => !item.reused);
  if (fresh.length === 0) return;
  const dir = path.join(projectRoot(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "research-updates.txt");
  const body = fresh
    .map((item) => {
      const date = shortDate(item.created_utc);
      return [
        `[${new Date().toISOString()}] ${item.topic} / r/${item.subreddit}`,
        `  ${date}: ${item.title}`,
        `  ${item.summary}`,
        `  ${item.permalink}`,
        "",
      ].join("\n");
    })
    .join("\n");
  fs.appendFileSync(file, body, "utf-8");
}

function signalStrengthFromSourceJson(
  sourceJson: string | null | undefined,
  score: number,
  comments: number
): RedditSignalStrength {
  if (sourceJson) {
    try {
      const parsed = JSON.parse(sourceJson) as { signal_strength?: unknown };
      if (parsed.signal_strength === "metrics" || parsed.signal_strength === "fallback") {
        return parsed.signal_strength;
      }
    } catch {
      /* old rows may have malformed or absent source metadata */
    }
  }
  return hasViralRedditMetrics({ score, comments }) ? "metrics" : "fallback";
}

function insertOrReuseResearch(args: {
  userChannelId: string;
  generationId?: string | null;
  topic: string;
  hit: RedditSearchHit;
}): RedditResearchItem {
  const key = redditDedupeKey({
    topic: args.topic,
    subreddit: args.hit.subreddit,
    permalink: args.hit.permalink,
    title: args.hit.title,
  });
  const existing = db
    .prepare(
      `SELECT id, topic_key, subreddit, title, permalink, score, comments,
              created_utc, summary, source_json
       FROM reddit_research_items
       WHERE dedupe_key = ?`
    )
    .get(key) as
    | (Omit<RedditResearchItem, "topic" | "reused" | "signal_strength"> & {
        source_json: string | null;
      })
    | undefined;

  let item: RedditResearchItem;
  if (existing) {
    const { source_json: sourceJson, ...row } = existing;
    const existingStrength = signalStrengthFromSourceJson(
      sourceJson,
      existing.score,
      existing.comments
    );
    const shouldRefreshMetrics =
      args.hit.signal_strength === "metrics" &&
      (existingStrength !== "metrics" ||
        args.hit.score !== existing.score ||
        args.hit.comments !== existing.comments ||
        (!existing.created_utc && !!args.hit.created_utc));

    if (shouldRefreshMetrics) {
      const summary = buildSummary(args.topic, args.hit);
      db.prepare(
        `UPDATE reddit_research_items
         SET title = ?, score = ?, comments = ?, created_utc = COALESCE(?, created_utc),
             summary = ?, source_json = ?
         WHERE id = ?`
      ).run(
        args.hit.title,
        args.hit.score,
        args.hit.comments,
        args.hit.created_utc,
        summary,
        JSON.stringify({
          ...args.hit,
          provider: "brave_search",
          signal_strength: args.hit.signal_strength,
          brave_rank: args.hit.brave_rank,
        }),
        existing.id
      );
      item = {
        ...row,
        title: args.hit.title,
        score: args.hit.score,
        comments: args.hit.comments,
        created_utc: args.hit.created_utc ?? existing.created_utc,
        summary,
        topic: args.topic,
        signal_strength: args.hit.signal_strength,
        reused: true,
      };
    } else {
      item = {
        ...row,
        topic: args.topic,
        signal_strength: existingStrength,
        reused: true,
      };
    }
  } else {
    const summary = buildSummary(args.topic, args.hit);
    const info = db
      .prepare(
        `INSERT INTO reddit_research_items
           (user_channel_id, topic_key, subreddit, reddit_id, title, permalink,
            score, comments, created_utc, summary, dedupe_key, source_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        args.userChannelId,
        topicKey(args.topic),
        args.hit.subreddit,
        args.hit.reddit_id,
        args.hit.title,
        args.hit.permalink,
        args.hit.score,
        args.hit.comments,
        args.hit.created_utc,
        summary,
        key,
        JSON.stringify({
          ...args.hit,
          provider: "brave_search",
          signal_strength: args.hit.signal_strength,
          brave_rank: args.hit.brave_rank,
        })
      );
    item = {
      id: Number(info.lastInsertRowid),
      topic_key: topicKey(args.topic),
      topic: args.topic,
      subreddit: args.hit.subreddit,
      title: args.hit.title,
      permalink: args.hit.permalink,
      score: args.hit.score,
      comments: args.hit.comments,
      created_utc: args.hit.created_utc,
      summary,
      signal_strength: args.hit.signal_strength,
      reused: false,
    };
  }

  if (args.generationId) {
    db.prepare(
      `INSERT OR IGNORE INTO generation_research_items (generation_id, research_item_id)
       VALUES (?, ?)`
    ).run(args.generationId, item.id);
  }
  return item;
}

export async function collectRedditResearch(
  options: SearchOptions
): Promise<RedditResearchItem[]> {
  if (!hasRedditSignalProvider()) {
    throw new Error("Brave Search API key missing — add it in /settings/integrations");
  }
  const subreddits = options.subreddits
    .map((s) => normalizeSubreddit(s))
    .filter((s): s is string => !!s)
    .slice(0, 8);
  if (subreddits.length === 0) {
    throw new Error("No Reddit sources configured for this channel — add one subreddit per line in /channel-info");
  }
  const topics = options.topics
    .map(cleanText)
    .filter((t) => t.length >= 3)
    .slice(0, 8);
  if (topics.length === 0) return [];

  const maxItems = options.maxItems ?? 18;
  const items: RedditResearchItem[] = [];
  const seen = new Set<string>();

  for (const topic of topics) {
    for (const subreddit of subreddits) {
      if (items.length >= maxItems) break;
      try {
        const hits = await searchBraveWeb({
          query: `site:reddit.com/r/${subreddit} ${topic}`,
          count: 10,
          freshness: "pm",
        });
        for (const [rankIndex, result] of hits.entries()) {
          if (items.length >= maxItems) break;
          const rawHit = normalizeBraveRedditResult(result, subreddit, rankIndex + 1);
          if (!rawHit) continue;
          const hit = await enrichRedditSearchHit(rawHit);
          if (!isUsableRedditSignal(hit)) {
            log.info("reddit", "skipping non-viral Reddit result", {
              subreddit,
              topic,
              permalink: hit.permalink,
              score: hit.score,
              comments: hit.comments,
              created_utc: hit.created_utc,
              signal_strength: hit.signal_strength,
              brave_rank: hit.brave_rank,
            });
            continue;
          }
          const key = redditDedupeKey({
            topic,
            subreddit: hit.subreddit,
            permalink: hit.permalink,
            title: hit.title,
          });
          if (seen.has(key)) continue;
          seen.add(key);
          items.push(
            insertOrReuseResearch({
              userChannelId: options.userChannelId,
              generationId: options.generationId,
              topic,
              hit,
            })
          );
        }
      } catch (err) {
        log.warn("reddit", "Brave subreddit search failed", {
          subreddit,
          topic,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const ranked = items.sort((a, b) => {
    const aMetrics = a.signal_strength === "metrics" ? 1 : 0;
    const bMetrics = b.signal_strength === "metrics" ? 1 : 0;
    if (aMetrics !== bMetrics) return bMetrics - aMetrics;
    const aEngagement = Math.max(a.score, a.comments * 5);
    const bEngagement = Math.max(b.score, b.comments * 5);
    if (aEngagement !== bEngagement) return bEngagement - aEngagement;
    return (b.created_utc ?? 0) - (a.created_utc ?? 0);
  });
  appendResearchUpdates(ranked);
  return ranked;
}
