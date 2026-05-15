"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Banknote,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
// Pencil + X used by the new card-level Edit button; Loader2 used by
// the inline save spinner.
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Month = {
  month: string;
  videoCount: number;
  rateUsd: number;
  amountUsd: number;
  videos: { id: string; title: string; published_at: number }[];
};

type EditorAggregate = {
  editorName: string | null;
  totalAmount: number;
  videoCount: number;
  channelCount: number;
  forecastMonthly: number;
  forecastVideoCount: number;
  channels: {
    id: string;
    title: string | null;
    videoCount: number;
    amount: number;
    expectedVideos: number;
    forecastAmount: number;
  }[];
};

type Payload = {
  rateUsd: number;
  editorName: string | null;
  expectedVideos: number;
  currentMonth: string;
  months: Month[];
  channelId: string | null;
  byEditor: EditorAggregate[];
  totalForecastMonthly: number;
};

function fmtMonthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}

/** Editor billing card — answers "how much do I owe my editor this month?".
 *  Rate is configurable inline, monthly history pulled from `videos` aggregated
 *  by upload date. Designed as a Dashboard widget so the number is visible
 *  without clicking through. */
export function EditorBillingCard() {
  const [data, setData] = useState<Payload | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editorDraft, setEditorDraft] = useState("");
  const [expectedDraft, setExpectedDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showByEditor, setShowByEditor] = useState(true);
  // "Refresh from YouTube" state — runs a lightweight sync across every
  // connected channel so this-month video counts catch up with reality.
  // Without this, the count column only reflects videos that happened
  // to be in the local DB at last sync, which is days/weeks stale by
  // the time editor payday rolls around.
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    totalAdded: number;
    failed: number;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/editor-billing");
      const d = (await res.json()) as Payload;
      setData(d);
      setDraft(String(d.rateUsd));
      setEditorDraft(d.editorName ?? "");
      setExpectedDraft(d.expectedVideos > 0 ? String(d.expectedVideos) : "");
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0) return;
    const expectedN = expectedDraft.trim() === "" ? 0 : Number(expectedDraft);
    if (
      expectedDraft.trim() !== "" &&
      (!Number.isFinite(expectedN) || expectedN < 0 || expectedN > 1000)
    ) {
      return;
    }
    setSaving(true);
    try {
      await fetch("/api/editor-billing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rateUsd: n,
          editorName: editorDraft.trim() || null,
          expectedVideos: expectedN > 0 ? expectedN : null,
        }),
      });
      setEditing(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  /**
   * Refresh the local video DB with whatever the editors have uploaded
   * since last sync. Hits /api/youtube/sync-recent which pulls the
   * last 50 ids per channel, fetches details only for the new ones,
   * upserts. ~90 YouTube Data API units for 30 channels. After it
   * finishes we re-fetch the billing payload so the count column
   * reflects reality.
   */
  const syncFromYouTube = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/youtube/sync-recent", { method: "POST" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        alert(j.error ?? `Sync failed (HTTP ${res.status})`);
        return;
      }
      const data = (await res.json()) as {
        totalAdded: number;
        failed: number;
      };
      setSyncResult(data);
      await load();
    } finally {
      setSyncing(false);
    }
  };

  if (!data) return null;

  const current = data.months.find((m) => m.month === data.currentMonth) ?? {
    month: data.currentMonth,
    videoCount: 0,
    rateUsd: data.rateUsd,
    amountUsd: 0,
    videos: [],
  };
  const history = data.months.filter((m) => m.month !== data.currentMonth);

  // Days remaining in current month (UTC). Pure cosmetic — gives the
  // creator an "X days until payday" hint.
  const now = new Date();
  const lastDayOfMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
  );
  const daysUntilPayday = Math.max(
    1,
    Math.ceil((lastDayOfMonth.getTime() - now.getTime()) / 86400_000) + 1
  );

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Banknote className="h-4 w-4 text-green-600 dark:text-green-400" />
            Editor billing
          </CardTitle>
          <CardDescription>
            Tracks uploads × your rate per video. Pay your editor on the 1st.
          </CardDescription>
        </div>
        {/* Card-level Edit button — single entry point that puts both
            the rate input and the editor-name input into edit mode.
            Cleaner than two separate pencils per the user's feedback
            "блять, воно якось трохи складно працює". */}
        {!editing ? (
          <div className="flex items-center gap-2">
            {/* Refresh button pulls the latest 50 uploads per channel
                from YouTube so video counts here reflect reality —
                without it the counts only show videos that happened to
                be in the local DB at the last manual /integrations
                sync, which is days/weeks stale by the time editor
                payday rolls around. Hits a lightweight endpoint that
                only fetches details for IDs we don't already have. */}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={syncFromYouTube}
              disabled={syncing}
              className="gap-1.5"
              title="Pull the latest uploads from every connected channel so this-month video counts catch up with reality"
            >
              {syncing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {syncing ? "Syncing…" : "Sync uploads"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
              className="gap-1.5"
            >
              <Pencil className="h-3 w-3" /> Edit
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setDraft(String(data.rateUsd));
                setEditorDraft(data.editorName ?? "");
                setExpectedDraft(
                  data.expectedVideos > 0 ? String(data.expectedVideos) : ""
                );
              }}
              disabled={saving}
            >
              <X className="h-3 w-3" /> Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={save}
              disabled={saving}
              className="gap-1"
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              Save
            </Button>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Sync result toast — shows after Sync uploads finishes, until
            the user clicks the X. Carries the "added 8 new videos" /
            "all channels up to date" / "3 channels failed" payload so
            the user knows whether the counts below are now fresh. */}
        {syncResult && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-md border p-2 text-xs",
              syncResult.failed > 0
                ? "border-amber-500/40 bg-amber-500/10"
                : "border-green-500/40 bg-green-500/10"
            )}
          >
            <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="flex-1">
              {syncResult.totalAdded > 0
                ? `Synced ${syncResult.totalAdded} new video${syncResult.totalAdded === 1 ? "" : "s"} across all connected channels. Counts below should now be up to date.`
                : "All channels are already up to date — no new videos since last sync."}
              {syncResult.failed > 0 && (
                <span className="ml-1 text-amber-700 dark:text-amber-400">
                  ({syncResult.failed} channel{syncResult.failed === 1 ? "" : "s"} failed — check /logs)
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSyncResult(null)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Headline: this month */}
        <div className="rounded-lg border bg-card p-4">
          <div className="text-[11px] text-muted-foreground uppercase">
            {fmtMonthLabel(current.month)} (so far)
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums text-green-700 dark:text-green-400">
              ${current.amountUsd.toFixed(2)}
            </span>
            <span className="text-sm text-muted-foreground">
              due in {daysUntilPayday}d
            </span>
          </div>

          {/* Two editable rows: rate per video + editor name. When
              the card is in edit mode (the [Edit] button up top
              flipped them on), both render as inputs side-by-side. */}
          <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Rate / video:</span>
              {editing ? (
                <span className="inline-flex items-center gap-1">
                  <span>$</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.5"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") save();
                    }}
                    className="inline-block h-7 w-20 px-1.5 py-0 text-xs"
                    autoFocus
                  />
                </span>
              ) : (
                <span
                  className={cn(
                    "font-medium",
                    data.rateUsd === 0 && "italic text-muted-foreground"
                  )}
                >
                  {data.rateUsd === 0
                    ? "not set"
                    : `$${data.rateUsd.toFixed(2)}`}
                </span>
              )}
              <span className="text-muted-foreground">
                · {current.videoCount} video
                {current.videoCount === 1 ? "" : "s"} this month
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Editor:</span>
              {editing ? (
                <Input
                  value={editorDraft}
                  onChange={(e) => setEditorDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                  }}
                  placeholder="e.g. John Doe"
                  className="inline-block h-7 flex-1 px-1.5 py-0 text-xs"
                />
              ) : data.editorName ? (
                <span className="font-medium">{data.editorName}</span>
              ) : (
                <span className="italic text-muted-foreground">
                  unassigned
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Expected:</span>
              {editing ? (
                <span className="inline-flex items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    value={expectedDraft}
                    onChange={(e) => setExpectedDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") save();
                    }}
                    placeholder="e.g. 8"
                    className="inline-block h-7 w-20 px-1.5 py-0 text-xs"
                  />
                  <span className="text-muted-foreground">videos / month</span>
                </span>
              ) : data.expectedVideos > 0 ? (
                <span className="font-medium">
                  {data.expectedVideos} videos / month
                </span>
              ) : (
                <span className="italic text-muted-foreground">
                  not set
                </span>
              )}
            </div>

            {/* Forecast: rate × expected for THIS channel. Only useful
                when both values are set; otherwise we'd be multiplying
                by zero and showing $0.00. */}
            {data.rateUsd > 0 && data.expectedVideos > 0 && !editing && (
              <div className="flex items-center gap-2 sm:col-span-2">
                <span className="text-muted-foreground">Forecast:</span>
                <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                  ${(data.rateUsd * data.expectedVideos).toFixed(2)} /month
                </span>
                <span className="text-[10px] text-muted-foreground">
                  ({data.expectedVideos} × ${data.rateUsd.toFixed(2)})
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Total monthly editor-cost forecast across every channel.
            Hidden when no channel has expectedVideos set — there'd be
            nothing to forecast. */}
        {data.totalForecastMonthly > 0 && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-50/30 p-3 dark:bg-emerald-900/10">
            <div className="flex items-baseline justify-between gap-2">
              <div>
                <div className="text-[11px] uppercase text-muted-foreground">
                  Total monthly forecast (all channels)
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Sum of (expected videos × rate) across every channel.
                </div>
              </div>
              <span className="text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                ${data.totalForecastMonthly.toFixed(2)}
              </span>
            </div>
          </div>
        )}

        {/* Cross-channel by-editor view: who you're paying this month
            and how much, summed across every connected channel. The
            big-picture answer to "what do I owe in total this month
            and to whom?". Hidden when there's only one entry (no
            grouping value). */}
        {data.byEditor.length > 1 && (
          <div>
            <button
              onClick={() => setShowByEditor((v) => !v)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent"
            >
              {showByEditor ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              <span>
                {showByEditor ? "Hide" : "Show"} payouts by editor across all
                channels ({data.byEditor.length})
              </span>
            </button>
            {showByEditor && (
              <div className="mt-2 space-y-1.5">
                {data.byEditor.map((row, idx) => {
                  const label =
                    row.editorName ?? "Unassigned (set editor name to track)";
                  return (
                    <details
                      key={idx}
                      className="rounded-md border bg-card"
                    >
                      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs">
                        <span
                          className={cn(
                            "font-medium",
                            !row.editorName && "italic text-muted-foreground"
                          )}
                        >
                          {label}
                          <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                            {row.channelCount}{" "}
                            {row.channelCount === 1 ? "channel" : "channels"} ·{" "}
                            {row.videoCount} video
                            {row.videoCount === 1 ? "" : "s"}
                          </span>
                        </span>
                        <span className="flex flex-col items-end">
                          <span className="font-semibold tabular-nums text-green-700 dark:text-green-400">
                            ${row.totalAmount.toFixed(2)}
                          </span>
                          {row.forecastMonthly > 0 && (
                            <span className="text-[10px] tabular-nums text-emerald-600 dark:text-emerald-500">
                              forecast ${row.forecastMonthly.toFixed(2)}/mo
                            </span>
                          )}
                        </span>
                      </summary>
                      <div className="border-t border-border px-3 py-2 text-[11px]">
                        {row.channels.length === 0 ? (
                          <span className="text-muted-foreground">No channels</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {row.channels.map((c) => (
                              <li
                                key={c.id}
                                className="flex items-center justify-between gap-2"
                              >
                                <span className="truncate">
                                  {c.title ?? c.id}
                                </span>
                                <span className="shrink-0 text-muted-foreground tabular-nums">
                                  {c.videoCount} ×{" "}
                                  {c.videoCount > 0
                                    ? `$${(c.amount / Math.max(1, c.videoCount)).toFixed(2)}`
                                    : "$0.00"}{" "}
                                  ={" "}
                                  <span className="font-medium text-foreground">
                                    ${c.amount.toFixed(2)}
                                  </span>
                                  {c.expectedVideos > 0 && (
                                    <span className="ml-2 text-emerald-600 dark:text-emerald-500">
                                      (forecast: {c.expectedVideos} ×{" "}
                                      $
                                      {c.expectedVideos > 0
                                        ? (c.forecastAmount / c.expectedVideos).toFixed(2)
                                        : "0.00"}{" "}
                                      = ${c.forecastAmount.toFixed(2)})
                                    </span>
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Toggle history */}
        {history.length > 0 && (
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            {showHistory ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            <span>
              {showHistory ? "Hide" : "Show"} previous months ({history.length})
            </span>
          </button>
        )}

        {showHistory && (
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Month</th>
                  <th className="px-3 py-2 text-right font-medium">Videos</th>
                  <th className="px-3 py-2 text-right font-medium">Rate</th>
                  <th className="px-3 py-2 text-right font-medium">Owed</th>
                </tr>
              </thead>
              <tbody>
                {history.map((m) => (
                  <tr key={m.month} className="border-t border-border">
                    <td className="px-3 py-2">{fmtMonthLabel(m.month)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {m.videoCount}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      ${m.rateUsd.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      ${m.amountUsd.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// (RateInline removed — superseded by the card-level [Edit] button.)
