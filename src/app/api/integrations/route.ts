import { NextResponse } from "next/server";
import { listIntegrations, setIntegration } from "@/lib/db";

// The only integrations the app actively uses post-simplification.
// Claude powers ideation + analyze-with-ai; YouTube Data API powers
// channel + video sync.
const ALLOWED = ["claude", "youtube"] as const;
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
      return [
        name,
        {
          name,
          hasKey: !!row?.api_key,
          masked: mask(row?.api_key ?? null),
          enabled: !!row?.enabled,
        },
      ];
    })
  );
  return NextResponse.json({ integrations: map });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { name?: string; api_key?: string };
  if (!body.name || !ALLOWED.includes(body.name as Name)) {
    return NextResponse.json({ error: "invalid integration name" }, { status: 400 });
  }
  if (typeof body.api_key !== "string") {
    return NextResponse.json({ error: "api_key required" }, { status: 400 });
  }
  setIntegration(body.name, body.api_key.trim());
  return NextResponse.json({ ok: true });
}
