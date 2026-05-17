import { NextResponse } from "next/server";
import { getActiveTranscriptionJob, updateTranscriptionJob } from "@/lib/db";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * POST /api/deepgram/jobs/cancel
 *
 * Force the currently-running Deepgram transcribe batch into the
 * "cancelled" status. Same rationale as the comment-sync cancel
 * endpoint: needed for both legitimate user-driven cancellation and
 * to unstick zombie rows left by a previous process.
 *
 * Note this does NOT abort the in-flight HTTP call to Deepgram for the
 * video the workers are currently transcribing — that call finishes
 * normally and the transcript still gets saved. Subsequent items in
 * the queue are skipped: each worker checks the job row's status
 * after every item via `updateTranscriptionJob` and bails out on a
 * non-running status. Worst case the user gets one extra transcript
 * they didn't want; budget-wise that's a fraction of a cent.
 */
export async function POST() {
  const active = getActiveTranscriptionJob();
  if (!active) {
    return NextResponse.json(
      { error: "No transcription batch is currently running." },
      { status: 404 }
    );
  }
  updateTranscriptionJob(active.id, {
    status: "cancelled",
    completed_at: Math.floor(Date.now() / 1000),
    current_video_id: null,
    last_error: "Cancelled by user from the /videos banner.",
  });
  log.info("deepgram", "Transcription batch cancelled by user", {
    jobId: active.id,
    done: active.done,
    total: active.total,
  });
  return NextResponse.json({ ok: true, jobId: active.id });
}
