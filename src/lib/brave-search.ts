import "server-only";

import { getIntegration } from "./db";

export interface BraveSearchConfig {
  apiKey: string;
  source: "settings" | "env";
}

export interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  age: string | null;
  extra_snippets: string[];
}

export interface BraveWebSearchOptions {
  query: string;
  count?: number;
  freshness?: "pd" | "pw" | "pm" | "py" | string;
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getBraveSearchConfig(): BraveSearchConfig | null {
  const row = getIntegration("brave");
  const settingsKey = row?.api_key?.trim() ?? "";
  if (settingsKey) return { apiKey: settingsKey, source: "settings" };

  const envKey = process.env.BRAVE_SEARCH_API_KEY?.trim() ?? "";
  if (envKey) return { apiKey: envKey, source: "env" };

  return null;
}

export async function searchBraveWeb(
  options: BraveWebSearchOptions
): Promise<BraveWebResult[]> {
  const config = getBraveSearchConfig();
  if (!config) {
    throw new Error("Brave Search API key missing — add it in /settings/integrations");
  }

  const query = options.query.trim().slice(0, 400);
  if (!query) return [];

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.max(1, Math.min(20, options.count ?? 10))));
  url.searchParams.set("freshness", options.freshness ?? "pm");
  url.searchParams.set("result_filter", "web");
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("country", "US");
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("extra_snippets", "true");

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": config.apiKey,
    },
    cache: "no-store",
  });
  if (res.status === 429) {
    throw new Error("Brave Search rate limit reached; try again later");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Brave Search failed (${res.status}): ${detail.slice(0, 200) || res.statusText}`
    );
  }

  const json = (await res.json()) as {
    web?: {
      results?: Array<{
        title?: unknown;
        url?: unknown;
        description?: unknown;
        age?: unknown;
        extra_snippets?: unknown;
      }>;
    };
  };

  return (json.web?.results ?? [])
    .map((result) => {
      const urlValue = typeof result.url === "string" ? result.url.trim() : "";
      return {
        title: cleanText(result.title),
        url: urlValue,
        description: cleanText(result.description),
        age: typeof result.age === "string" ? result.age : null,
        extra_snippets: Array.isArray(result.extra_snippets)
          ? result.extra_snippets.map(cleanText).filter(Boolean).slice(0, 5)
          : [],
      };
    })
    .filter((result) => result.title && result.url);
}
