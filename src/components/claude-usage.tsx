"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type Turn = {
  id: number;
  ts: number;
  provider: string;
  sessionId: string | null;
  executorModel: string;
  advisorModel: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  advisorInputTokens: number;
  advisorOutputTokens: number;
  advisorCalls: number;
  costMillicents: number;
  durationMs: number;
  iterations: number;
  firstUserMsg: string | null;
  activeTools: string[];
};

type Data = {
  totalCostMillicents: number;
  last24hCostMillicents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  turns: number;
  recent: Turn[];
};

function fmtUsd(millicents: number): string {
  const usd = millicents / 100_000;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toString();
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${m}-${dd} ${hh}:${mm}`;
}

/**
 * Per-turn AI spend widget rendered under configured model integrations.
 *
 * Three things visible at a glance:
 *   - Total spent + last-24h spent
 *   - Per-turn list with cost, duration, token breakdown on expand
 *   - "Clear history" button (resets the ledger, doesn't affect provider billing)
 */
export function AiUsage({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  const [data, setData] = useState<Data | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ai/usage?limit=100");
      if (!res.ok) return;
      const d = (await res.json()) as Data;
      setData(d);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && open) load();
  }, [enabled, open, load]);

  const clearAll = async () => {
    if (!confirm(t.claudeUsage.confirmClear)) return;
    await fetch("/api/ai/usage", { method: "DELETE" });
    load();
  };

  const toggleRow = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!enabled) return null;

  return (
    <div className="mt-4 space-y-2 rounded-md border border-border bg-muted/20">
      {/* Header / toggle — closed by default so we don't spam first-time users */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/50"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span>{t.claudeUsage.title}</span>
        {data && (
          <span className="ml-auto flex items-center gap-3 text-[11px] font-normal text-muted-foreground">
            <span>
              {t.claudeUsage.last24h}: <span className="font-medium text-foreground">{fmtUsd(data.last24hCostMillicents)}</span>
            </span>
            <span>
              {t.claudeUsage.total}: <span className="font-medium text-foreground">{fmtUsd(data.totalCostMillicents)}</span>
            </span>
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3 px-3 pb-3">
          {/* Summary row */}
          {data && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SummaryStat label={t.claudeUsage.statTurns} value={String(data.turns)} />
              <SummaryStat
                label={t.claudeUsage.statInput}
                value={fmtTokens(data.totalInputTokens)}
              />
              <SummaryStat
                label={t.claudeUsage.statOutput}
                value={fmtTokens(data.totalOutputTokens)}
              />
              <SummaryStat
                label={t.claudeUsage.statCacheRead}
                value={fmtTokens(data.totalCacheReadTokens)}
              />
            </div>
          )}

          {/* Honesty-bar: the local ledger only sees turns that happened after
              we added the tracking code. Anthropic's console has the full
              history. This hint prevents confusion when numbers differ. */}
          {data && data.recent.length > 0 && (
            <div className="rounded-md border border-dashed border-border bg-background px-3 py-2 text-[10px] text-muted-foreground">
              {t.claudeUsage.ledgerSinceHint.replace(
                "{date}",
                new Date(data.recent[data.recent.length - 1].ts * 1000).toLocaleString("en-US")
              )}
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={load}
              disabled={loading}
              className="h-7 gap-1.5 text-xs"
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
              {t.claudeUsage.refresh}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={clearAll}
              className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
              {t.claudeUsage.clearHistory}
            </Button>
          </div>

          {/* Recent turns list */}
          {!data || data.recent.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-background px-3 py-6 text-center text-xs text-muted-foreground">
              {loading ? t.claudeUsage.loading : t.claudeUsage.empty}
            </div>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border bg-background">
              {data.recent.map((turn) => {
                const isOpen = expanded.has(turn.id);
                return (
                  <li key={turn.id}>
                    <button
                      type="button"
                      onClick={() => toggleRow(turn.id)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent/40"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                      )}
                      <span className="w-14 shrink-0 font-mono text-[10px] text-muted-foreground">
                        {fmtTime(turn.ts)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {turn.firstUserMsg || (
                          <span className="italic text-muted-foreground">
                            {t.claudeUsage.emptyMsg}
                          </span>
                        )}
                      </span>
                      {turn.advisorCalls > 0 && (
                        <span
                          className="shrink-0 rounded-sm bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary"
                          title={t.claudeUsage.advisorUsedTitle}
                        >
                          +Opus×{turn.advisorCalls}
                        </span>
                      )}
                      <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums">
                        {fmtUsd(turn.costMillicents)}
                      </span>
                    </button>
                    {isOpen && <TurnDetails turn={turn} />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export const ClaudeUsage = AiUsage;

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function TurnDetails({ turn }: { turn: Turn }) {
  const { t } = useI18n();
  const durationSec = (turn.durationMs / 1000).toFixed(1);
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border/60 bg-muted/30 px-8 py-2 text-[11px] text-muted-foreground">
      <Row label={t.claudeUsage.rowModel} value={`${turn.provider}:${turn.executorModel}`} mono />
      <Row label={t.claudeUsage.rowIterations} value={String(turn.iterations)} />
      <Row label={t.claudeUsage.rowInputTokens} value={fmtTokens(turn.inputTokens)} />
      <Row label={t.claudeUsage.rowOutputTokens} value={fmtTokens(turn.outputTokens)} />
      {turn.cacheReadTokens > 0 && (
        <Row label={t.claudeUsage.rowCacheRead} value={fmtTokens(turn.cacheReadTokens)} />
      )}
      {turn.cacheWriteTokens > 0 && (
        <Row label={t.claudeUsage.rowCacheWrite} value={fmtTokens(turn.cacheWriteTokens)} />
      )}
      {turn.advisorCalls > 0 && (
        <>
          <Row
            label={t.claudeUsage.rowAdvisor}
            value={`${turn.advisorModel ?? "?"} × ${turn.advisorCalls}`}
            mono
          />
          {turn.advisorInputTokens + turn.advisorOutputTokens > 0 && (
            <Row
              label={t.claudeUsage.rowAdvisorTokens}
              value={`${fmtTokens(turn.advisorInputTokens)} / ${fmtTokens(turn.advisorOutputTokens)}`}
            />
          )}
        </>
      )}
      <Row label={t.claudeUsage.rowDuration} value={`${durationSec}s`} />
      {turn.activeTools.length > 0 && (
        <Row
          label={t.claudeUsage.rowActiveTools}
          value={turn.activeTools.join(", ")}
        />
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0">{label}</span>
      <span className={cn("truncate tabular-nums", mono && "font-mono text-foreground")}>
        {value}
      </span>
    </div>
  );
}
