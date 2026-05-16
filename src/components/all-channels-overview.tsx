"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Eye, Users, Video, Tv, ArrowUpRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MultiChannelEarnings } from "@/components/multi-channel-earnings";

type Channel = {
  id: string;
  title: string | null;
  handle: string | null;
  subscriber_count: number | null;
  view_count: number | null;
  video_count: number | null;
};

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

/**
 * Cross-channel dashboard view shown when the user picks "All channels"
 * in the tab bar. Aggregates basic counts across every connected
 * channel and embeds the cross-channel earnings widget. Each channel
 * gets a quick-link to switch to its individual view.
 */
export function AllChannelsOverview() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/channels", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { channels: Channel[]; activeId: string | null }) => {
        setChannels(d.channels);
        setActiveId(d.activeId);
      })
      .catch(() => {});
  }, []);

  const switchTo = async (id: string) => {
    setSwitching(id);
    try {
      await fetch("/api/channels/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      // Reset the dashboard mode flag so the per-channel view shows.
      if (typeof window !== "undefined") {
        window.localStorage.setItem("dashboard.viewMode", "channel");
      }
      window.location.reload();
    } catch {
      setSwitching(null);
    }
  };

  if (!channels) return null;

  const totals = channels.reduce(
    (s, c) => ({
      subs: s.subs + (c.subscriber_count ?? 0),
      views: s.views + (c.view_count ?? 0),
      videos: s.videos + (c.video_count ?? 0),
    }),
    { subs: 0, views: 0, videos: 0 }
  );

  return (
    <div className="space-y-4">
      {/* Combined KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Total subscribers" value={fmt(totals.subs)} icon={Users} />
        <KpiCard label="Total views" value={fmt(totals.views)} icon={Eye} />
        <KpiCard label="Total videos" value={fmt(totals.videos)} icon={Video} />
      </div>

      {/* Cross-channel revenue widget — the headline reason this view
          exists. Hidden by the component itself if revenue access
          denied or only one channel connected. */}
      <MultiChannelEarnings />

      {/* Per-channel grid with quick switcher */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Tv className="h-4 w-4 text-primary" />
            Channels ({channels.length})
          </CardTitle>
          <CardDescription>
            Switch to a channel-specific tab to see its individual analytics.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {channels.map((c) => {
              const isActive = c.id === activeId;
              const pending = switching === c.id;
              return (
                <li key={c.id}>
                  <div
                    className={`flex items-center gap-3 rounded-md border p-3 ${
                      isActive ? "border-primary/40 bg-primary/5" : "border-border"
                    }`}
                  >
                    <Tv className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {c.title ?? c.id}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {c.handle ?? "—"} · {fmt(c.subscriber_count)} subs ·{" "}
                        {fmt(c.video_count)} videos
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => switchTo(c.id)}
                      disabled={pending}
                      className="h-7 gap-1 px-2 text-[11px]"
                    >
                      {pending ? "..." : "Open"}
                      <ArrowUpRight className="h-3 w-3" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 text-[11px] text-muted-foreground">
            Add another channel from the{" "}
            <Link href="/settings/integrations" className="text-primary hover:underline">
              Integrations
            </Link>{" "}
            page.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
