import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * PATCH /api/ideas/[id]
 * Body: { user_note: string | null }
 *
 * Autosaved by the "My note" textarea on each idea card. Setting the note
 * to null clears it. note_distilled_at is left alone — distillFeedback
 * (run at the start of the NEXT generation) will pick up the row and
 * stamp it after producing a rule proposal.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as { user_note?: unknown };
  if (!("user_note" in body)) {
    return NextResponse.json(
      { error: "user_note required (string or null)" },
      { status: 400 }
    );
  }
  if (body.user_note !== null && typeof body.user_note !== "string") {
    return NextResponse.json(
      { error: "user_note must be a string or null" },
      { status: 400 }
    );
  }
  const trimmed =
    typeof body.user_note === "string" ? body.user_note.trim() : null;
  const result = db
    .prepare(
      `UPDATE ideas SET user_note = ?, note_distilled_at = NULL WHERE id = ?`
    )
    .run(trimmed && trimmed.length > 0 ? trimmed : null, id);
  if (result.changes === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
