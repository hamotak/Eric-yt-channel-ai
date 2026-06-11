import { NextResponse } from "next/server";
import { previewImageRunPlan } from "@/lib/image-studio/processor";
import type { ImageGenerationMode } from "@/lib/image-studio/types";

export const runtime = "nodejs";

async function parseRequest(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    prompt?: unknown;
    title?: unknown;
    sourceIdeaId?: unknown;
    sampleCount?: unknown;
    aspectRatio?: unknown;
    resolution?: unknown;
    aiAssist?: unknown;
    generationMode?: unknown;
  };
  const generationMode: ImageGenerationMode =
    body.generationMode === "remix" ? "remix" : "generate";
  return {
    prompt:
      typeof body.prompt === "string"
        ? body.prompt
        : typeof body.title === "string"
          ? body.title
          : "",
    sourceIdeaId:
      typeof body.sourceIdeaId === "string" ? body.sourceIdeaId : null,
    sampleCount:
      typeof body.sampleCount === "number"
        ? body.sampleCount
        : Number(body.sampleCount ?? 1),
    aspectRatio:
      typeof body.aspectRatio === "string" ? body.aspectRatio : "16:9",
    resolution:
      typeof body.resolution === "string" ? body.resolution : "1k",
    aiAssist: body.aiAssist === true,
    generationMode,
    attachments: [],
  };
}

export async function POST(req: Request) {
  try {
    const plan = await previewImageRunPlan(await parseRequest(req));
    return NextResponse.json(plan);
  } catch (err) {
    const message = err instanceof Error ? err.message : "image planning failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
