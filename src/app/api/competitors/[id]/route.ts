import { NextResponse } from "next/server";
import {
  deleteCompetitor,
  getCompetitor,
  setCompetitorThumbnailPolicy,
  setCompetitorNote,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * PATCH /api/competitors/[id]
 * Body: { note?: string | null, thumbnailPolicy?: "allow"|"cms_exclude",
 *         thumbnailPolicyNote?: string | null }
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

  const body = (await req.json().catch(() => ({}))) as {
    note?: unknown;
    thumbnailPolicy?: unknown;
    thumbnailPolicyNote?: unknown;
  };

  if (!("note" in body) && !("thumbnailPolicy" in body)) {
    return NextResponse.json(
      { error: "nothing to update — pass note or thumbnailPolicy" },
      { status: 400 }
    );
  }
  if ("note" in body && body.note !== null && typeof body.note !== "string") {
    return NextResponse.json(
      { error: "note must be a string or null" },
      { status: 400 }
    );
  }
  if (
    "thumbnailPolicy" in body &&
    body.thumbnailPolicy !== "allow" &&
    body.thumbnailPolicy !== "cms_exclude"
  ) {
    return NextResponse.json(
      { error: "thumbnailPolicy must be allow or cms_exclude" },
      { status: 400 }
    );
  }
  if (
    "thumbnailPolicyNote" in body &&
    body.thumbnailPolicyNote !== null &&
    typeof body.thumbnailPolicyNote !== "string"
  ) {
    return NextResponse.json(
      { error: "thumbnailPolicyNote must be a string or null" },
      { status: 400 }
    );
  }

  if ("note" in body) {
    setCompetitorNote(
      competitorId,
      typeof body.note === "string" ? body.note : null
    );
  }
  if (body.thumbnailPolicy === "allow" || body.thumbnailPolicy === "cms_exclude") {
    setCompetitorThumbnailPolicy(competitorId, {
      thumbnail_policy: body.thumbnailPolicy,
      thumbnail_policy_note:
        typeof body.thumbnailPolicyNote === "string"
          ? body.thumbnailPolicyNote
          : body.thumbnailPolicyNote === null
            ? null
            : existing.thumbnail_policy_note,
    });
  }
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
  // ON DELETE CASCADE wipes competitor_videos and
  // competitor_video_excludes referencing this competitor.
  deleteCompetitor(competitorId);
  return NextResponse.json({ ok: true });
}
