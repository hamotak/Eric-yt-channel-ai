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
        <p className="mt-1 text-sm text-muted-foreground">
          Channels the ideation pipeline pulls live outlier signals from.
          Paste a URL, @handle, or UC… id.
        </p>
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
          placeholder="@channel or https://youtube.com/@… or UC…"
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
  const [savedFlash, setSavedFlash] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
            <div className="flex items-center gap-3 whitespace-nowrap">
              {savedFlash && (
                <span className="text-xs text-muted-foreground">Saved</span>
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
            placeholder="Note (optional) — what's interesting about this channel?"
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
