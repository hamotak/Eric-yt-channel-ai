"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Check, ChevronsUpDown, Globe, Tv } from "lucide-react";
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

// Shared localStorage key with the (formerly visible) DashboardTabs toggle —
// the Dashboard page reads from this directly to decide whether to render
// the cross-channel combined view or the per-channel widgets.
const VIEW_MODE_KEY = "dashboard.viewMode";
type ViewMode = "all" | "channel";

/**
 * Top-bar channel picker. Lets the user switch which YouTube channel the
 * dashboard / videos / analytics screens are scoped to, plus an "All
 * channels" sentinel that only the Dashboard understands (combined view).
 *
 * Triggers a full page refresh on change because most pages are server-
 * rendered against the active channel and need fresh data.
 *
 * Cross-page caveat: "All channels" lives ONLY in localStorage. The
 * server-side active-channel pointer is unchanged — so on /videos,
 * /competitors, /channel etc. the page still scopes to whichever specific
 * channel was last selected. The picker label tracks this: on Dashboard
 * it says "All channels" when that mode is set; on other pages it always
 * shows the active channel title.
 *
 * Hidden when there's only one (or zero) channels — no point in a switcher
 * with nothing to switch between.
 */
export function ChannelSwitcher() {
  const pathname = usePathname();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("channel");
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(VIEW_MODE_KEY);
    if (saved === "all" || saved === "channel") setViewMode(saved);
  }, []);

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

  // "All channels" semantics are Dashboard-only. Everywhere else the label
  // shows the specific active channel, even if localStorage says "all" —
  // otherwise the picker would lie about what the visible page is showing.
  const isDashboard = pathname === "/";
  const showingAll = isDashboard && viewMode === "all";

  async function pickAll() {
    if (switching) {
      setOpen(false);
      return;
    }
    // Don't touch /api/channels/active — the server-side active channel
    // pointer stays as the last specific channel so other pages keep
    // working without us inventing a server-side "all" sentinel.
    window.localStorage.setItem(VIEW_MODE_KEY, "all");
    setSwitching(true);
    window.location.reload();
  }

  async function pick(id: string) {
    if (switching) {
      setOpen(false);
      return;
    }
    // Always set the localStorage flag back to "channel" so that on
    // Dashboard the per-channel widgets render again — even if the user
    // picks the SAME channel that was previously active while in "all"
    // mode.
    window.localStorage.setItem(VIEW_MODE_KEY, "channel");
    if (id === activeId) {
      // Just changed mode without picking a new channel — reload so the
      // Dashboard re-reads localStorage and re-mounts the per-channel
      // widgets.
      if (viewMode === "all") {
        setSwitching(true);
        window.location.reload();
        return;
      }
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
        {showingAll ? (
          <Globe className="h-4 w-4" />
        ) : (
          <Tv className="h-4 w-4" />
        )}
        <span className="max-w-[180px] truncate">
          {showingAll
            ? "All channels"
            : (active?.title ?? active?.handle ?? "Channel")}
        </span>
        <ChevronsUpDown className="h-3 w-3 opacity-60" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-[calc(100%+4px)] z-30 w-72 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          <div className="max-h-80 overflow-y-auto p-1">
            {/* "All channels" sentinel — first entry, separated by a
                bottom border. Only the Dashboard renders the combined
                view; other pages keep scoping to the active channel. */}
            <button
              onClick={pickAll}
              className="flex w-full items-center gap-2 rounded-sm border-b border-border/60 px-2 py-2 text-left text-sm hover:bg-accent"
            >
              <Check
                className={`h-4 w-4 shrink-0 ${
                  showingAll ? "opacity-100" : "opacity-0"
                }`}
              />
              <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">All channels</div>
                <div className="truncate text-xs text-muted-foreground">
                  Dashboard only — other pages scope to the active channel
                </div>
              </div>
            </button>
            {channels.map((c) => (
              <button
                key={c.id}
                onClick={() => pick(c.id)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent"
              >
                <Check
                  className={`h-4 w-4 shrink-0 ${
                    !showingAll && c.id === activeId
                      ? "opacity-100"
                      : "opacity-0"
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
