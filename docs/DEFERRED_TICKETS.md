# Deferred tickets

Tickets surfaced during the May 2026 /ideate redesign session that we chose not to ship in-session. Bring up when relevant.

## FIX-H — Harden findProjectRoot() in src/lib/db.ts

The current findProjectRoot() resolves to the first ancestor directory containing package.json. If the dev server starts while cwd is a stale path (e.g. a deleted folder still in the shell's history), better-sqlite3 creates a fresh empty DB at that path and the running process holds an open FD to it indefinitely — the app appears to "lose all data" even though the real DB is untouched at the correct path.

Workaround: prefix `npm run dev` with `DATA_DIR=/Users/hamidaliyev/Eric-yt-channel-ai-main/data` to force the correct location.

Proper fix: extend findProjectRoot() to verify the resolved root actually contains the expected sibling files (next.config.*, src/lib/db.ts, src/app/) and refuse to open a DB at a path that fails that check. Fail loud with an error message pointing to the DATA_DIR override. Optionally add a startup check that compares the resolved root against a stored canonical path (e.g. .project-root marker file written on first init).

## FIX-K — Investigate Tier 3 audit candidates

Two candidates flagged in the PRIO-11 dead-code audit need deeper investigation before removal:

- Competitor sync/alerts routes: some may be hit by the sync-queued worker (itself orphan-flagged but may be polled from elsewhere). Need to trace the polling path before deciding.
- claude-pricing.ts: verify db.ts cost-tracking still works without it before deleting. Run a generation, confirm the $cost field in the generations table is still populated.

Resolve as a focused 30-min audit in a future session.
