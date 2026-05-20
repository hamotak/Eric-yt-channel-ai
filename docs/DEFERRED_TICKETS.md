# Deferred tickets

Tickets surfaced during the May 2026 /ideate redesign session that we chose not to ship in-session. Bring up when relevant.

## FIX-H — Harden findProjectRoot() in src/lib/db.ts

The current findProjectRoot() resolves to the first ancestor directory containing package.json. If the dev server starts while cwd is a stale path (e.g. a deleted folder still in the shell's history), better-sqlite3 creates a fresh empty DB at that path and the running process holds an open FD to it indefinitely — the app appears to "lose all data" even though the real DB is untouched at the correct path.

Workaround: prefix `npm run dev` with `DATA_DIR=/Users/hamidaliyev/Eric-yt-channel-ai-main/data` to force the correct location.

Proper fix: extend findProjectRoot() to verify the resolved root actually contains the expected sibling files (next.config.*, src/lib/db.ts, src/app/) and refuse to open a DB at a path that fails that check. Fail loud with an error message pointing to the DATA_DIR override. Optionally add a startup check that compares the resolved root against a stored canonical path (e.g. .project-root marker file written on first init).

## FIX-K — Investigate Tier 3 audit candidates (RESOLVED 2026-05-21)

Three sub-tasks, all closed:

- ✓ `/api/competitors/sync-queued` — **alive**, called from `/api/competitors/[id]/sync/route.ts:32` via a fire-and-forget `fetch`. The audit's flag was a false negative from the earlier `[id]→empty` regex bug, fixed in the audit-script patch shipped with PRIO-11.
- ✓ `src/lib/claude-pricing.ts` — **alive**, `costMillicents` is imported by `src/lib/ideate/pipeline.ts:10` via `from "../claude-pricing"`. Audit didn't catch parent-sibling (`../foo`) relative imports — that hole is now patched in `scripts/dead-code-audit.sh`.
- ✓ Chat-session helpers in `src/lib/db.ts` — all 14 symbols (3 types + 11 functions) had zero non-self callers; ~246 lines deleted. `chat_sessions` and `chat_messages` CREATE TABLE blocks deleted; the existing module-init `DROP TABLE IF EXISTS` cleans residual data on next boot.

Only outstanding minor item: `formatUsdFromMillicents` is exported from `claude-pricing.ts` with zero callers. Dead export inside an otherwise live file. Not worth a follow-up ticket — pick up incidentally.
