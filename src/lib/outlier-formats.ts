import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  getExampleVideosForFormat,
  getFormatWeeklyHistogram,
  getIntegration,
  listFormatsForChannel,
  rebuildFormatVideoLinks,
  upsertOutlierFormat,
  wipeFormatsForChannel,
  type OutlierFormat,
} from "./db";
import { providerModelId } from "./ai-provider-types";
import { extractSection, loadMentorMethod } from "./mentor-method";
import { listOutliersForActiveChannel } from "./outliers";
import { log } from "./logger";

export type ExtractResult =
  | {
      ok: true;
      formatsCreated: number;
      videosLinked: number;
      lastExtractedAt: number;
      // T1 (soften pass): even on success we surface the survivor count so
      // the UI can warn the user when the pool was thin ("only 2 formats
      // passed validation — try syncing more competitors"). When the count
      // is healthy (≥3) the page treats this as a normal success.
      formatsPassed: number;
    }
  | { ok: false; status: number; error: string; retryAfterSec?: number };

/**
 * Extract title-format templates from the user channel's current top
 * outliers via Claude Sonnet 4.6, per MENTOR_METHOD §4 (formats are
 * structural patterns, not literal titles).
 *
 * Flow:
 *   1. Load up to 50 current outliers (the same set the Library tab
 *      shows) via listOutliersForActiveChannel.
 *   2. Send their titles to Claude in one batch with §4 + placeholder
 *      vocab + the 8–20 format target.
 *   3. For each format Claude returns: drop singletons, drop unknown
 *      video ids; compute metrics; upsert into outlier_formats + rebuild
 *      its link table with multiplier snapshots.
 *
 * No rate limit — re-extract is a user-triggered, cost-aware action.
 * If perf or cost becomes an issue we'll add real queueing.
 * Never throws — every error mode returns a structured `ok: false`.
 */
export async function extractFormatsFromOutliers(
  userChannelId: string
): Promise<ExtractResult> {
  const channelId = userChannelId?.trim();
  if (!channelId) {
    return { ok: false, status: 400, error: "userChannelId required" };
  }

  const now = Math.floor(Date.now() / 1000);
  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      error: "Claude API key not configured. Add it on the Integrations page.",
    };
  }

  const { outliers } = listOutliersForActiveChannel({
    userChannelId: channelId,
    limit: 50,
  });
  if (outliers.length < 4) {
    return {
      ok: false,
      status: 400,
      error: `Not enough outliers to extract patterns (need ≥4, have ${outliers.length}). Sync more competitors or widen the window.`,
    };
  }

  const md = loadMentorMethod();
  const sec4 = extractSection(md, 4);
  const systemPrompt = [
    "You extract REPEATABLE STRUCTURAL TITLE FORMATS from competitor outliers across MULTIPLE channels. A format is a content-agnostic template (placeholders, not concrete topics) that several distinct creators have used to break out of their normal performance. We're looking for STRUCTURAL repetition across creators — not topic repetition, not single-channel signature styles.",
    "",
    "From MENTOR_METHOD.md §4 (Title formats — structural patterns, not literal titles):",
    sec4 || "(section unavailable)",
    "",
    "# What counts as a TRENDING FORMAT (ALL must hold)",
    "A format qualifies ONLY if EVERY one of these is true after you assemble it:",
    "  i.   It has at least 3 example titles drawn from the outlier batch below.",
    "  ii.  Those examples come from at least 2 DIFFERENT competitor channels (no single-channel signatures). Each batch line tags the competitor — verify across the `ch=` field.",
    "  iii. Every example is ≥3× its own channel's median (use the multiplier shown in each batch line; lines below 3× are noise for this purpose).",
    "  iv.  The template has at least 2 placeholder slot variables in square brackets. A no-slot template is a copied title, not a format.",
    "  v.   The average multiplier across the 3+ examples is ≥5×. Anything lower is noise.",
    "  vi.  Across any pair of examples, ≤50% of the content words overlap. If two examples share most content words, they are the same TOPIC, not the same FORMAT.",
    "  vii. Aim for AT MOST 8 formats total. Quality over quantity — if only 4 qualify, return 4. Do NOT pad with weak candidates.",
    "",
    "The server re-checks every criterion above and drops any format that fails. Drops surface in the extraction log so HAmo can see which criterion fired. Don't try to game them: thin signal beats fabricated patterns.",
    "",
    "# Placeholder vocabulary (use SQUARE BRACKETS for every variable)",
    "Simple, descriptive placeholder names. Prefer this vocabulary when applicable:",
    "[Place], [Person], [Topic], [Thing], [Adjective], [Number], [Duration], [Action], [Verb-ed], [Age], [Era], [Authority figure], [Consequence], [Quantity], [Subject].",
    "If a placeholder doesn't fit any of those, invent a new one — ≤2 words, capitalised.",
    "",
    "# Output",
    "Return ONLY a JSON object. No prose, no markdown, no code fence.",
    "{",
    '  "formats": [',
    "    {",
    '      "template": string,        // e.g. "I went to [Place]\'s most [Adjective] [Thing]"',
    '      "videoIds": string[]       // 3+ ids from THIS BATCH, drawn from ≥2 different competitors',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  // Each line ships videoId, multiplier (so the model can satisfy the ≥3×
  // per-example criterion), and the competitor's title (so it can satisfy
  // the ≥2 distinct channels criterion without guessing). Server-side
  // validation re-checks both, but giving the model the data costs nothing.
  const userBody = [
    "# Outlier batch (each line: id, multiplier, competitor, title)",
    ...outliers.map(
      (o) =>
        `- [${o.videoId}] ${o.multiplier.toFixed(1)}× ch="${o.competitorTitle ?? o.competitorHandle ?? "?"}" — ${o.title}`
    ),
  ].join("\n");

  const model = providerModelId("claude");
  // Extended-thinking budget for format extraction. Format clustering
  // benefits from reasoning (cross-channel grouping, slot identification,
  // content-noun-overlap heuristics). Override via env if needed.
  const FORMATS_THINKING_BUDGET = (() => {
    const raw = Number(process.env.ANTHROPIC_THINKING_BUDGET_FORMATS);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6000;
  })();
  let raw: string;
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      // 10k = ~6k thinking + ~4k for the JSON output. Thinking requires
      // temperature=1 (the default); we previously ran at 0.2 for tighter
      // outputs but trade that off for the reasoning quality thinking
      // delivers on cross-channel clustering + slot identification.
      max_tokens: 10000,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
      thinking: {
        type: "enabled",
        budget_tokens: FORMATS_THINKING_BUDGET,
      },
    });
    raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Claude call failed";
    log.error("claude", `Format-extract ${channelId}: ${msg}`, err);
    return { ok: false, status: 502, error: msg };
  }

  // Parse + validate.
  const rawParsed = parseFormats(raw);
  if (!rawParsed || rawParsed.length === 0) {
    log.warn(
      "claude",
      `Format-extract ${channelId}: could not parse formats. Raw: ${raw.slice(0, 200)}`
    );
    return {
      ok: false,
      status: 502,
      error: "AI returned malformed JSON. Try again.",
    };
  }

  const knownIds = new Set(outliers.map((o) => o.videoId));
  const titleByVideo = new Map(outliers.map((o) => [o.videoId, o.title]));
  const multByVideo = new Map(outliers.map((o) => [o.videoId, o.multiplier]));
  const competitorByVideo = new Map(
    outliers.map((o) => [o.videoId, o.competitorId])
  );
  const viewsByVideo = new Map(outliers.map((o) => [o.videoId, o.views]));
  const publishedByVideo = new Map(
    outliers.map((o) => [o.videoId, o.publishedAt ?? 0])
  );

  // Post-LLM validation cascade. F1-F4 (slot count, anchor fit, marker
  // order, cross-format dedup) carry over from prior PRs. T1/T3 add the
  // trending-format rigour layer on top:
  //   T1-iii — per-example multiplier ≥3× (drops examples below 3×; if
  //            <3 survive, drop the format)
  //   T1-v   — avg multiplier ≥5× across surviving examples
  //   T1-vi  — pairwise content-word overlap ≤50%
  //   T3     — cross-channel: surviving examples must span ≥2 competitor ids
  //   T1-vii — cap at 8 formats total, sorted by avg multiplier DESC
  // Per-criterion drop counts logged so HAmo can see which gate fired.
  const parsed = validateAndDedupFormats(
    rawParsed,
    titleByVideo,
    knownIds,
    multByVideo,
    competitorByVideo
  );
  if (parsed.length === 0) {
    log.warn(
      "claude",
      `Format-extract ${channelId}: 0 templates survived dedup/validation. Raw: ${raw.slice(0, 200)}`
    );
    // Soften-pass copy: tell the user exactly what happened (zero passed)
    // and what to try (more competitors, broader sync window). The
    // per-criterion drop counts are in the dev log line above for HAmo to
    // audit if the data feels right but the result feels wrong.
    return {
      ok: false,
      status: 502,
      error:
        "Only 0 formats passed validation. Try syncing more competitors or widening the outlier window.",
    };
  }

  // Re-extract is meant to be a clean slate: wipe the channel's prior
  // formats + their video links so stale entries from older runs (which
  // the new dedup pass would have removed) don't linger. Cascade through
  // outlier_format_videos via FK.
  const wipe = wipeFormatsForChannel(channelId);
  if (wipe.formatsDeleted > 0) {
    log.info(
      "claude",
      `Format-extract ${channelId}: wiped ${wipe.formatsDeleted} stale formats + ${wipe.linksDeleted} links before re-extract`
    );
  }

  let formatsCreated = 0;
  let videosLinked = 0;
  const nowMs = Date.now();
  const thirtyDaysAgo = Math.floor(nowMs / 1000) - 30 * 86400;
  const sevenDaysAgo = Math.floor(nowMs / 1000) - 7 * 86400;
  const fourteenDaysAgo = Math.floor(nowMs / 1000) - 14 * 86400;

  for (const f of parsed) {
    const validIds = f.videoIds.filter((id) => knownIds.has(id));
    // Defense-in-depth: validateAndDedupFormats already enforces the
    // minimum (currently MIN_EXAMPLES_PER_FORMAT — softened to 2 in the
    // soften pass). Skip anything below the floor in case a future
    // refactor regresses the upstream filter.
    if (validIds.length < MIN_EXAMPLES_PER_FORMAT) continue;

    const multipliers = validIds.map((id) => multByVideo.get(id) ?? 0);
    const avgMult =
      multipliers.length > 0
        ? Number(
            (
              multipliers.reduce((s, m) => s + m, 0) / multipliers.length
            ).toFixed(2)
          )
        : null;

    // total_views_month: SUM(views) for videos published in last 30d
    let totalViewsMonth = 0;
    for (const id of validIds) {
      const pub = publishedByVideo.get(id) ?? 0;
      if (pub >= thirtyDaysAgo) totalViewsMonth += viewsByVideo.get(id) ?? 0;
    }

    // rising_rate: recent / prev, capped at 30, 0/0 → 1, 0/x → 30
    let recent = 0;
    let prev = 0;
    for (const id of validIds) {
      const pub = publishedByVideo.get(id) ?? 0;
      if (pub >= sevenDaysAgo) recent++;
      else if (pub >= fourteenDaysAgo) prev++;
    }
    let risingRate: number;
    if (prev === 0 && recent === 0) risingRate = 1.0;
    else if (prev === 0) risingRate = 30.0;
    else risingRate = Math.min(30.0, recent / prev);

    const formatId = upsertOutlierFormat({
      userChannelId: channelId,
      template: f.template,
      avgMultiplier: avgMult,
      totalViewsMonth,
      risingRate: Number(risingRate.toFixed(2)),
      model,
    });
    if (formatId < 0) continue;

    rebuildFormatVideoLinks(
      formatId,
      validIds.map((id) => ({
        videoId: id,
        multiplierAtExtract: multByVideo.get(id) ?? 0,
      }))
    );
    formatsCreated++;
    videosLinked += validIds.length;
  }

  log.info(
    "claude",
    `Format-extract ${channelId}: ${formatsCreated} formats, ${videosLinked} video links, from ${outliers.length} outliers`
  );

  return {
    ok: true,
    formatsCreated,
    videosLinked,
    lastExtractedAt: now,
    // Mirrors parsed.length — the count of templates that survived every
    // validation gate (slot count, anchor fit, marker order, dedup,
    // per-example mult, ≥N examples, avg mult, cross-channel, lexical
    // overlap, cap). The UI surfaces a "thin pool" warning when this is
    // 1 or 2, even though the upsert loop happily wrote them.
    formatsPassed: parsed.length,
  };
}

/**
 * Read-facade for the Patterns tab + the list_format_patterns chat
 * tool. Hydrates each format with up to 5 example videos AND its
 * weekly chart histogram (videos count + avg multiplier per week, last
 * 10 weeks). Returns "" for charts when data is too sparse — the UI
 * renders a "not enough data" fallback below 4 buckets.
 */
export type FormatWithExamples = OutlierFormat & {
  examples: ReturnType<typeof getExampleVideosForFormat>;
  weekly: { weekIndex: number; n: number; avgMult: number }[];
};

export function getFormatsForChannel(
  userChannelId: string,
  limit = 50
): FormatWithExamples[] {
  const formats = listFormatsForChannel(userChannelId, limit);
  return formats.map((f) => ({
    ...f,
    examples: getExampleVideosForFormat(f.id, 5),
    weekly: getFormatWeeklyHistogram(f.id),
  }));
}

/**
 * Post-LLM validation + dedup for extracted formats. Jobs (in order):
 *
 *   DEF-F3 — drop any template with fewer than 2 [X] slot markers. The
 *            "James Webb Just Found What Scientists Were Afraid Of" kind
 *            of literal-string non-template gets caught here.
 *
 *   DEF-F2 — literal-anchor enforcement. Words outside [X] brackets that
 *            are ≥4 chars (e.g. "James", "Webb", "Detected") must appear
 *            as whole words in the example title. A "James Webb [Verb-ed]"
 *            template cannot accept a CERN example.
 *
 *   DEF-F4 — structural-marker order. Short connector words inside the
 *            template (Is, And, Has, About, From, etc.) must appear in
 *            the example in the same order. Cheap order-preserving cursor.
 *            ≥60% of markers must match.
 *
 *   DEF-F1 — cross-format dedup. After per-example fit pruning, each
 *            videoId belongs to AT MOST ONE template — the one with the
 *            highest fit score. Ties broken by LLM-output order.
 *
 *   T1-iii — per-example multiplier ≥3×. Examples below 3× drop. The
 *            multiplier already encodes "views / channel median" per
 *            the SQL in outliersForUserChannel.
 *
 *   T1-ii  — ≥3 surviving examples after T1-iii ("proven" threshold).
 *
 *   T1-v   — avg multiplier ≥5× across surviving examples.
 *
 *   T3     — cross-channel: surviving examples must span ≥2 distinct
 *            competitor_ids. Single-channel signature styles drop.
 *
 *   T1-vi  — pairwise content-word overlap ≤50%. For every pair of
 *            surviving examples, the Jaccard similarity over their
 *            content tokens (≥4 chars, stopwords stripped) must be ≤0.5.
 *            If ANY pair exceeds, the format is topic-bound, not
 *            format-bound, and drops.
 *
 *   T1-vii — final cap at 8 formats, sorted by avg multiplier DESC.
 *
 * Per-criterion drop counts logged so HAmo can see which gate fired.
 */
const MAX_TRENDING_FORMATS = 8;
// Soften pass (T1 of follow-up PR): the prior cc7ef77 gates (≥3× per
// example, ≥5× avg, ≤50% lexical overlap, ≥3 examples) were rejecting
// nearly every candidate on HAmo's current 4-competitor pool. New
// thresholds are still defensible — ≥2× per example matches the
// MENTOR_METHOD §2 outlier floor, ≥3× avg keeps the "this is a trend,
// not a one-off" guarantee, ≤60% overlap leaves room for two examples
// that happen to share a few common nouns without being the same topic.
const PER_EXAMPLE_MIN_MULTIPLIER = 2;
const MIN_EXAMPLES_PER_FORMAT = 2;
const AVG_MULTIPLIER_MIN = 3;
const MIN_DISTINCT_COMPETITORS = 2;
const MAX_CONTENT_OVERLAP = 0.6;

const VALIDATE_STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","in","on","for","to","with",
  "is","are","was","were","be","been","this","that","these","those","i",
  "you","he","she","it","we","they","my","your","his","her","its","our",
  "their","do","does","did","done","have","has","had","not","no","yes",
  "at","by","from","as","than","then","so","very","what","when","where",
  "why","how","who","which","there","here","just","like","get","got",
  "make","made","will","would","can","could","should","shall","may",
  "might","one","two","three","new","video","videos","about","into",
  "over","out","off","up","down",
]);

function contentTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const raw of title
    .toLowerCase()
    .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
    .split(/\s+/)) {
    if (!raw || raw.length < 4) continue;
    if (VALIDATE_STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function validateAndDedupFormats(
  parsed: Array<{ template: string; videoIds: string[] }>,
  titleByVideo: Map<string, string>,
  knownIds: Set<string>,
  multByVideo: Map<string, number>,
  competitorByVideo: Map<string, number>
): Array<{ template: string; videoIds: string[] }> {
  const slotCount = (template: string): number =>
    (template.match(/\[[^\]]+\]/g) || []).length;

  // Literal anchors: words OUTSIDE [X] brackets, length ≥4, lowercased.
  // Strip the bracket placeholders entirely before tokenizing.
  const literalAnchors = (template: string): string[] => {
    const withoutSlots = template.replace(/\[[^\]]+\]/g, " ");
    return withoutSlots
      .toLowerCase()
      .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4);
  };

  // Structural markers: short connector words OUTSIDE [X] brackets that
  // anchor sentence structure. Tracked for order, not just presence.
  const STRUCTURAL = new Set([
    "is", "are", "was", "were", "be", "been", "and", "or", "but",
    "of", "in", "on", "for", "to", "with", "as", "than", "then",
    "has", "have", "had", "does", "did", "do", "about", "from",
    "into", "over", "under", "after", "before", "by",
  ]);
  const structuralMarkers = (template: string): string[] => {
    const withoutSlots = template.replace(/\[[^\]]+\]/g, " ");
    return withoutSlots
      .toLowerCase()
      .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
      .split(/\s+/)
      .filter((w) => STRUCTURAL.has(w));
  };

  // Whole-word lookup on a title (lowercased).
  const titleHasWord = (titleLower: string, word: string): boolean => {
    // Escape regex metachars in word (defensive — shouldn't happen here).
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(titleLower);
  };

  // Order-preserving cursor: do the markers appear in the title in the
  // same order they appear in the template? Returns (matched, total).
  const markerOrderFit = (
    markers: string[],
    titleLower: string
  ): { matched: number; total: number } => {
    if (markers.length === 0) return { matched: 0, total: 0 };
    let cursor = 0;
    let matched = 0;
    for (const m of markers) {
      const re = new RegExp(`\\b${m}\\b`);
      const slice = titleLower.slice(cursor);
      const found = slice.search(re);
      if (found >= 0) {
        matched++;
        cursor += found + m.length;
      }
    }
    return { matched, total: markers.length };
  };

  // Fit score per (template, example). Higher = better fit. Used both
  // as the gate (literal anchors must ALL match) and as the dedup
  // tiebreaker (anchor-count + marker-fraction).
  type Fit = {
    pass: boolean;
    anchorHits: number;
    anchorTotal: number;
    markerFraction: number;
    score: number;
  };
  const fitFor = (template: string, title: string): Fit => {
    const titleLower = title.toLowerCase();
    const anchors = literalAnchors(template);
    let anchorHits = 0;
    for (const a of anchors) {
      if (titleHasWord(titleLower, a)) anchorHits++;
    }
    const allAnchorsMatch = anchors.length === 0 || anchorHits === anchors.length;
    const markers = structuralMarkers(template);
    const { matched, total } = markerOrderFit(markers, titleLower);
    const markerFraction = total === 0 ? 1 : matched / total;
    const pass = allAnchorsMatch && markerFraction >= 0.6;
    // Score for dedup tiebreaker: weight anchors more than markers.
    const score = anchorHits * 2 + markerFraction;
    return { pass, anchorHits, anchorTotal: anchors.length, markerFraction, score };
  };

  // --- DEF-F3 pass: drop zero-slot templates.
  const slotPassed = parsed.filter((f) => slotCount(f.template) >= 2);
  const droppedF3 = parsed.length - slotPassed.length;

  // --- DEF-F2 + DEF-F4 pass: per-example grammar fit. Build a parallel
  //     array of {template, examples:[{videoId, fit}]} so we can dedup
  //     by fit score in the next pass.
  type ExWithFit = { videoId: string; fit: Fit };
  type FmtWithFits = {
    template: string;
    llmIndex: number; // position in original LLM output (tiebreaker)
    examples: ExWithFit[];
  };
  const fitsByFormat: FmtWithFits[] = slotPassed.map((f, i) => {
    const examples: ExWithFit[] = [];
    for (const vid of f.videoIds) {
      if (!knownIds.has(vid)) continue;
      const title = titleByVideo.get(vid);
      if (!title) continue;
      const fit = fitFor(f.template, title);
      if (!fit.pass) continue;
      examples.push({ videoId: vid, fit });
    }
    return { template: f.template, llmIndex: i, examples };
  });

  // --- DEF-F1 pass: cross-format dedup. For each videoId, pick the
  //     format-index with the highest fit score; remove from others.
  const bestByVideo = new Map<string, { fmtIdx: number; score: number; llmIdx: number }>();
  for (let i = 0; i < fitsByFormat.length; i++) {
    for (const ex of fitsByFormat[i].examples) {
      const prev = bestByVideo.get(ex.videoId);
      const cand = {
        fmtIdx: i,
        score: ex.fit.score,
        llmIdx: fitsByFormat[i].llmIndex,
      };
      const winner =
        !prev ||
        cand.score > prev.score ||
        (cand.score === prev.score && cand.llmIdx < prev.llmIdx)
          ? cand
          : prev;
      bestByVideo.set(ex.videoId, winner);
    }
  }
  for (let i = 0; i < fitsByFormat.length; i++) {
    fitsByFormat[i].examples = fitsByFormat[i].examples.filter(
      (ex) => bestByVideo.get(ex.videoId)?.fmtIdx === i
    );
  }

  // --- T1-iii: drop per-example multipliers <3×. The model can be lazy
  //     and assign a 2.4× example to a format claiming ≥3× rigor; we
  //     trim those examples here.
  let droppedByPerExampleMult = 0;
  for (const f of fitsByFormat) {
    const before = f.examples.length;
    f.examples = f.examples.filter((e) => {
      const m = multByVideo.get(e.videoId) ?? 0;
      return m >= PER_EXAMPLE_MIN_MULTIPLIER;
    });
    droppedByPerExampleMult += before - f.examples.length;
  }

  // --- min-examples gate. Soften pass dropped this from ≥3 to ≥2 so a
  //     format with two cross-channel examples still ships (cross-channel
  //     gate below carries the "is this a trend?" burden — the example
  //     count just guards against literal-copy templates).
  const afterMinSize = fitsByFormat.filter(
    (f) => f.examples.length >= MIN_EXAMPLES_PER_FORMAT
  );
  const droppedTooFew = fitsByFormat.length - afterMinSize.length;

  // --- T1-v: avg multiplier ≥5× across surviving examples.
  const withAvg = afterMinSize.map((f) => {
    const mults = f.examples.map((e) => multByVideo.get(e.videoId) ?? 0);
    const avg =
      mults.length > 0
        ? mults.reduce((s, m) => s + m, 0) / mults.length
        : 0;
    return { ...f, avgMultiplier: avg };
  });
  const afterAvg = withAvg.filter((f) => f.avgMultiplier >= AVG_MULTIPLIER_MIN);
  const droppedByAvg = withAvg.length - afterAvg.length;

  // --- T3: ≥2 distinct competitor_ids across surviving examples.
  const afterCrossChannel = afterAvg.filter((f) => {
    const ids = new Set<number>();
    for (const e of f.examples) {
      const cid = competitorByVideo.get(e.videoId);
      if (cid !== undefined) ids.add(cid);
    }
    return ids.size >= MIN_DISTINCT_COMPETITORS;
  });
  const droppedSingleChannel = afterAvg.length - afterCrossChannel.length;

  // --- T1-vi: pairwise content-word overlap ≤50%. If ANY pair of
  //     examples in the format exceeds 50% content Jaccard, the format
  //     is topic-bound (same subject in different titles), not format-
  //     bound (same structure across different subjects). Drop it.
  const afterContentOverlap = afterCrossChannel.filter((f) => {
    const tokenSets = f.examples.map((e) =>
      contentTokens(titleByVideo.get(e.videoId) ?? "")
    );
    for (let i = 0; i < tokenSets.length; i++) {
      for (let j = i + 1; j < tokenSets.length; j++) {
        if (jaccard(tokenSets[i], tokenSets[j]) > MAX_CONTENT_OVERLAP) {
          return false;
        }
      }
    }
    return true;
  });
  const droppedByOverlap = afterCrossChannel.length - afterContentOverlap.length;

  // --- T1-vii: cap at 8 formats, sorted by avg multiplier DESC.
  const sorted = [...afterContentOverlap].sort(
    (a, b) => b.avgMultiplier - a.avgMultiplier
  );
  const final = sorted.slice(0, MAX_TRENDING_FORMATS);
  const droppedByCap = sorted.length - final.length;

  log.info(
    "claude",
    `Format-validate: raw=${parsed.length} → slot=${slotPassed.length} (F3 drop ${droppedF3}) → minSize=${afterMinSize.length} (per-example<${PER_EXAMPLE_MIN_MULTIPLIER}× drop ${droppedByPerExampleMult}, <${MIN_EXAMPLES_PER_FORMAT} examples drop ${droppedTooFew}) → avg≥${AVG_MULTIPLIER_MIN}×=${afterAvg.length} (drop ${droppedByAvg}) → cross-channel=${afterCrossChannel.length} (drop ${droppedSingleChannel}) → overlap≤${MAX_CONTENT_OVERLAP * 100}%=${afterContentOverlap.length} (drop ${droppedByOverlap}) → cap${MAX_TRENDING_FORMATS}=${final.length} (drop ${droppedByCap}).`
  );

  return final.map((f) => ({
    template: f.template,
    videoIds: f.examples.map((e) => e.videoId),
  }));
}

function parseFormats(
  raw: string
): Array<{ template: string; videoIds: string[] }> | null {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rawFormats = (parsed as { formats?: unknown }).formats;
  if (!Array.isArray(rawFormats)) return null;
  const out: Array<{ template: string; videoIds: string[] }> = [];
  for (const f of rawFormats) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const template = typeof r.template === "string" ? r.template.trim() : "";
    const videoIds = Array.isArray(r.videoIds)
      ? r.videoIds.filter((v): v is string => typeof v === "string")
      : [];
    if (template && videoIds.length >= 2) {
      out.push({ template, videoIds });
    }
  }
  return out;
}
