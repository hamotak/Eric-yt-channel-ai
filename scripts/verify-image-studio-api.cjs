#!/usr/bin/env node
/**
 * Live Image Studio API verifier.
 *
 * Default mode runs prompt-only OpenAI GPT-5.5 planning through
 * /api/image-runs/plan and never calls the image provider.
 *
 * Add --render to run one paid 69labs smoke test and prove the first provider
 * attempt carries the selected source thumbnail URL.
 */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const Database = require("better-sqlite3");

const repoRoot = path.resolve(__dirname, "..");
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(repoRoot, "data");
const dbPath = path.join(dataDir, "app.db");
const db = new Database(dbPath, { readonly: true });
const baseUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const shouldRender = process.argv.includes("--render");
const ACTION_PROMPT_RE =
  /^(?:Replace|Recolor|Remove|Add|Boost|Darken|Brighten|Enlarge|Reduce|Shift|Simplify|Crop|Highlight|Dim|Use|Turn|Swap|Lower|Raise|Make|Change)\b/i;
const BANNED_PROMPT_RE =
  /\b(?:Edit attached thumbnail|Do not create|Reference thumbnail|Target title|preserve|focal hierarchy|overall YouTube thumbnail psychology|keep|maintain|retain|remain|still|same|sickly|organic|veins?|vein-like|alive|living|biological|flesh|blood|infected|diseased|corpse|rotting|69labs|nano banana|claude|fable|sonnet|openai|chatgpt|gpt)\b/i;

function dollarsFromMillicents(value) {
  return value / 100000;
}

function formatUsd(value) {
  return `$${value.toFixed(5)}`;
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sourceVideosFromAttribution(value) {
  const parsed = safeJson(value, null);
  if (!parsed) return [];
  return [
    parsed.topic_source,
    parsed.format_source,
    ...(Array.isArray(parsed.topic_evidence_sources)
      ? parsed.topic_evidence_sources
      : []),
  ].filter((item) => item && item.thumbnail_url);
}

function selectIdeaWithSourceThumbnail() {
  const rows = db
    .prepare(
      `SELECT i.id, i.title, i.source_attribution
       FROM ideas i
       JOIN generations g ON g.id = i.generation_id
       WHERE i.source_attribution LIKE '%thumbnail_url%'
       ORDER BY i.created_at DESC
       LIMIT 80`
    )
    .all();
  for (const row of rows) {
    const sources = sourceVideosFromAttribution(row.source_attribution);
    if (sources.length > 0) return { ...row, source: sources[0] };
  }
  throw new Error("No idea with source thumbnails found in SQLite");
}

async function postJson(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${pathname} HTTP ${response.status}: ${data.error || response.statusText}`);
  }
  return data;
}

async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${pathname} HTTP ${response.status}: ${data.error || response.statusText}`);
  }
  return data;
}

function assertPlanningResponse(plan, expectedCount) {
  assert.equal(plan.status, "planned");
  assert.equal(plan.renderer?.provider, "69labs");
  assert.equal(plan.renderer?.submitted, false);
  assert.equal(plan.mode, "ideate");
  assert.equal(plan.generationMode, "remix");
  assert.ok(plan.plannerUsage, "plannerUsage is required");
  assert.equal(plan.plannerUsage.provider, "openai");
  assert.equal(plan.plannerUsage.model, "gpt-5.5");
  assert.equal(plan.directions.length, expectedCount);
  for (const direction of plan.directions) {
    assert.equal(direction.imageUrls.length, 1);
    assert.equal(direction.referenceIds.length, 1);
    assertActionOnlyPrompt(direction.prompt, plan.title);
    const matchingReference = plan.references.find(
      (ref) =>
        ref.id === direction.referenceIds[0] &&
        ref.thumbnailUrl === direction.imageUrls[0]
    );
    assert.ok(matchingReference, "direction reference must match selected references");
  }
  if (expectedCount === 4) {
    const promptHashes = new Set(
      plan.directions.map((direction) =>
        crypto.createHash("sha256").update(direction.prompt).digest("hex").slice(0, 16)
      )
    );
    assert.equal(promptHashes.size, 4, "four remix directions must have distinct prompts");
  }
  return plan.directions[0];
}

function assertActionOnlyPrompt(prompt, title) {
  assert.ok(ACTION_PROMPT_RE.test(prompt), `prompt must start with action verb: ${prompt}`);
  assert.ok(prompt.length <= 350, "provider prompt must stay short");
  assert.doesNotMatch(prompt, /^Original astronomy/i);
  assert.doesNotMatch(prompt, BANNED_PROMPT_RE);
  if (title) {
    assert.doesNotMatch(
      prompt,
      new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    );
  }
}

function printUsage(usage) {
  const cost = dollarsFromMillicents(usage.costMillicents);
  console.log(
    [
      "AI_PLANNER_USAGE",
      `provider=${usage.provider}`,
      `model=${usage.model}`,
      `input=${usage.inputTokens}`,
      `output=${usage.outputTokens}`,
      `cache_write=${usage.cacheWriteTokens}`,
      `cache_read=${usage.cacheReadTokens}`,
      `duration_ms=${usage.durationMs}`,
      `estimated=${formatUsd(cost)}`,
    ].join(" ")
  );
}

function getRenderRows(runId) {
  const freshDb = new Database(dbPath, { readonly: true });
  try {
    return freshDb
      .prepare(
        `SELECT id, rank, status, job_id, model, source_images_json, provider_attempts_json, prompt
         FROM image_candidates
         WHERE run_id = ?
         ORDER BY rank ASC`
      )
      .all(runId);
  } finally {
    freshDb.close();
  }
}

async function waitForRun(runId) {
  const started = Date.now();
  while (Date.now() - started < 12 * 60 * 1000) {
    const { run } = await getJson(`/api/image-runs/${encodeURIComponent(runId)}`);
    if (run.status === "completed" || run.status === "failed") return run;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Timed out waiting for image run ${runId}`);
}

async function verifyRender(payload) {
  const runStart = await postJson("/api/image-runs", payload);
  const runId = runStart.request_id;
  assert.ok(runId, "render endpoint must return request_id");
  const run = await waitForRun(runId);
  assert.notEqual(
    run.status,
    "failed",
    `render failed phase=${run.phase || "n/a"} category=${run.errorCategory || "n/a"} error=${run.error || "n/a"}`
  );
  const rows = getRenderRows(runId);
  assert.equal(rows.length, 1);
  const candidate = rows[0];
  const sourceImages = safeJson(candidate.source_images_json, []);
  const attempts = safeJson(candidate.provider_attempts_json, []);
  assert.ok(sourceImages.length > 0, "candidate source_images_json must be non-empty");
  assertActionOnlyPrompt(candidate.prompt || "", payload.prompt);
  assert.ok(attempts.length >= 1, "provider attempts must be recorded");
  assert.equal(attempts[0].attemptType, "reference");
  assert.match(attempts[0].model || candidate.model || "", /nano.*banana.*pro/i);
  assert.equal(attempts[0].imageUrls.length, 1);
  assert.equal(attempts[0].imageUrls[0], sourceImages[0].thumbnailUrl);
  assert.equal(attempts[0].imagePayloads?.length, 1);
  assert.equal(attempts[0].imagePayloads[0].sourceUrl, sourceImages[0].thumbnailUrl);
  assert.equal(attempts[0].imagePayloads[0].submittedKind, "data_url");
  assert.match(attempts[0].imagePayloads[0].submittedPreview, /^data:image\//);
  assert.ok(attempts[0].imagePayloads[0].byteSize > 0);
  assert.match(attempts[0].imagePayloads[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(ACTION_PROMPT_RE.test(attempts[0].promptPreview));
  assert.doesNotMatch(attempts[0].promptPreview, BANNED_PROMPT_RE);
  assert.ok(attempts[0].promptPreview.length <= 300);
  assert.ok(attempts[0].promptHash, "first attempt prompt hash is required");
  const retryIndex = attempts.findIndex((attempt) => attempt.attemptType === "source_free_retry");
  if (retryIndex >= 0) {
    assert.equal(
      attempts[retryIndex].imageUrls.length,
      0,
      "source-free recovery must not send reference images"
    );
  }
  console.log(
    [
      "RENDER_SMOKE",
      `run=${runId}`,
      `status=${run.status}`,
      `candidate=${candidate.id}`,
      `job=${candidate.job_id || attempts[0].jobId || "n/a"}`,
      `model=${candidate.model || attempts[0].model}`,
      `source=${attempts[0].imageUrls[0]}`,
      `source_free_retry=${retryIndex >= 0 ? "yes" : "no"}`,
      `first_prompt_hash=${attempts[0].promptHash}`,
    ].join(" ")
  );
}

async function main() {
  const idea = selectIdeaWithSourceThumbnail();
  const sampleCount = shouldRender ? 1 : 4;
  const payload = {
    prompt: idea.title,
    sourceIdeaId: idea.id,
    sampleCount,
    aspectRatio: "16:9",
    resolution: "1k",
    aiAssist: true,
    generationMode: "remix",
  };
  const plan = await postJson("/api/image-runs/plan", payload);
  const direction = assertPlanningResponse(plan, sampleCount);
  printUsage(plan.plannerUsage);
  console.log(
    [
      "PLAN_OK",
      `idea=${idea.id}`,
      `directions=${plan.directions.length}`,
      `reference_id=${direction.referenceIds[0]}`,
      `source=${direction.imageUrls[0]}`,
      `prompt_sha=${crypto
        .createHash("sha256")
        .update(direction.prompt)
        .digest("hex")
        .slice(0, 16)}`,
    ].join(" ")
  );
  if (shouldRender) {
    await verifyRender(payload);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
