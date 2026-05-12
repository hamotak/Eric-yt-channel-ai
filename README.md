# Eric YT Channel AI

A local AI-powered YouTube channel analytics platform: YouTube Studio-style dashboard (views, watch time, subscribers, audience, traffic, revenue), retention curves, video hook analyzer, AI chat with Claude over all your imported data, automatic transcript extraction, comment & competitor analysis.

> **This project runs locally on your computer.** All data lives in `data/app.db` next to this README. API keys are entered once on the **Integrations** page and stored in the local SQLite database — nothing is uploaded anywhere.

## Quick start

Full step-by-step setup for someone who has never worked with code is in **[INSTALL.md](./INSTALL.md)**. Short version:

1. Install Node.js 20+ from [nodejs.org](https://nodejs.org/)
2. Download this repo — either as a ZIP from the green **Code** button above, or `git clone https://github.com/Bander4ik/Eric-yt-channel-ai.git`
3. Run `install.bat` (Windows) or `install.command` (macOS) — installs dependencies
4. Run `start.bat` (Windows) or `start.command` (macOS) — opens the app in your browser at `http://localhost:3000`
5. Open **Integrations** and add your keys (minimum: Claude + Deepgram)

## What it does

A web dashboard (opens in your browser at `localhost:3000`) that connects to:

- **Claude (Anthropic)** — AI analysis and chat about your channel (required)
- **Deepgram** — local video transcription (≈$0.0043/min)
- **YouTube Data API** — video details, stats, captions
- **Google OAuth** — your own Analytics + monetization data
- **Apify** (optional) — fallback path for transcription + competitor scraping
- **Exa** (optional) — semantic web search for niche research
- **Google Gemini** (optional) — second AI brain for chat

## Where your data lives

Everything is in the `data/` folder next to this README (a single `app.db` SQLite file). To reset, just delete that folder — it gets recreated on next launch.

API keys, OAuth tokens, chat history, transcripts, analytics cache — all there. Nothing ever leaves your machine.

## Tech stack

- Next.js 16 (App Router) + React 19
- TypeScript + Tailwind CSS v4
- SQLite (`better-sqlite3`) in WAL mode with `synchronous=FULL` — data survives hard shutdowns
- Anthropic SDK (Claude) + Google Generative AI (Gemini)
- yt-dlp (via `youtube-dl-exec`) → Deepgram for transcription

## How to stop the app

Just close the terminal window the server is running in. The database closes cleanly on shutdown — nothing is lost.
