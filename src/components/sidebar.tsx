"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Video,
  MessageSquare,
  Settings,
  PlaySquare,
  Search,
  Users,
  BookOpen,
  Flame,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const { t } = useI18n();
  const pathname = usePathname();
  // Lightweight outliers-discovery badge. Polls every 60s so the user
  // notices viral hits in their niche without having to open /outliers.
  // The count comes from competitor_alerts (the discovery log); /api/competitors
  // returns it as `unreadAlerts` already (legacy name, still accurate). Quiet
  // failure — no badge if the fetch errors (e.g. before the migration ran on
  // a fresh database). When the badge is > 0, the Outliers link deep-links
  // to the Recent tab so the click lands on the unread rows.
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const fetchUnread = async () => {
      try {
        const r = await fetch("/api/competitors", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { unreadAlerts?: number };
        if (!cancelled) setUnreadAlerts(d.unreadAlerts ?? 0);
      } catch {
        /* ignore */
      }
    };
    fetchUnread();
    const interval = window.setInterval(fetchUnread, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const items = [
    { href: "/", label: t.nav.dashboard, icon: LayoutDashboard, badge: 0 },
    { href: "/channel-info", label: "Channel Info", icon: Users, badge: 0 },
    { href: "/videos", label: t.nav.videos, icon: Video, badge: 0 },
    { href: "/chat", label: t.nav.chat, icon: MessageSquare, badge: 0 },
    { href: "/competitors", label: "Competitors", icon: Search, badge: 0 },
    {
      href: unreadAlerts > 0 ? "/outliers?tab=recent" : "/outliers",
      label: "Outliers",
      icon: Flame,
      badge: unreadAlerts,
    },
    { href: "/settings", label: t.nav.settings, icon: Settings, badge: 0 },
    {
      href: "/tutorial",
      label: "Tutorial",
      icon: BookOpen,
      badge: 0,
      separator: true,
    },
  ];

  // Sub-items of /settings — surfaced as indented links under Settings
  // whenever the user is on any /settings route. Before this, Logs / Alerts
  // / Import were only reachable by clicking Settings AND noticing the
  // tab strip above the Preferences card. Alerts is the only place to wire
  // Telegram — un-discoverable was a real usability bug.
  const settingsSubItems: { href: string; label: string }[] = [
    { href: "/settings", label: "Preferences" },
    { href: "/settings/integrations", label: "Integrations" },
    { href: "/settings/import", label: "Import" },
    { href: "/settings/logs", label: "Logs" },
    { href: "/settings/alerts", label: "Alerts" },
  ];
  const isOnSettings =
    pathname === "/settings" || pathname.startsWith("/settings/");

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <PlaySquare className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">{t.app.name}</div>
          <div className="text-xs text-muted-foreground">{t.app.tagline}</div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-2">
        <ul className="space-y-1">
          {items.map((item) => {
            // Strip any ?query string from the href before the activeness
            // check — the Outliers item conditionally deep-links to
            // /outliers?tab=recent and we still want it highlighted when
            // pathname is plain /outliers.
            const itemPath = item.href.split("?")[0];
            const active =
              itemPath === "/"
                ? pathname === "/"
                : pathname === itemPath || pathname.startsWith(itemPath + "/");
            const Icon = item.icon;
            return (
              <Fragment key={item.href}>
                {item.separator && (
                  <li
                    aria-hidden
                    className="my-2 border-t border-sidebar-border/60"
                  />
                )}
                <li>
                  <Link
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-sidebar-foreground/80 hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="flex-1">{item.label}</span>
                    {item.badge > 0 && (
                      <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                  {/* Settings sub-items — only render when the user is on a
                      /settings route, so the sidebar stays compact elsewhere. */}
                  {item.href === "/settings" && isOnSettings && (
                    <ul className="ml-7 mt-1 space-y-0.5">
                      {settingsSubItems.map((sub) => {
                        const subActive =
                          sub.href === "/settings"
                            ? pathname === "/settings"
                            : pathname === sub.href ||
                              pathname.startsWith(sub.href + "/");
                        return (
                          <li key={sub.href}>
                            <Link
                              href={sub.href}
                              className={cn(
                                "block rounded-md px-2 py-1 text-xs transition-colors",
                                subActive
                                  ? "bg-primary/10 text-primary font-medium"
                                  : "text-sidebar-foreground/70 hover:bg-accent hover:text-accent-foreground"
                              )}
                            >
                              {sub.label}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ul>
      </nav>

      <div className="px-5 py-4 text-xs text-muted-foreground border-t border-sidebar-border">
        v0.1.0 · local
      </div>
    </aside>
  );
}
