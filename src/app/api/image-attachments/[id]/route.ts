import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { resolveAttachmentPath } from "@/lib/image-studio/processor";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const attachment = resolveAttachmentPath(id);
  if (!attachment) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const bytes = await fs.readFile(attachment.path);
    return new Response(bytes, {
      headers: {
        "Content-Type": attachment.contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "attachment missing" }, { status: 404 });
  }
}
