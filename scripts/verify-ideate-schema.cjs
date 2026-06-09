#!/usr/bin/env node
/**
 * Standalone schema applier + verifier for the ideation pipeline.
 *
 * Run: node scripts/verify-ideate-schema.cjs
 */

const path = require("node:path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "data", "app.db");
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function tableExists(name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function cols(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function addColumn(table, column, ddl) {
  try {
    if (!columnExists(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch {}
}

addColumn("integrations", "config_json", "config_json TEXT");
addColumn("channels", "banned_topics", "banned_topics TEXT");
addColumn("channels", "last_user_videos_sync_at", "last_user_videos_sync_at TEXT");
addColumn("channels", "avatar_url", "avatar_url TEXT");
addColumn("channels", "topic_analysis_json", "topic_analysis_json TEXT");
addColumn("channels", "topic_analysis_at", "topic_analysis_at TEXT");
addColumn("channels", "reddit_sources", "reddit_sources TEXT");
addColumn("competitors", "note", "note TEXT");

for (const [column, ddl] of [
  ["used_by_user", "used_by_user INTEGER NOT NULL DEFAULT 0"],
  ["used_at", "used_at TEXT"],
  ["feedback", "feedback TEXT"],
  ["feedback_reason", "feedback_reason TEXT"],
  ["feedback_at", "feedback_at TEXT"],
  ["proof_json", "proof_json TEXT"],
  ["confidence_level", "confidence_level TEXT"],
  ["research_sources_json", "research_sources_json TEXT"],
  ["fit_reason", "fit_reason TEXT"],
]) {
  addColumn("ideas", column, ddl);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    user_channel_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('auto','new_angles','title_tweaks','reddit_angles')),
    count INTEGER NOT NULL CHECK (count >= 10 AND count <= 25),
    status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')) DEFAULT 'processing',
    estimated_cost_millicents INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    error TEXT,
    FOREIGN KEY (user_channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_generations_channel_started
    ON generations(user_channel_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_generations_status
    ON generations(status, started_at DESC);

  CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    source_attribution TEXT,
    validation_status TEXT NOT NULL CHECK (validation_status IN ('passed','rejected')),
    validation_reason TEXT,
    fit_score INTEGER,
    fit_reason TEXT,
    user_note TEXT,
    note_distilled_at TEXT,
    used_by_user INTEGER NOT NULL DEFAULT 0,
    used_at TEXT,
    feedback TEXT CHECK (feedback IS NULL OR feedback IN ('positive','negative')),
    feedback_reason TEXT,
    feedback_at TEXT,
    proof_json TEXT,
    confidence_level TEXT CHECK (confidence_level IS NULL OR confidence_level IN ('high','medium','low')),
    research_sources_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ideas_generation ON ideas(generation_id);
  CREATE INDEX IF NOT EXISTS idx_ideas_note_pending
    ON ideas(generation_id, note_distilled_at)
    WHERE user_note IS NOT NULL AND note_distilled_at IS NULL;

  CREATE TABLE IF NOT EXISTS ideation_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_channel_id TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('banned_topic','banned_substitution','banned_pattern','preferred_format','preferred_topic')),
    rule_value TEXT NOT NULL,
    source_note TEXT,
    source_idea_id TEXT,
    pending INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ideation_rules_channel
    ON ideation_rules(user_channel_id, pending, created_at DESC);

  CREATE TABLE IF NOT EXISTS gather_attrition_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_id TEXT NOT NULL,
    dropped_competitor_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_gather_attrition_generation
    ON gather_attrition_log(generation_id);

  CREATE TABLE IF NOT EXISTS reddit_research_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_channel_id TEXT NOT NULL,
    topic_key TEXT NOT NULL,
    subreddit TEXT NOT NULL,
    reddit_id TEXT,
    title TEXT NOT NULL,
    permalink TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    comments INTEGER NOT NULL DEFAULT 0,
    created_utc INTEGER,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    summary TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    source_json TEXT,
    FOREIGN KEY (user_channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_reddit_research_channel_topic
    ON reddit_research_items(user_channel_id, topic_key, observed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reddit_research_subreddit
    ON reddit_research_items(subreddit, observed_at DESC);

  CREATE TABLE IF NOT EXISTS generation_research_items (
    generation_id TEXT NOT NULL,
    research_item_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (generation_id, research_item_id),
    FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE,
    FOREIGN KEY (research_item_id) REFERENCES reddit_research_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_generation_research_generation
    ON generation_research_items(generation_id);
`);

try {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='generations'`)
    .get();
  if (row?.sql && !row.sql.includes("'reddit_angles'")) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE generations_rebuild (
        id TEXT PRIMARY KEY,
        user_channel_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('auto','new_angles','title_tweaks','reddit_angles')),
        count INTEGER NOT NULL CHECK (count >= 10 AND count <= 25),
        status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')) DEFAULT 'processing',
        estimated_cost_millicents INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        error TEXT,
        FOREIGN KEY (user_channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );
      INSERT INTO generations_rebuild
        (id, user_channel_id, mode, count, status, estimated_cost_millicents, started_at, completed_at, error)
      SELECT id, user_channel_id, mode, count, status, estimated_cost_millicents, started_at, completed_at, error
      FROM generations;
      DROP TABLE generations;
      ALTER TABLE generations_rebuild RENAME TO generations;
      CREATE INDEX IF NOT EXISTS idx_generations_channel_started
        ON generations(user_channel_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generations_status
        ON generations(status, started_at DESC);
    `);
    db.pragma("foreign_keys = ON");
  }
} catch {
  try {
    db.pragma("foreign_keys = ON");
  } catch {}
}

const REQUIRED = {
  integrations: ["name", "api_key", "config_json", "enabled", "updated_at"],
  generations: ["id", "user_channel_id", "mode", "count", "status", "estimated_cost_millicents", "started_at", "completed_at", "error"],
  ideas: ["id", "generation_id", "title", "description", "source_attribution", "proof_json", "confidence_level", "research_sources_json", "validation_status", "validation_reason", "fit_score", "fit_reason", "user_note", "note_distilled_at", "used_by_user", "used_at", "feedback", "feedback_reason", "feedback_at", "created_at"],
  ideation_rules: ["id", "user_channel_id", "rule_type", "rule_value", "source_note", "source_idea_id", "pending", "created_at"],
  gather_attrition_log: ["id", "generation_id", "dropped_competitor_id", "reason", "created_at"],
  reddit_research_items: ["id", "user_channel_id", "topic_key", "subreddit", "reddit_id", "title", "permalink", "score", "comments", "created_utc", "observed_at", "summary", "dedupe_key", "source_json"],
  generation_research_items: ["generation_id", "research_item_id", "created_at"],
};

let failed = false;
const out = [];

for (const [table, requiredCols] of Object.entries(REQUIRED)) {
  if (!tableExists(table)) {
    out.push(`FAIL: table "${table}" missing`);
    failed = true;
    continue;
  }
  const have = cols(table);
  const missing = requiredCols.filter((c) => !have.includes(c));
  if (missing.length > 0) {
    out.push(`FAIL: ${table} missing cols: ${missing.join(", ")}`);
    failed = true;
  } else {
    out.push(`OK: ${table} (${have.length} cols)`);
  }
}

for (const [table, column] of [
  ["channels", "banned_topics"],
  ["channels", "reddit_sources"],
  ["competitors", "note"],
]) {
  if (!cols(table).includes(column)) {
    out.push(`FAIL: ${table}.${column} missing`);
    failed = true;
  } else {
    out.push(`OK: ${table}.${column}`);
  }
}

const indices = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`)
  .all()
  .map((r) => r.name);
for (const index of [
  "idx_generations_channel_started",
  "idx_generations_status",
  "idx_ideas_generation",
  "idx_ideation_rules_channel",
  "idx_gather_attrition_generation",
  "idx_reddit_research_channel_topic",
  "idx_reddit_research_subreddit",
  "idx_generation_research_generation",
]) {
  if (!indices.includes(index)) {
    out.push(`FAIL: index ${index} missing`);
    failed = true;
  } else {
    out.push(`OK: index ${index}`);
  }
}

const channelRow = db.prepare(`SELECT id FROM channels LIMIT 1`).get();
if (channelRow) {
  try {
    const genId = "verify-" + Math.random().toString(36).slice(2);
    db.prepare(
      `INSERT INTO generations (id, user_channel_id, mode, count, status, estimated_cost_millicents)
       VALUES (?, ?, 'reddit_angles', 10, 'processing', 50000)`
    ).run(genId, channelRow.id);
    const ideaId = "verify-idea-" + Math.random().toString(36).slice(2);
    db.prepare(
      `INSERT INTO ideas
         (id, generation_id, title, description, source_attribution, proof_json,
          confidence_level, research_sources_json, validation_status, fit_score, fit_reason)
       VALUES (?, ?, 'Why This Test Title Has Enough Characters', 'desc', '{}', '{}',
          'low', '[]', 'passed', 8.6, 'fits the channel')`
    ).run(ideaId, genId);
    const researchInfo = db.prepare(
      `INSERT INTO reddit_research_items
         (user_channel_id, topic_key, subreddit, reddit_id, title, permalink,
          score, comments, created_utc, summary, dedupe_key, source_json)
       VALUES (?, 'verify-topic', 'testsub', 'abc', 'Verify title',
          'https://www.reddit.com/r/testsub/comments/abc/verify', 10, 2,
          1710000000, 'summary', ?, '{}')`
    ).run(channelRow.id, `verify-${genId}`);
    db.prepare(
      `INSERT INTO generation_research_items (generation_id, research_item_id)
       VALUES (?, ?)`
    ).run(genId, researchInfo.lastInsertRowid);
    db.prepare(`DELETE FROM generations WHERE id = ?`).run(genId);
    const orphanIdeas = db.prepare(`SELECT COUNT(*) AS n FROM ideas WHERE generation_id = ?`).get(genId).n;
    const orphanLinks = db.prepare(`SELECT COUNT(*) AS n FROM generation_research_items WHERE generation_id = ?`).get(genId).n;
    db.prepare(`DELETE FROM reddit_research_items WHERE dedupe_key = ?`).run(`verify-${genId}`);
    if (orphanIdeas !== 0 || orphanLinks !== 0) {
      out.push(`FAIL: cascade delete left orphans (ideas=${orphanIdeas}, research_links=${orphanLinks})`);
      failed = true;
    } else {
      out.push("OK: reddit_angles round-trip and cascade delete work");
    }
  } catch (err) {
    out.push(`FAIL: round-trip threw: ${err.message}`);
    failed = true;
  }
} else {
  out.push("SKIP: no channels row to round-trip against (acceptable on a fresh DB)");
}

try {
  db.prepare(
    `INSERT INTO generations (id, user_channel_id, mode, count, estimated_cost_millicents)
     VALUES ('bad-mode', 'nonexistent', 'invalid_mode', 10, 0)`
  ).run();
  out.push("FAIL: CHECK on generations.mode did not reject invalid value");
  failed = true;
} catch (err) {
  if (err.message.includes("CHECK") || err.message.includes("FOREIGN")) {
    out.push("OK: CHECK/FK constraint rejects invalid generations.mode");
  } else {
    out.push(`UNEXPECTED: ${err.message}`);
    failed = true;
  }
}
try {
  db.prepare(`DELETE FROM generations WHERE id='bad-mode'`).run();
} catch {}

for (const line of out) console.log(line);
console.log("");
if (failed) {
  console.error("SCHEMA VERIFY: FAILED");
  process.exit(1);
}
console.log("SCHEMA VERIFY: OK");
process.exit(0);
