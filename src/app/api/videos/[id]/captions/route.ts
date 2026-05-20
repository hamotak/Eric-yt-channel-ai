import { NextResponse } from "next/server";
import { getVideo, upsertTranscript } from "@/lib/db";
import { fetchTranscriptFreeWithDebug } from "@/lib/youtube";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/videos/:id/captions
 *
 * Single-tier transcript fetch via YouTube's public timedtext endpoint
 * (`fetchTranscriptFreeWithDebug`). No API keys, no Deepgram —
 * timedtext is the only path. Returns 200 + ok on success, or 404 with a
 * detailed `debug` block explaining exactly which probes were attempted
 * and what each returned, so when something fails the user (and the dev
 * console) sees the truth instead of a vague "unavailable".
 *
 * If timedtext genuinely returns nothing for a video, the only honest
 * answer is "this video does not expose captions through YouTube's CC
 * widget, period" — the same widget that powers the [CC] button on
 * every embedded video on the web.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const video = getVideo(id);
  if (!video) {
    return NextResponse.json({ error: "video not found" }, { status: 404 });
  }

  const startedAt = Date.now();
  const result = await fetchTranscriptFreeWithDebug(id);

  if (result.ok) {
    upsertTranscript(id, result.text, result.language);
    log.info("captions", "Transcript saved via timedtext", {
      videoId: id,
      language: result.language,
      textChars: result.text.length,
      probesAttempted: result.debug.probesAttempted,
      hitVia: result.debug.hitVia,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({
      ok: true,
      videoId: id,
      language: result.language,
      textLength: result.text.length,
      source: "youtube_captions",
      debug: result.debug,
    });
  }

  log.info("captions", "Timedtext returned no captions", {
    videoId: id,
    probesAttempted: result.debug.probesAttempted,
    sampleResponses: result.debug.sampleResponses,
    durationMs: Date.now() - startedAt,
  });
  return NextResponse.json(
    {
      error:
        "YouTube did not return captions for this video through any probed (language, kind) combination. See debug for raw probe results.",
      unavailable: true,
      debug: result.debug,
    },
    { status: 404 }
  );
}
