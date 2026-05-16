"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type FieldKey =
  | "niche"
  | "positioning"
  | "audience"
  | "voice"
  | "externalSources";

type ChannelContext = {
  id: string;
  channelId: string;
  title: string | null;
  handle: string | null;
  subscriberCount: number | null;
  niche: string;
  positioning: string;
  audience: string;
  voice: string;
  externalSources: string;
};

type FieldDef = {
  key: FieldKey;
  label: string;
  description: string;
  placeholder: string;
  multiline: boolean;
};

const FIELDS: FieldDef[] = [
  {
    key: "niche",
    label: "Niche",
    description:
      "One line — what this channel is about, in 5–15 words.",
    placeholder:
      "e.g. Cinematic sleep stories about the cosmos and deep space.",
    multiline: false,
  },
  {
    key: "positioning",
    label: "Positioning",
    description:
      "What makes this channel different from competitors in the same niche.",
    placeholder:
      "e.g. Slow narration, no music spikes, all original astronomy facts.",
    multiline: true,
  },
  {
    key: "audience",
    label: "Audience",
    description: "Who watches this channel and why.",
    placeholder:
      "e.g. Insomniacs aged 25–45 who like science. Want to learn while drifting off.",
    multiline: true,
  },
  {
    key: "voice",
    label: "Voice",
    description: "Tone, pacing, signature stylistic elements.",
    placeholder:
      "e.g. Calm, measured, no hype words, no emojis, no AI-cliché phrases.",
    multiline: true,
  },
  {
    key: "externalSources",
    label: "External sources",
    description:
      "Off-YouTube sources the AI should reference during ideation. One per line.",
    placeholder:
      "r/Space\nr/AskAstronomy\nNASA mission archives\nScientific American",
    multiline: true,
  },
];

export default function MyChannelsPage() {
  const [channels, setChannels] = useState<ChannelContext[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/my-channels", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { channels?: ChannelContext[] }) => {
        if (cancelled) return;
        setChannels(d.channels ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Could not load channels.");
        setChannels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUpdated = (next: ChannelContext) => {
    setChannels((prev) =>
      prev ? prev.map((c) => (c.channelId === next.channelId ? next : c)) : prev
    );
  };

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">My Channels</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Channel context. Every AI feature reads from this.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {channels === null ? (
        <SkeletonList />
      ) : channels.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-4">
          {channels.map((c) => (
            <ChannelCard
              key={c.channelId}
              channel={c}
              onUpdated={handleUpdated}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelCard({
  channel,
  onUpdated,
}: {
  channel: ChannelContext;
  onUpdated: (next: ChannelContext) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          {channel.title ?? channel.channelId}
        </CardTitle>
        <CardDescription>
          {channel.handle ? (
            <span className="font-mono">{channel.handle}</span>
          ) : (
            <span className="text-muted-foreground/70">No handle</span>
          )}
          {channel.subscriberCount !== null &&
            channel.subscriberCount !== undefined && (
              <>
                <span className="mx-2 text-muted-foreground/50">·</span>
                <span>
                  {channel.subscriberCount.toLocaleString()} subscribers
                </span>
              </>
            )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {FIELDS.map((field) => (
          <ContextField
            key={field.key}
            channelId={channel.channelId}
            field={field}
            value={channel[field.key]}
            onUpdated={onUpdated}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function ContextField({
  channelId,
  field,
  value,
  onUpdated,
}: {
  channelId: string;
  field: FieldDef;
  value: string;
  onUpdated: (next: ChannelContext) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const startEdit = () => {
    setDraft(value);
    setSaveError(null);
    setEditing(true);
  };

  const cancel = () => {
    if (saving) return;
    setEditing(false);
    setSaveError(null);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch("/api/my-channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, field: field.key, value: draft }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        channel?: ChannelContext;
        error?: string;
      };
      if (!r.ok || !d.channel) {
        setSaveError(d.error ?? "Save failed.");
        return;
      }
      onUpdated(d.channel);
      setEditing(false);
    } catch {
      setSaveError("Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{field.label}</div>
          <div className="text-xs text-muted-foreground">
            {field.description}
          </div>
        </div>
        {!editing && (
          <Button
            variant="ghost"
            size="icon"
            onClick={startEdit}
            aria-label={`Edit ${field.label}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            placeholder={field.placeholder}
            rows={field.key === "externalSources" ? 6 : field.multiline ? 4 : 2}
            className={cn(
              "w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
              "focus:outline-none focus:ring-2 focus:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          />
          {saveError && (
            <div className="text-xs text-destructive">{saveError}</div>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              <Check className="mr-1 h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={cancel}
              disabled={saving}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <ReadValue value={value} field={field} />
      )}
    </div>
  );
}

function ReadValue({ value, field }: { value: string; field: FieldDef }) {
  if (value.length === 0) {
    return (
      <div className="text-sm italic text-muted-foreground/70">
        Empty — click the pencil to add.
      </div>
    );
  }
  if (field.key === "externalSources") {
    const lines = value.split("\n").filter((l) => l.trim().length > 0);
    return (
      <ul className="space-y-1 text-sm">
        {lines.map((line, i) => (
          <li key={i} className="font-mono text-xs text-foreground/90">
            {line}
          </li>
        ))}
      </ul>
    );
  }
  return <div className="whitespace-pre-wrap text-sm">{value}</div>;
}

function SkeletonList() {
  return (
    <div className="space-y-4">
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <CardHeader>
            <div className="h-5 w-40 animate-pulse rounded bg-muted" />
            <div className="mt-2 h-3 w-24 animate-pulse rounded bg-muted" />
          </CardHeader>
          <CardContent className="space-y-3">
            {[0, 1, 2, 3, 4].map((j) => (
              <div key={j} className="h-8 animate-pulse rounded bg-muted/60" />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-sm text-muted-foreground">
          No channels yet. Add your first YouTube channel on the{" "}
          <Link
            href="/integrations"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Integrations page
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}
