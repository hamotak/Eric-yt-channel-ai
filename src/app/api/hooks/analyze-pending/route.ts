import { NextResponse } from "next/server";
import {
  createHookAnalysisJob,
  getActiveChannelId,
  getActiveHookAnalysisJob,
  getHookAnalysisJobStatus,
  listVideosPendingHookAnalysis,
  updateHookAnalysisJob,
} from "@/lib/db";
import { analyzeVideoHook } from "@/lib/hook-analyzer";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * POST /api/hooks/analyze-pending
 *
 * Kick off a background hook-analysis batch over every video on the
 * active channel that has a transcript but no hook scores yet.
 *
 * Mirrors the comment-sync / transcribe-batch pattern:
 *   - Returns immediately with `{ ok, jobId, total }`.
 *   - The actual work runs in `void runBatch(...)` in this same Node
 *     process — the Hook Lab banner polls /api/hooks/jobs/latest to
 *     watch progress and surface "X / Y analysed, current: …".
 *   - User can hit Cancel at any time; the worker checks the row's
 *     status between videos and bails out cleanly.
 *
 * The previous implementation looped synchronously inside the request
 * handler. For 40+ videos at ~10s per Claude call that's well over
 * any reasonable HTTP timeout — the UI just spun "Analyzing…" with
 * no feedback and the user assumed it was broken.
 */

const HARD_MAX_BATCH = 500;
const DEFAULT_BATCH = 200;

type PostBody = {
  /** Cap the batch size if you only want to dip your toe in. */
  limit?: number;
};

export async function POST(req: Request) {
  // Refuse to stack concurrent batches — the DB writes per video would
  // happily interleave, but the user has no UI for tracking two jobs.
  const existing = getActiveHookAnalysisJob();
  if (existing) {
    return NextResponse.json(
      {
        error: "A hook-analysis batch is already running.",
        jobId: existing.id,
      },
      { status: 409 }
    );
  }

  const channelId = getActiveChannelId();
  if (!channelId) {
    return NextResponse.json(
      { error: "No active channel. Connect a channel before analysing hooks." },
      { status: 400 }
    );
  }

  let body: PostBody = {};
  try {
    const text = await req.text();
    if (text.trim()) {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") body = parsed as PostBody;
    }
  } catch {
    /* empty body is fine */
  }
  const limit = Math.min(
    HARD_MAX_BATCH,
    Math.max(1, body.limit ?? DEFAULT_BATCH)
  );

  // listVideosPendingHookAnalysis is now channel-scoped so this returns
  // only the active channel's "transcript present, no hook" videos.
  const pending = listVideosPendingHookAnalysis(limit);
  if (pending.length === 0) {
    return NextResponse.json(
      {
        error:
          "Nothing to analyse. Every video with a transcript on this channel already has hook scores.",
      },
      { status: 400 }
    );
  }

  const jobId = createHookAnalysisJob(pending.length, channelId);
  log.info("hooks", "Bulk hook analysis started", {
    jobId,
    channelId,
    videoCount: pending.length,
  });

  void runBatch(jobId, pending);

  return NextResponse.json({ ok: true, jobId, total: pending.length });
}

/**
 * Recognise Claude errors that mean "stop the batch, fix the account":
 * empty credit balance, bad API key, model-not-allowed, etc. These will
 * affect every subsequent video the same way, so there's no point
 * burning 40 round-trips to learn the same thing 40 times.
 *
 * Anthropic returns these as HTTP 400/401/403 with `error.type` of
 * `invalid_request_error`, `authentication_error`, `permission_error`,
 * or `billing_error`. analyzeVideoHook surfaces them inside the
 * `reason` string verbatim, so a substring check is the cheapest
 * reliable signal.
 */
function isFatalClaudeError(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.includes("credit balance is too low") ||
    r.includes("authentication_error") ||
    r.includes("invalid x-api-key") ||
    r.includes("permission_error") ||
    r.includes("billing_error") ||
    r.includes("invalid_request_error") ||
    // analyzeVideoHook prefixes Claude errors with "Claude call failed"
    // and the API key absence with this exact string:
    r.includes("claude api key not configured")
  );
}

async function runBatch(
  jobId: number,
  videos: Array<{ id: string; title: string }>
): Promise<void> {
  let done = 0;
  let failed = 0;
  let lastError: string | null = null;
  let abortedReason: string | null = null;

  try {
    for (const v of videos) {
      // Cancel-check between every video so a user-driven cancel takes
      // effect within one Claude call (≈5-15s) instead of running the
      // whole batch to completion.
      const status = getHookAnalysisJobStatus(jobId);
      if (status !== "running") {
        log.info("hooks", "Bulk hook analysis stopped early", {
          jobId,
          reason: status ?? "row missing",
          done,
          failed,
        });
        return;
      }

      updateHookAnalysisJob(jobId, { current_video_id: v.id });
      try {
        const r = await analyzeVideoHook(v.id);
        if (r.ok) {
          done++;
        } else {
          failed++;
          lastError = r.reason;
          // Fail-fast on fatal-by-account errors (empty credits, bad key,
          // no model access). Trying the next 39 videos won't help and
          // just spams Anthropic with 400s.
          if (isFatalClaudeError(r.reason)) {
            abortedReason = r.reason;
            break;
          }
        }
      } catch (err) {
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
        log.warn("hooks", `Batch hook analysis errored on ${v.id}: ${lastError}`, {
          jobId,
          videoId: v.id,
        });
        if (isFatalClaudeError(lastError)) {
          abortedReason = lastError;
          break;
        }
      }
      updateHookAnalysisJob(jobId, {
        done,
        failed,
        last_error: lastError,
      });
    }

    // Final status: completed if at least one succeeded, otherwise
    // failed. Aborted-by-fatal-error also lands here as failed and the
    // banner surfaces the exact Anthropic message so Eric can fix the
    // account without diving into logs.
    const finalStatus =
      abortedReason !== null
        ? "failed"
        : failed === videos.length && done === 0
          ? "failed"
          : "completed";
    updateHookAnalysisJob(jobId, {
      done,
      failed,
      status: finalStatus,
      completed_at: Math.floor(Date.now() / 1000),
      current_video_id: null,
      last_error: abortedReason ?? lastError,
    });
    log.info("hooks", "Bulk hook analysis finished", {
      jobId,
      done,
      failed,
      total: videos.length,
      aborted: abortedReason !== null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateHookAnalysisJob(jobId, {
      status: "failed",
      completed_at: Math.floor(Date.now() / 1000),
      last_error: msg,
      current_video_id: null,
    });
    log.error("hooks", `Bulk hook analysis crashed: ${msg}`, err, { jobId });
  }
}
