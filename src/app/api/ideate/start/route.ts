import { NextResponse } from "next/server";
import { db, getActiveChannelId } from "@/lib/db";
import {
  createGeneration,
  runPipeline,
  countProcessingGenerations,
  hasProcessingForChannel,
  MAX_QUEUED_GENERATIONS,
  type Mode,
} from "@/lib/ideate/pipeline";
import { log } from "@/lib/logger";
import { hasRedditSignalProvider, parseSubredditSources } from "@/lib/reddit";

export const runtime = "nodejs";

const VALID_MODES: ReadonlySet<Mode> = new Set<Mode>([
  "auto",
  "new_angles",
  "title_tweaks",
  "reddit_angles",
]);

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { mode, count, competitorLimit } = (body ?? {}) as {
    mode?: unknown;
    count?: unknown;
    competitorLimit?: unknown;
  };

  if (typeof mode !== "string" || !VALID_MODES.has(mode as Mode)) {
    return NextResponse.json(
      { error: "mode must be one of: auto, new_angles, title_tweaks, reddit_angles" },
      { status: 400 }
    );
  }
  const countNum = typeof count === "number" ? Math.floor(count) : Number(count);
  if (!Number.isFinite(countNum) || countNum < 10 || countNum > 25) {
    return NextResponse.json(
      { error: "count must be an integer 10-25" },
      { status: 400 }
    );
  }

  const activeChannelId = getActiveChannelId();
  if (!activeChannelId) {
    return NextResponse.json(
      { error: "no active channel — connect one from the top-right channel switcher" },
      { status: 400 }
    );
  }

  const channelRow = db
    .prepare(`SELECT reddit_sources FROM channels WHERE id = ?`)
    .get(activeChannelId) as { reddit_sources: string | null } | undefined;
  if (!channelRow) {
    return NextResponse.json(
      { error: `active channel not found in DB: ${activeChannelId}` },
      { status: 400 }
    );
  }

  const competitorCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM competitors
         WHERE user_channel_id = ? AND channel_id IS NOT NULL`
      )
      .get(activeChannelId) as { n: number }
  ).n;
  if (competitorCount === 0) {
    return NextResponse.json(
      { error: "add at least 1 competitor first" },
      { status: 400 }
    );
  }

  if (mode === "reddit_angles") {
    if (!hasRedditSignalProvider()) {
      return NextResponse.json(
        {
          error:
            "Brave Search API key missing — add it in /settings/integrations",
        },
        { status: 400 }
      );
    }
    const subreddits = parseSubredditSources(channelRow.reddit_sources);
    if (subreddits.length === 0) {
      return NextResponse.json(
        {
          error:
            "Add at least one Reddit source for this channel in /channel-info before using Reddit Angles",
        },
        { status: 400 }
      );
    }
  }

  if (hasProcessingForChannel(activeChannelId)) {
    return NextResponse.json(
      { error: "a generation is already in progress for this channel" },
      { status: 409 }
    );
  }

  if (countProcessingGenerations() >= MAX_QUEUED_GENERATIONS) {
    return NextResponse.json(
      {
        error: `too many concurrent generations (max ${MAX_QUEUED_GENERATIONS}). Wait for one to finish.`,
      },
      { status: 429 }
    );
  }

  const limitNum = typeof competitorLimit === "number" ? Math.floor(competitorLimit) : null;
  const runOptions = limitNum && limitNum > 0 ? { competitorLimit: limitNum } : {};

  const requestId = createGeneration({
    userChannelId: activeChannelId,
    mode: mode as Mode,
    count: countNum,
  });

  setImmediate(() => {
    runPipeline(requestId, runOptions).catch((err) => {
      log.error("ideate", "runPipeline crashed in background", err, { requestId });
    });
  });

  return NextResponse.json({ request_id: requestId, status: "processing" });
}
