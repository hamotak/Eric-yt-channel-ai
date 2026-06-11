import { NextResponse } from "next/server";
import { getImageRunView } from "@/lib/image-studio/processor";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const run = await getImageRunView(id);
  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ run });
}
