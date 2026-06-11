# Lat Media Ideation Tool

Lat Media Ideation Tool is an internal YouTube workflow app for turning channel context, competitor signals, recent performance, and thumbnail references into better video ideas and thumbnail directions.

The app is built for a technical operator or developer who needs to understand how the system works, where the data lives, and which parts are safe to change.

## Product Map

- **Ideate** creates video ideas for the active channel using channel notes, recent uploads, competitors, saved feedback, Reddit/web signals, and the mentor method prompt in `MENTOR_METHOD.md`.
- **Image Studio** plans thumbnail directions, collects source references, analyzes winning and losing thumbnails, and sends final render jobs to 69labs.
- **Channel Info** stores the operating brief for each channel: audience, positioning, rules, tone, thumbnail style notes, banned topics, and source preferences.
- **Competitors** tracks competitor channels and videos so the app can find useful outliers and patterns.
- **Settings > Integrations** stores provider API keys in SQLite.
- **Settings > Usage** shows AI/API usage and cost history.
- **Settings > Logs** exposes local app logs for debugging.

The top-right channel switcher controls the active channel across the app.

## Architecture

- **Framework**: Next.js 16 App Router, React 19, TypeScript, Tailwind CSS.
- **Database**: SQLite through `better-sqlite3`.
- **App routes**: `src/app/`.
- **API routes**: `src/app/api/`.
- **Shared app logic**: `src/lib/`.
- **Image Studio pipeline**: `src/lib/image-studio/` and `src/app/image-studio/`.
- **Ideation pipeline**: `src/lib/ideate/`.
- **Reusable UI**: `src/components/`.
- **Verification scripts**: `scripts/verify-*.cjs`.

Before changing Next.js app/router behavior, read the matching guide in `node_modules/next/dist/docs/`. This repo uses Next.js 16 conventions, including `proxy.ts` instead of old middleware naming.

## Data And Secrets

Runtime data is intentionally local and ignored by Git:

- `data/app.db` stores channels, integrations, logs, usage, Image Studio runs, and local app state.
- `.env` can override local runtime settings.
- `.next/` and `node_modules/` are generated folders.

Provider keys are entered in **Settings > Integrations** and stored in SQLite. Do not commit real keys, local databases, screenshots with private data, generated build output, or downloaded media.

Only `.env.example` should be tracked as a safe template.

## Integrations

- **OpenAI**: default Image Studio planner and visual thumbnail analysis.
- **Claude / Anthropic**: fallback planner and existing AI workflows.
- **YouTube Data API**: channel, upload, and video metadata sync.
- **Brave Search**: Reddit/web research signals.
- **69labs**: thumbnail image rendering through Nano Banana Pro.

Use provider API keys. Do not use browser session tokens.

## Image Studio Flow

1. Read active channel context, selected references, recent videos, learned feedback, and style memory.
2. Build a planner context pack with recent winning and losing thumbnails.
3. Ask the planner for structured thumbnail directions.
4. Validate and clean each direction so prompts are safe for the render provider.
5. Submit render jobs to 69labs with a staggered launch cadence.
6. Poll each provider job, download completed images, and store provider telemetry.
7. Show compact candidate slots with source metadata, provider attempt details, and feedback controls.

The renderer remains 69labs Nano Banana Pro. Planning and prompt writing are separate from image generation.

## Ideation Flow

1. Load channel brief, style rules, recent uploads, competitors, and feedback.
2. Pull search/research signals when enabled.
3. Apply the mentor method from `MENTOR_METHOD.md`.
4. Generate, score, and store ideas for the selected channel.
5. Feed accepted/rejected feedback back into future ideation.

## Development

Requirements:

- Node.js 20 or newer.
- npm.

Common commands:

```bash
npm install
npm run dev
npx tsc --noEmit --pretty false
npx next build
```

The helper scripts `install.command`, `start.command`, `install.bat`, and `start.bat` are convenience launchers for non-technical local use. They are not the source of truth for deployment.

## Verification

Run these before publishing app changes:

```bash
node scripts/verify-image-studio-behavior.cjs
node scripts/verify-ideate-behavior.cjs
npx tsc --noEmit --pretty false
npx next build
```

For live provider checks, use the dedicated scripts in `scripts/` and keep sample counts low.

## Git Hygiene

Before pushing:

```bash
git status --short
git check-ignore -v .env .env.local .env.development .env.production data .next node_modules
git ls-files | rg '(^|/)\.env($|\.)|\.env'
```

The env-file search should only return `.env.example`.

Repository:

[hamotak/Lat-Media-Ideation-Tool](https://github.com/hamotak/Lat-Media-Ideation-Tool)
