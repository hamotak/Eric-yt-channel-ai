#!/usr/bin/env node
/**
 * FIX-C.6: backfill channel_handle on existing source_attribution rows
 * where the source is one of the user's own channels.
 *
 * The FIX-A backfill (scripts/backfill-source-attribution.cjs) reconstructs
 * source objects from the YouTube Data API. For own-channel sources, it
 * fetches the handle via channels.list — which works fine. But fresh
 * generations (post-FIX-A) emit channel_handle: null for own uploads
 * because gather() didn't carry channels.handle through. The pipeline
 * now does (this script's sibling commit). This script repairs the rows
 * that were generated in the gap.
 *
 * Match strategy: for each source in source_attribution where
 * channel_handle is null, look up channels.handle WHERE LOWER(title) =
 * LOWER(source.channel_name). Case-insensitive title match against the
 * user's own channels table.
 *
 * Idempotent: rows already with channel_handle are skipped.
 * No YT API calls — all data is local.
 *
 * Run: node scripts/backfill-own-channel-handle.cjs
 */

const path = require("node:path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "data", "app.db");

function main() {
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");

  // Map of LOWER(title) -> handle for the user's own channels
  const ownChannels = db
    .prepare(`SELECT title, handle FROM channels WHERE handle IS NOT NULL`)
    .all();
  const handleByLowerTitle = new Map();
  for (const c of ownChannels) {
    if (c.title && c.handle) {
      handleByLowerTitle.set(c.title.toLowerCase(), c.handle);
    }
  }
  if (handleByLowerTitle.size === 0) {
    console.log("No channels with handles in the user's own channels table — nothing to backfill.");
    process.exit(0);
  }
  console.log(`Reference: ${handleByLowerTitle.size} own channels with handles`);
  for (const [t, h] of handleByLowerTitle.entries()) {
    console.log(`  "${t}" -> ${h}`);
  }

  const rows = db
    .prepare(
      `SELECT id, source_attribution FROM ideas
       WHERE source_attribution IS NOT NULL
         AND source_attribution LIKE '%"channel_handle":null%'`
    )
    .all();

  if (rows.length === 0) {
    console.log("Nothing to backfill — no rows with null channel_handle.");
    process.exit(0);
  }
  console.log(`\nScanning ${rows.length} ideas with at least one null channel_handle…`);

  let upgraded = 0;
  let topicFilled = 0;
  let formatFilled = 0;
  const update = db.prepare(`UPDATE ideas SET source_attribution = ? WHERE id = ?`);

  const tx = db.transaction(() => {
    for (const row of rows) {
      let sa;
      try {
        sa = JSON.parse(row.source_attribution);
      } catch {
        continue;
      }
      let changed = false;

      for (const key of ["topic_source", "format_source"]) {
        const src = sa[key];
        if (!src || typeof src !== "object") continue;
        if (src.channel_handle) continue;
        const lookup =
          typeof src.channel_name === "string"
            ? handleByLowerTitle.get(src.channel_name.toLowerCase())
            : null;
        if (lookup) {
          src.channel_handle = lookup;
          changed = true;
          if (key === "topic_source") topicFilled++;
          else formatFilled++;
        }
      }

      if (changed) {
        update.run(JSON.stringify(sa), row.id);
        upgraded++;
      }
    }
  });
  tx();

  console.log(
    `\nDone. Upgraded ${upgraded} rows (topic_source filled: ${topicFilled}, format_source filled: ${formatFilled}).`
  );
  process.exit(0);
}

main();
