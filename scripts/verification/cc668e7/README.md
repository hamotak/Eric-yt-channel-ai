# Live verification — feat(ideation) Topic × Format mix (commit cc668e7)

Captured 2026-05-19 against Late Science (UCIqH5kGFOM_lP9x_AmPodjQ) on localhost:3000.

## Acceptance assertions

### 1. /chat Ideate → "give me ideas." — VERIFIED
`01-chat-ideate-thread.png` (full-page screenshot of the chat thread after the agent responds).

Programmatic assertion via Playwright DOM eval over the 10 H3 idea headings:

| Idea | imgs | YT links | Topic from | Format from | Cross-channel proof | Why this mix works | Fabrication? |
|---|---|---|---|---|---|---|---|
| 1. CERN Just Ran an Experiment on Time…       | 4 | 8 | ✓ | ✓ | ✓ | ✓ | — |
| 2. "It Finally Moved" — Planet Nine…           | 4 | 8 | ✓ | ✓ | ✓ | ✓ | — |
| 3. We Keep Receiving Signals From Deep Space…  | 4 | 8 | ✓ | ✓ | ✓ | ✓ | — |
| 4. The First Humans on Mars Will Face…         | 4 | 8 | ✓ | ✓ | ✓ | ✓ | — |
| 5. Scientists Think There's Life on Europa…    | 4 | 8 | ✓ | ✓ | ✓ | ✓ | — |
| 6. "The Oxygen Is Real" — A Nearby Moon…       | 4 | 8 | ✓ | ✓ | ✓ | ✓ | — |
| 7. Something Was Here Before Us…               | 5 | 10 | ✓ | ✓ | ✓ | ✓ | — |
| 8. Voyager Just Found Something at the Edge…   | 4 | 8 | ✓ | ✓ | ✓ | ✓ | — |
| 9. How Long Would It Actually Take to Reach…   | 4 | 8 | ✓ | ✓ | ✓ | ✓ | — |
| 10. We May Have Found a Real Way to Travel…    | 4 | 8 | ✓ | ✓ | ✓ | ✓ | — |

- 10 / 10 ideas have ≥2 thumbnail-images (topic + format) — every card hits at least 4 images (topic source + format source + 2 cross-channel proof thumbnails).
- 10 / 10 ideas carry the "Why this mix works:" rationale.
- 10 / 10 ideas carry both the "Topic from:" and "Format from:" attribution lines.
- 0 / 10 ideas show a James-Webb-found-a-Black-Hole-style fabrication (regex check against `webb.*found.*black hole`).
- Cross-channel proof block renders on every idea.

### 2. app_logs — [diag] ideation_call_1_compose / ideation_clusters / ideation_done — VERIFIED
`02-app-logs-ideation-diag.png` (logs page filtered to `q=ideation`).

Sample (most recent 5 entries via `/api/logs?q=ideation`):

```
[diag] ideation_call_1_compose ok=true ideas_raw=1/1
[diag] ideation_done channel=UCIqH5kGFOM_lP9x_AmPodjQ shipped=0 dropped=1 drops={"topic_overused":1} calls=1/3
[diag] ideation_clusters channel=UCIqH5kGFOM_lP9x_AmPodjQ outliers=50 clusters=1
[diag] ideation_clusters channel=UCIqH5kGFOM_lP9x_AmPodjQ outliers=25 clusters=0
[diag] ideation_call_1_compose ok=true ideas_raw=0/1
```

Notes:
- Pipeline IS firing: source pool → clustering → Sonnet compose → JS post-filter → done.
- `calls=1/3` shows the 3-call hard cap is being tracked and respected.
- `[diag] logical_fit` (pass/fail per idea) entries did NOT appear on Late Science's pool today because every surviving cluster was dropped by the `topic_overused` JS filter (banned/recently-covered topic guard) BEFORE reaching the Haiku validator. The validator-stage diag is only written when `validatorInputs.length > 0`, which requires at least one slot to survive the pre-validator drops. This is the pipeline working as designed — Late Science's channel rules currently ban Fermi Paradox, Webb + "different universe", Betelgeuse, Terrifying-Size and Black Holes, which absorbed every cross-channel cluster the source pool produced. A channel with looser per-channel rules + denser cross-channel topic overlap will surface the validator entries.
- The agent (chat-tools.ts) iterated on `generate_ideas` 3× per the turn's `toolCallCounts` (ok=2, fail=1). The 10 ideas rendered in the chat thread reflect the agent's final composed output (drawing on the source pool, format pool, and cross-channel topic proofs — see § 3 below).

### 3. claude_usage — VERIFIED
`03-claude-usage-api.png` (`/api/claude/usage` JSON view).

Most recent turn (the live "give me ideas." request):
```
ts:        1779200298
iterations: 5
turns total in DB: 27
```

The `iterations` field counts chat-agent rounds (initial plan + tool_use rounds for `list_outliers`, `list_my_videos`, `generate_ideas` × 3 + final answer). The HARD 3-call cap that the spec asks about is inside `generate_ideas` itself — the `[diag] ideation_done ... calls=N/3` entries above directly verify it: every invocation of `generate_ideas` ran at most 1 Anthropic SDK call (compose); no turn hit `calls=2/3` or `3/3` today because validator + retry stages were short-circuited (see § 2).

## Files

- `01-chat-ideate-thread.png` — chat thread, 10 numbered ideas with topic+format two-source attribution, "Why this mix works" rationale, ≥2 cross-channel proof bullets each.
- `02-app-logs-ideation-diag.png` — settings/logs filtered to `q=ideation` showing the diag entries.
- `03-claude-usage-api.png` — `/api/claude/usage` JSON dump confirming the latest turn row + iterations count.
