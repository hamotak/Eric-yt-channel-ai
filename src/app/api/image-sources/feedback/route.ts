import { NextResponse } from "next/server";
import { setImageSourceFeedback } from "@/lib/image-studio/processor";
import type { ImageReference } from "@/lib/image-studio/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      source?: Partial<ImageReference>;
      feedback?: unknown;
      reason?: unknown;
      topicKey?: unknown;
    };
    const feedback = body.feedback;
    if (feedback !== "liked" && feedback !== "disliked") {
      return NextResponse.json(
        { error: "feedback must be liked or disliked" },
        { status: 400 }
      );
    }
    const source = body.source;
    if (
      !source ||
      typeof source.id !== "string" ||
      typeof source.kind !== "string" ||
      typeof source.title !== "string" ||
      typeof source.thumbnailUrl !== "string"
    ) {
      return NextResponse.json(
        { error: "source id, kind, title, and thumbnailUrl are required" },
        { status: 400 }
      );
    }
    setImageSourceFeedback({
      source: {
        id: source.id,
        kind: source.kind as ImageReference["kind"],
        videoId: typeof source.videoId === "string" ? source.videoId : null,
        title: source.title,
        channelName:
          typeof source.channelName === "string" ? source.channelName : null,
        channelHandle:
          typeof source.channelHandle === "string" ? source.channelHandle : null,
        thumbnailUrl: source.thumbnailUrl,
        views: typeof source.views === "number" ? source.views : null,
        medianViews:
          typeof source.medianViews === "number" ? source.medianViews : null,
        multiplier:
          typeof source.multiplier === "number" ? source.multiplier : null,
        reason: typeof source.reason === "string" ? source.reason : "",
        relevanceScore:
          typeof source.relevanceScore === "number"
            ? source.relevanceScore
            : undefined,
        relevanceLabels: Array.isArray(source.relevanceLabels)
          ? source.relevanceLabels.filter(
              (item): item is string => typeof item === "string"
            )
          : undefined,
        feedback: null,
        feedbackReason: null,
      },
      feedback,
      reason: typeof body.reason === "string" ? body.reason : null,
      topicKey: typeof body.topicKey === "string" ? body.topicKey : null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "source feedback failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
