"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  DollarSign,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ChannelEarnings = {
  channelId: string;
  title: string | null;
  handle: string | null;
  total: number | null;
  latestDay: { date: string; amount: number } | null;
  mtd: number;
  prevMonth?: number;
  prevMonthKey?: string;
  tags: { id: number; name: string; cut_percent: number | null }[];
  totalCutPercent: number;
  cmsName: string | null;
  cmsCutPercent: number | null;
  adsenseName: string | null;
  editorName: string | null;
  monetizationStatus: "monetized" | "pending" | "not_eligible" | null;
  error?: string;
};

type Payload = {
  connected: boolean;
  revenueAccess: "allowed" | "denied" | "unknown";
  period: string;
  channels: ChannelEarnings[];
  totals: {
    period: number;
    latestDay: number;
    mtd: number;
    prevMonth?: number;
    periodNet: number;
    latestDayNet: number;
    mtdNet: number;
    prevMonthNet?: number;
    prevMonthKey?: string;
    prevMonthCoverageStart?: string;
    prevMonthCoverageEnd?: string;
    prevMonthPartial?: boolean;
    excludedChannelIds?: string[];
  };
  combinedDaily: { date: string; total: number }[];
};

/** Render a YYYY-MM key as a human month label, e.g. "April 2026".
 *  Forced to en-US so we don't accidentally show "квітень" / "abril" /
 *  whatever locale the user's browser happens to be set to — the rest
 *  of the UI is English, and Intl.DateTimeFormat with `undefined`
 *  follows the browser locale, which surprised us in production. */
function formatMonthKey(key: string | undefined | null): string {
  if (!key) return "previous month";
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** Render a YYYY-MM-DD as "Apr 3" — used for partial-coverage labels
 *  on the prev-month tile. en-US to keep parity with formatMonthKey. */
function formatShortDay(iso: string | undefined | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type Granularity = "day" | "week" | "month";
type PeriodKey = "28d" | "90d" | "365d" | "all";

const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: "28d", label: "28d" },
  { value: "90d", label: "90d" },
  { value: "365d", label: "1y" },
  { value: "all", label: "All" },
];

/**
 * Dashboard widget that totals revenue across every connected channel.
 * Sits next to (and complements) `<TodaysEarnings>`, which only shows the
 * active channel — this widget is the answer to "how much did *all* my
 * channels make today / this month / this year?".
 *
 * Below the headline tiles + per-channel table is a chart with a
 * granularity toggle (day / week / month). Daily series comes back from
 * the API; weekly and monthly are rolled up client-side so switching
 * granularity is instant and doesn't refetch.
 *
 * Hidden when fewer than 2 channels exist (no point in a "cross-channel"
 * total of one channel) or when revenue access is denied for every one.
 */
export function MultiChannelEarnings() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>("90d");
  const [granularity, setGranularity] = useState<Granularity>("day");
  // Per-channel breakdown defaults to collapsed when there are many
  // channels — 24-row tables push every other widget below the fold.
  // User can click to expand. State is local so it doesn't persist —
  // intentional, since each visit "let me peek at the table" works
  // better with a fresh collapsed default than a sticky one.
  const [tableExpanded, setTableExpanded] = useState(false);

  const load = useCallback(async (p: PeriodKey) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/analytics/revenue-multi?period=${p}`, {
        cache: "no-store",
      });
      const d = (await res.json()) as Payload;
      setData(d);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [load, period]);

  // Roll the daily series up to weekly / monthly buckets when the user
  // toggles granularity. Memoised so we don't rebuild on every render.
  const chartData = useMemo(() => {
    if (!data?.combinedDaily) return [];
    if (granularity === "day") {
      return data.combinedDaily.map((d) => ({
        bucket: d.date,
        total: d.total,
      }));
    }
    if (granularity === "month") {
      const map = new Map<string, number>();
      for (const d of data.combinedDaily) {
        // YYYY-MM prefix is enough for month grouping.
        const key = d.date.slice(0, 7);
        map.set(key, (map.get(key) ?? 0) + d.total);
      }
      return [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([bucket, total]) => ({ bucket, total: Number(total.toFixed(2)) }));
    }
    // week — group by ISO week starting Monday. Cheap implementation:
    // shift each date back to Monday's YYYY-MM-DD and accumulate.
    const map = new Map<string, number>();
    for (const d of data.combinedDaily) {
      const dt = new Date(d.date + "T00:00:00Z");
      const day = dt.getUTCDay(); // 0 = Sun, 1 = Mon, ...
      const offset = day === 0 ? -6 : 1 - day; // shift back to Monday
      const monday = new Date(dt.getTime() + offset * 86400_000);
      const key = monday.toISOString().slice(0, 10);
      map.set(key, (map.get(key) ?? 0) + d.total);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, total]) => ({ bucket, total: Number(total.toFixed(2)) }));
  }, [data, granularity]);

  if (!data) {
    return null; // initial render — let single-channel widget show first
  }
  if (!data.connected || data.revenueAccess === "denied") return null;
  if (data.channels.length < 2) return null;

  const succeeded = data.channels.filter((c) => c.total !== null);
  const failed = data.channels.filter((c) => c.total === null);
  const periodLabel =
    PERIOD_OPTIONS.find((p) => p.value === period)?.label ?? period;

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <DollarSign className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            All channels — earnings
          </CardTitle>
          <CardDescription>
            Combined revenue across {data.channels.length} connected channels.
          </CardDescription>
        </div>
        <div className="flex items-center gap-1">
          {/* Period selector */}
          <div className="flex rounded-md border border-border bg-background">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                disabled={loading}
                className={cn(
                  "px-2 py-1 text-[11px] font-medium transition-colors",
                  period === opt.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => load(period)}
            disabled={loading}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Silent-exclude warning: any channel whose row returned
            total === null was dropped from the headline totals (e.g. a
            transient OAuth 401, monetary access denied, etc.). Without
            this banner the user sees a number that looks complete but
            silently misses one or more channels. */}
        {(() => {
          const excluded = data.channels.filter((c) => c.total === null);
          if (excluded.length === 0) return null;
          const names = excluded
            .map((c) => c.title ?? c.handle ?? c.channelId)
            .join(", ");
          return (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <span className="font-medium">
                {excluded.length} channel{excluded.length === 1 ? "" : "s"} excluded from totals:
              </span>
              <span className="min-w-0 flex-1 truncate">{names}</span>
              <button
                onClick={() => load(period)}
                disabled={loading}
                className="font-medium underline-offset-2 hover:underline disabled:opacity-50"
              >
                Re-fetch
              </button>
            </div>
          );
        })()}

        {/* Top-line totals — show both gross (always) and net-after-CMS
            (only when at least one channel has a non-zero CMS cut, so
            we don't visually crowd the dashboard for users without
            networks). */}
        {(() => {
          // Decide whether to show MTD or fall back to previous-month
          // total. YouTube Analytics has a 1-3 day lag, so on the 1st-2nd
          // of a new month the MTD figure is genuinely $0 — that's not
          // useful, the user wants to see *something*. When MTD is empty
          // and we have prev-month data, swap the tile to show that
          // instead, with an explicit label so it's not mistaken for
          // current-month progress.
          const mtd = data.totals.mtd;
          const mtdNet = data.totals.mtdNet;
          const prevMonth = data.totals.prevMonth ?? 0;
          const prevMonthNet = data.totals.prevMonthNet ?? 0;
          const prevMonthKey = data.totals.prevMonthKey;
          const useFallback = mtd < 0.01 && prevMonth > 0;
          const monthValue = useFallback ? prevMonth : mtd;
          const monthNetValue = useFallback ? prevMonthNet : mtdNet;
          const prevMonthLabel = formatMonthKey(prevMonthKey);
          const partial = !!data.totals.prevMonthPartial;
          const coverageStart = data.totals.prevMonthCoverageStart;
          const coverageEnd = data.totals.prevMonthCoverageEnd;
          // When partial (selected period didn't reach back to the 1st
          // of the prev month), label the tile with the actual range it
          // covers — e.g. "Apr 3-30 total" — instead of pretending it's
          // the full month. Switch to 90d/1y/All to get the true full
          // month figure.
          const monthBaseLabel = useFallback
            ? partial && coverageStart && coverageEnd
              ? `${formatShortDay(coverageStart)} – ${formatShortDay(
                  coverageEnd
                )} total`
              : `${prevMonthLabel} total`
            : "Month-to-date";
          const showNet =
            data.totals.periodNet < data.totals.period - 0.01;

          if (showNet) {
            return (
              <div className="space-y-2">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <SummaryTile
                    label="Latest day (gross)"
                    value={data.totals.latestDay}
                    sublabel={`net $${data.totals.latestDayNet.toFixed(2)}`}
                  />
                  <SummaryTile
                    label={`${monthBaseLabel} (gross)`}
                    value={monthValue}
                    sublabel={`net $${monthNetValue.toFixed(2)}`}
                    highlight
                  />
                  <SummaryTile
                    label={`Total ${periodLabel} (gross)`}
                    value={data.totals.period}
                    sublabel={`net $${data.totals.periodNet.toFixed(2)}`}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Net = gross − each channel&apos;s CMS / network cut (set in
                  the Edit panel on /integrations).
                  {useFallback && (
                    <>
                      {" "}
                      Showing {prevMonthLabel}{" "}
                      {partial ? "(partial coverage)" : "total"} because
                      YouTube Analytics hasn&apos;t reported any days in
                      the current month yet (typical 1-3 day data lag).
                      {partial && (
                        <>
                          {" "}
                          The selected period only reaches back to{" "}
                          {formatShortDay(coverageStart)} — switch to
                          90d / 1y / All for the full month figure.
                        </>
                      )}
                    </>
                  )}
                </p>
              </div>
            );
          }
          return (
            <div className="space-y-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <SummaryTile
                  label="Latest day (combined)"
                  value={data.totals.latestDay}
                />
                <SummaryTile
                  label={monthBaseLabel}
                  value={monthValue}
                  highlight
                />
                <SummaryTile
                  label={`Total (${periodLabel})`}
                  value={data.totals.period}
                />
              </div>
              {useFallback && (
                <p className="text-[10px] text-muted-foreground">
                  Showing {prevMonthLabel}{" "}
                  {partial ? "(partial coverage)" : "total"} because
                  YouTube Analytics hasn&apos;t reported any days in the
                  current month yet (typical 1-3 day data lag).
                  {partial && (
                    <>
                      {" "}
                      The selected period only reaches back to{" "}
                      {formatShortDay(coverageStart)} — switch to 90d /
                      1y / All for the full month figure.
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })()}

        {/* Trend chart with granularity toggle */}
        {chartData.length > 0 && (
          <div className="rounded-md border bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase text-muted-foreground">
                Combined revenue over time
              </div>
              <div className="flex rounded-md border border-border bg-background">
                {(["day", "week", "month"] as Granularity[]).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGranularity(g)}
                    className={cn(
                      "px-2 py-0.5 text-[11px] font-medium capitalize transition-colors",
                      granularity === g
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent"
                    )}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="bucket"
                    tick={{ fontSize: 10 }}
                    tickFormatter={formatBucketLabel(granularity)}
                    interval="preserveStartEnd"
                    minTickGap={40}
                  />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(0)}`}
                    width={50}
                  />
                  <Tooltip
                    formatter={(v) => [`$${Number(v ?? 0).toFixed(2)}`, "Revenue"]}
                    labelFormatter={(label) =>
                      formatBucketTooltip(granularity)(String(label ?? ""))
                    }
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Bar dataKey="total" fill="#10b981" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Per-channel breakdown — collapsible. With 5+ channels the
            table dominates the dashboard; let users opt in. */}
        <button
          onClick={() => setTableExpanded((v) => !v)}
          className="flex w-full items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-xs font-medium hover:bg-accent"
          aria-expanded={tableExpanded}
        >
          <span>
            Per-channel breakdown ({data.channels.length}{" "}
            {data.channels.length === 1 ? "channel" : "channels"})
          </span>
          {tableExpanded ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>

        {tableExpanded && (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Channel</th>
                <th className="px-3 py-2 text-right font-medium">Latest day</th>
                <th className="px-3 py-2 text-right font-medium">MTD</th>
                <th className="px-3 py-2 text-right font-medium">{periodLabel}</th>
                <th className="px-3 py-2 text-right font-medium">Net {periodLabel}</th>
              </tr>
            </thead>
            <tbody>
              {succeeded.map((c) => {
                const cut = c.totalCutPercent ?? 0;
                const keep = cut > 0 ? Math.max(0, 1 - cut / 100) : 1;
                const net = (c.total ?? 0) * keep;
                const cutTags = (c.tags ?? []).filter(
                  (t) => typeof t.cut_percent === "number" && t.cut_percent > 0
                );
                return (
                  <tr key={c.channelId} className="border-t">
                    <td className="px-3 py-2">
                      <div className="font-medium">{c.title ?? "Untitled"}</div>
                      {c.handle ? (
                        <div className="text-xs text-muted-foreground">{c.handle}</div>
                      ) : null}
                      {/* Tags + status / editor chips */}
                      {((c.tags && c.tags.length > 0) ||
                        c.editorName ||
                        c.monetizationStatus === "pending") && (
                        <div className="mt-0.5 flex flex-wrap items-center gap-1">
                          {(c.tags ?? []).map((t) => (
                            <span
                              key={t.id}
                              className="rounded bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary"
                            >
                              {t.name}
                              {typeof t.cut_percent === "number" && t.cut_percent > 0 &&
                                ` −${t.cut_percent}%`}
                            </span>
                          ))}
                          {c.editorName && (
                            <span className="rounded bg-rose-500/15 px-1 py-0.5 text-[9px] font-medium text-rose-700 dark:text-rose-400">
                              {c.editorName}
                            </span>
                          )}
                          {c.monetizationStatus === "pending" && (
                            <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-400">
                              YPP pending
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.latestDay ? `$${c.latestDay.amount.toFixed(2)}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      ${c.mtd.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.total !== null ? `$${c.total.toFixed(2)}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.total !== null && cut > 0 ? (
                        <span title={`After cuts: ${cutTags.map((t) => `${t.name} −${t.cut_percent}%`).join(", ")}`}>
                          ${net.toFixed(2)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
              {failed.map((c) => (
                <tr key={c.channelId} className="border-t bg-muted/20">
                  <td className="px-3 py-2">
                    <div className="font-medium">{c.title ?? "Untitled"}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.error ?? "no data"}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground" colSpan={4}>
                    —
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Refreshing per-channel revenue…
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Bucket label for X-axis ticks. Shorter than the tooltip variant. */
function formatBucketLabel(g: Granularity): (raw: string) => string {
  if (g === "month") return (raw) => raw; // YYYY-MM is fine
  if (g === "week") {
    return (raw) => {
      // raw is the Monday YYYY-MM-DD; show MM-DD
      return raw.slice(5);
    };
  }
  return (raw) => raw.slice(5); // day → MM-DD
}

/** Verbose label shown in the chart's hover tooltip. */
function formatBucketTooltip(g: Granularity): (raw: string) => string {
  if (g === "month") {
    return (raw) => {
      const [y, m] = raw.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
        month: "long",
        year: "numeric",
      });
    };
  }
  if (g === "week") {
    return (raw) => `Week of ${raw}`;
  }
  return (raw) => raw;
}

function SummaryTile({
  label,
  value,
  sublabel,
  highlight = false,
}: {
  label: string;
  value: number;
  sublabel?: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 text-2xl font-bold tabular-nums",
          highlight && "text-emerald-700 dark:text-emerald-400"
        )}
      >
        ${value.toFixed(2)}
      </div>
      {sublabel && (
        <div className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
          {sublabel}
        </div>
      )}
    </div>
  );
}
