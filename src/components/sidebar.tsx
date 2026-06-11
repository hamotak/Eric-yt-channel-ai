"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Settings,
  PlaySquare,
  Search,
  Users,
  Sparkles,
  Image,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * Persistent collapse preference. Once the user toggles the chevron,
 * their explicit choice is stored here and wins over the viewport
 * auto-collapse on narrow widths. Cleared by removing the key from
 * localStorage (DevTools).
 */
const SIDEBAR_PREF_KEY = "sidebar-collapsed";

/**
 * Cross-component overlay trigger. Topbar dispatches this when the
 * mobile menu button is clicked at <640px; the sidebar listens and
 * toggles its overlay-open state.
 */
const SIDEBAR_TOGGLE_EVENT = "lat-media-ideation-sidebar-toggle";

export function Sidebar() {
  const { t } = useI18n();
  const pathname = usePathname();

  // Collapsed state machine:
  //   userPref           — null = no explicit choice yet; true/false = persisted choice
  //   viewportNarrow     — derived from matchMedia (max-width: 1023.98px)
  //   overlayMode        — derived from matchMedia (max-width: 639.98px)
  //   overlayOpen        — visible/hidden when in overlay mode
  //
  // Effective collapsed = userPref ?? viewportNarrow.
  // In overlay mode collapse is irrelevant — the overlay renders the
  // full-width sidebar with labels visible.
  const [hydrated, setHydrated] = useState(false);
  const [userPref, setUserPref] = useState<boolean | null>(null);
  const [viewportNarrow, setViewportNarrow] = useState(false);
  const [overlayMode, setOverlayMode] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);

  useEffect(() => {
    const raw = window.localStorage.getItem(SIDEBAR_PREF_KEY);
    if (raw === "true") setUserPref(true);
    else if (raw === "false") setUserPref(false);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mqNarrow = window.matchMedia("(max-width: 1023.98px)");
    const mqTiny = window.matchMedia("(max-width: 639.98px)");
    const sync = () => {
      setViewportNarrow(mqNarrow.matches);
      const tiny = mqTiny.matches;
      setOverlayMode(tiny);
      if (!tiny) setOverlayOpen(false);
    };
    sync();
    mqNarrow.addEventListener("change", sync);
    mqTiny.addEventListener("change", sync);
    return () => {
      mqNarrow.removeEventListener("change", sync);
      mqTiny.removeEventListener("change", sync);
    };
  }, []);

  const collapsed = userPref ?? viewportNarrow;
  const showLabels = overlayMode || !collapsed;

  const toggleCollapse = useCallback(() => {
    if (overlayMode) {
      setOverlayOpen((v) => !v);
      return;
    }
    const next = !collapsed;
    setUserPref(next);
    window.localStorage.setItem(SIDEBAR_PREF_KEY, String(next));
  }, [collapsed, overlayMode]);

  // Cmd+B / Ctrl+B keyboard shortcut. ChatGPT / Linear convention.
  // Skipped while focus is inside an editable element so typing 'b' in
  // a note textarea never accidentally toggles the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "b") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      toggleCollapse();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggleCollapse]);

  // External overlay trigger (Topbar mobile-menu button).
  useEffect(() => {
    const onEvent = () => toggleCollapse();
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, onEvent);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, onEvent);
  }, [toggleCollapse]);

  // Close the overlay on route change so the user doesn't see it lingering.
  useEffect(() => {
    setOverlayOpen(false);
  }, [pathname]);

  type NavItem = {
    href: string;
    label: string;
    icon: typeof Sparkles;
    badge?: number;
  };
  type NavSection = {
    /** Uppercase header above the items (e.g. "CREATE"). Omitted = no header. */
    label?: string;
    /** Render a hairline divider + extra spacing above the section. */
    separatorAbove?: boolean;
    items: NavItem[];
  };
  const sections: NavSection[] = [
    {
      label: "CREATE",
      items: [
        { href: "/ideate", label: "Ideate", icon: Sparkles },
        { href: "/image-studio", label: "Image Studio", icon: Image },
      ],
    },
    {
      label: "CHANNEL",
      items: [
        { href: "/channel-info", label: "Channel Info", icon: Users },
        { href: "/competitors", label: "Competitors", icon: Search },
      ],
    },
    {
      separatorAbove: true,
      items: [{ href: "/settings", label: t.nav.settings, icon: Settings }],
    },
  ];

  const settingsSubItems: { href: string; label: string }[] = [
    { href: "/settings/integrations", label: "Integrations" },
    { href: "/settings/logs", label: "Logs" },
  ];
  const isOnSettings =
    pathname === "/settings" || pathname.startsWith("/settings/");

  // While we haven't read localStorage + matchMedia yet, render the
  // server's expanded default so layout doesn't shift visibly on first
  // paint. Once hydrated, the real state takes over and CSS transitions
  // smooth the change.
  const effectiveOverlayMode = hydrated && overlayMode;
  const effectiveCollapsed = hydrated && collapsed && !overlayMode;
  const widthClass = effectiveOverlayMode
    ? "w-60"
    : effectiveCollapsed
      ? "w-16"
      : "w-60";
  const overlayClosed = effectiveOverlayMode && !overlayOpen;
  const layoutClass = effectiveOverlayMode
    ? "fixed inset-y-0 left-0 z-50"
    : "shrink-0";
  const transformClass = effectiveOverlayMode
    ? overlayOpen
      ? "translate-x-0"
      : "-translate-x-full"
    : "translate-x-0";

  return (
    <>
      {effectiveOverlayMode && overlayOpen && (
        <button
          aria-label="Dismiss sidebar"
          type="button"
          onClick={() => setOverlayOpen(false)}
          className="fixed inset-y-0 left-60 right-0 z-40 bg-black/50"
        />
      )}
      <aside
        className={cn(
          "flex h-screen flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
          "transition-[width,transform] duration-200 ease-in-out",
          layoutClass,
          widthClass,
          transformClass,
          overlayClosed && "pointer-events-none"
        )}
        aria-hidden={overlayClosed}
        inert={overlayClosed ? true : undefined}
      >
        {/* Header — single row in both states. ChatGPT pattern: in
            collapsed mode the toggle button IS the topmost element (no
            logo, no wordmark) so nav icons sit at the same Y coordinate
            as in expanded mode. Header height = py-5 (40px) + h-8
            content (32px) = 72px constant. */}
        <div
          className={cn(
            "flex h-8 items-center py-5",
            showLabels ? "gap-2 px-5" : "justify-center px-3"
          )}
        >
          {showLabels && (
            <>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <PlaySquare className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1 truncate text-sm font-semibold">
                {t.app.name}
              </div>
            </>
          )}
          <button
            type="button"
            onClick={toggleCollapse}
            aria-label={
              effectiveOverlayMode
                ? overlayOpen
                  ? "Close sidebar"
                  : "Open sidebar"
                : effectiveCollapsed
                  ? "Expand sidebar"
                  : "Collapse sidebar"
            }
            title={effectiveCollapsed ? "Expand (Cmd+B)" : "Collapse (Cmd+B)"}
            className="flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {effectiveCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
        </div>

        <nav className={cn("flex-1", showLabels ? "px-3 py-2" : "px-2 py-2")}>
          {sections.map((section, sectionIdx) => {
            const isFirstSection = sectionIdx === 0;
            return (
              <Fragment key={section.label ?? `section-${sectionIdx}`}>
                {/* Separator above standalone bottom items (Settings).
                    Renders in BOTH expanded and collapsed modes — the
                    hairline is part of the rhythm, not just text-mode
                    chrome. Negative -mx-2 in collapsed mode extends the
                    line back through the nav's px-2 padding so it spans
                    the full 64px sidebar width (matches ChatGPT pattern). */}
                {section.separatorAbove && (
                  <div
                    role="separator"
                    className={cn(
                      "mb-2 mt-3 border-t border-sidebar-border/60",
                      showLabels ? "mx-3" : "-mx-2"
                    )}
                  />
                )}
                {/* Section header (expanded only). Collapsed mode uses an
                    mt-6 gap on the first item of each section instead,
                    so icon groups have clearly visible breathing room
                    without text labels (FIX-G bump from mt-4). */}
                {section.label && showLabels && (
                  <div
                    className={cn(
                      "px-3 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70",
                      isFirstSection ? "mt-6" : "mt-5",
                      "mb-1"
                    )}
                  >
                    {section.label}
                  </div>
                )}
                <ul className="space-y-0.5">
                  {section.items.map((item, itemIdx) => {
                    const itemPath = item.href.split("?")[0];
                    const active =
                      itemPath === "/"
                        ? pathname === "/"
                        : pathname === itemPath ||
                          pathname.startsWith(itemPath + "/");
                    const Icon = item.icon;
                    const badge = item.badge ?? 0;
                    // Collapsed-mode gap between sections (replaces text
                    // header). FIX-G bumped from mt-4 to mt-6 (24px) so
                    // the section rhythm is unmistakable at icon-only
                    // density.
                    const collapsedSectionGap =
                      !showLabels &&
                      !isFirstSection &&
                      !section.separatorAbove &&
                      itemIdx === 0
                        ? "mt-6"
                        : "";
                    return (
                      <li key={item.href} className={collapsedSectionGap}>
                        <Link
                          href={item.href}
                          title={!showLabels ? item.label : undefined}
                          className={cn(
                            "flex items-center rounded-md text-sm transition-colors",
                            showLabels
                              ? "gap-3 py-2.5"
                              : "h-9 justify-center px-0",
                            // Active state: subtle bg-muted + red text/icon
                            // + 2px left accent bar (expanded only). Replaces
                            // the prior saturated red fill.
                            showLabels
                              ? active
                                ? "border-l-2 border-primary bg-muted pl-[10px] pr-3 text-primary font-medium"
                                : "border-l-2 border-transparent pl-[10px] pr-3 text-sidebar-foreground/80 hover:bg-accent/40 hover:text-accent-foreground"
                              : active
                                ? "bg-muted text-primary"
                                : "text-sidebar-foreground/80 hover:bg-accent/40 hover:text-accent-foreground"
                          )}
                        >
                          <span className="relative inline-flex">
                            <Icon className="h-4 w-4" />
                            {!showLabels && badge > 0 && (
                              <span className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-semibold text-white">
                                {badge}
                              </span>
                            )}
                          </span>
                          {showLabels && (
                            <>
                              <span className="flex-1">{item.label}</span>
                              {badge > 0 && (
                                <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                                  {badge}
                                </span>
                              )}
                            </>
                          )}
                        </Link>
                        {/* Settings sub-items — only when on a /settings route
                            and the sidebar is expanded. */}
                        {item.href === "/settings" && isOnSettings && showLabels && (
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
                                        ? "text-primary font-medium"
                                        : "text-sidebar-foreground/70 hover:text-foreground"
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
                    );
                  })}
                </ul>
              </Fragment>
            );
          })}
        </nav>

        {showLabels && (
          <div className="border-t border-sidebar-border px-5 py-4 text-xs text-muted-foreground">
            v0.1.0 · local
          </div>
        )}
      </aside>
    </>
  );
}

/**
 * Module-level helper for the Topbar's mobile-menu button to trigger
 * the sidebar overlay without prop-drilling. Exported so the Topbar
 * (and anything else, e.g. a keyboard shortcut surface) can call it.
 */
export function dispatchSidebarToggle(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SIDEBAR_TOGGLE_EVENT));
}
