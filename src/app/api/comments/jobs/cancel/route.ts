import { NextResponse } from "next/server";
import { getActiveCommentSyncJob, updateCommentSyncJob } from "@/lib/db";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * POST /api/comments/jobs/cancel
 *
 * Force the currently-running comment-sync job into "cancelled" state.
 *
 * Used by the banner's Cancel button when the user knows a job is stuck —
 * typically because the previous process was killed mid-batch. The
 * in-process worker (if any is still running on this server) will
 * notice on its next progress-flush that the row's status changed and
 * abandon further work; if no worker exists at all (zombie row from a
 * previous process), this simply releases the lock so the user can
 * start a fresh batch.
 */
export async function POST() {
  const active = getActiveCommentSyncJob();
  if (!active) {
    return NextResponse.json(
      { error: "No comment-sync job is currently running." },
      { status: 404 }
    );
  }
  updateCommentSyncJob(active.id, {
    status: "cancelled",
    completed_at: Math.floor(Date.now() / 1000),
    current_video_id: null,
    last_error: "Cancelled by user from the /videos banner.",
  });
  log.info("comments-sync", "Comment-sync job cancelled by user", {
    jobId: active.id,
    done: active.done,
    total: active.total,
  });
  return NextResponse.json({ ok: true, jobId: active.id });
}
