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
} from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const { t } = useI18n();
  const pathname = usePathname();
  // Lightweight competitor-alerts badge. Polls every 60s so the user
  // notices viral hits in their niche without having to open the
  // Competitors page. Quiet failure — no badge if the fetch errors
  // (e.g. before the migration ran on a fresh database).
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
    { href: "/my-channels", label: "My Channels", icon: Users, badge: 0 },
    { href: "/videos", label: t.nav.videos, icon: Video, badge: 0 },
    { href: "/chat", label: t.nav.chat, icon: MessageSquare, badge: 0 },
    {
      href: "/competitors",
      label: "Competitors",
      icon: Search,
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
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname === item.href || pathname.startsWith(item.href + "/");
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
