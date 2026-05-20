import { NextResponse } from "next/server";
import { db, getActiveChannelId } from "@/lib/db";

export const runtime = "nodejs";

interface GenerationRow {
  id: string;
  user_channel_id: string;
  mode: string;
  count: number;
  status: "processing" | "completed" | "failed";
  estimated_cost_millicents: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface IdeaRow {
  id: string;
  title: string;
  description: string;
  source_attribution: string | null;
  validation_status: "passed" | "rejected";
  validation_reason: string | null;
  fit_score: number | null;
  user_note: string | null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const gen = db
    .prepare(
      `SELECT id, user_channel_id, mode, count, status,
              estimated_cost_millicents, started_at, completed_at, error
       FROM generations WHERE id = ?`
    )
    .get(id) as GenerationRow | undefined;

  if (!gen) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Authorization: channel must exist (acts as a soft owner check in a
  // single-user app — cross-channel pollers would still need a real channel id).
  const activeChannelId = getActiveChannelId();
  const channelExists = db
    .prepare(`SELECT 1 AS x FROM channels WHERE id = ?`)
    .get(gen.user_channel_id) as { x: number } | undefined;
  if (!channelExists) {
    return NextResponse.json({ error: "channel gone" }, { status: 403 });
  }

  if (gen.status === "processing") {
    const elapsedSeconds = Math.floor(
      (Date.now() - new Date(gen.started_at + "Z").getTime()) / 1000
    );
    return NextResponse.json({
      status: "processing",
      request_id: gen.id,
      mode: gen.mode,
      count: gen.count,
      started_at: gen.started_at,
      elapsed_seconds: Math.max(0, elapsedSeconds),
      is_active_channel: activeChannelId === gen.user_channel_id,
    });
  }

  if (gen.status === "failed") {
    return NextResponse.json({
      status: "failed",
      request_id: gen.id,
      mode: gen.mode,
      count: gen.count,
      error: gen.error ?? "unknown error",
      started_at: gen.started_at,
      completed_at: gen.completed_at,
    });
  }

  // completed
  const rows = db
    .prepare(
      `SELECT id, title, description, source_attribution, validation_status,
              validation_reason, fit_score, user_note
       FROM ideas WHERE generation_id = ?
       ORDER BY validation_status ASC, fit_score DESC, created_at ASC`
    )
    .all(id) as IdeaRow[];

  const ideas = rows
    .filter((r) => r.validation_status === "passed")
    .map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      fit_score: r.fit_score,
      user_note: r.user_note,
      source_attribution: r.source_attribution ? safeParse(r.source_attribution) : null,
    }));

  const rejected = rows
    .filter((r) => r.validation_status === "rejected")
    .map((r) => ({
      id: r.id,
      title: r.title,
      reason: r.validation_reason,
      fit_score: r.fit_score,
    }));

  return NextResponse.json({
    status: "completed",
    request_id: gen.id,
    mode: gen.mode,
    count: gen.count,
    started_at: gen.started_at,
    completed_at: gen.completed_at,
    estimated_cost_millicents: gen.estimated_cost_millicents,
    ideas,
    rejected,
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
