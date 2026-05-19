import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import {
  banOutlierFormat,
  findOutlierFormatsByTemplateMatch,
  getActiveChannelId,
  getChannel,
  getIntegration,
  getOutlierFormatById,
  getSetting,
  listAllChannels,
  listChannelMemory,
  listCompetitorAlerts,
  listMyWinners,
  listVideos,
  resolveChannelDescription,
  searchComments,
  searchTranscripts,
  unbanOutlierFormat,
  videoStats,
} from "./db";
import { exaSearch } from "./exa";
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
import { log } from "./logger";

/**
 * A tool group the user can enable/disable via the "+" menu in chat.
 *
 * The agent's surface was pruned from 6 groups / ~25 tools down to 3
 * groups / ~18 tools. Cuts (execute_sql, web_*, scrape_*, niche_explorer,
 * youtube_trending, youtube_suggest, fetch_transcript, get_video_comments,
 * list_video_comments_cached, get_comment_thread, search_youtube,
 * get_comment_analysis, list_competitors, competitor_gap_analysis) are
 * gone from the agent registry but their underlying lib functions remain
 * exported — backend routes + scheduled jobs still call them.
 */
export type ToolGroup = "ideation" | "my_channel" | "studio_analytics";

/**
 * Chat mode — drives WHICH tools are exposed + the system-prompt block.
 * The 3-button picker in /chat/page.tsx maps directly to these values.
 *
 *   ideate    — default. Lean tool set, fast turn (~$0.10).
 *   research  — wider tool set, deeper system prompt, more thinking budget (~$0.25).
 *   validate  — go/no-go check for a specific topic. No compose call (~$0.05).
 */
export type ChatMode = "ideate" | "research" | "validate";

/** Tool names exposed per mode. Anything not in the list is filtered out
 *  before the agent's tool registration step — the model can't even see
 *  the tool, so it can't try to call it. */
const MODE_TOOL_WHITELIST: Record<ChatMode, ReadonlySet<string>> = {
  ideate: new Set([
    "list_outliers",
    "list_my_videos",
    "list_my_winners",
    "generate_ideas",
  ]),
  research: new Set([
    "list_outliers",
    "list_my_videos",
    "list_my_winners",
    "list_format_patterns",
    "validate_idea",
    "explain_outlier",
    "web_search",
    "generate_ideas",
  ]),
  validate: new Set([
    "validate_idea",
    "list_my_videos",
    "list_outliers",
    "web_search",
  ]),
};

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

// "My Channel" group — local-DB read-only tools scoped to the active
// channel. No live YouTube API quota, no Apify, no Deepgram, no Exa.
// Just the four indispensable channel-introspection helpers the agent
// reaches for when the user asks about their own content.
const MY_CHANNEL_TOOLS: Tool[] = [
  {
    name: "channel_summary",
    description:
      "Stats for the active channel: title, subscribers, total views, videos imported, averages.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_my_videos",
    description:
      "List the active channel's imported videos by recent publish date. Optional keyword filter.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string" },
        limit: { type: "number", default: 50, maximum: 200 },
      },
    },
  },
  {
    name: "list_my_winners",
    description:
      "Top own-channel videos ranked by multiplier (views / own-channel median) DESC within a lookback window. Use to answer \"what has actually worked on this channel\" — every recommendation should be grounded in real own-history evidence. Returns: { winners: [{ videoId, title, thumbnailUrl, views, channelMedian, multiplier, performanceBand, publishedAt, likes, comments }] }. Multiplier is computed against the channel's all-time median, so a 5× row is genuinely a top performer for THIS channel, not a relative-window artefact.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 20, maximum: 100 },
        lookbackDays: { type: "number", default: 365, minimum: 7, maximum: 3650 },
        minMultiplier: {
          type: "number",
          default: 1.5,
          description: "Floor for inclusion. ≥1.5 by default (the alert generation floor); pass higher (3, 5) when the user wants only big wins.",
        },
      },
    },
  },
  {
    name: "search_my_transcripts",
    description:
      "Full-text search across the active channel's transcripts. Use when asked what was said about X.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "search_my_comments",
    description:
      "Full-text FTS5 search across cached comments on the active channel's videos. Use for audience-sentiment questions. No API quota.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 20, maximum: 100 },
      },
      required: ["query"],
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

const STUDIO_ANALYTICS_TOOLS: Tool[] = [
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
// Ideation tools — the §1/§2/§4 engine. Outlier discovery → format extraction
// → idea composition. Plus the durable-state tools (channel context, memory,
// format bans) the agent uses to capture HAmo's preferences across sessions.
// ---------------------------------------------------------------------------
const IDEATION_TOOLS: Tool[] = [
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
    description: [
      "Produce 3-5 viral YouTube title candidates. Server loads the full channel context (description + ideation_rules + banned_topics + competitor outliers + own-channel winners + extracted trending formats + last 20 own uploads) and hands all of it to Opus 4.7 with creative freedom. Up to 5 internal compose passes per turn — each retry re-prompts with the prior rejected titles + reasons so the model can adjust. JS post-filters: 50-80 char length, banned-word regex, banned-topic substring, exact-copy guard against source titles, topic-frequency check against the channel's last 20 uploads. No Haiku validator, no anchor gate, no catalog-tag machinery.",
      "",
      "Returns `{ titles: string[], ideas: ProposedIdea[], pipeline_failure? }`. The titles array is the ONLY thing the chat agent should render.",
      "Each ProposedIdea: `{ proposedTitle, sourceTopicVideoId?, sourceFormatId?, coherenceRationale? }`. The optional source/rationale fields are populated by the model when it cites attribution and are surfaced ONLY on a follow-up `explain idea N` request — never in the initial render.",
      "",
      "## Ideation output format (MANDATORY)",
      "Render ONLY a numbered list of `proposedTitle` strings. Nothing else. No preamble, no section headers, no source links, no thumbnails, no Topic/Format lines, no Why-this-for-{channel} rationale, no Catalog tag, no Next-step sentence, no closing prose.",
      "",
      "Exact shape (3-5 titles):",
      "1. {proposedTitle}",
      "2. {proposedTitle}",
      "3. {proposedTitle}",
      "4. {proposedTitle}",
      "5. {proposedTitle}",
      "",
      "Hard rules:",
      "- NO emojis in titles or surrounding text.",
      "- NO source URLs in the list.",
      "- NO commentary above or below the list.",
      "- NO trailing 'Next step this week' line.",
      "",
      "### Follow-up `explain idea N`",
      "When (and ONLY when) the user explicitly asks 'explain idea N', 'tell me more about #N', 'why this title', or similar, surface the stored attribution for that idea — `sourceTopicVideoId`, `sourceFormatId`, `coherenceRationale` — drawing from the most recent generate_ideas response in conversation memory. Render as prose, NOT as a re-rendered card. Two-three sentences max.",
      "",
      "### Empty-pipeline reporting (when ideas:[])",
      "When the tool returns `titles: []` with a `pipeline_failure` block, surface the failure verbatim ('Pipeline couldn\\'t produce titles. Sync more competitors or widen the window.') — the server already ran 5 internal retries. Do NOT improvise. Op rule 17.",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        outlierVideoIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional curated set of outlier video ids to ideate FROM. When provided, bypasses the auto-filter — treats the user's choice as authoritative.",
        },
        windowDays: {
          type: "number",
          description:
            "Override the 28-day outlier window. Only set when the user has explicitly asked to widen or narrow.",
        },
        minMultiplier: {
          type: "number",
          description:
            "Override the ≥1.5× outlier threshold. Only set when the user has explicitly asked to lower or raise.",
        },
        mode: {
          type: "string",
          enum: ["mixed", "free-form"],
          description:
            "Legacy knob kept for backward compatibility. The new Topic × Format mix pipeline always pairs every idea with a format source. This field is accepted but ignored by the server.",
        },
      },
    },
  },
  {
    name: "list_format_patterns",
    description:
      "List the active channel's extracted title-format patterns (per MENTOR_METHOD §4). Each pattern is a structural template like \"[Place]'s most [Adjective] [Thing]\" plus its avg multiplier, total monthly views, and rising rate. Sorted by rising rate DESC. Defaults to patterns with ≥3 example videos (the 'proven' threshold) — formats with fewer examples are filtered out. Pass minExamples=1 to surface emerging patterns; when you do, label them 'emerging, not proven' in your reply. Pre-requisite: the user has run 'Re-extract trending formats' on the /outliers Trending Formats tab — without that this returns an empty array. Returns: { formats: [{ template, avgMultiplier, totalViewsMonth, risingRate, exampleVideoIds: string[] }] }.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 20 },
        minExamples: {
          type: "number",
          description:
            "Minimum example-video count per pattern. Default 3 ('proven'). Pass 1 to include emerging patterns.",
          default: 3,
        },
      },
    },
  },
  {
    name: "validate_idea",
    description:
      "Search the active channel's own catalog for similar or adjacent topics before recommending an idea. Primary window = last 60 days (videos that would directly compete with a new upload), secondary = 60-90 days (covered-old territory). Returns a verdict ('fresh' | 'covered_recently' | 'covered_old' | 'covered_underperformed'), a plain-English `verdictCopy` line you should echo or paraphrase tightly, and matching videos with their performanceBand ('hit hard' / 'above average' / 'average' / 'underperformed'). Call this BEFORE recommending any topic the user hasn't already explicitly tied to a competitor outlier — operating rule 7-equivalent: validate first, recommend second. The active channel is resolved server-side. Returns: { topic, verdict, verdictCopy, primaryMatches: [{ videoId, title, publishedAt, views, multiplier, performanceBand, matchedKeywords }], adjacentMatches: [...] }.",
    input_schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "The proposed topic to validate — short phrase, e.g. 'James Webb biosignatures' or 'Voyager 2 anomalies'.",
        },
        windowDays: {
          type: "number",
          description:
            "Primary window in days. Default 60. Secondary window (covered_old) extends to 90.",
          default: 60,
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "update_channel_context",
    description:
      "Update the active channel's strategic context fields — niche, positioning, audience, voice, external_sources, ideation_rules — when the user describes the channel naturally in conversation OR dictates an ideation rule (e.g. 'never propose deep-space topics', 'titles must mention a specific person'). TWO-STEP CONFIRM IS MANDATORY. First call ALWAYS with confirm:false (or omitted) — the tool returns a diff of before/after values per field. Show that diff to the user in plain prose and ask them to reply 'yes' (apply), 'edit <field>' (revise), or 'no' (cancel). Only after they explicitly approve in chat do you call AGAIN with confirm:true and the SAME `changes` payload. NEVER call with confirm:true in the same turn as the user's initial description — the user must see and approve the diff first. The active channel is resolved server-side; you do not pass a channel id. Empty-string field values mean CLEAR that field — get explicit per-field approval before clearing anything. Each field caps at 2000 chars after trim. Returns (confirm:false): { pending:true, diff:[{field, before, after}], agentInstruction }. Returns (confirm:true): { applied:true, changedFields:string[], message }.",
    input_schema: {
      type: "object",
      properties: {
        changes: {
          type: "object",
          description:
            "Map of context fields to new values. Include only the fields you intend to change. At least one field is required.",
          properties: {
            niche: { type: "string" },
            positioning: { type: "string" },
            audience: { type: "string" },
            voice: { type: "string" },
            external_sources: { type: "string" },
            ideation_rules: {
              type: "string",
              description:
                "Per-channel HARD-enforcement rules the ideation agent injects verbatim into its compose prompt. Free-form prose. Use for non-negotiable constraints HAmo dictates (e.g. 'every title must include a number', 'never use Voyager as a topic', 'tone must mirror Late Science's voice').",
            },
          },
        },
        confirm: {
          type: "boolean",
          description:
            "Always false on the first call (returns a diff). Set true only after the user has explicitly approved the diff in chat — and then with the SAME `changes` payload.",
          default: false,
        },
      },
      required: ["changes"],
    },
  },
  {
    name: "ban_format",
    description:
      "Soft-ban a trending title format for the active channel. After banning, the format stops appearing in the Patterns tab, the list_format_patterns chat tool, and the idea-generator's format pool. TWO-STEP CONFIRM IS MANDATORY (mirror update_channel_context). First call ALWAYS with confirm:false — the tool resolves which format to ban (by format_id OR by template_match substring), returns its template + key stats, and asks for approval. Second call with confirm:true and the SAME identifier applies the ban. NEVER call with confirm:true in the same turn as the user's initial mention. Disambiguation: if template_match matches more than one row the tool returns { requires_disambiguation:true, candidates:[{format_id, template, avg_multiplier, banned}] } — show the list to the user and ask them to pick by format_id, then retry with that exact format_id. Returns (confirm:false, single match): { pending:true, action:'ban'|'already_banned', format_id, template, agentInstruction }. Returns (confirm:true): { applied:true, format_id, template, message }. The format's stored examples are kept (the row is soft-deleted, not destroyed) so unban_format can restore it cleanly.",
    input_schema: {
      type: "object",
      properties: {
        format_id: {
          type: "number",
          description:
            "Exact format id (from list_format_patterns). Preferred over template_match — use this when you have it.",
        },
        template_match: {
          type: "string",
          description:
            "Substring (case-insensitive) of the template, used when the user describes the format in words and you don't have a format_id. Triggers disambiguation when >1 match.",
        },
        reason: {
          type: "string",
          description:
            "Optional rationale the user gave (e.g. 'too cliché', 'we never want this shape'). Logged for audit — does not affect behavior.",
        },
        confirm: {
          type: "boolean",
          description:
            "Always false on the first call. Set true only after explicit user approval — and then with the SAME identifier.",
          default: false,
        },
      },
    },
  },
  {
    name: "unban_format",
    description:
      "Clear a soft-ban on a trending title format so it surfaces again in the Patterns tab, list_format_patterns, and the ideation pool. TWO-STEP CONFIRM IS MANDATORY (mirror ban_format). First call with confirm:false — tool returns the banned format's template + ban timestamp. Second call with confirm:true and the SAME identifier applies the unban. Disambiguation flow mirrors ban_format: when template_match returns multiple banned candidates, surface the list and ask the user to pick by format_id. Returns (confirm:false): { pending:true, action:'unban'|'already_active', format_id, template, agentInstruction }. Returns (confirm:true): { applied:true, format_id, template, message }.",
    input_schema: {
      type: "object",
      properties: {
        format_id: { type: "number" },
        template_match: { type: "string" },
        reason: { type: "string" },
        confirm: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "web_search",
    description:
      "Search the web for current viral angles, recent news, or trending topics in the channel's niche. Use ONLY when (a) list_outliers and list_format_patterns don't surface enough viral signal in the last 14 days, OR (b) the user explicitly asks about a topic happening outside the tracked competitor set. Returns 5-10 results with title + URL + snippet. Do NOT use for general knowledge questions — those go through your training data. Cost: 1 Exa API call (~$0.005). Always cite source URLs in your reply.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search phrase. Include the channel niche + a recency anchor (\"trending this week\" / \"viral last 7 days\") when discovering viral topics.",
        },
        numResults: { type: "number", default: 8, minimum: 1, maximum: 10 },
      },
      required: ["query"],
    },
  },
];

/**
 * Tool selection is two-step:
 *   1. Group selector (legacy — chat-history sessions still pass tools:[]).
 *   2. Mode whitelist (T2 redesign — the agent's per-mode tool surface).
 *
 * For new chats, the mode whitelist is authoritative; groups can default
 * to every group (`["ideation","my_channel","studio_analytics"]`) and the
 * mode filter narrows down to the per-mode subset.
 *
 * For old chats without a mode, the absence of `mode` collapses to
 * `"ideate"` (the default) so the conversation keeps working.
 */
export function getToolsFor(groups: ToolGroup[], mode?: ChatMode): Tool[] {
  const set = new Set(groups);
  const all: Tool[] = [];
  if (set.has("ideation")) all.push(...IDEATION_TOOLS);
  if (set.has("my_channel")) all.push(...MY_CHANNEL_TOOLS);
  if (set.has("studio_analytics")) all.push(...STUDIO_ANALYTICS_TOOLS);
  if (!mode) return all;
  const whitelist = MODE_TOOL_WHITELIST[mode];
  return all.filter((t) => whitelist.has(t.name));
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
      case "list_my_winners": {
        const activeId = getActiveChannelId();
        if (!activeId) {
          return {
            ok: false,
            error:
              "No active channel — set one from the top-right channel picker before listing winners.",
          };
        }
        const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
        const lookbackDays = Math.min(
          3650,
          Math.max(7, Number(input.lookbackDays) || 365)
        );
        const minMultiplier =
          typeof input.minMultiplier === "number" &&
          Number.isFinite(input.minMultiplier)
            ? Math.max(0, input.minMultiplier)
            : 1.5;
        const winners = listMyWinners(activeId, {
          limit,
          lookbackDays,
          minMultiplier,
        });
        const { performanceBandFor } = await import("./validate-idea");
        return {
          ok: true,
          data: {
            winners: winners.map((w) => ({
              videoId: w.videoId,
              title: w.title,
              thumbnailUrl:
                w.thumbnailUrl ??
                `https://i.ytimg.com/vi/${w.videoId}/mqdefault.jpg`,
              youtubeUrl: `https://www.youtube.com/watch?v=${w.videoId}`,
              views: w.views,
              channelMedian: w.channelMedian,
              multiplier: w.multiplier,
              performanceBand: performanceBandFor(w.multiplier),
              publishedAt: w.publishedAt,
              likes: w.likes,
              comments: w.comments,
            })),
            channelMedianUsed: winners[0]?.channelMedian ?? null,
            lookbackDays,
            minMultiplier,
          },
        };
      }
      case "search_my_transcripts": {
        const q = String(input.query ?? "").trim();
        if (!q) return { ok: false, error: "query required" };
        return { ok: true, data: searchTranscripts(q, 20) };
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
            author: c.author,
            text: c.text,
            likes: c.like_count,
            replyCount: c.reply_count,
            publishedAt: c.published_at,
          })),
        };
      }

      // ===== Studio Analytics (YouTube Analytics OAuth) =====
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

      // ===== Ideation tools (the §1/§2/§4 engine) =====
      case "list_outliers": {
        const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
        const recentOnly = !!input.recent_only;
        if (recentOnly) {
          const unreadOnly = !!input.unreadOnly;
          // listCompetitorAlerts no longer takes a limit — the UI surface
          // (RecentTab) wants the full set. The chat tool caps client-side
          // to keep the LLM context bounded.
          const alerts = listCompetitorAlerts({
            unreadOnly,
            userChannelId: getActiveChannelId(),
          }).slice(0, limit);
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
        const windowDays =
          typeof input.windowDays === "number" && Number.isFinite(input.windowDays)
            ? input.windowDays
            : undefined;
        const minMultiplier =
          typeof input.minMultiplier === "number" &&
          Number.isFinite(input.minMultiplier)
            ? input.minMultiplier
            : undefined;
        // Legacy mode knob retained for backward compatibility; the
        // Topic × Format mix pipeline ignores it server-side.
        const mode: "mixed" | "free-form" =
          input.mode === "free-form" ? "free-form" : "mixed";
        const { generateIdeasForChannel } = await import("./idea-generator");
        const r = await generateIdeasForChannel({
          userChannelId: activeId,
          outlierVideoIds,
          windowDays,
          minMultiplier,
          mode,
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
          data: {
            // Primary render surface — the agent emits these as a
            // numbered list and nothing else. Stripped per the spec.
            titles: r.ideas.map((i) => i.proposedTitle),
            // Per-idea attribution kept available for the agent's
            // follow-up `explain idea N` handler. Not rendered on the
            // initial output.
            ideas: r.ideas,
            generatedAt: r.generatedAt,
            // Carries the per-gate attrition + a human-readable
            // fail_reason when the pipeline produced zero ideas. The
            // server already ran 5 internal retries before reporting.
            pipeline_failure: r.pipelineFailure,
          },
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
        // Default to ≥3 examples ("proven"). Agent can pass 1 to surface
        // emerging patterns, but the tool description tells it to label
        // those as 'emerging, not proven' in the user-facing reply.
        const minExamples = Math.max(
          1,
          typeof input.minExamples === "number" &&
            Number.isFinite(input.minExamples)
            ? Math.floor(input.minExamples)
            : 3
        );
        const { getFormatsForChannel } = await import("./outlier-formats");
        const formats = getFormatsForChannel(activeId, limit).filter(
          (f) => f.examples.length >= minExamples
        );
        return {
          ok: true,
          data: {
            // Each format now ships its examples WITH thumbnails + titles
            // so the agent's structured markdown can render them inline
            // without a follow-up tool call. `exampleVideoIds` retained as
            // a derived alias for back-compat (one release of grace).
            formats: formats.map((f) => ({
              id: f.id,
              template: f.template,
              avgMultiplier: f.avgMultiplier,
              totalViewsMonth: f.totalViewsMonth,
              risingRate: f.risingRate,
              // T3 follow-up: surfaced so the agent can label
              // single-channel formats "(author pattern)" in the
              // structured markdown — these are softer signals than
              // true cross-channel trends.
              isSingleChannel: f.isSingleChannel,
              examples: f.examples.map((e) => ({
                videoId: e.videoId,
                title: e.title,
                thumbnailUrl:
                  e.thumbnailUrl ??
                  `https://i.ytimg.com/vi/${e.videoId}/mqdefault.jpg`,
                multiplier:
                  Math.round((e.multiplierAtExtract || 0) * 10) / 10,
                competitorTitle: e.competitorTitle,
                youtubeUrl: `https://www.youtube.com/watch?v=${e.videoId}`,
              })),
              exampleVideoIds: f.examples.map((e) => e.videoId),
            })),
            minExamplesApplied: minExamples,
          },
        };
      }
      case "validate_idea": {
        const activeId = getActiveChannelId();
        if (!activeId) {
          return {
            ok: false,
            error:
              "No active channel — set one from the top-right channel picker before validating.",
          };
        }
        const topic =
          typeof input.topic === "string" ? input.topic.trim() : "";
        if (!topic) {
          return { ok: false, error: "topic required" };
        }
        const windowDays =
          typeof input.windowDays === "number" &&
          Number.isFinite(input.windowDays)
            ? Math.max(1, Math.floor(input.windowDays))
            : 60;
        const { validateIdeaAgainstOwnCatalog } = await import(
          "./validate-idea"
        );
        const result = validateIdeaAgainstOwnCatalog({
          topic,
          userChannelId: activeId,
          primaryWindowDays: windowDays,
          // Secondary window grows proportionally — 1.5× the primary —
          // so "covered_old" still catches stuff just outside the
          // primary window when the agent widens.
          secondaryWindowDays: Math.max(windowDays + 30, 90),
        });
        return { ok: true, data: result };
      }
      case "update_channel_context": {
        const activeId = getActiveChannelId();
        if (!activeId) {
          return {
            ok: false,
            error:
              "No active channel — set one from the top-right channel picker before updating context.",
          };
        }
        const activeChannel = getChannel(activeId);
        if (!activeChannel) {
          return {
            ok: false,
            error: `Active channel ${activeId} not found in DB.`,
          };
        }

        const rawChanges = input.changes;
        if (!rawChanges || typeof rawChanges !== "object") {
          return {
            ok: false,
            error:
              "changes must be an object with at least one of: niche, positioning, audience, voice, external_sources, ideation_rules.",
          };
        }
        const changesObj = rawChanges as Record<string, unknown>;
        const allowedFields = [
          "niche",
          "positioning",
          "audience",
          "voice",
          "external_sources",
          "ideation_rules",
        ] as const;
        type CtxField = (typeof allowedFields)[number];
        const cleaned: Partial<Record<CtxField, string>> = {};
        for (const field of allowedFields) {
          if (!(field in changesObj)) continue;
          const v = changesObj[field];
          if (typeof v !== "string") {
            return {
              ok: false,
              error: `${field}: must be a string (got ${typeof v}).`,
            };
          }
          const trimmed = v.trim();
          if (trimmed.length > 2000) {
            return {
              ok: false,
              error: `${field}: exceeds 2000 char limit (got ${trimmed.length}).`,
            };
          }
          cleaned[field] = trimmed;
        }
        if (Object.keys(cleaned).length === 0) {
          return {
            ok: false,
            error:
              "changes must include at least one of: niche, positioning, audience, voice, external_sources, ideation_rules.",
          };
        }

        const confirm = input.confirm === true;

        // Diff every changed field against the channel's current value.
        // Empty-string after-values are kept — they represent a CLEAR
        // operation and must be visible in the diff so the user can
        // approve or veto the wipe explicitly.
        const diff = Object.entries(cleaned).map(([field, after]) => ({
          field,
          before: (activeChannel[field as CtxField] ?? "") as string,
          after: after as string,
        }));

        if (!confirm) {
          const { log: logger } = await import("./logger");
          logger.debug("chat", "update_channel_context diff requested", {
            activeChannelId: activeId,
            fields: Object.keys(cleaned),
          });
          return {
            ok: true,
            data: {
              pending: true,
              channelTitle: activeChannel.title ?? activeChannel.id,
              diff,
              agentInstruction:
                "Present this diff to the user verbatim (one line per field, showing before → after). Ask them to reply 'yes' to apply, 'edit <field>' to revise a specific field, or 'no' to cancel. After they explicitly approve (yes / apply / go ahead / equivalent), call update_channel_context AGAIN with the SAME `changes` payload plus confirm:true. Do NOT call with confirm:true until the user has approved in this turn.",
            },
          };
        }

        // Confirm path: apply atomically.
        const { updateChannelContextBatch } = await import("./db");
        const { log: logger } = await import("./logger");
        const updated = updateChannelContextBatch(activeId, cleaned);
        logger.info("chat", "update_channel_context applied", {
          activeChannelId: activeId,
          channelTitle: activeChannel.title,
          fields: Object.keys(cleaned),
        });
        return {
          ok: true,
          data: {
            applied: true,
            channelTitle: updated?.title ?? activeChannel.title ?? activeId,
            changedFields: Object.keys(cleaned),
            message:
              "Confirm to the user that the update is applied, then offer the next concrete step (e.g. 'I can now run list_outliers grounded in this voice — say the word').",
          },
        };
      }
      case "ban_format":
      case "unban_format": {
        const activeId = getActiveChannelId();
        if (!activeId) {
          return {
            ok: false,
            error:
              "No active channel — set one from the top-right channel picker before banning a format.",
          };
        }
        const isBan = name === "ban_format";
        const confirm = input.confirm === true;
        const formatIdRaw = input.format_id;
        const templateMatchRaw = input.template_match;
        const reason =
          typeof input.reason === "string" && input.reason.trim().length > 0
            ? input.reason.trim().slice(0, 500)
            : null;

        // Resolve which format the user means. format_id wins; otherwise
        // we fuzzy-match by substring and either proceed (unique hit) or
        // ask the agent to disambiguate (>1 hit) or 404 (no hits).
        let resolvedId: number | null = null;
        if (typeof formatIdRaw === "number" && Number.isFinite(formatIdRaw)) {
          resolvedId = Math.floor(formatIdRaw);
        } else if (
          typeof templateMatchRaw === "string" &&
          templateMatchRaw.trim().length > 0
        ) {
          const matches = findOutlierFormatsByTemplateMatch(
            activeId,
            templateMatchRaw.trim(),
            5
          );
          // Filter to the right banned state for the operation: ban looks
          // at active rows, unban looks at banned rows. If the user
          // describes a format that's already in the target state, we
          // still surface it (with action='already_*') so the agent can
          // tell them it's a no-op.
          const candidates = matches.filter((f) =>
            isBan ? f.bannedAt === null : f.bannedAt !== null
          );
          if (candidates.length === 0 && matches.length > 0) {
            // The user described a format that's in the wrong state for
            // this op (e.g. asked to ban one that's already banned).
            // Surface those rows so the agent can explain.
            return {
              ok: true,
              data: {
                pending: true,
                requires_disambiguation: false,
                action: isBan ? "already_banned" : "already_active",
                candidates: matches.map((f) => ({
                  format_id: f.id,
                  template: f.template,
                  avg_multiplier: f.avgMultiplier,
                  banned: f.bannedAt !== null,
                })),
                agentInstruction: isBan
                  ? "These formats are ALREADY BANNED for this channel. Tell the user — no further action needed. If they want a different format banned, ask for a more specific template_match or a format_id."
                  : "These formats are ALREADY ACTIVE (not banned) for this channel. Tell the user — no further action needed. If they want a different format unbanned, ask for a more specific template_match.",
              },
            };
          }
          if (candidates.length === 0) {
            return {
              ok: false,
              error: `No format matches "${templateMatchRaw.trim()}". Try a different substring or pass format_id from list_format_patterns.`,
            };
          }
          if (candidates.length > 1) {
            return {
              ok: true,
              data: {
                pending: true,
                requires_disambiguation: true,
                action: isBan ? "ban" : "unban",
                candidates: candidates.map((f) => ({
                  format_id: f.id,
                  template: f.template,
                  avg_multiplier: f.avgMultiplier,
                  banned: f.bannedAt !== null,
                })),
                agentInstruction: `Multiple formats matched "${templateMatchRaw.trim()}". Show the user the candidates by template (and avg_multiplier so they can tell similar shapes apart) and ask them to pick one by format_id. Then retry ${name} with confirm:false and that exact format_id.`,
              },
            };
          }
          resolvedId = candidates[0].id;
        }
        if (resolvedId === null) {
          return {
            ok: false,
            error: `${name}: pass either format_id (preferred) or template_match (substring of the template).`,
          };
        }

        const fmt = getOutlierFormatById(resolvedId);
        if (!fmt) {
          return { ok: false, error: `format ${resolvedId} not found` };
        }
        if (fmt.userChannelId !== activeId) {
          return {
            ok: false,
            error: `format ${resolvedId} does not belong to the active channel.`,
          };
        }
        const alreadyTargetState = isBan
          ? fmt.bannedAt !== null
          : fmt.bannedAt === null;

        if (!confirm) {
          const { log: logger } = await import("./logger");
          logger.debug("chat", `${name} diff requested`, {
            activeChannelId: activeId,
            formatId: resolvedId,
            alreadyTargetState,
          });
          return {
            ok: true,
            data: {
              pending: true,
              action: isBan
                ? alreadyTargetState
                  ? "already_banned"
                  : "ban"
                : alreadyTargetState
                  ? "already_active"
                  : "unban",
              format_id: resolvedId,
              template: fmt.template,
              avg_multiplier: fmt.avgMultiplier,
              banned: fmt.bannedAt !== null,
              banned_at: fmt.bannedAt,
              reason,
              agentInstruction: alreadyTargetState
                ? isBan
                  ? "This format is already banned — tell the user it's a no-op, no second call needed."
                  : "This format is already active (not banned) — tell the user it's a no-op."
                : isBan
                  ? `Show the user the format you're about to BAN (template + avg multiplier). Ask 'yes' to apply, 'no' to cancel. After explicit approval, call ban_format AGAIN with the SAME format_id plus confirm:true. Do NOT call with confirm:true until the user has approved.`
                  : `Show the user the format you're about to UNBAN (template + when it was banned). Ask 'yes' to apply, 'no' to cancel. After explicit approval, call unban_format AGAIN with the SAME format_id plus confirm:true.`,
            },
          };
        }

        // Confirm path.
        const { log: logger } = await import("./logger");
        if (alreadyTargetState) {
          return {
            ok: true,
            data: {
              applied: false,
              action: isBan ? "already_banned" : "already_active",
              format_id: resolvedId,
              template: fmt.template,
              message: isBan
                ? "No change — this format was already banned."
                : "No change — this format was already active.",
            },
          };
        }
        const flipped = isBan
          ? banOutlierFormat(resolvedId)
          : unbanOutlierFormat(resolvedId);
        logger.info("chat", `${name} applied`, {
          activeChannelId: activeId,
          formatId: resolvedId,
          flipped,
          reason,
        });
        return {
          ok: true,
          data: {
            applied: flipped,
            action: isBan ? "ban" : "unban",
            format_id: resolvedId,
            template: fmt.template,
            message: isBan
              ? "Confirm to the user that the format is banned. It will no longer appear in Patterns, list_format_patterns, or ideation."
              : "Confirm to the user that the format is restored. It will now surface in Patterns, list_format_patterns, and ideation again.",
          },
        };
      }
      case "web_search": {
        const key = requireKey("exa");
        const query = String(input.query ?? "").trim();
        if (!query) return { ok: false, error: "query required" };
        const numResults = Math.min(
          10,
          Math.max(1, Number(input.numResults) || 8)
        );
        return {
          ok: true,
          data: await exaSearch(query, key, {
            numResults,
            includeText: true,
          }),
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

// One-shot diagnostic — logged the first time buildSystemPrompt runs per
// process boot. Surfaces the system-prompt size to dev-server logs so
// HAmo can see we held the post-T4 budget (<8000 chars).
let promptSizeDiagLogged = false;

export function buildSystemPrompt(
  activeGroups: ToolGroup[],
  opts: { advisorEnabled?: boolean; mode?: ChatMode } = {}
): string {
  const mode: ChatMode = opts.mode ?? "ideate";
  const channel = getChannel();
  const bound = getSetting("youtube.channelId");
  const allChannels = listAllChannels();

  // The MENTOR_METHOD module is loaded for the ban-checker substring
  // helper and for the format-extraction prompt; the chat agent itself
  // doesn't need verbatim quotes any more. Each section's ESSENCE is
  // baked into the operating rules + tool descriptions below — re-quoting
  // 8000 chars per turn paid no signal for the cost.
  void loadMentorMethod;
  void extractSection;

  const lines: string[] = [
    "You are HAmo's YouTube ideation agent. Turn channel context + competitor outliers + extracted formats into ideas grounded in MENTOR_METHOD.md. Evidence-cited from tool calls, never speculation.",
    "",
    "## Quality bar",
    "- No banal coach advice (\"post consistently\", \"optimize titles\", \"engage your audience\"). Replace with a data-backed claim or admit you don't have one.",
    "- Every number comes from a tool call. Don't invent numbers.",
    "- Every recommendation names a specific action grounded in the active channel's data.",
    "- No preamble. Go straight to the work. Default to terse.",
    "",
    "## Methodology essence (full text in MENTOR_METHOD.md; quotes available on request)",
    "- §1 Competitor mapping (B&S Method): tier each tracked channel — Authority / Breakthrough / Adjacent / Far. Authority + Breakthrough sources carry more weight.",
    "- §2 Outliers: a competitor video ≥2× its own channel's median is the canon definition. ≥1.5× is the alert generation floor.",
    "- §4 Title formats: structural templates with [Slot] placeholders, not literal titles. A format needs ≥3 examples across ≥2 channels to be 'trending'.",
    "- §7 Ideation: format × topic. Outliers are the topic source, formats are optional remix skeletons.",
    "- §9 Levers: curiosity-gap, status-signal, fear, identity, novelty, scale, taboo, urgency. Each idea cites one dominant lever as `angle`.",
    "",
    "## Active channel",
  ];

  if (channel) {
    lines.push(
      `- "${channel.title ?? "(unknown)"}"${channel.handle ? ` — ${channel.handle}` : ""}, id \`${channel.id}\` · ${channel.subscriber_count ?? "?"} subs, ${channel.video_count ?? "?"} videos.`,
      ""
    );

    // Channel description — single source of truth, UNCAPPED. The full
    // resolved description (legacy-fallback handled by
    // resolveChannelDescription) is injected verbatim so the agent's
    // "Why this for {channel}" rationale has every detail HAmo wrote.
    const description = resolveChannelDescription(channel);
    lines.push("## About this channel");
    if (description.length > 0) {
      lines.push(description);
    } else {
      lines.push("(not set — ask HAmo to fill /channel-info or the Brain panel in /chat)");
    }

    // Ideation rules — HARD enforcement, UNCAPPED. Per-channel rules
    // override every compose heuristic; truncating them silently was a
    // bug — the agent needs the full text to reason about edge cases.
    const rules = (channel.ideation_rules ?? "").trim();
    lines.push(
      "",
      "## Ideation rules (HARD — override every compose heuristic)",
      rules.length > 0 ? rules : "(none set)"
    );

    // Banned topics — kept as its own H2 so the constraint is impossible
    // to miss. Reads the legacy channel_memory.banned_topics row
    // (writer removed when the generic memory tools were cut; existing
    // rows still gate the source pool inside generate_ideas + steer
    // conversational drift). Ideation Rules covers the new write path.
    const memory = listChannelMemory(channel.id);
    const bannedRow = memory.find((m) => m.key === "banned_topics");
    if (bannedRow && bannedRow.value.trim().length > 0) {
      const terms = bannedRow.value
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      lines.push(
        "",
        "## Banned topics for this channel (case-insensitive substring, NEVER propose)",
        terms.map((t) => `- ${t}`).join("\n")
      );
    }

    if (allChannels.length > 1) {
      const others = allChannels
        .filter((c) => c.id !== channel.id)
        .map((c) => `"${c.title ?? c.id}"`)
        .slice(0, 6)
        .join(", ");
      lines.push(
        "",
        `## Multi-channel scope (CRITICAL)`,
        `${allChannels.length} channels connected; OTHER channels in this workspace (NOT active): ${others}. Every local-DB tool is scoped to THIS channel ONLY. Never aggregate. If the user names another connected channel, tell them to switch via the top-right picker first.`
      );
    }
  } else if (bound) {
    lines.push(`- Channel ${bound} is bound but not synced — suggest running a sync.`);
  } else {
    lines.push("- No channel bound. Suggest connecting one via /integrations before deep analysis.");
  }

  lines.push("", "## Available tools (full schemas attached to this turn)");
  if (activeGroups.length === 0) {
    lines.push("- None active. If the user needs live data, tell them to enable a group via the '+' menu.");
  } else {
    if (activeGroups.includes("ideation")) {
      lines.push(
        "### Ideation (§1/§2/§4 engine — primary surface)",
        "list_outliers · list_format_patterns · explain_outlier · generate_ideas · validate_idea · web_search · update_channel_context · ban_format · unban_format"
      );
    }
    if (activeGroups.includes("my_channel")) {
      lines.push(
        "### My Channel (active-channel-scoped local DB, no quota)",
        "channel_summary · list_my_videos · search_my_transcripts · search_my_comments"
      );
    }
    if (activeGroups.includes("studio_analytics")) {
      lines.push(
        "### Studio Analytics (live, OAuth-gated)",
        "get_channel_analytics_overview · get_video_analytics · get_channel_audience · get_channel_revenue"
      );
    }
  }

  lines.push(
    "",
    "## Operating rules (1-15, ALL non-negotiable)",
    "1. Always call a tool when one can answer; cite it (\"from list_outliers: …\").",
    "2. Active channel scope is sacred — never aggregate across the user's channels.",
    "3. Ideation flow: list_outliers → optional list_format_patterns → generate_ideas. Don't skip to generate_ideas without the source.",
    "4. \"Why did X work\": list_outliers (or use the videoId from context) → explain_outlier.",
    "5. Don't repeat the same tool+input combination in one turn — the dispatcher rejects duplicates.",
    "6. Two-step confirm is MANDATORY for every mutating tool (update_channel_context, ban_format, unban_format). First call confirm:false returns a proposal; second call confirm:true applies. Show the proposal to the user verbatim, wait for explicit yes. For ban_format/unban_format on template_match: if requires_disambiguation, surface the candidate list and ask the user to pick by format_id BEFORE confirming.",
    "7. Performance bands — translate multipliers BEFORE writing the line. ≥5× = \"hit hard\"; 2× to <5× = \"above average\"; 0.8×-<2× = \"average\"; <0.8× = \"underperformed\". Raw multiplier may appear in parentheses, never naked. validation responses already include performanceBand — use VERBATIM.",
    "8. Per MENTOR_METHOD §3, evergreen = cross-channel + cross-time. validate_idea checks YOUR catalog only; the cross-channel §3 check is on you (use list_outliers + competitor data, never a single outlier).",
    `9. You advise on the ${channel?.title ? `"${channel.title}"` : "active"} channel ONLY. Ignore facts/memory from other channels. If asked about a different connected channel, tell the user to switch first.`,
    "10. NEVER silently relax ideation thresholds. When generate_ideas returns 409 (\"Only N outliers ≥X× in last W days…\"), STOP and ask the user: \"Widen the window (try 60d) or lower the multiplier (try 1×)? Pick one.\" Wait for their choice, then pass those exact params. Auto-loosening is the single most reliable way to ship bad ideas.",
    "11. Default to TERSE. Show data + visuals + verdict, not prose. Elaborate ONLY when asked (\"why this format\" / \"explain idea N\").",
    "12. Title language MUST be plain. Banned in proposedTitle: cinematic, sensory, visceral, profound, desolate expanse, humanity has ever charted, humanity has ever mapped, inexorable, vastest, the most absolute, physically impossible. Mirror competitor outlier register (\"huge\", \"hiding\", \"hard\", \"real\", \"big\", \"found\", \"moved\"). Server enforces this — slips get one regenerate attempt then drop.",
    "13. The mandatory ideation output format lives in the generate_ideas tool description. Follow it exactly when listing ideas.",
    "14. If the channel is small/inactive/wrong-niche, say it directly. Honesty over polish.",
    "15. When generating ideas and viral_topic candidates from list_outliers are sparse (fewer than 5 topics with ≥3× multiplier in last 14d), call web_search with the channel's niche + 'trending this week' to surface fresh angles. Compose ideas blending those web-sourced topics with the trending formats from list_format_patterns. ALWAYS cite source URLs in the reply when a web result drives a title.",
    "16. Logical coherence is non-negotiable. A title mixing a topic from video A with a format from video B must describe a plausible video. Format provides STRUCTURE, topic provides SUBJECT. The compose call is Opus 4.7 with thinking budget 6000 — it self-validates coherence by reasoning before emitting. If you somehow spot a fabrication in the output (e.g. a title implying Webb found a black hole when the topic source is biosignatures), surface it verbatim to the user and ask whether to drop it; do NOT paper over it.",
    "17. When generate_ideas returns titles:[] with a pipeline_failure block, the server has already run 5 internal compose retries — say so to the user verbatim ('Pipeline couldn\\'t produce titles. Sync more competitors or widen the window.') and STOP. Do NOT improvise titles from list_outliers / list_format_patterns. Improvising bypasses the originality + length + banned-words + topic-frequency guards and ships worse titles than the pipeline."
  );

  // Per-mode addendum — drives WHAT the turn produces (ideas vs deep-dives
  // vs verdict) and how much thinking the agent invests.
  if (mode === "research") {
    lines.push(
      "",
      "## RESEARCH MODE (active)",
      "The user wants you to think harder. Surface the WHY behind viral patterns, not just the WHAT. Use web_search if local data is thin (op rule 15). Compare findings against the user's catalog via list_my_winners + validate_idea + ownCatalogMatches on every idea.",
      "",
      "Output structure for Research:",
      "1. Outlier deep-dives (≥3): pick the strongest cross-channel outliers from list_outliers + explain_outlier and surface a short H3 each:",
      "   ### Why \"{outlier.title}\" hit ({outlier.multiplier}× — {views} vs median {channelMedian})",
      "   - Channel: {competitorTitle} ({competitorSubscriberCount.toLocaleString()} subs), uploaded {publishedAt absolute + relative}",
      "   - Levers (§9): {2-3 from explain_outlier}",
      "   - Why it worked: {1-2 sentences grounded in the levers}",
      "   - Your channel comparison: {findOwnCatalogTopicMatches result or \"Fresh territory\"}",
      "2. Then call generate_ideas and render its `titles` as a numbered list — NO other formatting per the generate_ideas tool description."
    );
  } else if (mode === "validate") {
    lines.push(
      "",
      "## VALIDATE MODE (active)",
      "The user has a topic in mind. They want a go/no-go. DO NOT call generate_ideas. DO NOT compose new titles. Use validate_idea + list_outliers + list_my_videos (+ web_search if needed).",
      "",
      "Output structure for Validate:",
      "**Topic:** {echo the topic verbatim}",
      "",
      "**Cross-channel evidence (last 60d):**",
      "{call list_outliers, filter by topic match. If ≥2 distinct competitors hit ≥3×, list them with full forensic evidence per the generate_ideas spec (title link, channel + subs, views vs median, uploaded absolute date). If <2, say so explicitly: \"Only N competitor(s) have hit this topic ≥3× in 60d.\"}",
      "",
      "**Own-catalog status (last 12mo):**",
      "{call validate_idea (or findOwnCatalogTopicMatches via the agent path: ask list_my_videos with the topic keywords). If matches exist, list 1-3 with views + multiplier + absolute date + performanceBand. If no matches, say \"Fresh — you haven't shipped this topic.\" If 1-2 underperformers, flag \"Tried, didn't work — needs a fresh angle.\"}",
      "",
      "**Recency signal:**",
      "{is the topic still trending? Pull the most-recent outlier match date. If >30d ago, flag as \"cooling\". If ≤14d, \"hot now\". If web_search was used, cite source URLs.}",
      "",
      "**Verdict:**",
      "{one of three: \"Do it — clear cross-channel signal + fresh for you.\" / \"Pivot the angle — covered it before / has competitors who already won.\" / \"Skip — no cross-channel evidence + no own-channel hook.\"}",
      "",
      "**Why:** {2-3 sentence rationale grounded in the evidence above.}"
    );
  } else {
    // Ideate is the default — keep the system prompt lean.
    lines.push(
      "",
      "## IDEATE MODE (active — default)",
      "Lean turn: call generate_ideas, render its `titles` array as a numbered list (3-5 entries) and STOP. No preamble. No source citations. No catalog tags. No 'Next step this week' line. The numbered list IS the entire deliverable. If the user wants reasoning they'll ask 'explain idea N' in a follow-up — then surface the stored attribution from the most recent generate_ideas response."
    );
  }

  if (opts.advisorEnabled) {
    lines.push(
      "",
      "## advisor (escalation to Opus)",
      "Budget 3 calls/turn. Call for contradictory evidence, multi-factor tradeoffs, or when you suspect your plan is wrong. Don't call for lookups/formatting."
    );
  }

  const prompt = lines.join("\n");

  if (!promptSizeDiagLogged) {
    promptSizeDiagLogged = true;
    log.info(
      "chat",
      `[diag] system prompt: ${prompt.length} chars (~${Math.ceil(prompt.length / 4)} tokens) for mode=${mode}, groups=${activeGroups.join(",")}`
    );
  }

  return prompt;
}
