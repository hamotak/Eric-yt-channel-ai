"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bug,
  ChevronDown,
  ChevronRight,
  Info,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/provider";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogRow = {
  id: number;
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  context: unknown;
  stack: string | null;
};

type Stats = {
  total: number;
  byLevel: Record<LogLevel, number>;
  sources: string[];
  last24hErrors: number;
};

const LEVEL_META: Record<
  LogLevel,
  { label: string; icon: React.ComponentType<{ className?: string }>; classes: string }
> = {
  debug: {
    label: "debug",
    icon: Bug,
    classes: "text-muted-foreground bg-muted",
  },
  info: {
    label: "info",
    icon: Info,
    classes: "text-blue-700 dark:text-blue-300 bg-blue-500/10",
  },
  warn: {
    label: "warn",
    icon: AlertTriangle,
    classes: "text-amber-700 dark:text-amber-300 bg-amber-500/10",
  },
  error: {
    label: "error",
    icon: AlertCircle,
    classes: "text-red-700 dark:text-red-300 bg-red-500/10",
  },
};

export default function LogsPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [source, setSource] = useState<string>("all");
  const [q, setQ] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (level !== "all") params.set("level", level);
      if (source !== "all") params.set("source", source);
      if (q.trim()) params.set("q", q.trim());
      params.set("limit", "300");
      const res = await fetch(`/api/logs?${params.toString()}`);
      // Tolerate empty/non-JSON bodies (can happen mid hot-reload) instead of
      // crashing the whole page with "Unexpected end of JSON input".
      const text = await res.text();
      const data = text ? safeParse(text) : null;
      setRows((data as { logs?: LogRow[] } | null)?.logs ?? []);
      setStats((data as { stats?: Stats } | null)?.stats ?? null);
    } catch (err) {
      // Last-ditch: don't leave the page in a broken state.
      // eslint-disable-next-line no-console
      console.error("load /api/logs failed:", err);
    } finally {
      setLoading(false);
    }
  }, [level, source, q]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh (live tail). Avoid stacking timers — cleanup on deps change.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(load, 3000);
    return () => window.clearInterval(id);
  }, [autoRefresh, load]);

  const clearAll = async () => {
    if (!confirm(t.logs.confirmClear)) return;
    await fetch("/api/logs", { method: "DELETE" });
    load();
  };

  const clearLevel = async (lvl: LogLevel) => {
    if (!confirm(t.logs.confirmClear)) return;
    await fetch(`/api/logs?level=${lvl}`, { method: "DELETE" });
    load();
  };

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sources = useMemo(() => stats?.sources ?? [], [stats]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{t.logs.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t.logs.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={autoRefresh ? "default" : "outline"}
            onClick={() => setAutoRefresh((v) => !v)}
            className="gap-2"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", autoRefresh && "animate-spin")} />
            {autoRefresh ? t.logs.liveOn : t.logs.liveOff}
          </Button>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            {t.logs.refresh}
          </Button>
          <Button size="sm" variant="outline" onClick={clearAll} className="gap-2 text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
            {t.logs.clearAll}
          </Button>
        </div>
      </div>

      {/* KPI cards */}
      {stats && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <KpiCard label={t.logs.kpi.total} value={stats.total} />
          {(["error", "warn", "info", "debug"] as LogLevel[]).map((lvl) => (
            <KpiCard
              key={lvl}
              label={t.logs.kpi[lvl]}
              value={stats.byLevel[lvl] ?? 0}
              tone={lvl}
              onClick={stats.byLevel[lvl] > 0 ? () => clearLevel(lvl) : undefined}
              clickHint={t.logs.clickToClear}
            />
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-1">
          {(["all", "error", "warn", "info", "debug"] as const).map((lvl) => (
            <button
              key={lvl}
              onClick={() => setLevel(lvl)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                level === lvl
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              )}
            >
              {lvl === "all" ? t.logs.levelAll : lvl}
            </button>
          ))}
        </div>

        <div className="h-6 w-px bg-border" />

        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="all">{t.logs.sourceAll}</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <div className="relative ml-auto flex-1 min-w-[200px] max-w-sm">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.logs.searchPlaceholder}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            {loading ? t.logs.loading : t.logs.empty}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <LogItem
                key={r.id}
                row={r}
                open={expanded.has(r.id)}
                onToggle={() => toggleExpand(r.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  tone,
  onClick,
  clickHint,
}: {
  label: string;
  value: number;
  tone?: LogLevel;
  onClick?: () => void;
  clickHint?: string;
}) {
  const classes = tone ? LEVEL_META[tone].classes : "bg-muted text-foreground";
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      title={onClick ? clickHint : undefined}
      className={cn(
        "flex flex-col items-start rounded-lg border border-border p-3 text-left transition-colors",
        onClick ? "hover:bg-accent" : "cursor-default",
        "bg-card"
      )}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="mt-1 flex items-center gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {tone && value > 0 && (
          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase", classes)}>
            {LEVEL_META[tone].label}
          </span>
        )}
      </span>
    </button>
  );
}

function LogItem({
  row,
  open,
  onToggle,
}: {
  row: LogRow;
  open: boolean;
  onToggle: () => void;
}) {
  const meta = LEVEL_META[row.level];
  const Icon = meta.icon;
  const hasDetails = !!(row.context || row.stack);

  return (
    <div>
      <button
        onClick={hasDetails ? onToggle : undefined}
        className={cn(
          "flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors",
          hasDetails ? "hover:bg-accent/50 cursor-pointer" : "cursor-default"
        )}
      >
        {hasDetails ? (
          open ? (
            <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5" />
        )}
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
            meta.classes
          )}
        >
          <Icon className="h-3 w-3" />
          {row.level}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatTime(row.ts)}
        </span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
          {row.source}
        </span>
        <span className="min-w-0 flex-1 break-words">{row.message}</span>
      </button>
      {open && hasDetails && (
        <div className="space-y-2 border-t border-border/50 bg-muted/30 px-3 py-2">
          {row.context !== null && row.context !== undefined && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
                context
              </div>
              <pre className="overflow-x-auto rounded bg-background p-2 text-[11px] leading-snug">
                {typeof row.context === "string"
                  ? row.context
                  : JSON.stringify(row.context, null, 2)}
              </pre>
            </div>
          )}
          {row.stack && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
                stack
              </div>
              <pre className="overflow-x-auto rounded bg-background p-2 text-[11px] leading-snug text-destructive/90">
                {row.stack}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  if (same) return `${hh}:${mm}:${ss}`;
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${m}-${dd} ${hh}:${mm}:${ss}`;
}
