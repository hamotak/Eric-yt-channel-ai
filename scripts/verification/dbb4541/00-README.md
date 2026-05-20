# Memory removal + About removal + ideation viral×viral + web_search verification

Captured 2026-05-18. Move to `scripts/verification/<commit-shortsha>/` after commit.

## Screenshots
- `01-channel-info-no-memory-no-about.png` — /channel-info renders only Channel description + Ideation rules + Save. No "Agent memory" header, no "About / Description as it appears on YouTube" card. Migration-populated description visible.
- `02-chat-brain-panel-no-memory.png` — /chat Brain panel right-side aside shows Description + Ideation rules (HARD) ONLY. No Memory section.
- `03-trending-formats-single-channel-badge.png` — /outliers Trending Formats with a surviving format flagged "author pattern" (single-channel fallback was used). Badge visible next to the template line.

## DB / API proofs

### Format-extraction diagnostics
Live re-extract returned the new structured shape:
```
{
  formatsCreated: 1, videosLinked: 2, formatsPassed: 1,
  dropCounts: {
    slot_count: 0, literal_anchor: 1, per_example_multiplier: 0,
    min_examples: 0, avg_multiplier: 0, cross_channel: 0,
    lexical_overlap: 1
  },
  topDropReason: { gate: "literal_anchor", count: 1 },
  fallbackUsed: true
}
```
app_logs row:
```
2026-05-18 07:58:41 info claude [diag] format_extraction channel=UCIqH5kGFOM_lP9x_AmPodjQ:
  candidates=2, dropped_by_slot_count=0, dropped_by_literal_anchor=1,
  dropped_by_per_example_multiplier=0, dropped_by_min_examples=0,
  dropped_by_avg_multiplier=0, dropped_by_cross_channel=0,
  dropped_by_lexical_overlap=1, survivors=1 (FALLBACK single-channel)
```

### isSingleChannel round-trip
GET /api/outliers/formats returns the surviving format with isSingleChannel: true. UI badges "author pattern" (verified screenshot 03).

### System prompt size
```
2026-05-18 08:01:24 info chat [diag] system prompt: 7688 chars (~1922 tokens)
```
Up slightly from 7488 (prior PR baseline) because operating rule 15 was added (+260 chars) and the tool list grew by one entry. Persistent-facts block removal recovered ~200 chars in the other direction. Still well under the 8000 budget.

### Memory removal proofs
- save_channel_memory + forget_channel_memory deleted from STRATEGY_TOOLS / IDEATION_TOOLS array and dispatcher.
- /api/channel-info/memory route directory deleted.
- AgentMemoryPanel removed from agent-brain-editors.tsx exports.
- buildSystemPrompt: "## Persistent facts" block deleted. The legacy banned_topics channel_memory row is still read (defense-in-depth; ideation_rules is the new writer path).

## What was NOT live-driven
- Acceptance test 4 (full live ideation with web_search trigger). Live chat call would burn Anthropic + Exa credit on a single test. The code paths are typecheck-clean and the dispatcher handles web_search via `exaSearch` (same helper /lib/exa.ts:17 has always exported). Acceptance test 5 (force web_search via a niche-outside-tracked-competitors prompt) likewise deferred — operating rule 15 documents the trigger.
- Acceptance test 4's anchor enforcement is exercised by reading the dispatcher path: every idea routed through `mapped → ideas` is now gated by `hasFormatAnchor || hasTopicAnchor` with `reason:"no_anchor"` drops surfacing in `result.dropped[]`.

## Files touched
- src/lib/db.ts — outlier_formats.is_single_channel column (idempotent ADD COLUMN), threaded through OutlierFormat type + listFormatsForChannel + getOutlierFormatById + findOutlierFormatsByTemplateMatch + upsertOutlierFormat (new isSingleChannel param).
- src/lib/outlier-formats.ts — ExtractResult extended with dropCounts/topDropReason/fallbackUsed + DROP_REASON_LABEL. validateAndDedupFormats now returns { formats, dropCounts } + accepts minDistinctCompetitors override. extractFormatsFromOutliers runs primary pass → relaxed fallback when survivors === 0 → structured [diag] log line → marks is_single_channel on fallback survivors at upsert.
- src/app/api/outliers/formats/extract/route.ts — forwards new fields to client.
- src/app/outliers/page.tsx — FormatRow.isSingleChannel + "author pattern" badge on FormatCard + toast wording cites topDropReason + fallback note.
- src/lib/chat-tools.ts — removed save/forget_channel_memory tool defs + dispatcher cases + agent-instructions references. Removed "## Persistent facts" system-prompt block. Added web_search tool def + dispatcher + operating rule 15. list_format_patterns chat tool now surfaces id + isSingleChannel. generate_ideas tool description rewritten with viral_format × viral_topic anchor rule + new two-line "Top viral formats / Top viral topics" pattern-research block + Format/Same-topic conditional omissions per T6.
- src/lib/idea-generator.ts — DroppedIdea adds "no_anchor". Post-LLM gate enforces ≥1 anchor (sourceFormat OR ≥2 cross-channel topicSimilarOutliers with multiplier ≥3). Compose-prompt "Hard rules" updated with the ANCHOR RULE.
- src/components/agent-brain-editors.tsx — AgentMemoryPanel deleted (~280 LOC). Module jsdoc updated. Unused Check/X icons trimmed.
- src/app/channel-info/page.tsx — AgentMemoryPanel mount + AboutCard mount + their imports removed.
- src/app/chat/page.tsx — AgentMemoryPanel import + Brain-panel mount + AgentMemoryPanel-section JSX removed.
- src/app/api/channel-info/memory/ — entire directory deleted.

## Migrations
1 migration: outlier_formats.is_single_channel INTEGER NOT NULL DEFAULT 0 (idempotent ADD COLUMN). Schema for channel_memory and legacy fields untouched.
