"use client";

import { useState } from "react";
import {
  Calendar,
  ChevronDown,
  ChevronUp,
  FileText,
  Hash,
  Languages,
  Type,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * Reusable per-channel widgets that used to live on /channel/page.tsx.
 * After Prompt 4.8 the /channel route is gone and Channel Info hosts
 * these instead — but the rendering is identical to the old page.
 *
 * The Analytics shape is the subset of /api/channel's analytics block
 * that these widgets actually read. Other parts of the bigger Analytics
 * type (cadence, patterns, content mix, growth, performance, core) are
 * intentionally NOT defined here because the widgets that read them
 * were removed in Prompt 4.8 Change 4.
 */
export type ChannelDetailAnalytics = {
  transcripts: {
    total: number;
    withTranscript: number;
    coveragePct: number;
    avgChars: number;
    languages: { lang: string; count: number }[];
  };
  themes: {
    topTags: { tag: string; count: number }[];
    topTitleWords: { word: string; count: number }[];
    avgTitleLength: number;
  };
};

export type ChannelDetailChannel = {
  id: string;
  title: string | null;
  handle: string | null;
  description: string | null;
  imported_at: number;
};

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  } catch {
    return "—";
  }
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return "—";
  return `${n.toFixed(digits)}%`;
}

export function AboutCard({ channel }: { channel: ChannelDetailChannel }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const description = channel.description ?? "";
  const isLong = description.length > 300;
  const shown = expanded || !isLong ? description : description.slice(0, 300) + "…";
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">{t.channel.aboutTitle}</CardTitle>
        <CardDescription>{t.channel.aboutDesc}</CardDescription>
      </CardHeader>
      <CardContent>
        {description ? (
          <>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {shown}
            </p>
            {isLong && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 h-7 gap-1 px-2 text-xs"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? (
                  <>
                    <ChevronUp className="h-3 w-3" />
                    {t.channel.showLess}
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3" />
                    {t.channel.showMore}
                  </>
                )}
              </Button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t.channel.noDescription}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function MetaCard({ channel }: { channel: ChannelDetailChannel }) {
  const { t } = useI18n();
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">{t.channel.metaTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <MetaRow label={t.channel.channelId} value={channel.id} mono />
        {channel.handle && (
          <MetaRow
            label={t.channel.handleLabel}
            value={
              channel.handle.startsWith("@") ? channel.handle : "@" + channel.handle
            }
          />
        )}
        <MetaRow
          label={t.channel.importedAt}
          value={fmtDate(channel.imported_at)}
          icon={Calendar}
        />
      </CardContent>
    </Card>
  );
}

export function ThemesCard({
  analytics,
}: {
  analytics: ChannelDetailAnalytics;
}) {
  const { t } = useI18n();
  const th = analytics.themes;
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Hash className="h-4 w-4 text-primary" />
          {t.channel.themesTitle}
        </CardTitle>
        <CardDescription>{t.channel.themesDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Hash className="h-3 w-3" />
            <span className="font-medium text-foreground">{t.channel.topTags}</span>
          </div>
          {th.topTags.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.channel.noTags}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {th.topTags.map((tag) => (
                <span
                  key={tag.tag}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  <span>{tag.tag}</span>
                  <span className="rounded bg-primary/20 px-1 text-[10px] font-mono tabular-nums">
                    {tag.count}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Type className="h-3 w-3" />
            <span className="font-medium text-foreground">
              {t.channel.topTitleWords}
            </span>
            <span className="ml-auto text-muted-foreground">
              {t.channel.avgTitleLen}: {th.avgTitleLength} {t.channel.charsShort}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {th.topTitleWords.map((w, i) => {
              const weight = Math.max(
                0.7,
                Math.min(
                  1.8,
                  (w.count / (th.topTitleWords[0]?.count || 1)) * 1.4
                )
              );
              return (
                <span
                  key={w.word + i}
                  className="rounded-full bg-muted px-2 py-0.5 font-mono"
                  style={{ fontSize: `${0.7 * weight}rem` }}
                >
                  {w.word}
                  <span className="ml-1 text-muted-foreground text-[10px]">
                    {w.count}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function TranscriptsCoverageCard({
  analytics,
}: {
  analytics: ChannelDetailAnalytics;
}) {
  const { t } = useI18n();
  const tr = analytics.transcripts;
  const pct = tr.coveragePct;
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4 text-primary" />
          {t.channel.transcriptsCoverageTitle}
        </CardTitle>
        <CardDescription>{t.channel.transcriptsCoverageDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-sm">
              <span className="font-semibold tabular-nums">
                {tr.withTranscript}
              </span>
              <span className="text-muted-foreground"> / {tr.total}</span>
            </span>
            <span className="text-sm font-semibold tabular-nums">{fmtPct(pct)}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full transition-all",
                pct >= 80
                  ? "bg-green-500"
                  : pct >= 40
                    ? "bg-amber-500"
                    : "bg-primary/60"
              )}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MiniStat
            icon={Type}
            label={t.channel.avgTranscriptLen}
            value={`${fmt(tr.avgChars)} ${t.channel.charsShort}`}
          />
          <MiniStat
            icon={Languages}
            label={t.channel.languagesLabel}
            value={String(tr.languages.length)}
          />
        </div>
        {tr.languages.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tr.languages.map((l) => (
              <span
                key={l.lang}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
              >
                <span className="font-mono">{l.lang}</span>
                <span className="rounded bg-primary/20 px-1 text-[10px] font-mono tabular-nums">
                  {l.count}
                </span>
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------- Shared primitives ---------------- */

function MetaRow({
  label,
  value,
  mono,
  icon: Icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </span>
      <span
        className={
          "min-w-0 flex-1 truncate text-right" +
          (mono ? " font-mono text-xs" : "")
        }
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      <div className="mt-1 text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}
