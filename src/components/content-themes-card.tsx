"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Hash,
  Loader2,
  RefreshCw,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type TopicCluster = {
  cluster_name: string;
  video_ids_in_cluster: string[];
  avg_views: number;
};

type CrossCompetitorViral = {
  cluster_name: string;
  competitor_outliers: {
    video_id: string;
    title: string;
    channel_name: string;
    multiplier: number;
  }[];
};

type TopicAnalysis = {
  generated_at: string;
  my_clusters: TopicCluster[];
  cross_competitor_viral: CrossCompetitorViral[];
};

function fmtViews(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

function ytLink(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function ContentThemesCard({ channelId }: { channelId: string }) {
  const [analysis, setAnalysis] = useState<TopicAnalysis | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial load — GET pulls cached if any, returns { analysis: null }
  // when never computed.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(
      `/api/channel-info/topic-analysis?channelId=${encodeURIComponent(channelId)}`
    )
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setAnalysis(d.analysis ?? null);
        setGeneratedAt(d.generated_at ?? d.analysis?.generated_at ?? null);
      })
      .catch(() => {
        if (!cancelled) setAnalysis(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  const run = useCallback(
    async (refresh: boolean) => {
      setRunning(true);
      setError(null);
      try {
        const res = await fetch("/api/channel-info/topic-analysis", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId, refresh }),
        });
        const data = (await res.json()) as {
          analysis?: TopicAnalysis;
          error?: string;
        };
        if (!res.ok) {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        setAnalysis(data.analysis ?? null);
        setGeneratedAt(data.analysis?.generated_at ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "analysis failed");
      } finally {
        setRunning(false);
      }
    },
    [channelId]
  );

  return (
    <Card className="mb-4">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Hash className="h-4 w-4 text-primary" />
              Content themes
            </CardTitle>
            <CardDescription>
              AI-clustered topics across this channel&apos;s recent uploads,
              cross-referenced with competitor outliers.
              {generatedAt && (
                <span className="ml-1 text-[10px] text-muted-foreground/70">
                  · last run {new Date(generatedAt).toLocaleString()}
                </span>
              )}
            </CardDescription>
          </div>
          {analysis && (
            <button
              type="button"
              onClick={() => run(true)}
              disabled={running}
              className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Re-run the topic analysis (skips 24h cache)"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh analysis
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {loading && !analysis && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {!loading && !analysis && !running && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border bg-muted/30 px-4 py-6">
            <p className="text-sm text-muted-foreground">
              No analysis yet. One Claude call clusters this channel&apos;s last
              30 uploads and surfaces competitor outliers covering similar
              topics. Cached for 24h.
            </p>
            <Button onClick={() => run(false)} size="sm" className="gap-2 shrink-0">
              <Sparkles className="h-3.5 w-3.5" />
              Run analysis
            </Button>
          </div>
        )}

        {!loading && !analysis && running && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Running topic analysis…
          </div>
        )}

        {analysis && (
          <>
            <section>
              <div className="mb-2 flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium text-foreground">
                  Your channel&apos;s topics
                </span>
                <span className="text-muted-foreground">
                  {analysis.my_clusters.length} clusters
                </span>
              </div>
              <ul className="divide-y divide-border">
                {analysis.my_clusters.map((c) => (
                  <li
                    key={c.cluster_name}
                    className="flex items-baseline justify-between gap-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {c.cluster_name}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                      {c.video_ids_in_cluster.length}v · avg{" "}
                      {fmtViews(c.avg_views)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {analysis.cross_competitor_viral.length > 0 && (
              <section>
                <div className="mb-2 flex items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium text-foreground">
                    Cross-competitor viral topics
                  </span>
                  <span className="text-muted-foreground">
                    {analysis.cross_competitor_viral.length} clusters · ≥ 2
                    competitors winning
                  </span>
                </div>
                <ul className="space-y-3">
                  {analysis.cross_competitor_viral.map((c) => (
                    <li key={c.cluster_name} className="rounded-md border border-border bg-muted/20 p-3">
                      <div className="mb-2 text-sm font-medium">{c.cluster_name}</div>
                      <ul className="space-y-1">
                        {c.competitor_outliers.map((o) => (
                          <li
                            key={o.video_id}
                            className="flex items-baseline gap-2 text-xs"
                          >
                            <a
                              href={ytLink(o.video_id)}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex min-w-0 flex-1 items-baseline gap-1 truncate text-primary hover:underline"
                              title={`${o.channel_name} — ${o.title}`}
                            >
                              <span className="truncate">{o.title}</span>
                              <ExternalLink className="h-3 w-3 shrink-0" />
                            </a>
                            <span className="text-muted-foreground">
                              {o.channel_name}
                            </span>
                            <span className="font-mono tabular-nums text-muted-foreground">
                              {o.multiplier}×
                            </span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
