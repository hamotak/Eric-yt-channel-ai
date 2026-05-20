import "server-only";

/**
 * Claude API pricing as of April 2026. Update these constants when
 * Anthropic changes their rates (or when we switch models). Pricing is
 * per million tokens, in US dollars.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 *
 * We store costs in MILLI-cents (1/1000 of a cent) to avoid rounding
 * away sub-cent turns — at Sonnet input rates a 1K-token call costs
 * $0.003 = 0.3 cents = 300 millicents, which would round to 0 cents in
 * a naive integer-cents scheme.
 */

type ModelRates = {
  input: number; // $/M input tokens
  output: number; // $/M output tokens
  cacheWrite: number; // $/M cache-write input tokens (1.25x input for 5-min TTL)
  cacheRead: number; // $/M cache-read input tokens (0.1x input)
};

const RATES: Record<string, ModelRates> = {
  // Claude Sonnet 4.6 — executor model (our default for chat turns)
  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  // Claude Opus 4.7 — advisor model
  "claude-opus-4-7": {
    input: 5.0,
    output: 25.0,
    cacheWrite: 6.25,
    cacheRead: 0.5,
  },
  // Claude Haiku 4.6 — cheap tier, not used yet but good to have rates ready
  "claude-haiku-4-6": {
    input: 1.0,
    output: 5.0,
    cacheWrite: 1.25,
    cacheRead: 0.1,
  },
};

/** Fallback for unknown models — use Sonnet rates so we over-estimate
 * slightly rather than accidentally hide spend. */
const FALLBACK = RATES["claude-sonnet-4-6"];

/**
 * Cost in millicents (1/1000 of a cent) for a single model call.
 * Split inputs into "fresh", "cache-write", and "cache-read" buckets
 * because they bill at different rates.
 */
export function costMillicents(
  model: string,
  tokens: {
    inputFresh: number; // regular input tokens (not cached)
    inputCacheWrite: number; // tokens billed at cache-write rate
    inputCacheRead: number; // tokens billed at cache-read rate
    output: number;
  }
): number {
  const r = RATES[model] ?? FALLBACK;
  // $/M × tokens / 1_000_000 = $ → × 100 cents → × 1000 millicents = ×100_000
  const factor = 100_000;
  const fresh = (r.input * tokens.inputFresh) / 1_000_000;
  const write = (r.cacheWrite * tokens.inputCacheWrite) / 1_000_000;
  const read = (r.cacheRead * tokens.inputCacheRead) / 1_000_000;
  const output = (r.output * tokens.output) / 1_000_000;
  return Math.round((fresh + write + read + output) * factor);
}

export function formatUsdFromMillicents(mc: number): string {
  const usd = mc / 100_000;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
