import { NextResponse } from "next/server";
import {
  createImageRun,
  listImageRunHistory,
  startImagePipeline,
} from "@/lib/image-studio/processor";
import type { ImageGenerationMode } from "@/lib/image-studio/types";

export const runtime = "nodejs";

async function parseRequest(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const files = form
      .getAll("attachments")
      .filter((item): item is File => item instanceof File);
    const attachments = await Promise.all(
      files.map(async (file) => ({
        fileName: file.name || "attachment",
        contentType: file.type || "application/octet-stream",
        bytes: Buffer.from(await file.arrayBuffer()),
      }))
    );
    return {
      prompt: String(form.get("prompt") ?? ""),
      sourceIdeaId: String(form.get("sourceIdeaId") ?? "") || null,
      sampleCount: Number(form.get("sampleCount") ?? 1),
      aspectRatio: String(form.get("aspectRatio") ?? "16:9"),
      resolution: String(form.get("resolution") ?? "1k"),
      aiAssist: String(form.get("aiAssist") ?? "false") === "true",
      generationMode:
        String(form.get("generationMode") ?? "generate") === "remix"
          ? ("remix" as const)
          : ("generate" as const),
      attachments,
    };
  }

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
      typeof body.sampleCount === "number" ? body.sampleCount : Number(body.sampleCount ?? 1),
    aspectRatio:
      typeof body.aspectRatio === "string" ? body.aspectRatio : "16:9",
    resolution:
      typeof body.resolution === "string" ? body.resolution : "1k",
    aiAssist: body.aiAssist === true,
    generationMode,
    attachments: [],
  };
}

export async function GET() {
  return NextResponse.json({ history: listImageRunHistory() });
}

export async function POST(req: Request) {
  try {
    const input = await parseRequest(req);
    const runId = await createImageRun(input);
    startImagePipeline(runId);
    return NextResponse.json({ request_id: runId, status: "processing" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "image run failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
