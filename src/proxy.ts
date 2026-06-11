import { NextRequest, NextResponse } from "next/server";

/**
 * Basic Auth gate for cloud deploys.
 *
 * (This file used to be `src/middleware.ts` — Next 16 deprecated that
 * convention in favour of `proxy.ts` with the same shape. Same idea,
 * just a renamed entry point.)
 *
 * Locally we don't want a login dialog every time `npm run dev` runs, so
 * the proxy is a no-op when `APP_USERNAME` / `APP_PASSWORD` are unset.
 * On Railway / production we set both env vars and the browser shows
 * its native HTTP Basic prompt — minimal UI, zero React work, same
 * credentials cached for the whole session.
 *
 * Why Basic Auth and not a form login: this is a single-tenant demo gate.
 * One known user, one credential, no signup flow. Anything more would be
 * over-engineered for the use case. If we ever ship multi-user we'll
 * swap this out for a real auth provider.
 *
 * Runs on the Edge runtime (default in Next 16). We use `atob()` instead
 * of `Buffer.from()` to stay Edge-compatible.
 */

// Constant-time-ish string comparison. Not cryptographically perfect on
// JS engines (V8 may short-circuit) but enough to avoid the most obvious
// timing leak in a single-credential gate.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function proxy(req: NextRequest) {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;

  // Local dev / unconfigured deploy → no gate. This is intentional so
  // someone running `npm run dev` after a fresh clone never has to mess
  // with env vars just to see the app.
  if (!username || !password) return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      // `atob` is global in Edge runtime; Node has it from 18+.
      const decoded = atob(auth.slice(6));
      const sep = decoded.indexOf(":");
      if (sep > 0) {
        const user = decoded.slice(0, sep);
        const pass = decoded.slice(sep + 1);
        if (safeEqual(user, username) && safeEqual(pass, password)) {
          return NextResponse.next();
        }
      }
    } catch {
      // malformed base64 — fall through to 401
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      // The realm string shows up in some browsers' login dialog title.
      // Keep it short and recognisable.
      "WWW-Authenticate": 'Basic realm="Lat Media Ideation Tool", charset="UTF-8"',
    },
  });
}

export const config = {
  // Match all routes except:
  //   - Next's static asset paths (no data leak, avoid login dialog's
  //     background requests bouncing off 401s in some browsers)
  //   - /api/health — Railway's healthcheck probe ships no auth headers,
  //     so without this exemption the deploy never goes live
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/health).*)",
  ],
};
