import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * PATCH /api/ideas/[id]
 *
 * Mutating fields on a single idea row. All optional — any combination
 * may appear in the body. Unknown fields rejected to avoid silent typos.
 *
 *   { user_note: string | null }      — legacy free-text note (PRIO-10
 *                                       removed the UI; column stays for
 *                                       back-compat with old rows).
 *   { used: boolean }                 — PRIO-9: "I shipped this" toggle.
 *                                       true sets used_by_user=1 + used_at;
 *                                       false clears both.
 *   { feedback: "positive" | "negative" | null, reason?: string | null }
 *                                     — PRIO-10: structured feedback.
 *                                       'negative' may carry a reason; the
 *                                       reason feeds distillFeedback on the
 *                                       next generation. Setting feedback
 *                                       to null clears the trio.
 *
 * note_distilled_at is reset to NULL when feedback OR user_note changes,
 * so the next generation's distillFeedback pass re-evaluates the row.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const setClauses: string[] = [];
  const params_: unknown[] = [];
  let resetDistillStamp = false;

  if ("user_note" in body) {
    const v = body.user_note;
    if (v !== null && typeof v !== "string") {
      return NextResponse.json(
        { error: "user_note must be a string or null" },
        { status: 400 }
      );
    }
    const trimmed = typeof v === "string" ? v.trim() : null;
    setClauses.push("user_note = ?");
    params_.push(trimmed && trimmed.length > 0 ? trimmed : null);
    resetDistillStamp = true;
  }

  if ("used" in body) {
    if (typeof body.used !== "boolean") {
      return NextResponse.json(
        { error: "used must be a boolean" },
        { status: 400 }
      );
    }
    if (body.used) {
      setClauses.push("used_by_user = 1");
      setClauses.push("used_at = ?");
      params_.push(new Date().toISOString());
    } else {
      setClauses.push("used_by_user = 0");
      setClauses.push("used_at = NULL");
    }
  }

  if ("feedback" in body) {
    const f = body.feedback;
    if (f !== null && f !== "positive" && f !== "negative") {
      return NextResponse.json(
        { error: "feedback must be 'positive', 'negative', or null" },
        { status: 400 }
      );
    }
    const r = body.reason;
    if (r !== undefined && r !== null && typeof r !== "string") {
      return NextResponse.json(
        { error: "reason must be a string, null, or omitted" },
        { status: 400 }
      );
    }
    if (f === null) {
      setClauses.push("feedback = NULL");
      setClauses.push("feedback_reason = NULL");
      setClauses.push("feedback_at = NULL");
    } else {
      setClauses.push("feedback = ?");
      params_.push(f);
      const reasonText = typeof r === "string" ? r.trim() : null;
      setClauses.push("feedback_reason = ?");
      params_.push(reasonText && reasonText.length > 0 ? reasonText : null);
      setClauses.push("feedback_at = ?");
      params_.push(new Date().toISOString());
    }
    resetDistillStamp = true;
  }

  if (setClauses.length === 0) {
    return NextResponse.json(
      { error: "no recognised fields in body" },
      { status: 400 }
    );
  }
  if (resetDistillStamp) {
    setClauses.push("note_distilled_at = NULL");
  }

  const stmt = db.prepare(
    `UPDATE ideas SET ${setClauses.join(", ")} WHERE id = ?`
  );
  const result = stmt.run(...params_, id);
  if (result.changes === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
