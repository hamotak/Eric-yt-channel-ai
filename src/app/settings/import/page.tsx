"use client";

import { useRef, useState } from "react";
import { UploadCloud, Check, AlertTriangle, Loader2, FileText } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type ImportResponse = {
  ok?: boolean;
  videosImported?: number;
  channelUpdated?: boolean;
  skipped?: number;
  warnings?: string[];
  error?: string;
};

export default function ImportPage() {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);

  const pick = () => inputRef.current?.click();

  const onFile = (f: File | null) => {
    setResult(null);
    setFile(f);
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import", { method: "POST", body: form });
      const data: ImportResponse = await res.json();
      setResult(data);
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : "Upload failed" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t.import.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.import.subtitle}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t.import.howTitle}</CardTitle>
          <CardDescription className="mt-1 whitespace-pre-line">
            {t.import.howDesc}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) onFile(f);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed py-14 text-center transition-colors",
              dragging
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-accent/30"
            )}
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UploadCloud className="h-6 w-6" />
            </div>
            <div className="text-sm text-muted-foreground">{t.import.dropHint}</div>
            <Button type="button" variant="outline" size="sm" onClick={pick}>
              {t.import.button}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            />
          </label>

          {file && (
            <div className="mt-4 flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {(file.size / 1024).toFixed(1)} KB
                  </div>
                </div>
              </div>
              <Button size="sm" onClick={upload} disabled={uploading}>
                {uploading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t.import.processing}
                  </>
                ) : (
                  t.import.importBtn
                )}
              </Button>
            </div>
          )}

          {result && (
            <div
              className={cn(
                "mt-4 flex items-start gap-3 rounded-lg border p-3 text-sm",
                result.error
                  ? "border-destructive/30 bg-destructive/5 text-destructive"
                  : "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400"
              )}
            >
              {result.error ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <Check className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div className="flex-1">
                {result.error ? (
                  <div>{result.error}</div>
                ) : (
                  <div>
                    <div className="font-medium">{t.import.success}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t.import.imported.replace("{n}", String(result.videosImported ?? 0))}
                      {result.skipped
                        ? ` · ${t.import.skipped.replace("{n}", String(result.skipped))}`
                        : ""}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
