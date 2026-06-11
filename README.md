# Eric YT Channel AI

Eric YT Channel AI is a local browser app for running YouTube channel work in one place. It helps with channel notes, video ideation, competitor research, thumbnail planning, and AI-assisted thumbnail generation.

The app runs on your computer at `http://localhost:3000`. It is not a hosted SaaS app.

## Plain-English Overview

Use this app when you want to:

- keep channel strategy, positioning, audience notes, and rules in one place;
- generate and review video ideas for a selected channel;
- compare competitor channels and outlier videos;
- create thumbnail directions in Image Studio;
- generate thumbnail options through 69labs;
- track AI/API usage and app logs locally.

All private data lives on this machine unless an integration API is called for a specific task.

## Main App Areas

- **Ideate**: creates video ideas for the active YouTube channel, using channel context, recent uploads, competitors, and learned feedback.
- **Image Studio**: plans thumbnail directions, picks useful source thumbnails, and sends final image generation jobs to 69labs.
- **Channel Info**: stores the channel brief, audience, positioning, voice, banned topics, Reddit sources, and thumbnail style notes.
- **Competitors**: saves competitor channels, syncs their metadata, and helps compare useful outliers.
- **Settings > Integrations**: where API keys are entered.
- **Settings > Logs**: shows local app logs for debugging.

The top-right channel switcher controls which channel the app is currently working on.

## Integrations

API keys are entered inside the running app at **Settings > Integrations**. They are stored in the local SQLite database, not in Git.

Current integrations:

- **OpenAI**: default Image Studio thumbnail planner and visual analysis.
- **Claude (Anthropic)**: fallback planner and existing AI workflows.
- **YouTube Data API**: channel/video sync and metadata.
- **Brave Search**: Reddit/web signals for ideation.
- **69labs**: final image generation for thumbnails.

Do not paste browser session tokens. Use real provider API keys.

## Local Data And Secrets

Local data is stored in:

- `data/app.db` for SQLite app data;
- `.env` for optional local environment overrides.

These files are intentionally ignored by Git:

- `.env`
- `.env.local`
- `.env.development`
- `.env.production`
- `data/`
- `.next/`
- `node_modules/`

Never commit API keys, SQLite databases, generated build folders, or local screenshots with private information.

Only `.env.example` should be committed as a safe template.

## Quick Start

1. Install Node.js 20 or newer from [nodejs.org](https://nodejs.org/).
2. Clone the repo:

   ```bash
   git clone https://github.com/hamotak/Eric-yt-channel-ai.git
   cd Eric-yt-channel-ai
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:3000`.
6. Go to **Settings > Integrations** and add the needed API keys.

Mac users can also use `install.command` and `start.command`. Windows users can use `install.bat` and `start.bat`.

## Developer Notes

Important implementation details:

- The app uses **Next.js 16 App Router**, **React 19**, **TypeScript**, and **Tailwind CSS**.
- The local database uses **SQLite** through `better-sqlite3`.
- Image Studio code lives mainly under `src/lib/image-studio/` and `src/app/image-studio/`.
- Provider/API routes live under `src/app/api/`.
- The app is designed for local operation; do not assume cloud hosting or shared storage.

Before publishing changes, run:

```bash
node scripts/verify-image-studio-behavior.cjs
node scripts/verify-ideate-behavior.cjs
npx tsc --noEmit --pretty false
npx next build
```

## Git Safety Checklist

Before pushing to GitHub:

1. Run `git status --short`.
2. Confirm `.env` and `data/` are not staged.
3. Confirm only `.env.example` appears if searching tracked env files.
4. Run a quick secret scan for real API keys.
5. Push only to the intended remote, usually `origin`.

GitHub repo:

https://github.com/hamotak/Eric-yt-channel-ai
