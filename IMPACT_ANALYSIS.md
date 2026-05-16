# Eric YT Channel AI — Redesign Impact Analysis

Project root: `/Users/hamidaliyev/Desktop/Eric-yt-channel-ai-main`
Stack: Next.js 16 App Router · React 19 · TypeScript · SQLite (better-sqlite3) · Tailwind v4
Single DB file: `data/app.db` (also: `app.db-shm`, `app.db-wal`)
Schema is auto-created at boot inside `src/lib/db.ts` via `db.exec()` blocks. There is no migration runner — every schema change is an idempotent `CREATE TABLE IF NOT EXISTS …` or `ALTER TABLE … ADD COLUMN` guarded by a `PRAGMA table_info` probe. Any new table/column must follow the same pattern so existing installs upgrade in place without user intervention.

Repo state at time of analysis:
- 141 `.ts`/`.tsx` source files under `src/`.
- Active channels in DB: 2. Videos: 253. Competitors: 2. Competitor videos: 100. Competitor alerts: 32. `hooks_library` rows: 0. `video_hooks` rows: 0. `comment_analysis` rows: 0.
- The `video_hooks`, `hooks_library`, and `formula_*` aggregations are wired but empty — the user has not actually used Hook Lab / Hooks Library / Formula Analyzer.

Cross-cutting facts the build steps depend on (read once, used everywhere below):

1. **Channel scoping pattern.** The "active channel" is a single string stored in the `settings` table under key `active_channel_id`. `src/lib/db.ts` exposes `getActiveChannelId()` / `setActiveChannelId(id)` — almost every channel-scoped query (videos, hook stats, formula stats, transcripts, comments) reads `getActiveChannelId()` and filters by `videos.channel_id = ?`. There is no per-page channel param. The top-bar `ChannelSwitcher` (`src/components/channel-switcher.tsx`) writes via `POST /api/channels/active` and forces a full page reload. Any new page should follow this convention rather than invent a `?channelId=` query param — otherwise the new page will silently desync from the rest of the UI.
2. **Competitors are currently GLOBAL, not channel-scoped.** `competitors.channel_id` does NOT exist as a column on the `competitors` table; the `channel_id` column there is the COMPETITOR's YouTube UC-id, NOT the user's channel. Two of the user's channels see the exact same competitor list right now. This is what step 2 needs to fix, and it has knock-on effects everywhere `listCompetitors()` / `listCompetitorAlerts()` / `competitorGapAnalysis()` are called (notably the sidebar badge poll and the chat `STRATEGY_TOOLS`).
3. **AI prompts that need "channel context."** The system prompt for chat is built in `buildSystemPrompt()` at `src/lib/chat-tools.ts:~1020-1144`. It already injects active-channel metadata (title, subs, view count) but nothing about niche / positioning / audience. Step 1 establishes the data; step 9 wires it into this function.
4. **AI provider abstraction.** `src/lib/ai-provider.ts` (`streamTurn`, providers, models) and `@anthropic-ai/sdk` (`Anthropic.Tool`) are the patterns to copy when adding new AI features (Outlier "why-it-worked", Topic Validator, Ideation, Daily Market Watch).
5. **Cron pattern in repo.** `src/app/api/alerts/poll/route.ts` shows the established cron pattern: a `GET` endpoint exempted from Basic Auth in `src/proxy.ts`, gated by `ALERTS_CRON_SECRET`. Step 7 should clone that exactly.
6. **i18n.** `src/lib/i18n/dictionaries.ts` holds nav labels — `t.nav.dashboard`, `t.nav.videos`, etc. None of the hook/formula labels are in the dictionary (they are hardcoded English in `sidebar.tsx`). New pages can either hardcode strings (matching current sidebar style for the to-be-removed items) or extend the dictionary. The user is non-technical so simplicity wins — recommend hardcoded English short-term, extend dictionary later.

---

## Step 1 — My Channels (NEW page)

Goal: for every channel already in the `channels` table, capture and surface a rich editable "context" payload (niche, positioning gap, audience, voice, off-YouTube research sources). This becomes the single source of truth read by every AI prompt downstream (steps 3, 6, 7, 8, 9).

### Files to CREATE

- `src/app/my-channels/page.tsx` — list view of all channels in the DB with a card per channel showing key context fields, plus a "Edit context" affordance. Reuses `Card`/`Button`/`Input`/`Textarea` from `src/components/ui/`. Should match the visual style of `src/app/integrations/page.tsx` (densely-laid out list of editable cards) more than the dashboard.
- `src/app/my-channels/[id]/page.tsx` — full edit page for a single channel's context. Long-form editable fields for niche, positioning gap, audience, voice, research sources. Saves via PATCH to `/api/channels/:id/context`. Should also surface the existing channel meta fields (editor_name, monetization_status, notes, expected_videos_per_month) that today live on `/integrations` — DO NOT duplicate them, link out or move them.
- `src/app/api/channels/[id]/context/route.ts` — `GET` returns the channel context row; `PATCH` upserts. (Could be folded into the existing `src/app/api/channels/[id]/route.ts` instead; see below.)
- (Optional) `src/components/channel-context-card.tsx` — reusable card that renders a channel's context. Used both on the list page and as a compact "current channel context" widget on Outliers/Ideation pages.

### Files to MODIFY

- `src/components/sidebar.tsx` — add a top-level `My Channels` nav item, ideally first under Dashboard. Current sidebar entry list lives at lines 52–80.
- `src/lib/db.ts` — schema block + accessors. Add a `getChannelContext(id)` and `upsertChannelContext(id, patch)` near the existing `updateChannelMeta()` (around line 512).
- `src/app/api/channels/[id]/route.ts` — optionally extend the existing handler to read/write the new context columns instead of creating a separate `/context` sub-route. Existing handler is short; check it first.
- `src/lib/chat-tools.ts` — extend `buildSystemPrompt()` so the channel context (niche, positioning, audience, voice) is injected when a channel is active. This is the linchpin: every other AI feature relies on this being in the prompt.

### Files to DELETE

None.

### DB changes

Two viable shapes:

**Option A (recommended) — add columns to `channels`.**
The existing pattern (`editor_name`, `cms_name`, `monetization_status`, `notes` etc — see `src/lib/db.ts:1380-1425`) is to bolt extra meta onto the `channels` row. New context fields fit the same pattern: one row per channel, one field per dimension.

```sql
ALTER TABLE channels ADD COLUMN niche TEXT;
ALTER TABLE channels ADD COLUMN positioning_gap TEXT;
ALTER TABLE channels ADD COLUMN audience TEXT;
ALTER TABLE channels ADD COLUMN voice TEXT;
ALTER TABLE channels ADD COLUMN research_sources TEXT;  -- JSON array of {label, url, kind: 'reddit'|'blog'|'forum'|'other'}
ALTER TABLE channels ADD COLUMN context_updated_at INTEGER;
```

Wrap each `ALTER TABLE` in the same `PRAGMA table_info(channels)` guard the file already uses (see lines 1383-1424), so existing installs upgrade in place.

**Option B — separate `channel_contexts` table** with a 1:1 FK to `channels(id)`. Cleaner separation, but doubles the read path and adds no functional benefit until you need to version contexts. Stick with Option A.

No new indexes needed (lookups are always by `channels.id` PK).

### API routes affected

- ADD: `GET /api/channels/[id]/context` and `PATCH /api/channels/[id]/context` — OR fold into the existing `src/app/api/channels/[id]/route.ts`.
- MODIFY: `GET /api/channels/active` (`src/app/api/channels/active/route.ts`) — returned `channel` payload should now include context fields so the topbar can show "niche: …" if desired. Low priority.
- MODIFY: `GET /api/channels` (`src/app/api/channels/route.ts`) — list endpoint already exists; verify it returns the new columns (a `SELECT *` would automatically pick them up; explicit column lists would need updating).

### Sidebar / nav impact

Add `My Channels` (suggested icon: `Tv` from lucide). Position it directly under Dashboard so the user reads "Dashboard → My Channels → Videos" — channel-centric flow. Update `src/components/sidebar.tsx` items array.

### Existing features at risk

- The dashboard, videos, hooks, formula-analyzer, and analytics pages all read `getChannel()` (the active channel). Adding columns is safe — the spread/`SELECT *` reads pick them up automatically.
- `src/lib/db.ts`'s `Channel` type (around line 477-495) must be extended with the new optional fields so TypeScript users see them. Forget to update the type and downstream code will compile-error on touching the new fields.
- The `/integrations` page already manages `editor_name`, `monetization_status`, `notes`, `cms_*`. If the new "My Channels" page also edits these fields, decide who is the source of truth. Recommended: keep editor/billing fields on `/integrations`, put strategy/voice/audience fields on `/my-channels`. Otherwise two pages will fight to overwrite each other.

### Data preservation

Existing `channels` rows stay intact — `ALTER TABLE ADD COLUMN` is non-destructive. The two channels currently in the DB will simply show empty context until the user fills it in.

### Concrete code references for the implementer

- Schema-block placement: drop the new `ALTER TABLE channels ADD COLUMN …` statements inside the existing block at `src/lib/db.ts:1380-1425` — it already iterates a `newColumns` array. Append your fields to that array; the loop handles the `PRAGMA table_info` guard for free.
- The `Channel` type at `src/lib/db.ts:477-495` already uses `?:` optional fields for the meta columns. Extend it the same way (`niche?: string | null;` etc).
- `updateChannelMeta` at `src/lib/db.ts:512` is the existing accessor that takes a partial patch and updates only the supplied keys. Either widen its `ChannelMeta` type to include the context fields, OR write a parallel `updateChannelContext(channelId, patch)` for clean separation. Recommendation: parallel function. Splits concerns (`/integrations` writes meta, `/my-channels` writes context).
- The active channel is read via `getChannel()` at db.ts:748. Any AI-prompt-builder that needs to inject context should call `getChannel()` once and read the new fields directly — no separate lookup needed.
- For the research_sources JSON column, use the same `safeJsonArray` helper at db.ts:442 for parsing on read. Stringify on write.
- Suggested fields in `research_sources` JSON shape: `{ label: string, url: string, kind: 'reddit' | 'blog' | 'forum' | 'newsletter' | 'other' }`. This is the schema the chat tools and ideation prompts will reflect.

---

## Step 2 — Competitors (REWORK existing page)

Goal: scope competitors to channels. Today a single global competitor list is shared across all of the user's channels (both rows in `channels`). Make each competitor belong to exactly one of the user's channels, add a tier tag (Authority / Breakthrough / Adjacent / Far), and keep a channel picker at the top.

This is the highest-risk step because the `competitors`/`competitor_videos`/`competitor_alerts` tables already have data in them (2 competitors, 100 videos, 32 alerts).

### Files to CREATE

- (Optional) `src/components/channel-scoped-page-header.tsx` — reusable strip with title + the active-channel name + a "switch channel" hint, so the user always sees which channel a page is filtering against. Useful here AND on Outliers/Topic-Validator/Daily-Market-Watch/Ideation.

### Files to MODIFY

- `src/app/competitors/page.tsx` — major rework. Add a header row showing the active channel, a tier column on every competitor row, an editable tier dropdown, and tier-based filters on Overview/Alerts/Gaps tabs. The "Add competitor" affordance must attach the new row to the active channel id, not write a global row. The tab list (`Tab = "overview" | "gaps" | "alerts"`) is fine as-is.
- `src/lib/db.ts` — schema (see DB changes), plus accessor changes:
  - `listCompetitors()` must accept (and require) an active-channel argument or read `getActiveChannelId()` internally.
  - `addCompetitor()` must take `channel_id` (the user's channel) and tier.
  - `unreadCompetitorAlertCount()` must be channel-scoped too (or the sidebar badge will show alerts that belong to a different channel).
  - `competitorMedianViews()` is per-competitor only and unaffected.
  - `competitorGapAnalysis()` (line ~2940) reads the user's own video titles for the dedup — already channel-scoped via the active-channel filter inside, but verify it now also filters competitor rows by the active channel.
- `src/lib/competitor-sync.ts` — no logic changes (sync is per-competitor-id), but verify it doesn't accidentally read a stale "competitor exists globally" check.
- `src/components/sidebar.tsx` — the unread badge poll at lines 31-50 hits `/api/competitors`. That endpoint will now be channel-scoped (returns only the active channel's unread count). Verify the badge still shows the right number after a channel switch (it will, because `ChannelSwitcher` triggers a hard reload).
- `src/lib/chat-tools.ts` — every competitor tool (`list_competitors`, `list_competitor_alerts`, `competitor_gap_analysis`) must be channel-scoped via the active channel. Verify their result helpers in the dispatcher block (`runTool`, around lines 870-897). No tool schema changes required.
- `src/app/api/competitors/route.ts` (GET & POST) — `listCompetitors()` and `addCompetitor()` calls must pass active-channel id.
- `src/app/api/competitors/[id]/route.ts` — `GET` for one competitor needs to verify it belongs to the active channel before returning videos (otherwise a stale URL leak shows another channel's data).
- `src/app/api/competitors/alerts/route.ts` — must filter by active channel.
- `src/app/api/competitors/gaps/route.ts` — must filter competitor sources by active channel.
- `src/app/api/competitors/sync-all/route.ts` — must iterate only the active channel's competitors, otherwise switching channels and clicking sync would re-sync every channel's competitors at once.

### Files to DELETE

None.

### DB changes

```sql
-- Add the user's-channel pointer plus tier. user_channel_id is a FK back to channels(id) for the user's OWN channel — NOT a competitor's UC-id (which already exists as competitors.channel_id, confusingly named).
ALTER TABLE competitors ADD COLUMN user_channel_id TEXT;
ALTER TABLE competitors ADD COLUMN tier TEXT;  -- 'authority' | 'breakthrough' | 'adjacent' | 'far'
CREATE INDEX IF NOT EXISTS idx_competitors_user_channel ON competitors(user_channel_id);
```

Naming note: `competitors.channel_id` is already taken (it stores the competitor's YouTube UC-id). Pick `user_channel_id` for the new column so the two are never confused. The `Competitor` TypeScript type at db.ts:2695 must be extended with both fields.

Backfill strategy (run once on first boot after the migration, guarded by a `settings` flag like the existing `tags.legacyMigrated` pattern at db.ts:1459):

```sql
-- Step 2a: if exactly ONE user channel exists, assign all competitors to it.
-- Step 2b: if multiple user channels exist, assign to the channel that is currently marked active. The user can re-assign via the UI.
UPDATE competitors SET user_channel_id = (
  SELECT value FROM settings WHERE key = 'active_channel_id'
)
WHERE user_channel_id IS NULL;
-- Set a sensible default tier so existing rows don't render as "(no tier)".
UPDATE competitors SET tier = 'adjacent' WHERE tier IS NULL;
```

### API routes affected

All competitor routes need to either accept `?channelId=` or read the active channel — recommend the second to stay consistent with the rest of the app:

- `src/app/api/competitors/route.ts` — GET + POST scoped.
- `src/app/api/competitors/[id]/route.ts` — GET + DELETE scoped.
- `src/app/api/competitors/[id]/sync/route.ts` — verify it requires the competitor to belong to the active channel.
- `src/app/api/competitors/alerts/route.ts` — scoped.
- `src/app/api/competitors/alerts/[id]/read/route.ts` — verify the competitor it belongs to is on the active channel.
- `src/app/api/competitors/gaps/route.ts` — scoped.
- `src/app/api/competitors/sync-all/route.ts` — scoped (iterate only the active channel's competitors).

### Sidebar / nav impact

- Label stays "Competitors". Badge stays (unread alerts count, now scoped to active channel).
- If/when the user switches channels via `ChannelSwitcher`, the badge auto-refreshes thanks to the hard reload.

### Existing features at risk

- **Sidebar badge** (`src/components/sidebar.tsx:31-50`) polls `/api/competitors` every 60 s and reads `unreadAlerts`. The endpoint shape stays the same, but the number changes meaning (active-channel-only). Verify after step 2 lands that the badge clears correctly when alerts are read.
- **Chat tools** (`STRATEGY_TOOLS` in `src/lib/chat-tools.ts:425-441`). `list_competitors`, `list_competitor_alerts`, `competitor_gap_analysis` will return only the active channel's data after the rework. Tool descriptions tell Claude "the user's competitors" — keep that wording, since from the user's perspective there is now exactly one set of competitors per active channel.
- **Backfill correctness.** If the user has two channels and both legitimately compete with the same external creator, the backfill assigns the competitor to one channel only. The user must manually duplicate-add to the other channel after the migration. Document this in `UPDATE.md`.
- **Cascade implications.** `competitor_videos` and `competitor_alerts` are FK'd on `competitors(id)` with `ON DELETE CASCADE`, so deleting a competitor when re-assigning is safe — but you probably want to ADD (re-assign) rather than DELETE.
- The "Add competitor" 409-conflict check at `src/app/api/competitors/route.ts:52-60` uses `getCompetitorByChannelId(ucMatch[1])` which looks up by the competitor's UC-id alone. After the rework, two channels can legitimately track the same competitor — that uniqueness check must change to `(user_channel_id, channel_id)`. The UNIQUE constraint on `competitors.channel_id` (at db.ts:2649) must be dropped and replaced with a unique composite, OR removed entirely and dedup happens in app code. Dropping a UNIQUE constraint in SQLite requires recreating the table — non-trivial. Easier path: keep the column as nullable + non-unique, enforce uniqueness in app code per `(user_channel_id, channel_id)` pair.

### Data preservation

- `competitors`: 2 rows, both will be backfilled to whichever channel is active at first boot.
- `competitor_videos`: 100 rows, untouched (they cascade via `competitor_id`).
- `competitor_alerts`: 32 rows, untouched (same cascade).
- Tell the user explicitly: if they have multi-channel competitors that should appear under multiple channels, they need to re-add them after step 2 ships.

### Concrete code references for the implementer

- The full `competitors` schema block to edit is at `src/lib/db.ts:2646-2693`. Add the new columns at the bottom of the block (CREATE TABLE side is for fresh installs) and inside an idempotent migration loop modelled on lines 1380-1425.
- Helper to patch: `updateCompetitorAfterSync` at db.ts:2764 already takes a `Partial<Competitor>` patch. The Competitor type at db.ts:2695-2705 must include `user_channel_id: string | null` and `tier: string | null` (or a stricter union).
- For the UNIQUE-constraint problem: SQLite cannot drop a UNIQUE constraint without recreating the table. Two options:
  1. **App-level uniqueness** (recommended): drop the constraint syntactically only on new installs — i.e. CREATE TABLE statement no longer has UNIQUE on channel_id — but for existing installs that already have the UNIQUE constraint, just leave it AND change `addCompetitor` to set channel_id to NULL until resolved per `(user_channel_id, handle)`. Then resolve channel_id on first sync. Dedupe in app code via `getCompetitorByUserChannelAndChannelId(userChannelId, channelId)`.
  2. **Table rebuild** (heavier): CREATE TABLE competitors_new with the desired schema, INSERT SELECT, DROP TABLE competitors, ALTER TABLE competitors_new RENAME TO competitors, recreate indexes. Wrapped in a single transaction. Higher risk; only justified if option 1 turns out to leak duplicates in practice.
- Update site for sidebar badge: `src/components/sidebar.tsx:31-50` already does `fetch("/api/competitors")` and reads `unreadAlerts`. No code change needed there — the endpoint's return shape stays. The number's MEANING changes (now active-channel-scoped).
- The `Competitor` type extension matters for the chat tool `list_competitors` dispatcher (chat-tools.ts:~860-892) which currently maps every Competitor field to the AI's output shape. Adding `user_channel_id` and `tier` to the type and to that mapping makes them visible to Claude so it can reason about them.

### Migration smoke test

After step 2 lands, run this query mentally / in a SQL prompt to verify the backfill worked:

```sql
SELECT user_channel_id, tier, COUNT(*) FROM competitors GROUP BY user_channel_id, tier;
```

You should see exactly the active channel's id and "adjacent" as the only group, with count = number of pre-existing competitors. If you see NULL user_channel_id rows, the backfill missed something.

---

## Step 3 — Outliers (NEW page)

Goal: a sortable, filterable feed of competitor videos that meaningfully outperformed the median for their own channel. Clicking a row triggers an AI "why it worked" tag generation; tagged outliers can be saved as title or thumbnail formats to the Styles Library (step 5). This replaces the current scattered "alerts" approach with a fully-fledged ideation surface.

### Files to CREATE

- `src/app/outliers/page.tsx` — client page. Fetches `/api/outliers`, renders a sortable table (columns: thumbnail, competitor, title, views, multiplier, age, tier badge from step 2, "why it worked" if cached). Filters by tier, multiplier range, age window (30 / 90 / all), and competitor.
- `src/app/api/outliers/route.ts` — GET endpoint. Joins `competitor_videos` against `competitors` for the active channel, computes per-competitor median (last 30 d / 90 d / lifetime — windowed), returns rows with `multiplier = views / median`. Sort by multiplier DESC, paginate.
- `src/app/api/outliers/[videoId]/why/route.ts` — POST. Triggers AI "why it worked" generation, caches the result. GET reads the cache.
- `src/lib/outlier-analyzer.ts` — server-only. Builds the Claude prompt (uses channel context from step 1 + competitor metadata + video title + transcript if available). Returns structured JSON: `{ levers: string[], hookFormulaGuess: string, titlePattern: string, thumbnailNotes: string, confidence: 1-5 }`.

### Files to MODIFY

- `src/lib/db.ts` — extend competitor_videos query helpers OR add new ones. Probably add:
  - `listOutliers(userChannelId, opts: { windowDays?: 30 | 90 | null, minMultiplier?: number, tier?: string, limit?: number })`
  - `outlierWhyByVideoId(videoId)`
  - `upsertOutlierWhy(videoId, payload)`
- `src/components/sidebar.tsx` — add `Outliers` nav entry (suggested icon: `Flame` or `TrendingUp` from lucide).
- `src/lib/chat-tools.ts` — add a `list_outliers` tool to `STRATEGY_TOOLS` so the chat can read this surface too.

### Files to DELETE

None.

### DB changes

```sql
-- Cache the "why it worked" AI output keyed by competitor_video.
CREATE TABLE IF NOT EXISTS outlier_why (
  video_id TEXT PRIMARY KEY,             -- competitor_videos.video_id
  competitor_id INTEGER NOT NULL,
  levers TEXT,                            -- JSON array of strings
  hook_formula_guess TEXT,
  title_pattern TEXT,
  thumbnail_notes TEXT,
  confidence INTEGER,                     -- 1-5
  analyzed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  analyzer_model TEXT,
  FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_outlier_why_competitor ON outlier_why(competitor_id);
```

No changes to `competitor_videos` — its existing columns (views, published_at, thumbnail_url) are sufficient. Median is computed on-the-fly per request (already proven cheap by `competitorMedianViews` at db.ts:2839).

Note: the existing `competitor_alerts` table is essentially a sparse precursor of the outliers concept. Decision: keep `competitor_alerts` as the historical / Telegram-fire-once stream, but build Outliers as a live recomputed view. Don't try to repurpose `competitor_alerts` — its `multiplier` column is set at sync time and goes stale.

### API routes affected

- ADD: `GET /api/outliers?window=30|90|all&minMultiplier=&tier=&competitorId=`
- ADD: `POST /api/outliers/[videoId]/why` (triggers analysis), `GET /api/outliers/[videoId]/why` (reads cache)
- (Optional) `POST /api/outliers/[videoId]/save-as-style` — proxies to step 5's Styles Library endpoint.

### Sidebar / nav impact

Add `Outliers` between Videos and Competitors. After step 4 strips Hook Lab / Formula Analyzer / Hooks Library, the sidebar will shrink — keep this ordering in mind so the post-strip nav reads sensibly: Dashboard, My Channels, Videos, Outliers, Competitors, Styles Library, Topic Validator, Daily Market Watch, Topic Ideation, Chat, Alerts, Integrations, Import, Logs, Settings.

### Existing features at risk

- The "save title format / thumbnail format" buttons depend on step 5 (Styles Library). Build step 5 first OR ship step 3 with the buttons disabled / "coming soon."
- Outliers must respect the channel scope from step 2. If step 2 hasn't landed, every channel sees the same outliers — confusing for multi-channel users. Strict ordering: step 2 → step 3.
- "Why it worked" calls Claude/Gemini. Costs apply per click. Cache aggressively (the `outlier_why` table is the cache). Use the existing `recordClaudeUsage` from `src/lib/db.ts:2369` for billing visibility.

### Data preservation

N/A — net new feature. No data to migrate.

### Concrete code references for the implementer

- Median computation: copy the windowed-median trick from `competitorMedianViews` at db.ts:2839. Generalise it: accept a `WHERE published_at > ?` extra clause so 30 d / 90 d windows are one function call.
- For the "rolling median per competitor" the listing wants, two patterns:
  1. **Compute median once per competitor per request**, cache in memory for the request lifetime. ~10-20 competitors × a tiny query each = fast enough.
  2. **Materialise medians into a `competitor_medians` table**, refresh after each sync. Lower latency but adds a write path. v1: pattern 1; revisit if listings get slow.
- The "filter by tier" UI gets its tier list from the same union you defined in step 2 (`'authority' | 'breakthrough' | 'adjacent' | 'far'`). DRY it: declare the union once in `src/lib/db.ts` as `export type CompetitorTier = …` and import it into the Outliers page.
- For the "save title format / thumbnail format" buttons on a row, see step 5's `style-save-button.tsx` — it should accept a `{ type: 'title' | 'thumbnail', sourceVideoId, sourceKind: 'competitor', defaultFormat: string }` prop bag so it can be reused on the video detail page too.
- AI "why it worked" prompt should include: channel context (from step 1), competitor name + tier, the video's title, the channel's median, the multiplier, and a couple of representative recent titles from the SAME competitor (for stylistic anchoring). Out-of-band data (transcripts) is overkill for v1 — title + thumbnail + stats is enough signal.

### Risk: cost runaway on "why it worked"

If the user mass-clicks 50 outliers in a row, that's 50 Claude calls. Mitigations:
- Cache aggressively in `outlier_why` keyed by `video_id` — done above.
- Add a per-channel daily cap (env var, e.g. `OUTLIER_WHY_DAILY_BUDGET=50`) checked in the POST route. Friendly 429 if exceeded.
- Show the user the cached badge / loading state so they don't accidentally re-click.

---

## Step 4 — Strip out Hook Lab, Hooks Library, Formula Analyzer

Goal: remove every trace of the three retired features. Keep the underlying DB file intact so videos, competitors, comments, transcripts, channels stay live.

### Files to CREATE

None.

### Files to MODIFY

- `src/components/sidebar.tsx` — remove the three nav items at lines 55, 56-61, 62-67. Also remove the unused imports `Sparkles` (still used by chat as a `+` menu icon — keep import if so), `BarChart3`, `BookmarkPlus`. Double-check the icon-import list is consistent after removal.
- `src/lib/chat-tools.ts` — major surgery:
  - Remove the `STRATEGY_TOOLS` entries for `get_hook_stats`, `list_hook_breakdowns`, `get_video_hook`, `get_formula_breakdown`, `list_saved_hooks` (at lines 442-495).
  - Remove the matching `case` branches in the dispatcher (lines 898-1006).
  - Remove the imports: `getVideoHook`, `hookFormulaStats`, `hookOverallStats`, `listHooksLibrary`, `listHooksWithVideos`, `titleLengthBuckets`, `titleWordStats`, `topVsBottomTitles` (lines 11-26).
  - Update the `STRATEGY_TOOLS` description in `buildSystemPrompt()` (line 1103) — remove the words "Hook Lab", "Formula Analyzer", "Hooks Library". Keep "AI Comment Analysis" only if comment-analysis stays (it does — see step 4 caveats below).
- `src/app/chat/page.tsx` — line 130 description string mentions "Hook Lab, Formula Analyzer, … Hooks Library." Update it.
- `src/components/video-comments-panel.tsx` — this is the trickiest one. It is the AI Comment Analysis panel embedded on the video detail page, which calls `POST /api/hooks-library` to save standout comments. After the strip, those buttons must either be removed entirely OR they must save to a new home (Styles Library? a generic "saved quotes" table?). Decision recommended: REMOVE the "+ Save as hook" / "Already in Hooks Library" UI (lines ~183-207, ~408-440, ~544-700) but keep the AI Comment Analysis itself (sentiment, themes, objections, future ideas, hook candidates as read-only). The future ideas list is genuinely useful upstream of Topic Ideation (step 8).
  - Remove: `savedHookIds` state, `saveAsHook` function, "Save as hook" button branches, "Best hook candidates" save buttons.
  - Keep: every read-only display (sentiment badge, themes, objections, hook-candidates as text only without the save button).
- `src/lib/comment-analyzer.ts` — keep this file. The "hook_candidates" field in its JSON schema (line 49, 91, 154, 268) is internal terminology — rename to e.g. "standout_quotes" for clarity, OR leave alone (cheaper). Decision: rename. The chat tool `get_comment_analysis` (lines 481-489 of chat-tools.ts) returns this field; if you rename internally, update the chat dispatcher too.

### Files to DELETE

- `src/app/hooks/page.tsx`
- `src/app/hooks-library/page.tsx`
- `src/app/formula-analyzer/page.tsx`
- `src/app/api/hooks/route.ts`
- `src/app/api/hooks/dashboard/route.ts`
- `src/app/api/hooks/analyze-pending/route.ts`
- `src/app/api/hooks/analyze/[videoId]/route.ts`
- `src/app/api/hooks-library/route.ts`
- `src/app/api/hooks-library/[id]/route.ts`
- `src/app/api/formula-analyzer/route.ts`
- `src/lib/hook-analyzer.ts`

That's 11 files (4 pages + 6 API routes + 1 lib).

### DB changes

Tables to drop:

```sql
DROP TABLE IF EXISTS video_hooks;
DROP TABLE IF EXISTS hooks_library;
```

`comment_analysis` stays — it still backs the AI Comment Analysis panel on the video detail page, and the panel survives step 4.

`tags` and `channel_tags` STAY — they are an unrelated feature (per-channel CMS/network tags on the dashboard) and have nothing to do with hooks despite the unfortunate shared word "tag."

The `competitor_alerts` table stays (used by sidebar badge) and is unrelated to hooks despite the shared "alerts" word.

Code in `src/lib/db.ts` to remove (replace whole blocks with comments noting removal):

- The `HOOK_FORMULAS` const + `HookFormula` type (lines 3012-3022).
- The `video_hooks` schema block (lines 3024-3049).
- `VideoHook` type (lines 3051-3067).
- `upsertVideoHook`, `getVideoHook`, `HookWithVideo`, `listHooksWithVideos`, `hookFormulaStats`, `hookOverallStats`, `listVideosPendingHookAnalysis` (lines 3069-3256).
- The Formula Analyzer aggregations: `FORMULA_STOPWORDS`, `tokeniseForFormula`, `FormulaWordStat`, `titleWordStats`, `titleLengthBuckets`, `topVsBottomTitles` (lines 3267-3437).
- The `hooks_library` schema block, `HooksLibraryEntry` type, and all five helpers `listHooksLibrary`, `addHookToLibrary`, `updateHookLibraryEntry`, `deleteHookLibraryEntry`, `hookLibraryEntryForComment` (lines 3522-3618).

Add an idempotent drop at module scope, near the existing `DROP TABLE IF EXISTS transcripts_fts` (line 220):

```sql
DROP TABLE IF EXISTS video_hooks;
DROP TABLE IF EXISTS hooks_library;
```

Place these inside a `try { ... } catch { /* noop */ }` so a re-run on a freshly stripped DB doesn't error.

### API routes affected

Removed (listed above). The 60-second sidebar badge poll hits `/api/competitors` — unaffected. The chat route at `src/app/api/chat/route.ts` imports `getToolsFor` from chat-tools; once the hook tool descriptors are gone, the import still resolves cleanly because `STRATEGY_TOOLS` is still exported.

### Sidebar / nav impact

Three entries disappear: `/hooks` (Hook Lab), `/formula-analyzer` (Formula Analyzer), `/hooks-library` (Hooks Library). Confirm icon imports (`Sparkles`, `BarChart3`, `BookmarkPlus`) are removed if unused elsewhere — `Sparkles` is also used in `video-comments-panel.tsx` and `chat/page.tsx` (keep import there).

### Existing features at risk

Grep-found references (other than the obvious files-to-delete and chat-tools.ts):

- `src/components/video-comments-panel.tsx` — "+ Save as hook" / Hooks Library UI in two spots (lines 183-207 saveAsHook + state; lines 408-440 best-hook-candidate save button; lines 544-700 the comment row's save button). Already covered above.
- `src/lib/comment-analyzer.ts` — uses the word "hook_candidates" as a JSON field in its output. Internal-only; safe to leave OR rename to `standout_quotes`. Either way verify the chat tool `get_comment_analysis` is updated to match.
- `src/app/chat/page.tsx:130` — the tool-group description string references the removed pages. Rewrite that line to describe the post-strip world: "Read-only access to your tracked competitors, outlier alerts, AI Comment Analysis on your own videos, and (after step 5+ ship) your saved Styles, validated topics, and idea backlog."

References in comments only (no code change needed but tidy up while there):

- `src/lib/db.ts` "Hooks Library" mention at line 3517 — going away with the deletion.
- `src/lib/comment-analyzer.ts:25` "Ready to drop into Hooks Library" — update to "Ready to drop into Styles Library" or just "Ready to inspect" since step 5 doesn't import these.
- `src/app/api/hooks/dashboard/route.ts:13` — file being deleted.

NO shared utilities or types are at risk. The hook/formula code is fully self-contained — every consumer is inside the to-be-deleted files or inside `chat-tools.ts` and `video-comments-panel.tsx`, both of which are covered above.

`tags` table is named confusingly close to "hook tags" but is unrelated — it holds CMS / monetization labels per channel. Do NOT touch it.

### Data preservation

DB row counts at audit time:

- `hooks_library`: 0 rows — nothing to preserve.
- `video_hooks`: 0 rows — nothing to preserve.

The user has installed but never used the three retired features. No data loss whatsoever. Frame it that way to the user — this is the cleanest possible strip moment.

If at some future point the counts are non-zero before the strip ships, you would want to:
- Export `hooks_library` rows to CSV before drop (user-curated content).
- Decide whether the `video_hooks` formula classifications inform the "why it worked" tags in step 3 — they could be migrated into `outlier_why` for the user's own videos. Today: not worth it.

---

## Step 5 — Styles Library (NEW page, replaces Hooks Library slot)

Goal: a curated library of "title formats" and "thumbnail formats" the user wants to keep around as references. Each entry has tags, a source video link (own or competitor), and is the read-side target for step 8's Topic Ideation prompts.

### Files to CREATE

- `src/app/styles/page.tsx` — list page with two tabs (Title Formats / Thumbnail Formats) or a single mixed grid filtered by type. Cards show: format text (or thumbnail image), tags, source link, "used in" notes, add/edit/delete actions.
- `src/app/api/styles/route.ts` — GET list (with `?type=title|thumbnail&tag=…&q=…` filters), POST create.
- `src/app/api/styles/[id]/route.ts` — GET one, PATCH, DELETE.
- (Optional) `src/components/style-save-button.tsx` — reusable "Save as title format / Save as thumbnail format" button to drop into the Outliers row click handler and the video detail page.

### Files to MODIFY

- `src/components/sidebar.tsx` — add `Styles Library` (icon: `Bookmark` or `Layout`). The user said this REPLACES the Hooks Library slot, so position it where the old item was.
- `src/lib/chat-tools.ts` — add a `list_styles` tool to `STRATEGY_TOOLS`. Description: "List the user's saved title and thumbnail formats with tags and source-video references. Use when proposing new video titles or thumbnails so suggestions echo formats the creator has explicitly bookmarked."
- `src/app/outliers/page.tsx` (created in step 3) — wire the "Save title format" / "Save thumbnail format" buttons to call this API.

### Files to DELETE

None (the Hooks Library page was already deleted in step 4).

### DB changes

```sql
CREATE TABLE IF NOT EXISTS styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_channel_id TEXT NOT NULL,            -- which channel this style belongs to
  type TEXT NOT NULL,                       -- 'title' | 'thumbnail'
  format TEXT NOT NULL,                     -- the pattern text, e.g. "I tried X for N days" — or the thumbnail caption / description for thumbnail entries
  source_video_id TEXT,                     -- own video id OR competitor_videos.video_id
  source_kind TEXT,                         -- 'own' | 'competitor' | 'external'
  source_url TEXT,
  thumbnail_url TEXT,                       -- preview image (thumbnail-type only)
  tags TEXT,                                -- JSON array of strings
  notes TEXT,
  added_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_styles_channel ON styles(user_channel_id);
CREATE INDEX IF NOT EXISTS idx_styles_type ON styles(type);
CREATE INDEX IF NOT EXISTS idx_styles_added ON styles(added_at DESC);
```

The `user_channel_id` column ties each style to one of the user's channels (so the Styles Library reflects the active channel only, matching steps 2 and 3).

`tags` here is a JSON array stored as TEXT for simplicity. If you want first-class tag search, add a `style_tags` join table — but for a one-user local app, `WHERE tags LIKE '%"draft"%'` is fine.

### API routes affected

- ADD: `GET /api/styles` (channel-scoped via `getActiveChannelId()`), `POST /api/styles`.
- ADD: `GET /api/styles/[id]`, `PATCH /api/styles/[id]`, `DELETE /api/styles/[id]`.

### Sidebar / nav impact

Add `Styles Library` in the slot vacated by Hooks Library. Same icon if you like (`BookmarkPlus`).

### Existing features at risk

- The "save as style" buttons on the Outliers page (step 3) only work if step 5 ships first OR if step 3 ships with disabled buttons. Build order: step 5 before step 3 if you want the buttons live on day one.
- The Topic Ideation prompt (step 8) reads from Styles Library. Step 8 must wait for step 5.
- The Chat tool `list_styles` added in step 5 is what step 9 leans on for channel-context-aware suggestions. Step 9 must wait for step 5.

### Data preservation

N/A.

---

## Step 6 — Topic Validator (NEW page)

Goal: user types a candidate topic; app searches across the active channel's competitor videos (`competitor_videos` rows) for title matches; returns coverage count, age spread (when did each match publish), view distribution. AI flags four trap patterns:

- **Single-channel trap** — all hits come from one creator (not a topic, just that creator's lane).
- **Event-spike trap** — all hits clustered in a single week (one-off news cycle).
- **Pre-2020 trap** — all hits are old; audience has moved on.
- **Evergreen-saturated trap** — many old + new hits and views are flat (no new entrant can win this).

### Files to CREATE

- `src/app/topic-validator/page.tsx` — input + results card. Input: topic string. Results: a stats strip (total matches, age spread, median views), a list of matching videos grouped by competitor, and an AI verdict panel at the top.
- `src/app/api/topic-validator/route.ts` — POST. Body: `{ topic: string }`. Resolves the active channel, full-text-searches `competitor_videos.title` (LIKE-based, or via the same FTS pattern used for `comments_fts`), computes the stats, calls `analyzeTopicTraps`, returns everything.
- `src/lib/topic-validator.ts` — server-only. `analyzeTopicTraps(matches, channelContext)` → returns `{ traps: string[], verdict: 'green' | 'yellow' | 'red', reasoning: string }`.

### Files to MODIFY

- `src/components/sidebar.tsx` — add `Topic Validator` (icon: `Search` or `Microscope`).
- `src/lib/chat-tools.ts` — add a `validate_topic` chat tool. Description: "Given a candidate topic, return how many competitor videos already cover it, age spread, view-count distribution, and an AI trap-pattern verdict. Use before recommending a video idea."
- `src/lib/db.ts` — add a helper:
  - `searchCompetitorVideos(userChannelId, q: string, limit: number)` — JOINs `competitor_videos` with `competitors` filtered by `competitors.user_channel_id = ?`.

### Files to DELETE

None.

### DB changes

None strictly required if you go with simple `LIKE '%topic%'` matching. SQLite's existing `comments_fts` virtual table (db.ts:1514+) is a precedent for adding a `competitor_videos_fts` table if you want better matching — but step 6 doesn't need it for v1.

Optional improvement:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS competitor_videos_fts USING fts5(
  competitor_id UNINDEXED, video_id UNINDEXED, title
);
-- Triggers to keep it in sync, modelled on the comments_fts pattern in db.ts.
```

The existing `comments_fts` virtual table at db.ts:1514 isn't actually populated by a trigger (search the file — it's used directly by `searchComments` at line 1632). Read that path before deciding.

Cache table for AI verdicts (optional but recommended):

```sql
CREATE TABLE IF NOT EXISTS topic_validations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_channel_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  result_json TEXT NOT NULL,
  validated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(user_channel_id, topic)
);
```

### API routes affected

- ADD: `POST /api/topic-validator`.
- ADD: (optional) `GET /api/topic-validator/recent` — show the last N validated topics so the user has history.

### Sidebar / nav impact

Add `Topic Validator` between Styles Library and Daily Market Watch.

### Existing features at risk

- Depends on step 2 (channel-scoped competitors) to return meaningful results. Build after step 2.
- Costs Claude per validation. Cache by `(user_channel_id, topic)` lower-cased — re-validation reuses the cache for ~24 h.

### Data preservation

N/A.

### Concrete code references for the implementer

- The closest existing precedent for the Topic Validator's "search + group + verdict" pattern is `src/lib/db.ts:competitorGapAnalysis()` (line ~2940) — same shape: SQL aggregate over `competitor_videos` joined to `competitors`, return a structured result. Copy the active-channel filter wiring from that function.
- For age-spread computation, `competitor_videos.published_at` is a unix timestamp in seconds. Bucketing examples in the codebase: `titleLengthBuckets()` at db.ts:3370 (being deleted in step 4, but a useful reference for "bucket → array → average" pattern before it's gone).
- For median computation, copy the window function trick already in `competitorMedianViews()` at db.ts:2839 — SQLite's `ROW_NUMBER() OVER (ORDER BY views)` + filter on the middle rows.
- For the AI verdict call, reuse the `streamTurn` adapter from `src/lib/ai-provider.ts` (NOT direct Anthropic SDK calls — the adapter handles provider switching and usage recording). The hook-analyzer at `src/lib/hook-analyzer.ts` (being deleted in step 4) is the closest precedent for "one-shot Claude call with strict JSON output."
- A simple "trap pattern" rubric the AI can apply mechanically (so it doesn't hallucinate):
  - Single-channel trap: 100 % of hits share one `competitor_id`.
  - Event-spike trap: 80 %+ of hits within a 7-day window.
  - Pre-2020 trap: 0 hits in the last 18 months.
  - Evergreen-saturated trap: ≥15 hits AND the 90th-percentile views < 2× median (no breakout possible).
  Encoding the rule in TypeScript and only asking the AI to write the user-facing explanation is cheaper, more deterministic, and avoids the cost of a 2k-token verdict prompt on every search.

---

## Step 7 — Daily Market Watch (NEW page + cron-like job)

Goal: a once-per-day report summarising what happened in the niche. New outliers, emerging title structures, new competitor channels gaining traction, and topic conflicts between competitor activity and the user's planned uploads (i.e. their idea backlog from step 8).

### Files to CREATE

- `src/app/market-watch/page.tsx` — read-only list of historical daily reports (newest first), each expandable to show the four sections. Optionally a "Run now" button that hits the cron endpoint with a fresh token, for testing.
- `src/app/api/market-watch/route.ts` — GET returns the list of stored reports (channel-scoped). Optional POST gates "run now."
- `src/app/api/market-watch/[id]/route.ts` — GET one report by id.
- `src/app/api/market-watch/cron/route.ts` — the cron entry point. Clone `src/app/api/alerts/poll/route.ts` exactly: gated by an env-var secret, exempt from Basic Auth in `src/proxy.ts`. Iterate every user channel, generate a report per channel, persist.
- `src/lib/market-watch.ts` — orchestration: pull new outliers since yesterday, diff title patterns vs. last week, detect new competitor channels by checking which `competitor.added_at` rows landed in the last day, find topic conflicts by matching upcoming Idea Backlog titles (step 8) against today's outliers.

### Files to MODIFY

- `src/components/sidebar.tsx` — add `Daily Market Watch` (icon: `Newspaper` or `Eye`).
- `src/proxy.ts` — extend the Basic-Auth exemption list to include `/api/market-watch/cron`. The existing exemption pattern is documented in `src/app/api/alerts/poll/route.ts:19-22`.
- `.env.example` — document a new `MARKET_WATCH_CRON_SECRET` env var.
- `src/lib/chat-tools.ts` — optional `get_latest_market_watch` tool so the chat can read today's report.

### Files to DELETE

None.

### DB changes

```sql
CREATE TABLE IF NOT EXISTS market_watch_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_channel_id TEXT NOT NULL,
  generated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  new_outliers_json TEXT,          -- array of competitor_video refs that crossed multiplier threshold since the last report
  emerging_titles_json TEXT,       -- detected n-gram patterns rising vs last week
  new_competitors_json TEXT,       -- competitors.added_at within last 24h that are themselves growing
  topic_conflicts_json TEXT,       -- matches between backlog items (step 8) and today's outliers
  summary TEXT,                    -- AI-written one-paragraph summary
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_market_watch_channel_time
  ON market_watch_reports(user_channel_id, generated_at DESC);
```

### API routes affected

- ADD: `GET /api/market-watch` (list, channel-scoped), `POST /api/market-watch` (run-now, debug).
- ADD: `GET /api/market-watch/[id]`.
- ADD: `GET /api/market-watch/cron?secret=…` (cron entry, basic-auth-exempt).
- MODIFY: `src/proxy.ts` exemption list.

### Sidebar / nav impact

Add `Daily Market Watch`. Consider a small "unread report today" badge so the user knows when fresh insights are waiting.

### Existing features at risk

- Cron security: forgetting to set the secret means the endpoint refuses to run (see `src/app/api/alerts/poll/route.ts:28-42` for the fail-closed pattern — copy it exactly).
- Depends on step 2 (channel-scoped competitors), step 3 (outliers infrastructure), step 8 (idea backlog for topic-conflict detection). Topic-conflict section degrades gracefully if step 8 isn't shipped yet (just leave it empty).
- Cost control: one Claude call per channel per day. If user has 5 channels, that's 5 daily Claude calls — fine. Budget assumption holds.
- The cron service the user uses for `/api/alerts/poll` (cron-job.org, EasyCron, Railway cron, etc.) needs a new job pointed at the new URL. Document that explicitly.
- Idempotency: the cron will sometimes fire twice (network retries, manual debugging). Guard with a "skip if a report already exists for (user_channel_id, day-of-year)" check in `src/lib/market-watch.ts`. Cheaper than dedup-via-unique-index because the read is one row.
- Failure mode: if Apify or Claude is down at cron time, the report fails silently. Surface that on the Market Watch page as "last report: X days ago" so the user notices.

### Concrete code references for the implementer

- Cron handler template: `src/app/api/alerts/poll/route.ts` — copy line-for-line, change the secret name and the workload function. The Basic-Auth exemption pattern is documented inline at lines 19-24.
- Report orchestration shape: closest precedent is `src/lib/alerts.ts` (the `runAlertPoll` function the cron calls). It iterates an entity list (here: monitored videos; for market-watch: the user's channels), does work per item, returns a summary object.
- New-outliers diff: read `competitor_videos` rows with `synced_at > (now - 86400)` AND `views / median > OUTLIER_MULTIPLIER` (the same 2.0 constant from `src/lib/competitor-sync.ts:16`).
- Emerging title-pattern detection: tokenise titles via the existing `tokeniseTitle` helper in `src/lib/db.ts` (around line 2932). Diff this-week vs last-week token frequency. Anything with ≥3× growth is "emerging."
- Topic-conflict detection (step 7 needs step 8 data): for each `idea_backlog` row with `status IN ('backlog','scripting')`, fuzzy-match its `title` against today's new outliers' titles. Even a simple lowercase-trigram match works for v1.

### Data preservation

N/A.

---

## Step 8 — Topic Ideation (NEW page)

Goal: user picks a channel; the app loads channel context (step 1), recent outliers (step 3), and saved styles (step 5); Claude proposes 10 candidate video ideas, each with a suggested title, a thumbnail reference (link or text description), an explicit "lever it pulls" tag, and a 1-5 confidence score. The user approves ideas, sending them to the Idea Backlog (which is also new).

### Files to CREATE

- `src/app/ideation/page.tsx` — main page. Channel context is implicit (active channel). Click "Generate 10 ideas." Each idea is a card with approve / reject / "tweak title" / "swap thumbnail ref" actions. Approved ideas drop into the backlog section below.
- `src/app/ideation/backlog/page.tsx` (optional — or fold into the ideation page as a second tab) — Idea Backlog: a Kanban-ish list of approved ideas with status (backlog → scripting → shooting → editing → published).
- `src/app/api/ideation/generate/route.ts` — POST. Builds the prompt from My Channels context + Outliers (last N) + Styles. Calls Claude. Returns 10 ideas.
- `src/app/api/ideation/backlog/route.ts` — GET list, POST approve (move from "generated" to "backlog"), PATCH status.
- `src/app/api/ideation/backlog/[id]/route.ts` — GET one, PATCH (notes/status), DELETE.
- `src/lib/ideation.ts` — prompt builder + JSON parsing. Returns `Array<{ title, thumbnailRef, leverTag, confidence, reasoning }>`.

### Files to MODIFY

- `src/components/sidebar.tsx` — add `Topic Ideation` (icon: `Lightbulb` or `Wand2`) and (if separate) `Idea Backlog`.
- `src/lib/chat-tools.ts` — add `propose_ideas` and `list_backlog` chat tools.

### Files to DELETE

None.

### DB changes

```sql
CREATE TABLE IF NOT EXISTS idea_backlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail_ref TEXT,
  lever_tag TEXT,                 -- short label of the "what made it work" lever
  confidence INTEGER,             -- 1-5
  reasoning TEXT,                 -- AI's pitch for why this works on this channel
  source TEXT NOT NULL DEFAULT 'ai_ideation',  -- 'ai_ideation' | 'manual' | 'chat'
  status TEXT NOT NULL DEFAULT 'backlog',
                                  -- 'backlog' | 'scripting' | 'shooting' | 'editing' | 'published' | 'killed'
  approved_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  notes TEXT,
  published_video_id TEXT         -- once shipped, link to the videos.id row
);
CREATE INDEX IF NOT EXISTS idx_backlog_channel_status ON idea_backlog(user_channel_id, status);
CREATE INDEX IF NOT EXISTS idx_backlog_approved ON idea_backlog(approved_at DESC);
```

The "generated 10 ideas" set is ephemeral — don't store unapproved suggestions in the DB unless the user wants idea history (which is a v2 ask). Hold them in client state until approve.

### API routes affected

- ADD: `POST /api/ideation/generate` (channel-scoped, body optional — channel context implicit).
- ADD: `GET /api/ideation/backlog`, `POST /api/ideation/backlog`.
- ADD: `GET /api/ideation/backlog/[id]`, `PATCH /api/ideation/backlog/[id]`, `DELETE /api/ideation/backlog/[id]`.

### Sidebar / nav impact

Add `Topic Ideation`. If you split backlog into its own page, add `Idea Backlog` directly below it. Otherwise it's a tab inside Topic Ideation.

### Existing features at risk

- Depends on step 1 (channel context), step 3 (outliers feed), step 5 (Styles Library). All three must be live before step 8 returns useful suggestions. If forced to ship out of order, step 8 should fall back to generic Claude prompts and surface a "set up channel context for better ideas" banner.
- Topic-conflict detection in step 7 (Daily Market Watch) reads `idea_backlog`. Step 7 can ship first if step 8 isn't ready — the section just stays empty.
- Cost: 10-idea generation is one Claude call. Multi-shot if user asks for more (cap at 3 regen rounds per day per channel to prevent runaway).

### Data preservation

N/A.

### Concrete code references for the implementer

- Prompt-building pattern: `src/lib/chat-tools.ts:buildSystemPrompt()` is the right shape (sectioned markdown, optional sections based on data presence). Borrow its `lines: string[]` accumulator pattern.
- Strict-JSON output from Claude: `src/lib/hook-analyzer.ts` (being deleted in step 4, but worth screenshotting before then) shows the schema-in-prompt pattern + the safe `JSON.parse` with fallback at line ~150 of comment-analyzer.ts.
- Usage tracking: every Claude call must end in a `recordClaudeUsage(...)` call (db.ts:2369) so the Claude Usage card on `/integrations` stays honest. The chat route does this in its `finally` block — copy that pattern.
- Confidence score (1-5): instruct Claude to ground it. "5 = at least 3 outliers in the user's tracked competitors hit this lever in the last 30 d." "1 = no direct evidence; speculative."

---

## Step 9 — AI Chat (ENHANCE existing page)

Goal: bake channel-context awareness into the existing chat. The picker exists today (`ChannelSwitcher` in the topbar), and `buildSystemPrompt` already injects basic channel metadata. Step 9 enriches the prompt with the My Channels context (step 1), and ensures every tool descriptor steers Claude toward the new data sources (Styles, Outliers, Backlog).

### Files to CREATE

None.

### Files to MODIFY

- `src/lib/chat-tools.ts` — primary surgery:
  - `buildSystemPrompt()` (lines ~1020-1144): add a "Channel strategy context" section that inlines niche, positioning_gap, audience, voice, and research_sources for the active channel. Mark every field "(set in My Channels)" if it is null so Claude knows the user hasn't filled it in.
  - The `STRATEGY_TOOLS` descriptions all need a refresh once steps 3, 5, 7, 8 land. Make `list_styles`, `list_outliers`, `validate_topic`, `propose_ideas`, `list_backlog`, `get_latest_market_watch` first-class members of `STRATEGY_TOOLS`.
  - Old tool removals from step 4 (hook_stats, list_hook_breakdowns, get_video_hook, get_formula_breakdown, list_saved_hooks) are already covered. Step 9 simply benefits from their absence — Claude no longer has dead-end tools to call.
- `src/app/chat/page.tsx` — the topbar already has `ChannelSwitcher`; no need for a chat-specific picker. But:
  - Line 130: update the "strategy" tool group description string to describe post-redesign capabilities.
  - Consider adding a small "current channel: NAME" pill at the top of the chat thread so the user sees which channel a question will be answered against. The current UI is silent about which channel scope applies, which can confuse multi-channel users.
- `src/app/api/chat/route.ts` — no schema changes. The `buildSystemPrompt` call at line 184 already reads the active channel implicitly via `getChannel()` in chat-tools.ts.

### Files to DELETE

None.

### DB changes

None.

### API routes affected

None added. Existing `POST /api/chat` benefits from the new system prompt and the new strategy tools.

### Sidebar / nav impact

None.

### Existing features at risk

- If `buildSystemPrompt` is updated before steps 1, 3, 5 land, it will inject empty context blocks. Either gate each section on data presence (recommended), or hold step 9 till the prerequisites are in.
- Existing chat sessions in `chat_messages` (read with `getMessages` at db.ts:427) are not affected — only the SYSTEM prompt for new turns changes. Old conversations stay as they were.
- Two related risks worth a sanity check before shipping:
  1. **Token budget.** `buildSystemPrompt` is already large (~80 lines of prompt; output cap is 8192 / 16384). Adding 10-15 lines of channel context plus expanded tool descriptions is fine. Avoid the trap of inlining the entire research_sources blob — keep it to a short "they read: …" summary.
  2. **Tool count growth.** Each new strategy tool widens the tool list Claude sees. Sonnet handles 30-40 tools without issue, but if `STRATEGY_TOOLS` grows past ~15 entries, audit which ones can be merged.

### Data preservation

N/A. Chat history stays intact.

---

## Build order risks

### Hard ordering (do NOT reorder)

- **Step 1 must come before steps 3, 6, 7, 8, 9.** Without channel context columns and the My Channels page, every downstream AI prompt has nothing to inject. Ship step 1 first.
- **Step 2 must come before steps 3, 6, 7, 8.** Channel scope is the foundation. Outliers, Topic Validator, Market Watch and Ideation all return cross-channel garbage if `competitors.user_channel_id` doesn't exist yet.
- **Step 4 (strip) is best done EARLY, immediately after steps 1 and 2.** Doing it early shrinks the surface area for every subsequent step — fewer files, fewer chat tools, fewer sidebar items. Doing it late means every later step has to navigate around the dead code. Recommended sequence: 1, 2, 4, then the rest. The strip is also psychologically motivating for the non-technical user — a smaller, cleaner app to reason about.
- **Step 5 (Styles) must come before step 3's "Save as style" buttons work AND before step 8 can read styles.** If step 3 ships before step 5, the buttons are dead. If step 8 ships before step 5, Ideation can't echo saved formats.
- **Step 3 (Outliers) must come before step 7's "new outliers since yesterday" diff.** Without the outliers materialisation, Market Watch has no input.
- **Step 8 (Topic Ideation) must come before step 7's "topic conflicts vs backlog" section.** If step 7 ships first, that section is empty until step 8 lands — which is fine, since the report degrades gracefully.
- **Step 9 (Chat enhance) should come LAST, after at least steps 1, 3, 5.** Step 9 is a system-prompt + tool-descriptor refresh — it has nothing to inject if its data sources aren't built.

### Recommended order

1. **Step 4 (strip)** — first, while the surface area is small and the dead features are still empty. Big psychological win, small risk (zero data loss).
2. **Step 1 (My Channels)** — establishes the context-injection contract.
3. **Step 2 (Competitors rework)** — establishes channel scope across the app. The riskiest migration; do it early so subsequent features depend on a stable channel-scoped baseline.
4. **Step 5 (Styles Library)** — needed as a read-source by steps 3 and 8.
5. **Step 3 (Outliers)** — depends on 1, 2, 5.
6. **Step 6 (Topic Validator)** — depends on 1, 2. Independent of 3/5/8.
7. **Step 8 (Topic Ideation)** — depends on 1, 2, 3, 5.
8. **Step 7 (Daily Market Watch)** — depends on 1, 2, 3, 8 (for topic-conflict section). Can ship without 8 if topic-conflicts is left empty.
9. **Step 9 (Chat enhance)** — final pass to point chat at every new data source.

### Parallelisable

- Step 6 (Topic Validator) is independent of steps 3, 5, 7, 8 — can ship anytime after step 2. Good "side branch" while a larger step is in progress.
- Step 7 and step 8 can be built in parallel by two passes if the topic-conflict section in step 7 starts empty and gets wired up after step 8 lands.
- The post-strip cleanup of `comment-analyzer.ts` (renaming `hook_candidates` → `standout_quotes`) is a 5-minute change and can be slotted anywhere after step 4.

### Top cross-cutting risks (recap)

- **`competitors.channel_id` is the COMPETITOR's UC-id, not the user's channel id.** Step 2's new column MUST be named `user_channel_id` (or similar) — never reuse `channel_id` or you create an unrecoverable naming collision.
- **SQLite UNIQUE constraint on `competitors.channel_id` (db.ts:2649) blocks two channels tracking the same competitor.** Either drop the constraint by table-rebuild (heavy) or enforce uniqueness in app code per `(user_channel_id, channel_id)` pair (recommended).
- **No migration runner.** Every DB change must be expressed as idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` guarded by `PRAGMA table_info`, matching the existing pattern (db.ts:177-198, 1380-1425, 1455-1508). A non-idempotent migration will crash the app on second boot.
- **Active-channel scoping is silent and global.** It reads `getActiveChannelId()` everywhere — every new endpoint must do the same or the user's data leaks across channels. Forgetting one place is the single most likely correctness bug in this redesign.
- **Cron-style endpoints (step 7) need explicit Basic-Auth exemption in `src/proxy.ts`.** Forgetting this gates the cron behind auth and the external scheduler fails silently. The existing `/api/alerts/poll` exemption is the template.
- **i18n is partial.** `src/lib/i18n/dictionaries.ts` covers nav/dashboard/videos but not the new pages. Two safe paths: (a) hardcode English in new pages, accept the dictionary lag — matches the current state of the to-be-deleted hooks/formula pages, OR (b) extend the dictionary in every step. For a non-technical user shepherding a Claude Code build, path (a) is simpler — one less moving part per prompt.
- **DB write-locking.** SQLite + WAL mode (which this app uses — see the `app.db-wal` and `app.db-shm` files) tolerates concurrent reads but one writer at a time. Every step that adds a new write path should keep transactions short. The cron in step 7 plus a user-triggered "Run now" plus an in-progress chat tool call could all write concurrently — better-sqlite3 will serialize them but a slow Claude streaming call holding a transaction open is a footgun. Pattern: open transaction → write → commit → THEN call AI. Not: open transaction → call AI → write → commit.
- **TypeScript `Channel` type drift.** Every step that adds `channels.*` columns (step 1) or `competitors.*` columns (step 2) must also extend the `Channel` and `Competitor` types in `src/lib/db.ts`. The codebase is strict-TypeScript; forgetting this breaks the build of every downstream feature.

### Quick file-count summary of the redesign

- **NEW pages:** 6 (My Channels, Outliers, Styles, Topic Validator, Market Watch, Topic Ideation). Optionally a 7th if Idea Backlog gets its own page rather than being a tab.
- **NEW API route files:** ~15-18 (varies by how routes are grouped — e.g. ideation has 3 sub-paths).
- **NEW lib modules:** 3-4 (outlier-analyzer, topic-validator, market-watch, ideation).
- **DELETED:** 11 files in step 4.
- **MAJOR REWORKS:** `src/lib/db.ts` (every step touches the schema), `src/lib/chat-tools.ts` (every step adds or removes a tool), `src/components/sidebar.tsx` (every step adds or removes a nav item).
- **NET nav entries:** before redesign 12 items; after redesign 15 items (+ My Channels, + Outliers, + Styles, + Topic Validator, + Market Watch, + Topic Ideation, − Hook Lab, − Formula Analyzer, − Hooks Library).
