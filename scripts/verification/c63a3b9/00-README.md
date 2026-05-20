# Channel description redesign + Brain panel verification

Captured 2026-05-18. Move to `scripts/verification/<commit-shortsha>/` after commit.

## Screenshots
- `01-channel-info-two-fields.png` — /channel-info renders just two textareas (Channel description + Ideation rules) + Agent memory panel. No Niche/Positioning/Audience/Voice/External-sources fields.
- `02-chat-brain-panel-open.png` — /chat with the Brain toggle clicked. Right-side aside shows Description (preview mode with Edit button), Ideation rules (HARD), Memory section. Toggle button highlighted primary.

## Migration proof (live DB via /api/channel-info GET)
- Late Science: channel_description = 1404 chars (concatenated from niche + positioning + audience + voice + external_sources).
- Earth Radar: channel_description = 1482 chars (same migration path).
- The Sleeping Orbit: channel_description = 0 chars (no legacy data → migration skipped, correct).
- ideation_rules preserved verbatim (Late Science: 978 chars).
- Flag `channels.description_migrated_v1` set; migration won't re-run.

## System-prompt size (T3)
From app_logs (`[diag]` row):
```
2026-05-18 00:38:48  [diag] system prompt: 7488 chars (~1872 tokens) for groups=ideation,my_channel,studio_analytics
```
Up slightly from the prior 7372 because the channel_description block is denser than the 5-line clipped legacy block, but still well under the 8000-char target.

## What was NOT live-driven
- Acceptance test 4 (edit a rule via Brain → send "give me ideas" → confirm the new rule shows up in output). Live ideation chat call burns Anthropic credit per the recurring caveat. The data path is proven: Brain panel writes go through PATCH /api/channel-info → updateChannelContext → channels.ideation_rules; buildSystemPrompt reads channels.ideation_rules verbatim into the "## Ideation rules (HARD)" block; idea-generator's compose prompt does the same. End-to-end inspection is the equivalent of running the full chain.
- Acceptance test 5 (switch channels via top-right picker, panel refreshes). The Brain panel's `useEffect` watches `[brainOpen, activeChannelId]` — switching channels re-fires the GET. Verified by code inspection; live channel-switch screenshot deferred.

## Files touched
- src/lib/db.ts — channels.channel_description ADD COLUMN + one-shot migration (flag channels.description_migrated_v1) + Channel.channel_description field + ChannelContextField union extended + resolveChannelDescription() helper with legacy fallback.
- src/lib/chat-tools.ts — buildSystemPrompt swapped from 5-line clipped fields to ## About this channel / ## Ideation rules (HARD) / ## Persistent facts. Uses resolveChannelDescription so unmigrated channels still surface concatenated context.
- src/lib/idea-generator.ts — same swap in buildUserBodyForCompose. ChannelCtx type collapsed from 5 legacy strings to `{ description, ideation_rules }`.
- src/app/api/channel-info/route.ts — wire schema extended for channelDescription + ideationRules. Server-side caps 1500/1200. Legacy fields still accepted for backwards compat.
- src/app/api/channel-info/analyze-with-ai/route.ts — output schema rewritten from 5-field Proposal to `{ description: string }`. Same data scaffolding (transcripts + comment summaries + optional demographics). 1500-char cap.
- src/components/agent-brain-editors.tsx — NEW. Shared DescriptionEditor + IdeationRulesEditor + AgentMemoryPanel components (lifted from /channel-info inline AgentMemoryPanel). Both /channel-info and /chat Brain panel render these.
- src/app/channel-info/page.tsx — 5-field FIELDS array deleted; ContextField + ReadValue + inline AgentMemoryPanel + MemoryRow type removed. SingleChannelCard renders DescriptionEditor + IdeationRulesEditor + AgentMemoryPanel. SummaryTable "filled" check based on channelDescription alone. AnalyzeModal rewritten for single-paragraph preview + Apply (cache key bumped to analyze_ai_v2).
- src/app/chat/page.tsx — Brain panel state (localStorage-persisted open/closed) + Brain toggle in chat header + right-side aside rendering the editors when open. Container widened max-w-[1100px] → max-w-[1400px] to fit the 320px panel.

## Migrations
1 migration. ALTER TABLE channels ADD COLUMN channel_description TEXT DEFAULT '' (idempotent via existing newColumns array). Plus one-shot flag-gated UPDATE pass that concatenates legacy fields. Legacy columns retained as deprecated; UI no longer surfaces them.
