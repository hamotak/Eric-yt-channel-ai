import { NextResponse } from "next/server";
import { listIntegrations, setIntegration } from "@/lib/db";
import { getBraveSearchConfig } from "@/lib/brave-search";

// OpenAI/Claude power AI planning, YouTube powers channel/video sync, Brave
// powers Reddit web signals, and 69labs powers generated thumbnail images.
const ALLOWED = ["openai", "claude", "youtube", "brave", "69labs"] as const;
type Name = (typeof ALLOWED)[number];

function mask(key: string | null) {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}••••••${key.slice(-4)}`;
}

export async function GET() {
  const rows = listIntegrations();
  const map = Object.fromEntries(
    ALLOWED.map((name) => {
      const row = rows.find((r) => r.name === name);
      const braveConfig = name === "brave" ? getBraveSearchConfig() : null;
      const key = name === "brave" ? braveConfig?.apiKey ?? null : row?.api_key ?? null;
      return [
        name,
        {
          name,
          hasKey: !!key,
          masked: mask(key),
          enabled: name === "brave" ? !!key : !!row?.enabled,
          config: name === "brave" ? { source: braveConfig?.source ?? null } : undefined,
        },
      ];
    })
  );
  return NextResponse.json({ integrations: map });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    name?: string;
    api_key?: string;
  };
  if (!body.name || !ALLOWED.includes(body.name as Name)) {
    return NextResponse.json({ error: "invalid integration name" }, { status: 400 });
  }
  if (typeof body.api_key !== "string") {
    return NextResponse.json({ error: "api_key required" }, { status: 400 });
  }
  setIntegration(body.name, body.api_key.trim());
  return NextResponse.json({ ok: true });
}
