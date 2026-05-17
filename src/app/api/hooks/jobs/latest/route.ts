import { NextResponse } from "next/server";
import { getLatestHookAnalysisJob } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Latest hook-analysis job (running or finished). The Hook Lab banner
 * polls this every couple of seconds while a batch is in flight, then
 * stops once the row goes to completed/failed/cancelled.
 */
export async function GET() {
  const job = getLatestHookAnalysisJob();
  return NextResponse.json({ job: job ?? null });
}
