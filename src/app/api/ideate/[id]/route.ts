import { NextResponse } from "next/server";
import {
  db,
  getActiveChannelId,
  getCached,
  getIntegration,
  setCached,
} from "@/lib/db";
import { fetchVideos } from "@/lib/youtube";

export const runtime = "nodejs";

interface GenerationRow {
  id: string;
  user_channel_id: string;
  mode: string;
  count: number;
  status: "processing" | "completed" | "failed";
  estimated_cost_millicents: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface IdeaRow {
  id: string;
  title: string;
  description: string;
  source_attribution: string | null;
  proof_json: string | null;
  confidence_level: "high" | "medium" | "low" | null;
  research_sources_json: string | null;
  validation_status: "passed" | "rejected";
  validation_reason: string | null;
  fit_score: number | null;
  fit_reason: string | null;
  user_note: string | null;
  used_by_user: number;
  feedback: "positive" | "negative" | null;
  feedback_reason: string | null;
}

interface SourceVideo {
  video_id: string;
  title: string;
  channel_name: string;
  channel_handle: string | null;
  multiplier: number | null;
  thumbnail_url?: string | null;
  views?: number | null;
  published_at?: number | null;
  age_days?: number | null;
}

interface SourceAttribution {
  family?: string;
  topic_source?: SourceVideo | null;
  format_source?: SourceVideo | null;
  topic_evidence_sources?: SourceVideo[];
  reasoning?: string;
  method?: string;
  topic_source_video_id?: string;
  format_source_video_id?: string;
}

interface SourceVideoMeta {
  video_id: string;
  title: string | null;
  channel_name: string | null;
  channel_handle: string | null;
  thumbnail_url: string | null;
  views: number | null;
  published_at: number | null;
  age_days: number | null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const gen = db
    .prepare(
      `SELECT id, user_channel_id, mode, count, status,
              estimated_cost_millicents, started_at, completed_at, error
       FROM generations WHERE id = ?`
    )
    .get(id) as GenerationRow | undefined;

  if (!gen) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Authorization: channel must exist (acts as a soft owner check in a
  // single-user app — cross-channel pollers would still need a real channel id).
  const activeChannelId = getActiveChannelId();
  const channelExists = db
    .prepare(`SELECT 1 AS x FROM channels WHERE id = ?`)
    .get(gen.user_channel_id) as { x: number } | undefined;
  if (!channelExists) {
    return NextResponse.json({ error: "channel gone" }, { status: 403 });
  }

  if (gen.status === "processing") {
    const elapsedSeconds = Math.floor(
      (Date.now() - new Date(gen.started_at + "Z").getTime()) / 1000
    );
    return NextResponse.json({
      status: "processing",
      request_id: gen.id,
      mode: gen.mode,
      count: gen.count,
      started_at: gen.started_at,
      elapsed_seconds: Math.max(0, elapsedSeconds),
      is_active_channel: activeChannelId === gen.user_channel_id,
    });
  }

  if (gen.status === "failed") {
    return NextResponse.json({
      status: "failed",
      request_id: gen.id,
      mode: gen.mode,
      count: gen.count,
      error: gen.error ?? "unknown error",
      started_at: gen.started_at,
      completed_at: gen.completed_at,
    });
  }

  // completed
  const rows = db
    .prepare(
      `SELECT id, title, description, source_attribution, validation_status,
              proof_json, confidence_level, research_sources_json,
              validation_reason, fit_score, fit_reason, user_note,
              used_by_user, feedback, feedback_reason
       FROM ideas WHERE generation_id = ?
       ORDER BY COALESCE(fit_score, 0) DESC, created_at ASC`
    )
    .all(id) as IdeaRow[];

  const ideas = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    fit_score: r.fit_score,
    fit_reason: r.fit_reason,
    validation_status: r.validation_status,
    validation_reason: r.validation_reason,
    user_note: r.user_note,
    used: r.used_by_user === 1,
    feedback: r.feedback,
    feedback_reason: r.feedback_reason,
    source_attribution: r.source_attribution
      ? parseSourceAttribution(r.source_attribution)
      : null,
    proof: r.proof_json ? safeParse(r.proof_json) : null,
    confidence_level: r.confidence_level,
    research_sources: r.research_sources_json ? safeParse(r.research_sources_json) : [],
  }));

  await enrichSourceAttributions(
    ideas
      .map((idea) => idea.source_attribution)
      .filter((attr): attr is SourceAttribution => !!attr)
  );

  return NextResponse.json({
    status: "completed",
    request_id: gen.id,
    mode: gen.mode,
    count: gen.count,
    started_at: gen.started_at,
    completed_at: gen.completed_at,
    estimated_cost_millicents: gen.estimated_cost_millicents,
    ideas,
    rejected: [],
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseSourceAttribution(s: string): SourceAttribution | null {
  const parsed = safeParse(s);
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as SourceAttribution;
}

function isSourceVideo(value: unknown): value is SourceVideo {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as SourceVideo).video_id === "string" &&
    (value as SourceVideo).video_id.length > 0
  );
}

function ageDaysFromPublishedAt(publishedAt: number | null): number | null {
  if (!publishedAt || publishedAt <= 0) return null;
  return Math.max(
    0,
    Math.floor((Date.now() / 1000 - publishedAt) / 86400)
  );
}

function sourceHasDisplayMeta(source: SourceVideo): boolean {
  return (
    !!source.thumbnail_url &&
    typeof source.views === "number" &&
    typeof source.published_at === "number"
  );
}

function mergeSourceMeta(source: SourceVideo, meta: SourceVideoMeta): SourceVideo {
  const publishedAt = meta.published_at ?? source.published_at ?? null;
  return {
    ...source,
    title: meta.title || source.title,
    channel_name: meta.channel_name || source.channel_name,
    channel_handle: meta.channel_handle ?? source.channel_handle ?? null,
    thumbnail_url: meta.thumbnail_url ?? source.thumbnail_url ?? null,
    views: meta.views ?? source.views ?? null,
    published_at: publishedAt,
    age_days:
      meta.age_days ??
      source.age_days ??
      ageDaysFromPublishedAt(publishedAt),
  };
}

function cacheKey(videoId: string): string {
  return `youtube.video-meta.${videoId}`;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

function collectSourceVideos(attributions: SourceAttribution[]): SourceVideo[] {
  const sources: SourceVideo[] = [];
  for (const attr of attributions) {
    if (isSourceVideo(attr.topic_source)) sources.push(attr.topic_source);
    if (isSourceVideo(attr.format_source)) sources.push(attr.format_source);
    for (const source of attr.topic_evidence_sources ?? []) {
      if (isSourceVideo(source)) sources.push(source);
    }
  }
  return sources;
}

function readLocalVideoMeta(videoIds: string[]): Map<string, SourceVideoMeta> {
  const meta = new Map<string, SourceVideoMeta>();
  if (videoIds.length === 0) return meta;

  const ownRows = db
    .prepare(
      `SELECT v.id AS video_id, v.title, v.thumbnail_url, v.views, v.published_at,
              c.title AS channel_name, c.handle AS channel_handle
       FROM videos v
       LEFT JOIN channels c ON c.id = v.channel_id
       WHERE v.id IN (${placeholders(videoIds)})`
    )
    .all(...videoIds) as Array<{
      video_id: string;
      title: string | null;
      thumbnail_url: string | null;
      views: number | null;
      published_at: number | null;
      channel_name: string | null;
      channel_handle: string | null;
    }>;

  for (const row of ownRows) {
    meta.set(row.video_id, {
      video_id: row.video_id,
      title: row.title,
      channel_name: row.channel_name,
      channel_handle: row.channel_handle,
      thumbnail_url: row.thumbnail_url,
      views: row.views,
      published_at: row.published_at,
      age_days: ageDaysFromPublishedAt(row.published_at),
    });
  }

  const competitorRows = db
    .prepare(
      `SELECT v.video_id, v.title, v.thumbnail_url, v.views, v.published_at,
              c.title AS channel_name, c.handle AS channel_handle
       FROM competitor_videos v
       LEFT JOIN competitors c ON c.id = v.competitor_id
       WHERE v.video_id IN (${placeholders(videoIds)})`
    )
    .all(...videoIds) as Array<{
      video_id: string;
      title: string | null;
      thumbnail_url: string | null;
      views: number | null;
      published_at: number | null;
      channel_name: string | null;
      channel_handle: string | null;
    }>;

  for (const row of competitorRows) {
    if (meta.has(row.video_id) && sourceMetaComplete(meta.get(row.video_id)!)) {
      continue;
    }
    meta.set(row.video_id, {
      video_id: row.video_id,
      title: row.title,
      channel_name: row.channel_name,
      channel_handle: row.channel_handle,
      thumbnail_url: row.thumbnail_url,
      views: row.views,
      published_at: row.published_at,
      age_days: ageDaysFromPublishedAt(row.published_at),
    });
  }

  return meta;
}

function sourceMetaComplete(meta: SourceVideoMeta): boolean {
  return (
    !!meta.thumbnail_url &&
    typeof meta.views === "number" &&
    typeof meta.published_at === "number"
  );
}

async function fetchRemoteVideoMeta(
  videoIds: string[]
): Promise<Map<string, SourceVideoMeta>> {
  const meta = new Map<string, SourceVideoMeta>();
  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey || videoIds.length === 0) return meta;

  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    try {
      const videos = await fetchVideos(chunk, apiKey);
      for (const video of videos) {
        const item: SourceVideoMeta = {
          video_id: video.id,
          title: video.title,
          channel_name: null,
          channel_handle: null,
          thumbnail_url: video.thumbnail,
          views: video.views,
          published_at: video.publishedAt,
          age_days: ageDaysFromPublishedAt(video.publishedAt),
        };
        meta.set(video.id, item);
        setCached(cacheKey(video.id), item, 30 * 24 * 3600);
      }
    } catch {
      // Enrichment is best-effort. The idea itself should still render.
    }
  }

  return meta;
}

async function enrichSourceAttributions(
  attributions: SourceAttribution[]
): Promise<void> {
  const sources = collectSourceVideos(attributions);
  const videoIds = [...new Set(sources.map((source) => source.video_id))];
  if (videoIds.length === 0) return;

  const meta = readLocalVideoMeta(videoIds);

  for (const id of videoIds) {
    if (sourceMetaComplete(meta.get(id) ?? ({} as SourceVideoMeta))) continue;
    const cached = getCached<SourceVideoMeta>(cacheKey(id));
    if (cached) meta.set(id, cached);
  }

  const idsToFetch = videoIds.filter((id) => {
    const source = sources.find((s) => s.video_id === id);
    if (source && sourceHasDisplayMeta(source)) return false;
    const item = meta.get(id);
    return !item || !sourceMetaComplete(item);
  });

  const remote = await fetchRemoteVideoMeta(idsToFetch);
  for (const [id, item] of remote) meta.set(id, item);

  for (const attr of attributions) {
    if (isSourceVideo(attr.topic_source)) {
      const item = meta.get(attr.topic_source.video_id);
      if (item) attr.topic_source = mergeSourceMeta(attr.topic_source, item);
    }
    if (isSourceVideo(attr.format_source)) {
      const item = meta.get(attr.format_source.video_id);
      if (item) attr.format_source = mergeSourceMeta(attr.format_source, item);
    }
    if (Array.isArray(attr.topic_evidence_sources)) {
      attr.topic_evidence_sources = attr.topic_evidence_sources.map((source) => {
        const item = meta.get(source.video_id);
        return item ? mergeSourceMeta(source, item) : source;
      });
    }
  }
}
