import { NextResponse } from "next/server";
import { getIntegration } from "@/lib/db";
import { resolveChannel, YouTubeApiError } from "@/lib/youtube";

export const runtime = "nodejs";

/**
 * POST /api/competitors/resolve
 *
 * Body: { input: string }
 *
 * Accepts a full YouTube URL, a @handle, a bare handle, or a UC channel id.
 * Calls the YouTube Data API once (resolveChannel handles all four shapes)
 * and returns the metadata the /competitors page needs to render a card
 * before the user clicks "Add". No DB writes happen here.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const input = typeof (body as { input?: unknown })?.input === "string"
    ? ((body as { input: string }).input).trim()
    : "";
  if (!input) {
    return NextResponse.json({ error: "input required" }, { status: 400 });
  }

  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "YouTube API key missing — set it in /settings/integrations" },
      { status: 400 }
    );
  }

  try {
    const channel = await resolveChannel(input, apiKey);
    return NextResponse.json({
      channel_id: channel.id,
      channel_name: channel.title,
      handle: channel.handle,
      thumbnail_url: channel.thumbnail,
      subscriber_count: channel.subscribers,
    });
  } catch (err) {
    if (err instanceof YouTubeApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const msg = err instanceof Error ? err.message : "resolve failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
