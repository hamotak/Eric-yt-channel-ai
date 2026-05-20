#!/usr/bin/env node
/**
 * FIX-A.4: Backfill source_attribution to the new shape.
 *
 * Old shape (pre-FIX-A):
 *   { family, topic_source_video_id, format_source_video_id, reasoning }
 *
 * New shape:
 *   { family, topic_source: { video_id, title, channel_name, channel_handle, multiplier },
 *             format_source: { ... } | null,
 *             reasoning }
 *
 * multiplier is NULL on backfilled rows — we don't have the historical
 * per-channel median snapshot. Fresh generations get the actual value.
 *
 * Run:  node scripts/backfill-source-attribution.cjs
 * Idempotent: rows already on the new shape are skipped. Re-running is safe.
 */

const path = require("node:path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "data", "app.db");
const YT_BASE = "https://www.googleapis.com/youtube/v3";

function normalizeHandle(s) {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function chunked(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function ytFetch(endpoint, params, apiKey) {
  const url = new URL(`${YT_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("key", apiKey);
  const r = await fetch(url.toString(), { cache: "no-store" });
  if (!r.ok) {
    let detail = "";
    try {
      detail = (await r.json())?.error?.message ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(`YT ${endpoint} ${r.status}: ${detail || r.statusText}`);
  }
  return await r.json();
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");

  const apiKeyRow = db
    .prepare(`SELECT api_key FROM integrations WHERE name='youtube'`)
    .get();
  const apiKey = apiKeyRow?.api_key;
  if (!apiKey) {
    console.error("FAIL: no YouTube API key in integrations table");
    process.exit(1);
  }

  // Pull rows where source_attribution has the OLD shape (any of the bare
  // *_video_id fields) but does NOT already have a nested topic_source object.
  const candidates = db
    .prepare(
      `SELECT id, source_attribution FROM ideas
       WHERE source_attribution IS NOT NULL
         AND (source_attribution LIKE '%topic_source_video_id%' OR source_attribution LIKE '%format_source_video_id%')
         AND source_attribution NOT LIKE '%"topic_source":{%'`
    )
    .all();

  if (candidates.length === 0) {
    console.log("Nothing to backfill — every row already on new shape.");
    process.exit(0);
  }

  console.log(`Backfilling ${candidates.length} ideas…`);

  // Parse old shape and collect unique IDs
  const oldSa = new Map(); // idea.id -> parsed sa
  const videoIds = new Set();
  for (const row of candidates) {
    let sa;
    try {
      sa = JSON.parse(row.source_attribution);
    } catch {
      console.warn(`  skip ${row.id}: malformed JSON`);
      continue;
    }
    oldSa.set(row.id, sa);
    if (typeof sa.topic_source_video_id === "string") videoIds.add(sa.topic_source_video_id);
    if (typeof sa.format_source_video_id === "string") videoIds.add(sa.format_source_video_id);
  }
  console.log(`  ${videoIds.size} unique video IDs to look up`);

  // Batch videos.list
  const videoMap = new Map(); // video_id -> { title, channelId, channelTitle }
  let ytCalls = 0;
  for (const chunk of chunked([...videoIds], 50)) {
    const data = await ytFetch("videos", { part: "snippet", id: chunk.join(",") }, apiKey);
    ytCalls++;
    for (const item of data.items ?? []) {
      videoMap.set(item.id, {
        title: item.snippet?.title ?? "",
        channelId: item.snippet?.channelId ?? "",
        channelTitle: item.snippet?.channelTitle ?? "",
      });
    }
  }
  console.log(`  videos.list: ${ytCalls} call(s), resolved ${videoMap.size}/${videoIds.size}`);

  // Batch channels.list for handles
  const channelIds = new Set();
  for (const v of videoMap.values()) if (v.channelId) channelIds.add(v.channelId);
  const channelMap = new Map(); // channelId -> { name, handle }
  for (const chunk of chunked([...channelIds], 50)) {
    const data = await ytFetch("channels", { part: "snippet", id: chunk.join(",") }, apiKey);
    ytCalls++;
    for (const item of data.items ?? []) {
      channelMap.set(item.id, {
        name: item.snippet?.title ?? "",
        handle: normalizeHandle(item.snippet?.customUrl),
      });
    }
  }
  console.log(`  channels.list: total ${ytCalls} YT calls so far, resolved ${channelMap.size}/${channelIds.size}`);

  function buildSource(videoId) {
    if (!videoId) return null;
    const v = videoMap.get(videoId);
    if (!v) return null; // video deleted/private — drop source
    const ch = v.channelId ? channelMap.get(v.channelId) : undefined;
    return {
      video_id: videoId,
      title: v.title,
      channel_name: ch?.name ?? v.channelTitle ?? "",
      channel_handle: ch?.handle ?? null,
      multiplier: null,
    };
  }

  let upgraded = 0;
  let droppedSources = 0;
  const update = db.prepare(`UPDATE ideas SET source_attribution = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const [ideaId, sa] of oldSa.entries()) {
      const topicSrc = buildSource(sa.topic_source_video_id);
      const formatSrc = buildSource(sa.format_source_video_id);
      if (sa.topic_source_video_id && !topicSrc) droppedSources++;
      if (sa.format_source_video_id && !formatSrc) droppedSources++;
      const newSa = {
        family: sa.family,
        topic_source: topicSrc,
        format_source: formatSrc,
        reasoning: sa.reasoning,
      };
      update.run(JSON.stringify(newSa), ideaId);
      upgraded++;
    }
  });
  tx();

  console.log(`Done. Upgraded ${upgraded} rows. Dropped ${droppedSources} unresolved sources (video deleted/private).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
