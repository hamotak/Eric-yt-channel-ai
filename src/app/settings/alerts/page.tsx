"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Bell,
  BellOff,
  Check,
  ExternalLink,
  History,
  Loader2,
  Plus,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Config = {
  enabled: boolean;
  telegramConfigured: boolean;
};

type Rule = {
  id: number;
  enabled: boolean;
  name: string;
  type: "velocity" | "total_milestone" | "delta_window";
  metric: "views" | "likes" | "comments";
  threshold: number;
  windowMinutes: number | null;
  scope: "recent_n" | "all";
  scopeValue: number | null;
  channelId: string | null;
  cooldownMinutes: number;
  fireOnce: boolean;
  createdAt: number;
  updatedAt: number;
};

type Fire = {
  id: number;
  ruleId: number;
  ruleName: string | null;
  videoId: string;
  videoTitle: string | null;
  firedAt: number;
  metricValue: number | null;
  delivered: number;
  error: string | null;
};

const RULE_TEMPLATES: { name: string; preset: Omit<Rule, "id" | "createdAt" | "updatedAt"> }[] = [
  {
    name: "Views/hour spike (recent uploads)",
    preset: {
      enabled: true,
      name: "Recent uploads — views/hour spike",
      type: "velocity",
      metric: "views",
      threshold: 100,
      windowMinutes: 60,
      scope: "recent_n",
      scopeValue: 10,
      channelId: null,
      cooldownMinutes: 60,
      fireOnce: false,
    },
  },
  {
    name: "Hit 100k total views",
    preset: {
      enabled: true,
      name: "100k views milestone",
      type: "total_milestone",
      metric: "views",
      threshold: 100_000,
      windowMinutes: null,
      scope: "all",
      scopeValue: null,
      channelId: null,
      cooldownMinutes: 0,
      fireOnce: true,
    },
  },
  {
    name: "Hit 1M total views",
    preset: {
      enabled: true,
      name: "1M views milestone",
      type: "total_milestone",
      metric: "views",
      threshold: 1_000_000,
      windowMinutes: null,
      scope: "all",
      scopeValue: null,
      channelId: null,
      cooldownMinutes: 0,
      fireOnce: true,
    },
  },
  {
    name: "Comments burst (last 6h)",
    preset: {
      enabled: true,
      name: "Comments burst",
      type: "delta_window",
      metric: "comments",
      threshold: 50,
      windowMinutes: 360,
      scope: "recent_n",
      scopeValue: 10,
      channelId: null,
      cooldownMinutes: 360,
      fireOnce: false,
    },
  },
  {
    name: "Likes/hour spike",
    preset: {
      enabled: true,
      name: "Likes velocity",
      type: "velocity",
      metric: "likes",
      threshold: 50,
      windowMinutes: 60,
      scope: "recent_n",
      scopeValue: 10,
      channelId: null,
      cooldownMinutes: 60,
      fireOnce: false,
    },
  },
];

export default function AlertsPage() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [fires, setFires] = useState<Fire[]>([]);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const loadCfg = useCallback(async () => {
    const res = await fetch("/api/alerts/config");
    setCfg((await res.json()) as Config);
  }, []);
  const loadRules = useCallback(async () => {
    const res = await fetch("/api/alerts/rules");
    const d = (await res.json()) as { rules: Rule[] };
    setRules(d.rules);
  }, []);
  const loadFires = useCallback(async () => {
    const res = await fetch("/api/alerts/fires?limit=20");
    const d = (await res.json()) as { fires: Fire[] };
    setFires(d.fires);
  }, []);

  useEffect(() => {
    loadCfg();
    loadRules();
    loadFires();
  }, [loadCfg, loadRules, loadFires]);

  const saveCfg = async (
    patch: Partial<Config & { telegramBotToken: string; telegramChatId: string }>
  ) => {
    setSaving(true);
    try {
      await fetch("/api/alerts/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      await loadCfg();
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/alerts/config", { method: "PUT" });
      const data = (await res.json()) as { ok: boolean; error?: string };
      setTestResult({
        ok: data.ok,
        message: data.ok ? "Test message sent — check your Telegram." : data.error ?? "send failed",
      });
    } finally {
      setTesting(false);
    }
  };

  const createFromTemplate = async (preset: Omit<Rule, "id" | "createdAt" | "updatedAt">) => {
    setCreating(true);
    setCreateError("");
    try {
      const res = await fetch("/api/alerts/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(preset),
      });
      const data = (await res.json()) as { rule?: Rule; error?: string };
      if (!res.ok) {
        setCreateError(data.error ?? `HTTP ${res.status}`);
      } else {
        await loadRules();
      }
    } finally {
      setCreating(false);
    }
  };

  const updateRule = async (id: number, patch: Partial<Rule>) => {
    const res = await fetch(`/api/alerts/rules/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) loadRules();
    else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      alert(data.error ?? `HTTP ${res.status}`);
    }
  };

  const deleteRule = async (id: number) => {
    if (!confirm("Delete this rule?")) return;
    await fetch(`/api/alerts/rules/${id}`, { method: "DELETE" });
    loadRules();
  };

  if (!cfg || !rules) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Stack as many notification rules as you like — view spikes,
          milestone counts, comment bursts, or anything else worth a ping.
          Each rule polls every ~15 min via the configured cron.
        </p>
      </header>

      {/* Master switch */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {cfg.enabled ? (
                <Bell className="h-4 w-4 text-primary" />
              ) : (
                <BellOff className="h-4 w-4 text-muted-foreground" />
              )}
              Alerts {cfg.enabled ? "enabled" : "disabled"}
            </CardTitle>
            <CardDescription>
              {cfg.enabled
                ? "Polling will evaluate every enabled rule."
                : "Polling won't fire any rule until you flip this on."}
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant={cfg.enabled ? "outline" : "default"}
            onClick={() => saveCfg({ enabled: !cfg.enabled })}
            disabled={saving}
          >
            {cfg.enabled ? "Turn off" : "Turn on"}
          </Button>
        </CardHeader>
      </Card>

      {/* Telegram config */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Send className="h-4 w-4 text-primary" />
            Telegram bot
            {cfg.telegramConfigured && (
              <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
                CONFIGURED
              </span>
            )}
          </CardTitle>
          <CardDescription>Where alert messages get delivered.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <details className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer text-foreground">How to set up</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 leading-relaxed">
              <li>
                Open Telegram → search <code className="rounded bg-muted px-1">@BotFather</code> →{" "}
                <code className="rounded bg-muted px-1">/newbot</code>. Save the token.
              </li>
              <li>
                Send <code className="rounded bg-muted px-1">/start</code> to the new bot from your account.
              </li>
              <li>
                Open{" "}
                <code className="rounded bg-muted px-1">
                  https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates
                </code>
                . Look for <code className="rounded bg-muted px-1">{"\"chat\":{\"id\":123...}"}</code>.
              </li>
              <li>Paste both below, save, send a test.</li>
            </ol>
          </details>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="bot-token">Bot token</Label>
              <Input
                id="bot-token"
                type="password"
                placeholder="123456:ABC-DEF..."
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-id">Chat ID</Label>
              <Input
                id="chat-id"
                type="text"
                placeholder="123456789"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={saving || (!botToken.trim() && !chatId.trim())}
              onClick={() =>
                saveCfg({
                  telegramBotToken: botToken.trim() || undefined,
                  telegramChatId: chatId.trim() || undefined,
                } as never)
              }
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!cfg.telegramConfigured || testing}
              onClick={sendTest}
              className="gap-1.5"
            >
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send test
            </Button>
          </div>

          {testResult && (
            <div
              className={cn(
                "rounded-md border p-2 text-xs",
                testResult.ok
                  ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400"
                  : "border-destructive/40 bg-destructive/10 text-destructive"
              )}
            >
              <div className="flex items-start gap-2">
                {testResult.ok ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <span>{testResult.message}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Rules */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span>Rules ({rules.length})</span>
          </CardTitle>
          <CardDescription>
            Each rule runs every poll. Rules can stack — &ldquo;views/hour spike&rdquo;{" "}
            <em>and</em> &ldquo;hit 100k views&rdquo; <em>and</em> &ldquo;comments burst&rdquo;
            can all fire on the same video without conflict.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Quick-add templates */}
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Plus className="h-3.5 w-3.5" /> Add a rule
            </div>
            <div className="flex flex-wrap gap-2">
              {RULE_TEMPLATES.map((t) => (
                <Button
                  key={t.name}
                  size="sm"
                  variant="outline"
                  disabled={creating}
                  onClick={() => createFromTemplate(t.preset)}
                  className="text-xs"
                >
                  {t.name}
                </Button>
              ))}
            </div>
            {createError && (
              <div className="mt-2 text-xs text-destructive">{createError}</div>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              Templates seed defaults — edit threshold / window / scope on the rule row after it appears.
            </p>
          </div>

          {/* Rule list */}
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rules yet. Pick a template above to get started.
            </p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  onUpdate={(p) => updateRule(rule.id, p)}
                  onDelete={() => deleteRule(rule.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent fires feed */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-primary" />
            Recent fires
          </CardTitle>
          <CardDescription>
            What rules have triggered lately. Useful to spot a rule that&apos;s too
            sensitive (firing every poll) or too strict (never fires).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {fires.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No alerts have fired yet. Once cron starts polling and a rule&apos;s
              condition trips, you&apos;ll see entries here.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {fires.map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-2 text-xs">
                  <span className="w-32 shrink-0 truncate font-medium">
                    {f.ruleName ?? `rule#${f.ruleId}`}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {f.videoTitle ?? f.videoId}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {f.metricValue !== null ? Math.round(f.metricValue).toLocaleString("en-US") : "—"}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {fmtAgo(f.firedAt)}
                  </span>
                  {f.delivered ? (
                    <Check className="h-3 w-3 shrink-0 text-green-600" />
                  ) : (
                    <AlertCircle className="h-3 w-3 shrink-0 text-amber-500" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Cron setup */}
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Cron setup (one-time)
          </CardTitle>
          <CardDescription>
            Polling runs at <code className="rounded bg-muted px-1">/api/alerts/poll</code>.
            Hit it every ~15 min from any free cron service.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <ol className="ml-4 list-decimal space-y-1 text-xs text-muted-foreground">
            <li>
              Sign up at{" "}
              <a
                href="https://cron-job.org"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                cron-job.org <ExternalLink className="h-3 w-3" />
              </a>
              .
            </li>
            <li>
              Set the URL to{" "}
              <code className="break-all rounded bg-muted px-1 text-[11px]">
                {typeof window !== "undefined"
                  ? `${window.location.origin}/api/alerts/poll?secret=YOUR_SECRET`
                  : "https://your-domain/api/alerts/poll?secret=YOUR_SECRET"}
              </code>
            </li>
            <li>
              On Railway, set{" "}
              <code className="rounded bg-muted px-1">ALERTS_CRON_SECRET</code> env var to the same value.
            </li>
            <li>Schedule: every 15 minutes.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function fmtAgo(unix: number): string {
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function RuleRow({
  rule,
  onUpdate,
  onDelete,
}: {
  rule: Rule;
  onUpdate: (patch: Partial<Rule>) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(rule);
  // Re-sync if rule props changed externally (e.g. another row's update
  // triggered a refetch).
  useMemo(() => {
    setDraft(rule);
  }, [rule]);

  const dirty =
    draft.name !== rule.name ||
    draft.threshold !== rule.threshold ||
    draft.windowMinutes !== rule.windowMinutes ||
    draft.scope !== rule.scope ||
    draft.scopeValue !== rule.scopeValue ||
    draft.cooldownMinutes !== rule.cooldownMinutes ||
    draft.fireOnce !== rule.fireOnce ||
    draft.metric !== rule.metric ||
    draft.type !== rule.type;

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => onUpdate({ enabled: e.target.checked })}
          className="h-4 w-4"
          aria-label="Enable rule"
        />
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="h-8 flex-1 text-sm font-medium"
        />
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={onDelete}
          aria-label="Delete rule"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase text-muted-foreground">Type</Label>
          <select
            value={draft.type}
            onChange={(e) => {
              const t = e.target.value as Rule["type"];
              setDraft({
                ...draft,
                type: t,
                fireOnce: t === "total_milestone" ? true : false,
                windowMinutes:
                  t === "total_milestone" ? null : (draft.windowMinutes ?? 60),
              });
            }}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          >
            <option value="velocity">Velocity (per hour)</option>
            <option value="total_milestone">Total milestone</option>
            <option value="delta_window">Delta in window</option>
          </select>
        </div>

        <div className="space-y-1">
          <Label className="text-[10px] uppercase text-muted-foreground">Metric</Label>
          <select
            value={draft.metric}
            onChange={(e) => setDraft({ ...draft, metric: e.target.value as Rule["metric"] })}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          >
            <option value="views">Views</option>
            <option value="likes">Likes</option>
            <option value="comments">Comments</option>
          </select>
        </div>

        <div className="space-y-1">
          <Label className="text-[10px] uppercase text-muted-foreground">
            {draft.type === "total_milestone"
              ? "Threshold (total)"
              : draft.type === "velocity"
                ? "Threshold (per hour)"
                : "Threshold (delta)"}
          </Label>
          <Input
            type="number"
            min={1}
            value={draft.threshold}
            onChange={(e) => setDraft({ ...draft, threshold: Number(e.target.value) || 0 })}
            className="h-8 text-xs"
          />
        </div>

        {draft.type !== "total_milestone" && (
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Window (min)</Label>
            <Input
              type="number"
              min={5}
              value={draft.windowMinutes ?? 60}
              onChange={(e) =>
                setDraft({ ...draft, windowMinutes: Number(e.target.value) || 60 })
              }
              className="h-8 text-xs"
            />
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-[10px] uppercase text-muted-foreground">Scope</Label>
          <select
            value={draft.scope}
            onChange={(e) => {
              const s = e.target.value as Rule["scope"];
              setDraft({
                ...draft,
                scope: s,
                scopeValue: s === "recent_n" ? (draft.scopeValue ?? 10) : null,
              });
            }}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          >
            <option value="recent_n">Recent N uploads</option>
            <option value="all">All videos</option>
          </select>
        </div>

        {draft.scope === "recent_n" && (
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">N (recent)</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={draft.scopeValue ?? 10}
              onChange={(e) =>
                setDraft({ ...draft, scopeValue: Number(e.target.value) || 10 })
              }
              className="h-8 text-xs"
            />
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-[10px] uppercase text-muted-foreground">Cooldown (min)</Label>
          <Input
            type="number"
            min={0}
            value={draft.cooldownMinutes}
            onChange={(e) =>
              setDraft({ ...draft, cooldownMinutes: Number(e.target.value) || 0 })
            }
            disabled={draft.fireOnce}
            className="h-8 text-xs"
          />
        </div>

        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.fireOnce}
              onChange={(e) => setDraft({ ...draft, fireOnce: e.target.checked })}
              className="h-3.5 w-3.5"
            />
            <span>Fire once per video</span>
          </label>
        </div>
      </div>

      {dirty && (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(rule)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onUpdate({
                name: draft.name,
                type: draft.type,
                metric: draft.metric,
                threshold: draft.threshold,
                windowMinutes: draft.windowMinutes,
                scope: draft.scope,
                scopeValue: draft.scopeValue,
                cooldownMinutes: draft.cooldownMinutes,
                fireOnce: draft.fireOnce,
              })
            }
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
