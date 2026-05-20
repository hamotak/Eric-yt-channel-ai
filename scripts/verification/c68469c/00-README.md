# Prune/popover/sidebar/prompt-tax verification

Captured 2026-05-18. Move to `scripts/verification/<commit-shortsha>/` after commit.

## Screenshots
- `01-tool-picker-popover.png` — /chat with the popover open. Three rows: Ideation / My Channel / Studio Analytics, each with toggle. No paragraph descriptions. Footer link "Manage integrations →". Also shows the sidebar grouping by `TODAY` and the `UNTAGGED (4)` collapsed section + the new MoreHorizontal kebab next to "+ New chat" for clear-empty.
- `02-sidebar-grouped-today-untagged.png` — sidebar with the same state for a closer look.

## DOM-verified assertions

Picker rows (via `data-testid="chat-tool-picker"` and the inline `title=` attr):
- Ideation — "Outliers, formats, idea composition, channel memory — 10 tools"
- My Channel — "Videos, transcripts, comments — local DB only — 4 tools"
- Studio Analytics — "Live Studio metrics (OAuth required) — retention, audience, revenue — 4 tools"

Clear-empty kebab: button[aria-label="Clear empty chats"] present, title="Clear empty chats (sessions with no user messages)". Confirms via window.confirm before POST /api/sessions/clear-empty.

## System-prompt size (T4)

Pulled from the `[diag]` log row in app_logs:
```
2026-05-17 23:58:01 info chat [diag] system prompt: 7372 chars (~1843 tokens) for groups=ideation,my_channel,studio_analytics
```
Target was <8000 chars. **7372 / 8000 = 92% of budget**, down from ~32000+ before T4. ~78% reduction.

## Tool surface (T1) — before / after

Cut from agent registry (kept as backend exports — used by /api routes + scheduled jobs):
  execute_sql · niche_explorer · youtube_trending · youtube_suggest · fetch_transcript · web_search · web_fetch · scrape_youtube_channel · get_youtube_transcript · search_youtube · get_video_comments · list_video_comments_cached · get_comment_thread · get_comment_analysis · list_competitors · competitor_gap_analysis

Kept (18 total across 3 groups):
  Ideation (10): list_outliers · list_format_patterns · generate_ideas · explain_outlier · validate_idea · update_channel_context · save_channel_memory · forget_channel_memory · ban_format · unban_format
  My Channel (4): channel_summary · list_my_videos · search_my_transcripts · search_my_comments
  Studio Analytics (4): get_channel_analytics_overview · get_video_analytics · get_channel_audience · get_channel_revenue

## What was NOT live-driven

Spec acceptance test 5 ("ask 'give me ideas.' Confirm response works as before") needs a real Sonnet chat call that would burn Anthropic credit on a single test. The code path is typecheck-clean and the dispatcher cases for every kept tool are preserved verbatim — only the cut tools were removed.

## Files touched

- src/lib/chat-tools.ts — ToolGroup union (7→3), MY_CHANNEL_TOOLS / IDEATION_TOOLS / STUDIO_ANALYTICS_TOOLS rewrites, dispatcher cleanup, buildSystemPrompt collapsed (~32k → 7372 chars), boot diag log, ideation output format spec moved into generate_ideas description.
- src/app/api/chat/route.ts — ALLOWED_GROUPS shrunk to ["ideation","my_channel","studio_analytics"].
- src/app/chat/page.tsx — ToolGroup type + TOOL_GROUPS array + default-enable logic + tool-picker popover with inline ToggleSwitch, sidebar refactored into SessionBuckets / SessionGroup / SessionRow / UntaggedSection components, clear-empty kebab, truncateTitle helper. Stale localStorage keys (youtube/analytics/exa/apify/research/strategy/yt_analytics) silently dropped on next mount.
- src/lib/db.ts — new clearEmptyChatSessions(channelId | null) helper.
- src/app/api/sessions/clear-empty/route.ts — new POST endpoint.

## Migrations
None.
