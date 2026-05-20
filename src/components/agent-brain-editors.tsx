"use client";

/**
 * Shared editors for the agent's "brain" — the per-channel description
 * and ideation rules. Both render on:
 *   - /channel-info (the primary editing surface)
 *   - /chat → Brain panel (inline editing without leaving the chat)
 *
 * Both editors hit PATCH /api/channel-info { channelId, field, value }
 * where field ∈ "channelDescription" | "ideationRules". Saves trigger
 * an `onSaved` callback so the parent can show a toast.
 *
 * Memory was removed in the post-c63a3b9 cleanup — description +
 * ideation_rules cover every durable-agent-state case HAmo needs.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DESCRIPTION_CAP = 1500;
const IDEATION_RULES_CAP = 1200;
const BANNED_TOPICS_CAP = 500;

// ---------------------------------------------------------------------
// Channel description — one big textarea + live counter
// ---------------------------------------------------------------------

export function DescriptionEditor({
  channelId,
  initialValue,
  onSaved,
  variant = "full",
}: {
  channelId: string;
  initialValue: string;
  onSaved?: (value: string) => void;
  /** "full" = always-editable textarea. "preview" = read-only with Edit button (used by Brain panel). */
  variant?: "full" | "preview";
}) {
  const [value, setValue] = useState(initialValue);
  const [editing, setEditing] = useState(variant === "full");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the parent switches the active channel.
  useEffect(() => {
    setValue(initialValue);
    setEditing(variant === "full");
    setError(null);
  }, [channelId, initialValue, variant]);

  const dirty = value !== initialValue;
  const overCap = value.length > DESCRIPTION_CAP;

  const save = async () => {
    if (overCap) {
      setError(`Description exceeds ${DESCRIPTION_CAP} chars`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/channel-info", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          field: "channelDescription",
          value,
        }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      onSaved?.(value);
      if (variant === "preview") setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (variant === "preview" && !editing) {
    return (
      <div className="space-y-2">
        {value.trim().length > 0 ? (
          <div className="whitespace-pre-wrap text-sm leading-snug text-foreground/90 line-clamp-6">
            {value}
          </div>
        ) : (
          <div className="text-sm italic text-muted-foreground/70">
            No description yet. Click Edit to write one.
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          className="gap-1.5"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={variant === "full" ? 8 : 6}
        placeholder="One paragraph the agent reads before every job. Cover what the channel is, who watches (age + region), what makes you different, voice + pacing. Plain words. Shorter is better."
        className={cn(
          "w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
          "focus:outline-none focus:ring-2 focus:ring-ring",
          overCap && "border-destructive/60 focus:ring-destructive"
        )}
        disabled={saving}
      />
      <div className="flex items-center gap-2 text-[11px]">
        <span
          className={cn(
            "text-muted-foreground",
            overCap && "font-medium text-destructive"
          )}
        >
          {value.length} / {DESCRIPTION_CAP}
        </span>
        {dirty && !overCap && (
          <span className="text-amber-600 dark:text-amber-400">unsaved</span>
        )}
        {error && <span className="text-destructive">· {error}</span>}
        <div className="ml-auto flex items-center gap-2">
          {variant === "preview" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setValue(initialValue);
                setEditing(false);
                setError(null);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || overCap || saving}
            className="gap-1.5"
          >
            <Check className="h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Banned topics — comma-separated list, autosave on blur
// ---------------------------------------------------------------------

export function BannedTopicsEditor({
  channelId,
  initialValue,
  onSaved,
}: {
  channelId: string;
  initialValue: string;
  onSaved?: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(initialValue);
    setError(null);
  }, [channelId, initialValue]);

  const persist = useCallback(async () => {
    const trimmed = value.trim();
    if (trimmed === initialValue.trim()) return;
    if (trimmed.length > BANNED_TOPICS_CAP) {
      setError(`Banned topics exceed ${BANNED_TOPICS_CAP} chars`);
      return;
    }
    setError(null);
    try {
      const r = await fetch("/api/channel-info", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          field: "bannedTopics",
          value: trimmed,
        }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      onSaved?.(trimmed);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }, [value, initialValue, channelId, onSaved]);

  const overCap = value.length > BANNED_TOPICS_CAP;

  return (
    <div className="space-y-1">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={persist}
        rows={2}
        placeholder="e.g. fermi paradox, dark energy, black holes, footages"
        className={cn(
          "w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
          "focus:outline-none focus:ring-2 focus:ring-ring",
          overCap && "border-destructive/60 focus:ring-destructive"
        )}
      />
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>AI will reject any idea matching these topics.</span>
        <span className="ml-auto">
          {savedFlash && <span className="text-emerald-600 dark:text-emerald-400">Saved</span>}
          {error && <span className="text-destructive">{error}</span>}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Ideation rules — line-list with add/delete
// ---------------------------------------------------------------------

export function IdeationRulesEditor({
  channelId,
  initialValue,
  onSaved,
}: {
  channelId: string;
  initialValue: string;
  onSaved?: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(initialValue);
    setError(null);
  }, [channelId, initialValue]);

  const dirty = value !== initialValue;
  const overCap = value.length > IDEATION_RULES_CAP;

  const save = async () => {
    if (overCap) {
      setError(`Rules exceed ${IDEATION_RULES_CAP} chars`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/channel-info", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          field: "ideationRules",
          value,
        }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      onSaved?.(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={6}
        placeholder="One rule per line. HARD-enforcement constraints the ideation agent must follow when composing titles. Voice constraints, banned shapes, format overrides — anything you never want bent."
        className={cn(
          "w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono",
          "focus:outline-none focus:ring-2 focus:ring-ring",
          overCap && "border-destructive/60 focus:ring-destructive"
        )}
        disabled={saving}
      />
      <div className="flex items-center gap-2 text-[11px]">
        <span
          className={cn(
            "text-muted-foreground",
            overCap && "font-medium text-destructive"
          )}
        >
          {value.length} / {IDEATION_RULES_CAP}
        </span>
        {dirty && !overCap && (
          <span className="text-amber-600 dark:text-amber-400">unsaved</span>
        )}
        {error && <span className="text-destructive">· {error}</span>}
        <div className="ml-auto">
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || overCap || saving}
            className="gap-1.5"
          >
            <Check className="h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

