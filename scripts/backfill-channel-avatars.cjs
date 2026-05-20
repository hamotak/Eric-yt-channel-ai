#!/usr/bin/env node
/**
 * One-time backfill: fetch every locally-bound channel's avatar from
 * YouTube and persist it to channels.avatar_url. A single channels.list
 * call covers up to 50 channels in one request (we have 6 — fits).
 *
 * Idempotent: only updates rows where avatar_url IS NULL or empty.
 * Going forward both /api/youtube/sync and /api/sync/user-videos write
 * avatar_url on every channel resolution, so this script is a one-shot.
 *
 * Usage:
 *   DATA_DIR=/Users/.../data node scripts/backfill-channel-avatars.cjs
 */

const path = require("path");
const Database = require("better-sqlite3");
const https = require("https");

const DATA_DIR =
  process.env.DATA_DIR ||
  path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "app.db");

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

// Idempotent column bootstrap — the running dev server's db.ts module
// init also adds these, but the script may run before that re-evaluates
// (turbopack HMR doesn't always re-execute top-level code on restart).
const cols = db.prepare(`PRAGMA table_info(channels)`).all();
if (!cols.some((c) => c.name === "avatar_url")) {
  db.exec(`ALTER TABLE channels ADD COLUMN avatar_url TEXT`);
}

const integ = db
  .prepare(`SELECT api_key FROM integrations WHERE name = 'youtube'`)
  .get();
if (!integ || !integ.api_key) {
  console.error("No YouTube API key in integrations table. Aborting.");
  process.exit(1);
}
const apiKey = integ.api_key;

const rows = db
  .prepare(
    `SELECT id, title FROM channels
     WHERE avatar_url IS NULL OR avatar_url = ''
     ORDER BY subscriber_count DESC NULLS LAST`
  )
  .all();

if (rows.length === 0) {
  console.log("All channels already have avatar_url. Nothing to do.");
  process.exit(0);
}

const ids = rows.map((r) => r.id);
console.log(
  `Backfilling ${ids.length} channel${ids.length === 1 ? "" : "s"}:`
);
for (const r of rows) console.log(`  - ${r.title} (${r.id})`);
console.log();

const url = new URL("https://www.googleapis.com/youtube/v3/channels");
url.searchParams.set("part", "snippet");
url.searchParams.set("id", ids.join(","));
url.searchParams.set("key", apiKey);

function fetchJson(u) {
  return new Promise((resolve, reject) => {
    https
      .get(u, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode >= 400) {
              reject(
                new Error(
                  `HTTP ${res.statusCode}: ${parsed.error?.message ?? body.slice(0, 200)}`
                )
              );
              return;
            }
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Parse failure: ${err.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

(async () => {
  const res = await fetchJson(url.toString());
  const items = res.items ?? [];
  const byId = new Map(items.map((it) => [it.id, it]));

  const update = db.prepare(
    `UPDATE channels SET avatar_url = ? WHERE id = ?`
  );
  let updated = 0;
  let missing = 0;
  for (const r of rows) {
    const it = byId.get(r.id);
    const thumb =
      it?.snippet?.thumbnails?.high?.url ??
      it?.snippet?.thumbnails?.medium?.url ??
      it?.snippet?.thumbnails?.default?.url ??
      null;
    if (thumb) {
      update.run(thumb, r.id);
      updated++;
      console.log(`  set ${r.id} -> ${thumb}`);
    } else {
      missing++;
      console.warn(`  no thumbnail returned for ${r.id} (${r.title})`);
    }
  }

  console.log();
  console.log(
    `Updated ${updated} row${updated === 1 ? "" : "s"}.` +
      (missing ? ` ${missing} missing.` : "")
  );
  console.log(
    `Quota used: 1 unit (single channels.list call covering ${ids.length} ids).`
  );
})();
