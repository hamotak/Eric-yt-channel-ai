"use client";

/**
 * Learned Rules panel — surfaces rows from `ideation_rules` for the
 * current channel. Rows distilled by the pipeline (T6.5 distillFeedback)
 * land with pending=1. The panel exposes the two-step confirm:
 *   - "Apply"  → PATCH /api/ideation-rules/[id] { pending: 0 }
 *   - "Reject" → DELETE /api/ideation-rules/[id]
 * Already-applied rows show only "Remove" (DELETE).
 *
 * Visual style matches the new /competitors page: hairline-divided rows,
 * no card chrome, text-link affordances (not buttons).
 */

import { useCallback, useEffect, useState } from "react";

type LearnedRule = {
  id: number;
  ruleType: string;
  ruleValue: string;
  sourceNote: string | null;
  sourceIdeaId: string | null;
  pending: boolean;
  createdAt: string;
};

const RULE_TYPE_LABEL: Record<string, string> = {
  banned_topic: "BANNED TOPIC",
  banned_substitution: "BANNED SUBSTITUTION",
  banned_pattern: "BANNED PATTERN",
  preferred_format: "PREFERRED FORMAT",
  preferred_topic: "PREFERRED TOPIC",
};

export function LearnedRulesPanel({ channelId }: { channelId: string }) {
  const [rules, setRules] = useState<LearnedRule[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/ideation-rules?channelId=${channelId}`, {
        cache: "no-store",
      });
      const j = await r.json();
      setRules(j.rules ?? []);
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    async (id: number) => {
      await fetch(`/api/ideation-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pending: 0 }),
      });
      await load();
    },
    [load]
  );

  const remove = useCallback(
    async (id: number) => {
      await fetch(`/api/ideation-rules/${id}`, { method: "DELETE" });
      await load();
    },
    [load]
  );

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">Loading learned rules…</p>
    );
  }

  if (rules.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No learned rules yet. Add notes on ideas in /ideate and they&apos;ll surface here.
      </p>
    );
  }

  return (
    <ul className="border-t border-border">
      {rules.map((rule) => (
        <li key={rule.id} className="border-b border-border py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[10px] tracking-wider text-muted-foreground">
                  {RULE_TYPE_LABEL[rule.ruleType] ?? rule.ruleType.toUpperCase()}
                </span>
                {rule.pending && (
                  <span className="font-mono text-[10px] tracking-wider text-amber-600 dark:text-amber-400">
                    PENDING
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-foreground">{rule.ruleValue}</p>
              {rule.sourceNote && (
                <p className="mt-1 text-xs italic text-muted-foreground">
                  from your note: &ldquo;{rule.sourceNote}&rdquo;
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3 whitespace-nowrap pt-1 text-xs">
              {rule.pending ? (
                <>
                  <button
                    type="button"
                    onClick={() => apply(rule.id)}
                    className="text-primary hover:underline"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(rule.id)}
                    className="text-muted-foreground hover:text-destructive hover:underline"
                  >
                    Reject
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => remove(rule.id)}
                  className="text-muted-foreground hover:text-destructive hover:underline"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
