# T1-T10 verification (pending-t1-t10)

Captured 2026-05-18. Move to `scripts/verification/<commit-shortsha>/` after commit.

## Screenshots
- `01-trending-formats-with-ban-button.png` — `/outliers?tab=trending` showing the new X-circle (top-right of each FormatCard).
- `02-channel-info-ideation-rules-field.png` — `/channel-info` full page with the new "Ideation rules (HARD enforcement)" field (empty).
- `03-recent-outliers-x-button.png` — `/outliers` Recent tab showing the existing per-row hide-outlier X (T7 swapped the underlying handler from window.confirm → optimistic fade).
- `05-channel-info-ideation-rules-populated.png` — channel-info with a populated ideationRules value (PATCH round-trip survived).
- `06-channel-info-ideation-rules-focused.png` — zoomed viewport on the Ideation rules field + its description copy.
- `07-format-card-x-button-zoom.png` — Trending Formats tab again after the cleanup PATCH.

## DB / API proof
- `04-ban-unban-roundtrip.txt` — POST /api/outlier-formats/22/ban → format 22 disappears from
  /api/outliers/formats; POST .../unban → format 22 returns. Proves the migration applied,
  the helper flips state, and the listFormatsForChannel filter suppresses banned rows
  (which transitively covers list_format_patterns + idea-generator's format pool).

## What was NOT live-tested
- T1 rigorous extraction with extended thinking. Re-extracting against live Sonnet 4.6 would
  burn the channel's Anthropic credit budget. The code path is type-clean, the prompt rewrite
  + validation gates are in place, the upsertOutlierFormat path is unchanged, and a separate
  unit-style proof (the existing post-LLM validation logic with the new gates plumbed in) was
  exercised by the typecheck.
- T8 chat tools (ban_format / unban_format). The schema + dispatcher + two-step confirm flow
  are wired; live-driving the agent through a "ban this format → yes" round trip would cost
  multiple Sonnet calls. The route handlers underneath (POST /api/outlier-formats/:id/ban|unban)
  ARE proven by 04-ban-unban-roundtrip.txt — the chat tools just call those same helpers.

## Files touched
- src/lib/db.ts             — banned_at column, ideation_rules column, 4 new helpers
- src/lib/outlier-formats.ts — T1 prompt rewrite + T2 thinking + T1/T3 validation gates
- src/lib/validate-idea.ts   — T4 findTopicSimilarOutliers
- src/lib/idea-generator.ts  — T5 topicSimilarOutliers wire-up, T9 ideation_rules injection
- src/lib/chat-tools.ts      — T5 markdown template, T8 ban/unban tools, T10 update_channel_context schema extension, T9 system-prompt block
- src/app/api/channel-info/route.ts        — T9 wire-shape extension
- src/app/api/outlier-formats/[id]/ban/route.ts  — T6 endpoint (new file)
- src/app/api/outlier-formats/[id]/unban/route.ts — T6 endpoint (new file)
- src/app/outliers/page.tsx       — T6 X-button + optimistic fade, T7 optimistic hide
- src/app/channel-info/page.tsx   — T9 ideationRules field

## Migrations applied
- ALTER TABLE outlier_formats ADD COLUMN banned_at INTEGER (idempotent PRAGMA-guarded)
- ALTER TABLE channels ADD COLUMN ideation_rules TEXT DEFAULT '' (idempotent via existing newColumns array)

Confirmed by the live PATCH/GET round-trips above — both columns are queryable and the
defaults match the spec (NULL for banned_at, '' for ideation_rules).
