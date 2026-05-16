# Eric YT Channel AI — Codebase Map

## Stack & Top-level Files

- Next.js **16.2.4** (App Router, React **19.2.4**, TypeScript 5)
- SQLite via **better-sqlite3 ^12.9.0** (WAL + synchronous=FULL + foreign keys)
- AI SDKs: `@anthropic-ai/sdk ^0.90.0`, `@google/generative-ai ^0.24.1`
- Misc: `youtube-dl-exec` + `youtubei.js` (transcripts/audio), `csv-parse`, `recharts`, `react-markdown` + `remark-gfm`, `lucide-react`, `class-variance-authority`, `tailwind-merge`, `tailwindcss-animate`, Tailwind v4 (no `tailwind.config.*` — config in `globals.css`), `zustand` (declared but barely used), `@tanstack/react-query` (declared but barely used — most pages use `fetch` directly).
- `next.config.ts` declares `serverExternalPackages: ["better-sqlite3", "youtube-dl-exec", "youtubei.js"]` (native + binary packages, kept out of Next's bundler).
- `tsconfig.json`: `"strict": true`, `target: ES2017`, `paths: { "@/*": ["./src/*"] }`, `moduleResolution: bundler`, `jsx: react-jsx`. No `noUnused*`/`exactOptionalPropertyTypes`.
- No ESLint config file. `next lint` would use Next's default rules but no script wires it. No pre-commit hooks (no `husky`, no `.husky/`, no `lint-staged`).
- `AGENTS.md` (and `CLAUDE.md`, which is just `@AGENTS.md`) tells AI agents: "This is NOT the Next.js you know. Read `node_modules/next/dist/docs/` before writing code."
- Basic Auth at edge: `src/proxy.ts` (note: Next 16 renamed `middleware.ts` → `proxy.ts`). No-op locally unless `APP_USERNAME`/`APP_PASSWORD` are set. Exempts `/api/health`, `/api/alerts/poll`, and `_next/*`.
- Data lives at `<project-root>/data/app.db` (override with `DATA_DIR` env). Build phase (`NEXT_PHASE === "phase-production-build"`) swaps to `:memory:` per worker to avoid 30-way SQLite lock races during `next build`.

---

## 1. Folder & Route Layout

### Page routes (`src/app/**/page.tsx`)

| Route | File | One-line purpose |
| --- | --- | --- |
| `/` | `src/app/page.tsx` | Dashboard. KPI tiles (subs/views/videos/avg) + Top-by-views, Top-by-engagement, outliers, monthly bars. Hosts `<DashboardTabs>` switching between "All channels" aggregate and per-channel view; embeds StudioOverview, MultiChannelEarnings, TagsOverview, TodaysEarnings, EditorBillingCard. Client component, fetches `/api/dashboard`. |
| `/videos` | `src/app/videos/page.tsx` | Video list with search, sort (recent/oldest/views/likes/comments/engagement), duration filter (all/short/long). Hosts `<TranscribeAllBanner>`. |
| `/videos/[id]` | `src/app/videos/[id]/page.tsx` | Single video detail: metadata, transcript (or "Transcribe" CTA), `<VideoAnalyticsPanel>`, `<VideoCommentsPanel>`. |
| `/channel` | `src/app/channel/page.tsx` | Deep channel analytics page (built on `channelAnalytics()` aggregate). Cadence, day-of-week patterns, content mix, growth trajectory. |
| `/chat` | `src/app/chat/page.tsx` | Claude/Gemini chat UI with tool calls, session history, attachment picker. SSE stream from `/api/chat`. |
| `/hooks` | `src/app/hooks/page.tsx` | Hook Lab — formula type stats, hook quality scores, rankings. |
| `/hooks-library` | `src/app/hooks-library/page.tsx` | Saved hooks library (user-curated reusable comment quotes). |
| `/formula-analyzer` | `src/app/formula-analyzer/page.tsx` | Pure-SQL aggregation over own video titles — word stats, title-length buckets, top-vs-bottom titles. |
| `/competitors` | `src/app/competitors/page.tsx` | Competitors dashboard with tabs: Overview, Gaps (gap-analysis keywords), Alerts (viral hits). Add/sync/delete competitors. |
| `/alerts` | `src/app/alerts/page.tsx` | Alert rules CRUD + recent fires feed (velocity / total_milestone / delta_window rule types). |
| `/import` | `src/app/import/page.tsx` | CSV import + YouTube channel binding entry point. |
| `/integrations` | `src/app/integrations/page.tsx` | API keys (Claude, Gemini, Deepgram, Apify, Exa, YouTube), YouTube channel binder, Google OAuth connector, YouTube cookies, per-channel meta editor, usage cards (Claude/Apify/Deepgram). |
| `/logs` | `src/app/logs/page.tsx` | App-log viewer (level/source/search filters, level counts, last-24h errors). |
| `/settings` | `src/app/settings/page.tsx` | Theme picker (light/dark/system). Minimal — i18n locale picker was removed (English-only). |

`src/app/layout.tsx` is the root layout: wraps `<ThemeProvider>` → `<I18nProvider>` → flex row of `<Sidebar>` + (`<Topbar>` + `<main>`).

### API routes (`src/app/api/**/route.ts`)

Grouped by feature area. `runtime = "nodejs"` is declared on every route that touches SQLite (which is all of them in practice). Long-running routes also declare `maxDuration` and some set `dynamic = "force-dynamic"`.

#### Dashboard / global
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/dashboard` | GET | `{ channel, stats, aggregates }` — drives the home page. |
| `/api/health` | GET | Liveness ping, exempt from Basic Auth. |
| `/api/stats` | GET | Bare `videoStats()` totals. |

#### Integrations / keys
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/integrations` | GET, POST | List API keys (masked) / save a key. `name` whitelist: `claude`, `deepgram`, `apify`, `exa`, `youtube`, `google_gemini`. |
| `/api/integrations/apify/usage` | GET | Apify account usage (calls Apify `/me`). |

#### YouTube (Data API + OAuth + cookies)
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/youtube/resolve` | POST | Resolve `@handle`/URL/UC-id → channel preview. |
| `/api/youtube/sync` | GET, POST | SSE-streaming full-channel sync (resolve → list uploads → fetch videos → transcripts). |
| `/api/youtube/sync-recent` | POST | Lightweight "fetch only new videos" sync. |
| `/api/youtube/cookies` | GET, POST, DELETE | Manage `youtube.cookies` setting (Netscape cookie file, bypasses bot gates for yt-dlp). |
| `/api/youtube/oauth/config` | GET, POST, DELETE | Store `google.oauth.clientId/clientSecret`. |
| `/api/youtube/oauth/start` | GET | Begin OAuth authorize redirect. |
| `/api/youtube/oauth/callback` | GET | OAuth redirect URI; exchanges code → tokens. |
| `/api/youtube/oauth/status` | GET | Returns `connected`, `scopes`, `expiresAt`. |
| `/api/youtube/oauth/disconnect` | POST | Clear stored tokens. |
| `/api/youtube/oauth/diagnose` | GET | Debug helper — shows what's in the DB & what Google says. |

#### Channels (multi-channel)
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/channel` | GET | The legacy single-channel getter (returns `getChannel()`). |
| `/api/channels` | GET | List all imported channels. |
| `/api/channels/active` | GET, POST | Read / set `youtube.activeChannelId`. |
| `/api/channels/[id]` | PATCH, DELETE | Update channel meta / remove channel + cascading data. |
| `/api/channels/[id]/tags` | GET, POST | List/attach tags for a channel. |
| `/api/channels/[id]/tags/[tagId]` | DELETE | Detach a tag. |

#### Tags
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/tags` | GET, POST | List all tags w/ usage counts / create tag. |
| `/api/tags/[id]` | GET, PATCH, DELETE | Tag CRUD. |

#### Videos
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/videos` | GET | Advanced list w/ search + sort + duration filter. |
| `/api/videos/search` | GET | Lightweight search for the chat attachment picker. |
| `/api/videos/[id]` | GET | Single video + transcript + commentSummary. |
| `/api/videos/[id]/captions` | POST | Trigger free-tier transcript fetch (`fetchTranscriptFreeWithDebug`). |
| `/api/videos/[id]/transcribe` | POST, GET | Deepgram transcribe one video. |
| `/api/videos/[id]/transcribe-upload` | POST | Upload local audio file → Deepgram. |
| `/api/videos/[id]/transcribe-url` | POST | Pass external audio URL → Deepgram. |
| `/api/videos/[id]/comments` | GET | Cached top-level comments for a video. |
| `/api/videos/[id]/comments/sync` | POST | Sync comments via YouTube Data API. |
| `/api/videos/[id]/comments/[commentId]/replies` | GET, POST | Fetch/sync replies for a comment thread. |
| `/api/videos/[id]/comment-analysis` | GET, POST | Cached Claude breakdown (sentiment, themes, objections, future ideas, hook candidates, summary). |
| `/api/comments/search` | GET | FTS5 search across comments. |

#### Analytics (YouTube Analytics v2, cached)
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/analytics/overview` | GET | Channel overview + top videos. Cached 6h in `api_cache`. |
| `/api/analytics/revenue` | GET | Revenue (requires monetary scope; gated by `revenueAccess` flag). |
| `/api/analytics/revenue-multi` | GET | Cross-channel revenue summary. |
| `/api/analytics/audience` | GET | Demographics, traffic sources, geography. |
| `/api/analytics/tags-overview` | GET | Roll up analytics by tag. |
| `/api/analytics/video/[id]` | GET | Per-video analytics over a period. |
| `/api/analytics/cache` | POST | Bust `api_cache` rows with `analytics.%` prefix (Refresh button). |

#### Competitors
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/competitors` | GET, POST | List/add competitor (POST also runs initial sync via Apify). |
| `/api/competitors/[id]` | GET, DELETE | Competitor detail (incl. videos) / remove. |
| `/api/competitors/[id]/sync` | POST | Re-sync one competitor via Apify scraper. |
| `/api/competitors/sync-all` | POST | Batch-sync every competitor. |
| `/api/competitors/gaps` | GET | Gap-analysis keywords. |
| `/api/competitors/alerts` | GET | List viral-hit alerts. |
| `/api/competitors/alerts/[id]/read` | POST | Mark alert read. |

#### Alerts (rule-based + cron)
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/alerts/rules` | GET, POST | List/create rules. |
| `/api/alerts/rules/[id]` | GET, PATCH, DELETE | Rule CRUD. |
| `/api/alerts/fires` | GET | Recent firings feed. |
| `/api/alerts/config` | GET, POST, PUT | Read/save Telegram bot config; PUT sends a test message. |
| `/api/alerts/poll` | GET, POST | Cron entry point. Basic-Auth-exempt, gated by `?secret=<ALERTS_CRON_SECRET>`. |

#### Chat
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/chat` | POST | SSE-stream chat turn (Anthropic/Gemini), with iterative tool calls. Persists to `chat_sessions`/`chat_messages` and logs cost to `claude_usage`. |
| `/api/sessions` | GET, POST | List chat sessions / create one. |
| `/api/sessions/[id]` | GET, PATCH, DELETE | Read / rename / delete session. |

#### Hooks (AI hook scoring)
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/hooks` | GET | `listHooksWithVideos()` for rankings. |
| `/api/hooks/dashboard` | GET | Overall + per-formula stats. |
| `/api/hooks/analyze/[videoId]` | POST | Analyze one video's opening with Claude. |
| `/api/hooks/analyze-pending` | POST | Background batch over pending videos. |
| `/api/hooks-library` | GET, POST | Read / add to manual hooks library. |
| `/api/hooks-library/[id]` | PATCH, DELETE | Update / remove a library entry. |

#### Formula Analyzer
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/formula-analyzer` | GET | Bundle: `titleWordStats`, `titleLengthBuckets`, `topVsBottomTitles`. |

#### Deepgram (transcription)
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/deepgram/usage` | GET, POST | Cost ledger; POST records a manual entry. |
| `/api/deepgram/transcribe-batch` | GET, POST | Start/check the "transcribe all missing" background job. |
| `/api/deepgram/jobs/latest` | GET | Polled by `<TranscribeAllBanner>`. |

#### Editor billing / Claude usage / logs / import
| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/editor-billing` | GET, POST | Monthly editor compensation rollup; POST saves the per-channel rate. |
| `/api/claude/usage` | GET, DELETE | Token spend stats / clear ledger. |
| `/api/logs` | GET, DELETE | App log viewer / clear. |
| `/api/import` | POST | CSV import endpoint. |

### `src/lib/` — server-side library

Every file starts with `import "server-only"` unless noted. Each one-line summary:

| File | Purpose |
| --- | --- |
| `db.ts` | **The schema lives here.** Initializes better-sqlite3 (WAL + FULL + FK + busy_timeout=5000). Singleton on `globalThis.__sqlite`. Schema is hand-rolled via `db.exec("CREATE TABLE IF NOT EXISTS ...")` blocks executed at module load. Idempotent migrations done as `PRAGMA table_info` + `ALTER TABLE` wrapped in try/catch. Exports every query helper used across the app: `getChannel`, `listVideos`, `dashboardAggregates`, `videoStats`, `channelAnalytics`, `editorBillingByMonth`, comments + transcripts CRUD, tags, competitors, hooks, alerts, claude_usage, deepgram_usage, app_logs, api_cache. |
| `ai-provider.ts` | Unified Claude / Gemini streaming wrapper. `streamTurn()` dispatches on provider, returns Anthropic-shape content as source of truth (Gemini results converted at SDK boundary). |
| `ai-provider-types.ts` | Client-safe model enum, `providerLabel()`, `providerModelId()`, `providerIntegrationName()`. Importable from client components. |
| `apify.ts` | Apify `run-sync-get-dataset-items` wrapper. Used only for competitor scraping (`apifyYouTubeScrape` via actor `streamers~youtube-scraper`). |
| `apify-usage.ts` | Calls `https://api.apify.com/v2/users/me` to read account credits. |
| `alerts.ts` | Rule-based polling engine. `runAlertPoll()` reads enabled rules, snapshots each in-scope video via YouTube Data API, evaluates `velocity` / `total_milestone` / `delta_window` rules, fires via Telegram, writes to `alert_fires`. |
| `attachments.ts` | Resolves attachment IDs (video / comment) into the structured Anthropic blocks for `/api/chat`. |
| `chat-tools.ts` | Defines tool schemas + dispatch (`runTool`) for the chat agent. Tool groups: `youtube`, `analytics`, `research`, `exa`, `apify`, `yt_analytics`. Includes the `runSelect` SQL tool. |
| `claude-pricing.ts` | Hard-coded $/M-token rate table (Sonnet 4.6 = $3 in / $15 out etc.). `costMillicents()` returns spend in 1/1000-cents. |
| `comment-analyzer.ts` | Claude-driven comment breakdown — sentiment 1-10 + themes + objections + future ideas + hook candidates + summary. Cached in `comment_analysis` table. |
| `competitor-sync.ts` | `syncCompetitor(id)` calls Apify scraper, upserts `competitors` + `competitor_videos`, computes `competitorMedianViews`, fires `competitor_alerts` for ≥2× median outliers. |
| `csv-import.ts` | csv-parse-based importer for /import. |
| `deepgram.ts` | yt-dlp → Deepgram pipeline. Resolves YouTube ID → signed audio URL, sends to `https://api.deepgram.com/v1/listen?model=nova-3`. Model `DEEPGRAM_MODEL = "nova-3"`, $0.0043/min. Manages `transcription_jobs` for batch progress. |
| `exa.ts` | Exa semantic search wrapper (`/search`, `/contents`). |
| `google-oauth.ts` | "Bring your own client" OAuth 2.0. Scopes: `yt-analytics.readonly`, `yt-analytics-monetary.readonly`, `youtube.readonly`. Tokens stored per-channel in `settings` under `google.oauth.tokens.<channelId>` (legacy fallback `google.oauth.tokens`). `getValidAccessToken()` refreshes on demand. |
| `hook-analyzer.ts` | Claude hook scoring (formula type + 7 quality dimensions 1-10). Writes to `video_hooks`. |
| `i18n/dictionaries.ts` | English-only dictionary. |
| `i18n/provider.tsx` | Client `<I18nProvider>` — locale is hard-coded to `"en"`. |
| `logger.ts` | `log.debug/info/warn/error(source, message, context|err)` → writes to `app_logs` table + mirrors errors/warnings to stderr. `LogSource` = `"sync" | "comments-sync" | "chat" | "youtube" | "claude" | "oauth" | "db" | "api" | "other"`. |
| `sql-tool.ts` | Read-only SQL executor for Claude. Allowlist of tables; auto-injects active-channel-scoped CTE shadows over `videos`/`transcripts`/`comments`; rejects multi-statement / non-SELECT input. |
| `telegram.ts` | Tiny `sendTelegramMessage` wrapper, reads `telegram.botToken` + `telegram.chatId` from settings. |
| `theme-provider.tsx` | Client theme provider; persists `theme` (light/dark/system) in localStorage. |
| `trends.ts` | Helpers for time-series trend math. |
| `utils.ts` | Only one export: `cn(...)` — `twMerge(clsx(...))`. |
| `youtube.ts` | YouTube Data API v3 client (`resolveChannel`, `listUploadIds`, `fetchVideos`, `fetchComments`, `fetchCommentThreads`, `fetchCommentReplies`, `fetchTrending`, `searchYouTube`, `nicheExplorer`, `youtubeSuggest`). Free transcript fetcher `fetchTranscriptFree` and `fetchTranscriptFreeWithDebug` using `youtubei.js` + Innertube fallback ladder (`IOS`→`TV_EMBEDDED`→`WEB_EMBEDDED`→`ANDROID`→`WEB`). |
| `yt-analytics.ts` | YouTube Analytics v2 wrapper. Auto-resolves `channel==UCxxx`. Per-channel `revenueAccess` flag (allowed/denied/unknown). Helpers: `fetchChannelOverview`, `fetchTopVideos`, `fetchVideoAnalytics`, `fetchChannelAudience`, `fetchChannelRevenue`. |

### `src/components/`

All client components (`"use client"` at top of every interactive one).

| File | Purpose |
| --- | --- |
| `sidebar.tsx` | **The nav source of truth.** Hard-coded `items` array of 12 entries (see §4). Polls `/api/competitors` every 60s for unread-alert badge. |
| `topbar.tsx` | Top header bar; hosts `<ChannelSwitcher>` + theme toggle. |
| `channel-switcher.tsx` | Dropdown to change active channel — calls `/api/channels/active`. |
| `connect-banner.tsx` | "Connect a channel to get started" CTA banner on /. |
| `dashboard-tabs.tsx` | All-channels-vs-per-channel tab selector. Persists choice to localStorage. |
| `studio-overview.tsx` | Reads `/api/analytics/overview` (YouTube Analytics period picker). |
| `all-channels-overview.tsx` | Cross-channel aggregate summary card. |
| `multi-channel-earnings.tsx` | Bars of revenue per channel for the active period. |
| `tags-overview.tsx` | Per-tag revenue + video roll-up. |
| `todays-earnings.tsx` | Today's revenue widget (YouTube Analytics + manual override). |
| `channel-revenue.tsx` | Single-channel revenue card. |
| `channel-audience.tsx` | Demographics/geography card. |
| `editor-billing-card.tsx` | Per-channel editor pay forecast + monthly breakdown. |
| `video-analytics-panel.tsx` | YouTube Analytics for one video. |
| `video-comments-panel.tsx` | Comments view + replies + AI analysis trigger. |
| `chat-attachment-picker.tsx` | Search videos/comments to attach to a chat message. |
| `youtube-channel-binder.tsx` | Input + resolve + bind flow used by `/import` + `/integrations`. |
| `youtube-cookies.tsx` | Paste Netscape cookies for yt-dlp bot-bypass. |
| `google-oauth-connector.tsx` | Bring-your-own-client OAuth config + connect button. |
| `claude-usage.tsx` | Claude spend ledger card. |
| `apify-usage.tsx` | Apify credit usage card. |
| `deepgram-usage.tsx` | Deepgram spend ledger card. |
| `transcribe-all-banner.tsx` | Polls `/api/deepgram/jobs/latest`; shows progress bar while batch transcription runs. |
| `ui/button.tsx` | shadcn-style Button (cva variants: default/destructive/outline/secondary/ghost/link, sizes default/sm/lg/icon). |
| `ui/card.tsx` | shadcn Card + CardHeader + CardTitle + CardDescription + CardContent. |
| `ui/input.tsx` | shadcn Input. |
| `ui/textarea.tsx` | shadcn Textarea. |
| `ui/label.tsx` | shadcn Label. |

There is **no `src/hooks/`, no `src/server/`, no `src/types/`** directory. All shared types live next to the function that exports them (mostly in `db.ts`). Hooks (e.g. `useI18n`) are exported from the providers they belong to.

`src/proxy.ts` is the Next-16 replacement for `middleware.ts`. Basic Auth gate.

---

## 2. Database

Schema is defined entirely in `src/lib/db.ts` via `db.exec("CREATE TABLE IF NOT EXISTS ...")` blocks executed at module load. There is **no migrations directory and no migration framework** (not Drizzle, not Prisma, not Kysely). Schema changes are added by:

1. Adding the `CREATE TABLE IF NOT EXISTS ...` block in `db.ts` (somewhere — they're scattered across the file by feature: alerts ~L1212, tags ~L1435, comments ~L1513, competitors ~L2646, hooks ~L3024, comment_analysis ~L3448, hooks_library ~L3522).
2. For added columns on existing tables, hand-rolling an idempotent migration block: `PRAGMA table_info(<table>)` → if column missing → `ALTER TABLE … ADD COLUMN …` wrapped in try/catch. Examples: `chat_messages.attachments` (L177-185), `chat_sessions.pending_since` (L191-198), `video_view_snapshots.likes/comments` (L1352-1373), channel meta columns (L1382-1425).
3. Legacy migrations gated by a row in `settings` (e.g. `tags.legacyMigrated = '1'` at L1459-1509).

The database file is at `<project-root>/data/app.db` (override via `DATA_DIR` env). WAL mode, `synchronous = FULL`, `foreign_keys = ON`, `busy_timeout = 5000`.

### Tables

```sql
-- Key-value bag for app config, OAuth tokens, channel meta, migration flags
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- API keys for external services (claude, deepgram, apify, exa, youtube, google_gemini)
CREATE TABLE integrations (
  name TEXT PRIMARY KEY,
  api_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- The user's bound YouTube channel(s). One row per UCxxxx imported.
CREATE TABLE channels (
  id TEXT PRIMARY KEY,                       -- UCxxxx
  title TEXT,
  handle TEXT,
  description TEXT,
  subscriber_count INTEGER,
  view_count INTEGER,
  video_count INTEGER,
  imported_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  -- Added via idempotent ALTER (channel meta — user-managed fields)
  editor_name TEXT,
  cms_name TEXT,
  cms_cut_percent REAL,
  adsense_name TEXT,
  monetization_status TEXT,                  -- 'monetized'|'pending'|'not_eligible'
  notes TEXT,
  expected_videos_per_month INTEGER
);

-- Videos from the bound channels.
CREATE TABLE videos (
  id TEXT PRIMARY KEY,                       -- YouTube video id
  channel_id TEXT,                           -- soft FK to channels.id
  title TEXT NOT NULL,
  description TEXT,
  published_at INTEGER,
  duration_seconds INTEGER,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  thumbnail_url TEXT,
  tags TEXT,                                 -- JSON array of strings
  imported_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE transcripts (
  video_id TEXT PRIMARY KEY,
  language TEXT,
  text TEXT NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
-- Note: transcripts_fts was DROPPED — see DROP TABLE IF EXISTS transcripts_fts at L221.
-- transcript search now uses plain LIKE.

CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  pending_since INTEGER                      -- session-level "turn in progress" marker, 5min TTL
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,                        -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  attachments TEXT,                          -- JSON array of StoredAttachment
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

-- Generic key-value JSON cache with TTL. Used heavily for analytics responses.
CREATE TABLE api_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  cached_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_api_cache_expires ON api_cache(expires_at);

-- Observability — every `log.*()` call writes here, retention ~5000 rows.
CREATE TABLE app_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  level TEXT NOT NULL,                       -- 'debug'|'info'|'warn'|'error'
  source TEXT NOT NULL,                      -- See LogSource enum
  message TEXT NOT NULL,
  context TEXT,                              -- JSON
  stack TEXT
);
CREATE INDEX idx_logs_ts ON app_logs(ts DESC);
CREATE INDEX idx_logs_level ON app_logs(level);
CREATE INDEX idx_logs_source ON app_logs(source);

-- Per-transcription cost ledger (Deepgram).
CREATE TABLE deepgram_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL,
  model TEXT NOT NULL,
  transcribed_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX idx_deepgram_usage_video ON deepgram_usage(video_id);
CREATE INDEX idx_deepgram_usage_ts ON deepgram_usage(transcribed_at DESC);

-- Batch transcription job tracker (singleton — only one 'running' at a time).
CREATE TABLE transcription_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  completed_at INTEGER,
  total INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  current_video_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',    -- 'running'|'completed'|'failed'|'cancelled'
  last_error TEXT
);
CREATE INDEX idx_tx_jobs_status ON transcription_jobs(status);

-- Per-turn Claude / Gemini cost ledger. Cost stored in MILLICENTS (1/1000 ¢).
CREATE TABLE claude_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  executor_model TEXT NOT NULL,
  advisor_model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  advisor_input_tokens INTEGER NOT NULL DEFAULT 0,
  advisor_output_tokens INTEGER NOT NULL DEFAULT 0,
  advisor_calls INTEGER NOT NULL DEFAULT 0,
  cost_millicents INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  iterations INTEGER NOT NULL DEFAULT 0,
  first_user_msg TEXT,
  active_tools TEXT                          -- JSON array
);
CREATE INDEX idx_claude_usage_ts ON claude_usage(ts DESC);
CREATE INDEX idx_claude_usage_session ON claude_usage(session_id);

-- Per-poll video stat snapshot for alerts engine.
CREATE TABLE video_view_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  views INTEGER NOT NULL,
  likes INTEGER,
  comments INTEGER
);
CREATE INDEX idx_view_snapshots_video_ts ON video_view_snapshots(video_id, ts DESC);

-- Legacy single-threshold per-video alert state (still consulted; new engine uses alert_fires).
CREATE TABLE alert_state (
  video_id TEXT PRIMARY KEY,
  last_fired_at INTEGER NOT NULL,
  last_velocity REAL NOT NULL
);

-- User-defined alert rules — see alerts.ts.
CREATE TABLE alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enabled INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                        -- 'velocity'|'total_milestone'|'delta_window'
  metric TEXT NOT NULL,                      -- 'views'|'likes'|'comments'
  threshold REAL NOT NULL,
  window_minutes INTEGER,
  scope TEXT NOT NULL DEFAULT 'recent_n',    -- 'recent_n'|'all'
  scope_value INTEGER,
  channel_id TEXT,                           -- null = whichever is active at poll time
  cooldown_minutes INTEGER NOT NULL DEFAULT 60,
  fire_once INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE alert_fires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL,
  video_id TEXT NOT NULL,
  fired_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  metric_value REAL,
  delivered INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
);
CREATE INDEX idx_alert_fires_rule_video ON alert_fires (rule_id, video_id, fired_at DESC);
CREATE INDEX idx_alert_fires_recent ON alert_fires (fired_at DESC);

-- Tags (m:n with channels). Tags can carry a cut_percent for revenue math.
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  cut_percent REAL,
  color TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE channel_tags (
  channel_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (channel_id, tag_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
CREATE INDEX idx_channel_tags_channel ON channel_tags(channel_id);
CREATE INDEX idx_channel_tags_tag ON channel_tags(tag_id);

-- Comments — top-level + replies.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  parent_id TEXT,                            -- null = top-level, else parent comment id
  author TEXT,
  author_channel_id TEXT,
  text TEXT NOT NULL,
  like_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  published_at INTEGER,
  updated_at INTEGER,
  fetched_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
CREATE INDEX idx_comments_video ON comments(video_id);
CREATE INDEX idx_comments_parent ON comments(parent_id);

-- FTS5 standalone shadow (NOT external-content) for comment search.
CREATE VIRTUAL TABLE comments_fts USING fts5(
  video_id UNINDEXED, comment_id UNINDEXED, author UNINDEXED, text
);
-- Maintained manually by upsertComment(s) — DELETE-then-INSERT on every write.
-- Cleaned in purgeOtherChannels() and removeChannel() because not FK-linked.

-- Competitors (Phase B — Apify-sourced).
CREATE TABLE competitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT UNIQUE,                    -- null until first sync resolves it
  handle TEXT,                               -- @handle or URL the user pasted
  title TEXT,
  avatar_url TEXT,
  subscriber_count INTEGER,
  video_count INTEGER,
  added_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_sync_at INTEGER
);
CREATE INDEX idx_competitors_channel ON competitors(channel_id);

CREATE TABLE competitor_videos (
  competitor_id INTEGER NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail_url TEXT,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  duration_seconds INTEGER,
  published_at INTEGER,
  synced_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (competitor_id, video_id),
  FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
);
CREATE INDEX idx_comp_videos_views ON competitor_videos(competitor_id, views DESC);

CREATE TABLE competitor_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competitor_id INTEGER NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT,
  thumbnail_url TEXT,
  views INTEGER,
  channel_median_views INTEGER,
  multiplier REAL,
  detected_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  read_at INTEGER,
  UNIQUE(competitor_id, video_id),
  FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
);
CREATE INDEX idx_comp_alerts_unread ON competitor_alerts(read_at, detected_at DESC);

-- Hook Lab — Claude-scored opening for each video.
CREATE TABLE video_hooks (
  video_id TEXT PRIMARY KEY,
  hook_text TEXT NOT NULL,
  formula_type TEXT NOT NULL,                -- one of HOOK_FORMULAS
  score_open_loop INTEGER NOT NULL,
  score_value_promise INTEGER NOT NULL,
  score_conflict INTEGER NOT NULL,
  score_specific_language INTEGER NOT NULL,
  score_identification INTEGER NOT NULL,
  score_pacing INTEGER NOT NULL,
  score_benefit INTEGER NOT NULL,
  overall_score REAL NOT NULL,
  fortalezas TEXT,                           -- JSON array
  mejoras TEXT,                              -- JSON array
  analyzed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  analyzer_model TEXT,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
CREATE INDEX idx_hooks_score ON video_hooks(overall_score DESC);
CREATE INDEX idx_hooks_formula ON video_hooks(formula_type);

-- AI comment analysis cache (one row per video, regenerated on demand).
CREATE TABLE comment_analysis (
  video_id TEXT PRIMARY KEY,
  sentiment_score INTEGER NOT NULL,          -- 1-10
  themes TEXT,                               -- JSON
  objections TEXT,                           -- JSON
  future_ideas TEXT,                         -- JSON
  hook_candidates TEXT,                      -- JSON
  summary TEXT,
  analyzed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  analyzer_model TEXT,
  comments_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- Manually curated hook quotes (re-use comments as hooks in future videos).
CREATE TABLE hooks_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id TEXT,                           -- soft FK; null when entered by hand
  source_video_id TEXT,
  quote TEXT NOT NULL,
  author TEXT,
  score INTEGER,                             -- 1-5 user-assigned rating
  status TEXT NOT NULL DEFAULT 'available',  -- 'available'|'used'
  used_in_video_id TEXT,
  note TEXT,
  added_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (source_video_id) REFERENCES videos(id) ON DELETE SET NULL
);
CREATE INDEX idx_hooks_library_status ON hooks_library(status);
CREATE INDEX idx_hooks_library_added ON hooks_library(added_at DESC);
```

### Which tables back which feature

| Feature | Tables |
| --- | --- |
| Channel binding & multi-channel switching | `channels`, `channel_tags`, `tags`, `settings` (keys: `youtube.channelId`, `youtube.activeChannelId`, `youtube.channelInput`, `youtube.cookies`) |
| Video catalogue & dashboard | `videos`, `transcripts`, `api_cache` (for analytics) |
| Chat | `chat_sessions`, `chat_messages`, `claude_usage` |
| Transcription | `transcripts`, `deepgram_usage`, `transcription_jobs` |
| Comments + AI analysis | `comments`, `comments_fts`, `comment_analysis`, `hooks_library` |
| Hook Lab | `video_hooks` |
| Formula Analyzer | (pure aggregation over `videos`/`videos.title`) |
| Competitors | `competitors`, `competitor_videos`, `competitor_alerts` |
| Alerts (rule engine) | `alert_rules`, `alert_fires`, `video_view_snapshots`, `alert_state` (legacy) |
| Tags / cuts | `tags`, `channel_tags` |
| Editor billing | (aggregate over `videos`, rate stored in `settings.editor.costPerVideoUsd[.channelId]`) |
| YouTube OAuth | `settings` keys: `google.oauth.clientId/clientSecret`, `google.oauth.tokens[.<channelId>]`, `google.oauth.issuedAt[.<channelId>]`, `analytics.revenueAccess[.<channelId>]` |
| Telegram alerts | `settings` keys: `telegram.botToken`, `telegram.chatId` |
| Integrations / API keys | `integrations` |
| Logs | `app_logs` |
| Analytics caching | `api_cache` (keys: `analytics.<endpoint>.<channelId>.<period>`) |

### Adding a new table

1. Append a `db.exec("CREATE TABLE IF NOT EXISTS ...")` block at module scope in `src/lib/db.ts` near the feature it belongs to (the file is already organised by feature region with banner comments).
2. **Do not** put it inside `initSchema()` — that function only runs on the very first import per process (gated by `global.__sqlite` cache). Module-level `db.exec` runs on every import, which is what you want so the table exists after a hot reload.
3. Add indexes inside the same `CREATE TABLE IF NOT EXISTS` exec (use `CREATE INDEX IF NOT EXISTS`).
4. If adding columns to an existing table on an installed DB, write an idempotent migration block: `PRAGMA table_info(<table>)` → conditional `ALTER TABLE … ADD COLUMN … `, wrapped in try/catch with `console.warn` on failure.
5. Export typed query helpers (don't expose `db` to route handlers — they import named functions from `db.ts`).

---

## 3. API conventions

Sampled representative routes: `/api/dashboard`, `/api/integrations`, `/api/videos`, `/api/competitors/[id]`, `/api/analytics/overview`, `/api/chat`, `/api/alerts/poll`.

### Standard shape

- Every route file declares `export const runtime = "nodejs"` at the top. (SQLite + Anthropic SDK + yt-dlp all need Node runtime; never Edge.)
- Long-running routes also set `export const maxDuration = 60|300` and sometimes `export const dynamic = "force-dynamic"` (alerts poll does this to prevent Next 16's build-phase data collection from importing the route).
- Use `NextResponse.json(...)` from `next/server` (or `Response.json(...)` in the chat SSE route which streams). No custom `apiError()` / `jsonResponse()` helper exists — handlers inline the response shape.
- Dynamic `params` are typed as `{ params: Promise<{ id: string }> }` and unwrapped with `await params` — this is the **Next 16** signature (different from Next 13/14).
- Errors are returned as `NextResponse.json({ error: "message" }, { status: 4xx })`. Many handlers also call `log.error("source", message, err, context)` from `src/lib/logger.ts` before returning.
- No session/auth at the handler layer — gating is exclusively done at the edge by `src/proxy.ts` (HTTP Basic). The `/api/health` and `/api/alerts/poll` routes are exempt from Basic Auth; `/api/alerts/poll` enforces its own `?secret=<ALERTS_CRON_SECRET>` instead.
- No tRPC, no zod, no schema validation library. Input parsing is hand-rolled `(await req.json().catch(() => ({})) ) as { ... }` with property whitelisting (`ALLOWED` arrays).

### DB access pattern

Routes import named helpers from `@/lib/db` and call them. They never new up a `Database()` themselves. Example from `/api/dashboard`:

```ts
import { dashboardAggregates, getChannel, videoStats } from "@/lib/db";
export const runtime = "nodejs";
export async function GET() {
  return NextResponse.json({
    channel: getChannel(),
    stats: videoStats(),
    aggregates: dashboardAggregates(),
  });
}
```

Transactions use `db.transaction(...)` inside helpers in `db.ts` (e.g. `purgeOtherChannels`, `removeChannel`, `upsertComments`). There is **no** generic `withTransaction()` helper.

### Calling AI / external APIs

- **Claude / Gemini**: routes import `streamTurn` (or its building blocks `providerModelId`, `providerIntegrationName`) from `@/lib/ai-provider`. Keys read via `getIntegration("claude" | "google_gemini")` from the DB.
- **YouTube Data API**: import helpers from `@/lib/youtube` (`resolveChannel`, `fetchVideos`, etc.). Key read via `getIntegration("youtube")`.
- **YouTube Analytics v2**: import helpers from `@/lib/yt-analytics`. Tokens read via `getOAuthTokens(activeChannelId)`; access auto-refreshed by `getValidAccessToken` inside the wrapper.
- **Deepgram**: `transcribeYouTubeVideo` from `@/lib/deepgram`. Key from `getIntegration("deepgram")`.
- **Apify**: `apifyYouTubeScrape` from `@/lib/apify`. Key from `getIntegration("apify")`.
- **Exa**: `exaSearch`, `exaGetContents` from `@/lib/exa`. Key from `getIntegration("exa")`.
- **Telegram**: `sendTelegramMessage` from `@/lib/telegram` (settings table, not integrations).

### Shared helpers

| Helper | Where | Purpose |
| --- | --- | --- |
| `log.debug/info/warn/error` | `@/lib/logger` | Structured DB-backed logger. Every API error path should call it. |
| `cn(...)` | `@/lib/utils` | Class merger for components. |
| `getCached<T>(key)` / `setCached(key, payload, ttl)` / `invalidateCache(prefix)` | `@/lib/db` | Generic JSON cache used by analytics routes. |
| `getActiveChannelId()` / `setActiveChannelId(id)` | `@/lib/db` | Single source of truth for the currently selected channel. |
| `encodeSSE(data)` | inline in `/api/chat`, `/api/youtube/sync` | One-line `data: ${JSON.stringify}\n\n` encoder for SSE streams. (Not centralized — copy-pasted.) |
| `getOAuthTokens(channelId)` / `getValidAccessToken()` | `@/lib/google-oauth` | Per-channel OAuth token retrieval + refresh. |

There is **no** shared `apiError(message, status)` / `jsonResponse(body, init)` / `withTransaction()` wrapper. Patterns are short enough that handlers inline them.

---

## 4. UI conventions

- **shadcn/ui-style** primitives in `src/components/ui/` (Button, Card, Input, Textarea, Label) using `class-variance-authority` + `clsx` + `tailwind-merge` + `tailwindcss-animate`. Theme variables live in `src/app/globals.css` (Tailwind v4, no `tailwind.config.*`).
- **Icons**: `lucide-react`.
- **Charts**: `recharts` (used in analytics + audience panels).
- **Markdown**: `react-markdown` + `remark-gfm` (chat messages).
- **State**: `zustand` is in the deps but barely referenced. `@tanstack/react-query` is in the deps but not the dominant fetcher. The de-facto pattern is **plain `fetch` inside `useEffect` / event handlers**, storing result in `useState`.
- **Components**: every interactive page is a client component (`"use client"` at line 1). Server components are rare — the only one visible is `src/app/layout.tsx`. There is no server-component data fetching pattern in pages; pages fetch via `/api/*` from the browser.
- **Loading / error**: pages render skeletons or "no data" cards conditionally on state. No global `<Suspense>` or `error.tsx` boundary is used.
- **Routing**: `next/link` for nav, `next/navigation`'s `usePathname()` for active-nav detection.
- **Theme**: `src/lib/theme-provider.tsx` is a custom client provider (theme stored in localStorage, applied via `data-theme` attribute). Not `next-themes`.
- **i18n**: `src/lib/i18n/provider.tsx` exists and `useI18n()` is called everywhere, but the platform is **English-only** — locale is hard-coded to `"en"` and `setLocale` is a no-op. Dictionary keys still get used; copy is centralized in `src/lib/i18n/dictionaries.ts`.

### Typical page structure (from `src/app/page.tsx`, `src/app/videos/page.tsx`, `src/app/competitors/page.tsx`, `src/app/integrations/page.tsx`)

```tsx
"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";

type FooResponse = { ... };

export default function FooPage() {
  const { t } = useI18n();
  const [data, setData] = useState<FooResponse | null>(null);

  useEffect(() => {
    fetch("/api/foo").then(r => r.json()).then(setData).catch(() => {});
  }, []);

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t.foo.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.foo.subtitle}</p>
      </header>
      {/* Cards … */}
    </div>
  );
}
```

Patterns to mimic when adding a new page:
- `mx-auto max-w-6xl` (or `max-w-3xl` for narrow pages like Settings) on the outermost `div`.
- Header with `h1 className="text-2xl font-semibold tracking-tight"` + `p className="mt-1 text-sm text-muted-foreground"`.
- Tabs implemented as a state-controlled inline div (e.g. competitors page) — no `<Tabs>` primitive in `ui/`.
- Refresh buttons use `<Button variant="outline" size="sm">` + a spinning `<RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />`.

### Sidebar nav (THE place to add/remove pages)

`src/components/sidebar.tsx`, lines 52-80. The `items` array is the **only place** that controls top-level nav. Removing or adding a page must touch this file.

| `href` | `label` | `icon` |
| --- | --- | --- |
| `/` | `t.nav.dashboard` | LayoutDashboard |
| `/videos` | `t.nav.videos` | Video |
| `/hooks` | `"Hook Lab"` (hard-coded) | Sparkles |
| `/formula-analyzer` | `"Formula Analyzer"` (hard-coded) | BarChart3 |
| `/hooks-library` | `"Hooks Library"` (hard-coded) | BookmarkPlus |
| `/chat` | `t.nav.chat` | MessageSquare |
| `/competitors` | `"Competitors"` (hard-coded) | Search (badge = unread alerts) |
| `/alerts` | `"Alerts"` (hard-coded) | Bell |
| `/integrations` | `t.nav.integrations` | Plug |
| `/import` | `t.nav.import` | Upload |
| `/logs` | `t.nav.logs` | ScrollText |
| `/settings` | `t.nav.settings` | Settings |

Notes:
- Some labels use the `t.nav.*` dictionary, others are hard-coded strings. (Inconsistent — newer features didn't get dictionary entries because we're English-only.)
- The competitor item carries a polled badge (`unreadAlerts`) — the only nav item with a live number. The pattern: bump `useEffect`'s setInterval inside the Sidebar component itself.
- Active-state matching: exact match for `/`, prefix-or-equal for all others (`pathname.startsWith(item.href + "/")`).

---

## 5. AI / external integrations

### Anthropic Claude

- Initialized **per-request** inside `runClaudeTurn` in `src/lib/ai-provider.ts`: `new Anthropic({ apiKey: opts.apiKey })`. No singleton.
- Default model: `claude-sonnet-4-6` (returned by `providerModelId("claude")`).
- Advisor / Opus model: `claude-opus-4-7` (referenced in `claude-pricing.ts`; used as a sub-agent in chat flows).
- Cost tracking: `src/lib/claude-pricing.ts` → `costMillicents(model, tokens)` → written to `claude_usage` table by `/api/chat`.

### Google Gemini

- Initialized **per-request** inside `runGeminiTurn` in `src/lib/ai-provider.ts`: `new GoogleGenerativeAI(opts.apiKey).getGenerativeModel({ ... })`.
- Available models (enum in `ai-provider-types.ts`): `gemini-2.5-flash-lite`, `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-flash`, `gemini-3-pro`, `gemini-3.1-flash`, `gemini-3.1-pro` — every enum value matches the SDK model id verbatim.
- Sessions are pinned to a provider on creation; switching mid-session is not supported (tool_use_id ↔ function name mapping is one-way).
- API key under `integrations.name = "google_gemini"`.

### Other external clients (one-liners)

| Client | File | Pattern |
| --- | --- | --- |
| YouTube Data API v3 | `src/lib/youtube.ts` | Fetch `https://www.googleapis.com/youtube/v3/…?key=<API key>` directly via `fetch()`. |
| YouTube Analytics v2 | `src/lib/yt-analytics.ts` | OAuth bearer token; `https://youtubeanalytics.googleapis.com/v2/reports`. |
| Google OAuth | `src/lib/google-oauth.ts` | Bring-your-own-client (user pastes their client_id/secret). Per-channel tokens. |
| Deepgram | `src/lib/deepgram.ts` | `https://api.deepgram.com/v1/listen?model=nova-3`, audio URL pulled by yt-dlp. |
| yt-dlp | `youtube-dl-exec` package | Spawns the bundled binary; we pass `--cookies <tempfile>` when `youtube.cookies` setting is set. Player-client fallback: `tv_embedded`, `ios`. |
| youtubei.js (Innertube) | dynamic `await import()` inside `youtube.ts` | Fallback for transcript fetching when datacenter IPs get bot-gated. |
| Apify | `src/lib/apify.ts` | `POST https://api.apify.com/v2/acts/streamers~youtube-scraper/run-sync-get-dataset-items?token=<key>`. |
| Exa | `src/lib/exa.ts` | `POST https://api.exa.ai/search`, header `x-api-key`. |
| Telegram | `src/lib/telegram.ts` | `POST https://api.telegram.org/bot<token>/sendMessage`. |

### Where API keys live

- **`integrations` table** (`integrations.name`, `integrations.api_key`): Claude (`claude`), Deepgram (`deepgram`), Apify (`apify`), Exa (`exa`), YouTube Data API key (`youtube`), Gemini (`google_gemini`). The Integrations page POSTs to `/api/integrations` to save them. Read in handlers via `getIntegration(name)?.api_key`.
- **`settings` table** (key/value): Google OAuth client id/secret (`google.oauth.clientId/clientSecret`), OAuth tokens (`google.oauth.tokens[.<channelId>]`), Telegram bot (`telegram.botToken`, `telegram.chatId`), YouTube cookies (`youtube.cookies`), active channel (`youtube.activeChannelId` / `youtube.channelId`), revenueAccess flag (`analytics.revenueAccess[.<channelId>]`), editor rates (`editor.costPerVideoUsd[.<channelId>]`).
- **`.env`** is **only** used for: `APP_USERNAME`, `APP_PASSWORD` (proxy.ts Basic Auth), `ALERTS_CRON_SECRET` (cron polling secret), `DATA_DIR` (optional override for DB location). Provider API keys live in the DB, **not** in env. This is on purpose — the app is positioned as a "local-only, run-anywhere" tool.

---

## 6. Background jobs / cron / polling

There is **no in-process job queue or scheduler.** No `bullmq`, no `node-schedule`, no `node-cron`, no `setInterval(...)` for app-wide scheduled work. The closest things are:

1. **`/api/alerts/poll`** (`src/app/api/alerts/poll/route.ts`) — designed to be called by an **external cron service** (cron-job.org, EasyCron, Railway cron, etc.) on a ~15 min cadence. GET (or POST) to `/api/alerts/poll?secret=<ALERTS_CRON_SECRET>` runs `runAlertPoll()` from `src/lib/alerts.ts`, which takes a fresh YouTube snapshot of monitored videos and fires Telegram messages. Auth: `?secret=<env>` query param (the route is Basic-Auth-exempt so cron services can hit it without juggling headers). `maxDuration = 60`, `dynamic = "force-dynamic"`.
2. **Browser polling**:
   - `src/components/sidebar.tsx` polls `/api/competitors` every 60 s for unread-alert badge count.
   - `src/components/transcribe-all-banner.tsx` polls `/api/deepgram/jobs/latest` while a batch transcription job is `'running'`.
   - The chat page polls `/api/sessions/[id]` to detect stale `pending_since` markers (5 min TTL).
3. **Background batch jobs kicked off by user click** — `/api/deepgram/transcribe-batch` POST creates a row in `transcription_jobs` (`status='running'`) and fires off a non-awaited async loop that processes videos serially; the browser polls the row for progress. Only one job runs at a time (singleton enforced via `getActiveTranscriptionJob()`).
4. **No init-time tasks** beyond schema bootstrapping.

What `runAlertPoll` triggers: fetches monitored video stats via YouTube Data API → inserts into `video_view_snapshots` → evaluates each `alert_rules` row → on a fire writes to `alert_fires` (subject to per-rule cooldown / `fire_once`) → POSTs to Telegram if configured.

---

## 7. Conventions & gotchas

### Naming

- Files: kebab-case (`youtube-channel-binder.tsx`, `chat-attachment-picker.tsx`). All `lib/` files are kebab-case too. The only Next-mandated names (`page.tsx`, `route.ts`, `layout.tsx`, `proxy.ts`) are lower-case.
- React components: PascalCase (`YouTubeChannelBinder`, `ChannelSwitcher`). Default-exports for pages (`export default function FooPage()`); named exports for components in `src/components/`.
- API route handlers: must be named `GET`, `POST`, `PATCH`, `DELETE`, `PUT` exactly. `OPTIONS` is not used (CORS isn't a concern — same-origin app). `export const POST = GET` is used in `/api/alerts/poll` for "either method works".
- Library exports: camelCase functions (`getChannel`, `dashboardAggregates`, `upsertVideo`).
- Types: `PascalCase`; type vs interface — mostly `type` aliases (`type Channel = { ... }`, `type ChannelMeta = { ... }`).
- Setting keys: dot-namespaced strings (`youtube.activeChannelId`, `editor.costPerVideoUsd.<channelId>`, `google.oauth.tokens.<channelId>`, `analytics.revenueAccess.<channelId>`, `tags.legacyMigrated`).
- Cache keys: dot-namespaced w/ channel id second (`analytics.overview.v2.<channelId>.<period>`).

### TypeScript strictness

- `"strict": true` is on, but `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters` are **not** enabled.
- `target: ES2017`, `moduleResolution: bundler`, `paths: { "@/*": ["./src/*"] }`.
- Loose practice in handlers: `(await req.json().catch(() => ({}))) as { foo?: string }` (manual cast, no zod). Whitelist via `const ALLOWED = [...] as const`.

### ESLint / pre-commit

- No `.eslintrc*`, no `eslint.config.*` at the project root — only `next lint` defaults would apply, but no script invokes it. There is no `pnpm/npm lint` script.
- No `husky/`, no `.husky/`, no `lint-staged`. No git pre-commit gating.
- `// eslint-disable-next-line no-console` is used to silence the lint about `console.warn`/`console.error` in the catch-fallback paths (in `db.ts`, `logger.ts`, `next/image` rules in `page.tsx`).
- `// eslint-disable-next-line @next/next/no-img-element` is used wherever raw `<img>` is rendered for YouTube thumbnails (referrer-policy + cross-origin makes `<Image>` unfriendly).

### Patterns the developer clearly cares about (from inline comments)

- **Channel scoping is everything.** Almost every query helper takes `getActiveChannelId()` and adds `WHERE channel_id = ?` — leaving it off was a real bug ("multi-channel users had cross-channel leaks", per the SQL tool comment). When you add new helpers that read videos/transcripts/comments/hooks, **always** scope by active channel.
- **Idempotent migrations.** Every column addition is gated by `PRAGMA table_info` + try/catch ALTER. Add new columns the same way.
- **Costs in millicents.** Claude/Gemini spend uses 1/1000-cent precision (`cost_millicents`) because Sonnet 1k-token turns round to 0 cents otherwise.
- **Cache busting on channel switch.** `purgeOtherChannels` and `removeChannel` both wipe `api_cache WHERE cache_key LIKE 'analytics.%'`. Any new cached endpoint must use the `analytics.<...>.<channelId>.<...>` key shape so this purge catches it.
- **Per-channel everything.** Editor rate, OAuth tokens, revenueAccess flag, channelInput — all keyed by `<setting>.<channelId>` with a legacy fallback to the bare setting name.
- **WAL + FULL sync.** Reading `db.ts` reveals the developer hit "I closed the server and my API keys were gone" — durability matters. New SQLite work shouldn't regress this.
- **Build-phase memory DB.** `NEXT_PHASE === "phase-production-build"` swaps the DB to `:memory:` per worker. Any module-level work must run cleanly on a fresh empty DB. Don't `SELECT … FROM` at import time.
- **Defensive route runtime declarations.** `/api/alerts/poll` carries `dynamic = "force-dynamic"` to prevent Next 16's data-collection phase from importing it.
- **Mirror dev console output for errors/warnings.** The logger only mirrors errors and warnings to `console.*`. Debug/info stay silent — keep your terminal clean.
- **YouTube transcripts are flaky.** The ladder `youtubei.js Innertube (IOS → TV_EMBEDDED → WEB_EMBEDDED → ANDROID → WEB)` → `caption_tracks` → `get_transcript` → legacy `timedtext` → watch-page scrape exists because every layer fails on different deployments. Don't simplify it.
- **`AGENTS.md` rule for AI agents.** "This is NOT the Next.js you know. Read `node_modules/next/dist/docs/` before writing code." Take Next-16-specific signatures seriously (e.g. `params: Promise<{ id: string }>`).
- **No top-level `await` outside async functions.** Module-level work in `db.ts` is sync only.

There are no `// HACK:`, `// CONVENTION:`, or `// FIXME:` comments — the developer documents intent inline with full-paragraph explanations attached to most non-trivial blocks. Read the comment above an existing function before changing it.

---

## Conventions to follow when adding new pages

1. **Wire the nav first.** Add an entry to the `items` array in `src/components/sidebar.tsx`. Pick a lucide-react icon and reuse a `t.nav.*` key if the route is general-purpose; hard-code the label otherwise (newer features all have hard-coded labels).
2. **One folder per route.** Pages go at `src/app/<slug>/page.tsx`; nested dynamic routes go at `src/app/<slug>/[id]/page.tsx`. No `_layout` folders, no route groups.
3. **Default-export the page component with PascalCase name** (`export default function FooPage()`). Start the file with `"use client"` unless you have a strong reason for a server component — every existing page is a client component.
4. **Fetch data via `/api/*` with plain `fetch` inside `useEffect`.** Don't introduce a React-Query / SWR boundary unless you're refactoring more than one page. Match the existing pattern.
5. **Companion API route under `src/app/api/<slug>/route.ts`** with `export const runtime = "nodejs"` and named exports `GET` / `POST` etc. Return `NextResponse.json(...)`. For dynamic params: `{ params: Promise<{ id: string }> }` → `await params`.
6. **No raw `new Database()` calls in routes.** Import named helpers from `@/lib/db` and add new ones there if the query is novel. Helpers must scope by `getActiveChannelId()` when they touch videos / transcripts / comments / hooks.
7. **Schema lives in `src/lib/db.ts`.** New tables go in a top-level `db.exec("CREATE TABLE IF NOT EXISTS ...")` block near the feature, not inside `initSchema()`. Indexes go in the same exec. Column additions get a `PRAGMA table_info` + try/catch `ALTER`.
8. **Centralize per-feature settings under `<feature>.<key>[.<channelId>]`.** Use `getSetting` / `setSetting`. Anything that can vary per channel **must** be keyed by `channelId` with a legacy fallback to the bare name.
9. **Read API keys via `getIntegration(name)?.api_key`, not `process.env`.** Whitelist of integration names: `claude`, `deepgram`, `apify`, `exa`, `youtube`, `google_gemini` (extend in `/api/integrations` `ALLOWED` array if adding a new provider).
10. **Log every error via `log.error("<source>", "<message>", err, context)`.** Source tags: `sync`, `comments-sync`, `chat`, `youtube`, `claude`, `oauth`, `db`, `api`, `other`. Add new tags sparingly.
11. **Cache external-API responses through `getCached` / `setCached` with TTL.** Always include channel id in the cache key: `<feature>.<endpoint>.<channelId>.<extra>`. Names starting with `analytics.` are wiped on channel-switch automatically.
12. **Use Tailwind + the `cn(...)` helper.** Imports: `import { cn } from "@/lib/utils"`. For variant-ed components mirror the shadcn/cva pattern in `ui/button.tsx`. Theme tokens (e.g. `bg-primary`, `text-muted-foreground`) come from `globals.css` — don't hard-code colours.
13. **Page shell**: `<div className="mx-auto max-w-6xl">` (or `max-w-3xl` for narrow pages) → `<header className="mb-6">` with `h1 text-2xl font-semibold tracking-tight` + `p mt-1 text-sm text-muted-foreground` → cards. Reuse `<Card>` / `<CardHeader>` / `<CardTitle>` / `<CardDescription>` / `<CardContent>` from `@/components/ui/card`.
14. **For SSE-streaming routes** (long sync, chat), encode messages as `data: ${JSON.stringify(payload)}\n\n` and return a `Response` with `Content-Type: text/event-stream`. Don't await the stream; pipe into a `ReadableStream`. Reference: `/api/youtube/sync` and `/api/chat`.
15. **For external-cron-callable endpoints**, exempt the path in `src/proxy.ts`'s `matcher` regex AND enforce a `?secret=` check inside the route. Never expose a state-mutating endpoint without one of those gates.
