import { NextResponse } from "next/server";
import { getActiveChannelId } from "@/lib/db";
import { getFormatsForChannel } from "@/lib/outlier-formats";

export const runtime = "nodejs";

/**
 * GET /api/outliers/formats — hydrated formats for the active channel.
 * Each row carries its top 5 example videos + a 10-week histogram for
 * the tiny per-card charts. Empty array when the user hasn't extracted
 * yet — the Patterns tab renders an "Extract format patterns" CTA in
 * that case.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const explicit = url.searchParams.get("userChannelId");
  const userChannelId =
    explicit && explicit !== "all" ? explicit : getActiveChannelId();
  if (!userChannelId) {
    return NextResponse.json({ formats: [] });
  }
  const formats = getFormatsForChannel(userChannelId, 50);
  return NextResponse.json({ formats });
}
