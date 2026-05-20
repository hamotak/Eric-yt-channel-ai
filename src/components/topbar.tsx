"use client";

import { Menu, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChannelSwitcher } from "@/components/channel-switcher";
import { dispatchSidebarToggle } from "@/components/sidebar";
import { useTheme } from "@/lib/theme-provider";

export function Topbar() {
  const { theme, toggle } = useTheme();

  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b border-border bg-background px-5">
      {/* Mobile menu — only visible at <640px where the sidebar becomes
          an overlay. Hidden at sm+ where the sidebar is always docked. */}
      <Button
        variant="ghost"
        size="icon"
        onClick={dispatchSidebarToggle}
        aria-label="Open sidebar"
        className="sm:hidden"
      >
        <Menu className="h-4 w-4" />
      </Button>
      <div className="hidden sm:block" />
      <div className="flex items-center gap-2">
        <ChannelSwitcher />
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
          {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  );
}
