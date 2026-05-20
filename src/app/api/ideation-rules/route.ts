import { NextResponse } from "next/server";
import { db, getActiveChannelId } from "@/lib/db";

export const runtime = "nodejs";

type RuleRow = {
  id: number;
  user_channel_id: string;
  rule_type: string;
  rule_value: string;
  source_note: string | null;
  source_idea_id: string | null;
  pending: number;
  created_at: string;
};

/**
 * GET /api/ideation-rules?channelId=UC...
 *
 * Returns all ideation_rules rows for the given channel (or the active
 * channel if no param), sorted newest-first. Used by the Learned Rules
 * panel on /channel-info.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelId =
    url.searchParams.get("channelId") ?? getActiveChannelId();
  if (!channelId) {
    return NextResponse.json({ rules: [], channelId: null });
  }
  const rows = db
    .prepare(
      `SELECT id, user_channel_id, rule_type, rule_value, source_note,
              source_idea_id, pending, created_at
       FROM ideation_rules
       WHERE user_channel_id = ?
       ORDER BY pending DESC, created_at DESC`
    )
    .all(channelId) as RuleRow[];

  return NextResponse.json({
    channelId,
    rules: rows.map((r) => ({
      id: r.id,
      ruleType: r.rule_type,
      ruleValue: r.rule_value,
      sourceNote: r.source_note,
      sourceIdeaId: r.source_idea_id,
      pending: r.pending === 1,
      createdAt: r.created_at,
    })),
  });
}
