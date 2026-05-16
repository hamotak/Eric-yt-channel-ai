"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Dedicated "Views over time" bar chart that mirrors the visual structure
 * of MultiChannelEarnings's "Combined revenue over time" — bar chart inside
 * a bordered panel with a row of period pills above it.
 *
 * Data comes from the existing /api/analytics/overview endpoint (no new
 * server work). The endpoint returns `overview.daily` with a `views`
 * field per day, scoped to the currently-active channel server-side.
 */
const PERIODS = [
  { value: "7d" as const, label: "7d", subtitle: "Last 7 days" },
  { value: "28d" as const, label: "28d", subtitle: "Last 28 days" },
  { value: "90d" as const, label: "90d", subtitle: "Last 90 days" },
  { value: "365d" as const, label: "365d", subtitle: "Last 365 days" },
];

type Period = (typeof PERIODS)[number]["value"];

type DailyPoint = { date: string; views: number };

type OverviewPayload = {
  overview?: {
    daily?: DailyPoint[];
  };
  connected?: boolean;
};

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function fmtDayLabel(iso: string): string {
  // "2026-05-12" → "May 12". recharts passes the raw value through.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ViewsOverTime() {
  const [period, setPeriod] = useState<Period>("28d");
  const [daily, setDaily] = useState<DailyPoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [notConnected, setNotConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotConnected(false);
    fetch(`/api/analytics/overview?period=${period}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: OverviewPayload) => {
        if (cancelled) return;
        if (d.connected === false) {
          setNotConnected(true);
          setDaily([]);
          return;
        }
        setDaily(d.overview?.daily ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setDaily([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const subtitle = PERIODS.find((p) => p.value === period)?.subtitle ?? "";

  return (
    <Card className="mb-4">
      <CardContent className="p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium">Views over time</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {subtitle}
            </div>
          </div>
          <div className="flex shrink-0 rounded-md border border-border bg-background">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPeriod(p.value)}
                className={cn(
                  "px-2 py-1 text-[11px] font-medium transition-colors",
                  period === p.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {loading && (
          <div className="flex h-44 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {!loading && notConnected && (
          <div className="flex h-44 items-center justify-center text-center text-xs text-muted-foreground">
            Connect Google OAuth in Integrations to see views over time.
          </div>
        )}

        {!loading && !notConnected && (daily?.length ?? 0) === 0 && (
          <div className="flex h-44 items-center justify-center text-center text-xs text-muted-foreground">
            No data for this period yet.
          </div>
        )}

        {!loading && !notConnected && (daily?.length ?? 0) > 0 && (
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={daily ?? []}
                margin={{ top: 4, right: 8, bottom: 0, left: -8 }}
              >
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10 }}
                  tickFormatter={fmtDayLabel}
                  interval="preserveStartEnd"
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v) => fmtCompact(Number(v))}
                  width={50}
                />
                <Tooltip
                  formatter={(v) => [Number(v ?? 0).toLocaleString("en-US"), "Views"]}
                  labelFormatter={fmtDayLabel}
                  contentStyle={{ fontSize: 12 }}
                />
                <Bar dataKey="views" fill="#3b82f6" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
