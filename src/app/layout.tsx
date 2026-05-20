import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n/provider";
import { ThemeProvider } from "@/lib/theme-provider";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";

export const metadata: Metadata = {
  title: "YT Channel AI",
  description: "YT Channel AI (local)",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <I18nProvider>
            <div className="flex h-screen overflow-hidden">
              <Sidebar />
              <div className="flex flex-1 flex-col overflow-hidden">
                <Topbar />
                {/* FIX-F: pt-20 (80px) gives every page a generous gap below
                    the topbar — strictly above the 64px target after subpixel
                    rounding. Sides + bottom keep 24px. Two-column pages that
                    need full-bleed below the topbar (e.g. /ideate) override
                    with -mt-20. */}
                <main className="flex-1 overflow-y-auto px-6 pb-6 pt-20">{children}</main>
              </div>
            </div>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
