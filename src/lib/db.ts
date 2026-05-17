import "server-only";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

/**
 * Resolve the project root by walking up from this source file until we
 * find a `package.json`. This is more robust than `process.cwd()` — even
 * if the user launches the app from a different directory (rare but
 * possible on some shells), the data folder always ends up next to the
 * package.json. Prevents the classic "I restarted and my API keys are
 * gone" footgun where two runs saved into two different data folders.
 */
function findProjectRoot(startDir: string): string {
  let cur = startDir;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(cur, "package.json"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return startDir;
}

const PROJECT_ROOT = findProjectRoot(__dirname);

// Where the SQLite database lives. `DATA_DIR` env var still wins (handy
// for tests / advanced setups). Otherwise we always use
// `<project-root>/data` so it's the same folder no matter where the
// user happens to launch `npm run dev` from.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(PROJECT_ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "app.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

declare global {
  var __sqlite: Database.Database | undefined;
}

/**
 * Detect Next.js production-build phase. During build, Next forks ~30
 * parallel workers to "collect page data" for every route. Each worker
 * imports this module → opens its own SQLite handle → runs initSchema
 * (CREATE/ALTER on the same `app.db` file). 31 workers racing on the
 * write lock blew through `busy_timeout=5000` and the build still
 * crashed with SQLITE_BUSY for whichever worker drew the short straw.
 *
 * Workaround: during the build phase, give every worker its own
 * throwaway `:memory:` database. No contention, no schema mutation on
 * the real file, module imports just work. At runtime (start phase /
 * dev) we still use the real `app.db` on disk.
 *
 * Every module-level CREATE/ALTER below is idempotent on a fresh
 * memory DB (CREATE IF NOT EXISTS, ALTER wrapped in try/catch), so
 * the same code path handles both modes.
 */
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

export const db =
  global.__sqlite ?? new Database(isBuildPhase ? ":memory:" : DB_PATH);
if (!global.__sqlite) {
  // For real on-disk DBs we want WAL + foreign keys + a generous busy
  // timeout. The `:memory:` build-phase DB keeps these too — they're
  // harmless and they keep the schema-init code uniform across modes.
  db.pragma("journal_mode = WAL");
  // synchronous=FULL is the safest setting: every commit fsyncs before
  // returning. Slower than the WAL default (NORMAL) by a few ms per write
  // but immune to data loss on a hard kill (closing the terminal window,
  // power loss, etc.). For a single-user local app the throughput trade
  // is invisible, and the durability is exactly what we need given the
  // user-reported "I closed the server and my API keys were gone" class
  // of issue.
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  // Only cache the singleton when it points at the real on-disk DB.
  // The build-phase :memory: DB is per-worker and shouldn't leak into
  // any cached runtime instance — we want the runtime singleton to
  // open the real file.
  if (!isBuildPhase) {
    global.__sqlite = db;
    // Best-effort WAL checkpoint + close on graceful shutdown. WAL stays
    // durable even without this (NORMAL/FULL sync writes the WAL frame
    // to disk before commit returns), but a clean close folds the WAL
    // back into the main `.db` file so a curious user inspecting the
    // data folder sees a single tidy `app.db` instead of three files.
    const shutdown = () => {
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.close();
      } catch {
        /* process is going away anyway */
      }
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("beforeExit", shutdown);
  }
  initSchema();
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS integrations (
      name TEXT PRIMARY KEY,
      api_key TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      title TEXT,
      handle TEXT,
      description TEXT,
      subscriber_count INTEGER,
      view_count INTEGER,
      video_count INTEGER,
      imported_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      published_at INTEGER,
      duration_seconds INTEGER,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      thumbnail_url TEXT,
      tags TEXT,
      imported_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      video_id TEXT PRIMARY KEY,
      language TEXT,
      text TEXT NOT NULL,
      fetched_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    -- (Note: a transcripts_fts virtual table used to live here -- it was
    -- created as external-content FTS5 against transcripts.text but we
    -- never wired up index maintenance, which caused "database disk image
    -- is malformed" errors on cascade delete. Removed in favour of plain
    -- LIKE search in searchTranscripts. See module-level DROP below.)

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
  `);

  // Lightweight migration for existing DBs — add the attachments column on first boot.
  try {
    const cols = db.prepare(`PRAGMA table_info(chat_messages)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "attachments")) {
      db.exec(`ALTER TABLE chat_messages ADD COLUMN attachments TEXT`);
    }
  } catch {
    /* noop */
  }
}

// Session-level "turn in progress" marker. Declared at module scope so it
// runs on every import — `initSchema` only runs once per process due to the
// globalThis cache, and we want this column added for any existing db file.
try {
  const cols = db.prepare(`PRAGMA table_info(chat_sessions)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "pending_since")) {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN pending_since INTEGER`);
  }
} catch {
  /* noop */
}

// Generic key-value cache with TTL — used for caching expensive YouTube
// Analytics API responses so we don't hammer Google on every page load.
// Keys are hand-rolled (e.g. "analytics.overview.28d"); values are JSON.
db.exec(`
  CREATE TABLE IF NOT EXISTS api_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    cached_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache(expires_at);
`);

// Drop `transcripts_fts` permanently — it was created as an external-content
// FTS5 table (`content='transcripts'`) but we never index it after writes,
// so its internal state desynchronises from `transcripts` and SQLite raises
// "database disk image is malformed" on operations that touch it (e.g.
// the cascade delete during channel switch). We don't actually use FTS on
// transcripts — `searchTranscripts` does plain LIKE — so this table is
// pure liability. Drop and let it stay gone.
try {
  db.exec(`DROP TABLE IF EXISTS transcripts_fts`);
} catch {
  /* table didn't exist or rare concurrent issue — moving on either way */
}

/* ------------------------------------------------------------------ *
 * Stale-job cleanup on boot.
 *
 * Background tasks (transcribe batch, comment sync) run in-process via
 * `void runBatch(...)`. When the Node process exits — user closes the
 * terminal, server restarts after `git pull`, OS reboots — those tasks
 * vanish without ever updating their `comment_sync_jobs` /
 * `transcription_jobs` row. The row stays at status='running' forever,
 * and the next time the app boots the banner polls /jobs/latest, sees
 * a "running" row, and shows a phantom "Syncing comments: 0/0" spinner
 * with no actual work happening behind it.
 *
 * Fix: at startup, any row still marked 'running' from a previous
 * process is a corpse — mark it 'failed' with an explanatory
 * last_error so the UI shows a (dismissable) "previous job didn't
 * finish" summary instead of a perpetual spinner.
 *
 * We DON'T also clear the `sync.inProgress` setting flag here because
 * it's per-channel-sync, much shorter lived, and the user can re-trigger
 * sync trivially. Adding cleanup for it would be reasonable but isn't
 * the actual cause of the phantom-banner bug reported.
 */
if (!isBuildPhase) {
  try {
    db.exec(`
      UPDATE transcription_jobs
      SET status = 'failed',
          completed_at = strftime('%s','now'),
          last_error = COALESCE(last_error, '') ||
            CASE WHEN COALESCE(last_error,'') = '' THEN '' ELSE ' | ' END ||
            'Server restarted before this batch finished — auto-cancelled.'
      WHERE status = 'running';

      UPDATE comment_sync_jobs
      SET status = 'failed',
          completed_at = strftime('%s','now'),
          last_error = COALESCE(last_error, '') ||
            CASE WHEN COALESCE(last_error,'') = '' THEN '' ELSE ' | ' END ||
            'Server restarted before this batch finished — auto-cancelled.'
      WHERE status = 'running';

      UPDATE hook_analysis_jobs
      SET status = 'failed',
          completed_at = strftime('%s','now'),
          last_error = COALESCE(last_error, '') ||
            CASE WHEN COALESCE(last_error,'') = '' THEN '' ELSE ' | ' END ||
            'Server restarted before this batch finished — auto-cancelled.'
      WHERE status = 'running';

      -- Same logic for the channel-sync flag. If the previous process
      -- was killed mid-sync the flag stays at "1" and silently blocks
      -- every future sync + transcribe-batch attempt.
      UPDATE settings SET value = '0' WHERE key = 'sync.inProgress' AND value = '1';
    `);
  } catch (err) {
    // Tables may not exist yet on a brand-new DB — first-time install
    // hasn't run the CREATE TABLE statements yet. Either way the
    // cleanup is best-effort, ignore.
    void err;
  }
}

export function getIntegration(name: string) {
  return db
    .prepare("SELECT name, api_key, enabled FROM integrations WHERE name = ?")
    .get(name) as { name: string; api_key: string | null; enabled: number } | undefined;
}

export function setIntegration(name: string, apiKey: string) {
  const enabled = apiKey.trim().length > 0 ? 1 : 0;
  db.prepare(
    `INSERT INTO integrations (name, api_key, enabled, updated_at)
     VALUES (?, ?, ?, strftime('%s','now'))
     ON CONFLICT(name) DO UPDATE SET
       api_key = excluded.api_key,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`
  ).run(name, apiKey, enabled);
}

export function listIntegrations() {
  return db
    .prepare("SELECT name, api_key, enabled FROM integrations")
    .all() as { name: string; api_key: string | null; enabled: number }[];
}

/* ---------- Generic settings (key-value) ---------- */

export function getSetting(key: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, strftime('%s','now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key, value);
}

/* ---------- Transcripts ---------- */

export function upsertTranscript(
  videoId: string,
  text: string,
  language: string | null = null
): void {
  db.prepare(
    `INSERT INTO transcripts (video_id, language, text, fetched_at)
     VALUES (?, ?, ?, strftime('%s','now'))
     ON CONFLICT(video_id) DO UPDATE SET
       language = excluded.language,
       text = excluded.text,
       fetched_at = excluded.fetched_at`
  ).run(videoId, language, text);
}

export function getTranscript(videoId: string): { text: string; language: string | null } | null {
  const row = db
    .prepare("SELECT text, language FROM transcripts WHERE video_id = ?")
    .get(videoId) as { text: string; language: string | null } | undefined;
  return row ?? null;
}

export function searchTranscripts(
  query: string,
  limit = 20
): { video_id: string; snippet: string; title: string }[] {
  const q = query.trim();
  if (!q) return [];
  // Scope to the active channel so transcript search doesn't pull hits from
  // a different connected channel. JOIN through videos for the filter.
  const activeId = getActiveChannelId();
  try {
    if (activeId) {
      return db
        .prepare(
          `SELECT t.video_id, substr(t.text, 1, 400) as snippet, v.title
           FROM transcripts t
           JOIN videos v ON v.id = t.video_id
           WHERE t.text LIKE ? AND v.channel_id = ?
           ORDER BY v.published_at DESC NULLS LAST
           LIMIT ?`
        )
        .all(`%${q}%`, activeId, limit) as { video_id: string; snippet: string; title: string }[];
    }
    return db
      .prepare(
        `SELECT t.video_id, substr(t.text, 1, 400) as snippet, v.title
         FROM transcripts t
         JOIN videos v ON v.id = t.video_id
         WHERE t.text LIKE ?
         ORDER BY v.published_at DESC NULLS LAST
         LIMIT ?`
      )
      .all(`%${q}%`, limit) as { video_id: string; snippet: string; title: string }[];
  } catch {
    return [];
  }
}

/* ---------- Chat sessions & messages ---------- */

export type ChatSession = {
  id: string;
  title: string | null;
  created_at: number;
  last_message_at: number;
  message_count: number;
};

export type ChatMessage = {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
  attachments?: StoredAttachment[];
};

export type StoredAttachment =
  | { type: "video"; id: string; title: string; thumbnail: string | null }
  | { type: "comment"; id: string; title: string; thumbnail: null };

export function createSession(id: string, title: string | null = null): void {
  db.prepare(
    `INSERT INTO chat_sessions (id, title, created_at) VALUES (?, ?, strftime('%s','now'))`
  ).run(id, title);
}

export function renameSession(id: string, title: string): void {
  db.prepare(`UPDATE chat_sessions SET title = ? WHERE id = ?`).run(title, id);
}

export function deleteSession(id: string): void {
  db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id);
}

/* ---- Pending-turn markers ---- */

// Anything older than this is considered stale (dev server was restarted
// mid-stream, network dropped, etc.) and reported as NOT pending so the UI
// doesn't loop forever on a dead flag.
const PENDING_TTL_SEC = 300; // 5 minutes

export function markSessionPending(id: string): void {
  db.prepare(
    `UPDATE chat_sessions SET pending_since = strftime('%s','now') WHERE id = ?`
  ).run(id);
}

export function clearSessionPending(id: string): void {
  db.prepare(`UPDATE chat_sessions SET pending_since = NULL WHERE id = ?`).run(id);
}

export function isSessionPending(id: string): boolean {
  const row = db
    .prepare(`SELECT pending_since FROM chat_sessions WHERE id = ?`)
    .get(id) as { pending_since: number | null } | undefined;
  if (!row?.pending_since) return false;
  const age = Math.floor(Date.now() / 1000) - row.pending_since;
  return age < PENDING_TTL_SEC;
}

export function listSessions(): ChatSession[] {
  return db
    .prepare(
      `SELECT
         s.id,
         s.title,
         s.created_at,
         COALESCE(MAX(m.created_at), s.created_at) AS last_message_at,
         COUNT(m.id) AS message_count
       FROM chat_sessions s
       LEFT JOIN chat_messages m ON m.session_id = s.id
       GROUP BY s.id
       ORDER BY last_message_at DESC`
    )
    .all() as ChatSession[];
}

export function getSession(id: string): ChatSession | undefined {
  return db
    .prepare(
      `SELECT
         s.id,
         s.title,
         s.created_at,
         COALESCE(MAX(m.created_at), s.created_at) AS last_message_at,
         COUNT(m.id) AS message_count
       FROM chat_sessions s
       LEFT JOIN chat_messages m ON m.session_id = s.id
       WHERE s.id = ?
       GROUP BY s.id`
    )
    .get(id) as ChatSession | undefined;
}

export function getMessages(sessionId: string): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, role, content, created_at, attachments
       FROM chat_messages
       WHERE session_id = ?
       ORDER BY id ASC`
    )
    .all(sessionId) as (ChatMessage & { attachments: string | null })[];
  return rows.map((r) => ({
    ...r,
    attachments: r.attachments ? safeJsonArray(r.attachments) : undefined,
  }));
}

function safeJsonArray<T = unknown>(s: string): T[] | undefined {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : undefined;
  } catch {
    return undefined;
  }
}

export function addMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  attachments?: StoredAttachment[]
): ChatMessage {
  const info = db
    .prepare(
      `INSERT INTO chat_messages (session_id, role, content, attachments, created_at)
       VALUES (?, ?, ?, ?, strftime('%s','now'))`
    )
    .run(sessionId, role, content, attachments?.length ? JSON.stringify(attachments) : null);
  const row = db
    .prepare(
      `SELECT id, session_id, role, content, created_at, attachments
       FROM chat_messages WHERE id = ?`
    )
    .get(info.lastInsertRowid) as ChatMessage & { attachments: string | null };
  return {
    ...row,
    attachments: row.attachments ? safeJsonArray(row.attachments) : undefined,
  };
}

/* ---------- Channel & videos ---------- */

export type Channel = {
  id: string;
  title: string | null;
  handle: string | null;
  description: string | null;
  subscriber_count: number | null;
  view_count: number | null;
  video_count: number | null;
  imported_at: number;
  // User-managed metadata (set via /integrations row Edit). All
  // optional; missing on rows imported before the migration ran.
  editor_name?: string | null;
  cms_name?: string | null;
  cms_cut_percent?: number | null;
  adsense_name?: string | null;
  monetization_status?: "monetized" | "pending" | "not_eligible" | null;
  notes?: string | null;
  expected_videos_per_month?: number | null;
};

/**
 * Patch the user-managed metadata fields of a channel. Only the fields
 * passed in are updated; absent fields stay untouched. Pass `null` for
 * a field to explicitly clear it.
 */
export type ChannelMeta = {
  editor_name?: string | null;
  cms_name?: string | null;
  cms_cut_percent?: number | null;
  adsense_name?: string | null;
  monetization_status?: "monetized" | "pending" | "not_eligible" | null;
  notes?: string | null;
  expected_videos_per_month?: number | null;
};

export function updateChannelMeta(channelId: string, patch: ChannelMeta): void {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(v as string | number | null);
  }
  if (sets.length === 0) return;
  args.push(channelId);
  db.prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}

/* ---------- Tags ---------- */

export type Tag = {
  id: number;
  name: string;
  cut_percent: number | null;
  color: string | null;
  created_at: number;
};

export type TagWithUsage = Tag & {
  channel_count: number;
};

export function listTags(): TagWithUsage[] {
  return db
    .prepare(
      `SELECT t.*, COUNT(ct.channel_id) AS channel_count
       FROM tags t
       LEFT JOIN channel_tags ct ON ct.tag_id = t.id
       GROUP BY t.id
       ORDER BY t.name COLLATE NOCASE ASC`
    )
    .all() as TagWithUsage[];
}

export function getTag(id: number): Tag | null {
  return (
    (db.prepare(`SELECT * FROM tags WHERE id = ?`).get(id) as Tag | undefined) ??
    null
  );
}

export function getTagByName(name: string): Tag | null {
  return (
    (db.prepare(`SELECT * FROM tags WHERE name = ? COLLATE NOCASE`).get(name) as
      | Tag
      | undefined) ?? null
  );
}

export function createTag(input: {
  name: string;
  cut_percent?: number | null;
  color?: string | null;
}): Tag {
  const info = db
    .prepare(
      `INSERT INTO tags (name, cut_percent, color)
       VALUES (?, ?, ?)`
    )
    .run(
      input.name.trim(),
      input.cut_percent ?? null,
      input.color ?? null
    );
  return getTag(Number(info.lastInsertRowid))!;
}

export function updateTag(
  id: number,
  patch: { name?: string; cut_percent?: number | null; color?: string | null }
): Tag | null {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    args.push(patch.name.trim());
  }
  if ("cut_percent" in patch) {
    sets.push("cut_percent = ?");
    args.push(patch.cut_percent ?? null);
  }
  if ("color" in patch) {
    sets.push("color = ?");
    args.push(patch.color ?? null);
  }
  if (sets.length === 0) return getTag(id);
  args.push(id);
  db.prepare(`UPDATE tags SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return getTag(id);
}

export function deleteTag(id: number): boolean {
  // FK CASCADE removes channel_tags rows automatically.
  const info = db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
  return info.changes > 0;
}

/** Tags currently attached to a single channel. */
export function listTagsForChannel(channelId: string): Tag[] {
  return db
    .prepare(
      `SELECT t.* FROM tags t
       JOIN channel_tags ct ON ct.tag_id = t.id
       WHERE ct.channel_id = ?
       ORDER BY t.name COLLATE NOCASE ASC`
    )
    .all(channelId) as Tag[];
}

/** Channels currently carrying a single tag. */
export function listChannelsForTag(tagId: number): { id: string; title: string | null }[] {
  return db
    .prepare(
      `SELECT c.id, c.title FROM channels c
       JOIN channel_tags ct ON ct.channel_id = c.id
       WHERE ct.tag_id = ?
       ORDER BY c.title COLLATE NOCASE ASC`
    )
    .all(tagId) as { id: string; title: string | null }[];
}

export function attachTag(channelId: string, tagId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO channel_tags (channel_id, tag_id) VALUES (?, ?)`
  ).run(channelId, tagId);
}

export function detachTag(channelId: string, tagId: number): void {
  db.prepare(
    `DELETE FROM channel_tags WHERE channel_id = ? AND tag_id = ?`
  ).run(channelId, tagId);
}

/**
 * Returns a map of channel_id → Tag[] for ALL channels in one query.
 * Used by analytics endpoints that need to fold tag info into per-
 * channel rows without N+1.
 */
export function tagsByChannel(): Map<string, Tag[]> {
  const rows = db
    .prepare(
      `SELECT ct.channel_id, t.id, t.name, t.cut_percent, t.color, t.created_at
       FROM channel_tags ct
       JOIN tags t ON t.id = ct.tag_id
       ORDER BY t.name COLLATE NOCASE ASC`
    )
    .all() as ({ channel_id: string } & Tag)[];
  const map = new Map<string, Tag[]>();
  for (const r of rows) {
    const list = map.get(r.channel_id) ?? [];
    list.push({
      id: r.id,
      name: r.name,
      cut_percent: r.cut_percent,
      color: r.color,
      created_at: r.created_at,
    });
    map.set(r.channel_id, list);
  }
  return map;
}

export type Video = {
  id: string;
  channel_id: string | null;
  title: string;
  description: string | null;
  published_at: number | null;
  duration_seconds: number | null;
  views: number;
  likes: number;
  comments: number;
  thumbnail_url: string | null;
  tags: string | null;
  imported_at: number;
};

export function upsertChannel(c: Partial<Channel> & { id: string }): void {
  db.prepare(
    `INSERT INTO channels (id, title, handle, description, subscriber_count, view_count, video_count, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(id) DO UPDATE SET
       title = COALESCE(excluded.title, channels.title),
       handle = COALESCE(excluded.handle, channels.handle),
       description = COALESCE(excluded.description, channels.description),
       subscriber_count = COALESCE(excluded.subscriber_count, channels.subscriber_count),
       view_count = COALESCE(excluded.view_count, channels.view_count),
       video_count = COALESCE(excluded.video_count, channels.video_count),
       imported_at = excluded.imported_at`
  ).run(
    c.id,
    c.title ?? null,
    c.handle ?? null,
    c.description ?? null,
    c.subscriber_count ?? null,
    c.view_count ?? null,
    c.video_count ?? null
  );
}

export function upsertVideo(v: Partial<Video> & { id: string; title: string }): void {
  db.prepare(
    `INSERT INTO videos (id, channel_id, title, description, published_at, duration_seconds, views, likes, comments, thumbnail_url, tags, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(id) DO UPDATE SET
       channel_id = COALESCE(excluded.channel_id, videos.channel_id),
       title = excluded.title,
       description = COALESCE(excluded.description, videos.description),
       published_at = COALESCE(excluded.published_at, videos.published_at),
       duration_seconds = COALESCE(excluded.duration_seconds, videos.duration_seconds),
       views = COALESCE(excluded.views, videos.views),
       likes = COALESCE(excluded.likes, videos.likes),
       comments = COALESCE(excluded.comments, videos.comments),
       thumbnail_url = COALESCE(excluded.thumbnail_url, videos.thumbnail_url),
       tags = COALESCE(excluded.tags, videos.tags),
       imported_at = excluded.imported_at`
  ).run(
    v.id,
    v.channel_id ?? null,
    v.title,
    v.description ?? null,
    v.published_at ?? null,
    v.duration_seconds ?? null,
    v.views ?? 0,
    v.likes ?? 0,
    v.comments ?? 0,
    v.thumbnail_url ?? null,
    v.tags ?? null
  );
}

export function getChannel(): Channel | undefined {
  // Returns the *active* channel — the one most pages of the UI scope to.
  // Falls back to "most recently imported" if no active pointer is set yet
  // (covers fresh installs / pre-multi-channel data).
  const activeId = getActiveChannelId();
  if (activeId) {
    const row = db
      .prepare(`SELECT * FROM channels WHERE id = ?`)
      .get(activeId) as Channel | undefined;
    if (row) return row;
  }
  return db
    .prepare(`SELECT * FROM channels ORDER BY imported_at DESC LIMIT 1`)
    .get() as Channel | undefined;
}

/** All channels stored locally — used by the channel switcher dropdown
 * and the multi-channel earnings aggregator. Most recently imported first. */
export function listAllChannels(): Channel[] {
  return db
    .prepare(`SELECT * FROM channels ORDER BY imported_at DESC`)
    .all() as Channel[];
}

/**
 * Active channel id — the one user-facing screens scope to. Single source
 * of truth for "which channel are we currently looking at". Persisted in
 * settings under `youtube.activeChannelId`.
 *
 * Backward compatibility: pre-multi-channel installs only had
 * `youtube.channelId` (the single bound channel). We fall back to that
 * if no explicit active pointer is set, so existing deployments don't
 * suddenly show "no channel".
 */
export function getActiveChannelId(): string | null {
  const explicit = getSetting("youtube.activeChannelId");
  if (explicit) return explicit;
  return getSetting("youtube.channelId");
}

export function setActiveChannelId(id: string): void {
  setSetting("youtube.activeChannelId", id);
  // Keep the legacy key in sync so any code still reading
  // `youtube.channelId` (analytics endpoints, sync route) sees the same
  // value. Cheap belt-and-braces.
  setSetting("youtube.channelId", id);
}

/**
 * Delete a single channel and every row that scopes to it: videos
 * (cascades to transcripts + comments via FK), comments_fts shadow,
 * cached analytics. If the deleted channel was active, repoint to
 * whichever channel was imported most recently (or clear the pointer
 * if none remain).
 *
 * Returns counts so the caller can surface "removed N videos" in UI.
 */
export function removeChannel(channelId: string): {
  videos: number;
  transcripts: number;
  comments: number;
} {
  const tx = db.transaction((id: string) => {
    const doomed = db
      .prepare(`SELECT id FROM videos WHERE channel_id = ?`)
      .all(id) as { id: string }[];

    let transcriptCount = 0;
    let commentCount = 0;
    if (doomed.length > 0) {
      const ids = doomed.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");

      try {
        db.prepare(
          `DELETE FROM comments_fts WHERE video_id IN (${placeholders})`
        ).run(...ids);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[removeChannel] comments_fts cleanup failed (continuing):", err);
      }

      transcriptCount = (
        db
          .prepare(
            `SELECT COUNT(*) as n FROM transcripts WHERE video_id IN (${placeholders})`
          )
          .get(...ids) as { n: number }
      ).n;
      commentCount = (
        db
          .prepare(
            `SELECT COUNT(*) as n FROM comments WHERE video_id IN (${placeholders})`
          )
          .get(...ids) as { n: number }
      ).n;

      db.prepare(`DELETE FROM videos WHERE channel_id = ?`).run(id);
    }

    db.prepare(`DELETE FROM channels WHERE id = ?`).run(id);

    // Snapshots / alert state aren't FK-linked.
    if (doomed.length > 0) {
      const ids = doomed.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM video_view_snapshots WHERE video_id IN (${placeholders})`
      ).run(...ids);
      db.prepare(
        `DELETE FROM alert_state WHERE video_id IN (${placeholders})`
      ).run(...ids);
      db.prepare(
        `DELETE FROM alert_fires WHERE video_id IN (${placeholders})`
      ).run(...ids);
    }

    // Per-channel settings — wipe everything keyed by the deleted
    // channel id so we don't leave dangling OAuth tokens / editor rate
    // / revenueAccess flags / channelInput tied to a channel that no
    // longer exists.
    db.prepare(`DELETE FROM settings WHERE key LIKE ?`).run(`%.${id}`);

    // Bust analytics cache (keyed by channel id).
    db.prepare(`DELETE FROM api_cache WHERE cache_key LIKE ?`).run(
      `analytics.%.${id}.%`
    );

    // Re-point active channel if we just removed it.
    if (getSetting("youtube.activeChannelId") === id || getSetting("youtube.channelId") === id) {
      const next = db
        .prepare(`SELECT id FROM channels ORDER BY imported_at DESC LIMIT 1`)
        .get() as { id: string } | undefined;
      if (next?.id) {
        setSetting("youtube.activeChannelId", next.id);
        setSetting("youtube.channelId", next.id);
      } else {
        setSetting("youtube.activeChannelId", "");
        setSetting("youtube.channelId", "");
      }
    }

    return {
      videos: doomed.length,
      transcripts: transcriptCount,
      comments: commentCount,
    };
  });
  return tx(channelId);
}

/**
 * Wipe every video (and its cascading transcripts / comments / FTS rows) that
 * doesn't belong to `keepChannelId`. Called at the start of a sync when the
 * user binds a different channel than the one currently in `settings`.
 *
 * Why this exists: `listVideos`, `dashboardAggregates`, the SQL tool, the chat
 * picker — they all query `SELECT * FROM videos` with no channel filter. So
 * without this purge, a fresh sync of channel B leaves channel A's rows
 * hanging around and polluting every listing.
 *
 * The `comments_fts` table isn't FK-linked, so ON DELETE CASCADE from
 * `videos` doesn't reach it — we clean it explicitly. (`transcripts_fts`
 * used to be cleaned here too but was removed as a defective leftover.)
 *
 * Returns counts so callers can surface a "cleaned up N old videos" status.
 */
export function purgeOtherChannels(keepChannelId: string): {
  videos: number;
  transcripts: number;
  comments: number;
  channels: number;
} {
  const tx = db.transaction((keepId: string) => {
    // 1. Find every video that will be deleted — we need their ids to clean
    //    the FTS tables (which aren't FK-linked so no CASCADE).
    const doomed = db
      .prepare(
        `SELECT id FROM videos WHERE channel_id IS NULL OR channel_id != ?`
      )
      .all(keepId) as { id: string }[];

    if (doomed.length === 0) {
      // Still purge orphaned channel rows, then exit early.
      const chInfo = db
        .prepare(`DELETE FROM channels WHERE id != ?`)
        .run(keepId);
      return { videos: 0, transcripts: 0, comments: 0, channels: chInfo.changes };
    }

    const ids = doomed.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");

    // 2. Clean the FTS shadow table for comments (standalone FTS5, we own
    //    its content). Wrap in try/catch — if the FTS index is malformed
    //    we'd rather log and keep going than abort the whole channel
    //    switch and leave the user staring at a "malformed" error.
    //    `transcripts_fts` was dropped at module init (it was an unused
    //    external-content table that kept desynchronising), so don't
    //    touch it here.
    try {
      db.prepare(
        `DELETE FROM comments_fts WHERE video_id IN (${placeholders})`
      ).run(...ids);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[purgeOtherChannels] comments_fts cleanup failed (continuing):", err);
    }

    // 3. Count what will cascade so we can report it (the DELETE on videos
    //    below triggers ON DELETE CASCADE for transcripts + comments).
    const transcriptCount = db
      .prepare(
        `SELECT COUNT(*) as n FROM transcripts WHERE video_id IN (${placeholders})`
      )
      .get(...ids) as { n: number };
    const commentCount = db
      .prepare(
        `SELECT COUNT(*) as n FROM comments WHERE video_id IN (${placeholders})`
      )
      .get(...ids) as { n: number };

    // 4. Delete the videos — FK cascade handles transcripts + comments.
    const vidInfo = db
      .prepare(
        `DELETE FROM videos WHERE channel_id IS NULL OR channel_id != ?`
      )
      .run(keepId);

    // 5. Orphan channel rows (any channel row that isn't the current one).
    const chInfo = db
      .prepare(`DELETE FROM channels WHERE id != ?`)
      .run(keepId);

    // 6. Invalidate any cached YouTube Analytics responses — they're keyed
    //    by channel id so old entries become orphan dead weight after a
    //    channel switch. Cheaper to wipe anything `analytics.*` than to
    //    selectively delete by previous channel id (we don't track it).
    db.prepare(`DELETE FROM api_cache WHERE cache_key LIKE 'analytics.%'`).run();

    return {
      videos: vidInfo.changes,
      transcripts: transcriptCount.n,
      comments: commentCount.n,
      channels: chInfo.changes,
    };
  });

  return tx(keepChannelId);
}

export function listVideos(opts: { limit?: number; search?: string } = {}): Video[] {
  const limit = opts.limit ?? 200;
  // Scope to active channel — multi-channel installs would otherwise mix
  // videos from every connected channel together. If there's no active
  // channel set, return everything (covers fresh-install state).
  const activeId = getActiveChannelId();
  const channelClause = activeId ? "AND channel_id = ?" : "";
  if (opts.search && opts.search.trim()) {
    const q = `%${opts.search.trim()}%`;
    const args = activeId ? [q, q, activeId, limit] : [q, q, limit];
    return db
      .prepare(
        `SELECT * FROM videos
         WHERE (title LIKE ? OR description LIKE ?) ${channelClause}
         ORDER BY COALESCE(published_at, imported_at) DESC
         LIMIT ?`
      )
      .all(...args) as Video[];
  }
  const args = activeId ? [activeId, limit] : [limit];
  return db
    .prepare(
      `SELECT * FROM videos
       ${activeId ? "WHERE channel_id = ?" : ""}
       ORDER BY COALESCE(published_at, imported_at) DESC
       LIMIT ?`
    )
    .all(...args) as Video[];
}

export type VideoSort = "recent" | "oldest" | "views" | "likes" | "comments" | "engagement";
export type DurationFilter = "all" | "short" | "long";

/**
 * Advanced listing with sort + duration filter.
 * - engagement = (likes + comments) / max(views, 1)
 * - short  = duration <= 60s (YouTube Shorts)
 * - long   = duration > 60s
 */
export function listVideosAdvanced(opts: {
  limit?: number;
  search?: string;
  sort?: VideoSort;
  duration?: DurationFilter;
} = {}): Video[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const where: string[] = [];
  const args: unknown[] = [];

  // Scope to active channel for multi-channel installs.
  const activeId = getActiveChannelId();
  if (activeId) {
    where.push("channel_id = ?");
    args.push(activeId);
  }

  if (opts.search && opts.search.trim()) {
    where.push("(title LIKE ? OR description LIKE ?)");
    const q = `%${opts.search.trim()}%`;
    args.push(q, q);
  }
  if (opts.duration === "short") where.push("duration_seconds IS NOT NULL AND duration_seconds <= 60");
  else if (opts.duration === "long") where.push("(duration_seconds IS NULL OR duration_seconds > 60)");

  let order = "COALESCE(published_at, imported_at) DESC";
  switch (opts.sort) {
    case "oldest":
      order = "COALESCE(published_at, imported_at) ASC";
      break;
    case "views":
      order = "views DESC";
      break;
    case "likes":
      order = "likes DESC";
      break;
    case "comments":
      order = "comments DESC";
      break;
    case "engagement":
      order = "(CAST(likes + comments AS REAL) / MAX(views, 1)) DESC";
      break;
    case "recent":
    default:
      break;
  }

  const sql = `SELECT * FROM videos ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ?`;
  args.push(limit);
  return db.prepare(sql).all(...args) as Video[];
}

/** Lightweight list used by the chat attachment picker. No description payload. */
export function searchVideosLite(q: string, limit = 20): {
  id: string; title: string; views: number; likes: number;
  published_at: number | null; thumbnail_url: string | null; duration_seconds: number | null;
}[] {
  const like = `%${q.trim()}%`;
  const activeId = getActiveChannelId();
  if (!q.trim()) {
    if (activeId) {
      return db.prepare(
        `SELECT id, title, views, likes, published_at, thumbnail_url, duration_seconds
         FROM videos WHERE channel_id = ?
         ORDER BY COALESCE(published_at, imported_at) DESC LIMIT ?`
      ).all(activeId, limit) as never;
    }
    return db.prepare(
      `SELECT id, title, views, likes, published_at, thumbnail_url, duration_seconds
       FROM videos ORDER BY COALESCE(published_at, imported_at) DESC LIMIT ?`
    ).all(limit) as never;
  }
  if (activeId) {
    return db.prepare(
      `SELECT id, title, views, likes, published_at, thumbnail_url, duration_seconds
       FROM videos WHERE (title LIKE ? OR description LIKE ?) AND channel_id = ?
       ORDER BY COALESCE(published_at, imported_at) DESC LIMIT ?`
    ).all(like, like, activeId, limit) as never;
  }
  return db.prepare(
    `SELECT id, title, views, likes, published_at, thumbnail_url, duration_seconds
     FROM videos WHERE title LIKE ? OR description LIKE ?
     ORDER BY COALESCE(published_at, imported_at) DESC LIMIT ?`
  ).all(like, like, limit) as never;
}

/** Aggregates for the dashboard: top/bottom performers + outliers. */
export function dashboardAggregates(): {
  topByViews: Video[];
  topByEngagement: (Video & { engagement: number })[];
  bottomByViews: Video[];
  outliers: (Video & { zscore: number })[];
  byMonth: { month: string; count: number; views: number }[];
} {
  // Scope to the active channel — Dashboard widgets must reflect the channel
  // the user is currently viewing in the switcher, not a mash-up of every
  // connected channel. (Pre-multi-channel installs have no active id and
  // see all videos, which is the same behaviour as before.)
  const activeId = getActiveChannelId();
  const allVideos = (
    activeId
      ? db.prepare(`SELECT * FROM videos WHERE channel_id = ?`).all(activeId)
      : db.prepare(`SELECT * FROM videos`).all()
  ) as Video[];
  const total = allVideos.length;
  if (total === 0) {
    return { topByViews: [], topByEngagement: [], bottomByViews: [], outliers: [], byMonth: [] };
  }

  const topByViews = [...allVideos].sort((a, b) => b.views - a.views).slice(0, 5);
  const bottomByViews = [...allVideos]
    .filter((v) => v.views > 0)
    .sort((a, b) => a.views - b.views)
    .slice(0, 5);
  const topByEngagement = allVideos
    .map((v) => ({ ...v, engagement: (v.likes + v.comments) / Math.max(v.views, 1) }))
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 5);

  // Z-score over views. Videos with |z| >= 2 are outliers.
  const mean = allVideos.reduce((s, v) => s + v.views, 0) / total;
  const variance = allVideos.reduce((s, v) => s + (v.views - mean) ** 2, 0) / total;
  const std = Math.sqrt(variance) || 1;
  const outliers = allVideos
    .map((v) => ({ ...v, zscore: (v.views - mean) / std }))
    .filter((v) => Math.abs(v.zscore) >= 2)
    .sort((a, b) => Math.abs(b.zscore) - Math.abs(a.zscore))
    .slice(0, 10);

  // Monthly rollup over the last 18 months.
  const monthMap = new Map<string, { count: number; views: number }>();
  for (const v of allVideos) {
    if (!v.published_at) continue;
    const d = new Date(v.published_at * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const cur = monthMap.get(key) ?? { count: 0, views: 0 };
    cur.count += 1;
    cur.views += v.views;
    monthMap.set(key, cur);
  }
  const byMonth = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-18)
    .map(([month, v]) => ({ month, ...v }));

  return { topByViews, topByEngagement, bottomByViews, outliers, byMonth };
}

/* ---------- App logs (observability) ----------
 * Declared at module scope (not inside initSchema) so the table is guaranteed
 * to exist even when the better-sqlite3 handle is cached on `global.__sqlite`
 * across Next.js hot reloads. initSchema only runs on the very first import;
 * module-level db.exec runs every import, which is what we want for schema
 * added in later patches. */

db.exec(`
  CREATE TABLE IF NOT EXISTS app_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    level TEXT NOT NULL,
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT,
    stack TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON app_logs(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_level ON app_logs(level);
  CREATE INDEX IF NOT EXISTS idx_logs_source ON app_logs(source);
`);

/* ---------- Deepgram transcription usage + jobs ---------- */
// Declared at module scope for the same reason as app_logs — survives hot
// reloads and ensures a newly-added integration always has its tables.

db.exec(`
  -- Per-transcription ledger. One row = one video successfully transcribed
  -- via Deepgram. Used to compute total spend and show a running cost on
  -- the Integrations page. Cost is stored in cents to avoid float drift.
  CREATE TABLE IF NOT EXISTS deepgram_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    cost_cents INTEGER NOT NULL,
    model TEXT NOT NULL,
    transcribed_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_deepgram_usage_video ON deepgram_usage(video_id);
  CREATE INDEX IF NOT EXISTS idx_deepgram_usage_ts ON deepgram_usage(transcribed_at DESC);

  -- Batch job tracker. The "Transcribe all missing" button kicks off a
  -- server-side background task; the UI polls this row for progress. Only
  -- one job runs at a time — new jobs wait for the current to finish.
  CREATE TABLE IF NOT EXISTS transcription_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    completed_at INTEGER,
    total INTEGER NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    current_video_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tx_jobs_status ON transcription_jobs(status);

  -- Bulk comment-sync progress tracking. Same shape as transcription_jobs
  -- minus cost_cents (YouTube Data API comments are quota, not dollars)
  -- plus comments_added so the banner can show "12,341 new comments
  -- across 87 videos".
  CREATE TABLE IF NOT EXISTS comment_sync_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    completed_at INTEGER,
    total INTEGER NOT NULL,                  -- videos to process
    done INTEGER NOT NULL DEFAULT 0,         -- videos processed
    failed INTEGER NOT NULL DEFAULT 0,       -- videos that errored
    comments_added INTEGER NOT NULL DEFAULT 0, -- total comments inserted across the batch
    current_video_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cs_jobs_status ON comment_sync_jobs(status);

  -- Hook-analysis batch progress tracking. Same shape as comment_sync_jobs
  -- (videos in / done / failed / status) plus channel_id so the banner
  -- can show "Analyzing hooks on <channel>" and the boot-cleanup logic
  -- doesn't need a separate code path. No cost column: Claude usage is
  -- already tracked centrally in claude_usage, and per-hook spend is
  -- a fraction of a cent — not worth a dedicated ledger here.
  CREATE TABLE IF NOT EXISTS hook_analysis_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    completed_at INTEGER,
    channel_id TEXT,                         -- which channel this batch was queued for
    total INTEGER NOT NULL,                  -- videos to analyse
    done INTEGER NOT NULL DEFAULT 0,         -- videos with hooks now stored
    failed INTEGER NOT NULL DEFAULT 0,       -- videos that errored (Claude error, parse fail, short transcript)
    current_video_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ha_jobs_status ON hook_analysis_jobs(status);

  -- Per-turn Claude spend ledger. One row = one chat turn (user message →
  -- final assistant response). Tracks tokens separately for executor and
  -- advisor so we can see where the money actually goes. Cost in
  -- millicents (1/1000 of a cent) for precision — at Sonnet rates a tiny
  -- 500-token turn rounds down to 0 cents otherwise.
  CREATE TABLE IF NOT EXISTS claude_usage (
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
    active_tools TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_claude_usage_ts ON claude_usage(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_claude_usage_session ON claude_usage(session_id);

  -- Per-video stat snapshots used by the alerts feature. Each poll
  -- inserts one row per monitored video; the rule engine compares the
  -- latest row to a prior one to compute deltas / velocities. Snapshots
  -- older than 7 days are auto-trimmed. (Originally views-only - likes
  -- and comments were added when alerts went rule-based; the migration
  -- below ALTERs the table on existing installs.)
  CREATE TABLE IF NOT EXISTS video_view_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    views INTEGER NOT NULL,
    likes INTEGER,
    comments INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_view_snapshots_video_ts ON video_view_snapshots(video_id, ts DESC);

  -- Per-video alert state. Records when we last fired so we don't spam
  -- on every poll while velocity stays elevated. Kept around for the
  -- legacy single-rule path; the new multi-rule engine uses
  -- alert_fires (below) which is keyed by (rule_id, video_id).
  CREATE TABLE IF NOT EXISTS alert_state (
    video_id TEXT PRIMARY KEY,
    last_fired_at INTEGER NOT NULL,
    last_velocity REAL NOT NULL
  );

  -- User-defined alert rules. Replaces the old single-threshold model.
  -- Each rule combines (metric × comparison × threshold) so the user
  -- can stack as many notifications as they want — e.g. one rule for
  -- "views/hour > 500" plus a separate one for "total views ≥ 100k"
  -- plus another for "comments delta in last 6h ≥ 50".
  --
  -- type:        "velocity" - (current - prior) / hours_elapsed >= threshold
  --              "total_milestone" - current >= threshold, fires once per video
  --              "delta_window" - current - prior_within_window >= threshold
  -- metric:      "views" | "likes" | "comments"
  -- scope:       "recent_n" — most recent N uploads (scope_value = N)
  --              "all" — every video in the active channel
  -- channel_id:  null = monitor whichever channel is active at poll time;
  --              specific id = always evaluate against that channel.
  -- cooldown_minutes: don't re-fire the same rule on the same video
  --              more often than this; ignored when fire_once is 1.
  -- fire_once:   for milestones — fire exactly once per video per rule
  --              (crossing 100k views shouldn't ping every poll forever).
  CREATE TABLE IF NOT EXISTS alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    enabled INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    metric TEXT NOT NULL,
    threshold REAL NOT NULL,
    window_minutes INTEGER,
    scope TEXT NOT NULL DEFAULT 'recent_n',
    scope_value INTEGER,
    channel_id TEXT,
    cooldown_minutes INTEGER NOT NULL DEFAULT 60,
    fire_once INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- One row per rule firing. Used both for the cooldown / fire_once
  -- gates and so we can show a recent-alerts feed in the UI.
  CREATE TABLE IF NOT EXISTS alert_fires (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    fired_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    metric_value REAL,
    delivered INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_alert_fires_rule_video ON alert_fires (rule_id, video_id, fired_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alert_fires_recent ON alert_fires (fired_at DESC);
`);

// Backfill the snapshot table on existing installs — they pre-date the
// likes/comments columns, so SQLite would 500 on the new INSERT shape.
// Best-effort: if either ALTER fails (column already exists, table
// doesn't exist yet on a brand-new install), we log and move on.
{
  const cols = db
    .prepare(`PRAGMA table_info(video_view_snapshots)`)
    .all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  if (cols.length && !have.has("likes")) {
    try {
      db.exec(`ALTER TABLE video_view_snapshots ADD COLUMN likes INTEGER`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[db] add likes column to snapshots failed (ignored):", err);
    }
  }
  if (cols.length && !have.has("comments")) {
    try {
      db.exec(`ALTER TABLE video_view_snapshots ADD COLUMN comments INTEGER`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[db] add comments column to snapshots failed (ignored):", err);
    }
  }
}

// Per-channel attribute columns (editor name, CMS network info,
// monetization status, free-form notes). These are user-managed
// metadata layered on top of the channels table — set via the
// /integrations channel row "Edit" expansion. Idempotent migration:
// each ALTER is wrapped in try/catch so re-runs (or running on a
// fresh install where the columns already exist via CREATE TABLE)
// are no-ops.
{
  const channelCols = (
    db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[]
  ).map((c) => c.name);
  const newColumns: { name: string; type: string }[] = [
    // Who edits videos for this channel — used by the editor billing
    // card to group "you owe John X, you owe Anna Y".
    { name: "editor_name", type: "TEXT" },
    // CMS / MCN that owns the channel (e.g. "Freedom!", "Spotter").
    // Used to group cross-channel earnings by network and to apply
    // the network's revenue cut.
    { name: "cms_name", type: "TEXT" },
    // Percentage the CMS deducts from gross revenue, 0-50. UI
    // surfaces "Net after CMS cut" computed as gross * (1 - cut/100).
    { name: "cms_cut_percent", type: "REAL" },
    // AdSense account label — informational tag for grouping channels
    // that share an AdSense account. No revenue math.
    { name: "adsense_name", type: "TEXT" },
    // monetized | pending | not_eligible. Drives the dashboard
    // "Monetized only" / "All" filter and segregates the editor
    // billing card so non-monetised channels stay visible without
    // mixing into the revenue widgets.
    { name: "monetization_status", type: "TEXT" },
    // Free-form scratchpad — anything the user wants to remember.
    { name: "notes", type: "TEXT" },
    // Forecast input for the Editor Billing card. The user agrees an
    // upload schedule with the editor (e.g. "8 videos a month at $20
    // each = $160/month forecast"); the dashboard sums this across
    // every channel for total expected monthly editor cost.
    { name: "expected_videos_per_month", type: "INTEGER" },
  ];
  for (const col of newColumns) {
    if (channelCols.includes(col.name)) continue;
    try {
      db.exec(`ALTER TABLE channels ADD COLUMN ${col.name} ${col.type}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[db] add channels.${col.name} failed (ignored):`,
        err
      );
    }
  }
}

// Tags + channel_tags m:n. Replaces the old per-channel cms_name /
// adsense_name columns with a flexible, multi-tag-per-channel system:
// "tags you can put on each channel, and a %, that group them into
// batches" — friend's actual ask. A tag can optionally carry a
// `cut_percent` so the dashboard can compute net-after-cut for any
// channel tagged with it (CMS networks, AdSense-tier deals, etc).
// Tags without a cut are just labels (genre, language, internal
// grouping, "monetised content network", etc).
db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    cut_percent REAL,
    color TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS channel_tags (
    channel_id TEXT NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (channel_id, tag_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_channel_tags_channel ON channel_tags(channel_id);
  CREATE INDEX IF NOT EXISTS idx_channel_tags_tag ON channel_tags(tag_id);
`);

// One-shot migration: lift the legacy cms_name / cms_cut_percent /
// adsense_name fields (now removed from the UI) into proper tags so
// existing installs don't lose data. Idempotent via the
// `tags.legacyMigrated` setting flag.
{
  const migrated = getSetting("tags.legacyMigrated") === "1";
  if (!migrated) {
    try {
      const channelsWithMeta = db
        .prepare(
          `SELECT id, cms_name, cms_cut_percent, adsense_name
           FROM channels
           WHERE cms_name IS NOT NULL OR adsense_name IS NOT NULL`
        )
        .all() as {
          id: string;
          cms_name: string | null;
          cms_cut_percent: number | null;
          adsense_name: string | null;
        }[];
      const tx = db.transaction(() => {
        const upsertTag = db.prepare(
          `INSERT INTO tags (name, cut_percent)
           VALUES (?, ?)
           ON CONFLICT(name) DO UPDATE SET
             cut_percent = COALESCE(tags.cut_percent, excluded.cut_percent)
           RETURNING id`
        );
        const attach = db.prepare(
          `INSERT OR IGNORE INTO channel_tags (channel_id, tag_id) VALUES (?, ?)`
        );
        for (const c of channelsWithMeta) {
          if (c.cms_name && c.cms_name.trim()) {
            const row = upsertTag.get(
              c.cms_name.trim(),
              c.cms_cut_percent ?? null
            ) as { id: number } | undefined;
            if (row) attach.run(c.id, row.id);
          }
          if (c.adsense_name && c.adsense_name.trim()) {
            const row = upsertTag.get(c.adsense_name.trim(), null) as
              | { id: number }
              | undefined;
            if (row) attach.run(c.id, row.id);
          }
        }
      });
      tx();
      setSetting("tags.legacyMigrated", "1");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[db] tags legacy migration failed (ignored):", err);
    }
  }
}

/* ---------- Comments (Phase 2 — schema lives here so SQL tool sees it) ---------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    parent_id TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id);
  CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
    video_id UNINDEXED, comment_id UNINDEXED, author UNINDEXED, text
  );
`);

export type Comment = {
  id: string;
  video_id: string;
  parent_id: string | null;
  author: string | null;
  author_channel_id: string | null;
  text: string;
  like_count: number;
  reply_count: number;
  published_at: number | null;
  updated_at: number | null;
  fetched_at: number;
};

export function upsertComment(c: Partial<Comment> & { id: string; video_id: string; text: string }): void {
  db.prepare(
    `INSERT INTO comments (id, video_id, parent_id, author, author_channel_id, text, like_count, reply_count, published_at, updated_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(id) DO UPDATE SET
       text = excluded.text,
       like_count = excluded.like_count,
       reply_count = excluded.reply_count,
       updated_at = excluded.updated_at,
       fetched_at = excluded.fetched_at`
  ).run(
    c.id, c.video_id, c.parent_id ?? null, c.author ?? null, c.author_channel_id ?? null,
    c.text, c.like_count ?? 0, c.reply_count ?? 0, c.published_at ?? null, c.updated_at ?? null
  );
  // Keep FTS in sync: remove any stale row for this comment id first, then insert.
  // Without this, re-syncing the same comment accumulates duplicate FTS rows and
  // poisons search results.
  db.prepare(`DELETE FROM comments_fts WHERE comment_id = ?`).run(c.id);
  db.prepare(
    `INSERT INTO comments_fts (video_id, comment_id, author, text) VALUES (?, ?, ?, ?)`
  ).run(c.video_id, c.id, c.author ?? "", c.text);
}

/**
 * Upsert many comments in one transaction. Much faster than calling
 * upsertComment in a loop because we avoid the JS ↔ SQLite round-trip cost
 * per-row and we only parse/plan the statements once.
 */
export function upsertComments(
  comments: (Partial<Comment> & { id: string; video_id: string; text: string })[]
): void {
  const insertMain = db.prepare(
    `INSERT INTO comments (id, video_id, parent_id, author, author_channel_id, text, like_count, reply_count, published_at, updated_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(id) DO UPDATE SET
       text = excluded.text,
       like_count = excluded.like_count,
       reply_count = excluded.reply_count,
       updated_at = excluded.updated_at,
       fetched_at = excluded.fetched_at`
  );
  const deleteFts = db.prepare(`DELETE FROM comments_fts WHERE comment_id = ?`);
  const insertFts = db.prepare(
    `INSERT INTO comments_fts (video_id, comment_id, author, text) VALUES (?, ?, ?, ?)`
  );
  const tx = db.transaction(
    (rows: (Partial<Comment> & { id: string; video_id: string; text: string })[]) => {
      for (const c of rows) {
        insertMain.run(
          c.id, c.video_id, c.parent_id ?? null, c.author ?? null, c.author_channel_id ?? null,
          c.text, c.like_count ?? 0, c.reply_count ?? 0, c.published_at ?? null, c.updated_at ?? null
        );
        deleteFts.run(c.id);
        insertFts.run(c.video_id, c.id, c.author ?? "", c.text);
      }
    }
  );
  tx(comments);
}

export function listTopLevelComments(videoId: string, limit = 50, offset = 0): Comment[] {
  return db.prepare(
    `SELECT * FROM comments WHERE video_id = ? AND parent_id IS NULL
     ORDER BY like_count DESC, published_at DESC LIMIT ? OFFSET ?`
  ).all(videoId, limit, offset) as Comment[];
}

export function listReplies(parentId: string): Comment[] {
  return db.prepare(
    `SELECT * FROM comments WHERE parent_id = ?
     ORDER BY published_at ASC`
  ).all(parentId) as Comment[];
}

export function getComment(id: string): Comment | undefined {
  return db.prepare(`SELECT * FROM comments WHERE id = ?`).get(id) as Comment | undefined;
}

/**
 * FTS5 search across ALL cached comments. Returns hits with the parent video
 * title joined in so the caller can show context without a second query.
 */
export function searchComments(
  query: string,
  limit = 30
): (Comment & { video_title: string | null })[] {
  // Escape FTS5 metachars by quoting the whole phrase.
  const safeQuery = `"${query.replace(/"/g, '""')}"`;
  // Scope to the active channel — comment hits from a different channel
  // would just confuse the user reading results in their channel context.
  const activeId = getActiveChannelId();
  if (activeId) {
    return db
      .prepare(
        `SELECT c.*, v.title as video_title
         FROM comments_fts fts
         JOIN comments c ON c.id = fts.comment_id
         JOIN videos v ON v.id = c.video_id
         WHERE comments_fts MATCH ? AND v.channel_id = ?
         ORDER BY bm25(comments_fts) ASC, c.like_count DESC
         LIMIT ?`
      )
      .all(safeQuery, activeId, limit) as (Comment & { video_title: string | null })[];
  }
  return db
    .prepare(
      `SELECT c.*, v.title as video_title
       FROM comments_fts fts
       JOIN comments c ON c.id = fts.comment_id
       LEFT JOIN videos v ON v.id = c.video_id
       WHERE comments_fts MATCH ?
       ORDER BY bm25(comments_fts) ASC, c.like_count DESC
       LIMIT ?`
    )
    .all(safeQuery, limit) as (Comment & { video_title: string | null })[];
}

export function commentCount(videoId: string): { total: number; topLevel: number; fetchedAt: number | null } {
  const row = db.prepare(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END) as topLevel,
            MAX(fetched_at) as fetchedAt
     FROM comments WHERE video_id = ?`
  ).get(videoId) as { total: number; topLevel: number; fetchedAt: number | null };
  return row;
}

export function getVideo(id: string): Video | undefined {
  return db
    .prepare(`SELECT * FROM videos WHERE id = ?`)
    .get(id) as Video | undefined;
}

export function videoStats(): {
  total: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  avgViews: number;
} {
  // Headline KPI tiles must reflect the active channel only — otherwise
  // switching channels wouldn't change the numbers.
  const activeId = getActiveChannelId();
  const row = (
    activeId
      ? db
          .prepare(
            `SELECT COUNT(*) as total,
                    COALESCE(SUM(views),0) as totalViews,
                    COALESCE(SUM(likes),0) as totalLikes,
                    COALESCE(SUM(comments),0) as totalComments
             FROM videos WHERE channel_id = ?`
          )
          .get(activeId)
      : db
          .prepare(
            `SELECT COUNT(*) as total,
                    COALESCE(SUM(views),0) as totalViews,
                    COALESCE(SUM(likes),0) as totalLikes,
                    COALESCE(SUM(comments),0) as totalComments
             FROM videos`
          )
          .get()
  ) as { total: number; totalViews: number; totalLikes: number; totalComments: number };
  const avgViews = row.total > 0 ? Math.round(row.totalViews / row.total) : 0;
  return { ...row, avgViews };
}

/* ---------- Deep channel analytics ---------- */

export type ChannelAnalytics = {
  core: {
    total: number;
    totalViews: number;
    totalLikes: number;
    totalComments: number;
    avgViews: number;
    medianViews: number;
    avgLikes: number;
    avgComments: number;
    engagementRate: number; // (likes+comments)/views
    likesPerView: number;
    commentsPerView: number;
  };
  performance: {
    minViews: number;
    maxViews: number;
    medianViews: number;
    p25Views: number;
    p75Views: number;
    stdevViews: number;
    aboveMedianPct: number;
    topViralPct: number; // % of subs the best video reached
  };
  contentMix: {
    shorts: { count: number; totalViews: number; avgViews: number };
    longForm: { count: number; totalViews: number; avgViews: number };
    durationBuckets: { label: string; count: number; totalViews: number }[];
  };
  transcripts: {
    total: number;
    withTranscript: number;
    coveragePct: number;
    avgChars: number;
    languages: { lang: string; count: number }[];
  };
  cadence: {
    firstUploadTs: number | null;
    lastUploadTs: number | null;
    channelAgeDays: number | null;
    daysSinceLastUpload: number | null;
    avgDaysBetween: number | null;
    uploadsLast30d: number;
    uploadsLast90d: number;
    activeMonths: number; // months with ≥1 upload since first upload
    silentMonths: number;
  };
  patterns: {
    byDayOfWeek: { day: number; label: string; count: number; avgViews: number }[];
    byHour: { hour: number; count: number }[]; // 0-23 UTC
    byMonth: { month: string; count: number; views: number }[];
  };
  themes: {
    topTags: { tag: string; count: number }[];
    topTitleWords: { word: string; count: number }[];
    avgTitleLength: number;
  };
  growth: {
    recent5AvgViews: number | null;
    previous5AvgViews: number | null;
    growthPct: number | null;
    recent10AvgViews: number | null;
    previous10AvgViews: number | null;
    trend: "up" | "down" | "flat" | "insufficient-data";
  };
};

/**
 * Compute a rich analytics bundle for the currently bound channel. Pure
 * aggregation over the `videos` + `transcripts` tables — no external API
 * calls. Meant for the Channel Details page where we want to surface
 * everything we can actually see, not just the 4 headline KPIs.
 */
export function channelAnalytics(): ChannelAnalytics | null {
  type VideoRow = {
    id: string;
    title: string;
    views: number;
    likes: number;
    comments: number;
    duration_seconds: number | null;
    published_at: number | null;
    tags: string | null;
  };
  // Scope every aggregate below to the active channel so the deep-analytics
  // page reflects the channel currently selected in the switcher.
  const activeId = getActiveChannelId();
  const videos = (
    activeId
      ? db
          .prepare(
            `SELECT id, title, views, likes, comments, duration_seconds, published_at, tags
             FROM videos WHERE channel_id = ?`
          )
          .all(activeId)
      : db
          .prepare(
            `SELECT id, title, views, likes, comments, duration_seconds, published_at, tags
             FROM videos`
          )
          .all()
  ) as VideoRow[];
  if (videos.length === 0) return null;

  const totalViews = videos.reduce((s, v) => s + (v.views ?? 0), 0);
  const totalLikes = videos.reduce((s, v) => s + (v.likes ?? 0), 0);
  const totalComments = videos.reduce((s, v) => s + (v.comments ?? 0), 0);
  const avgViews = Math.round(totalViews / videos.length);
  const avgLikes = Math.round(totalLikes / videos.length);
  const avgComments = Math.round(totalComments / videos.length);

  // Percentile helpers
  const sortedViews = [...videos].map((v) => v.views ?? 0).sort((a, b) => a - b);
  const pct = (p: number) => {
    if (sortedViews.length === 0) return 0;
    const idx = Math.min(sortedViews.length - 1, Math.floor((p / 100) * sortedViews.length));
    return sortedViews[idx];
  };
  const medianViews = pct(50);
  const p25Views = pct(25);
  const p75Views = pct(75);
  const minViews = sortedViews[0] ?? 0;
  const maxViews = sortedViews[sortedViews.length - 1] ?? 0;

  const mean = totalViews / videos.length;
  const variance =
    videos.reduce((s, v) => s + Math.pow((v.views ?? 0) - mean, 2), 0) / videos.length;
  const stdevViews = Math.round(Math.sqrt(variance));

  const aboveMedianCount = videos.filter((v) => (v.views ?? 0) > medianViews).length;
  const aboveMedianPct = (aboveMedianCount / videos.length) * 100;

  const ch = getChannel();
  const topViralPct =
    ch?.subscriber_count && ch.subscriber_count > 0
      ? (maxViews / ch.subscriber_count) * 100
      : 0;

  const engagementRate = totalViews > 0 ? (totalLikes + totalComments) / totalViews : 0;
  const likesPerView = totalViews > 0 ? totalLikes / totalViews : 0;
  const commentsPerView = totalViews > 0 ? totalComments / totalViews : 0;

  // Content mix — Shorts (≤60s) vs long-form
  const shortsArr = videos.filter(
    (v) => typeof v.duration_seconds === "number" && v.duration_seconds <= 60
  );
  const longArr = videos.filter(
    (v) => !v.duration_seconds || v.duration_seconds > 60
  );
  const sumViews = (arr: VideoRow[]) => arr.reduce((s, v) => s + (v.views ?? 0), 0);
  const avgOf = (arr: VideoRow[]) =>
    arr.length > 0 ? Math.round(sumViews(arr) / arr.length) : 0;

  const bucketDefs: { label: string; min: number; max: number }[] = [
    { label: "<1m", min: 0, max: 60 },
    { label: "1–5m", min: 60, max: 300 },
    { label: "5–15m", min: 300, max: 900 },
    { label: "15–30m", min: 900, max: 1800 },
    { label: "30m+", min: 1800, max: Number.POSITIVE_INFINITY },
  ];
  const durationBuckets = bucketDefs.map((b) => {
    const xs = videos.filter((v) => {
      const d = v.duration_seconds ?? 0;
      return d >= b.min && d < b.max;
    });
    return { label: b.label, count: xs.length, totalViews: sumViews(xs) };
  });

  // Transcripts coverage — scoped to the active channel via JOIN with videos
  // so the % matches the videos count we computed above.
  const transcriptRows = (
    activeId
      ? db
          .prepare(
            `SELECT t.language, t.text
             FROM transcripts t
             JOIN videos v ON v.id = t.video_id
             WHERE v.channel_id = ?`
          )
          .all(activeId)
      : db.prepare(`SELECT language, text FROM transcripts`).all()
  ) as { language: string | null; text: string }[];
  const withTranscript = transcriptRows.length;
  const coveragePct = (withTranscript / videos.length) * 100;
  const avgChars =
    withTranscript > 0
      ? Math.round(
          transcriptRows.reduce((s, r) => s + (r.text?.length ?? 0), 0) / withTranscript
        )
      : 0;
  const langMap = new Map<string, number>();
  for (const r of transcriptRows) {
    const lang = (r.language ?? "unknown").slice(0, 10);
    langMap.set(lang, (langMap.get(lang) ?? 0) + 1);
  }
  const languages = [...langMap.entries()]
    .map(([lang, count]) => ({ lang, count }))
    .sort((a, b) => b.count - a.count);

  // Cadence
  const dated = videos
    .map((v) => v.published_at)
    .filter((t): t is number => typeof t === "number")
    .sort((a, b) => a - b);
  const now = Math.floor(Date.now() / 1000);
  const firstUploadTs = dated[0] ?? null;
  const lastUploadTs = dated[dated.length - 1] ?? null;
  const channelAgeDays = firstUploadTs ? Math.floor((now - firstUploadTs) / 86400) : null;
  const daysSinceLastUpload = lastUploadTs
    ? Math.floor((now - lastUploadTs) / 86400)
    : null;
  let avgDaysBetween: number | null = null;
  if (dated.length >= 2) {
    const totalSpan = dated[dated.length - 1] - dated[0];
    avgDaysBetween = Math.round(totalSpan / (dated.length - 1) / 86400);
  }
  const uploadsLast30d = dated.filter((t) => now - t <= 30 * 86400).length;
  const uploadsLast90d = dated.filter((t) => now - t <= 90 * 86400).length;

  // Count active (≥1 upload) vs silent months since first upload
  const monthKeys = new Set<string>();
  for (const t of dated) {
    const d = new Date(t * 1000);
    monthKeys.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  let totalMonths = 0;
  if (firstUploadTs) {
    const first = new Date(firstUploadTs * 1000);
    const nowDate = new Date();
    totalMonths =
      (nowDate.getUTCFullYear() - first.getUTCFullYear()) * 12 +
      (nowDate.getUTCMonth() - first.getUTCMonth()) +
      1;
  }
  const activeMonths = monthKeys.size;
  const silentMonths = Math.max(0, totalMonths - activeMonths);

  // Patterns
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dowBuckets: { count: number; totalViews: number }[] = Array.from(
    { length: 7 },
    () => ({ count: 0, totalViews: 0 })
  );
  for (const v of videos) {
    if (!v.published_at) continue;
    const d = new Date(v.published_at * 1000);
    const dow = d.getUTCDay();
    dowBuckets[dow].count += 1;
    dowBuckets[dow].totalViews += v.views ?? 0;
  }
  const byDayOfWeek = dowBuckets.map((b, day) => ({
    day,
    label: dayLabels[day],
    count: b.count,
    avgViews: b.count > 0 ? Math.round(b.totalViews / b.count) : 0,
  }));

  const hourBuckets: number[] = Array.from({ length: 24 }, () => 0);
  for (const v of videos) {
    if (!v.published_at) continue;
    const d = new Date(v.published_at * 1000);
    hourBuckets[d.getUTCHours()] += 1;
  }
  const byHour = hourBuckets.map((count, hour) => ({ hour, count }));

  const monthMap = new Map<string, { count: number; views: number }>();
  for (const v of videos) {
    if (!v.published_at) continue;
    const d = new Date(v.published_at * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const cur = monthMap.get(key) ?? { count: 0, views: 0 };
    cur.count += 1;
    cur.views += v.views ?? 0;
    monthMap.set(key, cur);
  }
  const byMonth = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, ...v }));

  // Themes — tags and title words
  const tagMap = new Map<string, number>();
  for (const v of videos) {
    try {
      const parsed = JSON.parse(v.tags ?? "[]");
      if (Array.isArray(parsed)) {
        for (const tag of parsed) {
          const t = String(tag).toLowerCase().trim();
          if (!t) continue;
          tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
        }
      }
    } catch {
      /* ignore malformed */
    }
  }
  const topTags = [...tagMap.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }));

  const stopWords = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
    "are", "was", "were", "be", "by", "at", "from", "that", "this", "it", "as",
    "how", "why", "what", "when", "who", "i", "you", "my", "your", "our", "we",
    "і", "та", "а", "чи", "як", "до", "з", "на", "по", "від", "що", "це", "цей",
    "my", "мій", "моя", "my", "most",
  ]);
  const wordMap = new Map<string, number>();
  let totalTitleChars = 0;
  for (const v of videos) {
    totalTitleChars += (v.title ?? "").length;
    const words = (v.title ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !stopWords.has(w));
    for (const w of words) {
      wordMap.set(w, (wordMap.get(w) ?? 0) + 1);
    }
  }
  const topTitleWords = [...wordMap.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([word, count]) => ({ word, count }));
  const avgTitleLength = Math.round(totalTitleChars / videos.length);

  // Growth trajectory — compare recent vs previous N uploads by published date
  const publishedSorted = videos
    .filter((v): v is VideoRow & { published_at: number } => !!v.published_at)
    .sort((a, b) => b.published_at - a.published_at);
  const avgN = (arr: typeof publishedSorted) =>
    arr.length > 0
      ? Math.round(arr.reduce((s, v) => s + (v.views ?? 0), 0) / arr.length)
      : null;
  const recent5AvgViews = avgN(publishedSorted.slice(0, 5));
  const previous5AvgViews = avgN(publishedSorted.slice(5, 10));
  const recent10AvgViews = avgN(publishedSorted.slice(0, 10));
  const previous10AvgViews = avgN(publishedSorted.slice(10, 20));
  let growthPct: number | null = null;
  let trend: ChannelAnalytics["growth"]["trend"] = "insufficient-data";
  if (recent5AvgViews !== null && previous5AvgViews !== null && previous5AvgViews > 0) {
    growthPct = ((recent5AvgViews - previous5AvgViews) / previous5AvgViews) * 100;
    trend = Math.abs(growthPct) < 10 ? "flat" : growthPct > 0 ? "up" : "down";
  } else if (publishedSorted.length < 10) {
    trend = "insufficient-data";
  }

  return {
    core: {
      total: videos.length,
      totalViews,
      totalLikes,
      totalComments,
      avgViews,
      medianViews,
      avgLikes,
      avgComments,
      engagementRate,
      likesPerView,
      commentsPerView,
    },
    performance: {
      minViews,
      maxViews,
      medianViews,
      p25Views,
      p75Views,
      stdevViews,
      aboveMedianPct,
      topViralPct,
    },
    contentMix: {
      shorts: {
        count: shortsArr.length,
        totalViews: sumViews(shortsArr),
        avgViews: avgOf(shortsArr),
      },
      longForm: {
        count: longArr.length,
        totalViews: sumViews(longArr),
        avgViews: avgOf(longArr),
      },
      durationBuckets,
    },
    transcripts: {
      total: videos.length,
      withTranscript,
      coveragePct,
      avgChars,
      languages,
    },
    cadence: {
      firstUploadTs,
      lastUploadTs,
      channelAgeDays,
      daysSinceLastUpload,
      avgDaysBetween,
      uploadsLast30d,
      uploadsLast90d,
      activeMonths,
      silentMonths,
    },
    patterns: {
      byDayOfWeek,
      byHour,
      byMonth,
    },
    themes: {
      topTags,
      topTitleWords,
      avgTitleLength,
    },
    growth: {
      recent5AvgViews,
      previous5AvgViews,
      growthPct,
      recent10AvgViews,
      previous10AvgViews,
      trend,
    },
  };
}

/* ---------- App logs (observability) ---------- */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type AppLog = {
  id: number;
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  context: string | null;
  stack: string | null;
};

const LOG_RETENTION_ROWS = 5000;

export function writeLog(entry: {
  level: LogLevel;
  source: string;
  message: string;
  context?: unknown;
  stack?: string | null;
}): void {
  const contextJson = (() => {
    if (entry.context === undefined || entry.context === null) return null;
    try {
      return JSON.stringify(entry.context);
    } catch {
      // A circular object shouldn't crash the logger — fall back to tagging it.
      return JSON.stringify({ _serializationError: true });
    }
  })();
  db.prepare(
    `INSERT INTO app_logs (level, source, message, context, stack)
     VALUES (?, ?, ?, ?, ?)`
  ).run(entry.level, entry.source, entry.message, contextJson, entry.stack ?? null);

  // Cheap retention: after every error and occasionally for others, trim the
  // oldest rows so the table doesn't grow forever.
  if (entry.level === "error" || Math.random() < 0.02) {
    db.prepare(
      `DELETE FROM app_logs WHERE id IN (
         SELECT id FROM app_logs ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?
       )`
    ).run(LOG_RETENTION_ROWS);
  }
}

export function listLogs(opts: {
  level?: LogLevel | "all";
  source?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): AppLog[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const offset = Math.max(0, opts.offset ?? 0);
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.level && opts.level !== "all") {
    where.push("level = ?");
    args.push(opts.level);
  }
  if (opts.source && opts.source.trim() && opts.source !== "all") {
    where.push("source = ?");
    args.push(opts.source);
  }
  if (opts.search && opts.search.trim()) {
    where.push("(message LIKE ? OR context LIKE ?)");
    const q = `%${opts.search.trim()}%`;
    args.push(q, q);
  }
  const sql = `SELECT * FROM app_logs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`;
  args.push(limit, offset);
  return db.prepare(sql).all(...args) as AppLog[];
}

export function logStats(): {
  total: number;
  byLevel: Record<LogLevel, number>;
  sources: string[];
  last24hErrors: number;
} {
  const total = (db.prepare(`SELECT COUNT(*) as n FROM app_logs`).get() as { n: number }).n;
  const rows = db
    .prepare(`SELECT level, COUNT(*) as n FROM app_logs GROUP BY level`)
    .all() as { level: LogLevel; n: number }[];
  const byLevel: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const r of rows) byLevel[r.level] = r.n;
  const sources = (
    db.prepare(`SELECT DISTINCT source FROM app_logs ORDER BY source`).all() as {
      source: string;
    }[]
  ).map((r) => r.source);
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
  const last24hErrors = (
    db.prepare(`SELECT COUNT(*) as n FROM app_logs WHERE level = 'error' AND ts >= ?`).get(cutoff) as {
      n: number;
    }
  ).n;
  return { total, byLevel, sources, last24hErrors };
}

/* ---------- Editor billing ---------- */

/**
 * Monthly editor compensation breakdown. Built on top of `videos` —
 * counts uploads per month and multiplies by the rate stored in
 * settings ("editor.costPerVideoUsd"). No new tables, just an
 * aggregate over what we already have.
 */
export type EditorBillingMonth = {
  month: string; // YYYY-MM, UTC
  videoCount: number;
  rateUsd: number;
  amountUsd: number;
  videos: { id: string; title: string; published_at: number }[];
};

export function editorBillingByMonth(months = 12): EditorBillingMonth[] {
  // Editor rate is stored per-channel ("editor.costPerVideoUsd.<channelId>")
  // so each channel can have its own per-video price. Falls back to the
  // legacy single-tenant key for backwards compatibility with installs
  // that were configured before multi-channel support landed.
  const activeId = getActiveChannelId();
  const perChannelRate = activeId
    ? getSetting(`editor.costPerVideoUsd.${activeId}`)
    : null;
  const legacyRate = getSetting("editor.costPerVideoUsd");
  const rate = Number(perChannelRate ?? legacyRate ?? "0");
  const rows = (
    activeId
      ? db
          .prepare(
            `SELECT id, title, published_at
             FROM videos
             WHERE published_at IS NOT NULL AND channel_id = ?
             ORDER BY published_at DESC`
          )
          .all(activeId)
      : db
          .prepare(
            `SELECT id, title, published_at
             FROM videos
             WHERE published_at IS NOT NULL
             ORDER BY published_at DESC`
          )
          .all()
  ) as { id: string; title: string; published_at: number }[];

  // Group by YYYY-MM in UTC.
  const map = new Map<string, EditorBillingMonth>();
  for (const v of rows) {
    const d = new Date(v.published_at * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { month: key, videoCount: 0, rateUsd: rate, amountUsd: 0, videos: [] };
      map.set(key, bucket);
    }
    bucket.videoCount += 1;
    bucket.amountUsd = Number((bucket.videoCount * rate).toFixed(2));
    if (bucket.videos.length < 50) bucket.videos.push(v);
  }
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, months);
}

/* ---------- Generic API cache ---------- */

/**
 * Read a cached JSON payload by key. Returns null if missing or expired.
 * Expired rows are not auto-deleted here — `clearExpiredCache` does that
 * on a schedule if anyone ever wires it up.
 */
export function getCached<T>(key: string): T | null {
  const row = db
    .prepare(`SELECT payload, expires_at FROM api_cache WHERE cache_key = ?`)
    .get(key) as { payload: string; expires_at: number } | undefined;
  if (!row) return null;
  if (Math.floor(Date.now() / 1000) >= row.expires_at) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export function setCached(key: string, payload: unknown, ttlSeconds: number): void {
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(1, ttlSeconds);
  db.prepare(
    `INSERT INTO api_cache (cache_key, payload, cached_at, expires_at)
     VALUES (?, ?, strftime('%s','now'), ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload = excluded.payload,
       cached_at = excluded.cached_at,
       expires_at = excluded.expires_at`
  ).run(key, JSON.stringify(payload), expiresAt);
}

export function invalidateCache(keyPrefix: string): number {
  const info = db.prepare(`DELETE FROM api_cache WHERE cache_key LIKE ?`).run(`${keyPrefix}%`);
  return info.changes;
}

/* ---------- Claude usage tracking ---------- */

export type ClaudeUsageRow = {
  id: number;
  session_id: string | null;
  ts: number;
  executor_model: string;
  advisor_model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  advisor_input_tokens: number;
  advisor_output_tokens: number;
  advisor_calls: number;
  cost_millicents: number;
  duration_ms: number;
  iterations: number;
  first_user_msg: string | null;
  active_tools: string | null;
};

export function recordClaudeUsage(entry: {
  sessionId: string | null;
  executorModel: string;
  advisorModel: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  advisorInputTokens: number;
  advisorOutputTokens: number;
  advisorCalls: number;
  costMillicents: number;
  durationMs: number;
  iterations: number;
  firstUserMsg: string | null;
  activeTools: string[];
}): void {
  db.prepare(
    `INSERT INTO claude_usage (
      session_id, executor_model, advisor_model,
      input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
      advisor_input_tokens, advisor_output_tokens, advisor_calls,
      cost_millicents, duration_ms, iterations,
      first_user_msg, active_tools
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.sessionId,
    entry.executorModel,
    entry.advisorModel,
    entry.inputTokens,
    entry.outputTokens,
    entry.cacheWriteTokens,
    entry.cacheReadTokens,
    entry.advisorInputTokens,
    entry.advisorOutputTokens,
    entry.advisorCalls,
    entry.costMillicents,
    entry.durationMs,
    entry.iterations,
    entry.firstUserMsg,
    JSON.stringify(entry.activeTools)
  );
}

export function claudeUsageStats(opts: { limit?: number } = {}): {
  totalCostMillicents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  turns: number;
  last24hCostMillicents: number;
  recent: ClaudeUsageRow[];
} {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const agg = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_millicents),0) as total,
         COALESCE(SUM(input_tokens),0) as inputT,
         COALESCE(SUM(output_tokens),0) as outputT,
         COALESCE(SUM(cache_read_tokens),0) as cacheReadT,
         COUNT(*) as turns
       FROM claude_usage`
    )
    .get() as {
    total: number;
    inputT: number;
    outputT: number;
    cacheReadT: number;
    turns: number;
  };
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
  const last24h = db
    .prepare(`SELECT COALESCE(SUM(cost_millicents),0) as total FROM claude_usage WHERE ts >= ?`)
    .get(cutoff) as { total: number };
  const recent = db
    .prepare(`SELECT * FROM claude_usage ORDER BY ts DESC LIMIT ?`)
    .all(limit) as ClaudeUsageRow[];
  return {
    totalCostMillicents: agg.total,
    totalInputTokens: agg.inputT,
    totalOutputTokens: agg.outputT,
    totalCacheReadTokens: agg.cacheReadT,
    turns: agg.turns,
    last24hCostMillicents: last24h.total,
    recent,
  };
}

export function clearClaudeUsage(): number {
  const info = db.prepare(`DELETE FROM claude_usage`).run();
  return info.changes;
}

/* ---------- Deepgram helpers ---------- */

export type DeepgramUsageRow = {
  id: number;
  video_id: string;
  duration_seconds: number;
  cost_cents: number;
  model: string;
  transcribed_at: number;
};

export function recordDeepgramUsage(entry: {
  videoId: string;
  durationSeconds: number;
  costCents: number;
  model: string;
}): void {
  db.prepare(
    `INSERT INTO deepgram_usage (video_id, duration_seconds, cost_cents, model)
     VALUES (?, ?, ?, ?)`
  ).run(entry.videoId, entry.durationSeconds, entry.costCents, entry.model);
}

export function deepgramStats(): {
  totalCostCents: number;
  totalSeconds: number;
  transcriptCount: number;
  lastUsageAt: number | null;
  last10: DeepgramUsageRow[];
} {
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(cost_cents),0) as totalCost,
              COALESCE(SUM(duration_seconds),0) as totalSeconds,
              COUNT(*) as n,
              MAX(transcribed_at) as lastAt
       FROM deepgram_usage`
    )
    .get() as { totalCost: number; totalSeconds: number; n: number; lastAt: number | null };
  const last10 = db
    .prepare(`SELECT * FROM deepgram_usage ORDER BY transcribed_at DESC LIMIT 10`)
    .all() as DeepgramUsageRow[];
  return {
    totalCostCents: agg.totalCost,
    totalSeconds: agg.totalSeconds,
    transcriptCount: agg.n,
    lastUsageAt: agg.lastAt,
    last10,
  };
}

/**
 * Videos that need a (re-)transcription run. Matches two cases:
 *   1. No transcript row at all.
 *   2. A transcript exists but is suspiciously short relative to video
 *      duration — typically caused by CDN truncation on older runs where
 *      Deepgram only saw the first 30-60 seconds. Heuristic: English speech
 *      is ~15 chars/sec, so anything below 3 chars/sec of the source video
 *      is almost certainly a truncated (or broken) transcript worth redoing.
 * Videos without a known duration are only returned if they have no
 * transcript — we can't judge ratio without a denominator.
 */
export function listVideosMissingTranscript(): {
  id: string;
  title: string;
  duration_seconds: number | null;
}[] {
  const SUSPICIOUS_CHARS_PER_SEC = 3;
  // Bulk-transcribe is initiated from the channel's transcript page, so it
  // must only target the currently selected channel — we don't want to
  // accidentally burn Deepgram credits on a different channel's backlog.
  const activeId = getActiveChannelId();
  if (activeId) {
    return db
      .prepare(
        `SELECT v.id, v.title, v.duration_seconds
         FROM videos v
         LEFT JOIN transcripts t ON t.video_id = v.id
         WHERE v.channel_id = ? AND (
           t.video_id IS NULL
           OR (
             v.duration_seconds IS NOT NULL
             AND v.duration_seconds > 60
             AND (LENGTH(t.text) * 1.0 / v.duration_seconds) < ?
           )
         )
         ORDER BY COALESCE(v.published_at, v.imported_at) DESC`
      )
      .all(activeId, SUSPICIOUS_CHARS_PER_SEC) as {
      id: string;
      title: string;
      duration_seconds: number | null;
    }[];
  }
  return db
    .prepare(
      `SELECT v.id, v.title, v.duration_seconds
       FROM videos v
       LEFT JOIN transcripts t ON t.video_id = v.id
       WHERE t.video_id IS NULL
          OR (
            v.duration_seconds IS NOT NULL
            AND v.duration_seconds > 60
            AND (LENGTH(t.text) * 1.0 / v.duration_seconds) < ?
          )
       ORDER BY COALESCE(v.published_at, v.imported_at) DESC`
    )
    .all(SUSPICIOUS_CHARS_PER_SEC) as {
    id: string;
    title: string;
    duration_seconds: number | null;
  }[];
}

/* ------------------------------------------------------------------ *
 * Flexible "what to transcribe" picker (Phase 1 of the transcribe-
 * batch UX rework).
 *
 * The old flow only had ONE bulk option: "transcribe everything missing".
 * The new UI lets the user choose between
 *   - all missing (legacy default)
 *   - top N ordered by views / recency / oldest, optionally restricted
 *     to videos still missing a transcript
 *   - a hand-picked list of video IDs
 *
 * To support that without scattering query-building across routes, we
 * expose two helpers:
 *   1. listChannelVideosForTranscribe(opts) — sorted/filtered/limited
 *      list of candidates plus their transcript status, used by the
 *      modal that lets the user pick what they want.
 *   2. getVideosByIds(ids) — strict lookup of metadata for the IDs the
 *      user actually picked (channel-scoped, so a malicious caller
 *      can't sneak in IDs from a different channel).
 * ------------------------------------------------------------------ */

export type TranscribeCandidate = {
  id: string;
  title: string;
  duration_seconds: number | null;
  views: number;
  published_at: number | null;
  has_transcript: boolean;
};

const TRANSCRIBE_SUSPICIOUS_CHARS_PER_SEC = 3;

/**
 * Active-channel-scoped video list for the bulk-transcribe picker UI.
 *
 *   onlyMissing — if true, filters out videos that already have a
 *     usable transcript (same heuristic as listVideosMissingTranscript:
 *     no transcript at all, OR suspiciously short transcript-text/
 *     duration ratio that suggests a previous bad transcribe).
 *   orderBy — "views" | "recent" | "oldest". Default "recent".
 *   limit — caps the result set; useful for the "top N" CTA so we
 *     don't ship the whole 500-video catalogue to the browser when
 *     the user only cares about the top 10.
 */
export function listChannelVideosForTranscribe(
  opts: {
    onlyMissing?: boolean;
    orderBy?: "views" | "recent" | "oldest";
    limit?: number;
  } = {}
): TranscribeCandidate[] {
  const activeId = getActiveChannelId();
  if (!activeId) return [];

  const order =
    opts.orderBy === "views"
      ? "v.views DESC"
      : opts.orderBy === "oldest"
        ? "COALESCE(v.published_at, v.imported_at) ASC"
        : "COALESCE(v.published_at, v.imported_at) DESC";

  // The missing-only filter uses an INLINE expression instead of a CASE
  // / sub-query so SQLite can still hit the index on (channel_id,
  // published_at) for the ORDER BY. Same heuristic as
  // listVideosMissingTranscript.
  const missingClause = opts.onlyMissing
    ? `AND (
        t.video_id IS NULL
        OR (
          v.duration_seconds IS NOT NULL
          AND v.duration_seconds > 60
          AND (LENGTH(t.text) * 1.0 / v.duration_seconds) < ?
        )
      )`
    : "";

  const limitClause =
    opts.limit && opts.limit > 0
      ? `LIMIT ${Math.floor(Math.max(1, opts.limit))}`
      : "";

  const sql = `
    SELECT
      v.id,
      v.title,
      v.duration_seconds,
      v.views,
      v.published_at,
      CASE WHEN t.video_id IS NULL THEN 0 ELSE 1 END AS has_transcript_int
    FROM videos v
    LEFT JOIN transcripts t ON t.video_id = v.id
    WHERE v.channel_id = ?
    ${missingClause}
    ORDER BY ${order}
    ${limitClause}
  `;

  const args: unknown[] = [activeId];
  if (opts.onlyMissing) args.push(TRANSCRIBE_SUSPICIOUS_CHARS_PER_SEC);

  const rows = db.prepare(sql).all(...args) as Array<{
    id: string;
    title: string;
    duration_seconds: number | null;
    views: number | null;
    published_at: number | null;
    has_transcript_int: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    duration_seconds: r.duration_seconds,
    views: r.views ?? 0,
    published_at: r.published_at,
    has_transcript: r.has_transcript_int === 1,
  }));
}

/**
 * Look up metadata for a specific list of video IDs, restricted to the
 * active channel. Used when the user picks a custom set in the batch-
 * transcribe modal — we still channel-scope the lookup so that a
 * crafted request can't accidentally transcribe videos from a
 * different connected channel.
 */
export function getVideosByIds(ids: string[]): Array<{
  id: string;
  title: string;
  duration_seconds: number | null;
}> {
  if (ids.length === 0) return [];
  const activeId = getActiveChannelId();
  if (!activeId) return [];
  // Dedup + cap at 500 IDs so we can't build a 10k-wide IN list by
  // accident. The UI will never legitimately need more.
  const unique = Array.from(new Set(ids)).slice(0, 500);
  const placeholders = unique.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, title, duration_seconds
       FROM videos
       WHERE channel_id = ? AND id IN (${placeholders})`
    )
    .all(activeId, ...unique) as Array<{
    id: string;
    title: string;
    duration_seconds: number | null;
  }>;
}

export type TranscriptionJob = {
  id: number;
  started_at: number;
  completed_at: number | null;
  total: number;
  done: number;
  failed: number;
  cost_cents: number;
  current_video_id: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  last_error: string | null;
};

export function getActiveTranscriptionJob(): TranscriptionJob | undefined {
  return db
    .prepare(`SELECT * FROM transcription_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1`)
    .get() as TranscriptionJob | undefined;
}

export function getLatestTranscriptionJob(): TranscriptionJob | undefined {
  return db
    .prepare(`SELECT * FROM transcription_jobs ORDER BY id DESC LIMIT 1`)
    .get() as TranscriptionJob | undefined;
}

export function createTranscriptionJob(total: number): number {
  const info = db
    .prepare(`INSERT INTO transcription_jobs (total, status) VALUES (?, 'running')`)
    .run(total);
  return info.lastInsertRowid as number;
}

export function updateTranscriptionJob(
  id: number,
  patch: Partial<Omit<TranscriptionJob, "id" | "started_at">>
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k] as unknown);
  db.prepare(`UPDATE transcription_jobs SET ${setClause} WHERE id = ?`).run(...values, id);
}

/* ---------------------------------------------------------------------- *
 * Comment-sync job tracking — same job-pattern as transcription_jobs but
 * dimensioned around "videos processed" + "comments added" instead of
 * cost in cents. Lets the /videos page run a single background sweep
 * that syncs comments for every (or N) videos on the active channel,
 * with live progress in a banner.
 * ---------------------------------------------------------------------- */

export type CommentSyncJob = {
  id: number;
  started_at: number;
  completed_at: number | null;
  total: number;
  done: number;
  failed: number;
  comments_added: number;
  current_video_id: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  last_error: string | null;
};

export function getActiveCommentSyncJob(): CommentSyncJob | undefined {
  return db
    .prepare(
      `SELECT * FROM comment_sync_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1`
    )
    .get() as CommentSyncJob | undefined;
}

export function getLatestCommentSyncJob(): CommentSyncJob | undefined {
  return db
    .prepare(`SELECT * FROM comment_sync_jobs ORDER BY id DESC LIMIT 1`)
    .get() as CommentSyncJob | undefined;
}

export function createCommentSyncJob(total: number): number {
  const info = db
    .prepare(`INSERT INTO comment_sync_jobs (total, status) VALUES (?, 'running')`)
    .run(total);
  return info.lastInsertRowid as number;
}

export function updateCommentSyncJob(
  id: number,
  patch: Partial<Omit<CommentSyncJob, "id" | "started_at">>
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k] as unknown);
  db.prepare(`UPDATE comment_sync_jobs SET ${setClause} WHERE id = ?`).run(
    ...values,
    id
  );
}

/* ---------- Hook-analysis batch jobs ---------- */

export type HookAnalysisJob = {
  id: number;
  started_at: number;
  completed_at: number | null;
  channel_id: string | null;
  total: number;
  done: number;
  failed: number;
  current_video_id: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  last_error: string | null;
};

export function getActiveHookAnalysisJob(): HookAnalysisJob | undefined {
  return db
    .prepare(
      `SELECT * FROM hook_analysis_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1`
    )
    .get() as HookAnalysisJob | undefined;
}

export function getLatestHookAnalysisJob(): HookAnalysisJob | undefined {
  return db
    .prepare(`SELECT * FROM hook_analysis_jobs ORDER BY id DESC LIMIT 1`)
    .get() as HookAnalysisJob | undefined;
}

export function createHookAnalysisJob(
  total: number,
  channelId: string | null
): number {
  const info = db
    .prepare(
      `INSERT INTO hook_analysis_jobs (total, channel_id, status) VALUES (?, ?, 'running')`
    )
    .run(total, channelId);
  return info.lastInsertRowid as number;
}

export function updateHookAnalysisJob(
  id: number,
  patch: Partial<Omit<HookAnalysisJob, "id" | "started_at">>
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k] as unknown);
  db.prepare(`UPDATE hook_analysis_jobs SET ${setClause} WHERE id = ?`).run(
    ...values,
    id
  );
}

/**
 * Re-read a job to check whether the user cancelled it.
 *
 * The background worker calls this between every video so a Cancel
 * button press takes effect within one Claude call's worth of latency
 * (≈5-15s) rather than letting the whole batch run to completion.
 */
export function getHookAnalysisJobStatus(id: number): HookAnalysisJob["status"] | undefined {
  const row = db
    .prepare(`SELECT status FROM hook_analysis_jobs WHERE id = ?`)
    .get(id) as { status: HookAnalysisJob["status"] } | undefined;
  return row?.status;
}

/**
 * Active-channel-scoped list of videos with their current comment-sync
 * status (cached count + last-synced timestamp). Used by the bulk-
 * sync-comments banner to decide what to enqueue.
 *
 *   onlyMissing — if true, only returns videos that have NEVER had
 *     comments synced (no rows in the local `comments` table for that
 *     video). Useful for the "sync new videos only" flow that runs
 *     after a channel sync.
 *   orderBy — same vocabulary as the transcribe picker. Default "recent"
 *     because newly-uploaded videos get the most comment activity.
 *   limit — cap on the result set.
 */
export function listChannelVideosForCommentSync(
  opts: {
    onlyMissing?: boolean;
    orderBy?: "views" | "recent" | "oldest";
    limit?: number;
  } = {}
): Array<{
  id: string;
  title: string;
  views: number;
  published_at: number | null;
  comments_count: number; // local DB count, not the YouTube `comments` column
  last_synced_at: number | null;
}> {
  const activeId = getActiveChannelId();
  if (!activeId) return [];

  const order =
    opts.orderBy === "views"
      ? "v.views DESC"
      : opts.orderBy === "oldest"
        ? "COALESCE(v.published_at, v.imported_at) ASC"
        : "COALESCE(v.published_at, v.imported_at) DESC";

  // Aggregate over the comments table once per video. LEFT JOIN keeps
  // videos with no comments synced yet.
  const missingClause = opts.onlyMissing
    ? "HAVING comments_count = 0"
    : "";

  const limitClause =
    opts.limit && opts.limit > 0
      ? `LIMIT ${Math.floor(Math.max(1, opts.limit))}`
      : "";

  const sql = `
    SELECT
      v.id,
      v.title,
      v.views,
      v.published_at,
      COUNT(c.id) AS comments_count,
      MAX(c.fetched_at) AS last_synced_at
    FROM videos v
    LEFT JOIN comments c ON c.video_id = v.id
    WHERE v.channel_id = ?
    GROUP BY v.id
    ${missingClause}
    ORDER BY ${order}
    ${limitClause}
  `;

  const rows = db.prepare(sql).all(activeId) as Array<{
    id: string;
    title: string;
    views: number | null;
    published_at: number | null;
    comments_count: number;
    last_synced_at: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    views: r.views ?? 0,
    published_at: r.published_at,
    comments_count: r.comments_count,
    last_synced_at: r.last_synced_at,
  }));
}

export function clearLogs(opts: { level?: LogLevel; olderThanSec?: number } = {}): number {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.level) {
    where.push("level = ?");
    args.push(opts.level);
  }
  if (opts.olderThanSec && opts.olderThanSec > 0) {
    where.push("ts < ?");
    args.push(Math.floor(Date.now() / 1000) - opts.olderThanSec);
  }
  const sql = `DELETE FROM app_logs ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
  const info = db.prepare(sql).run(...args);
  return info.changes;
}

/* ============================================================
 * COMPETITORS (Phase B)
 *
 * Tracks rival YouTube channels for gap/outlier analysis. Synced
 * through Apify (per the user's existing Apify integration), not the
 * YouTube Data API — Apify lets us pull title + views + thumbnail at
 * scale without burning the 10K/day quota that we save for the user's
 * own channel.
 * ============================================================ */

db.exec(`
  CREATE TABLE IF NOT EXISTS competitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT UNIQUE,                -- UCxxxx; null until first sync resolves it
    handle TEXT,                            -- @handle or full URL given by user
    title TEXT,
    avatar_url TEXT,
    subscriber_count INTEGER,
    video_count INTEGER,
    added_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_sync_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_competitors_channel ON competitors(channel_id);

  CREATE TABLE IF NOT EXISTS competitor_videos (
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
  CREATE INDEX IF NOT EXISTS idx_comp_videos_views ON competitor_videos(competitor_id, views DESC);

  -- Captions for competitor videos. Pulled via YouTube's free timedtext
  -- endpoint when the YT-Data-API competitor sync runs -- no API quota
  -- cost, but only ~80% of videos have usable captions. Schema mirrors
  -- the main transcripts table but keyed by competitor_id + video_id
  -- (no FK to videos because these videos are not in the main videos
  -- table).
  CREATE TABLE IF NOT EXISTS competitor_transcripts (
    competitor_id INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    language TEXT,
    text TEXT NOT NULL,
    fetched_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (competitor_id, video_id),
    FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
  );

  -- Top comments for competitor videos. We only pull top-relevance
  -- threads (no replies) at a fixed cap per video to keep YT Data API
  -- quota in check. Schema mirrors the main comments table.
  CREATE TABLE IF NOT EXISTS competitor_comments (
    id TEXT PRIMARY KEY,
    competitor_id INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    author TEXT,
    author_channel_id TEXT,
    text TEXT NOT NULL,
    like_count INTEGER,
    reply_count INTEGER,
    published_at INTEGER,
    fetched_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_comp_comments_video
    ON competitor_comments(competitor_id, video_id);
  CREATE INDEX IF NOT EXISTS idx_comp_comments_likes
    ON competitor_comments(competitor_id, video_id, like_count DESC);

  -- Auto-detected viral hits we surface as Alerts. One row per
  -- (competitor, video) pair; re-detection is idempotent on PK conflict.
  CREATE TABLE IF NOT EXISTS competitor_alerts (
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
  CREATE INDEX IF NOT EXISTS idx_comp_alerts_unread ON competitor_alerts(read_at, detected_at DESC);
`);

export type Competitor = {
  id: number;
  channel_id: string | null;
  handle: string | null;
  title: string | null;
  avatar_url: string | null;
  subscriber_count: number | null;
  video_count: number | null;
  added_at: number;
  last_sync_at: number | null;
};

export type CompetitorVideo = {
  competitor_id: number;
  video_id: string;
  title: string;
  thumbnail_url: string | null;
  views: number;
  likes: number;
  comments: number;
  duration_seconds: number | null;
  published_at: number | null;
  synced_at: number;
};

export type CompetitorAlert = {
  id: number;
  competitor_id: number;
  video_id: string;
  title: string | null;
  thumbnail_url: string | null;
  views: number | null;
  channel_median_views: number | null;
  multiplier: number | null;
  detected_at: number;
  read_at: number | null;
};

export function listCompetitors(): Competitor[] {
  return db
    .prepare(`SELECT * FROM competitors ORDER BY added_at DESC`)
    .all() as Competitor[];
}

export function getCompetitor(id: number): Competitor | undefined {
  return db.prepare(`SELECT * FROM competitors WHERE id = ?`).get(id) as
    | Competitor
    | undefined;
}

export function getCompetitorByChannelId(channelId: string): Competitor | undefined {
  return db
    .prepare(`SELECT * FROM competitors WHERE channel_id = ?`)
    .get(channelId) as Competitor | undefined;
}

export function addCompetitor(input: {
  handle?: string | null;
  channel_id?: string | null;
  title?: string | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO competitors (handle, channel_id, title) VALUES (?, ?, ?)`
    )
    .run(input.handle ?? null, input.channel_id ?? null, input.title ?? null);
  return Number(info.lastInsertRowid);
}

export function updateCompetitorAfterSync(
  id: number,
  patch: Partial<Competitor>
): void {
  const keys = Object.keys(patch) as (keyof Competitor)[];
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k] as unknown);
  db.prepare(
    `UPDATE competitors SET ${setClause}, last_sync_at = strftime('%s','now') WHERE id = ?`
  ).run(...values, id);
}

export function deleteCompetitor(id: number): void {
  // ON DELETE CASCADE cleans up competitor_videos and competitor_alerts.
  db.prepare(`DELETE FROM competitors WHERE id = ?`).run(id);
}

export function upsertCompetitorVideo(v: {
  competitor_id: number;
  video_id: string;
  title: string;
  thumbnail_url?: string | null;
  views?: number;
  likes?: number;
  comments?: number;
  duration_seconds?: number | null;
  published_at?: number | null;
}): void {
  db.prepare(
    `INSERT INTO competitor_videos
       (competitor_id, video_id, title, thumbnail_url, views, likes, comments, duration_seconds, published_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(competitor_id, video_id) DO UPDATE SET
       title = excluded.title,
       thumbnail_url = excluded.thumbnail_url,
       views = excluded.views,
       likes = excluded.likes,
       comments = excluded.comments,
       duration_seconds = excluded.duration_seconds,
       published_at = excluded.published_at,
       synced_at = excluded.synced_at`
  ).run(
    v.competitor_id,
    v.video_id,
    v.title,
    v.thumbnail_url ?? null,
    v.views ?? 0,
    v.likes ?? 0,
    v.comments ?? 0,
    v.duration_seconds ?? null,
    v.published_at ?? null
  );
}

export function listCompetitorVideos(
  competitorId: number,
  limit = 100
): CompetitorVideo[] {
  return db
    .prepare(
      `SELECT * FROM competitor_videos
       WHERE competitor_id = ?
       ORDER BY views DESC
       LIMIT ?`
    )
    .all(competitorId, limit) as CompetitorVideo[];
}

/**
 * Median views across this competitor's catalogue. Used as the
 * baseline for outlier detection — anything ≥2× median flips into
 * an alert. Median chosen over mean because a single huge hit
 * would otherwise hide all subsequent viral candidates.
 */
export function upsertCompetitorTranscript(
  competitorId: number,
  videoId: string,
  text: string,
  language: string | null
): void {
  db.prepare(
    `INSERT INTO competitor_transcripts
       (competitor_id, video_id, language, text, fetched_at)
     VALUES (?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(competitor_id, video_id) DO UPDATE SET
       language = excluded.language,
       text = excluded.text,
       fetched_at = excluded.fetched_at`
  ).run(competitorId, videoId, language, text);
}

export function upsertCompetitorComments(
  competitorId: number,
  rows: Array<{
    id: string;
    video_id: string;
    author: string | null;
    author_channel_id: string | null;
    text: string;
    like_count: number;
    reply_count: number;
    published_at: number | null;
  }>
): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO competitor_comments
       (id, competitor_id, video_id, author, author_channel_id, text,
        like_count, reply_count, published_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(id) DO UPDATE SET
       text = excluded.text,
       like_count = excluded.like_count,
       reply_count = excluded.reply_count,
       fetched_at = excluded.fetched_at`
  );
  const tx = db.transaction((batch: typeof rows) => {
    for (const r of batch) {
      stmt.run(
        r.id,
        competitorId,
        r.video_id,
        r.author,
        r.author_channel_id,
        r.text,
        r.like_count,
        r.reply_count,
        r.published_at
      );
    }
  });
  tx(rows);
}

export function getCompetitorTranscript(
  competitorId: number,
  videoId: string
): { text: string; language: string | null } | null {
  const row = db
    .prepare(
      `SELECT text, language FROM competitor_transcripts
       WHERE competitor_id = ? AND video_id = ?`
    )
    .get(competitorId, videoId) as
    | { text: string; language: string | null }
    | undefined;
  return row ?? null;
}

export function listCompetitorComments(
  competitorId: number,
  videoId: string,
  limit = 50
): Array<{
  id: string;
  author: string | null;
  text: string;
  like_count: number;
  reply_count: number;
  published_at: number | null;
}> {
  return db
    .prepare(
      `SELECT id, author, text, like_count, reply_count, published_at
       FROM competitor_comments
       WHERE competitor_id = ? AND video_id = ?
       ORDER BY like_count DESC, published_at DESC
       LIMIT ?`
    )
    .all(competitorId, videoId, limit) as Array<{
    id: string;
    author: string | null;
    text: string;
    like_count: number;
    reply_count: number;
    published_at: number | null;
  }>;
}

export function competitorMedianViews(competitorId: number): number {
  const row = db
    .prepare(
      `WITH ordered AS (
         SELECT views, ROW_NUMBER() OVER (ORDER BY views) AS rn,
                COUNT(*) OVER () AS cnt
         FROM competitor_videos
         WHERE competitor_id = ?
       )
       SELECT AVG(views) AS median
       FROM ordered
       WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)`
    )
    .get(competitorId) as { median: number | null } | undefined;
  return Math.round(row?.median ?? 0);
}

export function recordCompetitorAlert(a: {
  competitor_id: number;
  video_id: string;
  title?: string | null;
  thumbnail_url?: string | null;
  views?: number | null;
  channel_median_views?: number | null;
  multiplier?: number | null;
}): void {
  db.prepare(
    `INSERT INTO competitor_alerts
       (competitor_id, video_id, title, thumbnail_url, views, channel_median_views, multiplier)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(competitor_id, video_id) DO UPDATE SET
       views = excluded.views,
       multiplier = excluded.multiplier,
       channel_median_views = excluded.channel_median_views`
  ).run(
    a.competitor_id,
    a.video_id,
    a.title ?? null,
    a.thumbnail_url ?? null,
    a.views ?? null,
    a.channel_median_views ?? null,
    a.multiplier ?? null
  );
}

export function listCompetitorAlerts(opts: { unreadOnly?: boolean; limit?: number } = {}): (CompetitorAlert & { competitor_title: string | null; competitor_handle: string | null })[] {
  const where = opts.unreadOnly ? "WHERE a.read_at IS NULL" : "";
  return db
    .prepare(
      `SELECT a.*, c.title AS competitor_title, c.handle AS competitor_handle
       FROM competitor_alerts a
       JOIN competitors c ON c.id = a.competitor_id
       ${where}
       ORDER BY a.detected_at DESC
       LIMIT ?`
    )
    .all(opts.limit ?? 100) as (CompetitorAlert & {
    competitor_title: string | null;
    competitor_handle: string | null;
  })[];
}

export function markCompetitorAlertRead(id: number): void {
  db.prepare(
    `UPDATE competitor_alerts SET read_at = strftime('%s','now') WHERE id = ?`
  ).run(id);
}

export function unreadCompetitorAlertCount(): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM competitor_alerts WHERE read_at IS NULL`)
    .get() as { n: number };
  return row.n;
}

/**
 * Gap analysis — words frequent in TOP videos of competitors but NOT
 * in any of the user's own video titles. Returns the most "missed"
 * keywords by aggregate competitor views. Stopwords skipped.
 *
 * Pure SQL-side aggregation; the tokeniser is lo-fi (split on
 * non-word chars + lowercase) but it's enough to surface the
 * obvious gaps the dashboard wants to show. Refinement (n-grams,
 * lemmatisation) can come later if needed.
 */
const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","in","on","for","to","with","is","are","was","were","be","been",
  "this","that","these","those","i","you","he","she","it","we","they","my","your","his","her","its","our","their",
  "do","does","did","done","have","has","had","not","no","yes","at","by","from","as","than","then","so","very",
  "what","when","where","why","how","who","which","there","here","just","like","get","got","make","made",
  "will","would","can","could","should","shall","may","might","one","two","three","new",
]);

function tokeniseTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

export function competitorGapAnalysis(opts: { topN?: number } = {}): Array<{
  word: string;
  competitorUses: number;
  competitorTotalViews: number;
  avgViews: number;
  exampleCompetitorTitle: string;
}> {
  const top = opts.topN ?? 25;
  // "Own" titles must be the ACTIVE channel only — otherwise we'd mix
  // in titles from a different connected channel and call them "ours",
  // hiding gap-words that are actually opportunities for THIS channel.
  const activeId = getActiveChannelId();
  const ownTitles = activeId
    ? (db
        .prepare(`SELECT title FROM videos WHERE channel_id = ?`)
        .all(activeId) as { title: string }[])
    : [];
  const ownWords = new Set<string>();
  for (const r of ownTitles) {
    for (const w of tokeniseTitle(r.title)) ownWords.add(w);
  }

  // Pull each competitor video's title + views. Aggregate frequency
  // and total views per word; subtract words already in the user's
  // catalogue at the end.
  const compVideos = db
    .prepare(
      `SELECT title, views FROM competitor_videos
       ORDER BY views DESC
       LIMIT 1000`
    )
    .all() as { title: string; views: number }[];

  type Agg = { uses: number; totalViews: number; sampleTitle: string };
  const stats = new Map<string, Agg>();
  for (const v of compVideos) {
    const words = new Set(tokeniseTitle(v.title));
    for (const w of words) {
      if (ownWords.has(w)) continue;
      const cur = stats.get(w);
      if (cur) {
        cur.uses += 1;
        cur.totalViews += v.views;
      } else {
        stats.set(w, { uses: 1, totalViews: v.views, sampleTitle: v.title });
      }
    }
  }
  return Array.from(stats.entries())
    .map(([word, s]) => ({
      word,
      competitorUses: s.uses,
      competitorTotalViews: s.totalViews,
      avgViews: Math.round(s.totalViews / Math.max(1, s.uses)),
      exampleCompetitorTitle: s.sampleTitle,
    }))
    .filter((r) => r.competitorUses >= 2) // need at least 2 sightings to be a "pattern"
    .sort((a, b) => b.competitorTotalViews - a.competitorTotalViews)
    .slice(0, top);
}

/* ============================================================
 * HOOK LAB (Phase C)
 *
 * AI scoring of each video's opening 30-60 seconds — the "hook".
 * Captures both a formula classification (direct question, mystery,
 * personal story, etc.) and seven 1-10 quality scores covering the
 * dimensions the mentor framework identifies: open loop, value promise,
 * conflict, specific language, identification, pacing, benefit.
 * One row per video, regenerated on demand.
 * ============================================================ */

export const HOOK_FORMULAS = [
  "direct_question",
  "statistic",
  "comment_reference",
  "personal_story",
  "mystery",
  "character_place_date",
  "provocation",
  "other",
] as const;
export type HookFormula = (typeof HOOK_FORMULAS)[number];

db.exec(`
  CREATE TABLE IF NOT EXISTS video_hooks (
    video_id TEXT PRIMARY KEY,
    hook_text TEXT NOT NULL,
    formula_type TEXT NOT NULL,
    -- Seven quality dimensions (1-10 each). Stored as columns rather
    -- than a JSON blob so SQL aggregations (averages, sorting) stay
    -- fast and the chat SQL tool can reason about them directly.
    score_open_loop INTEGER NOT NULL,
    score_value_promise INTEGER NOT NULL,
    score_conflict INTEGER NOT NULL,
    score_specific_language INTEGER NOT NULL,
    score_identification INTEGER NOT NULL,
    score_pacing INTEGER NOT NULL,
    score_benefit INTEGER NOT NULL,
    overall_score REAL NOT NULL,
    -- Free-form strengths + improvement suggestions from the analyzer.
    fortalezas TEXT,
    mejoras TEXT,
    analyzed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    analyzer_model TEXT,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_hooks_score ON video_hooks(overall_score DESC);
  CREATE INDEX IF NOT EXISTS idx_hooks_formula ON video_hooks(formula_type);
`);

export type VideoHook = {
  video_id: string;
  hook_text: string;
  formula_type: HookFormula;
  score_open_loop: number;
  score_value_promise: number;
  score_conflict: number;
  score_specific_language: number;
  score_identification: number;
  score_pacing: number;
  score_benefit: number;
  overall_score: number;
  fortalezas: string | null; // JSON array
  mejoras: string | null;    // JSON array
  analyzed_at: number;
  analyzer_model: string | null;
};

export function upsertVideoHook(h: VideoHook): void {
  db.prepare(
    `INSERT INTO video_hooks
       (video_id, hook_text, formula_type,
        score_open_loop, score_value_promise, score_conflict, score_specific_language,
        score_identification, score_pacing, score_benefit, overall_score,
        fortalezas, mejoras, analyzed_at, analyzer_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), ?)
     ON CONFLICT(video_id) DO UPDATE SET
       hook_text = excluded.hook_text,
       formula_type = excluded.formula_type,
       score_open_loop = excluded.score_open_loop,
       score_value_promise = excluded.score_value_promise,
       score_conflict = excluded.score_conflict,
       score_specific_language = excluded.score_specific_language,
       score_identification = excluded.score_identification,
       score_pacing = excluded.score_pacing,
       score_benefit = excluded.score_benefit,
       overall_score = excluded.overall_score,
       fortalezas = excluded.fortalezas,
       mejoras = excluded.mejoras,
       analyzed_at = strftime('%s','now'),
       analyzer_model = excluded.analyzer_model`
  ).run(
    h.video_id,
    h.hook_text,
    h.formula_type,
    h.score_open_loop,
    h.score_value_promise,
    h.score_conflict,
    h.score_specific_language,
    h.score_identification,
    h.score_pacing,
    h.score_benefit,
    h.overall_score,
    h.fortalezas ?? null,
    h.mejoras ?? null,
    h.analyzer_model ?? null
  );
}

export function getVideoHook(videoId: string): VideoHook | undefined {
  return db
    .prepare(`SELECT * FROM video_hooks WHERE video_id = ?`)
    .get(videoId) as VideoHook | undefined;
}

/**
 * List hooks joined to their videos. Used by /hooks dashboards — the
 * Rankings tab wants both the score and the source title/views in the
 * same row so it can sort by either dimension without an N+1 join.
 */
export type HookWithVideo = VideoHook & {
  title: string;
  views: number;
  published_at: number | null;
  thumbnail_url: string | null;
};

export function listHooksWithVideos(opts: {
  formula?: HookFormula;
  limit?: number;
  orderBy?: "score" | "views" | "recent";
} = {}): HookWithVideo[] {
  const order =
    opts.orderBy === "views"
      ? "v.views DESC"
      : opts.orderBy === "recent"
        ? "v.published_at DESC"
        : "h.overall_score DESC";
  // Always scope to the active channel — the dashboard / chat user
  // expects "the hooks on MY current channel", not a cross-channel pool.
  const activeId = getActiveChannelId();
  if (!activeId) return [];
  const whereParts: string[] = ["v.channel_id = ?"];
  const args: unknown[] = [activeId];
  if (opts.formula) {
    whereParts.push("h.formula_type = ?");
    args.push(opts.formula);
  }
  args.push(opts.limit ?? 200);
  return db
    .prepare(
      `SELECT h.*, v.title, v.views, v.published_at, v.thumbnail_url
       FROM video_hooks h
       JOIN videos v ON v.id = h.video_id
       WHERE ${whereParts.join(" AND ")}
       ORDER BY ${order}
       LIMIT ?`
    )
    .all(...args) as HookWithVideo[];
}

/**
 * Per-formula aggregates for the dashboard chart — how many hooks of
 * each type the channel ships, and what their average views look like.
 * "Winning formula" is just the formula with the highest avg views.
 */
export function hookFormulaStats(): Array<{
  formula: HookFormula;
  count: number;
  avgViews: number;
  avgScore: number;
}> {
  const activeId = getActiveChannelId();
  if (!activeId) return [];
  return db
    .prepare(
      `SELECT
         h.formula_type AS formula,
         COUNT(*) AS count,
         CAST(AVG(v.views) AS INTEGER) AS avgViews,
         ROUND(AVG(h.overall_score), 1) AS avgScore
       FROM video_hooks h
       JOIN videos v ON v.id = h.video_id
       WHERE v.channel_id = ?
       GROUP BY h.formula_type
       ORDER BY avgViews DESC`
    )
    .all(activeId) as Array<{
    formula: HookFormula;
    count: number;
    avgViews: number;
    avgScore: number;
  }>;
}

export function hookOverallStats(): {
  analyzed: number;
  totalVideos: number;
  avgScore: number;
  topFormula: HookFormula | null;
} {
  const activeId = getActiveChannelId();
  if (!activeId) {
    return { analyzed: 0, totalVideos: 0, avgScore: 0, topFormula: null };
  }
  // Both counts and the avg must be channel-scoped — otherwise we'd
  // mix hooks/videos from every connected channel into a single number.
  const analyzed = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM video_hooks h
         JOIN videos v ON v.id = h.video_id
         WHERE v.channel_id = ?`
      )
      .get(activeId) as { n: number }
  ).n;
  const totalVideos = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM videos WHERE channel_id = ?`)
      .get(activeId) as { n: number }
  ).n;
  const avgRow = db
    .prepare(
      `SELECT ROUND(AVG(h.overall_score), 1) AS avg
       FROM video_hooks h
       JOIN videos v ON v.id = h.video_id
       WHERE v.channel_id = ?`
    )
    .get(activeId) as { avg: number | null } | undefined;
  const formulas = hookFormulaStats();
  return {
    analyzed,
    totalVideos,
    avgScore: avgRow?.avg ?? 0,
    topFormula: formulas[0]?.formula ?? null,
  };
}

/**
 * Videos that still need hook analysis — used by both the batch analyzer
 * and the Hook Lab dashboard's "pending" counter.
 *
 * Channel-scoped: only returns videos on the currently active channel.
 * Without this scope the dashboard would count videos from every
 * connected channel (so the user sees "40 pending" while the active
 * channel really has 5), and the batch analyzer would happily burn
 * Claude credits analysing another channel's videos that won't move
 * the active dashboard at all. Same multi-channel data-leak pattern
 * fixed in hookOverallStats / hookFormulaStats.
 */
export function listVideosPendingHookAnalysis(limit = 200): Array<{
  id: string;
  title: string;
}> {
  const activeId = getActiveChannelId();
  if (!activeId) return [];
  return db
    .prepare(
      `SELECT v.id, v.title
       FROM videos v
       LEFT JOIN video_hooks h ON h.video_id = v.id
       LEFT JOIN transcripts t ON t.video_id = v.id
       WHERE v.channel_id = ?
         AND h.video_id IS NULL
         AND t.video_id IS NOT NULL
       ORDER BY v.views DESC
       LIMIT ?`
    )
    .all(activeId, limit) as Array<{ id: string; title: string }>;
}

/* ============================================================
 * FORMULA ANALYZER (Phase D)
 *
 * Pure SQL aggregations over the user's own video catalogue —
 * surface which title patterns / lengths / keywords have actually
 * pulled views on THIS channel. No AI: this is the "what did
 * you ship and what worked" view.
 * ============================================================ */

const FORMULA_STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","in","on","for","to","with","is","are","was","were","be","been",
  "this","that","these","those","i","you","he","she","it","we","they","my","your","his","her","its","our","their",
  "do","does","did","done","have","has","had","not","no","yes","at","by","from","as","than","then","so","very",
  "what","when","where","why","how","who","which","there","here","just","like","get","got","make","made",
  "will","would","can","could","should","shall","may","might","one","two","three","new","video","watch",
]);

function tokeniseForFormula(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !FORMULA_STOPWORDS.has(w));
}

export type FormulaWordStat = {
  word: string;
  uses: number;
  totalViews: number;
  avgViews: number;
  successRate: number; // share of uses where views >= median × 1.5
  exampleTitle: string;
};

/**
 * Per-word stats across the user's own video titles. We grade a word
 * as "successful" on a video when that video's views land at least
 * 1.5× the channel median — i.e. an above-average upload. successRate
 * is the share of a word's uses that cleared that bar.
 *
 * Returns words sorted by aggregate views (the actually-tested
 * keywords; obscure one-shot words sink to the bottom).
 */
export function titleWordStats(opts: { minUses?: number; topN?: number } = {}): FormulaWordStat[] {
  const minUses = opts.minUses ?? 2;
  const topN = opts.topN ?? 60;
  const activeId = getActiveChannelId();
  if (!activeId) return [];
  const rows = db
    .prepare(
      `SELECT title, views
       FROM videos
       WHERE title IS NOT NULL AND channel_id = ?`
    )
    .all(activeId) as { title: string; views: number }[];
  if (rows.length === 0) return [];

  // Channel median — used as the "did this video over-perform?" baseline.
  const sortedViews = [...rows].map((r) => r.views).sort((a, b) => a - b);
  const median =
    sortedViews.length % 2 === 1
      ? sortedViews[(sortedViews.length - 1) / 2]
      : (sortedViews[sortedViews.length / 2 - 1] +
          sortedViews[sortedViews.length / 2]) /
        2;
  const successThreshold = median * 1.5;

  type Agg = {
    uses: number;
    totalViews: number;
    successes: number;
    sampleTitle: string;
  };
  const stats = new Map<string, Agg>();
  for (const r of rows) {
    const words = new Set(tokeniseForFormula(r.title));
    for (const w of words) {
      const cur = stats.get(w);
      if (cur) {
        cur.uses += 1;
        cur.totalViews += r.views;
        if (r.views >= successThreshold) cur.successes += 1;
      } else {
        stats.set(w, {
          uses: 1,
          totalViews: r.views,
          successes: r.views >= successThreshold ? 1 : 0,
          sampleTitle: r.title,
        });
      }
    }
  }
  return Array.from(stats.entries())
    .filter(([, s]) => s.uses >= minUses)
    .map(([word, s]) => ({
      word,
      uses: s.uses,
      totalViews: s.totalViews,
      avgViews: Math.round(s.totalViews / s.uses),
      successRate: Math.round((s.successes / s.uses) * 100),
      exampleTitle: s.sampleTitle,
    }))
    .sort((a, b) => b.totalViews - a.totalViews)
    .slice(0, topN);
}

/**
 * Title-length performance buckets. Splits the catalogue into
 * <=8 / 9-12 / 13-16 / 17+ word ranges and reports average views per
 * bucket so the dashboard can show "long titles win" or "short ones
 * win" at a glance.
 */
export function titleLengthBuckets(): Array<{
  bucket: string;
  videos: number;
  avgViews: number;
}> {
  const activeId = getActiveChannelId();
  if (!activeId) {
    return [
      { bucket: "≤ 8 words", videos: 0, avgViews: 0 },
      { bucket: "9–12 words", videos: 0, avgViews: 0 },
      { bucket: "13–16 words", videos: 0, avgViews: 0 },
      { bucket: "17+ words", videos: 0, avgViews: 0 },
    ];
  }
  const rows = db
    .prepare(
      `SELECT title, views
       FROM videos
       WHERE title IS NOT NULL AND channel_id = ?`
    )
    .all(activeId) as { title: string; views: number }[];
  const buckets = {
    "≤ 8 words": [] as number[],
    "9–12 words": [] as number[],
    "13–16 words": [] as number[],
    "17+ words": [] as number[],
  };
  for (const r of rows) {
    const n = (r.title ?? "").trim().split(/\s+/).filter(Boolean).length;
    if (n <= 8) buckets["≤ 8 words"].push(r.views);
    else if (n <= 12) buckets["9–12 words"].push(r.views);
    else if (n <= 16) buckets["13–16 words"].push(r.views);
    else buckets["17+ words"].push(r.views);
  }
  return Object.entries(buckets).map(([bucket, arr]) => ({
    bucket,
    videos: arr.length,
    avgViews:
      arr.length > 0
        ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
        : 0,
  }));
}

/**
 * Top vs bottom video titles — splits the catalogue at the 80th
 * percentile by views, surfaces top + bottom 10 for side-by-side
 * inspection. Used by the Title Patterns block of the dashboard.
 */
export function topVsBottomTitles(): {
  top: Array<{ id: string; title: string; views: number }>;
  bottom: Array<{ id: string; title: string; views: number }>;
} {
  const activeId = getActiveChannelId();
  if (!activeId) return { top: [], bottom: [] };
  const all = db
    .prepare(
      `SELECT id, title, views
       FROM videos
       WHERE title IS NOT NULL AND channel_id = ?
       ORDER BY views DESC`
    )
    .all(activeId) as { id: string; title: string; views: number }[];
  if (all.length === 0) return { top: [], bottom: [] };
  const top = all.slice(0, Math.min(10, all.length));
  const bottom = all.slice(Math.max(0, all.length - 10)).reverse();
  return { top, bottom };
}

/* ============================================================
 * AI COMMENT ANALYSIS (Phase D)
 *
 * One Claude-driven breakdown per video, cached so repeat clicks
 * don't re-bill. Captures audience sentiment, recurring themes,
 * credibility objections, future-video ideas, and the best hook
 * candidates lifted straight out of the comment stream.
 * ============================================================ */

db.exec(`
  CREATE TABLE IF NOT EXISTS comment_analysis (
    video_id TEXT PRIMARY KEY,
    sentiment_score INTEGER NOT NULL,    -- 1-10 (1 = hostile, 10 = adoring)
    themes TEXT,                          -- JSON array of strings
    objections TEXT,                      -- JSON array of { text, severity }
    future_ideas TEXT,                    -- JSON array of { title, demand, evidence }
    hook_candidates TEXT,                 -- JSON array of { author, quote, why }
    summary TEXT,                         -- one-paragraph synthesis
    analyzed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    analyzer_model TEXT,
    comments_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );
`);

export type CommentAnalysis = {
  video_id: string;
  sentiment_score: number;
  themes: string | null;
  objections: string | null;
  future_ideas: string | null;
  hook_candidates: string | null;
  summary: string | null;
  analyzed_at: number;
  analyzer_model: string | null;
  comments_count: number;
};

export function getCommentAnalysis(videoId: string): CommentAnalysis | undefined {
  return db
    .prepare(`SELECT * FROM comment_analysis WHERE video_id = ?`)
    .get(videoId) as CommentAnalysis | undefined;
}

export function upsertCommentAnalysis(a: CommentAnalysis): void {
  db.prepare(
    `INSERT INTO comment_analysis
       (video_id, sentiment_score, themes, objections, future_ideas, hook_candidates,
        summary, analyzed_at, analyzer_model, comments_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET
       sentiment_score = excluded.sentiment_score,
       themes = excluded.themes,
       objections = excluded.objections,
       future_ideas = excluded.future_ideas,
       hook_candidates = excluded.hook_candidates,
       summary = excluded.summary,
       analyzed_at = strftime('%s','now'),
       analyzer_model = excluded.analyzer_model,
       comments_count = excluded.comments_count`
  ).run(
    a.video_id,
    a.sentiment_score,
    a.themes,
    a.objections,
    a.future_ideas,
    a.hook_candidates,
    a.summary,
    a.analyzer_model,
    a.comments_count
  );
}

/* ============================================================
 * HOOKS LIBRARY (Phase D)
 *
 * User-curated list of standout comments / quotes the creator
 * wants to re-use as hooks in future videos. Sourced manually
 * from /videos/:id/comments via a "+ Hooks Library" button,
 * or via the AI Comment Analysis "Best Hook Candidates" list.
 * Tracks usage so the same line doesn't end up in two videos.
 * ============================================================ */

db.exec(`
  CREATE TABLE IF NOT EXISTS hooks_library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Optional FK back to a real comment row; null when the hook
    -- was entered by hand or pulled from an external source.
    comment_id TEXT,
    source_video_id TEXT,
    quote TEXT NOT NULL,
    author TEXT,
    score INTEGER,            -- 1-5, user-assigned vibe rating
    status TEXT NOT NULL DEFAULT 'available',  -- 'available' | 'used'
    used_in_video_id TEXT,
    note TEXT,
    added_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (source_video_id) REFERENCES videos(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hooks_library_status ON hooks_library(status);
  CREATE INDEX IF NOT EXISTS idx_hooks_library_added ON hooks_library(added_at DESC);
`);

export type HooksLibraryEntry = {
  id: number;
  comment_id: string | null;
  source_video_id: string | null;
  quote: string;
  author: string | null;
  score: number | null;
  status: "available" | "used";
  used_in_video_id: string | null;
  note: string | null;
  added_at: number;
};

export function listHooksLibrary(): (HooksLibraryEntry & {
  source_video_title: string | null;
})[] {
  return db
    .prepare(
      `SELECT h.*, v.title AS source_video_title
       FROM hooks_library h
       LEFT JOIN videos v ON v.id = h.source_video_id
       ORDER BY h.added_at DESC`
    )
    .all() as (HooksLibraryEntry & { source_video_title: string | null })[];
}

export function addHookToLibrary(input: {
  comment_id?: string | null;
  source_video_id?: string | null;
  quote: string;
  author?: string | null;
  score?: number | null;
  note?: string | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO hooks_library
         (comment_id, source_video_id, quote, author, score, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.comment_id ?? null,
      input.source_video_id ?? null,
      input.quote,
      input.author ?? null,
      input.score ?? null,
      input.note ?? null
    );
  return Number(info.lastInsertRowid);
}

export function updateHookLibraryEntry(
  id: number,
  patch: Partial<HooksLibraryEntry>
): void {
  const keys = Object.keys(patch) as (keyof HooksLibraryEntry)[];
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k] as unknown);
  db.prepare(`UPDATE hooks_library SET ${setClause} WHERE id = ?`).run(
    ...values,
    id
  );
}

export function deleteHookLibraryEntry(id: number): void {
  db.prepare(`DELETE FROM hooks_library WHERE id = ?`).run(id);
}

/** Look up by comment_id so the UI's "+ Save" button can dedupe. */
export function hookLibraryEntryForComment(
  commentId: string
): HooksLibraryEntry | undefined {
  return db
    .prepare(`SELECT * FROM hooks_library WHERE comment_id = ?`)
    .get(commentId) as HooksLibraryEntry | undefined;
}
