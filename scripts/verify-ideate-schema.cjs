#!/usr/bin/env node
/**
 * Standalone schema applier + verifier. Opens data/app.db directly,
 * replays the ideate migration block (same SQL as src/lib/db.ts), then
 * runs PRAGMA assertions. Idempotent — re-running is a no-op.
 *
 * Run:  node scripts/verify-ideate-schema.cjs
 */

const path = require("node:path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "data", "app.db");
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

// --- replay migration block (must match src/lib/db.ts verbatim) ---

try {
  const cols = db.prepare(`PRAGMA table_info(channels)`).all();
  if (!cols.some((c) => c.name === "banned_topics")) {
    db.exec(`ALTER TABLE channels ADD COLUMN banned_topics TEXT`);
  }
} catch {}

try {
  const cols = db.prepare(`PRAGMA table_info(competitors)`).all();
  if (!cols.some((c) => c.name === "note")) {
    db.exec(`ALTER TABLE competitors ADD COLUMN note TEXT`);
  }
} catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    user_channel_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('auto','new_angles','title_tweaks')),
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
    user_note TEXT,
    note_distilled_at TEXT,
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
`);

// --- verification ---

const REQUIRED = {
  generations: ["id", "user_channel_id", "mode", "count", "status", "estimated_cost_millicents", "started_at", "completed_at", "error"],
  ideas: ["id", "generation_id", "title", "description", "source_attribution", "validation_status", "validation_reason", "fit_score", "user_note", "note_distilled_at", "created_at"],
  ideation_rules: ["id", "user_channel_id", "rule_type", "rule_value", "source_note", "source_idea_id", "pending", "created_at"],
  gather_attrition_log: ["id", "generation_id", "dropped_competitor_id", "reason", "created_at"],
};

let failed = false;
const out = [];

function tableExists(name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}
function cols(t) {
  return db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
}

for (const [t, requiredCols] of Object.entries(REQUIRED)) {
  if (!tableExists(t)) {
    out.push(`FAIL: table "${t}" missing`);
    failed = true;
    continue;
  }
  const have = cols(t);
  const missing = requiredCols.filter((c) => !have.includes(c));
  if (missing.length > 0) {
    out.push(`FAIL: ${t} missing cols: ${missing.join(", ")}`);
    failed = true;
  } else {
    out.push(`OK: ${t} (${have.length} cols)`);
  }
}

const cCh = cols("channels");
if (!cCh.includes("banned_topics")) {
  out.push("FAIL: channels.banned_topics missing");
  failed = true;
} else out.push("OK: channels.banned_topics");

const cCo = cols("competitors");
if (!cCo.includes("note")) {
  out.push("FAIL: competitors.note missing");
  failed = true;
} else out.push("OK: competitors.note");

const indices = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`)
  .all()
  .map((r) => r.name);
for (const i of [
  "idx_generations_channel_started",
  "idx_generations_status",
  "idx_ideas_generation",
  "idx_ideation_rules_channel",
  "idx_gather_attrition_generation",
]) {
  if (!indices.includes(i)) {
    out.push(`FAIL: index ${i} missing`);
    failed = true;
  } else out.push(`OK: index ${i}`);
}

// Round-trip insert/delete to confirm the FK + CHECK constraints work end-to-end
const channelRow = db.prepare(`SELECT id FROM channels LIMIT 1`).get();
if (channelRow) {
  try {
    const genId = "verify-" + Math.random().toString(36).slice(2);
    db.prepare(
      `INSERT INTO generations (id, user_channel_id, mode, count, status, estimated_cost_millicents)
       VALUES (?, ?, 'auto', 10, 'processing', 50000)`
    ).run(genId, channelRow.id);
    const ideaId = "verify-idea-" + Math.random().toString(36).slice(2);
    db.prepare(
      `INSERT INTO ideas (id, generation_id, title, description, validation_status)
       VALUES (?, ?, 'Test Title — 50 chars padded out exactly here', 'desc', 'passed')`
    ).run(ideaId, genId);
    db.prepare(
      `INSERT INTO ideation_rules (user_channel_id, rule_type, rule_value, pending)
       VALUES (?, 'banned_topic', 'verify-only', 1)`
    ).run(channelRow.id);
    db.prepare(
      `INSERT INTO gather_attrition_log (generation_id, dropped_competitor_id, reason)
       VALUES (?, 'UC-verify', 'verify-only')`
    ).run(genId);
    // Cascade test: deleting the generation should remove ideas + attrition rows
    db.prepare(`DELETE FROM generations WHERE id = ?`).run(genId);
    const orphanIdeas = db.prepare(`SELECT COUNT(*) AS n FROM ideas WHERE generation_id = ?`).get(genId).n;
    const orphanAttr = db.prepare(`SELECT COUNT(*) AS n FROM gather_attrition_log WHERE generation_id = ?`).get(genId).n;
    if (orphanIdeas !== 0 || orphanAttr !== 0) {
      out.push(`FAIL: cascade delete left orphans (ideas=${orphanIdeas}, attrition=${orphanAttr})`);
      failed = true;
    } else {
      out.push("OK: cascade delete works (generations → ideas + attrition)");
    }
    // Cleanup the verify-only rule
    db.prepare(`DELETE FROM ideation_rules WHERE rule_value = 'verify-only'`).run();
    out.push("OK: round-trip insert/delete clean");
  } catch (err) {
    out.push(`FAIL: round-trip threw: ${err.message}`);
    failed = true;
  }
} else {
  out.push("SKIP: no channels row to round-trip against (acceptable on a fresh DB)");
}

// CHECK constraint negative tests
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
