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

function createdUtcFromAge(age: string | null): number | null {
  if (!age) return null;
  const parsed = Date.parse(age);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1000);
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
  expectedSubreddit: string
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
  };
}

function buildSummary(topic: string, hit: RedditSearchHit): string {
  const date = shortDate(hit.created_utc);
  const snippet = hit.snippet ? ` The search snippet says: "${hit.snippet.slice(0, 260)}"` : "";
  return `On ${date}, Brave Search surfaced a Reddit thread in r/${hit.subreddit} while researching ${topic}: "${hit.title}".${snippet} This is a web-search signal for audience demand, not a direct Reddit API metric.`;
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
              created_utc, summary
       FROM reddit_research_items
       WHERE dedupe_key = ?`
    )
    .get(key) as Omit<RedditResearchItem, "topic" | "reused"> | undefined;

  let item: RedditResearchItem;
  if (existing) {
    item = { ...existing, topic: args.topic, reused: true };
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
        JSON.stringify({ ...args.hit, provider: "brave_search" })
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
        for (const result of hits) {
          if (items.length >= maxItems) break;
          const hit = normalizeBraveRedditResult(result, subreddit);
          if (!hit) continue;
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

  appendResearchUpdates(items);
  return items;
}
