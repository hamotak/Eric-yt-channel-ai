"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";
import { useTheme } from "@/lib/theme-provider";

export default function SettingsPage() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="mb-6">
        <p className="mt-1 text-sm text-muted-foreground">{t.settings.subtitle}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t.settings.theme}</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button
            variant={theme === "light" ? "default" : "outline"}
            size="sm"
            onClick={() => setTheme("light")}
          >
            {t.settings.themeLight}
          </Button>
          <Button
            variant={theme === "dark" ? "default" : "outline"}
            size="sm"
            onClick={() => setTheme("dark")}
          >
            {t.settings.themeDark}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
