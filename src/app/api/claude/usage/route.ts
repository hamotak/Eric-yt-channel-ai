import { NextResponse } from "next/server";
import { claudeUsageStats, clearClaudeUsage } from "@/lib/db";

export const runtime = "nodejs";

/**
 * AI-spend history for the Integrations page widget. This route stays as a
 * compatibility alias for older clients.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const stats = claudeUsageStats({ limit });
  return NextResponse.json({
    totalCostMillicents: stats.totalCostMillicents,
    last24hCostMillicents: stats.last24hCostMillicents,
    totalInputTokens: stats.totalInputTokens,
    totalOutputTokens: stats.totalOutputTokens,
    totalCacheReadTokens: stats.totalCacheReadTokens,
    turns: stats.turns,
    recent: stats.recent.map((r) => ({
      id: r.id,
      ts: r.ts,
      provider: r.provider,
      sessionId: r.session_id,
      executorModel: r.executor_model,
      advisorModel: r.advisor_model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      cacheReadTokens: r.cache_read_tokens,
      advisorInputTokens: r.advisor_input_tokens,
      advisorOutputTokens: r.advisor_output_tokens,
      advisorCalls: r.advisor_calls,
      costMillicents: r.cost_millicents,
      durationMs: r.duration_ms,
      iterations: r.iterations,
      firstUserMsg: r.first_user_msg,
      activeTools: safeParseArr(r.active_tools),
    })),
  });
}

/**
 * DELETE — clear the whole ledger. Useful for when the user wants to
 * reset cost tracking (e.g. after switching API keys or billing periods).
 */
export async function DELETE() {
  const deleted = clearClaudeUsage();
  return NextResponse.json({ ok: true, deleted });
}

function safeParseArr(s: string | null): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
