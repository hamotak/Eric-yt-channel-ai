/**
 * Silent freshness pass for a single user-bound channel.
 *
 * Pulls the most recent slice of uploads from YouTube and upserts them into
 * the `videos` table so the /videos page surfaces newly published rows
 * without the user pressing "Re-sync". Deliberately small: at most
 * three YT Data API calls per channel per invocation, capped at the 50
 * newest uploads. The full re-sync path at /api/youtube/sync is unchanged
 * and remains the way to do a 1000+ video deep pull.
 *
 *   1. channels.list (1 unit) — fetches uploadsPlaylistId + fresh stats
 *   2. playlistItems.list (1 unit) — first page, 50 ids
 *   3. videos.list (1 unit) — batched metadata for those 50 ids
 *
 * Throttling lives in the API route, not here — this function always
 * executes when called.
 */

import {
  getIntegration,
  setLastUserVideosSyncAt,
  upsertChannel,
  upsertVideo,
} from "@/lib/db";
import {
  fetchVideos,
  listUploadIds,
  resolveChannel,
  YouTubeApiError,
} from "@/lib/youtube";
import { log } from "@/lib/logger";

export type SyncUserVideosResult = {
  channel_id: string;
  fetched: number;
  upserted: number;
  duration_ms: number;
};

const RECENT_SLICE = 50;

export async function syncUserChannelVideos(
  channelId: string
): Promise<SyncUserVideosResult> {
  const started = Date.now();

  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    throw new YouTubeApiError("YouTube API key is not configured", 400);
  }
  if (!channelId) {
    throw new YouTubeApiError("missing channelId", 400);
  }

  // Call #1 — channels.list (resolveChannel accepts a raw UC... id and
  // returns updated stats + uploadsPlaylistId).
  const ch = await resolveChannel(channelId, apiKey);
  upsertChannel({
    id: ch.id,
    title: ch.title,
    handle: ch.handle,
    description: ch.description,
    subscriber_count: ch.subscribers,
    view_count: ch.views,
    video_count: ch.videoCount,
    avatar_url: ch.thumbnail,
  });

  // Call #2 — playlistItems.list, first page only (max=50 keeps it to
  // exactly one HTTP request).
  const ids = await listUploadIds(ch.uploadsPlaylistId, apiKey, {
    max: RECENT_SLICE,
  });

  // Call #3 — videos.list, single batch (ids.length ≤ 50, the per-call
  // limit of the underlying helper).
  const videos = ids.length ? await fetchVideos(ids, apiKey) : [];

  for (const v of videos) {
    upsertVideo({
      id: v.id,
      channel_id: v.channelId,
      title: v.title,
      description: v.description,
      published_at: v.publishedAt,
      duration_seconds: v.durationSeconds,
      views: v.views,
      likes: v.likes,
      comments: v.comments,
      thumbnail_url: v.thumbnail,
      tags: v.tags.length ? JSON.stringify(v.tags) : null,
    });
  }

  const nowIso = new Date().toISOString();
  setLastUserVideosSyncAt(ch.id, nowIso);

  const result: SyncUserVideosResult = {
    channel_id: ch.id,
    fetched: ids.length,
    upserted: videos.length,
    duration_ms: Date.now() - started,
  };
  log.info("user-videos-sync", "Silent freshness pass complete", result);
  return result;
}
