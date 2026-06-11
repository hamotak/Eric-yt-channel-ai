#!/usr/bin/env node
/**
 * Focused pure-function checks for Image Studio behavior that can run without
 * network, Next, or 69labs credentials.
 *
 * Run: node scripts/verify-image-studio-behavior.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const repoRoot = path.resolve(__dirname, "..");
const sixtyNineLabsPath = path.join(
  repoRoot,
  "src/lib/image-studio/sixty-nine-labs.ts"
);
const plannerPath = path.join(repoRoot, "src/lib/image-studio/planner.ts");
const processorPath = path.join(repoRoot, "src/lib/image-studio/processor.ts");
const referencesPath = path.join(repoRoot, "src/lib/image-studio/references.ts");
const typesPath = path.join(repoRoot, "src/lib/image-studio/types.ts");
const imageStudioPagePath = path.join(repoRoot, "src/app/image-studio/page.tsx");
const channelSwitcherPath = path.join(repoRoot, "src/components/channel-switcher.tsx");
const dbPath = path.join(repoRoot, "src/lib/db.ts");
const integrationsRoutePath = path.join(repoRoot, "src/app/api/integrations/route.ts");
const settingsIntegrationsPath = path.join(
  repoRoot,
  "src/app/settings/integrations/page.tsx"
);

function matchingParenIndex(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`could not match function parameter list near ${openIndex}`);
}

function matchingBraceIndex(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`could not match function body near ${openIndex}`);
}

function extractFunction(source, name) {
  const match = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`
  ).exec(source);
  if (!match) throw new Error(`missing production helper: ${name}`);
  const functionStart = match.index;
  const paramsStart = source.indexOf("(", match.index);
  const paramsEnd = matchingParenIndex(source, paramsStart);
  const bodyStart = source.indexOf("{", paramsEnd);
  const bodyEnd = matchingBraceIndex(source, bodyStart);
  return source.slice(functionStart, bodyEnd + 1);
}

function loadProductionHelpers(sourcePath, functionNames, options = {}) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const helperSource = [
    options.prefix ?? "",
    ...functionNames.map((name) => extractFunction(source, name)),
    options.suffix ?? "",
  ].join("\n\n");
  const compiled = ts.transpileModule(helperSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  const context = {
    console,
    exports: module.exports,
    module,
  };
  vm.createContext(context);
  vm.runInContext(compiled, context, { filename: sourcePath });
  return context.module.exports;
}

function assertProductionRetryWiring() {
  const source = fs.readFileSync(processorPath, "utf8");
  assert.match(source, /const IMAGE_PROVIDER_SUBMIT_SPACING_MS = 4000/);
  assert.match(source, /IMAGE_PROVIDER_RATE_LIMIT_RETRY_MS/);
  assert.match(source, /IMAGE_PROVIDER_MAX_RATE_LIMIT_RETRIES/);
  assert.match(source, /IMAGE_PROVIDER_RATE_LIMIT_RETRY_MAX_MS/);
  assert.match(source, /function sleep\(ms: number\): Promise<void>/);
  assert.match(source, /function classifyImageRunError/);
  assert.match(source, /function markRunPhase/);
  assert.match(source, /function markRunProcessing/);
  assert.match(source, /function markCandidateWaitingForCapacity/);
  assert.match(source, /error_category/);
  assert.match(source, /export function isProviderRateLimitError/);
  assert.match(source, /providerRetryAfterMs/);
  assert.match(source, /waitForProviderCreationSlot/);
  assert.match(source, /getImageLimits/);
  assert.match(source, /Concurrent image generation limit reached/);
  assert.match(source, /submitAttemptWithRateLimitRetry/);
  assert.match(source, /retrying same provider payload/);
  assert.match(source, /buildSimplifiedReferenceRetryPrompt/);
  assert.match(source, /Source-free retry after the provider rejected the reference image/);
  assert.match(source, /const activeImageRunPipelines = new Set<string>\(\)/);
  assert.match(source, /startImagePipeline/);
  assert.match(source, /shouldResumeInterruptedRun/);
  assert.match(source, /directionFromCandidate/);
  assert.doesNotMatch(source, /const pendingJobs/);
  assert.match(source, /const candidateJobs = jobs\s*\.map/);
  assert.match(source, /const runCandidateJob = async/);
  assert.match(source, /await Promise\.all\(\s*candidateJobs\.map\(\(job, index\) =>\s*runCandidateJob\(job, index \* IMAGE_PROVIDER_SUBMIT_SPACING_MS\)/);
  assert.doesNotMatch(source, /for \(let index = 0; index < jobs\.length; index \+= 1\)/);
  assert.doesNotMatch(source, /Promise\.allSettled\(candidateJobs\)/);
  assert.match(source, /await submitAttemptWithRateLimitRetry\(\s*retryPrompt,\s*\[\],\s*input\.model,\s*"source_free_retry"\s*\);/);
  assert.doesNotMatch(source, /fallbackModel/);
  assert.doesNotMatch(source, /excludeModelIds/);
  assert.doesNotMatch(source, /Source-free Nano Banana generation/);
  assert.match(source, /directionForProvider\(\{ direction, references, run \}\)/);
  assert.match(source, /function readChannelStyleExamples/);
  assert.match(source, /channelStyleExamples = readChannelStyleExamples\(run\.user_channel_id\)/);
  assert.match(source, /channelStyleExamples,/);
  assert.match(source, /Local image uploads were available to the AI planner/);
  assert.match(source, /const thumbnailStyleGoals = \(channel\.thumbnail_style_goals \?\? ""\)\.trim\(\)/);
  assert.match(source, /const thumbnailDesignRules = \(channel\.thumbnail_design_rules \?\? ""\)\.trim\(\)/);
  assert.match(source, /thumbnailStyleGoals,\s*\n\s*thumbnailDesignRules,/);
  assert.match(source, /assertProviderDirectionsHaveRequiredReferences\(\{ run, references, directions \}\)/);
  assert.match(source, /imageUrls: \[primaryRef\.thumbnailUrl\]/);
  assert.match(source, /referenceIds: \[primaryRef\.id\]/);
  assert.match(source, /refs: referencesForDirection\(providerDirection, plan\.references\)/);
  assert.match(source, /if \(candidates\.length === 0\) \{\s*return run;\s*\}/);
  assert.match(source, /provider_attempts_json/);
  assert.match(source, /appendProviderAttempt\(/);
  assert.match(source, /markLatestProviderAttemptJob\(/);
  assert.match(source, /markLatestProviderAttemptPayloads\(/);
  assert.match(source, /markLatestProviderAttemptError\(/);
  assert.match(source, /prepareProviderImagePayloads\(/);
  assert.match(source, /providerImagePayloadFromUrl\(/);
  assert.match(source, /data:\$\{mimeType\};base64/);
  assert.match(source, /source_free_retry/);
  assert.match(source, /if \(firstImageUrls\.length > 0\)/);
  assert.doesNotMatch(source, /source_images_json = '\[\]'/);
  assert.match(source, /formatRetryFailureMessage\(\{ retryMessage, firstMessage \}\)/);
}

function assertPlannerWiring() {
  const source = fs.readFileSync(plannerPath, "utf8");
  assert.match(source, /export const IMAGE_STUDIO_PLANNER_PROVIDER = "openai"/);
  assert.match(source, /export const IMAGE_STUDIO_PLANNER_MODEL = "gpt-5\.5"/);
  assert.match(source, /export const IMAGE_STUDIO_FALLBACK_PROVIDER = "anthropic"/);
  assert.match(source, /export const IMAGE_STUDIO_FALLBACK_MODEL = "claude-sonnet-4-6"/);
  assert.doesNotMatch(source, /claude-fable-5/);
  assert.match(source, /import OpenAI from "openai"/);
  assert.match(source, /getIntegration\("openai"\)/);
  assert.match(source, /getIntegration\("claude"\)/);
  assert.match(source, /function getOpenAIClient/);
  assert.match(source, /function getAnthropicClient/);
  assert.match(source, /model: IMAGE_STUDIO_PLANNER_MODEL/);
  assert.match(source, /model: IMAGE_STUDIO_FALLBACK_MODEL/);
  assert.match(source, /PLANNER_REQUEST_TIMEOUT_MS/);
  assert.match(source, /PLANNER_CONNECTION_RETRIES/);
  assert.match(source, /PLANNER_CONNECTION_FAILURE_MESSAGE/);
  assert.match(source, /maxRetries:\s*0/);
  assert.match(source, /timeout:\s*PLANNER_REQUEST_TIMEOUT_MS/);
  assert.match(source, /createOpenAIPlannerResponse\(client, body\)/);
  assert.match(source, /client\.responses\.create\(body\)/);
  assert.match(source, /createAnthropicPlannerMessage\(client,/);
  assert.doesNotMatch(source, /temperature\s*:/);
  assert.match(source, /recordAiUsage\(\{/);
  assert.match(source, /provider: IMAGE_STUDIO_PLANNER_PROVIDER/);
  assert.match(source, /provider: IMAGE_STUDIO_FALLBACK_PROVIDER/);
  assert.match(source, /activeTools: \["image_studio", "openai_planner"\]/);
  assert.match(source, /activeTools: \["image_studio", "anthropic_fallback"\]/);
  assert.match(source, /OPENAI_PLANNER_TEXT_FORMAT/);
  assert.match(source, /type: "input_image"/);
  assert.match(source, /detail: "high"/);
  assert.match(source, /reasoning: \{ effort: "high" as const \}/);
  assert.match(source, /max_output_tokens:\s*7000/);
  assert.match(source, /max_tokens:\s*7000/);
  assert.match(source, /prompt_cache_key: `image-studio:\$\{input\.userChannelId\}`/);
  assert.match(source, /prompt_cache_retention: "24h" as const/);
  assert.match(source, /function styleExamplesText/);
  assert.match(source, /function savedStyleProfileText/);
  assert.match(source, /function styleImageUrls/);
  assert.match(source, /MAX_SELECTED_REFERENCE_INPUT_IMAGES = 10/);
  assert.match(source, /MAX_STYLE_IMAGE_INPUTS_PER_OUTCOME = 4/);
  assert.match(source, /styleProfile/);
  assert.match(source, /Saved channel thumbnail style profile:/);
  assert.match(source, /Last-30-day channel winners and losers:/);
  assert.match(source, /getImagePlannerStyleProfile/);
  assert.match(source, /upsertImagePlannerStyleProfile/);
  assert.match(source, /function assertValidPlannerDirections/);
  assert.match(source, /function persistStyleProfile/);
  assert.match(source, /function planWithOpenAI/);
  assert.match(source, /function planWithAnthropic/);
  assert.match(source, /fallback/);
  assert.match(source, /Channel thumbnail notes:/);
  assert.match(source, /thumbnailStyleGoals/);
  assert.match(source, /thumbnailDesignRules/);
  assert.match(source, /Apply the channel thumbnail notes privately/);
  assert.match(source, /requireReference/);
  assert.match(source, /selectedReferenceId/);
  assert.match(source, /visualRead/);
  assert.match(source, /visibleElements/);
  assert.match(source, /thumbnailRuleCheck/);
  assert.match(source, /visualBrainstorm/);
  assert.match(source, /visibleDifference/);
  assert.match(source, /editReason/);
  assert.match(source, /providerPrompt/);
  assert.match(source, /Do not write the phrase/);
  assert.match(source, /Edit attached thumbnail/);
  assert.match(source, /max 350 characters/);
  assert.match(source, /Start providerPrompt with an action verb/);
  assert.match(source, /Hard-ban these words\/phrases in providerPrompt/);
  assert.match(source, /four clearly distinct edits/);
  assert.match(source, /Prefer four different source thumbnails/);
  assert.match(source, /winner/);
  assert.match(source, /loser/);
  assert.match(source, /waveform, signal waveform, pulse line, or abstract data wave/);
  assert.match(source, /what will be obviously different from the other directions/);
  assert.match(source, /Do not repeat the full video title in providerPrompt/);
  assert.match(source, /Do not write phrases like "Do not create a new unrelated thumbnail"/);
  assert.match(source, /THIS IS SCARY/);
  assert.match(source, /THIS IS STRANGE/);
}

function assertReferenceWiring() {
  const source = fs.readFileSync(referencesPath, "utf8");
  assert.match(source, /function isIdeaSourceReference/);
  assert.match(source, /!ideaSource/);
  assert.match(source, /export function pickPrimaryImageReference/);
  assert.match(source, /getChannel/);
  assert.match(source, /const channel = getChannel\(userChannelId\)/);
  assert.match(source, /channelName: channel\?\.title \?\? null/);
  assert.match(source, /channelHandle: channel\?\.handle \?\? null/);
  assert.doesNotMatch(source, /kind: "channel_winner"[\s\S]*?channelName: null,[\s\S]*?channelHandle: null/);
}

function assertTypesWiring() {
  const source = fs.readFileSync(typesPath, "utf8");
  assert.match(source, /export type ImagePlannerUsage/);
  assert.match(source, /provider: "openai" \| "anthropic"/);
  assert.match(source, /export type ImageProviderAttempt/);
  assert.match(source, /export type ImageRunPhase = "planning" \| "rendering" \| "reviewing" \| "completed" \| "failed"/);
  assert.match(source, /export type ImageRunErrorCategory/);
  assert.match(source, /attemptType: "generate" \| "reference" \| "source_free_retry"/);
  assert.match(source, /provider_attempts_json: string/);
  assert.match(source, /phase: ImageRunPhase/);
  assert.match(source, /error_category: ImageRunErrorCategory \| null/);
  assert.match(source, /submittedKind: "data_url" \| "remote_url"/);
  assert.match(source, /submittedPreview: string/);
  assert.match(source, /error\?: string \| null/);
}

function assertOpenAIIntegrationWiring() {
  const dbSource = fs.readFileSync(dbPath, "utf8");
  const routeSource = fs.readFileSync(integrationsRoutePath, "utf8");
  const settingsSource = fs.readFileSync(settingsIntegrationsPath, "utf8");

  assert.match(dbSource, /provider TEXT NOT NULL DEFAULT 'anthropic'/);
  assert.match(dbSource, /export function recordAiUsage/);
  assert.match(dbSource, /export function aiUsageStats/);
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS image_planner_style_profiles/);
  assert.match(dbSource, /export function getImagePlannerStyleProfile/);
  assert.match(dbSource, /export function upsertImagePlannerStyleProfile/);
  assert.match(dbSource, /source_video_ids_json/);
  assert.match(routeSource, /"openai", "claude", "youtube", "brave", "69labs"/);
  assert.match(settingsSource, /name: "openai"/);
  assert.match(settingsSource, /GPT-5\.5 thumbnail planning/);
  assert.match(settingsSource, /platform\.openai\.com\/api-keys/);
  assert.match(settingsSource, /Do not paste a ChatGPT browser\/session token/);
  assert.match(settingsSource, /\/api\/ai\/usage|<ClaudeUsage enabled/);
}

function assertImageStudioPageWiring() {
  const source = fs.readFileSync(imageStudioPagePath, "utf8");
  assert.match(source, /type ProviderAttempt/);
  assert.match(source, /Prompt used/);
  assert.match(source, /Planner timed out/);
  assert.match(source, /Last provider message/);
  assert.match(source, /job \$\{finalAttempt\.jobId\.slice\(0, 8\)\}/);
  assert.match(source, /Original thumbnail/);
  assert.match(source, /Thumbnail pipeline/);
  assert.match(source, /Sources found/);
  assert.match(source, /Prompts planned/);
  assert.match(source, /Rendering 4 edits/);
  assert.match(source, /Review results/);
  assert.match(source, /function sourceChannelText/);
  assert.match(source, /function sourceScoreText/);
  assert.match(source, /ref\.channelName/);
  assert.match(source, /ref\.channelHandle/);
  assert.match(source, /Channel unknown/);
  assert.match(source, /md:grid-cols-2 xl:grid-cols-4/);
  assert.match(source, /min-\[520px\]:grid-cols-2/);
  assert.match(source, /xl:grid-cols-4/);
  assert.match(source, /min-h-\[17rem\]/);
  assert.match(source, /primarySourceMeta/);
  assert.match(source, /sourceScoreText\(primarySource\)/);
  assert.match(source, /Source candidates/);
  assert.doesNotMatch(source, /<details className="rounded-lg border border-border bg-muted\/10 p-4">/);
  assert.doesNotMatch(source, /Rendered prompt/);
  assert.doesNotMatch(source, /Planned edit prompt/);
  assert.doesNotMatch(source, /Provider attachment/);
  assert.doesNotMatch(source, /Sources used/);
  assert.match(source, /source_free_retry/);
}

function assertChannelSwitcherWiring() {
  const source = fs.readFileSync(channelSwitcherPath, "utf8");
  const loadingIndex = source.indexOf('if (loadState === "loading")');
  const errorIndex = source.indexOf('if (loadState === "error")');
  const hiddenIndex = source.indexOf("if (channels.length <= 1) return null;");
  assert.match(source, /type LoadState = "loading" \| "ready" \| "error"/);
  assert.match(source, /setLoadState\("loading"\)/);
  assert.match(source, /setLoadState\("ready"\)/);
  assert.match(source, /setLoadState\("error"\)/);
  assert.match(source, /autoRetryRef/);
  assert.match(source, /retryTimerRef/);
  assert.match(source, /setTimeout\(\(\) => \{/);
  assert.match(source, /Channels unavailable/);
  assert.match(source, /function retryLoad/);
  assert.match(source, /Could not switch channel/);
  assert.doesNotMatch(source, /Silent — switcher will just stay hidden/);
  assert.ok(loadingIndex >= 0, "switcher must render a loading state");
  assert.ok(errorIndex >= 0, "switcher must render an error state");
  assert.ok(hiddenIndex >= 0, "switcher may still hide after successful single-channel load");
  assert.ok(
    loadingIndex < hiddenIndex && errorIndex < hiddenIndex,
    "switcher must only hide after loading/error states have been handled"
  );
}

const imageProvider = loadProductionHelpers(
  sixtyNineLabsPath,
  [
    "detailFromUnknown",
    "positiveInt",
    "retryAfterMsFromHeader",
    "isProviderCapacityDetail",
    "imageJobFailureMessage",
    "formatImageJobFailure",
    "optionValues",
    "supportsRatio",
    "supportsResolution",
    "modelName",
    "normalizedModelName",
    "isPro",
    "isNanoBananaPro",
    "chooseImageModel",
    "assertImageModelCompatible",
  ],
  {
    prefix: [
      "let __models = [];",
      "async function listImageModels() { return __models; }",
    ].join("\n"),
    suffix: [
      "exports.__setModels = (models) => { __models = models; };",
    ].join("\n"),
  }
);

const processor = loadProductionHelpers(
  processorPath,
  [
    "hasProviderDetail",
    "normalizeProviderRateLimitText",
    "basicNormalizeImageErrorText",
    "normalizeImageErrorText",
    "trimTrailingSentencePunctuation",
    "equivalentImageErrorMessages",
    "formatRetryFailureMessage",
    "formatReferenceRecoveryFailureMessage",
    "isStoredFailureMissingDetails",
    "runFailureMessageFromCandidates",
    "normalizeRunPhase",
    "normalizeErrorCategory",
    "isPlannerTimeoutMessage",
    "classifyImageRunError",
    "isRetryableImageGenerationError",
    "isProviderConcurrencyLimitMessage",
    "isProviderRateLimitError",
    "compactPromptText",
    "sentenceFragments",
    "providerSafePromptText",
    "buildReferenceEditPrompt",
    "validateReferenceProviderPrompt",
    "buildSimplifiedReferenceRetryPrompt",
    "buildSimplifiedRetryPrompt",
  ],
  {
    prefix: [
      "const IMAGE_PROVIDER_BUSY_MESSAGE = 'Image provider is busy. Wait for current image jobs to finish, then retry.';",
      "const IMAGE_PROVIDER_RATE_LIMIT_MESSAGE = 'Image provider rate-limited this request. Wait a moment, then retry.';",
      "const IMAGE_PROVIDER_RATE_LIMIT_RETRY_MAX_MS = 120000;",
      "const MAX_REFERENCE_PROVIDER_PROMPT_CHARS = 350;",
      "const ACTION_PROVIDER_PROMPT_RE = /^(?:Replace|Recolor|Remove|Add|Boost|Darken|Brighten|Enlarge|Reduce|Shift|Simplify|Crop|Highlight|Dim|Use|Turn|Swap|Lower|Raise|Make|Change)\\b/i;",
      "const BANNED_REFERENCE_PROVIDER_PROMPT_PATTERNS = [",
      "  { pattern: /\\bedit\\s+(?:the\\s+)?attached\\s+thumbnail\\b/i, label: 'old edit wrapper' },",
      "  { pattern: /\\b(?:keep|preserve|maintain|retain|remain|still)\\b/i, label: 'generic preserve wording' },",
      "  { pattern: /\\bsame\\b/i, label: 'generic sameness wording' },",
      "  { pattern: /\\bdo not create\\b/i, label: 'negative wrapper wording' },",
      "  { pattern: /\\breference thumbnail\\b/i, label: 'reference-title wording' },",
      "  { pattern: /\\btarget title\\b/i, label: 'target-title wording' },",
      "  { pattern: /\\bfocal hierarchy\\b/i, label: 'internal thumbnail analysis' },",
      "  { pattern: /\\boverall YouTube thumbnail psychology\\b/i, label: 'internal thumbnail analysis' },",
      "  { pattern: /\\b(?:69labs|nano banana|claude|fable|sonnet|openai|chatgpt|gpt)\\b/i, label: 'model/provider wording' },",
      "  { pattern: /\\b\\d+(?:\\.\\d+)?\\s*(?:x|×)\\+?\\b/i, label: 'source analytics' },",
      "  { pattern: /\\b(?:sickly|organic|veins?|vein-like|alive|living|biological|flesh|blood|infected|diseased|corpse|rotting)\\b/i, label: 'provider-filter-prone biological wording' },",
      "];",
    ].join("\n"),
    suffix: [
      "exports.hasProviderDetail = hasProviderDetail;",
      "exports.normalizeImageErrorText = normalizeImageErrorText;",
      "exports.trimTrailingSentencePunctuation = trimTrailingSentencePunctuation;",
      "exports.formatReferenceRecoveryFailureMessage = formatReferenceRecoveryFailureMessage;",
      "exports.isStoredFailureMissingDetails = isStoredFailureMissingDetails;",
      "exports.runFailureMessageFromCandidates = runFailureMessageFromCandidates;",
      "exports.normalizeRunPhase = normalizeRunPhase;",
      "exports.normalizeErrorCategory = normalizeErrorCategory;",
      "exports.isPlannerTimeoutMessage = isPlannerTimeoutMessage;",
      "exports.classifyImageRunError = classifyImageRunError;",
    ].join("\n"),
  }
);

async function main() {
  assertPlannerWiring();
  assertReferenceWiring();
  assertTypesWiring();
  assertOpenAIIntegrationWiring();
  assertImageStudioPageWiring();
  assertChannelSwitcherWiring();
  assertProductionRetryWiring();

  assert.equal(
    imageProvider.imageJobFailureMessage({
      status: "FAILED",
      outputMetadata: null,
      userMessage: "Your request took too long. No credits were taken.",
    }),
    "Your request took too long. No credits were taken."
  );
  assert.equal(
    imageProvider.imageJobFailureMessage({
      status: "FAILED",
      outputMetadata: { providerMessage: "Restricted or misclassified content." },
    }),
    "Restricted or misclassified content."
  );
  assert.equal(
    imageProvider.formatImageJobFailure({
      status: "FAILED",
      message: "Image provider failed without details",
    }),
    "Image provider failed without details"
  );
  assert.equal(
    imageProvider.formatImageJobFailure({
      status: "CENSORED",
      failureReason: "Policy block",
    }),
    "Image provider censored: Policy block"
  );
  assert.equal(
    imageProvider.imageJobFailureMessage({
      status: "FAILED",
      errorMessage: "Provider internal moderation rejected the image.",
      errorCode: "PROVIDER_REJECTED",
    }),
    "Provider internal moderation rejected the image."
  );

  imageProvider.__setModels([
    {
      id: "nano-banana-pro",
      name: "Nano Banana Pro",
      supportsImageInput: true,
      aspectRatios: [{ value: "16:9" }],
      resolutions: [{ value: "1k" }, { value: "2k" }],
    },
  ]);
  const compatiblePro = await imageProvider.assertImageModelCompatible({
      model: "nano-banana-pro",
      needsImageInput: false,
      aspectRatio: "16:9",
      resolution: "1k",
    });
  assert.equal(compatiblePro.id, "nano-banana-pro");
  assert.equal(imageProvider.retryAfterMsFromHeader("12"), 12000);
  assert.equal(imageProvider.retryAfterMsFromHeader("0"), null);
  assert.equal(
    imageProvider.isProviderCapacityDetail(
      403,
      "Concurrent image generation limit reached (7). Please wait for current jobs to complete."
    ),
    true
  );
  assert.equal(
    imageProvider.isProviderCapacityDetail(403, "Invalid API key or model access denied"),
    false
  );

  imageProvider.__setModels([
    { id: "nano-banana-pro", name: "Nano Banana Pro", supportsImageInput: true },
    { id: "gpt-image-2", name: "GPT Image 2", supportsImageInput: true },
    { id: "nano-banana-2", name: "Nano Banana 2", supportsImageInput: true },
  ]);
  const chosen = await imageProvider.chooseImageModel({
    needsImageInput: true,
    aspectRatio: "16:9",
    resolution: "2k",
  });
  assert.equal(chosen.id, "nano-banana-pro");

  imageProvider.__setModels([
    { id: "nano-banana-2", name: "Nano Banana 2", supportsImageInput: true },
  ]);
  await assert.rejects(
    imageProvider.chooseImageModel({
      needsImageInput: true,
      aspectRatio: "16:9",
      resolution: "2k",
    }),
    /No 69labs Nano Banana Pro image-input model supports 16:9 at 2K/
  );
  imageProvider.__setModels([
    { id: "nano-banana-pro", name: "Nano Banana Pro", supportsImageInput: false },
  ]);
  await assert.rejects(
    imageProvider.chooseImageModel({
      needsImageInput: true,
      aspectRatio: "16:9",
      resolution: "2k",
    }),
    /No 69labs Nano Banana Pro image-input model supports 16:9 at 2K/
  );
  imageProvider.__setModels([
    { id: "gpt-image-2", name: "GPT Image 2", supportsImageInput: true },
    { id: "z-image", name: "Z-Image", supportsImageInput: false },
  ]);
  await assert.rejects(
    imageProvider.chooseImageModel({
      needsImageInput: false,
      aspectRatio: "16:9",
      resolution: "2k",
    }),
    /No 69labs Nano Banana Pro image model supports 16:9 at 2K/
  );
  imageProvider.__setModels([
    { id: "nano-banana-2", name: "Nano Banana 2", supportsImageInput: true },
    { id: "gpt-image-2", name: "GPT Image 2", supportsImageInput: true },
    { id: "z-image", name: "Z-Image", supportsImageInput: false },
  ]);
  await assert.rejects(
    imageProvider.chooseImageModel({
      needsImageInput: false,
      aspectRatio: "16:9",
      resolution: "2k",
    }),
    /No 69labs Nano Banana Pro image model supports 16:9 at 2K/
  );

  assert.equal(
    processor.isRetryableImageGenerationError(
      "Image provider failed: Your request took too long. Our providers did not respond in time."
    ),
    true
  );
  assert.equal(
    processor.isRetryableImageGenerationError(
      "Image provider failed: restricted or misclassified content in the prompt or reference image."
    ),
    true
  );
  assert.equal(
    processor.isRetryableImageGenerationError("69labs API key missing - add it in settings"),
    false
  );
  assert.equal(
    processor.isRetryableImageGenerationError(
      "No 69labs Nano Banana Pro image-input model supports 16:9 at 2K"
    ),
    false
  );
  assert.equal(
    processor.isProviderRateLimitError("69labs 429: Too many requests"),
    true
  );
  assert.equal(
    processor.isProviderRateLimitError("provider rate limit exceeded"),
    true
  );
  assert.equal(
    processor.isProviderRateLimitError(
      "69labs 403: Concurrent image generation limit reached (7). Please wait for current jobs to complete."
    ),
    true
  );
  assert.equal(
    processor.isProviderRateLimitError("internal generation pipeline failed"),
    false
  );
  assert.equal(
    processor.normalizeImageErrorText(
      "Option 3: 69labs 403: Concurrent image generation limit reached (7). Please wait for current jobs to complete."
    ),
    "Option 3: Image provider is busy. Wait for current image jobs to finish, then retry."
  );
  assert.equal(
    processor.formatRetryFailureMessage({
      retryMessage:
        "Image provider failed: This image failed in our internal generation pipeline. Try simplifying the request or changing the reference image and try again.",
      firstMessage:
        "Image provider failed: This image failed in our internal generation pipeline. Try simplifying the request or changing the reference image and try again.",
    }),
    "Retry failed with the same provider message as the first attempt: Image provider failed: This image failed in our internal generation pipeline. Try simplifying the request or changing the reference image and try again."
  );
  assert.equal(
    processor.normalizeImageErrorText("Retry failed: foo.. First attempt: bar."),
    "Retry failed: foo. First attempt: bar."
  );
  assert.equal(
    processor.normalizeImageErrorText(
      "Fallback model gpt-image-2 failed: 69labs 400: GPT Image 2 does not support resolution selection. Retry failed: retry issue. First attempt: first issue."
    ),
    "Retry failed: retry issue. First attempt: first issue."
  );
  assert.equal(
    processor.normalizeImageErrorText("Retry failed: foo. First attempt: foo."),
    "Retry failed with the same provider message as the first attempt: foo."
  );
  assert.equal(processor.normalizeRunPhase(null, "processing"), "planning");
  assert.equal(processor.normalizeRunPhase("reviewing", "completed"), "reviewing");
  assert.equal(processor.normalizeErrorCategory("planner_timeout"), "planner_timeout");
  assert.equal(processor.normalizeErrorCategory("not-real"), null);
  assert.equal(processor.isPlannerTimeoutMessage("Request timed out."), true);
  assert.equal(
    processor.classifyImageRunError({
      message: "Request timed out.",
      phase: "planning",
      candidatesCreated: false,
    }),
    "planner_timeout"
  );
  assert.equal(
    processor.classifyImageRunError({
      message: "69labs image job exceeded polling/download timeout",
      phase: "rendering",
      candidatesCreated: true,
    }),
    "download_failed"
  );
  assert.equal(
    processor.classifyImageRunError({
      message:
        "Image provider failed: This image failed in our internal generation pipeline. The most common cause is restricted or misclassified content.",
      phase: "rendering",
      candidatesCreated: true,
    }),
    "provider_rejected"
  );

  const editPrompt = processor.buildReferenceEditPrompt({
    targetTitle:
      "NtjDbmqn-Tg 35.84x outlier - There Is No Going Back JWST Found Something at the Edge",
    aspectRatio: "16:9",
    referenceTitle: '"This Is Scary" James Webb Telescope Reveals One of the Oldest Galaxies Ever Seen',
    directionPrompt:
      "Edit the attached thumbnail. Do not create a new unrelated thumbnail. Reference thumbnail title/style cue: THIS IS SCARY. Target title: NtjDbmqn-Tg 35.84x outlier - There Is No Going Back JWST Found Something at the Edge. Preserve the original layout, structure, composition, crop, focal hierarchy, color logic, contrast, font style, font size, text placement, and overall YouTube thumbnail psychology. Keep the same font style. Replace the scary wording with THIS IS STRANGE, keep the same black space background, red focal galaxy, arrow placement, blocky uppercase font, and right-side glow.",
  });
  assert.equal(editPrompt.startsWith("Replace"), true);
  assert.doesNotMatch(editPrompt, /Edit attached thumbnail/i);
  assert.doesNotMatch(editPrompt, /do not create a new unrelated thumbnail/i);
  assert.equal(editPrompt.includes("Reference thumbnail title"), false);
  assert.equal(editPrompt.includes("Target title"), false);
  assert.equal(editPrompt.includes("Preserve the original layout, structure, composition"), false);
  assert.equal(editPrompt.includes("focal hierarchy"), false);
  assert.equal(editPrompt.includes("overall YouTube thumbnail psychology"), false);
  assert.doesNotMatch(editPrompt, /\b(?:keep|preserve|maintain|retain|remain|still|same)\b/i);
  assert.equal(editPrompt.includes("font style"), false);
  assert.equal(editPrompt.includes("font size"), false);
  assert.equal(editPrompt.includes("avoid repeating the full video title"), false);
  assert.equal(editPrompt.includes("THIS IS SCARY"), false);
  assert.equal(editPrompt.includes("THIS IS STRANGE"), true);
  assert.equal(editPrompt.includes("There Is No Going Back"), false);
  assert.equal(editPrompt.includes("35.84x"), false);
  assert.equal(editPrompt.includes("outlier"), false);
  assert.equal(editPrompt.length <= 350, true);
  assert.doesNotThrow(() => processor.validateReferenceProviderPrompt(editPrompt));
  assert.throws(
    () => processor.validateReferenceProviderPrompt("Edit attached thumbnail: keep the same layout."),
    /prompt failed validation/
  );

  const safePrompt = processor.buildReferenceEditPrompt({
    targetTitle: "Webb Found a Life Signal — And Scientists Hope It's a Mistake",
    aspectRatio: "16:9",
    referenceTitle: "James Webb Found a Planet With 99.7% Chance of Life!",
    directionPrompt:
      "Replace the headline with 'PLEASE BE WRONG' — 'PLEASE' in bold yellow, 'BE WRONG' in white, arrow still pointing at the big planet. Recolor the large planet into a sickly luminous green world laced with faint glowing organic veins, hinting it is alive. Darken surrounding space and boost a sharp bright rim light along the planet's edge.",
  });
  assert.equal(safePrompt.startsWith("Replace"), true);
  assert.doesNotMatch(
    safePrompt,
    /\b(?:keep|preserve|maintain|retain|remain|still|same|sickly|organic|veins?|alive|living|biological|flesh|blood|infected|diseased|corpse|rotting)\b/i
  );
  assert.match(safePrompt, /signal lines|anomaly cue|rim light/i);
  assert.doesNotThrow(() => processor.validateReferenceProviderPrompt(safePrompt));
  assert.throws(
    () =>
      processor.validateReferenceProviderPrompt(
        "Recolor the planet into a sickly organic world with glowing veins."
      ),
    /provider-filter-prone biological wording/
  );

  const retryPrompt = processor.buildSimplifiedRetryPrompt({
    title:
      "NtjDbmqn-Tg https://example.com/image.jpg 35.84x outlier - There is No Going Back JWST Found Something at the Edge",
    aspectRatio: "16:9",
    resolution: "2k",
  });
  assert.equal(retryPrompt.includes("NtjDbmqn-Tg"), false);
  assert.equal(retryPrompt.includes("35.84x"), false);
  assert.equal(retryPrompt.includes("https://"), false);
  assert.equal(retryPrompt.includes("Clean science-news thumbnail illustration"), true);
  assert.equal(retryPrompt.includes("safe glowing anomaly"), true);
  assert.equal(retryPrompt.includes("Text-free image"), true);
  assert.equal(retryPrompt.includes("no readable words"), true);
  assert.equal(retryPrompt.includes("reference"), false);
  assert.equal(retryPrompt.includes("NO GOING BACK"), false);
  assert.equal(retryPrompt.includes("no gore"), false);
  assert.equal(retryPrompt.length <= 700, true);

  const referenceRetryPrompt = processor.buildSimplifiedReferenceRetryPrompt();
  assert.equal(referenceRetryPrompt.startsWith("Replace"), true);
  assert.equal(referenceRetryPrompt.includes("reference"), false);
  assert.doesNotThrow(() =>
    processor.validateReferenceProviderPrompt(referenceRetryPrompt)
  );
  assert.equal(
    processor.formatReferenceRecoveryFailureMessage({
      firstMessage: "Image provider failed: first.",
      referenceRetryMessage: "Image provider failed: reference.",
      sourceFreeMessage: "Image provider failed: source-free.",
    }),
    "Source-free retry failed: Image provider failed: source-free. Reference retry failed: Image provider failed: reference. First attempt: Image provider failed: first."
  );

  assert.equal(
    processor.isStoredFailureMissingDetails({
      status: "failed",
      job_id: "job-1",
      error: "Image provider failed without details",
    }),
    true
  );
  assert.equal(
    processor.isStoredFailureMissingDetails({
      status: "failed",
      job_id: "job-1",
      error: "Image provider failed: Your request took too long.",
    }),
    false
  );
  assert.equal(
    processor.isStoredFailureMissingDetails({
      status: "processing",
      job_id: "job-1",
      error: "Image provider failed without details",
    }),
    false
  );
  assert.equal(
    processor.hasProviderDetail("Image provider failed without details"),
    false
  );
  assert.equal(processor.hasProviderDetail("Your request took too long."), true);
  assert.equal(
    processor.runFailureMessageFromCandidates([
      { status: "failed", rank: 1, error: "Your request took too long." },
      { status: "completed", rank: 2, error: null },
      { status: "failed", rank: 3, error: "Restricted content." },
    ]),
    "2 image candidate job failed: Option 1: Your request took too long.; Option 3: Restricted content."
  );

  console.log("IMAGE STUDIO BEHAVIOR VERIFY: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
