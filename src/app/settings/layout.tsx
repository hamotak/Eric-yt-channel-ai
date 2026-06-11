"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Shared layout for /settings sub-tabs (/settings/integrations,
 * /settings/logs). Renders the page-level "Settings" heading and a tab
 * strip; each tab is a real URL so back/forward and deep links work
 * without client-side state. The /settings index redirects to
 * /settings/integrations so the sidebar "Settings" item lands on the
 * first real tab.
 */
const TABS = [
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/logs", label: "Logs" },
] as const;

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const activeTab = TABS.find((tab) => pathname.startsWith(tab.href));

  return (
    <div
      className={cn(
        "mx-auto w-full",
        activeTab?.href === "/settings/logs" ? "max-w-6xl" : "max-w-3xl"
      )}
    >
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          {activeTab ? `Settings: ${activeTab.label}` : "Settings"}
        </h1>
      </header>
      <nav className="mb-6 flex gap-4 border-b border-border">
        {TABS.map((t) => (
          <TabLink key={t.href} href={t.href} label={t.label} />
        ))}
      </nav>
      {children}
    </div>
  );
}

function TabLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  // Both surviving tabs own a /settings/<x> subtree, so prefix match is
  // enough; usePathname is stable across client-side navigation, so
  // back/forward update the highlight too.
  const active = pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={cn(
        "-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 pb-2 text-sm transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </Link>
  );
}
