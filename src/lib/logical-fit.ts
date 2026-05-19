import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getIntegration } from "./db";
import { log } from "./logger";

/**
 * Logical-fit validator. Topic and format come from DIFFERENT videos by
 * design — the topic supplies the SUBJECT, the format supplies the
 * STRUCTURE. The hazard is that a Sonnet compose call mashes them into a
 * title that fabricates a fact neither source supports (e.g. topic source
 * is Webb biosignatures, format source is Sagittarius A*, proposed title
 * "James Webb Found a Black Hole" — incoherent, would mislead viewers).
 *
 * A single Haiku 4.5 call inspects every (topicSourceTitle,
 * formatSourceTitle, proposedTitle, coherenceRationale) triple and
 * returns logically_coherent + reason per row. The chat agent surfaces
 * fails via app_logs diagnostic entries; the idea-generator drops or
 * format-swaps the slot.
 */

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export type LogicalFitInput = {
  ideaIndex: number;
  topicSourceTitle: string;
  formatSourceTitle: string;
  proposedTitle: string;
  coherenceRationale: string;
};

export type LogicalFitVerdict = {
  ideaIndex: number;
  logicallyCoherent: boolean;
  reason: string;
};

export type LogicalFitResult =
  | { ok: true; verdicts: LogicalFitVerdict[]; inputTokens: number; outputTokens: number }
  | { ok: false; error: string };

const SYSTEM_PROMPT = [
  "You are a logical-coherence judge for YouTube video title proposals.",
  "",
  "Each candidate is a remix: topic source supplies the SUBJECT, format source supplies the STRUCTURE (the verb shape, the phrasing template, the rhetorical move). The combination is COHERENT only when the proposed title describes a video that a viewer could plausibly watch — the subject from the topic source remains intact and the structure does not invent a fact that contradicts the topic source.",
  "",
  "Reject titles that FABRICATE a connection — combining the format's claim (e.g. \"Found a Black Hole\") with the topic's subject (e.g. \"James Webb\") when the topic source is about something different (e.g. biosignatures on K2-18b). The format provides STRUCTURE, the topic provides SUBJECT — they cannot create fabricated facts together.",
  "",
  "Example to reject:",
  "  topic_source: \"James Webb Spotted Biosignatures on K2-18b — Strongest Yet\"",
  "  format_source: \"Astronomers Just Found a Black Hole Bending Light at Sgr A*\"",
  "  proposed_title: \"James Webb Just Found a Black Hole Hiding in Plain Sight\"",
  "  Verdict: INCOHERENT — Webb's biosignature finding is not a black hole. The format provides STRUCTURE (\"X Just Found Y Hiding in Plain Sight\"), but applying it fabricates a finding Webb did not make.",
  "",
  "Example to accept:",
  "  topic_source: \"Voyager 2 Sent Back Data Engineers Can't Explain\"",
  "  format_source: \"NASA Just Detected Something Weird in Saturn's Rings\"",
  "  proposed_title: \"NASA Just Detected Something Weird in Voyager 2's Signal\"",
  "  Verdict: COHERENT — the topic (Voyager 2 anomaly) is preserved, the format (\"NASA Just Detected Something Weird in [X]\") cleanly maps onto it without inventing a fact.",
  "",
  "Return JSON ONLY. No prose, no markdown, no code fence. Shape:",
  "{",
  '  "verdicts": [',
  '    { "ideaIndex": number, "logicallyCoherent": boolean, "reason": string }',
  "  ]",
  "}",
  "",
  "reason is one short sentence (max 140 chars) — when rejecting, name the fabricated fact; when accepting, name why the structure transfers cleanly.",
].join("\n");

export async function checkLogicalFit(
  inputs: LogicalFitInput[]
): Promise<LogicalFitResult> {
  if (inputs.length === 0) {
    return { ok: true, verdicts: [], inputTokens: 0, outputTokens: 0 };
  }
  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return { ok: false, error: "Claude API key not configured." };
  }

  const userBody = [
    "# CANDIDATES",
    "",
    ...inputs.map((it) =>
      [
        `## ideaIndex=${it.ideaIndex}`,
        `topic_source: ${JSON.stringify(it.topicSourceTitle)}`,
        `format_source: ${JSON.stringify(it.formatSourceTitle)}`,
        `proposed_title: ${JSON.stringify(it.proposedTitle)}`,
        `coherence_rationale_from_composer: ${JSON.stringify(it.coherenceRationale)}`,
      ].join("\n")
    ),
    "",
    `Return the verdicts array with one entry per ideaIndex above (${inputs.length} total).`,
  ].join("\n");

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userBody }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const verdicts = parseVerdicts(text, inputs);
    if (!verdicts) {
      log.warn(
        "claude",
        `[diag] logical_fit parse failure — raw output prefix: ${text.slice(0, 240)}`
      );
      return { ok: false, error: "Validator returned malformed JSON." };
    }
    for (const v of verdicts) {
      const it = inputs.find((x) => x.ideaIndex === v.ideaIndex);
      log.info(
        "claude",
        `[diag] logical_fit idea=${v.ideaIndex} pass=${v.logicallyCoherent} reason=${JSON.stringify(v.reason)} title=${JSON.stringify(it?.proposedTitle ?? "")}`
      );
    }
    const usage = (resp as unknown as { usage?: { input_tokens?: number; output_tokens?: number } })
      .usage ?? {};
    return {
      ok: true,
      verdicts,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Validator call failed";
    log.error("claude", `[diag] logical_fit call failed: ${msg}`, err);
    return { ok: false, error: msg };
  }
}

function parseVerdicts(
  raw: string,
  inputs: LogicalFitInput[]
): LogicalFitVerdict[] | null {
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
  const arr = (parsed as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(arr)) return null;
  const knownIndices = new Set(inputs.map((i) => i.ideaIndex));
  const seen = new Set<number>();
  const out: LogicalFitVerdict[] = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const ideaIndex =
      typeof o.ideaIndex === "number" && Number.isFinite(o.ideaIndex)
        ? Math.floor(o.ideaIndex)
        : -1;
    if (ideaIndex < 0 || !knownIndices.has(ideaIndex) || seen.has(ideaIndex)) {
      continue;
    }
    const logicallyCoherent =
      o.logicallyCoherent === true || o.logicallyCoherent === false
        ? o.logicallyCoherent
        : null;
    if (logicallyCoherent === null) continue;
    const reason =
      typeof o.reason === "string" ? o.reason.trim().slice(0, 240) : "";
    seen.add(ideaIndex);
    out.push({ ideaIndex, logicallyCoherent, reason });
  }
  return out.length > 0 ? out : null;
}
