import "server-only";

// Same stopword set used by validate-idea — keeps token-overlap math
// consistent across the two ideation guard-rails.
const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","in","on","for","to","with",
  "is","are","was","were","be","been","this","that","these","those","i",
  "you","he","she","it","we","they","my","your","his","her","its","our",
  "their","do","does","did","done","have","has","had","not","no","yes",
  "at","by","from","as","than","then","so","very","what","when","where",
  "why","how","who","which","there","here","just","like","get","got",
  "make","made","will","would","can","could","should","shall","may",
  "might","one","two","three","new","video","videos","about","into",
  "over","out","off","up","down","why","what's","whats","thats","that's",
]);

// Token-set tokenizer (4+ chars, stopwords dropped, deduped) — drives the
// overlap percentage and shared-noun count.
function tokenizeSet(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of s
    .toLowerCase()
    .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
    .split(/\s+/)) {
    if (!raw) continue;
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

// Flat tokenizer (preserves order + duplicates + short words + stopwords) —
// drives the consecutive-word run detector. Adjacency matters here, so we
// can't strip stopwords; we just normalise case + punctuation.
function tokenizeFlat(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Longest contiguous run of matching tokens between `proposed` and
 * `source` (both already lowercased + punctuation-stripped). Sliding-
 * window over proposed; for each starting position k, walks forward until
 * the sequence stops appearing as a contiguous slice of source. Returns
 * the max length seen.
 *
 * Tuned for catching "CERN Just Detected Two Timelines" → 5-word echo
 * in proposals. Stopwords kept because adjacency is the signal.
 */
function longestSharedRun(proposed: string[], source: string[]): number {
  if (proposed.length === 0 || source.length === 0) return 0;
  // Build a Set of n-gram strings from source for O(1) lookup, sized to
  // the proposed length (we'll never compare runs longer than proposed).
  const maxN = Math.min(proposed.length, source.length);
  let best = 0;
  for (let n = maxN; n > best; n--) {
    const sourceNgrams = new Set<string>();
    for (let i = 0; i + n <= source.length; i++) {
      sourceNgrams.add(source.slice(i, i + n).join(" "));
    }
    for (let j = 0; j + n <= proposed.length; j++) {
      const cand = proposed.slice(j, j + n).join(" ");
      if (sourceNgrams.has(cand)) {
        best = n;
        break;
      }
    }
    // Early exit: if a length-n match is found, no point checking smaller.
    if (best === n) break;
  }
  return best;
}

// Composite verdict — see scoreOriginality for the gates.
export type OriginalityVerdict = {
  maxOverlap: number;
  // Back-compat: 1 - maxOverlap. Older callers read this directly.
  originalityScore: number;
  worstSourceIndex: number;
  sharedNouns: number;
  longestSharedRun: number;
  flagged: boolean;
  reason: string | null;
};

// Three independent gates. Any failure flags the proposal for regenerate.
// Tuned against observed echo failures (verbatim source titles slipping
// through at 0.6 overlap because we measured fraction-of-proposed rather
// than absolute overlap).
const MAX_OVERLAP_RATIO = 0.45;
const MAX_SHARED_NOUNS = 2;       // strict > comparison; 3+ shared content words flags
const MAX_SHARED_RUN = 3;         // strict > comparison; 4+ consecutive words flags

/**
 * Score a proposed title against one or more source titles and decide
 * whether it's original enough to ship. Three gates:
 *
 *   (1) token-overlap ratio        > 0.45  → flag
 *   (2) shared content nouns       > 2     → flag
 *   (3) longest consecutive run    ≥ 4     → flag
 *
 * `flagged: true` means the proposal echoes the source too closely and
 * must be regenerated. `reason` names which gate triggered (first one
 * wins for legibility). worstSourceIndex points at the most overlap-y
 * source for the retry prompt to quote back.
 */
export function scoreOriginality(
  proposed: string,
  sources: string[]
): OriginalityVerdict {
  const proposedTokens = tokenizeSet(proposed);
  if (proposedTokens.length === 0 || sources.length === 0) {
    return {
      maxOverlap: 0,
      originalityScore: 1,
      worstSourceIndex: -1,
      sharedNouns: 0,
      longestSharedRun: 0,
      flagged: false,
      reason: null,
    };
  }
  const proposedSet = new Set(proposedTokens);
  const proposedFlat = tokenizeFlat(proposed);

  let maxOverlap = 0;
  let worstIdx = -1;
  let worstShared = 0;
  let worstRun = 0;
  for (let i = 0; i < sources.length; i++) {
    const sourceTokens = tokenizeSet(sources[i]);
    if (sourceTokens.length === 0) continue;
    let shared = 0;
    for (const t of sourceTokens) {
      if (proposedSet.has(t)) shared++;
    }
    const overlap = shared / Math.max(1, proposedTokens.length);
    const run = longestSharedRun(proposedFlat, tokenizeFlat(sources[i]));
    // Worst source = whichever triggers the strongest gate. Prefer the
    // source that would flag if any gate would; otherwise the highest
    // overlap. This keeps the retry prompt focused on the right echo.
    const candidateFlag =
      overlap > MAX_OVERLAP_RATIO ||
      shared > MAX_SHARED_NOUNS ||
      run > MAX_SHARED_RUN;
    const incumbentFlag =
      maxOverlap > MAX_OVERLAP_RATIO ||
      worstShared > MAX_SHARED_NOUNS ||
      worstRun > MAX_SHARED_RUN;
    const replace =
      worstIdx === -1 ||
      (candidateFlag && !incumbentFlag) ||
      (candidateFlag === incumbentFlag && overlap > maxOverlap);
    if (replace) {
      maxOverlap = overlap;
      worstIdx = i;
      worstShared = shared;
      worstRun = run;
    }
  }

  let reason: string | null = null;
  if (worstRun > MAX_SHARED_RUN) reason = "shared-run";
  else if (worstShared > MAX_SHARED_NOUNS) reason = "shared-nouns";
  else if (maxOverlap > MAX_OVERLAP_RATIO) reason = "overlap";

  return {
    maxOverlap,
    originalityScore: Math.max(0, 1 - maxOverlap),
    worstSourceIndex: worstIdx,
    sharedNouns: worstShared,
    longestSharedRun: worstRun,
    flagged: reason !== null,
    reason,
  };
}
