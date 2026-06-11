import { NextResponse } from "next/server";
import {
  createImageRun,
  startImagePipeline,
} from "@/lib/image-studio/processor";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { title, prompt, sourceIdeaId, sampleCount } = (body ?? {}) as {
    title?: unknown;
    prompt?: unknown;
    sourceIdeaId?: unknown;
    sampleCount?: unknown;
  };

  try {
    const runId = await createImageRun({
      prompt:
        typeof prompt === "string"
          ? prompt
          : typeof title === "string"
            ? title
            : "",
      sourceIdeaId: typeof sourceIdeaId === "string" ? sourceIdeaId : null,
      sampleCount:
        typeof sampleCount === "number" ? sampleCount : Number(sampleCount ?? 1),
      aspectRatio: "16:9",
      aiAssist: true,
      generationMode: "remix",
    });
    startImagePipeline(runId);
    return NextResponse.json({ request_id: runId, status: "processing" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "image run failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
