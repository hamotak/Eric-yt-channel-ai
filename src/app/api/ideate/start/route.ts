import { NextResponse } from "next/server";
import { db, getActiveChannelId } from "@/lib/db";
import {
  createGeneration,
  runPipeline,
  estimateCostMillicents,
  dailyBudgetSpentMillicents,
  dailyBudgetResetIso,
  countProcessingGenerations,
  hasProcessingForChannel,
  DAILY_IDEATION_BUDGET_MILLICENTS,
  MAX_QUEUED_GENERATIONS,
  type Mode,
} from "@/lib/ideate/pipeline";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

const VALID_MODES: ReadonlySet<Mode> = new Set<Mode>(["auto", "new_angles", "title_tweaks"]);

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
      { error: "mode must be one of: auto, new_angles, title_tweaks" },
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
    .prepare(`SELECT 1 AS x FROM channels WHERE id = ?`)
    .get(activeChannelId) as { x: number } | undefined;
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

  const proposedCost = estimateCostMillicents(countNum);
  const spentToday = dailyBudgetSpentMillicents();
  if (spentToday + proposedCost > DAILY_IDEATION_BUDGET_MILLICENTS) {
    return NextResponse.json(
      {
        error: "daily ideation budget reached, resets at <ISO timestamp>".replace(
          "<ISO timestamp>",
          dailyBudgetResetIso()
        ),
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
