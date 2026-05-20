import { NextResponse } from "next/server";
import {
  deleteCompetitor,
  getCompetitor,
  setCompetitorNote,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * PATCH /api/competitors/[id]
 * Body: { note: string | null }
 *
 * T2: the only field the simplified card exposes for inline edit is `note`,
 * autosaved on textarea blur. Tier + channel reassignment surfaces were
 * removed in the redesign.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const competitorId = Number(id);
  if (!Number.isFinite(competitorId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const existing = getCompetitor(competitorId);
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { note?: unknown };

  if (!("note" in body)) {
    return NextResponse.json(
      { error: "nothing to update — pass note" },
      { status: 400 }
    );
  }
  if (body.note !== null && typeof body.note !== "string") {
    return NextResponse.json(
      { error: "note must be a string or null" },
      { status: 400 }
    );
  }

  setCompetitorNote(competitorId, body.note);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const competitorId = Number(id);
  if (!Number.isFinite(competitorId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  // ON DELETE CASCADE wipes competitor_videos, competitor_alerts,
  // competitor_video_excludes and outlier_explanations referencing
  // this competitor.
  deleteCompetitor(competitorId);
  return NextResponse.json({ ok: true });
}
