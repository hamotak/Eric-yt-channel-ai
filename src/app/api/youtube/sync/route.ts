import {
  getIntegration,
  getSetting,
  setActiveChannelId,
  setSetting,
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

export const runtime = "nodejs";

function encodeSSE(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    input?: string;
    max?: number;
  };

  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    return Response.json(
      { error: "YouTube API key is not configured. Add it in Integrations." },
      { status: 400 }
    );
  }

  // Determine what channel to sync: explicit input > saved binding
  const input = body.input?.trim() || getSetting("youtube.channelInput");
  if (!input) {
    return Response.json(
      { error: "No channel bound. Provide input (handle/URL/ID) or bind a channel first." },
      { status: 400 }
    );
  }

  const max = Math.min(5000, Math.max(1, body.max ?? 1000));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encodeSSE(event));
      const startedAt = Date.now();
      // Marks that a sync is in flight. Cleared in `finally`. Kept around
      // because other background jobs may want to check it before
      // touching shared video rows.
      setSetting("sync.inProgress", "1");
      log.info("sync", "Sync started", { input, max });
      try {
        send({ type: "status", step: "resolving", message: "Resolving channel…" });
        const ch = await resolveChannel(input, apiKey);

        // Multi-channel: we *append* this channel rather than purging the
        // previous one. The user may legitimately want analytics for several
        // channels at once and switch between them via the channel switcher.
        // Every query that consumes `videos` / `comments` is already
        // scoped through `getActiveChannelId()`, so cross-channel bleed
        // isn't possible.
        const previousChannelId = getSetting("youtube.channelId");
        const newBinding = previousChannelId !== ch.id;
        if (newBinding) {
          log.info("sync", "Active channel changed (appended, no purge)", {
            previousChannelId,
            newChannelId: ch.id,
          });
        }

        // Persist binding + channel row. `channelInput` is recorded
        // per-channel so re-syncs of any channel can recover the original
        // user input (handle/URL/ID); the legacy `youtube.channelInput` is
        // updated to the active channel's input so older code paths keep
        // working.
        setSetting("youtube.channelInput", input);
        setSetting(`youtube.channelInput.${ch.id}`, input);
        setActiveChannelId(ch.id);
        upsertChannel({
          id: ch.id,
          title: ch.title,
          handle: ch.handle,
          description: ch.description,
          subscriber_count: ch.subscribers,
          view_count: ch.views,
          video_count: ch.videoCount,
        });
        send({
          type: "channel",
          channel: {
            id: ch.id,
            title: ch.title,
            handle: ch.handle,
            subscribers: ch.subscribers,
            views: ch.views,
            videoCount: ch.videoCount,
            thumbnail: ch.thumbnail,
          },
        });

        send({ type: "status", step: "listing", message: "Listing uploads…" });
        const ids = await listUploadIds(ch.uploadsPlaylistId, apiKey, {
          max,
          onPage: (n) => send({ type: "progress", phase: "listing", count: n }),
        });
        send({ type: "status", step: "listed", total: ids.length });

        send({ type: "status", step: "fetching", message: "Fetching video details…" });
        let saved = 0;
        const videos = await fetchVideos(ids, apiKey, {
          onBatch: (done) =>
            send({ type: "progress", phase: "fetching", count: done, total: ids.length }),
        });

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
          saved++;
        }

        send({
          type: "done",
          saved,
          total: ids.length,
        });
        log.info("sync", "Sync completed", {
          channelId: ch.id,
          videosSaved: saved,
          idsListed: ids.length,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        const status = err instanceof YouTubeApiError ? err.status : 500;
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ type: "error", status, message });
        log.error("sync", `Sync failed: ${message}`, err, {
          input,
          status,
          durationMs: Date.now() - startedAt,
        });
      } finally {
        // Always clear the sync flag, success or error.
        setSetting("sync.inProgress", "0");
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function GET() {
  const input = getSetting("youtube.channelInput");
  const id = getSetting("youtube.channelId");
  return Response.json({ bound: !!id, input, channelId: id });
}
