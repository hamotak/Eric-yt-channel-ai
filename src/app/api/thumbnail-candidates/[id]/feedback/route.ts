import { NextResponse } from "next/server";
import { setImageCandidateFeedback } from "@/lib/image-studio/processor";
import type { ImageFeedback } from "@/lib/image-studio/types";

export const runtime = "nodejs";

const VALID_FEEDBACK = new Set<ImageFeedback>(["accepted", "rejected"]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { feedback, reason } = (body ?? {}) as {
    feedback?: unknown;
    reason?: unknown;
  };
  if (typeof feedback !== "string" || !VALID_FEEDBACK.has(feedback as ImageFeedback)) {
    return NextResponse.json(
      { error: "feedback must be accepted or rejected" },
      { status: 400 }
    );
  }
  try {
    setImageCandidateFeedback({
      candidateId: id,
      feedback: feedback as ImageFeedback,
      reason: typeof reason === "string" ? reason : null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "feedback failed";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
