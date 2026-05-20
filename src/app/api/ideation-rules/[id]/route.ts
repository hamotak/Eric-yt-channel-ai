import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * PATCH /api/ideation-rules/[id]
 * Body: { pending: 0 | 1 }
 *
 * Used by the "Apply" link on a pending learned rule (flips pending=0 so
 * the next /ideate generation will read it). The reverse direction
 * (re-pending an applied rule) is not exposed in UI but is supported for
 * completeness.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ruleId = Number(id);
  if (!Number.isFinite(ruleId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { pending?: unknown };
  if (body.pending !== 0 && body.pending !== 1) {
    return NextResponse.json(
      { error: "pending must be 0 or 1" },
      { status: 400 }
    );
  }

  const result = db
    .prepare(`UPDATE ideation_rules SET pending = ? WHERE id = ?`)
    .run(body.pending, ruleId);
  if (result.changes === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ruleId = Number(id);
  if (!Number.isFinite(ruleId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const result = db.prepare(`DELETE FROM ideation_rules WHERE id = ?`).run(ruleId);
  if (result.changes === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
