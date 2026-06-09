"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";

type Channel = {
  id: string;
  title: string | null;
  handle: string | null;
  subscriber_count: number | null;
};

type ChannelsResponse = {
  channels: Channel[];
  activeId: string | null;
};

/**
 * Top-bar channel picker. Lets the user switch which YouTube channel the
 * ideation and setup screens are scoped to.
 *
 * Triggers a full page refresh on change because most pages are server-
 * rendered against the active channel and need fresh data.
 *
 * Hidden when there's only one (or zero) channels — no point in a switcher
 * with nothing to switch between.
 */
export function ChannelSwitcher() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // Display order: largest channel first, alphabetical tiebreak. Otherwise
  // a freshly-added 100-sub channel can bury the 117K main channel below
  // the fold.
  const sortedChannels = useMemo(() => {
    return [...channels].sort((a, b) => {
      const aSubs = a.subscriber_count ?? -1;
      const bSubs = b.subscriber_count ?? -1;
      if (aSubs !== bSubs) return bSubs - aSubs;
      const aLabel = (a.title ?? a.handle ?? "").toLowerCase();
      const bLabel = (b.title ?? b.handle ?? "").toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
  }, [channels]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/channels", { cache: "no-store" })
      .then((r) => r.json() as Promise<ChannelsResponse>)
      .then((data) => {
        if (cancelled) return;
        setChannels(data.channels);
        setActiveId(data.activeId);
      })
      .catch(() => {
        // Silent — switcher will just stay hidden if the fetch fails.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  if (channels.length <= 1) return null;
  const active = channels.find((c) => c.id === activeId) ?? channels[0];

  async function pick(id: string) {
    if (switching) {
      setOpen(false);
      return;
    }
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      const res = await fetch("/api/channels/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        // Kick the silent freshness pass for the newly-active channel
        // before navigating. keepalive lets the request survive the
        // upcoming reload; the server enforces a 15-minute throttle.
        fetch("/api/sync/user-videos", {
          method: "POST",
          keepalive: true,
        }).catch(() => {});
        // Hard reload — server components on every page read the active
        // channel during render. SWR-style soft invalidation isn't enough.
        window.location.reload();
      } else {
        setSwitching(false);
        setOpen(false);
      }
    } catch {
      setSwitching(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative" ref={popRef}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        disabled={switching}
        className="gap-2"
      >
        <Tv className="h-4 w-4" />
        <span className="max-w-[180px] truncate">
          {active?.title ?? active?.handle ?? "Channel"}
        </span>
        <ChevronsUpDown className="h-3 w-3 opacity-60" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-[calc(100%+4px)] z-30 w-72 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          <div className="max-h-[min(70vh,560px)] overflow-y-auto p-1">
            {sortedChannels.map((c) => (
              <button
                key={c.id}
                onClick={() => pick(c.id)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent"
              >
                <Check
                  className={`h-4 w-4 shrink-0 ${
                    c.id === activeId ? "opacity-100" : "opacity-0"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{c.title ?? "Untitled"}</div>
                  {c.handle ? (
                    <div className="truncate text-xs text-muted-foreground">{c.handle}</div>
                  ) : null}
                </div>
                {typeof c.subscriber_count === "number" ? (
                  <div className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatCompact(c.subscriber_count)}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
