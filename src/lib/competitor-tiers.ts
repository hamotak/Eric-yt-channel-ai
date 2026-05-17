// Shared vocabulary for the four competitor tiers from MENTOR_METHOD.md §1.
// Lifted out of competitors/page.tsx (and the mirrors in competitors/[id]
// + outliers/page.tsx) so a single edit propagates everywhere — and so the
// tier-tooltip strings live in exactly one place.

export const TIERS = ["authority", "breakthrough", "adjacent", "far"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABEL: Record<Tier, string> = {
  authority: "Authority",
  breakthrough: "Breakthrough",
  adjacent: "Adjacent",
  far: "Far",
};

// Pill colors. Authority = blue (established), Breakthrough = green
// (currently winning), Adjacent = orange (related niche), Far = grey
// (unrelated audience).
export const TIER_PILL: Record<Tier, string> = {
  authority:
    "bg-sky-500/15 text-sky-700 dark:text-sky-400 border border-sky-500/30",
  breakthrough:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30",
  adjacent:
    "bg-orange-500/15 text-orange-700 dark:text-orange-400 border border-orange-500/30",
  far: "bg-muted text-muted-foreground border border-border",
};

// Strategic meaning per tier — rendered via the native `title=""` attribute
// on every tier badge across the app. Plain HTML tooltip is the MVP fallback
// because no shadcn Tooltip primitive exists yet.
export const TIER_TOOLTIP: Record<Tier, string> = {
  authority:
    "Big established competitor. Source for topic ideas. Don't copy thumbnails 1:1 — same audience.",
  breakthrough:
    "Newer channel currently blowing up. Most predictive of what's working RIGHT NOW.",
  adjacent:
    "Related niche with partial audience overlap. Good for format inspiration with slight twist.",
  far: "Unrelated niche, zero audience overlap. Safe source for thumbnail steals (90/10 rule).",
};
