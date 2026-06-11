import "server-only";

import {
  competitorMedianViews,
  db,
  getChannel,
  listMyWinners,
} from "@/lib/db";
import type { ImageReference, ImageReferenceKind } from "./types";

type SourceVideo = {
  video_id?: string;
  title?: string;
  channel_name?: string;
  channel_handle?: string | null;
  thumbnail_url?: string | null;
  views?: number | null;
  multiplier?: number | null;
  published_at?: number | null;
};

type SourceAttribution = {
  topic_source?: SourceVideo | null;
  format_source?: SourceVideo | null;
  topic_evidence_sources?: SourceVideo[];
};

type VideoMeta = {
  videoId: string;
  title: string | null;
  channelName: string | null;
  channelHandle: string | null;
  thumbnailUrl: string | null;
  views: number | null;
  thumbnailAllowed: boolean;
};

type SourceFeedbackRow = {
  source_url: string;
  source_video_id: string | null;
  feedback: "liked" | "disliked";
  reason: string | null;
};

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "alive",
  "back",
  "before",
  "being",
  "from",
  "found",
  "going",
  "into",
  "james",
  "just",
  "keeps",
  "never",
  "nobody",
  "over",
  "really",
  "reveals",
  "scientists",
  "something",
  "that",
  "there",
  "these",
  "this",
  "too",
  "what",
  "when",
  "with",
]);

const TOPIC_GROUPS = [
  {
    label: "edge",
    terms: [
      "edge",
      "boundary",
      "border",
      "wall",
      "map",
      "shape",
      "universe",
      "galaxy",
      "galaxies",
      "void",
      "deep",
    ],
  },
  {
    label: "life",
    terms: [
      "life",
      "oxygen",
      "planet",
      "earth",
      "habitable",
      "biosignature",
      "alien",
    ],
  },
  {
    label: "solar",
    terms: ["sun", "solar", "flare", "venus", "mars", "jupiter", "saturn"],
  },
  {
    label: "physics",
    terms: ["quantum", "cern", "timeline", "reality", "experiment", "particle"],
  },
] as const;

function safeJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeImageUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function sourceId(kind: ImageReferenceKind, videoId: string): string {
  return `${kind}:${videoId}`;
}

function titleTokens(text: string | null | undefined): Set<string> {
  const source = (text ?? "").toLowerCase();
  const tokens = new Set(
    source
      .replace(/jwst/g, " jwst james webb telescope ")
      .replace(/galaxies/g, " galaxy galaxies ")
      .replace(/universe's/g, " universe ")
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
  );
  if (source.includes("edge")) {
    tokens.add("boundary");
    tokens.add("wall");
  }
  if (source.includes("james webb") || source.includes("jwst")) {
    tokens.add("webb");
    tokens.add("jwst");
    tokens.add("telescope");
  }
  return tokens;
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let score = 0;
  for (const token of a) {
    if (b.has(token)) score += 1;
  }
  return score;
}

function lowerText(text: string | null | undefined): string {
  return (text ?? "").toLowerCase();
}

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function semanticTopicScore(target: string, refTitle: string): number {
  let score = 0;
  for (const group of TOPIC_GROUPS) {
    const targetHasGroup = hasAny(target, group.terms);
    const refHasGroup = hasAny(refTitle, group.terms);
    if (targetHasGroup && refHasGroup) score += group.label === "edge" ? 4 : 3;
    if (!targetHasGroup && refHasGroup && group.label === "life") score -= 4;
  }
  const targetHasWebb = hasAny(target, ["jwst", "james webb", "webb"]);
  const refHasWebb = hasAny(refTitle, ["jwst", "james webb", "webb"]);
  if (targetHasWebb && refHasWebb) score += 1;
  return score;
}

function labelsForRef(
  ref: ImageReference,
  feedback: SourceFeedbackRow | null,
  topicOverlap: number,
  semanticScore: number
): string[] {
  const labels: string[] = [];
  if (ref.kind === "idea_topic") labels.push("Topic");
  if (ref.kind === "idea_format") labels.push("Format");
  if (ref.kind === "idea_evidence") labels.push("Evidence");
  if (ref.kind === "channel_winner") labels.push("Style");
  if (ref.kind === "competitor_outlier") labels.push("Outlier");
  if (semanticScore >= 3) labels.push("Strong fit");
  if (topicOverlap > 0) labels.push("Topic match");
  if (typeof ref.multiplier === "number" && ref.multiplier >= 3) labels.push("3x+");
  if (feedback?.feedback === "liked") labels.push("Liked");
  return [...new Set(labels)];
}

function isIdeaSourceReference(ref: ImageReference): boolean {
  return (
    ref.kind === "idea_topic" ||
    ref.kind === "idea_format" ||
    ref.kind === "idea_evidence"
  );
}

function readSourceFeedback(userChannelId: string): SourceFeedbackRow[] {
  return db
    .prepare(
      `SELECT source_url, source_video_id, feedback, reason
       FROM image_source_feedback
       WHERE user_channel_id = ?`
    )
    .all(userChannelId) as SourceFeedbackRow[];
}

function feedbackForRef(
  ref: ImageReference,
  byUrl: Map<string, SourceFeedbackRow>,
  byVideoId: Map<string, SourceFeedbackRow>
): SourceFeedbackRow | null {
  return byUrl.get(ref.thumbnailUrl) ?? (ref.videoId ? byVideoId.get(ref.videoId) : null) ?? null;
}

function addReference(
  map: Map<string, ImageReference>,
  ref: ImageReference
): void {
  if (!ref.thumbnailUrl) return;
  const key = ref.videoId ?? ref.id;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, ref);
    return;
  }
  const existingMultiplier = existing.multiplier ?? 0;
  const nextMultiplier = ref.multiplier ?? 0;
  if (nextMultiplier > existingMultiplier) map.set(key, ref);
}

function readLocalVideoMeta(
  videoIds: string[],
  userChannelId: string
): Map<string, VideoMeta> {
  const out = new Map<string, VideoMeta>();
  if (videoIds.length === 0) return out;
  const placeholders = videoIds.map(() => "?").join(",");

  const ownRows = db
    .prepare(
      `SELECT v.id AS videoId, v.title, v.thumbnail_url AS thumbnailUrl,
              v.views, c.title AS channelName, c.handle AS channelHandle
       FROM videos v
       LEFT JOIN channels c ON c.id = v.channel_id
       WHERE v.id IN (${placeholders})`
    )
    .all(...videoIds) as Array<Omit<VideoMeta, "thumbnailAllowed">>;
  for (const row of ownRows) {
    out.set(row.videoId, { ...row, thumbnailAllowed: true });
  }

  const competitorRows = db
    .prepare(
      `SELECT v.video_id AS videoId, v.title, v.thumbnail_url AS thumbnailUrl,
              v.views, c.title AS channelName, c.handle AS channelHandle,
              COALESCE(c.thumbnail_policy, 'allow') AS thumbnailPolicy
       FROM competitor_videos v
       LEFT JOIN competitors c ON c.id = v.competitor_id
       WHERE v.video_id IN (${placeholders})
         AND c.user_channel_id = ?`
    )
    .all(...videoIds, userChannelId) as Array<VideoMeta & { thumbnailPolicy: string }>;
  for (const row of competitorRows) {
    const cur = out.get(row.videoId);
    if (!cur?.thumbnailUrl) {
      out.set(row.videoId, {
        videoId: row.videoId,
        title: row.title,
        channelName: row.channelName,
        channelHandle: row.channelHandle,
        thumbnailUrl: row.thumbnailUrl,
        views: row.views,
        thumbnailAllowed: row.thumbnailPolicy !== "cms_exclude",
      });
    }
  }
  return out;
}

function collectSourceRefs(
  userChannelId: string,
  sourceIdeaId: string | null,
  refs: Map<string, ImageReference>
): void {
  if (!sourceIdeaId) return;
  const row = db
    .prepare(`SELECT source_attribution FROM ideas WHERE id = ?`)
    .get(sourceIdeaId) as { source_attribution: string | null } | undefined;
  const attr = safeJson<SourceAttribution>(row?.source_attribution);
  if (!attr) return;

  const sources: Array<{
    kind: ImageReferenceKind;
    source: SourceVideo | null | undefined;
    reason: string;
  }> = [
    {
      kind: "idea_topic",
      source: attr.topic_source,
      reason: "Topic source from the selected ideation card",
    },
    {
      kind: "idea_format",
      source: attr.format_source,
      reason: "Format source from the selected ideation card",
    },
    ...(attr.topic_evidence_sources ?? []).map((source) => ({
      kind: "idea_evidence" as const,
      source,
      reason: "Extra topic evidence from the selected ideation card",
    })),
  ];
  const ids = sources
    .map((item) => item.source?.video_id)
    .filter((id): id is string => !!id);
  const localMeta = readLocalVideoMeta(ids, userChannelId);

  for (const item of sources) {
    const videoId = item.source?.video_id;
    if (!videoId) continue;
    const meta = localMeta.get(videoId);
    if (meta && !meta.thumbnailAllowed) continue;
    const thumbnailUrl = normalizeImageUrl(
      item.source?.thumbnail_url ?? meta?.thumbnailUrl
    );
    if (!thumbnailUrl) continue;
    addReference(refs, {
      id: sourceId(item.kind, videoId),
      kind: item.kind,
      videoId,
      title: item.source?.title ?? meta?.title ?? "Untitled video",
      channelName: item.source?.channel_name ?? meta?.channelName ?? null,
      channelHandle: item.source?.channel_handle ?? meta?.channelHandle ?? null,
      thumbnailUrl,
      views: item.source?.views ?? meta?.views ?? null,
      medianViews: null,
      multiplier:
        typeof item.source?.multiplier === "number"
          ? item.source.multiplier
          : null,
      reason: item.reason,
    });
  }
}

function collectOwnWinners(
  userChannelId: string,
  refs: Map<string, ImageReference>
): void {
  const channel = getChannel(userChannelId);
  for (const winner of listMyWinners(userChannelId, {
    limit: 4,
    lookbackDays: 3650,
    minMultiplier: 2,
  })) {
    const thumbnailUrl = normalizeImageUrl(winner.thumbnailUrl);
    if (!thumbnailUrl) continue;
    addReference(refs, {
      id: sourceId("channel_winner", winner.videoId),
      kind: "channel_winner",
      videoId: winner.videoId,
      title: winner.title,
      channelName: channel?.title ?? null,
      channelHandle: channel?.handle ?? null,
      thumbnailUrl,
      views: winner.views,
      medianViews: winner.channelMedian,
      multiplier: winner.multiplier,
      reason: "Winner from the active channel for style consistency",
    });
  }
}

function collectCompetitorOutliers(
  userChannelId: string,
  refs: Map<string, ImageReference>
): void {
  const rows = db
    .prepare(
      `SELECT cv.video_id, cv.title, cv.thumbnail_url, cv.views,
              c.id AS competitor_id, c.title AS channel_name, c.handle AS channel_handle
       FROM competitor_videos cv
       JOIN competitors c ON c.id = cv.competitor_id
       WHERE c.user_channel_id = ?
         AND COALESCE(c.thumbnail_policy, 'allow') != 'cms_exclude'
         AND cv.thumbnail_url IS NOT NULL
         AND cv.views > 0
         AND NOT EXISTS (
           SELECT 1 FROM competitor_video_excludes e
           WHERE e.user_channel_id = ?
             AND e.competitor_id = cv.competitor_id
             AND e.video_id = cv.video_id
         )
       ORDER BY cv.views DESC
       LIMIT 500`
    )
    .all(userChannelId, userChannelId) as Array<{
    video_id: string;
    title: string;
    thumbnail_url: string | null;
    views: number;
    competitor_id: number;
    channel_name: string | null;
    channel_handle: string | null;
  }>;

  const scored = rows
    .map((row) => {
      const median = competitorMedianViews(row.competitor_id);
      const multiplier = median > 0 ? row.views / median : 0;
      return { row, median, multiplier };
    })
    .filter((item) => item.multiplier >= 2)
    .sort((a, b) => b.multiplier - a.multiplier || b.row.views - a.row.views)
    .slice(0, 80);

  for (const item of scored) {
    const thumbnailUrl = normalizeImageUrl(item.row.thumbnail_url);
    if (!thumbnailUrl) continue;
    addReference(refs, {
      id: sourceId("competitor_outlier", item.row.video_id),
      kind: "competitor_outlier",
      videoId: item.row.video_id,
      title: item.row.title,
      channelName: item.row.channel_name,
      channelHandle: item.row.channel_handle,
      thumbnailUrl,
      views: item.row.views,
      medianViews: item.median,
      multiplier: Number(item.multiplier.toFixed(2)),
      reason:
        item.multiplier >= 3
          ? "3x+ competitor outlier"
          : "2x+ competitor outlier",
    });
  }
}

export function selectImageReferences(input: {
  userChannelId: string;
  title?: string | null;
  prompt?: string | null;
  sourceIdeaId?: string | null;
  requireMinimum?: boolean;
}): ImageReference[] {
  const refs = new Map<string, ImageReference>();
  collectSourceRefs(input.userChannelId, input.sourceIdeaId ?? null, refs);
  collectCompetitorOutliers(input.userChannelId, refs);
  collectOwnWinners(input.userChannelId, refs);

  const targetText = lowerText(`${input.title ?? ""} ${input.prompt ?? ""}`);
  const targetTokens = titleTokens(targetText);
  const feedbackRows = readSourceFeedback(input.userChannelId);
  const feedbackByUrl = new Map(feedbackRows.map((row) => [row.source_url, row]));
  const feedbackByVideoId = new Map(
    feedbackRows
      .filter((row): row is SourceFeedbackRow & { source_video_id: string } => !!row.source_video_id)
      .map((row) => [row.source_video_id, row])
  );
  const scored = [...refs.values()]
    .flatMap((ref): ImageReference[] => {
      const feedback = feedbackForRef(ref, feedbackByUrl, feedbackByVideoId);
      if (feedback?.feedback === "disliked") return [];
      const refText = lowerText(ref.title);
      const topicOverlap = overlapScore(targetTokens, titleTokens(refText));
      const semanticScore = semanticTopicScore(targetText, refText);
      const ideaSource = isIdeaSourceReference(ref);
      const multiplier = Math.min(ref.multiplier ?? 0, 40);
      const attributionBonus =
        ref.kind === "idea_topic"
          ? 90
          : ref.kind === "idea_format"
            ? 70
            : ref.kind === "idea_evidence"
              ? 50
              : 0;
      const styleBonus = ref.kind === "channel_winner" ? 110 : 0;
      const outlierBonus = ref.kind === "competitor_outlier" ? 80 : 0;
      const feedbackBonus = feedback?.feedback === "liked" ? 180 : 0;
      const genericTitleOnlyPenalty =
        topicOverlap > 0 && semanticScore < 1 && ref.kind !== "channel_winner"
          ? 70
          : 0;
      const score =
        attributionBonus +
        styleBonus +
        outlierBonus +
        feedbackBonus +
        topicOverlap * 34 +
        semanticScore * 80 +
        multiplier * 3 +
        Math.min(ref.views ?? 0, 1_000_000) / 120_000 -
        genericTitleOnlyPenalty;
      if (
        feedback?.feedback !== "liked" &&
        !ideaSource &&
        ref.kind !== "channel_winner" &&
        topicOverlap === 0 &&
        semanticScore <= 0
      ) {
        return [];
      }
      return [{
        ...ref,
        relevanceScore: Number(score.toFixed(2)),
        relevanceLabels: labelsForRef(ref, feedback, topicOverlap, semanticScore),
        feedback: feedback?.feedback ?? null,
        feedbackReason: feedback?.reason ?? null,
      }];
    });

  const sorted = scored.sort(
    (a, b) =>
      (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0) ||
      (b.multiplier ?? 0) - (a.multiplier ?? 0) ||
      (b.views ?? 0) - (a.views ?? 0)
  );
  const selected: ImageReference[] = [];
  const seen = new Set<string>();
  for (const ref of sorted) {
    const key = ref.videoId ?? ref.thumbnailUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(ref);
    if (selected.length >= (input.sourceIdeaId ? 10 : 8)) break;
  }

  if ((input.requireMinimum ?? false) && selected.length < 2) {
    throw new Error(
      "Not enough outlier thumbnails found — add/sync competitors or use an ideation card with source thumbnails"
    );
  }

  return selected;
}

export function pickPrimaryImageReference(
  references: ImageReference[]
): ImageReference | null {
  return references[0] ?? null;
}
