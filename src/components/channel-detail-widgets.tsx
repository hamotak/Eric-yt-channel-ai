"use client";

import { useState } from "react";
import { Calendar, ChevronDown, ChevronUp } from "lucide-react";
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

