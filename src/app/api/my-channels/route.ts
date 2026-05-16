import { NextResponse } from "next/server";
import {
  Channel,
  ChannelContextField,
  listAllChannels,
  updateChannelContext,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * Per-channel context page. GET returns every channel with its 5 context
 * fields (niche, positioning, audience, voice, externalSources) in the
 * wire-side camelCase shape. PATCH updates a single field on a single
 * channel — the page edits one field at a time, so batch upsert is
 * unnecessary and just adds an attack surface for partial writes.
 *
 * Intentionally NOT scoped by getActiveChannelId(): the page lists every
 * channel the user manages so they can fill context in one sitting.
 */

type WireField =
  | "niche"
  | "positioning"
  | "audience"
  | "voice"
  | "externalSources";

const WIRE_TO_DB: Record<WireField, ChannelContextField> = {
  niche: "niche",
  positioning: "positioning",
  audience: "audience",
  voice: "voice",
  externalSources: "external_sources",
};

const WIRE_FIELDS = Object.keys(WIRE_TO_DB) as WireField[];

type ChannelContextWire = {
  id: string;
  channelId: string;
  title: string | null;
  handle: string | null;
  subscriberCount: number | null;
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

  const dbField = WIRE_TO_DB[field as WireField];
  const updated = updateChannelContext(channelId, dbField, value);
  if (!updated) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  return NextResponse.json({ channel: toWire(updated) });
}
