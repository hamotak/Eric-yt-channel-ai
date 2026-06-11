"use client";

import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";

export function ConnectBanner() {
  const { t } = useI18n();
  const [needsAi, setNeedsAi] = useState(false);

  useEffect(() => {
    fetch("/api/integrations")
      .then((r) => r.json())
      .then((data) => {
        const hasPlannerKey =
          !!data.integrations?.openai?.hasKey || !!data.integrations?.claude?.hasKey;
        setNeedsAi(!hasPlannerKey);
      })
      .catch(() => {});
  }, []);

  if (!needsAi) return null;

  return (
    <div className="mb-6 flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
      <div className="flex-1">
        <div className="font-medium">{t.banner.connectTitle}</div>
        <div className="mt-1 text-sm text-muted-foreground">{t.banner.connectDesc}</div>
      </div>
      <Link href="/settings/integrations">
        <Button size="sm">{t.banner.connectCta}</Button>
      </Link>
    </div>
  );
}
