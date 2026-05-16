import { NextResponse } from "next/server";
import { channelAnalytics, getChannel, videoStats } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Returns channel, stats, and deep analytics. Defaults to the active
 * channel; `?channelId=<id>` overrides — used by /channel-info when the
 * user clicks a row in the "All channels" summary table (sets
 * ?focus=<id>) and the detail widgets need to reflect THAT channel
 * regardless of which one is active in the global picker.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const explicit = url.searchParams.get("channelId");
  const channelId = explicit && explicit.length > 0 ? explicit : null;
  const channel = getChannel(channelId);
  if (!channel) return NextResponse.json({ channel: null });
  const stats = videoStats(channelId);
  // Deep analytics bundle — everything we can compute from the local
  // `videos` + `transcripts` tables, no external API calls. Drives the
  // Channel Details section of /channel-info. Returns `null` if there
  // are no videos yet.
  const analytics = channelAnalytics(channelId);
  return NextResponse.json({ channel, stats, analytics });
}
