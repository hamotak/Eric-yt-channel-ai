import { NextResponse } from "next/server";
import {
  COMPETITOR_TIERS,
  isCompetitorTier,
  listAllChannels,
} from "@/lib/db";
import { listOutliersForActiveChannel } from "@/lib/outliers";

export const runtime = "nodejs";

/**
 * GET /api/outliers
 *
 * Thin wrapper over the shared `listOutliersForActiveChannel` helper —
 * the same function the list_outliers chat tool calls. Filter pills on
 * the /outliers page were removed in this refactor; the Library tab
 * passes only `?userChannelId=` (or omits for the active channel) and
 * gets the unfiltered top 50.
 *
 * Optional overrides preserved for legacy callers (chat tools that want
 * a tighter window/multiplier) — pass `?window=` / `?minMultiplier=` /
 * `?tiers=` to opt in. Default behaviour: 30d window, 3× multiplier,
 * all tiers (per MENTOR_METHOD §2 baseline).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawUserChannelId = url.searchParams.get("userChannelId");
  let userChannelId: string | null | undefined;
  if (!rawUserChannelId || rawUserChannelId === "all") {
    userChannelId = null;
  } else {
    const all = listAllChannels();
    if (!all.some((c) => c.id === rawUserChannelId)) {
      return NextResponse.json(
        { error: `Unknown userChannelId: ${rawUserChannelId}` },
        { status: 400 }
      );
    }
    userChannelId = rawUserChannelId;
  }

  const windowParam = Number(url.searchParams.get("window") ?? 30);
  const windowDays =
    windowParam === 7 || windowParam === 30 || windowParam === 90
      ? windowParam
      : 30;

  const multiplierParam = Number(url.searchParams.get("minMultiplier") ?? 3);
  const minMultiplier =
    Number.isFinite(multiplierParam) && multiplierParam >= 1
      ? multiplierParam
      : 3;

  const tiersParam = url.searchParams.get("tiers");
  const tiers = tiersParam
    ? tiersParam.split(",").map((s) => s.trim()).filter(isCompetitorTier)
    : [...COMPETITOR_TIERS];
  if (tiers.length === 0) {
    return NextResponse.json(
      {
        error: `tiers must include at least one of: ${COMPETITOR_TIERS.join(", ")}`,
      },
      { status: 400 }
    );
  }

  const result = listOutliersForActiveChannel({
    userChannelId,
    windowDays,
    minMultiplier,
    tiers,
  });

  return NextResponse.json(result);
}
