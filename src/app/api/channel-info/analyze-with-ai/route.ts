import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  getCommentAnalysis,
  getIntegration,
  getSetting,
  listAllChannels,
  listVideos,
  setSetting,
} from "@/lib/db";
import { extractSection, loadMentorMethod } from "@/lib/mentor-method";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

const RATE_LIMIT_WINDOW_SEC = 5 * 60; // one analyze per channel per 5 min

// Single-paragraph channel_description — the one source of truth the rest
// of the app's AI agents read on every job. Signal sources: recent video
// titles + descriptions + view/like/comment counts, and recent comment-analysis
// summaries when any.
// Transcripts used to feed this prompt; that backend was removed in the
// May 2026 simplification pass.
const DESCRIPTION_CAP = 1500;
type Proposal = { description: string };

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
  // active one. The page sets the active channel via the picker before
  // analyzing in normal flow.
  const recentVideos = listVideos({ limit: 10 }).slice(0, 10);

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

  // Build prompt.
  const md = loadMentorMethod();
  const sec1 = extractSection(md, 1);
  const sec7 = extractSection(md, 7);
  const sec9 = extractSection(md, 9);

  const audienceLine =
    "Cover audience inferred from titles + descriptions + comment-analysis summaries below — age range, region, what they're looking for.";

  // v2: a single channel_description paragraph (one source of truth that
  // the agent reads on every job). Replaces the prior 5-field proposal.
  const systemPrompt = [
    "You are writing the channel_description paragraph for a YouTube creator. This single paragraph is what the rest of this app's AI agents read every time they run. Quality of this text directly shapes ideation quality.",
    "",
    "From MENTOR_METHOD.md §1 (Competitor mapping — the B&S Method):",
    sec1 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §7 (Ideation — synthesizing the inputs):",
    sec7 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §9 (The \"what made it work\" lever taxonomy):",
    sec9 || "(section unavailable)",
    "",
    "# What this paragraph must cover",
    "- WHAT the channel is about (1 sentence — the niche, but framed naturally, not as a definition).",
    `- WHO watches and why. ${audienceLine}`,
    "- HOW it sounds (voice, pacing, signature moves — concrete, not adjectives).",
    "- WHAT makes it different from neighbouring channels in the same space.",
    "",
    "# Style",
    "- Plain words a 14-year-old reads in <2 seconds. No flowery adjectives.",
    "- 4-7 sentences total. ≤1500 characters. The shorter the better — long fluff dilutes the agent's focus.",
    "- Specific over generic. \"Slow narration, sleep-friendly pacing, no music spikes\" beats \"high production value\".",
    "- If signal is weak for any part (e.g. small channel with few comments analyzed), say what you do know and stop — don't invent.",
    "",
    "Return ONLY a JSON object. No prose, no markdown, no code fence. Shape:",
    "{ \"description\": string }",
  ]
    .join("\n");

  const userBody = [
    `# Channel`,
    `- Title: ${channel.title ?? "(none)"}`,
    `- Handle: ${channel.handle ?? "(none)"}`,
    `- Subscribers: ${channel.subscriber_count ?? "unknown"}`,
    "",
    `# Recent ${recentVideos.length} videos (title — views/likes/comments — description excerpt)`,
    ...recentVideos.map((v, i) => {
      const desc = (v.description ?? "").slice(0, 400).replace(/\s+/g, " ").trim();
      const stats = `${v.views ?? 0}v / ${v.likes ?? 0}l / ${v.comments ?? 0}c`;
      return `${i + 1}. ${v.title} — ${stats}${desc ? ` — ${desc}` : ""}`;
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
      model: "claude-sonnet-4-6",
      // v2: single description paragraph ≤1500 chars ≈ ~400 tokens out.
      // 1200 max_tokens gives headroom for the JSON wrapper + thinking
      // room. Slightly tighter temperature than the prior 5-field call
      // because we want one coherent paragraph, not 5 short field stubs.
      max_tokens: 1200,
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
 * peels common wrappers, extracts the description field, and clamps to
 * the cap so a runaway model can't blow the column limit.
 */
function parseProposal(raw: string): Proposal | null {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    text = text.trim();
  }
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
  const v = obj.description;
  if (typeof v !== "string") return null;
  const description = v.trim();
  if (description.length === 0) return null;
  return {
    description:
      description.length > DESCRIPTION_CAP
        ? `${description.slice(0, DESCRIPTION_CAP - 1).trimEnd()}…`
        : description,
  };
}
