/**
 * POST /api/channel-info/topic-analysis
 *
 * Single Claude call (sonnet 4.6, no extended thinking — pure
 * summarization, not reasoning) that:
 *  1. Reads the user's last 30 video titles + descriptions
 *  2. Reads every competitor outlier (≥ 2× the competitor's 90-day median)
 *     for that user_channel_id, last 90 days
 *  3. Returns 5-8 named topic clusters for the user's own catalog plus a
 *     cross-channel virality view — i.e. which of those clusters have ≥ 2
 *     different competitors winning on similar topics.
 *
 * Cached for 24h on channels.topic_analysis_json + channels.topic_analysis_at.
 * Body { refresh: true } bypasses the cache.
 */

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { db, getIntegration, listAllChannels } from "@/lib/db";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 120;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type TopicCluster = {
  cluster_name: string;
  video_ids_in_cluster: string[];
  avg_views: number;
};

export type CrossCompetitorViral = {
  cluster_name: string;
  competitor_outliers: {
    video_id: string;
    title: string;
    channel_name: string;
    multiplier: number;
  }[];
};

export type TopicAnalysis = {
  generated_at: string;
  my_clusters: TopicCluster[];
  cross_competitor_viral: CrossCompetitorViral[];
};

type UserVideo = {
  id: string;
  title: string;
  description: string | null;
  views: number;
};

type CompetitorOutlier = {
  video_id: string;
  title: string;
  channel_name: string;
  channel_handle: string | null;
  views: number;
  multiplier: number;
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    channelId?: unknown;
    refresh?: unknown;
  };
  const channelId =
    typeof body.channelId === "string" ? body.channelId.trim() : "";
  const refresh = body.refresh === true;
  if (!channelId) {
    return NextResponse.json(
      { error: "channelId required" },
      { status: 400 }
    );
  }

  const channel = listAllChannels().find((c) => c.id === channelId);
  if (!channel) {
    return NextResponse.json(
      { error: `Unknown channel ${channelId}` },
      { status: 404 }
    );
  }


  // Cache check
  if (!refresh) {
    const row = db
      .prepare(
        `SELECT topic_analysis_json, topic_analysis_at
         FROM channels WHERE id = ?`
      )
      .get(channelId) as {
      topic_analysis_json: string | null;
      topic_analysis_at: string | null;
    } | undefined;
    if (row?.topic_analysis_json && row.topic_analysis_at) {
      const ts = Date.parse(row.topic_analysis_at);
      if (Number.isFinite(ts) && Date.now() - ts < CACHE_TTL_MS) {
        try {
          const cached = JSON.parse(row.topic_analysis_json) as TopicAnalysis;
          return NextResponse.json({ analysis: cached, cached: true });
        } catch {
          // fall through to recompute on parse failure
        }
      }
    }
  }

  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Claude API key not configured" },
      { status: 400 }
    );
  }

  // 1. user's last 30 videos
  const userVideos = db
    .prepare(
      `SELECT id, title, description, views FROM videos
       WHERE channel_id = ?
       ORDER BY COALESCE(published_at, imported_at) DESC
       LIMIT 30`
    )
    .all(channelId) as UserVideo[];
  if (userVideos.length === 0) {
    return NextResponse.json(
      { error: "No videos on file for this channel — sync it first." },
      { status: 400 }
    );
  }

  // 2. competitor outliers — last 90 days, views > 2× the competitor's
  //    own 90-day median. Mirrors the CTE pattern already used elsewhere
  //    in db.ts. Scoped to this user_channel_id only.
  const outliers = db
    .prepare(
      `WITH videos_90d AS (
         SELECT v.competitor_id, v.video_id, v.title, v.views, v.published_at,
                c.title AS channel_name, c.handle AS channel_handle,
                ROW_NUMBER() OVER (PARTITION BY v.competitor_id ORDER BY v.views) AS rn,
                COUNT(*)     OVER (PARTITION BY v.competitor_id)                  AS n_90d
         FROM competitor_videos v
         JOIN competitors c ON c.id = v.competitor_id
         WHERE v.published_at > strftime('%s','now') - 90 * 86400
           AND c.user_channel_id = ?
       ),
       qualified_medians AS (
         SELECT competitor_id, AVG(views) AS median_views
         FROM videos_90d
         WHERE n_90d >= 5 AND rn IN ((n_90d + 1) / 2, (n_90d + 2) / 2)
         GROUP BY competitor_id
       )
       SELECT v.video_id, v.title, v.channel_name, v.channel_handle, v.views,
              ROUND(CAST(v.views AS REAL) / m.median_views, 2) AS multiplier
       FROM videos_90d v
       JOIN qualified_medians m ON m.competitor_id = v.competitor_id
       WHERE v.views > 2 * m.median_views
       ORDER BY multiplier DESC
       LIMIT 80`
    )
    .all(channelId) as CompetitorOutlier[];

  const systemPrompt = [
    "You are summarising a YouTube channel's content topics. You receive (a) the user's last 30 videos and (b) competitor outliers (videos that hit ≥ 2× their channel's 90-day median). Cluster the user's videos into 5-8 distinct topics, then identify cross-competitor virality.",
    "",
    "## Rules",
    "- cluster_name: 2-4 plain words. Specific over generic. e.g. \"Planet Nine\" not \"space\"; \"Solar storms\" not \"weather\".",
    "- Every user video MUST appear in exactly one of my_clusters[*].video_ids_in_cluster.",
    "- avg_views: integer, the average views of the videos in that cluster.",
    "- cross_competitor_viral: include a cluster ONLY when ≥ 2 different competitor channels have outliers covering similar topics. Skip the cluster otherwise.",
    "- competitor_outliers in each cross_competitor_viral entry: copy verbatim from the input list (do not invent video_ids, titles, or multipliers).",
    "",
    "## Output schema (JSON only, no prose, no markdown)",
    "{",
    '  "my_clusters": [{ "cluster_name": string, "video_ids_in_cluster": string[], "avg_views": number }],',
    '  "cross_competitor_viral": [{ "cluster_name": string, "competitor_outliers": [{ "video_id": string, "title": string, "channel_name": string, "multiplier": number }] }]',
    "}",
  ].join("\n");

  const userPrompt = [
    `# Channel: ${channel.title ?? "(untitled)"}`,
    "",
    `## My last ${userVideos.length} videos`,
    ...userVideos.map((v, i) => {
      const desc = (v.description ?? "").slice(0, 200).replace(/\s+/g, " ").trim();
      return `${i + 1}. [id=${v.id}] (${v.views}v) ${v.title}${desc ? ` — ${desc}` : ""}`;
    }),
    "",
    `## Competitor outliers (last 90 days, ≥ 2× their 90d median) — ${outliers.length} videos`,
    ...outliers.map(
      (o) =>
        `- [${o.video_id}] (${o.multiplier}×) ${o.channel_name}${o.channel_handle ? ` (${o.channel_handle})` : ""}: ${o.title}`
    ),
    "",
    "Return the JSON object only.",
  ].join("\n");

  const client = new Anthropic({ apiKey });
  let raw = "";
  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Claude call failed";
    log.error("topic-analysis", `channel ${channelId}: ${msg}`, err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  let parsed: TopicAnalysis;
  try {
    const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < 0) throw new Error("no JSON object found");
    const obj = JSON.parse(text.slice(start, end + 1)) as Partial<TopicAnalysis>;
    if (!Array.isArray(obj.my_clusters)) throw new Error("my_clusters missing");
    if (!Array.isArray(obj.cross_competitor_viral)) {
      obj.cross_competitor_viral = [];
    }
    parsed = {
      generated_at: new Date().toISOString(),
      my_clusters: obj.my_clusters as TopicCluster[],
      cross_competitor_viral: obj.cross_competitor_viral as CrossCompetitorViral[],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "parse failed";
    log.warn(
      "topic-analysis",
      `channel ${channelId}: malformed JSON (${msg}); raw=${raw.slice(0, 200)}`
    );
    return NextResponse.json(
      { error: "AI returned malformed JSON. Try again." },
      { status: 502 }
    );
  }

  db.prepare(
    `UPDATE channels SET topic_analysis_json = ?, topic_analysis_at = ? WHERE id = ?`
  ).run(JSON.stringify(parsed), parsed.generated_at, channelId);

  return NextResponse.json({ analysis: parsed, cached: false });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelId = url.searchParams.get("channelId");
  if (!channelId) {
    return NextResponse.json(
      { error: "channelId required" },
      { status: 400 }
    );
  }
  const row = db
    .prepare(
      `SELECT topic_analysis_json, topic_analysis_at FROM channels WHERE id = ?`
    )
    .get(channelId) as
    | { topic_analysis_json: string | null; topic_analysis_at: string | null }
    | undefined;
  if (!row || !row.topic_analysis_json) {
    return NextResponse.json({ analysis: null });
  }
  try {
    const parsed = JSON.parse(row.topic_analysis_json) as TopicAnalysis;
    return NextResponse.json({ analysis: parsed, generated_at: row.topic_analysis_at });
  } catch {
    return NextResponse.json({ analysis: null });
  }
}
