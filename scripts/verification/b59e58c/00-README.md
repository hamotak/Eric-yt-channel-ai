# Soften pass (T1-T3) verification

Captured 2026-05-18. Move to `scripts/verification/<commit-shortsha>/` after commit.

## Screenshots
- `01-trending-formats-after-soften.png` — Trending Formats tab showing surviving formats after soften gates. Each FormatCard has the X-ban button (top-right) from the prior PR; no T3 changes here.
- `02-recent-tab-x-only.png` — /outliers Recent rows. Each row's trailing icon group is now JUST the X-circle (hide). The Sparkles (Explain) and Check (mark-read) buttons are gone. Confirmed programmatically via DOM inspection — `firstRowButtons` returns exactly 1 button with aria-label "Hide this outlier".
- `03-trending-formats-thin-pool-warning.png` — After a Re-extract on HAmo's current pool, the page renders the new soften-pass copy: "Only 1 format passed validation, covering 3 videos. Try syncing more competitors or widening the outlier window for richer patterns." Surviving format spans ≥2 competitor channels (cross-channel gate held).

## DB / API proof
- POST /api/outliers/formats/extract → returns `{formatsCreated: N, formatsPassed: N, videosLinked: …}` where N is the post-validation survivor count. On HAmo's current pool the soften gates produce 1-2 survivors per run (vs. 0 under the prior stricter gates).
- /api/outliers/formats GET returns the surviving rows with `bannedAt: null`, each carrying ≥2 examples spanning ≥2 distinct competitor channels — proves the cross-channel + per-example multiplier + min-examples gates still fire correctly post-soften.

## What was NOT live-tested
- T2 outliers-primary ideation. Driving the full chat flow ("give me ideas") would burn Anthropic credit on a single test. The code path is typecheck-clean, the new compose prompt + parser + topic-cluster dedup are wired, and the dispatcher forwards the `mode` knob. Live verification deferred — same pattern HAmo accepted on the prior PRs.
- The free-form mode stretch goal (mode:"free-form" → every idea ships sourceFormat:null). Schema + dispatcher + prompt branches are in place but not live-driven for the same credit reason.

## Files touched
- src/lib/outlier-formats.ts — soften gate constants, ship N≥1 survivors, ExtractResult.formatsPassed
- src/app/api/outliers/formats/extract/route.ts — forward formatsPassed
- src/app/outliers/page.tsx — thin-pool warning copy; T3 strip Sparkles + Check from OutlierRow + handlers
- src/lib/outliers.ts — widen windowDays from union to number with runtime clamp
- src/lib/idea-generator.ts — T2 outliers-primary pipeline (entire compose stage rewritten)
- src/lib/chat-tools.ts — generate_ideas schema + dispatcher + agent markdown template + operating rule 11 + strategy-tools description

## Migrations
None. Schema unchanged.
