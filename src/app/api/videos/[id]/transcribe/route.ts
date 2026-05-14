import { NextResponse } from "next/server";
import {
  getActiveTranscriptionJob,
  getIntegration,
  getSetting,
  getTranscript,
  getVideo,
  recordDeepgramUsage,
  upsertTranscript,
} from "@/lib/db";
import { transcribeYouTubeVideo, DeepgramError, AudioUrlError } from "@/lib/deepgram";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
// Transcribing a 1-hour video through Deepgram can take a minute even in
// their cloud — plus URL resolution + network. Give it room.
export const maxDuration = 300;

/**
 * POST /api/videos/:id/transcribe
 *
 * Force-transcribes a single video via Deepgram. Overwrites any existing
 * transcript — the user is explicitly asking for a re-transcription.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Outer try/catch is the safety net — if ANYTHING throws before our
  // inner catch (e.g. params await fails, getVideo throws, the logger
  // itself blows up), we still return JSON with a usable error message
  // instead of a bare HTTP 500 + empty body that the UI can't render.
  try {
    const { id } = await params;
    const video = getVideo(id);
    if (!video) {
      return NextResponse.json({ error: "video not found" }, { status: 404 });
    }

    const apiKey = getIntegration("deepgram")?.api_key;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Deepgram API key is not configured. Add it in Integrations." },
        { status: 400 }
      );
    }

    // Mutual exclusion against the batch transcribe job + the channel sync.
    // A batch processes many videos with concurrency=3 — adding a 4th
    // single-video request can race the same `transcripts` rows and corrupt
    // FTS / break the batch's progress accounting. A sync may be deleting
    // the very video we're about to write a transcript for. Block both.
    const activeJob = getActiveTranscriptionJob();
    if (activeJob) {
      return NextResponse.json(
        {
          error:
            "A batch transcription is currently running. Wait for it to finish before transcribing a single video — they share the same Deepgram quota and database tables.",
          jobId: activeJob.id,
        },
        { status: 409 }
      );
    }
    if (getSetting("sync.inProgress") === "1") {
      return NextResponse.json(
        {
          error:
            "A channel sync is currently running. Try again in a few seconds — videos may be moved or deleted while the sync runs.",
        },
        { status: 409 }
      );
    }

    const startedAt = Date.now();
    try {
      const result = await transcribeYouTubeVideo(id, apiKey);
      upsertTranscript(id, result.text, result.language);
      recordDeepgramUsage({
        videoId: id,
        durationSeconds: result.durationSeconds,
        costCents: result.costCents,
        model: result.model,
      });
      log.info("deepgram", "Video transcribed", {
        videoId: id,
        durationSeconds: result.durationSeconds,
        costCents: result.costCents,
        language: result.language,
        textChars: result.text.length,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json({
        ok: true,
        videoId: id,
        durationSeconds: result.durationSeconds,
        costCents: result.costCents,
        language: result.language,
        textLength: result.text.length,
      });
    } catch (err) {
      const status =
        err instanceof DeepgramError ? err.status : err instanceof AudioUrlError ? 422 : 500;
      const message = err instanceof Error ? err.message : "Unknown error";
      // log.error wrapped in its own try so a logger failure can't
      // bubble out and starve the user of an error response.
      try {
        log.error("deepgram", `Transcription failed: ${message}`, err, { videoId: id });
      } catch {
        /* logger blew up — nothing actionable here */
      }
      return NextResponse.json({ error: message }, { status });
    }
  } catch (outerErr) {
    const message =
      outerErr instanceof Error ? outerErr.message : String(outerErr);
    // Last-resort response. Try to log but don't let it throw further.
    try {
      console.error("[transcribe route] unhandled error:", outerErr);
    } catch {
      /* nothing */
    }
    return NextResponse.json(
      { error: `Unhandled server error during transcribe: ${message}` },
      { status: 500 }
    );
  }
}

/** GET — return whether this video already has a transcript (for the UI). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const t = getTranscript(id);
  return NextResponse.json({
    hasTranscript: !!t,
    language: t?.language ?? null,
    chars: t?.text.length ?? 0,
  });
}
