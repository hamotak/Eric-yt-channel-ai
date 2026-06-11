"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Competitor = {
  id: number;
  channelId: string | null;
  handle: string | null;
  title: string | null;
  avatarUrl: string | null;
  subscriberCount: number | null;
  note: string | null;
  thumbnailPolicy: "allow" | "cms_exclude";
  thumbnailPolicyNote: string | null;
  addedAt: number;
};

type Resolved = {
  channel_id: string;
  channel_name: string;
  handle: string | null;
  thumbnail_url: string | null;
  subscriber_count: number | null;
};

function fmtSubs(n: number | null): string {
  if (n === null) return "—";
  if (n === -1) return "Hidden";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M subs";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K subs";
  return `${n} subs`;
}

export default function CompetitorsPage() {
  const [list, setList] = useState<Competitor[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [input, setInput] = useState("");
  const [resolving, setResolving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/competitors", { cache: "no-store" });
      const json = await res.json();
      setList(json.competitors ?? []);
      setActiveChannelId(json.activeChannelId ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onAdd = useCallback(async () => {
    const raw = input.trim();
    if (!raw) return;
    setError(null);
    setResolving(true);
    let resolved: Resolved;
    try {
      const r = await fetch("/api/competitors/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: raw }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "could not resolve channel");
        return;
      }
      resolved = j as Resolved;
    } finally {
      setResolving(false);
    }
    setSaving(true);
    try {
      const r = await fetch("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved, note: "" }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "could not save competitor");
        return;
      }
      setInput("");
      await load();
    } finally {
      setSaving(false);
    }
  }, [input, load]);

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-10 leading-relaxed">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Competitors</h1>
        <p className="mt-1 text-sm text-muted-foreground">Source channels for outlier signals.</p>
      </header>

      <div className="mb-10 flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !resolving && !saving) {
              e.preventDefault();
              void onAdd();
            }
          }}
          placeholder="@channel, URL, or channel ID"
          disabled={resolving || saving || !activeChannelId}
          className="flex-1"
        />
        <Button
          onClick={onAdd}
          disabled={!input.trim() || resolving || saving || !activeChannelId}
          aria-label="Add competitor"
        >
          {resolving || saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add
        </Button>
      </div>

      {error && (
        <p role="alert" className="-mt-6 mb-8 text-sm text-destructive">
          {error}
        </p>
      )}

      {!activeChannelId && !loading && (
        <p className="text-sm text-muted-foreground">
          No active channel. Connect one from the top-right channel switcher.
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.length === 0 && activeChannelId ? (
        <p className="text-sm text-muted-foreground">
          No competitors yet. Add one above.
        </p>
      ) : (
        <ul className="border-t border-border">
          {list.map((c) => (
            <CompetitorRow
              key={c.id}
              competitor={c}
              onChanged={load}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CompetitorRow({
  competitor,
  onChanged,
}: {
  competitor: Competitor;
  onChanged: () => Promise<void> | void;
}) {
  const [note, setNote] = useState(competitor.note ?? "");
  const [thumbnailPolicy, setThumbnailPolicy] = useState<
    "allow" | "cms_exclude"
  >(competitor.thumbnailPolicy ?? "allow");
  const thumbnailPolicyNote = competitor.thumbnailPolicyNote ?? "";
  const [savedFlash, setSavedFlash] = useState(false);
  const [policySavedFlash, setPolicySavedFlash] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const policyFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistNote = useCallback(async () => {
    const next = note.trim();
    const prior = (competitor.note ?? "").trim();
    if (next === prior) return;
    await fetch(`/api/competitors/${competitor.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: next.length > 0 ? next : null }),
    });
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSavedFlash(false), 1000);
  }, [note, competitor.id, competitor.note]);

  const flashPolicySaved = useCallback(() => {
    setPolicySavedFlash(true);
    if (policyFlashTimer.current) clearTimeout(policyFlashTimer.current);
    policyFlashTimer.current = setTimeout(() => setPolicySavedFlash(false), 1000);
  }, []);

  const persistThumbnailPolicy = useCallback(
    async (
      nextPolicy = thumbnailPolicy,
      nextNote = thumbnailPolicyNote
    ) => {
      await fetch(`/api/competitors/${competitor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thumbnailPolicy: nextPolicy,
          thumbnailPolicyNote: nextNote.trim().length > 0 ? nextNote.trim() : null,
        }),
      });
      flashPolicySaved();
    },
    [competitor.id, flashPolicySaved, thumbnailPolicy, thumbnailPolicyNote]
  );

  const onDelete = useCallback(async () => {
    await fetch(`/api/competitors/${competitor.id}`, { method: "DELETE" });
    await onChanged();
  }, [competitor.id, onChanged]);

  return (
    <li className="border-b border-border py-6">
      <div className="flex items-start gap-4">
        {competitor.avatarUrl ? (
          // Avatar from YouTube. Plain img to avoid Next/Image domain config friction.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={competitor.avatarUrl}
            alt=""
            className="h-10 w-10 shrink-0 rounded-full"
          />
        ) : (
          <div className="h-10 w-10 shrink-0 rounded-full bg-muted" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-4">
            <div className="min-w-0">
              <h3 className="truncate text-base font-medium">
                {competitor.title ?? "(untitled)"}
              </h3>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {competitor.handle ? `${competitor.handle} · ` : ""}
                {fmtSubs(competitor.subscriberCount)}
              </p>
            </div>
            <div className="flex items-center gap-2 whitespace-nowrap">
              {savedFlash && (
                <span className="text-xs text-muted-foreground">Saved</span>
              )}
              {policySavedFlash && (
                <span className="text-xs text-muted-foreground">Saved</span>
              )}
              {!confirmingDelete && (
                <div
                  className="inline-flex rounded-md border border-border p-0.5"
                  title="CMS channels can inspire ideas, but Image Studio skips their thumbnails."
                >
                  <button
                    type="button"
                    onClick={() => {
                      setThumbnailPolicy("allow");
                      void persistThumbnailPolicy("allow", thumbnailPolicyNote);
                    }}
                    className={cn(
                      "h-7 rounded px-2 text-xs transition-colors",
                      thumbnailPolicy === "allow"
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground hover:bg-muted"
                    )}
                  >
                    No CMS
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setThumbnailPolicy("cms_exclude");
                      void persistThumbnailPolicy("cms_exclude", thumbnailPolicyNote);
                    }}
                    className={cn(
                      "h-7 rounded px-2 text-xs transition-colors",
                      thumbnailPolicy === "cms_exclude"
                        ? "bg-destructive/15 text-destructive"
                        : "text-muted-foreground hover:bg-muted"
                    )}
                  >
                    CMS
                  </button>
                </div>
              )}
              {confirmingDelete ? (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    Cancel
                  </button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={onDelete}
                  >
                    Confirm delete
                  </Button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label="Delete competitor"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={persistNote}
            placeholder="Note"
            className={cn(
              "mt-3 min-h-[2.25rem] resize-none border-none bg-transparent px-0 py-1",
              "text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/70",
              "focus-visible:ring-0 focus-visible:ring-offset-0",
              "shadow-none"
            )}
            rows={1}
          />
        </div>
      </div>
    </li>
  );
}
