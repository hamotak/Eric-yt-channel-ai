import { NextResponse } from "next/server";
import {
  consumePendingChannelId,
  consumeState,
  exchangeCode,
  markIssuedNow,
} from "@/lib/google-oauth";

export const runtime = "nodejs";

/**
 * Google redirects back here with either
 *   ?code=...&state=...     on success, or
 *   ?error=access_denied&state=...  on user cancel.
 *
 * We always redirect back to /integrations with a status query param so the
 * UI can show a toast / banner.
 */
/**
 * Same logic as oauth/start: behind Railway's proxy `req.url` reports an
 * internal hostname, so we build the public origin from env var or
 * X-Forwarded-* headers. Origin MUST match what `oauth/start` used —
 * Google's token exchange validates redirect_uri equality.
 */
function resolveOrigin(req: Request): string {
  const envBase = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (envBase) return envBase;
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || "https";
  const fwdHost =
    req.headers.get("x-forwarded-host")?.split(",")[0].trim() ||
    req.headers.get("host");
  if (fwdHost) return `${proto}://${fwdHost}`;
  return new URL(req.url).origin;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = resolveOrigin(req);
  const redirectBack = (params: Record<string, string>): NextResponse => {
    const to = new URL("/settings/integrations", origin);
    for (const [k, v] of Object.entries(params)) {
      to.searchParams.set(k, v);
    }
    to.hash = "youtube-analytics";
    return NextResponse.redirect(to, { status: 302 });
  };

  const error = url.searchParams.get("error");
  if (error) {
    return redirectBack({ oauth: "error", reason: error });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    return redirectBack({ oauth: "error", reason: "missing_code" });
  }
  if (!consumeState(state)) {
    return redirectBack({ oauth: "error", reason: "bad_state" });
  }

  // The pending pointer was set by /api/youtube/oauth/start when the
  // user clicked "Connect" on a specific channel row. We consume it
  // here (clears the setting in one go) so subsequent flows start fresh.
  const pendingChannelId = consumePendingChannelId();

  try {
    await exchangeCode(code, origin, pendingChannelId);
    markIssuedNow(pendingChannelId);

    // Reset any stale denial state for this channel so the next analytics
    // call actually retries. Without this, a previous Manager-tier 403
    // that flipped revenueAccess to "denied" would still short-circuit
    // the monetary report after the user reconnects with the right
    // account.
    if (pendingChannelId) {
      const { setSetting, invalidateCache } = await import("@/lib/db");
      setSetting(`analytics.revenueAccess.${pendingChannelId}`, "");
      // Bust analytics caches for this channel so old "denied" payloads
      // don't keep being served until TTL expires.
      invalidateCache(`analytics.revenue.v2.${pendingChannelId}.`);
      invalidateCache(`analytics.overview.v2.${pendingChannelId}.`);
      invalidateCache(`analytics.video.v3.${pendingChannelId}.`);
      invalidateCache(`analytics.revenue-multi.`);
    }

    return redirectBack({ oauth: "connected" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "token_exchange_failed";
    return redirectBack({ oauth: "error", reason: message.slice(0, 200) });
  }
}
