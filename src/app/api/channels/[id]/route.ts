import { NextResponse } from "next/server";
import { ChannelMeta, removeChannel, updateChannelMeta } from "@/lib/db";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Delete a single channel and every video / comment / cache row that
 * scoped to it. Used by the multi-channel binder when the user removes
 * a channel from the list.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "Missing channel id" }, { status: 400 });
  }
  const result = removeChannel(id);
  return NextResponse.json({ ok: true, ...result });
}

/**
 * Update user-managed metadata for the channel: editor_name,
 * cms_name, cms_cut_percent, adsense_name, monetization_status,
 * notes. Each field is optional — only what's in the body gets
 * touched. Pass `null` to clear a field explicitly.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "Missing channel id" }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as Partial<ChannelMeta>;

  // Lightweight validation. Empty strings → null so the DB stays clean.
  const patch: ChannelMeta = {};
  if ("editor_name" in body) patch.editor_name = nullifyEmpty(body.editor_name);
  if ("cms_name" in body) patch.cms_name = nullifyEmpty(body.cms_name);
  if ("adsense_name" in body) patch.adsense_name = nullifyEmpty(body.adsense_name);
  if ("notes" in body) patch.notes = nullifyEmpty(body.notes);
  if ("cms_cut_percent" in body) {
    const v = body.cms_cut_percent;
    if (v === null || v === undefined) patch.cms_cut_percent = null;
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) {
      patch.cms_cut_percent = v;
    } else {
      return NextResponse.json(
        { error: "cms_cut_percent must be a number between 0 and 100" },
        { status: 400 }
      );
    }
  }
  if ("monetization_status" in body) {
    const v = body.monetization_status;
    if (v === null || v === undefined) {
      patch.monetization_status = null;
    } else if (v === "monetized" || v === "pending" || v === "not_eligible") {
      patch.monetization_status = v;
    } else {
      return NextResponse.json(
        { error: "monetization_status must be one of: monetized, pending, not_eligible" },
        { status: 400 }
      );
    }
  }
  if ("expected_videos_per_month" in body) {
    const v = body.expected_videos_per_month;
    if (v === null || v === undefined) {
      patch.expected_videos_per_month = null;
    } else if (
      typeof v === "number" &&
      Number.isFinite(v) &&
      v >= 0 &&
      v <= 1000
    ) {
      patch.expected_videos_per_month = Math.round(v);
    } else {
      return NextResponse.json(
        { error: "expected_videos_per_month must be a non-negative integer ≤ 1000" },
        { status: 400 }
      );
    }
  }

  updateChannelMeta(id, patch);
  return NextResponse.json({ ok: true, id, patch });
}

function nullifyEmpty(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}
