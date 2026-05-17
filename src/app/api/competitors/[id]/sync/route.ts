import { NextResponse } from "next/server";
import { getCompetitor, requeueCompetitor } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * POST /api/competitors/[id]/sync — re-queue ONE competitor and kick the
 * worker. Replaces the legacy inline-sync behaviour; the queued model
 * is now the single execution path so a manual "Retry" on a failed card
 * runs through the same lock as the initial-add flow.
 *
 * Returns 202 immediately; the page polls GET /api/competitors for state.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const competitorId = Number(id);
  if (!Number.isFinite(competitorId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const competitor = getCompetitor(competitorId);
  if (!competitor) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  requeueCompetitor(competitorId);

  const origin = new URL(req.url).origin;
  void fetch(`${origin}/api/competitors/sync-queued`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    cache: "no-store",
  }).catch(() => {});

  return NextResponse.json(
    { ok: true, id: competitorId, queued: true },
    { status: 202 }
  );
}
