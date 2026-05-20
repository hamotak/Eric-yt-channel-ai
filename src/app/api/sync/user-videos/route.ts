/**
 * POST /api/sync/user-videos
 *
 * Silent, fire-and-forget freshness pass over every locally-bound user
 * channel. Triggered from the root layout on app open and from the
 * channel switcher on switch. Caller never observes the result; we return
 * a small JSON diagnostic for ad-hoc debugging only.
 *
 * Per-channel throttle: 15 minutes since the last successful run, gated
 * by channels.last_user_videos_sync_at. Channels whose timestamp is fresh
 * are skipped without touching the YT API.
 *
 * Quota: each channel that actually runs spends 3 YT Data API units. With
 * 3 bound channels and the 15-minute throttle, worst case is ~870 units
 * per 24h — well inside the 10K daily quota.
 */

import {
  getActiveTranscriptionJob,
  getIntegration,
  getLastUserVideosSyncAt,
  listAllChannels,
} from "@/lib/db";
import { syncUserChannelVideos } from "@/lib/sync-user-videos";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

const THROTTLE_MS = 15 * 60 * 1000;

function isFresh(lastIso: string | null): boolean {
  if (!lastIso) return false;
  const ts = Date.parse(lastIso);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < THROTTLE_MS;
}

export async function POST() {
  // Don't compete with a full sync or batch transcription. Bail silently
  // — the layout/onChange callers ignore the response either way.
  if (getActiveTranscriptionJob()) {
    return Response.json({ skipped: "transcription_job_active" });
  }

  if (!getIntegration("youtube")?.api_key) {
    return Response.json({ skipped: "no_youtube_key" });
  }

  const channels = listAllChannels();
  if (channels.length === 0) {
    return Response.json({ skipped: "no_channels", results: [] });
  }

  const work = channels.map(async (c) => {
    const last = getLastUserVideosSyncAt(c.id);
    if (isFresh(last)) {
      return { channel_id: c.id, skipped: "throttled" as const, last_iso: last };
    }
    try {
      const r = await syncUserChannelVideos(c.id);
      return { ok: true as const, ...r };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("user-videos-sync", `channel ${c.id} freshness pass failed`, err);
      return { channel_id: c.id, ok: false as const, error: message };
    }
  });

  const settled = await Promise.allSettled(work);
  const results = settled.map((s) =>
    s.status === "fulfilled"
      ? s.value
      : { ok: false as const, error: String(s.reason) }
  );

  return Response.json({ results });
}
