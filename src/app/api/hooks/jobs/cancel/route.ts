import { NextResponse } from "next/server";
import { getActiveHookAnalysisJob, updateHookAnalysisJob } from "@/lib/db";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * POST /api/hooks/jobs/cancel
 *
 * Force the currently-running hook-analysis batch into "cancelled".
 *
 * The worker checks status between every video, so a fresh cancel
 * stops further work within one Claude call. The video already
 * mid-flight finishes its Claude request and persists normally —
 * that's a fraction of a cent and not worth aborting the HTTP call.
 *
 * Also acts as the "unstick zombie row" button: if the previous
 * process died mid-batch and the DB row is still 'running' (despite
 * boot-cleanup, in case the server hasn't been restarted), this
 * flips it so the user can start a fresh batch.
 */
export async function POST() {
  const active = getActiveHookAnalysisJob();
  if (!active) {
    return NextResponse.json(
      { error: "No hook-analysis batch is currently running." },
      { status: 404 }
    );
  }
  updateHookAnalysisJob(active.id, {
    status: "cancelled",
    completed_at: Math.floor(Date.now() / 1000),
    current_video_id: null,
    last_error: "Cancelled by user from the Hook Lab banner.",
  });
  log.info("hooks", "Hook-analysis batch cancelled by user", {
    jobId: active.id,
    done: active.done,
    total: active.total,
  });
  return NextResponse.json({ ok: true, jobId: active.id });
}
