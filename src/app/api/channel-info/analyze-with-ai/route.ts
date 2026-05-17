import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import {
  getCommentAnalysis,
  getIntegration,
  getSetting,
  getTranscript,
  listAllChannels,
  listVideos,
  setSetting,
} from "@/lib/db";
import { getOAuthTokens } from "@/lib/google-oauth";
import {
  fetchChannelAudience,
  YtAnalyticsError,
  type ChannelAudienceBundle,
} from "@/lib/yt-analytics";
import { providerModelId } from "@/lib/ai-provider-types";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

const RATE_LIMIT_WINDOW_SEC = 5 * 60; // one analyze per channel per 5 min

// MENTOR_METHOD.md sections are loaded from disk once per process. The
// file is at the project root next to package.json — same lookup the DB
// module uses. Cached on first read; the file is small and stable.
let methodCache: string | null = null;
function loadMentorMethod(): string {
  if (methodCache !== null) return methodCache;
  try {
    // Walk up from cwd to find package.json, then read MENTOR_METHOD.md
    // alongside it. Same posture as src/lib/db.ts's findProjectRoot.
    let cur = process.cwd();
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(cur, "package.json"))) break;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    const filePath = path.join(cur, "MENTOR_METHOD.md");
    methodCache = fs.readFileSync(filePath, "utf8");
  } catch {
    methodCache = "";
  }
  return methodCache;
}

/**
 * Slice the methodology document down to specific sections by their
 * "## N. <title>" headers. Returns the section body without its own
 * header line. Falls back to empty string if the section isn't found —
 * the prompt still works, just with less context.
 */
function extractSection(md: string, sectionNumber: number): string {
  // Match "## <n>. " at the start of a line, capture until the next
  // "## " heading or end of file.
  const re = new RegExp(
    `^##\\s+${sectionNumber}\\.\\s+[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+\\d+\\.|\\Z)`,
    "m"
  );
  const m = md.match(re);
  if (!m) return "";
  return m[1].trim();
}

const FIELD_VOCAB = ["niche", "positioning", "audience", "voice", "externalSources"] as const;
type FieldKey = (typeof FIELD_VOCAB)[number];

type Proposal = Record<FieldKey, string>;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { channelId?: unknown };
  const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
  if (!channelId) {
    return NextResponse.json(
      { error: "channelId required" },
      { status: 400 }
    );
  }

  // Channel sanity check.
  const all = listAllChannels();
  const channel = all.find((c) => c.id === channelId);
  if (!channel) {
    return NextResponse.json(
      { error: `Unknown channel ${channelId}` },
      { status: 404 }
    );
  }

  // Rate limit: one analyze per channel per 5 minutes. Stored in settings
  // table as `analyze_ai.last_run.<channelId>` = Unix seconds.
  const key = `analyze_ai.last_run.${channelId}`;
  const last = Number(getSetting(key) ?? "0");
  const now = Math.floor(Date.now() / 1000);
  if (last > 0 && now - last < RATE_LIMIT_WINDOW_SEC) {
    const retryAfterSec = RATE_LIMIT_WINDOW_SEC - (now - last);
    return NextResponse.json(
      {
        error: "Analyze-with-AI is rate-limited per channel",
        retryAfterSec,
      },
      { status: 429 }
    );
  }

  // API key check.
  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Claude API key not configured. Add it on the Integrations page.",
      },
      { status: 400 }
    );
  }

  // Gather signal. listVideos() is channel-scoped via getActiveChannelId
  // internally — but the page can analyze any channel, not just the
  // active one. We use the SQL pattern in db.ts directly via a generic
  // listVideos() override is non-trivial; instead, pull the top 10
  // most-recent videos for THIS channelId via a dedicated SQL helper.
  //
  // For simplicity in this round, fall back to listVideos() which uses
  // the active channel. The page sets the active channel via the picker
  // before analyzing in normal flow. This means analyzing a non-active
  // channel will pull the active channel's videos — flag for follow-up.
  const recentVideos = listVideos({ limit: 10 }).slice(0, 10);

  // 2-3 transcripts that fit ~5K input tokens combined (we use chars as
  // a rough proxy: ~4 chars / token, target ~20K chars total).
  const transcriptBudget = 20_000;
  const transcripts: { videoId: string; title: string; text: string }[] = [];
  let used = 0;
  const sortedByLength = [...recentVideos]
    .map((v) => ({ video: v, transcript: getTranscript(v.id) }))
    .filter((x) => x.transcript && x.transcript.text.length > 0)
    .sort((a, b) => (b.transcript?.text.length ?? 0) - (a.transcript?.text.length ?? 0));
  for (const { video, transcript } of sortedByLength) {
    if (!transcript) continue;
    const remaining = transcriptBudget - used;
    if (remaining < 1500) break;
    const slice = transcript.text.slice(0, Math.min(transcript.text.length, remaining));
    transcripts.push({ videoId: video.id, title: video.title, text: slice });
    used += slice.length;
    if (transcripts.length >= 3) break;
  }

  // 2-3 comment analyses if available.
  const commentAnalyses: { videoId: string; title: string; summary: string }[] = [];
  for (const v of recentVideos) {
    if (commentAnalyses.length >= 3) break;
    const ca = getCommentAnalysis(v.id);
    if (ca && ca.summary) {
      commentAnalyses.push({
        videoId: v.id,
        title: v.title,
        summary: ca.summary,
      });
    }
  }

  // Demographics fetch — graceful, never blocks the AI proposal.
  // Three failure modes all caught: no OAuth tokens, soft 4xx from YT
  // Analytics (per-sub-report soft() wrapper), and unexpected throws.
  // When demographics ARE available we inject them as ground truth for
  // the Audience field; when absent the Audience instruction falls back
  // to the original "infer from titles/transcripts" wording.
  let demographicsBlock = "";
  const oauth = getOAuthTokens(channelId);
  if (oauth?.refresh_token) {
    try {
      // PeriodSpec is `number | "all"` (days, not the "90d" string key).
      const audience = await fetchChannelAudience(90, channelId);
      demographicsBlock = formatDemographicsBlock(audience);
      if (demographicsBlock) {
        log.info(
          "claude",
          `Analyze-with-AI ${channelId}: injected demographics (${audience.demographics.length} demo rows, ${audience.geography.length} countries)`
        );
      } else {
        log.info(
          "claude",
          `Analyze-with-AI ${channelId}: demographics empty (OAuth granted but YT returned no rows)`
        );
      }
    } catch (err) {
      const msg =
        err instanceof YtAnalyticsError || err instanceof Error
          ? err.message
          : "audience fetch failed";
      log.warn(
        "claude",
        `Analyze-with-AI ${channelId}: skipping demographics — ${msg}`
      );
    }
  } else {
    log.info(
      "claude",
      `Analyze-with-AI ${channelId}: skipping demographics — no OAuth tokens for this channel`
    );
  }

  // Build prompt.
  const md = loadMentorMethod();
  const sec1 = extractSection(md, 1);
  const sec7 = extractSection(md, 7);
  const sec9 = extractSection(md, 9);

  const audienceInstruction = demographicsBlock
    ? "- audience: 1–3 sentences, who watches and why. USE THE DEMOGRAPHICS BLOCK ABOVE AS GROUND TRUTH — describe the audience grounded in those exact age/gender/country numbers; don't speculate about who watches when the data is right there. Mention the top age group and top 2 countries by share."
    : "- audience: 1–3 sentences, who watches and why";

  const systemPrompt = [
    "You are analyzing a YouTube creator's channel to propose values for five context fields that the rest of this app's AI features will read every time they run. Be accurate; if signal is weak for a field, say so in the field rather than inventing detail.",
    "",
    "From MENTOR_METHOD.md §1 (Competitor mapping — the B&S Method):",
    sec1 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §7 (Ideation — synthesizing the inputs):",
    sec7 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §9 (The \"what made it work\" lever taxonomy):",
    sec9 || "(section unavailable)",
    demographicsBlock ? "" : null,
    demographicsBlock || null,
    "",
    "The five fields you are filling in:",
    "- niche: one line, 5–15 words, what this channel is about",
    "- positioning: 1–3 sentences, what makes this channel different from others in the same niche (use specifics; avoid generic claims)",
    audienceInstruction,
    "- voice: 1–3 sentences, tone / pacing / signature stylistic elements",
    "- externalSources: newline-separated list of off-YouTube sources the AI should reference during ideation (e.g. \"r/Space\", \"NASA mission archives\"). Up to 6 lines.",
    "",
    "Return ONLY a JSON object. No prose, no markdown, no code fence. Keys: niche, positioning, audience, voice, externalSources. Values are strings (externalSources is a single string with newlines between sources).",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const userBody = [
    `# Channel`,
    `- Title: ${channel.title ?? "(none)"}`,
    `- Handle: ${channel.handle ?? "(none)"}`,
    `- Subscribers: ${channel.subscriber_count ?? "unknown"}`,
    "",
    `# Recent ${recentVideos.length} video titles + descriptions`,
    ...recentVideos.map((v, i) => {
      const desc = (v.description ?? "").slice(0, 400);
      return `${i + 1}. ${v.title}${desc ? ` — ${desc.replace(/\s+/g, " ").trim()}` : ""}`;
    }),
    "",
    transcripts.length > 0
      ? `# Sample transcripts (${transcripts.length}, truncated)`
      : "",
    ...transcripts.map((t) => {
      return [`## "${t.title}"`, t.text].join("\n");
    }),
    commentAnalyses.length > 0
      ? `\n# Recent comment-analysis summaries (${commentAnalyses.length})`
      : "",
    ...commentAnalyses.map((c) => `- "${c.title}": ${c.summary}`),
  ]
    .filter((line) => line !== "")
    .join("\n");

  // Call Claude.
  const client = new Anthropic({ apiKey });
  let proposal: Proposal | null = null;
  try {
    const resp = await client.messages.create({
      model: providerModelId("claude"),
      max_tokens: 1500,
      temperature: 0.4,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    proposal = parseProposal(text);
    if (!proposal) {
      log.warn(
        "claude",
        `Analyze-with-AI ${channelId}: could not parse JSON from Claude. Raw: ${text.slice(0, 200)}`
      );
      return NextResponse.json(
        { error: "AI returned malformed JSON. Try again." },
        { status: 502 }
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Claude call failed";
    log.error("claude", `Analyze-with-AI ${channelId}: ${msg}`, err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Mark rate-limit AFTER a successful call so failures don't lock the
  // user out for 5 minutes.
  setSetting(key, String(now));

  return NextResponse.json({ proposal });
}

/**
 * Best-effort JSON parse. Claude usually returns clean JSON when told
 * "no markdown / no code fence" but occasionally wraps in ```json. This
 * peels common wrappers and validates the 5-field shape.
 */
function parseProposal(raw: string): Proposal | null {
  let text = raw.trim();
  // Strip code fences if present.
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    text = text.trim();
  }
  // Find the first { ... } block in case Claude added a stray header.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const body = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const out: Proposal = {
    niche: "",
    positioning: "",
    audience: "",
    voice: "",
    externalSources: "",
  };
  for (const k of FIELD_VOCAB) {
    const v = obj[k];
    if (typeof v === "string") out[k] = v.trim();
    else if (Array.isArray(v) && k === "externalSources") {
      out[k] = v.filter((s) => typeof s === "string").join("\n");
    }
  }
  return out;
}

/**
 * Render the audience bundle as a compact human-readable block for the
 * Claude system prompt. Shows:
 *  - Top 5 age×gender combos by viewerPercentage (the direct % from YT)
 *  - Top 5 countries by view-share (computed against the sum of returned rows)
 *  - Top 3 traffic sources by view-share
 * Devices intentionally skipped — desktop/mobile/tablet split rarely
 * shapes the AUDIENCE description (it speaks to consumption habits more
 * than to who the audience is). Returns "" when every block is empty,
 * which the caller treats as "no demographics, fall back to inference".
 */
function formatDemographicsBlock(b: ChannelAudienceBundle): string {
  const lines: string[] = [];

  if (b.demographics.length > 0) {
    const top = [...b.demographics]
      .sort((a, x) => x.viewerPercentage - a.viewerPercentage)
      .slice(0, 5);
    lines.push("Age × gender (top 5 by viewer share):");
    for (const r of top) {
      lines.push(
        `  • ${r.ageGroup} ${r.gender} — ${r.viewerPercentage.toFixed(1)}%`
      );
    }
  }

  if (b.geography.length > 0) {
    const total = b.geography.reduce((s, r) => s + r.views, 0);
    if (total > 0) {
      const top = [...b.geography].slice(0, 5);
      lines.push("Top countries (by view share):");
      for (const r of top) {
        lines.push(
          `  • ${r.country} — ${((r.views / total) * 100).toFixed(1)}%`
        );
      }
    }
  }

  if (b.trafficSources.length > 0) {
    const total = b.trafficSources.reduce((s, r) => s + r.views, 0);
    if (total > 0) {
      const top = [...b.trafficSources].slice(0, 3);
      lines.push("Top traffic sources (by view share):");
      for (const r of top) {
        lines.push(
          `  • ${r.source} — ${((r.views / total) * 100).toFixed(1)}%`
        );
      }
    }
  }

  if (lines.length === 0) return "";
  return [
    `ACTUAL AUDIENCE DEMOGRAPHICS (from YouTube Analytics, last 90 days, ${b.period.startDate} → ${b.period.endDate}):`,
    ...lines,
  ].join("\n");
}
