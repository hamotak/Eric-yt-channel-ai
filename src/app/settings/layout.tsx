"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Shared layout for /settings and its sub-tabs (/settings/integrations,
 * /settings/import, /settings/logs). Renders the page-level "Settings"
 * heading and a tab strip; each tab is a real URL so back/forward and
 * deep links work without client-side state.
 */
const TABS = [
  { href: "/settings", label: "Preferences" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/import", label: "Import" },
  { href: "/settings/logs", label: "Logs" },
] as const;

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
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
  // The Preferences tab lives at the exact /settings path; the other
  // three each own a /settings/<x> subtree. usePathname is stable across
  // client-side navigation, so back/forward update the highlight too.
  const active =
    href === "/settings" ? pathname === "/settings" : pathname.startsWith(href);
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
