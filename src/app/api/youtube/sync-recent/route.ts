import { NextResponse } from "next/server";
import {
  db,
  getIntegration,
  listAllChannels,
  upsertVideo,
} from "@/lib/db";
import {
  fetchVideos,
  listUploadIds,
  resolveChannel,
} from "@/lib/youtube";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
// Resolving + listing + fetching across many channels can run a while.
// Per-channel each step is fast (3 API calls of ~150-500ms), and we
// run them in parallel, but the worst case still wants headroom.
export const maxDuration = 180;

/**
 * Lightweight "sync recent uploads" across every connected channel.
 *
 * Why this exists: editor billing counts videos by `published_at`
 * matching the current calendar month. Those rows only exist in the
 * local DB after a manual /api/youtube/sync run per channel. With
 * 30+ channels nobody clicks Sync that often, so the editor billing
 * card shows stale counts ("6 videos this month" when the editor
 * actually shipped 12).
 *
 * This endpoint pulls just the latest 50 video IDs from each
 * channel's uploads playlist, fetches details only for the IDs that
 * aren't already in our DB, and upserts them. Cheap: 3 YouTube Data
 * API calls per channel = ~90 units for 30 channels (out of the
 * 10,000/day free quota).
 *
 * Runs every channel in parallel. Errors on one channel don't poison
 * the rest; the response payload reports per-channel outcomes so the
 * UI can surface which channels failed if any.
 */

const RECENT_VIDEO_LIMIT = 50;

type ChannelResult = {
  channelId: string;
  title: string | null;
  addedVideos: number;
  totalSeen: number;
  error?: string;
};

export async function POST() {
  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "YouTube API key is not configured. Add it in Integrations." },
      { status: 400 }
    );
  }

  const channels = listAllChannels();
  if (channels.length === 0) {
    return NextResponse.json({
      error: "No channels connected — add one on /integrations first.",
    }, { status: 400 });
  }

  log.info("sync-recent", "Recent-uploads sync started", {
    channelCount: channels.length,
  });

  // Prepared statement for the "is this video already in our DB?"
  // check. Stays cheap — we hit it 50× per channel.
  const existsStmt = db.prepare(`SELECT 1 FROM videos WHERE id = ?`);

  const results = await Promise.all(
    channels.map(async (channel): Promise<ChannelResult> => {
      try {
        // Step 1: resolve channel to get its uploads playlist id.
        // resolveChannel accepts a channel id directly and returns
        // metadata including uploadsPlaylistId.
        const resolved = await resolveChannel(channel.id, apiKey);
        // Step 2: list recent N video ids. listUploadIds returns the
        // playlist's newest-first, so the first 50 = the latest 50.
        const ids = await listUploadIds(resolved.uploadsPlaylistId, apiKey, {
          max: RECENT_VIDEO_LIMIT,
        });
        // Step 3: filter to only new ids — saves an API call when the
        // editor hasn't uploaded since last sync.
        const newIds = ids.filter((id) => !existsStmt.get(id));
        if (newIds.length === 0) {
          return {
            channelId: channel.id,
            title: channel.title,
            addedVideos: 0,
            totalSeen: ids.length,
          };
        }
        // Step 4: fetch details for the new ids and upsert.
        const videos = await fetchVideos(newIds, apiKey);
        for (const v of videos) {
          upsertVideo({
            id: v.id,
            channel_id: channel.id,
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
        return {
          channelId: channel.id,
          title: channel.title,
          addedVideos: videos.length,
          totalSeen: ids.length,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("sync-recent", `Channel sync failed: ${channel.id}`, {
          channelId: channel.id,
          error: message,
        });
        return {
          channelId: channel.id,
          title: channel.title,
          addedVideos: 0,
          totalSeen: 0,
          error: message,
        };
      }
    })
  );

  const totalAdded = results.reduce((s, r) => s + r.addedVideos, 0);
  const failed = results.filter((r) => r.error).length;
  log.info("sync-recent", "Recent-uploads sync finished", {
    channelCount: channels.length,
    totalAdded,
    failed,
  });

  return NextResponse.json({
    ok: true,
    channels: results,
    totalAdded,
    failed,
  });
}
