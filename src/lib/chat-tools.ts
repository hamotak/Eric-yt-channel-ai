import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import {
  competitorGapAnalysis,
  getActiveChannelId,
  getChannel,
  getComment,
  getCommentAnalysis,
  getIntegration,
  getSetting,
  getTranscript,
  listAllChannels,
  listCompetitorAlerts,
  listCompetitors,
  listReplies,
  listTopLevelComments,
  listVideos,
  searchComments,
  searchTranscripts,
  recordDeepgramUsage,
  upsertTranscript,
  videoStats,
} from "./db";
import {
  fetchComments,
  fetchTrending,
  fetchTranscriptFree,
  nicheExplorer,
  searchYouTube,
  youtubeSuggest,
} from "./youtube";
import { exaGetContents, exaSearch } from "./exa";
import { apifyYouTubeScrape } from "./apify";
import { transcribeYouTubeVideo } from "./deepgram";
import { runSelect, SQL_SCHEMA } from "./sql-tool";
import { extractSection, loadMentorMethod } from "./mentor-method";
import {
  fetchChannelOverview,
  fetchVideoAnalytics,
  fetchChannelAudience,
  fetchChannelRevenue,
  getRevenueAccessFlag,
  YtAnalyticsError,
  type PeriodSpec,
} from "./yt-analytics";
import { getOAuthTokens } from "./google-oauth";

/** A tool group the user can enable/disable via the "+" menu in chat. */
export type ToolGroup =
  | "youtube"
  | "exa"
  | "apify"
  | "analytics"
  | "research"
  | "yt_analytics"
  | "strategy";

type Tool = Anthropic.Tool;
type ToolInput = Record<string, unknown>;

function requireKey(name: string): string {
  const key = getIntegration(name)?.api_key;
  if (!key) throw new Error(`${name} API key is not configured`);
  return key;
}

// ---------------------------------------------------------------------------
// Tool schemas — what Claude sees
// ---------------------------------------------------------------------------

const YOUTUBE_TOOLS: Tool[] = [
  {
    name: "channel_summary",
    description:
      "Return overall stats for the user's bound YouTube channel: title, subscribers, total views, videos, average views/likes/comments across imported videos. Use this first when the user asks about 'my channel'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_my_videos",
    description:
      "List the user's own imported videos from local DB, sorted by recent publish date. Optionally filter by text search across title/description. Returns id, title, views, likes, comments, duration, publishedAt.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional keyword filter." },
        limit: { type: "number", description: "Default 50, max 200.", default: 50 },
      },
    },
  },
  {
    name: "search_my_transcripts",
    description:
      "Full-text search across transcripts of the user's own videos. Use when the user asks what they said about a topic, or to find which videos discuss something.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "get_video_comments",
    description:
      "Fetch top-level YouTube comments for a video by ID. Use to analyze audience reaction / sentiment. Costs 1 YouTube API unit per ~100 comments.",
    input_schema: {
      type: "object",
      properties: {
        videoId: { type: "string", description: "YouTube video ID (11 chars)." },
        max: { type: "number", default: 50 },
      },
      required: ["videoId"],
    },
  },
  {
    name: "list_video_comments_cached",
    description:
      "Return top-level comments for one of the USER'S OWN videos from the local cache (already synced via the UI). Prefer this over `get_video_comments` when the user asks about their own video — it's instant and costs no API quota. Each comment has reply_count; call `get_comment_thread` to read replies.",
    input_schema: {
      type: "object",
      properties: {
        videoId: { type: "string" },
        limit: { type: "number", default: 50, maximum: 200 },
        offset: { type: "number", default: 0 },
      },
      required: ["videoId"],
    },
  },
  {
    name: "search_my_comments",
    description:
      "Full-text search across ALL cached comments on the user's videos (FTS5). Use for audience-sentiment questions like \"what do people say about X\", \"who mentioned sponsorship\", \"complaints about audio quality\". Returns comment text + author + like_count + video_id + video_title. No API quota.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 20, maximum: 100 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_comment_thread",
    description:
      "Fetch a single top-level comment plus all its cached replies from the local cache. Use after `search_my_comments` or `list_video_comments_cached` to read the full discussion under a specific comment.",
    input_schema: {
      type: "object",
      properties: {
        commentId: { type: "string" },
      },
      required: ["commentId"],
    },
  },
  {
    name: "search_youtube",
    description:
      "Search public YouTube for videos or channels matching a query. Costs 100 YouTube API units — use sparingly. Returns titles, channels, IDs.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", enum: ["video", "channel"], default: "video" },
        maxResults: { type: "number", default: 10 },
      },
      required: ["query"],
    },
  },
];

const EXA_TOOLS: Tool[] = [
  {
    name: "web_search",
    description:
      "Semantic web search via Exa AI. Use for research, trends, news, competitor intel, industry data. Returns titles, URLs, and (if requested) text snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        numResults: { type: "number", default: 8 },
        includeText: {
          type: "boolean",
          default: true,
          description: "Include text snippets from each page.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch cleaned readable text of specific URLs via Exa. Use after web_search to drill into promising results.",
    input_schema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, maxItems: 5 },
      },
      required: ["urls"],
    },
  },
];

const ANALYTICS_TOOLS: Tool[] = [
  {
    name: "execute_sql",
    description:
      `Run a **read-only** SELECT against the local SQLite database. Use this for statistical / structured analysis of the user's videos (averages, correlations, bucketing by month, tag analysis, outlier detection). Returns up to 200 rows.\n\nSchema:\n${SQL_SCHEMA}`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A single SELECT/WITH statement." },
      },
      required: ["query"],
    },
  },
  {
    name: "youtube_trending",
    description:
      "List what's trending on YouTube right now by region. Useful to spot format patterns and hot topics. Free (1 YouTube API unit).",
    input_schema: {
      type: "object",
      properties: {
        regionCode: { type: "string", description: "ISO 3166-1 alpha-2 (US, UA, GB, ...)", default: "US" },
        categoryId: { type: "string", description: "Optional YT videoCategoryId." },
        maxResults: { type: "number", default: 25, maximum: 50 },
      },
    },
  },
  {
    name: "niche_explorer",
    description:
      "Given a topic/niche phrase, returns the top-5 channels by subscribers and top-10 outlier videos (highest views in the last 6 months). Costs ~200 YouTube API units — use once per niche question.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        maxChannels: { type: "number", default: 5, maximum: 10 },
      },
      required: ["topic"],
    },
  },
  {
    name: "fetch_transcript",
    description:
      "Fetch the transcript of a YouTube video (any public video with captions — manual or auto). Free, no API key. Caches result in local DB if the video is already known.",
    input_schema: {
      type: "object",
      properties: {
        videoId: { type: "string", description: "YouTube 11-char video ID." },
        lang: { type: "string", description: "Preferred language code (en, uk, ...)" },
      },
      required: ["videoId"],
    },
  },
];

const RESEARCH_TOOLS: Tool[] = [
  {
    name: "youtube_suggest",
    description:
      "YouTube search autocomplete — returns what YouTube users actually type when searching for a seed query. Perfect for discovering long-tail topic ideas and content gaps. Free, no API key.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        hl: { type: "string", description: "Language (en, uk, ...)", default: "en" },
        gl: { type: "string", description: "Country code (US, UA, ...)" },
      },
      required: ["query"],
    },
  },
  // NOTE: `google_trends_interest` + `google_trends_related` were removed —
  // the underlying Apify actor hits Google Trends without an official API,
  // and Google returns 429 against Apify's datacenter IPs essentially all
  // the time. The tool was burning research iterations on guaranteed
  // failures. `youtube_suggest` (autocomplete) covers real search demand
  // well enough as a substitute signal. The `./trends.ts` library is
  // intentionally left in the repo in case we bring it back via residential
  // proxies or a different provider.
];

const APIFY_TOOLS: Tool[] = [
  {
    name: "scrape_youtube_channel",
    description:
      "Use Apify to scrape a YouTube channel (usually a competitor, not the user's own channel). Returns up to `maxResults` videos with title, views, likes, duration, comment count, and optionally transcripts. Slower and more expensive than the YouTube API, but bypasses quota and can fetch transcripts.",
    input_schema: {
      type: "object",
      properties: {
        channelUrl: {
          type: "string",
          description: "Channel URL like https://www.youtube.com/@handle or /channel/UC...",
        },
        maxResults: { type: "number", default: 20, maximum: 100 },
        includeTranscript: { type: "boolean", default: false },
      },
      required: ["channelUrl"],
    },
  },
  {
    name: "get_youtube_transcript",
    description:
      "Transcribe one or more YouTube videos via Deepgram (yt-dlp pulls audio locally, streams to Deepgram). Caches results into the local transcripts DB. Costs ≈$0.0043/min against the user's Deepgram credit.",
    input_schema: {
      type: "object",
      properties: {
        videoUrls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
      },
      required: ["videoUrls"],
    },
  },
];

// ---------------------------------------------------------------------------
// YouTube Analytics tools — proxy the same /v2/reports calls the dashboard
// uses, but expose them to Claude so it can answer questions like "where do
// viewers drop off in this video?" or "where is most of my watch time
// coming from?". All four require a working Google OAuth connection AND
// for the connected user to have at least Brand Account Manager / Owner
// access on the channel — Channel Permissions Manager will 403 (we
// translate that to a clear error so Claude tells the user what to do).
// ---------------------------------------------------------------------------

const PERIOD_ENUM = ["7d", "28d", "90d", "365d", "all"] as const;

const YT_ANALYTICS_TOOLS: Tool[] = [
  {
    name: "get_channel_analytics_overview",
    description:
      "Live channel-level analytics from YouTube Analytics API for a chosen period. Returns totals (views, watch minutes, subscribers gained/lost, likes, comments, shares), the same metrics for the preceding period of equal length (so you can compute Δ% trends), a daily time series, and the top 10 videos in the period sorted by views. Use whenever the user asks about overall channel performance over a window of time.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: [...PERIOD_ENUM],
          description: "Time window. 'all' = since channel creation.",
          default: "28d",
        },
      },
    },
  },
  {
    name: "get_video_analytics",
    description:
      "Per-video DEEP analytics from YouTube Analytics API. Returns a thick bundle: " +
      "(1) totals — views, watch minutes, avg view duration, average view percentage, likes, comments, shares, subscribers gained/lost, playlist additions/removals; " +
      "(2) daily time series for views, watch time, likes, comments, subs gained/lost; " +
      "(3) audience retention curve — fraction of viewers still watching at each percentage point of the video (use to identify drop-off moments); " +
      "(4) traffic sources (YT_SEARCH, SUGGESTED_VIDEO, EXTERNAL, BROWSE, etc.); " +
      "(5) playback locations — WATCH page, EMBEDDED on third-party sites, CHANNEL page, SEARCH, SHORTS feed; " +
      "(6) top YouTube SEARCH terms that led viewers to this video (gold for SEO); " +
      "(7) sharing services — where viewers shared the video (Twitter, WhatsApp, Reddit, etc.); " +
      "(8) operating systems breakdown; " +
      "(9) subscribed-vs-not breakdown — subscribed audience vs new viewers, with separate watch time / avg duration for each; " +
      "(10) demographics (age × gender, viewer percentages); " +
      "(11) geography — top countries by views; " +
      "(12) cards & end-screen performance — impressions, clicks, CTR for overlay cards and end-screen elements; " +
      "(13) vsChannelAverage — how this video's views/watch/duration compares to the channel's typical video (1.0× = average). " +
      "Use whenever the user asks about a SPECIFIC video — retention drops, traffic, audience, search keywords, sharing patterns, anything.",
    input_schema: {
      type: "object",
      properties: {
        videoId: { type: "string", description: "YouTube 11-char video ID." },
        period: {
          type: "string",
          enum: [...PERIOD_ENUM],
          description: "Time window. 'all' = since video published.",
          default: "28d",
        },
      },
      required: ["videoId"],
    },
  },
  {
    name: "get_channel_audience",
    description:
      "Channel-wide audience analytics: demographics (age × gender breakdown), top 25 countries by views, device split (mobile/desktop/tablet/TV), and traffic sources. Use when the user asks WHO is watching the channel, WHERE they are, or HOW they find the videos.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["28d", "90d", "365d", "all"],
          default: "28d",
        },
      },
    },
  },
  {
    name: "get_channel_revenue",
    description:
      "Revenue analytics: estimated revenue, ad revenue, YouTube Premium revenue, gross revenue, CPM, playback CPM, monetized playbacks, ad impressions, daily revenue trend, and the top 10 earning videos. Requires the connected Google account to have Owner-tier access — Manager-tier returns a 'denied' result you should relay to the user. Only call when the user explicitly asks about money / earnings / RPM / CPM.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: [...PERIOD_ENUM],
          default: "28d",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Strategy tools — every Phase D / B dataset, exposed read-only so chat can
// reason about the user's channel the same way the dashboards do.
// ---------------------------------------------------------------------------
const STRATEGY_TOOLS: Tool[] = [
  {
    name: "list_competitors",
    description:
      "List the user's tracked competitor channels with their subs, video counts, and last sync time. Use whenever the user asks who they're tracking, or wants channel-by-channel competitor stats.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "competitor_gap_analysis",
    description:
      "Find title keywords frequent in competitors' top videos that the user has NEVER used. Returns words ranked by aggregate competitor views, with usage frequency and example titles. Use when the user wants ideas grounded in proven competitor formulas.",
    input_schema: {
      type: "object",
      properties: { topN: { type: "number", default: 25 } },
    },
  },
  {
    name: "get_comment_analysis",
    description:
      "Return the cached AI audience analysis for one video — sentiment 1-10, top themes, credibility objections, future-video ideas, standout quote candidates. Returns 'no analysis yet' if the user hasn't run it; tell them to open the Comments tab and click 'Analyse with AI'.",
    input_schema: {
      type: "object",
      properties: { videoId: { type: "string" } },
      required: ["videoId"],
    },
  },
  {
    name: "list_outliers",
    description:
      "List the active channel's competitor outliers — competitor videos that beat their own channel's median views. Two modes: (default) the methodology-canonical view — 60-day window, ≥2× median per MENTOR_METHOD §2, sorted by multiplier DESC; or set recent_only=true for the discovery log — alert rows generated when a competitor video first crossed the 1.5× generation floor, sorted by detection time DESC. Pass unreadOnly=true (with recent_only) to filter the discovery log to rows the user hasn't acknowledged. Always scoped to the active channel. Returns: { outliers: [{ videoId, title, thumbnailUrl, views, multiplier, channelMedian, publishedAt, competitorTitle, competitorHandle, tier, detectedAt?, unread? }] }.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 50 },
        recent_only: {
          type: "boolean",
          description:
            "When true, return the alert/discovery log (1.5× floor, sorted newest first) instead of the methodology view (2× floor, sorted by multiplier).",
          default: false,
        },
        unreadOnly: {
          type: "boolean",
          description:
            "Only honored when recent_only=true. Filters to alerts the user hasn't marked read.",
          default: false,
        },
      },
    },
  },
  {
    name: "explain_outlier",
    description:
      "Get the cached \"what made it work\" lever tags (per MENTOR_METHOD §9) + 2-3 sentence explanation for one outlier video. If no cache exists yet, this call generates one and caches it permanently. Use after list_outliers to reason about WHY a specific video broke out. Returns: { levers: string[2-3], explanation: string, cached: boolean }.",
    input_schema: {
      type: "object",
      properties: { videoId: { type: "string" } },
      required: ["videoId"],
    },
  },
  {
    name: "generate_ideas",
    description:
      "Synthesise 5-10 new video ideas for the user's active channel, grounded in their channel context AND in real competitor outliers. If `outlierVideoIds` is omitted, the top 10 outliers by multiplier in the active scope are auto-picked. Each idea references a specific source outlier and uses one lever from §9. Rate-limited to 1 call per channel per 5 min. Returns: { ideas: [{ topic, suggestedTitle, angle, confidence, sourceOutlierVideoId }] }.",
    input_schema: {
      type: "object",
      properties: {
        outlierVideoIds: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "list_format_patterns",
    description:
      "List the active channel's extracted title-format patterns (per MENTOR_METHOD §4). Each pattern is a structural template like \"[Place]'s most [Adjective] [Thing]\" plus its avg multiplier, total monthly views, and rising rate. Sorted by rising rate DESC. Pre-requisite: the user has run 'Extract format patterns' on the /outliers Patterns tab — without that this returns an empty array. Returns: { formats: [{ template, avgMultiplier, totalViewsMonth, risingRate, exampleVideoIds: string[] }] }.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", default: 20 } },
    },
  },
];

export function getToolsFor(groups: ToolGroup[]): Tool[] {
  const set = new Set(groups);
  const tools: Tool[] = [];
  if (set.has("youtube")) tools.push(...YOUTUBE_TOOLS);
  if (set.has("analytics")) tools.push(...ANALYTICS_TOOLS);
  if (set.has("research")) tools.push(...RESEARCH_TOOLS);
  if (set.has("exa")) tools.push(...EXA_TOOLS);
  if (set.has("apify")) tools.push(...APIFY_TOOLS);
  if (set.has("yt_analytics")) tools.push(...YT_ANALYTICS_TOOLS);
  if (set.has("strategy")) tools.push(...STRATEGY_TOOLS);
  return tools;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export async function runTool(name: string, input: ToolInput): Promise<ToolResult> {
  try {
    switch (name) {
      case "channel_summary": {
        const channel = getChannel();
        const stats = videoStats();
        return { ok: true, data: { channel, stats } };
      }
      case "list_my_videos": {
        const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
        const search = typeof input.search === "string" ? input.search : undefined;
        const rows = listVideos({ limit, search });
        return {
          ok: true,
          data: rows.map((v) => ({
            id: v.id,
            title: v.title,
            views: v.views,
            likes: v.likes,
            comments: v.comments,
            duration: v.duration_seconds,
            publishedAt: v.published_at,
          })),
        };
      }
      case "search_my_transcripts": {
        const q = String(input.query ?? "").trim();
        if (!q) return { ok: false, error: "query required" };
        return { ok: true, data: searchTranscripts(q, 20) };
      }
      case "get_video_comments": {
        const key = requireKey("youtube");
        const videoId = String(input.videoId ?? "").trim();
        const max = Math.min(500, Math.max(1, Number(input.max) || 50));
        if (!videoId) return { ok: false, error: "videoId required" };
        return { ok: true, data: await fetchComments(videoId, key, max) };
      }
      case "list_video_comments_cached": {
        const videoId = String(input.videoId ?? "").trim();
        if (!videoId) return { ok: false, error: "videoId required" };
        const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
        const offset = Math.max(0, Number(input.offset) || 0);
        const rows = listTopLevelComments(videoId, limit, offset);
        return {
          ok: true,
          data: rows.map((c) => ({
            id: c.id,
            author: c.author,
            text: c.text,
            likes: c.like_count,
            replyCount: c.reply_count,
            publishedAt: c.published_at,
          })),
        };
      }
      case "search_my_comments": {
        const q = String(input.query ?? "").trim();
        if (!q) return { ok: false, error: "query required" };
        const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
        const rows = searchComments(q, limit);
        return {
          ok: true,
          data: rows.map((c) => ({
            id: c.id,
            videoId: c.video_id,
            videoTitle: c.video_title,
            parentId: c.parent_id,
            author: c.author,
            text: c.text,
            likes: c.like_count,
            replyCount: c.reply_count,
            publishedAt: c.published_at,
          })),
        };
      }
      case "get_comment_thread": {
        const commentId = String(input.commentId ?? "").trim();
        if (!commentId) return { ok: false, error: "commentId required" };
        const top = getComment(commentId);
        if (!top) return { ok: false, error: "comment not found in cache" };
        // If caller passed a reply id, resolve the actual parent.
        const parent = top.parent_id ? getComment(top.parent_id) ?? top : top;
        const replies = listReplies(parent.id);
        return {
          ok: true,
          data: {
            parent: {
              id: parent.id,
              videoId: parent.video_id,
              author: parent.author,
              text: parent.text,
              likes: parent.like_count,
              replyCount: parent.reply_count,
              publishedAt: parent.published_at,
            },
            replies: replies.map((r) => ({
              id: r.id,
              author: r.author,
              text: r.text,
              likes: r.like_count,
              publishedAt: r.published_at,
            })),
          },
        };
      }
      case "search_youtube": {
        const key = requireKey("youtube");
        const query = String(input.query ?? "").trim();
        if (!query) return { ok: false, error: "query required" };
        const type = (input.type === "channel" ? "channel" : "video") as "video" | "channel";
        const maxResults = Math.min(25, Math.max(1, Number(input.maxResults) || 10));
        return { ok: true, data: await searchYouTube(query, key, { type, maxResults }) };
      }
      case "web_search": {
        const key = requireKey("exa");
        const query = String(input.query ?? "").trim();
        if (!query) return { ok: false, error: "query required" };
        const numResults = Math.min(20, Math.max(1, Number(input.numResults) || 8));
        const includeText = input.includeText !== false;
        return {
          ok: true,
          data: await exaSearch(query, key, { numResults, includeText }),
        };
      }
      case "web_fetch": {
        const key = requireKey("exa");
        const urls = Array.isArray(input.urls)
          ? (input.urls as unknown[]).filter((u): u is string => typeof u === "string").slice(0, 5)
          : [];
        if (!urls.length) return { ok: false, error: "urls required" };
        return { ok: true, data: await exaGetContents(urls, key) };
      }
      case "scrape_youtube_channel": {
        const key = requireKey("apify");
        const channelUrl = String(input.channelUrl ?? "").trim();
        if (!channelUrl) return { ok: false, error: "channelUrl required" };
        const maxResults = Math.min(100, Math.max(1, Number(input.maxResults) || 20));
        const includeTranscript = !!input.includeTranscript;
        return {
          ok: true,
          data: await apifyYouTubeScrape(
            { startUrls: [{ url: channelUrl }], maxResults, includeTranscript },
            key
          ),
        };
      }
      case "execute_sql": {
        const query = String(input.query ?? "").trim();
        if (!query) return { ok: false, error: "query required" };
        const result = runSelect(query, 200);
        // Convert to array of objects for readability
        const { columns, rows } = result;
        const objects = rows.map((r) => {
          const obj: Record<string, unknown> = {};
          columns.forEach((c, i) => {
            obj[c] = r[i];
          });
          return obj;
        });
        return { ok: true, data: { columns, rowCount: rows.length, rows: objects } };
      }
      case "youtube_trending": {
        const key = requireKey("youtube");
        const regionCode = typeof input.regionCode === "string" ? input.regionCode : "US";
        const categoryId = typeof input.categoryId === "string" ? input.categoryId : undefined;
        const maxResults = Math.min(50, Math.max(1, Number(input.maxResults) || 25));
        const vids = await fetchTrending(key, { regionCode, categoryId, maxResults });
        // Return compact shape
        return {
          ok: true,
          data: vids.map((v) => ({
            id: v.id,
            title: v.title,
            channel: v.channelId,
            views: v.views,
            likes: v.likes,
            duration: v.durationSeconds,
            publishedAt: v.publishedAt,
            tags: v.tags.slice(0, 6),
          })),
        };
      }
      case "niche_explorer": {
        const key = requireKey("youtube");
        const topic = String(input.topic ?? "").trim();
        if (!topic) return { ok: false, error: "topic required" };
        const maxChannels = Math.min(10, Math.max(1, Number(input.maxChannels) || 5));
        return {
          ok: true,
          data: await nicheExplorer(topic, key, { maxChannels }),
        };
      }
      case "fetch_transcript": {
        const videoId = String(input.videoId ?? "").trim();
        if (!videoId) return { ok: false, error: "videoId required" };
        const lang = typeof input.lang === "string" ? input.lang : undefined;
        const cached = getTranscript(videoId);
        if (cached) {
          return {
            ok: true,
            data: { videoId, language: cached.language, text: cached.text.slice(0, 20_000), cached: true },
          };
        }
        const t = await fetchTranscriptFree(videoId, { lang });
        if (!t) return { ok: false, error: "no transcript available" };
        upsertTranscript(videoId, t.text, t.language);
        return {
          ok: true,
          data: { videoId, language: t.language, text: t.text.slice(0, 20_000), cached: false },
        };
      }
      case "youtube_suggest": {
        const query = String(input.query ?? "").trim();
        if (!query) return { ok: false, error: "query required" };
        const hl = typeof input.hl === "string" ? input.hl : "en";
        const gl = typeof input.gl === "string" ? input.gl : undefined;
        return { ok: true, data: await youtubeSuggest(query, { hl, gl }) };
      }
      // google_trends_* cases removed — the underlying scraper consistently
      // returns 429 and the tools aren't exposed to Claude anymore.
      case "get_youtube_transcript": {
        const key = requireKey("deepgram");
        const urls = Array.isArray(input.videoUrls)
          ? (input.videoUrls as unknown[]).filter((u): u is string => typeof u === "string").slice(0, 10)
          : [];
        if (!urls.length) return { ok: false, error: "videoUrls required" };
        // Extract the 11-char videoId from each URL and run Deepgram on
        // each in series. Sequential rather than parallel because (a)
        // yt-dlp + Deepgram per video is bursty CPU/network and we'd
        // rather not slam the local machine, and (b) Deepgram pre-recorded
        // tier limits concurrent jobs anyway.
        const results: Array<{
          url: string;
          videoId: string | null;
          transcript: string;
          language: string | null;
          error?: string;
        }> = [];
        for (const url of urls) {
          const m = /(?:youtu\.be\/|v=)([A-Za-z0-9_-]{11})/.exec(url);
          const videoId = m ? m[1] : null;
          if (!videoId) {
            results.push({ url, videoId: null, transcript: "", language: null, error: "could not extract videoId from URL" });
            continue;
          }
          // Serve from cache if we already have it — same DB the UI uses.
          const cached = getTranscript(videoId);
          if (cached) {
            results.push({ url, videoId, transcript: cached.text, language: cached.language });
            continue;
          }
          try {
            const r = await transcribeYouTubeVideo(videoId, key);
            upsertTranscript(videoId, r.text, r.language);
            recordDeepgramUsage({
              videoId,
              durationSeconds: r.durationSeconds,
              costCents: r.costCents,
              model: r.model,
            });
            results.push({ url, videoId, transcript: r.text, language: r.language });
          } catch (err) {
            results.push({
              url,
              videoId,
              transcript: "",
              language: null,
              error: err instanceof Error ? err.message : "transcription failed",
            });
          }
        }
        return { ok: true, data: results };
      }

      // ===== YouTube Analytics tools (Phase 6) =====
      // All four share the same pre-flight check: must be connected to
      // Google OAuth. We skip calling the wrapper if there's no token,
      // because the wrapper would throw a less helpful error.
      case "get_channel_analytics_overview":
      case "get_video_analytics":
      case "get_channel_audience":
      case "get_channel_revenue": {
        if (!getOAuthTokens()?.refresh_token) {
          return {
            ok: false,
            error:
              "YouTube Analytics is not connected. Tell the user to go to Integrations → YouTube Analytics (Google OAuth) and click Connect.",
          };
        }
        const period = (typeof input.period === "string" ? input.period : "28d") as
          | "7d"
          | "28d"
          | "90d"
          | "365d"
          | "all";
        const periodSpec: PeriodSpec = period === "all" ? "all" : Number(period.replace("d", ""));

        try {
          if (name === "get_channel_analytics_overview") {
            const data = await fetchChannelOverview(periodSpec);
            return { ok: true, data };
          }
          if (name === "get_video_analytics") {
            const videoId = String(input.videoId ?? "").trim();
            if (!videoId) return { ok: false, error: "videoId required" };
            const data = await fetchVideoAnalytics(videoId, periodSpec);
            return { ok: true, data };
          }
          if (name === "get_channel_audience") {
            const data = await fetchChannelAudience(periodSpec);
            return { ok: true, data };
          }
          // get_channel_revenue
          if (getRevenueAccessFlag() === "denied") {
            return {
              ok: false,
              error:
                "Revenue access denied for this account (Manager-tier or non-monetised channel). Tell the user this metric needs Owner-level access — you have no way to fetch it from this side. Continue with what you can get.",
            };
          }
          const data = await fetchChannelRevenue(periodSpec);
          return { ok: true, data };
        } catch (err) {
          if (err instanceof YtAnalyticsError) {
            // Translate 403 specifically — Claude should know this is a
            // permissions-not-bug situation and stop retrying.
            if (err.status === 403 || err.status === 401) {
              return {
                ok: false,
                error:
                  "YouTube Analytics 403/401 — the connected Google account doesn't have access to this data. This is a permissions issue, not a transient failure. Do NOT retry; tell the user the channel owner needs to elevate their role or reconnect with the owner's account.",
              };
            }
            return { ok: false, error: err.message };
          }
          throw err;
        }
      }

      // ===== Strategy tools (Phase D / E) =====
      // All three competitor tools scope to the user's currently-active
      // channel — competitors now belong to one of the user's channels,
      // not the global app. Without active scoping, Claude would see
      // every channel's competitors mixed together.
      case "list_competitors": {
        const activeId = getActiveChannelId() ?? undefined;
        const competitors = listCompetitors(activeId);
        return {
          ok: true,
          data: competitors.map((c) => ({
            id: c.id,
            handle: c.handle,
            title: c.title,
            channelId: c.channel_id,
            subscribers: c.subscriber_count,
            videoCount: c.video_count,
            tier: c.tier,
            userChannelId: c.user_channel_id,
            lastSyncAt: c.last_sync_at,
          })),
        };
      }
      case "competitor_gap_analysis": {
        const topN = Math.min(50, Math.max(5, Number(input.topN) || 25));
        // competitorGapAnalysis already falls back to getActiveChannelId
        // internally; explicit pass-through keeps the call site grep-able.
        return {
          ok: true,
          data: competitorGapAnalysis({
            topN,
            userChannelId: getActiveChannelId(),
          }),
        };
      }
      case "get_comment_analysis": {
        const videoId = String(input.videoId ?? "").trim();
        if (!videoId) return { ok: false, error: "videoId required" };
        const a = getCommentAnalysis(videoId);
        if (!a) {
          return {
            ok: false,
            error:
              "No comment analysis cached for this video. Open the Comments tab and click 'Analyse with AI' first.",
          };
        }
        const safe = <T,>(s: string | null, fb: T): T => {
          if (!s) return fb;
          try {
            return JSON.parse(s) as T;
          } catch {
            return fb;
          }
        };
        return {
          ok: true,
          data: {
            sentimentScore: a.sentiment_score,
            themes: safe(a.themes, [] as string[]),
            objections: safe(a.objections, [] as unknown[]),
            futureIdeas: safe(a.future_ideas, [] as unknown[]),
            hookCandidates: safe(a.hook_candidates, [] as unknown[]),
            summary: a.summary,
            analyzedAt: a.analyzed_at,
            commentsCount: a.comments_count,
          },
        };
      }
      case "list_outliers": {
        const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
        const recentOnly = !!input.recent_only;
        if (recentOnly) {
          const unreadOnly = !!input.unreadOnly;
          const alerts = listCompetitorAlerts({
            unreadOnly,
            limit,
            userChannelId: getActiveChannelId(),
          });
          return {
            ok: true,
            data: {
              outliers: alerts.map((a) => ({
                videoId: a.video_id,
                title: a.title,
                thumbnailUrl: a.thumbnail_url,
                views: a.views,
                multiplier: a.multiplier,
                channelMedian: a.channel_median_views,
                publishedAt: a.published_at,
                competitorTitle: a.competitor_title,
                competitorHandle: a.competitor_handle,
                tier: a.competitor_tier ?? null,
                detectedAt: a.detected_at,
                unread: !a.read_at,
              })),
            },
          };
        }
        const { listOutliersForActiveChannel } = await import("./outliers");
        const { outliers } = listOutliersForActiveChannel({ limit });
        return {
          ok: true,
          data: {
            outliers: outliers.map((o) => ({
              videoId: o.videoId,
              title: o.title,
              thumbnailUrl: o.thumbnailUrl,
              views: o.views,
              multiplier: o.multiplier,
              channelMedian: o.channelMedian,
              publishedAt: o.publishedAt,
              competitorTitle: o.competitorTitle,
              competitorHandle: o.competitorHandle,
              tier: o.tier,
            })),
          },
        };
      }
      case "explain_outlier": {
        const videoId = String(input.videoId ?? "").trim();
        if (!videoId) return { ok: false, error: "videoId required" };
        const { explainOutlier } = await import("./outlier-explain");
        const r = await explainOutlier({ videoId });
        if (!r.ok) return { ok: false, error: r.error };
        return {
          ok: true,
          data: {
            videoId: r.videoId,
            levers: r.levers,
            explanation: r.explanation,
            cached: r.cached,
          },
        };
      }
      case "generate_ideas": {
        const activeId = getActiveChannelId();
        if (!activeId) {
          return {
            ok: false,
            error:
              "No active channel — set one from the top-right channel picker before generating ideas.",
          };
        }
        const outlierVideoIds = Array.isArray(input.outlierVideoIds)
          ? input.outlierVideoIds.filter((v): v is string => typeof v === "string")
          : undefined;
        const { generateIdeasForChannel } = await import("./idea-generator");
        const r = await generateIdeasForChannel({
          userChannelId: activeId,
          outlierVideoIds,
        });
        if (!r.ok) {
          return {
            ok: false,
            error: r.retryAfterSec
              ? `${r.error} (try again in ${r.retryAfterSec}s)`
              : r.error,
          };
        }
        return {
          ok: true,
          data: { ideas: r.ideas, generatedAt: r.generatedAt },
        };
      }
      case "list_format_patterns": {
        const activeId = getActiveChannelId();
        if (!activeId) {
          return {
            ok: false,
            error:
              "No active channel — set one from the top-right channel picker.",
          };
        }
        const limit = Math.min(50, Math.max(1, Number(input.limit) || 20));
        const { getFormatsForChannel } = await import("./outlier-formats");
        const formats = getFormatsForChannel(activeId, limit);
        return {
          ok: true,
          data: {
            formats: formats.map((f) => ({
              template: f.template,
              avgMultiplier: f.avgMultiplier,
              totalViewsMonth: f.totalViewsMonth,
              risingRate: f.risingRate,
              exampleVideoIds: f.examples.map((e) => e.videoId),
            })),
          },
        };
      }
      default:
        return { ok: false, error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "tool execution failed",
    };
  }
}

// ---------------------------------------------------------------------------
// System prompt (context-aware)
// ---------------------------------------------------------------------------

export function buildSystemPrompt(
  activeGroups: ToolGroup[],
  opts: { advisorEnabled?: boolean } = {}
): string {
  const channel = getChannel();
  const bound = getSetting("youtube.channelId");
  // Pull the full list of connected channels too — when the user has
  // more than one, we have to make it crystal clear which one is
  // currently active, otherwise Claude has historically confused them.
  const allChannels = listAllChannels();

  // Methodology quotes — load once per request. MENTOR_METHOD.md lives
  // at the project root and is small (<10KB), so the cached read is
  // free. If the file ever moves the helpers fall back to empty strings
  // and the prompt still functions (just with less context).
  const md = loadMentorMethod();
  const sec1 = extractSection(md, 1);
  const sec2 = extractSection(md, 2);
  const sec4 = extractSection(md, 4);
  const sec7 = extractSection(md, 7);
  const sec9 = extractSection(md, 9);

  const lines: string[] = [
    `You are HAmo's central YouTube ideation agent for the Eric YT Channel AI app. Your job: turn channel context, competitor data, and outlier patterns into video ideas that follow the methodology below. Every output must be practical, specific, evidence-cited from tool calls, and grounded in MENTOR_METHOD.md — never speculation.`,
    ``,
    `## Mission`,
    `This app exists to help YouTube channels grow. Every recommendation must name a specific action grounded in data the user can see. If your answer could fit any channel in any niche, you failed — rewrite it with channel-specific evidence.`,
    ``,
    `## Quality bar — non-negotiable`,
    `- **No banal advice.** Forbidden phrases and any paraphrase of them: "post consistently", "optimize your titles", "engage with your audience", "understand your niche", "be authentic", "create quality content", "use SEO", "thumbnails matter". If you catch yourself writing something that sounds like generic creator-coach content, delete it and replace with a data-backed claim.`,
    `- **Every number must come from a tool call**, not from your training knowledge. If you don't have the number, say so.`,
    `- **Every recommendation must name a specific action.** Bad: "Try longer videos". Good: "Make a 15-20 min video titled 'X' — your 3 longest videos (>12min) have 2.4× the watch time of your Shorts, and competitor @Y publishes only this format."`,
    `- **Honesty over polish.** If the channel is small/inactive/wrong-niche, say it directly. Don't soften bad news.`,
    `- **No preamble.** Don't open with "Great question!" or "Let me analyse…". Go straight to the work.`,
    ``,
    `## Methodology — MENTOR_METHOD.md (load-bearing for every reply)`,
    ``,
    `### §1 — Competitor mapping (B&S Method)`,
    sec1 || "(section unavailable)",
    ``,
    `### §2 — Outliers (the engine)`,
    sec2 || "(section unavailable)",
    ``,
    `### §4 — Title formats (structural patterns, not literal titles)`,
    sec4 || "(section unavailable)",
    ``,
    `### §7 — Ideation (synthesizing the inputs)`,
    sec7 || "(section unavailable)",
    ``,
    `### §9 — The "what made it work" lever taxonomy`,
    sec9 || "(section unavailable)",
    ``,
    `## User context`,
  ];
  if (channel) {
    lines.push(
      `- **Active channel** (this is the one every local-DB tool is scoped to right now): "${channel.title ?? "(unknown)"}"${channel.handle ? ` — ${channel.handle}` : ""}, id \`${channel.id}\``,
      `- Subscribers: ${channel.subscriber_count ?? "?"}, total views: ${channel.view_count ?? "?"}, videos in DB: ${channel.video_count ?? "?"}`,
      `- When the user says "my channel" they mean THIS one — never another channel from the list below.`
    );
    if (allChannels.length > 1) {
      const others = allChannels
        .filter((c) => c.id !== channel.id)
        .map((c) => `"${c.title ?? c.id}"${c.handle ? ` (${c.handle})` : ""}`)
        .join(", ");
      lines.push(
        `- The user has **${allChannels.length} channels connected** in this app. Other connected channels (NOT active right now): ${others}.`,
        `- **CRITICAL multi-channel rule:** every local-DB tool (list_videos, search_transcripts, search_comments, video_stats, raw_sql, etc.) returns data from the ACTIVE channel only. The other channels' videos/transcripts/comments are NOT visible to these tools until the user switches the active channel. If the user asks "ideas based on our channel" or "what's worked for us", that always means the ACTIVE channel — never an aggregate across all of them, and never a different one.`,
        `- If the user names a specific channel by handle/title that matches one of their OTHER connected channels, tell them to switch to it in the sidebar first. Do not silently answer with the active channel's data and pretend it's the other one.`
      );
    }
    lines.push(
      `- When the user asks about a channel that is NOT in the connected list (a competitor, a reference channel they admire), use external tools (Exa / Apify / youtube search) — do NOT confuse it with the active channel's local data.`
    );
  } else if (bound) {
    lines.push(`- A channel is bound (${bound}) but not yet synced — suggest running a sync.`);
  } else {
    lines.push(`- No channel is bound yet. Suggest connecting a YouTube channel in Integrations before deep analysis.`);
  }

  lines.push(``, `## Available tools — by name, by purpose`);
  if (activeGroups.length === 0) {
    lines.push(
      `- None active in this conversation. Reason from prior knowledge only; if the user asks for live data, tell them to enable a tool group via the "+" menu.`
    );
  } else {
    lines.push(
      `Always call a tool when one can answer the question — never speculate when data is available. Cite the tool that produced each fact ("from list_outliers: …").`,
      ``
    );

    if (activeGroups.includes("youtube")) {
      lines.push(
        `### Channel data (active-channel-scoped local DB)`,
        `- channel_summary — channel + headline stats`,
        `- list_my_videos — your videos, sortable, searchable`,
        `- search_my_transcripts — keyword search across your video transcripts`,
        `- get_video_comments / list_video_comments_cached / search_my_comments / get_comment_thread — comment data`,
        ``
      );
    }

    if (activeGroups.includes("analytics")) {
      lines.push(
        `### Analytics & SQL (deeper local work)`,
        `- execute_sql — read-only SQL over local DB tables (videos, transcripts, comments, etc.)`,
        `- youtube_trending — top-trending videos in a niche/region`,
        `- niche_explorer — top channels + outlier videos in a niche`,
        `- fetch_transcript — transcript for any public YouTube video`,
        ``
      );
    }

    if (activeGroups.includes("research")) {
      lines.push(
        `### Research`,
        `- youtube_suggest — YouTube autocomplete (real search-demand signal)`,
        ``
      );
    }

    if (activeGroups.includes("exa")) {
      lines.push(
        `### External web`,
        `- web_search / web_fetch — semantic web search + page contents via Exa. Use for competitor research, articles, external context.`,
        ``
      );
    }

    if (activeGroups.includes("apify")) {
      lines.push(
        `### Apify (paid scrapers)`,
        `- scrape_youtube_channel — full sync of a competitor channel via Apify (paid). Use when you need competitor data that isn't in the user's DB.`,
        `- get_youtube_transcript — Apify-backed transcript fallback when fetch_transcript can't find one.`,
        ``
      );
    }

    if (activeGroups.includes("yt_analytics")) {
      lines.push(
        `### YouTube Analytics (live, OAuth-gated)`,
        `- get_channel_analytics_overview / get_channel_audience / get_channel_revenue — channel-wide period data`,
        `- get_video_analytics — per-video retention, traffic sources, demographics, geography`,
        `This is the ground truth for "how is my channel actually doing" — use it before relying on stale local DB stats.`,
        ``
      );
    }

    if (activeGroups.includes("strategy")) {
      lines.push(
        `### Competitive intelligence (per §1 B&S Method)`,
        `- list_competitors — your tracked competitors, each tagged Authority / Breakthrough / Adjacent / Far`,
        `- competitor_gap_analysis — keywords frequent in competitor top videos that you've NEVER used`,
        ``,
        `### Outliers + ideation (the §2 + §9 engine)`,
        `- list_outliers — competitor videos beating their own median. Default mode (60d window, ≥2×, sorted by multiplier) for "what's working broadly". Pass recent_only=true for the discovery log (≥1.5× floor, sorted by detection time DESC) when the user asks "what's new" or "any viral hits since I last looked"; combine with unreadOnly=true to filter to unacknowledged.`,
        `- explain_outlier — 2-3 §9 levers + reasoning for a specific outlier (cached permanently)`,
        `- generate_ideas — 5–10 ideas grounded in §1/§7/§9, traceable to source outliers (rate-limited 1/5min per channel)`,
        `- list_format_patterns — title-format templates extracted from outliers (§4 structural patterns)`,
        ``,
        `### Audience (your own videos)`,
        `- get_comment_analysis — sentiment, themes, objections, future-video ideas, standout quote candidates per video`
      );
    }
  }

  lines.push(
    ``,
    `## Operating rules`,
    `1. Always call a tool when one can answer. No data speculation.`,
    `2. Cite the tool that produced each fact ("from list_outliers: …", "from list_format_patterns: …").`,
    `3. Active channel scope is sacred — never silently aggregate across the user's channels.`,
    `4. For ideation questions: list_outliers → optionally list_format_patterns → generate_ideas. Don't skip to generate_ideas without the source.`,
    `5. For "why did X work" questions: list_outliers (or accept the videoId from context) → explain_outlier.`,
    `6. Avoid retrying the same tool+input combination — the dispatcher rejects duplicates.`
  );

  // Tell the executor about the advisor ONLY when it's actually wired up for
  // this request — otherwise we'd be encouraging calls to a non-existent tool.
  if (opts.advisorEnabled) {
    lines.push(
      ``,
      `## The \`advisor\` tool (your strategic escalation path)`,
      `You have access to an \`advisor\` tool that routes a question to a stronger reasoning model (Claude Opus) and returns a short strategic opinion — a plan, a correction, or a stop signal.`,
      `- **Budget: 3 calls** per turn, use them well.`,
      `- **DO call advisor** when you face: synthesis of contradictory evidence, multi-factor strategic tradeoffs, final recommendations where stakes are high, or when you suspect your current plan is wrong.`,
      `- **DO NOT call advisor** for simple lookups, data gathering, or formatting questions — you handle those yourself.`,
      `- When you call advisor, phrase the question tightly. Example: "Given channel X has declining Shorts performance but growing long-form retention, and competitor Y switched to long-form 6 months ago with 3× subscriber growth — should this creator pivot fully away from Shorts, or split 30/70?"`,
      `- Treat the advisor's answer as input to your reasoning, not as the final output. You still own the final answer to the user.`
    );
  }

  lines.push(
    ``,
    `## Workflow for non-trivial questions`,
    `1. **Plan in 1 line**: what 3-5 tool calls give evidence for this question?`,
    `2. **Gather parallel when possible** — issue independent tool calls in one turn, not serial. Sonnet can emit multiple tool_use blocks per response.`,
    `3. **Start local, then external** — channel_summary / execute_sql before niche_explorer / exa / apify. Free data before paid.`,
    `4. **Synthesise before you write** — look at all your results, find the pattern, THEN open your answer.`,
    `5. **Structure the answer**: TL;DR (3 bullets max) → evidence sections with tables → concrete action list → the ONE thing to do this week.`,
    ``,
    `## Cost & failure discipline`,
    `- You have a research budget of 12 rounds of tool calls. Don't waste rounds.`,
    `- **If a tool fails, do not retry it more than once.** After a second failure the system will refuse the call and tell you to move on — respect that signal, note the limitation in your final answer, and continue from other sources.`,
    `- **Never repeat an identical tool+input combination** in the same turn — the system tracks and rejects duplicates.`,
    `- If data you need is missing, say exactly what's missing and why, then reason from what IS available. Do not invent numbers.`,
    ``,
    `## Style`,
    `- Markdown tables for data. Bullets for insights. Headings for structure.`,
    `- Match the user's language (UA / EN) in responses.`,
    `- End every analytical task with a short "Next step this week:" section naming ONE concrete action.`
  );

  return lines.join("\n");
}
