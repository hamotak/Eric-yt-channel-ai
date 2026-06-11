import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { resolveCandidateImagePath } from "@/lib/image-studio/processor";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const image = resolveCandidateImagePath(id);
  if (!image) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const bytes = await fs.readFile(image.path);
    return new Response(bytes, {
      headers: {
        "Content-Type": image.contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "image missing" }, { status: 404 });
  }
}
