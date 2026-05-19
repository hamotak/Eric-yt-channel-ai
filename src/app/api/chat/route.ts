import type Anthropic from "@anthropic-ai/sdk";
import {
  addMessage,
  clearSessionPending,
  getIntegration,
  getMessages,
  getSession,
  markSessionPending,
  recordClaudeUsage,
  renameSession,
} from "@/lib/db";
import {
  buildSystemPrompt,
  getToolsFor,
  runTool,
  type ChatMode,
  type ToolGroup,
} from "@/lib/chat-tools";
import { resolveAttachmentsForClaude, type AttachmentInput } from "@/lib/attachments";
import { costMillicents } from "@/lib/claude-pricing";
import { log } from "@/lib/logger";
import {
  DEFAULT_PROVIDER,
  PROVIDER_CHOICES,
  providerIntegrationName,
  providerLabel,
  providerModelId,
  streamTurn,
  type ProviderChoice,
  type UnifiedContentBlock,
} from "@/lib/ai-provider";

export const runtime = "nodejs";
export const maxDuration = 300;

// Output budget per model call. 8192 is the comfortable Sonnet 4.6 ceiling
// without enabling extended thinking; Gemini 2.5 Flash/Pro accept it too.
const MAX_TOKENS = 8192;
// Forced-synthesis round gets a bigger budget because it has to emit the
// whole structured report in one go — no more rounds to spread across.
const SYNTHESIS_MAX_TOKENS = 16384;
// Research budget. 12 × ~3 parallel calls per round ≈ 36 tool calls — plenty
// for deep analysis. Runaway cost is prevented by (1) anti-repeat lock on
// identical tool+input signatures, (2) consecutive-failure lock, and (3) a
// forced synthesis round at the end.
const MAX_TOOL_ITERATIONS = 12;
// After this many consecutive failures of the SAME tool, subsequent calls
// return a "do not retry" sentinel instead of actually running. Prevents
// the model from burning iterations re-calling a broken tool.
const TOOL_FAILURE_LOCK_AT = 2;

// Extended thinking budget for the chat agent's Claude turns. Sonnet 4.6
// supports thinking natively (no beta header). Hidden from the live chat
// bubble — the SDK's `text` event doesn't fire on thinking deltas — but
// the thinking blocks travel with each assistant message in history so
// the multi-turn tool-use loop stays valid. Override via env if you want
// a fatter / leaner budget; 0 (or any falsy value) disables thinking.
const CHAT_THINKING_BUDGET: number = (() => {
  const raw = Number(process.env.ANTHROPIC_THINKING_BUDGET_CHAT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4000;
})();

// Must mirror the ToolGroup union in chat-tools.ts. Missing entries cause
// the route to silently drop those groups even when the UI sends them.
// The agent surface was pruned from 6 groups to 3 — old client-side
// localStorage entries for "youtube" / "exa" / "apify" / etc. are filtered
// out below and silently dropped.
const ALLOWED_GROUPS: ToolGroup[] = ["ideation", "my_channel", "studio_analytics"];

function encodeSSE(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    sessionId?: string;
    content?: string;
    tools?: string[];
    mode?: string;
    attachments?: AttachmentInput[];
    provider?: ProviderChoice;
  };

  // T2 mode picker. Defaults to "ideate" when missing. Invalid values
  // also collapse to ideate (no 400 — keeps old clients working).
  const VALID_MODES: ReadonlySet<ChatMode> = new Set<ChatMode>([
    "ideate",
    "research",
    "validate",
  ]);
  const mode: ChatMode =
    typeof body.mode === "string" && VALID_MODES.has(body.mode as ChatMode)
      ? (body.mode as ChatMode)
      : "ideate";

  const userText = body.content?.trim() ?? "";
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (!body.sessionId || (!userText && rawAttachments.length === 0)) {
    return Response.json({ error: "sessionId and content (or attachments) required" }, { status: 400 });
  }

  const session = getSession(body.sessionId);
  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }

  const provider: ProviderChoice =
    body.provider && PROVIDER_CHOICES.includes(body.provider)
      ? body.provider
      : DEFAULT_PROVIDER;

  // The provider abstraction tells us which DB integration row holds the
  // matching API key. Bail with a clear, provider-specific message if it's
  // missing — much more actionable than a 401 from the upstream SDK.
  const integrationName = providerIntegrationName(provider);
  const apiKey = getIntegration(integrationName)?.api_key;
  if (!apiKey) {
    return Response.json(
      {
        error: `${providerLabel(
          provider
        )} API key is not configured. Add it in Integrations.`,
      },
      { status: 400 }
    );
  }

  // The mode whitelist is authoritative for tool exposure. Groups
  // default to all three so the mode filter has every tool to draw
  // from. Old clients that still POST `tools: [...]` are honored, but
  // the intersection with the mode whitelist always wins.
  const requestedGroups = (body.tools ?? []).filter(
    (g): g is ToolGroup => ALLOWED_GROUPS.includes(g as ToolGroup)
  );
  const activeGroups: ToolGroup[] =
    requestedGroups.length > 0 ? requestedGroups : [...ALLOWED_GROUPS];

  // Resolve attachments against the local DB + decode any inline images.
  // The UI renders the user's plain text, while the model sees text +
  // context block + image content blocks (when applicable).
  const resolved = resolveAttachmentsForClaude(rawAttachments);
  const composedText = resolved.asContext
    ? [
        resolved.asContext,
        "",
        "---",
        userText || "(The user attached the items above without additional text — infer intent from the attachments.)",
      ].join("\n")
    : userText;
  // Multimodal path: if any images came along, build the user message as
  // [image, image, …, text] block array. Both Anthropic and Gemini accept
  // images-then-text in the same user turn — the provider adapter handles
  // the SDK-specific wire format.
  const claudeMessageContent: Anthropic.MessageParam["content"] =
    resolved.imageBlocks.length > 0
      ? [
          ...resolved.imageBlocks,
          {
            type: "text",
            text: composedText || "(image attached without additional text — describe what you see and offer next steps)",
          },
        ]
      : composedText;

  // Save user message (raw text + attachment metadata for rendering). Images
  // are stripped here on purpose — base64 bytes don't belong in the SQLite
  // chat-history row. The chip in the UI lives only on the current page;
  // on reload the user sees the text but not the image they attached.
  const persistableAttachments = resolved.forStorage.filter(
    (a) => a.type === "video" || a.type === "comment"
  );
  addMessage(
    session.id,
    "user",
    userText,
    persistableAttachments.length ? persistableAttachments : undefined
  );

  // Auto-title first message — use user text if any, otherwise first attachment title.
  if (!session.title) {
    const seed = userText || resolved.forStorage[0]?.title || "New chat";
    const title = seed.trim().replace(/\s+/g, " ").slice(0, 60);
    renameSession(session.id, title);
  }

  const historyRows = getMessages(session.id);
  // Rebuild history. Past user messages get their attachments re-inlined so
  // the model continues to see the same context on follow-up turns. Image
  // attachments are intentionally NOT persisted with their bytes (would
  // explode the SQLite file) — the resolver silently skips them on reload.
  const history: Anthropic.MessageParam[] = historyRows.map((m) => {
    if (m.role === "user" && m.attachments && m.attachments.length > 0 && m.id !== undefined) {
      // Re-resolve video/comment refs against the live DB so the model sees
      // fresh stats; image refs (no bytes on reload) get dropped here.
      const reusable: AttachmentInput[] = m.attachments.flatMap<AttachmentInput>(
        (a) => {
          if (a.type === "video" || a.type === "comment") {
            return [{ type: a.type, id: a.id }];
          }
          return [];
        }
      );
      const r = resolveAttachmentsForClaude(reusable);
      const composed = r.asContext
        ? [r.asContext, "", "---", m.content || "(attachments only)"].join("\n")
        : m.content;
      return { role: "user", content: composed };
    }
    return { role: m.role, content: m.content };
  });

  // Replace the just-stored user message tail with the composed version
  // (text + any inline images for THIS turn).
  if (history.length > 0 && history[history.length - 1].role === "user") {
    history[history.length - 1] = { role: "user", content: claudeMessageContent };
  }

  const tools = getToolsFor(activeGroups, mode);
  const system = buildSystemPrompt(activeGroups, {
    advisorEnabled: false,
    mode,
  });

  // Mark the session as "turn in progress" so the /chat UI can show a
  // "generating…" indicator even after the user navigates away and back,
  // or refreshes the browser. Cleared in the `finally` below.
  markSessionPending(session.id);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: object) => controller.enqueue(encodeSSE(e));
      let finalAssistantText = "";
      // Anthropic extended-thinking text accumulated across every iteration
      // + the forced synthesis round. Persisted on the assistant row + sent
      // via SSE before "done" so the chat UI's "Show thinking" pill picks
      // it up without a page refresh.
      let thinkingAcc = "";
      const startedAt = Date.now();
      const toolCallCounts: Record<string, { ok: number; fail: number }> = {};
      let iterationsUsed = 0;
      let forcedSynthesis = false;

      // Token accumulators — summed across every model call in this turn
      // (main iterations + forced synthesis round). Numbers are normalized
      // by the provider adapter so cache fields stay 0 for providers that
      // don't surface them.
      let sumInput = 0;
      let sumOutput = 0;
      let sumCacheWrite = 0;
      let sumCacheRead = 0;

      // Per-turn guards against pathological behaviour.
      const consecutiveFailsByTool: Record<string, number> = {};
      const recentSignatures = new Map<string, string>();

      const signatureFor = (name: string, input: unknown): string => {
        try {
          return `${name}::${JSON.stringify(input ?? {})}`;
        } catch {
          return `${name}::<unserializable>`;
        }
      };

      try {
        const messages: Anthropic.MessageParam[] = [...history];

        let stopReason: string | null = null;
        let hadToolUseAtEnd = false;

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
          iterationsUsed = iter + 1;

          let iterText = "";
          const turn = await streamTurn({
            provider,
            apiKey,
            system,
            messages,
            tools,
            maxTokens: MAX_TOKENS,
            // Thinking only applies to Claude; Gemini path ignores it.
            thinkingBudget:
              provider === "claude" ? CHAT_THINKING_BUDGET : undefined,
            onText: (text) => {
              iterText += text;
              send({ type: "delta", text });
            },
          });

          stopReason = turn.stopReason;

          // Scoop thinking blocks out of the unified content array. Anthropic
          // ships them inline as { type: "thinking", thinking: string }; the
          // ai-provider adapter passes the raw Anthropic content through on
          // `turn.content`, so a duck-typed check covers it without us
          // having to widen the UnifiedContentBlock union.
          for (const block of turn.content as Array<{
            type: string;
            thinking?: string;
          }>) {
            if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
              thinkingAcc += (thinkingAcc ? "\n\n---\n\n" : "") + block.thinking;
            }
          }

          log.debug("chat", "Turn usage", {
            provider,
            iter,
            usage: turn.usage,
            stopReason: turn.stopReason,
          });

          sumInput += turn.usage.inputTokens;
          sumOutput += turn.usage.outputTokens;
          sumCacheWrite += turn.usage.cacheWriteTokens;
          sumCacheRead += turn.usage.cacheReadTokens;

          const toolUses = turn.blocks.filter(
            (b): b is Extract<UnifiedContentBlock, { type: "tool_use" }> =>
              b.type === "tool_use"
          );

          if (turn.stopReason !== "tool_use" || toolUses.length === 0) {
            // Terminal iteration — THIS iteration's text IS the final answer.
            finalAssistantText = iterText;
            hadToolUseAtEnd = false;
            break;
          }
          hadToolUseAtEnd = true;

          // Run each tool; collect results.
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            const sig = signatureFor(tu.name, tu.input);
            const failCount = consecutiveFailsByTool[tu.name] ?? 0;

            // Guard 1: refuse the Nth attempt of a tool that already failed
            // N-1 times — something is wrong with the tool itself.
            if (failCount >= TOOL_FAILURE_LOCK_AT) {
              send({ type: "tool_use", name: tu.name, input: tu.input });
              const msg = `[REPEATED_FAILURE] The tool "${tu.name}" has failed ${failCount} times in this turn and is unavailable. Do NOT call it again. Note this limitation in your final answer and continue with other evidence sources.`;
              send({ type: "tool_result", name: tu.name, ok: false, preview: msg });
              toolResults.push({
                type: "tool_result",
                tool_use_id: tu.id,
                is_error: true,
                content: msg,
              });
              (toolCallCounts[tu.name] ??= { ok: 0, fail: 0 }).fail++;
              continue;
            }

            // Guard 2: identical tool+input combo already executed this turn.
            const prior = recentSignatures.get(sig);
            if (prior) {
              send({ type: "tool_use", name: tu.name, input: tu.input });
              const msg = `[DUPLICATE_CALL] You already invoked ${tu.name} with these exact arguments earlier in this turn. Previous result preview: ${prior}. Do not re-issue identical calls — synthesise from what you have.`;
              send({ type: "tool_result", name: tu.name, ok: false, preview: msg });
              toolResults.push({
                type: "tool_result",
                tool_use_id: tu.id,
                is_error: true,
                content: msg,
              });
              continue;
            }

            send({ type: "tool_use", name: tu.name, input: tu.input });
            const result = await runTool(
              tu.name,
              (tu.input ?? {}) as Record<string, unknown>
            );
            const counts = (toolCallCounts[tu.name] ??= { ok: 0, fail: 0 });
            if (result.ok) {
              counts.ok++;
              consecutiveFailsByTool[tu.name] = 0;
            } else {
              counts.fail++;
              consecutiveFailsByTool[tu.name] =
                (consecutiveFailsByTool[tu.name] ?? 0) + 1;
              log.warn("chat", `Tool call failed: ${tu.name}`, {
                sessionId: session.id,
                tool: tu.name,
                input: tu.input,
                error: result.error,
                consecutiveFails: consecutiveFailsByTool[tu.name],
              });
            }
            const preview = result.ok
              ? typeof result.data === "object"
                ? JSON.stringify(result.data).slice(0, 280)
                : String(result.data).slice(0, 280)
              : result.error;
            recentSignatures.set(sig, preview);
            send({ type: "tool_result", name: tu.name, ok: result.ok, preview });

            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              is_error: !result.ok,
              content: result.ok
                ? JSON.stringify(result.data).slice(0, 50_000)
                : result.error,
            });
          }

          // Append assistant (with tool_use blocks) + user (with tool_result blocks).
          messages.push({ role: "assistant", content: turn.content });
          messages.push({ role: "user", content: toolResults });

          // Newline break in the visible stream so the UI can slot tool
          // call rows between text chunks. Not saved — it was narration.
          send({ type: "delta", text: "\n\n" });
        }

        // FORCED SYNTHESIS ROUND: research budget exhausted but the model
        // still wanted tools. Without this, the user sees scattered "I'm
        // about to check X…" narration and no actual answer. Give it one
        // final shot with tools disabled, a bigger token budget, and a
        // direct "write the answer now" nudge.
        if (hadToolUseAtEnd && stopReason === "tool_use") {
          forcedSynthesis = true;
          // Tell the UI to wipe the visible assistant bubble — everything
          // streamed so far was narration between tool calls, not the
          // actual answer.
          send({ type: "reset_text" });

          messages.push({
            role: "user",
            content:
              "Research budget exhausted. Do not request any more tools. " +
              "Write the complete final answer NOW using the data you already gathered. " +
              "If some data is missing, explicitly state what's unavailable and why — then proceed to conclusions and actions based on what IS known. " +
              "Do not apologise or preamble. Go straight to the structured report.",
          });

          let synthText = "";
          const synthTurn = await streamTurn({
            provider,
            apiKey,
            system,
            messages,
            tools: [], // tools off for synthesis
            maxTokens: SYNTHESIS_MAX_TOKENS,
            // Synthesis is exactly the case where reasoning pays — give
            // the model the same budget as a regular iter.
            thinkingBudget:
              provider === "claude" ? CHAT_THINKING_BUDGET : undefined,
            onText: (text) => {
              synthText += text;
              send({ type: "delta", text });
            },
          });
          sumInput += synthTurn.usage.inputTokens;
          sumOutput += synthTurn.usage.outputTokens;
          sumCacheWrite += synthTurn.usage.cacheWriteTokens;
          sumCacheRead += synthTurn.usage.cacheReadTokens;
          finalAssistantText = synthText;
          // Same thinking-scoop pattern as the iter loop.
          for (const block of synthTurn.content as Array<{
            type: string;
            thinking?: string;
          }>) {
            if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
              thinkingAcc += (thinkingAcc ? "\n\n---\n\n" : "") + block.thinking;
            }
          }
        }

        if (finalAssistantText.trim().length > 0) {
          addMessage(
            session.id,
            "assistant",
            finalAssistantText,
            undefined,
            thinkingAcc || null
          );
        }

        // Push the thinking text to the client BEFORE done so the pill
        // appears the moment the answer is finalized. Skipped when empty.
        if (thinkingAcc) {
          send({ type: "thinking", text: thinkingAcc });
        }
        send({ type: "done" });

        log.info("chat", "Chat turn completed", {
          sessionId: session.id,
          provider,
          model: providerModelId(provider),
          attachments: resolved.forStorage.length,
          activeTools: activeGroups,
          toolCallCounts,
          iterationsUsed,
          maxIterations: MAX_TOOL_ITERATIONS,
          forcedSynthesis,
          durationMs: Date.now() - startedAt,
          answerChars: finalAssistantText.length,
          tokens: {
            input: sumInput,
            output: sumOutput,
            cacheWrite: sumCacheWrite,
            cacheRead: sumCacheRead,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ type: "error", message });
        log.error("chat", `Chat turn failed: ${message}`, err, {
          sessionId: session.id,
          provider,
          activeTools: activeGroups,
          toolCallCounts,
          durationMs: Date.now() - startedAt,
          tokens: {
            input: sumInput,
            output: sumOutput,
            cacheWrite: sumCacheWrite,
            cacheRead: sumCacheRead,
          },
        });
      } finally {
        // Record spend on BOTH success and error paths. The ledger reflects
        // every API call we actually made, including aborted turns.
        // Cost calc only knows Claude pricing today — Gemini turns log
        // tokens but report 0 millicents until we extend the pricer. The
        // /claude/usage page filters by model so this still surfaces.
        if (sumInput > 0 || sumOutput > 0) {
          try {
            const executorModel = providerModelId(provider);
            const executorCostMc =
              provider === "claude"
                ? costMillicents(executorModel, {
                    inputFresh: sumInput,
                    inputCacheWrite: sumCacheWrite,
                    inputCacheRead: sumCacheRead,
                    output: sumOutput,
                  })
                : 0;
            recordClaudeUsage({
              sessionId: session.id,
              executorModel,
              advisorModel: null,
              inputTokens: sumInput,
              outputTokens: sumOutput,
              cacheWriteTokens: sumCacheWrite,
              cacheReadTokens: sumCacheRead,
              advisorInputTokens: 0,
              advisorOutputTokens: 0,
              advisorCalls: 0,
              costMillicents: executorCostMc,
              durationMs: Date.now() - startedAt,
              iterations: iterationsUsed,
              firstUserMsg: userText.slice(0, 200),
              activeTools: activeGroups,
            });
          } catch (ledgerErr) {
            log.warn("chat", "Failed to record usage", {
              sessionId: session.id,
              error: ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr),
            });
          }
        }
        // Always clear the pending marker — on success, error, or abort.
        clearSessionPending(session.id);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
