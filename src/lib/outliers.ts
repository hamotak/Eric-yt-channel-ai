import "server-only";
import {
  COMPETITOR_TIERS,
  getActiveChannelId,
  type OutlierRow,
  outliersForUserChannel,
} from "./db";

/**
 * Single source of truth for "the outliers visible to the user right now".
 * Used by:
 *   - GET /api/outliers (the Library tab on /outliers)
 *   - list_outliers chat tool (the central ideation agent in /chat)
 *
 * Defaults to the unfiltered view: scope to the active channel, last
 * 30-day window, all tiers, multiplier ≥ 3 (per MENTOR_METHOD §2). The
 * underlying SQL helper in db.ts already enforces "needs ≥ 5 videos in
 * the window" for statistical sanity.
 *
 * No window/multiplier/tier pills on /outliers anymore — that nuance
 * lives in the chat agent. Callers can still pass overrides when they
 * really need them (e.g. the formats extraction wants more videos).
 */
export type ListOutliersOptions = {
  userChannelId?: string | null; // null = across all user channels; undefined = active
  windowDays?: 7 | 30 | 90;
  minMultiplier?: number;
  tiers?: readonly string[];
  limit?: number;
  competitorId?: number | null; // narrow to a single competitor — used by /competitors/[id]
};

export function listOutliersForActiveChannel(
  opts: ListOutliersOptions = {}
): { outliers: OutlierRow[]; totalScanned: number; competitorsCovered: number } {
  const userChannelId =
    opts.userChannelId === undefined
      ? (getActiveChannelId() ?? null)
      : opts.userChannelId;

  return outliersForUserChannel({
    userChannelId,
    windowDays: opts.windowDays ?? 30,
    minMultiplier: opts.minMultiplier ?? 3,
    tiers: opts.tiers ?? [...COMPETITOR_TIERS],
    limit: opts.limit ?? 50,
    competitorId: opts.competitorId ?? null,
  });
}
