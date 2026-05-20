import { NextResponse } from "next/server";
import {
  Channel,
  ChannelContextField,
  listAllChannels,
  updateChannelContext,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * Per-channel context page. GET returns every channel with the agent's
 * brain fields (channel_description + ideation_rules) plus the legacy
 * 5-field bundle preserved for read-side compatibility. PATCH writes
 * one field at a time.
 *
 * Intentionally NOT scoped by getActiveChannelId(): the page lists every
 * channel the user manages so they can fill context in one sitting.
 *
 * The legacy fields (niche / positioning / audience / voice /
 * externalSources) are still WRITABLE — they're not surfaced in the
 * redesigned UI, but the chat tool `update_channel_context` retains
 * them in its input schema so older agent prompts don't break.
 */

type WireField =
  | "channelDescription"
  | "ideationRules"
  | "bannedTopics"
  | "niche"
  | "positioning"
  | "audience"
  | "voice"
  | "externalSources";

const WIRE_TO_DB: Record<WireField, ChannelContextField> = {
  channelDescription: "channel_description",
  ideationRules: "ideation_rules",
  bannedTopics: "banned_topics",
  niche: "niche",
  positioning: "positioning",
  audience: "audience",
  voice: "voice",
  externalSources: "external_sources",
};

const WIRE_FIELDS = Object.keys(WIRE_TO_DB) as WireField[];

// Server-side caps so a runaway client can't blow the column. Mirrors
// the editor component limits exactly.
const FIELD_CAPS: Partial<Record<WireField, number>> = {
  channelDescription: 1500,
  ideationRules: 1200,
  bannedTopics: 500,
};

type ChannelContextWire = {
  id: string;
  channelId: string;
  title: string | null;
  handle: string | null;
  subscriberCount: number | null;
  channelDescription: string;
  ideationRules: string;
  bannedTopics: string;
  // Legacy fields still surfaced so older clients reading the GET
  // response don't break; the redesigned UI ignores them.
  niche: string;
  positioning: string;
  audience: string;
  voice: string;
  externalSources: string;
};

function toWire(c: Channel): ChannelContextWire {
  return {
    id: c.id,
    channelId: c.id,
    title: c.title,
    handle: c.handle,
    subscriberCount: c.subscriber_count,
    channelDescription: c.channel_description ?? "",
    ideationRules: c.ideation_rules ?? "",
    bannedTopics: c.banned_topics ?? "",
    niche: c.niche ?? "",
    positioning: c.positioning ?? "",
    audience: c.audience ?? "",
    voice: c.voice ?? "",
    externalSources: c.external_sources ?? "",
  };
}

export async function GET() {
  const channels = listAllChannels();
  const sorted = [...channels].sort((a, b) =>
    (a.title ?? "").localeCompare(b.title ?? "", undefined, {
      sensitivity: "base",
    })
  );
  return NextResponse.json({ channels: sorted.map(toWire) });
}

export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    channelId?: unknown;
    field?: unknown;
    value?: unknown;
  };

  const { channelId, field, value } = body;

  if (typeof channelId !== "string" || channelId.length === 0) {
    return NextResponse.json(
      { error: "channelId must be a non-empty string" },
      { status: 400 }
    );
  }
  if (
    typeof field !== "string" ||
    !WIRE_FIELDS.includes(field as WireField)
  ) {
    return NextResponse.json(
      { error: `field must be one of: ${WIRE_FIELDS.join(", ")}` },
      { status: 400 }
    );
  }
  if (typeof value !== "string") {
    return NextResponse.json(
      { error: "value must be a string" },
      { status: 400 }
    );
  }
  const cap = FIELD_CAPS[field as WireField];
  if (typeof cap === "number" && value.length > cap) {
    return NextResponse.json(
      { error: `${field} exceeds ${cap} char limit (got ${value.length})` },
      { status: 400 }
    );
  }

  const dbField = WIRE_TO_DB[field as WireField];
  const updated = updateChannelContext(channelId, dbField, value);
  if (!updated) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  return NextResponse.json({ channel: toWire(updated) });
}
