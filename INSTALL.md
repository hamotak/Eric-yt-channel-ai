# Installation guide — for first-time users

This guide is written for someone who has **never written code, never used GitHub, never opened a terminal**. Every step is spelled out. Take your time — total install is around 20–30 minutes, mostly spent waiting for downloads.

If anything looks weird or you get stuck, take a screenshot and send it to the developer. Don't guess — most steps are reversible, but a wrong API key in the wrong field is annoying to debug.

> **Quick mental model.** This is an app that runs **on your own computer**, not on the internet. You start it like Photoshop or Chrome — there's an icon you double-click, a window opens, you use it, you close it. The "website" you'll see at `http://localhost:3000` is served from your own machine. Nothing leaves your laptop unless you explicitly send it to an external API (like Claude).

---

## Part 1 — Install the prerequisites

You need **one** program installed before the app will run: Node.js. That's it.

### 1.1 Install Node.js (Windows and macOS)

1. Open [https://nodejs.org/](https://nodejs.org/) in your browser.
2. Click the big green **LTS** button. (LTS = "long-term support" = the stable version, which is what you want.)
3. The download starts automatically. You'll get a `.msi` file on Windows or a `.pkg` file on macOS.
4. Double-click the downloaded file and click **Next / Continue / Install** through every screen. Defaults are fine — don't change anything.
5. When it says "Installation complete", close the installer.

**Verify it worked** (optional but recommended):

- **Windows**: press the **Windows key**, type `cmd`, hit Enter. A black window opens. Type `node -v` and press Enter. You should see something like `v20.18.0`. If yes — done. If you get "command not found", reboot your computer and try again.
- **macOS**: open **Terminal** (press ⌘+Space, type `Terminal`, hit Enter). Type `node -v` and press Enter. Same expected output.

### 1.2 (Windows only) Install Python 3 — optional but recommended

The transcription engine ships a small helper that may need Python during install. If you skip this and the install fails with a message about Python, come back here.

1. Open the Microsoft Store.
2. Search for `Python 3.12`.
3. Click **Get** / **Install**. (It's free.)
4. Done. No configuration needed.

(macOS already ships with Python.)

---

## Part 2 — Get the project files onto your computer

The project lives on GitHub at:

**https://github.com/Bander4ik/Eric-yt-channel-ai**

You have two ways to download it. Pick **one**. If you don't know which, pick Option A — it's the simplest and works exactly the same.

### Option A — Download the ZIP from GitHub (simplest)

No account, no extra tools. Best if you just want to run the app.

1. Open **[https://github.com/Bander4ik/Eric-yt-channel-ai](https://github.com/Bander4ik/Eric-yt-channel-ai)** in your browser.
2. Find the green **`<> Code`** button (near the top, above the file list) → click it.
3. In the dropdown, click **Download ZIP** (at the bottom).
4. The ZIP downloads to your **Downloads** folder. It will be named `Eric-yt-channel-ai-main.zip`.
5. Extract it:
   - **Windows**: right-click the ZIP → **Extract All...** → **Extract**.
   - **macOS**: double-click the ZIP.
6. You now have a folder called `Eric-yt-channel-ai-main` containing `package.json`, `README.md`, `install.bat`, `start.bat`, etc.

### Option B — Clone via GitHub Desktop (recommended if you'll get updates)

If the developer is going to push fixes and you want one-click updates without re-downloading the ZIP each time, use GitHub Desktop.

1. Download GitHub Desktop from **[https://desktop.github.com/](https://desktop.github.com/)** → install (defaults are fine).
2. Open GitHub Desktop. You can sign in with a GitHub account or skip — both work since the repo is public.
3. **File → Clone repository...** → tab **URL** at the top → paste:
   ```
   https://github.com/Bander4ik/Eric-yt-channel-ai
   ```
4. **Local path** → pick a folder (default `Documents/GitHub/Eric-yt-channel-ai` is fine) → **Clone**.
5. Done. To update later: open GitHub Desktop → click **Fetch origin** → if there are new changes, click **Pull origin**.

### 2.x — Move the folder somewhere safe

This applies to **both options**.

**Don't leave the project in `Downloads`** — browsers and OS cleanup utilities auto-delete old Downloads, which would wipe the app *and your local data* (API keys, transcripts, chat history) along with it. If you used Option B, the GitHub Desktop default location (`Documents/GitHub/...`) is already fine — skip this step.

Move (drag-and-drop is fine) the folder to:

- **Windows**: `C:\Users\<your name>\Documents\Eric-yt-channel-ai`
- **macOS**: `~/Documents/Eric-yt-channel-ai` (under `Macintosh HD/Users/<your name>/Documents/`)

> ⚠️ **Don't put the project inside a cloud-sync folder.** OneDrive, iCloud Drive, Dropbox, and Google Drive all silently sync changes to the cloud as you work. The app's SQLite database is touched constantly while the app runs, and these sync services can corrupt the database's WAL files. Keep the project under plain `Documents` (outside any synced subfolder), on your **Desktop**, or in a folder like `C:\dev\` (Windows) / `~/code/` (macOS). Anywhere NOT inside iCloud / OneDrive / Dropbox.

---

## Part 3 — First-time setup (one-time only)

You should now have a folder like `Documents/Eric-yt-channel-ai` containing files like `package.json`, `README.md`, `install.bat`, `start.bat`, etc.

### 3.1 Run the installer

This downloads everything the app needs (~300 MB of code libraries). It takes **2–5 minutes** depending on your internet speed.

- **Windows**: double-click `install.bat` in the project folder. A black terminal window opens. You'll see lots of lines scrolling — that's normal. **Wait until it says "Installation complete!"** and asks you to press a key. **Don't close the window early** — interrupting npm mid-install leaves a half-broken `node_modules` folder.
- **macOS**: double-click `install.command`. If macOS shows a popup "cannot be opened because it is from an unidentified developer":
  - Right-click `install.command` → **Open**.
  - In the popup, click **Open**.
  - macOS remembers your choice; next time it'll just open.

> **If install fails**: read the last few lines of the terminal. Common causes:
> - "Node.js not found" → go back to step 1.1.
> - "python not found" or "youtube-dl-exec needs Python" → install Python (step 1.2).
> - "EACCES permission denied" (macOS) → run `sudo chmod +x install.command start.command` in Terminal, from the project folder, then double-click again.
> - "ENOENT" or weird npm errors → delete the `node_modules` folder if it exists, then re-run `install.bat` / `install.command`.

### 3.2 Test that it starts

- **Windows**: double-click `start.bat`.
- **macOS**: double-click `start.command`.

A terminal window opens. After ~5–10 seconds you'll see lines like:

```
▲ Next.js 16.2.4
- Local:        http://localhost:3000
✓ Ready in 2.1s
```

Your default browser should automatically open `http://localhost:3000`. If it doesn't, open your browser yourself and type `http://localhost:3000` in the address bar.

You should see the app's dashboard. It'll be empty (no channels yet) — that's expected.

**To stop the app**: just close the terminal window. (Closing the browser tab does nothing — the server keeps running in the background until you close the terminal.)

---

## Part 4 — Add API keys (Integrations page)

The app needs API keys for the external services it talks to. Every key is stored **locally in `data/app.db`** — never uploaded anywhere. You enter each one once and forget about it.

Open the running app (`http://localhost:3000`) and click **Integrations** in the left sidebar.

### 4.1 Claude (Anthropic) — REQUIRED

Without this, the AI chat, hook analyzer, and competitor analysis are all disabled.

1. Go to [https://console.anthropic.com/](https://console.anthropic.com/) → sign in or create an account (any personal email works).
2. Add a payment method: **Billing → Plans → Add credit card**. New accounts often get $5 of free credit.
3. **API Keys → Create Key** → name it `eric-yt-channel-ai` → **Create Key** → **copy the key** (starts with `sk-ant-...`). You only see it once — copy now.
4. In the app: **Integrations** → paste into **Claude (Anthropic)** → **Save**. The status chip should flip to green "Connected".

> Typical spend: $1–10 / month for light use. Heavy chat use with the Opus advisor can hit $30+ — the **Claude usage** widget on the Integrations page shows live spend so you can watch it.

### 4.2 Deepgram — STRONGLY RECOMMENDED

This is what generates transcripts for videos that don't have YouTube captions. The app runs `yt-dlp` locally to pull audio, streams it to Deepgram, and saves the text. Without Deepgram, you only get YouTube's free `[CC]` captions (≈80% of videos have them).

1. Go to [https://console.deepgram.com/](https://console.deepgram.com/) → sign up. **You get $200 of free credit** — enough for ~770 hours of audio.
2. **API Keys → Create a New API Key** → name it `eric-yt-channel-ai` → permissions: **Member** → **Create Key** → **copy the key**.
3. In the app: **Integrations** → paste into **Deepgram (speech-to-text)** → **Save**.

> Cost after free credit: $0.0043/min ($0.26/hour). The **Deepgram usage** widget tracks spend.

### 4.3 YouTube Data API key — REQUIRED to add channels

1. Go to [https://console.cloud.google.com/](https://console.cloud.google.com/).
2. Top of page → **Select a project** → **New Project** → name it `eric-yt-channel-ai` → **Create**.
3. Wait ~10 seconds for the project to be created. Make sure you're inside it (top of page should show its name).
4. Left menu → **APIs & Services → Library** → search for **YouTube Data API v3** → click it → **Enable**.
5. Left menu → **APIs & Services → Credentials** → **+ Create Credentials** → **API key**. Copy the key (starts with `AIza...`).
6. Click the key in the list → **API restrictions** → **Restrict key** → check only **YouTube Data API v3** → **Save**. (Security best practice — the key now only works for YouTube.)
7. In the app: **Integrations** → paste into **YouTube Data API v3** → **Save**.

> Free quota: 10,000 units/day. Plenty for syncing many channels with regular updates.

### 4.4 Google OAuth (for Analytics + revenue data) — OPTIONAL but unlocks the best features

This is what lets the app pull real Analytics data (views over time, retention, revenue, traffic sources) directly from YouTube on your behalf.

1. In the same Google Cloud project as step 4.3, enable **YouTube Analytics API** the same way (**APIs & Services → Library** → search → **Enable**).
2. **APIs & Services → OAuth consent screen**:
   - **User Type**: External → **Create**.
   - **App name**: `Eric YT Channel AI`. **User support email**: your email. **Developer contact email**: your email. **Save and continue**.
   - **Scopes** → **Add or remove scopes** → add all three:
     - `https://www.googleapis.com/auth/yt-analytics.readonly`
     - `https://www.googleapis.com/auth/yt-analytics-monetary.readonly`
     - `https://www.googleapis.com/auth/youtube.readonly`
   - **Save and continue**.
   - **Test users** → **Add users** → add the email of every Google account that owns a YouTube channel you'll be analyzing. **Save and continue → Back to dashboard**.
3. **APIs & Services → Credentials → + Create Credentials → OAuth client ID**:
   - **Application type**: Web application.
   - **Name**: `eric-yt-channel-ai`.
   - **Authorized redirect URIs** → **Add URI** → paste **exactly**:
     ```
     http://localhost:3000/api/youtube/oauth/callback
     ```
     No trailing slash. Must be `http://` (not `https://`) because this is local.
   - **Create**.
   - The popup shows **Client ID** and **Client secret** → copy both.
4. In the app: **Integrations** → scroll to **YouTube Analytics (Google OAuth)** → paste **Client ID** and **Client secret** → **Save**.
5. Then for each channel you've added, click the **Google** button next to it → sign in with the channel's owner account → grant all 3 permissions → page redirects back to the app.

> Token expiry: While your OAuth app is in **Testing** mode (the default), Google forces a re-login every 7 days. The app shows token age and warns you when re-login is due.

### 4.5 Apify — OPTIONAL (fallback transcription + competitor scraping)

Apify is useful if Deepgram + yt-dlp fails for some reason, and for scraping competitor channels. Free plan ships $5/month of credit.

1. Sign up at [apify.com](https://apify.com).
2. Console → your profile → **Settings → Integrations** → copy your **Personal API token** (starts with `apify_api_`).
3. In the app: **Integrations** → paste into **Apify** → **Save**.

### 4.6 Exa & Gemini — OPTIONAL

Same pattern. Self-explanatory help text is on each card in the Integrations page (click "How to get an X API key" to expand the steps).

---

## Part 5 — Add your first YouTube channel

1. **Integrations** page → scroll to the **YouTube Data API v3** card → in the **Add channel** input below it, paste:
   - the channel URL (e.g. `https://www.youtube.com/@MrBeast`), OR
   - the channel handle (e.g. `@MrBeast`), OR
   - the channel ID (e.g. `UCX6OQ3DkcsbYNE6H8uQQuVA`)
2. Click **Sync**. The app pulls metadata: title, handle, subscriber count, recent video list.
3. If you set up Google OAuth (step 4.4), click the **Google** button on the channel's row to grant the app access to that channel's Analytics.

---

## Part 6 — Daily usage

- **Dashboard** — overview: top videos by views/engagement, recent activity, alerts.
- **Videos** — every video, sortable. Click one for transcript + AI analysis + comments.
- **AI Chat** — talk to Claude about your channel; attach videos to focus the conversation.
- **Hook Lab** — auto-scores the opening of every video on 7 dimensions (curiosity, value promise, conflict, specific language, identification, pacing, benefit).
- **Competitors** — track other channels, sync their videos.
- **Logs** — every API call, error, and event in chronological order. Handy for debugging.

---

## Part 7 — Updating the app

How you update depends on which option you used in Part 2.

### If you used Option B (GitHub Desktop) — the easy way

1. **Stop the app** (close the terminal window the server is running in).
2. Open **GitHub Desktop** → click **Fetch origin**.
3. If GitHub Desktop shows "X commits behind" + a **Pull origin** button → click it. The new code is downloaded into your existing project folder; your `data/` folder is left untouched (it's gitignored).
4. Back in the project folder, double-click `install.bat` / `install.command` once (in case any dependencies changed — takes 30 seconds to a couple of minutes).
5. Launch the app again with `start.bat` / `start.command`.

**Your data survives automatically** because GitHub Desktop never touches the `data/` folder.

### If you used Option A (ZIP download)

1. **Stop the app** (close the terminal window).
2. **Rename your current project folder** to `Eric-yt-channel-ai-old`. Don't delete it yet — we need one folder from it.
3. Re-download the ZIP from **[github.com/Bander4ik/Eric-yt-channel-ai](https://github.com/Bander4ik/Eric-yt-channel-ai)** → green **Code** button → **Download ZIP**. Extract it.
4. Open the **OLD** folder, find the `data` subfolder, and **copy it into the NEW folder**. This preserves your API keys, OAuth tokens, channels, transcripts, chat history — everything you've set up.
5. Inside the new folder, run `install.bat` / `install.command` once (dependencies may have changed), then `start.bat` / `start.command`.
6. Once you've verified the new version works and your data is intact, delete the `-old` folder.

> Tip: if you find yourself updating more than once or twice, switching to Option B (GitHub Desktop, Part 2) is worth the 5 minutes it takes to set up.

---

## Where is everything?

| Thing | Where |
|---|---|
| Your data (DB, API keys, transcripts) | `data/app.db` inside the project folder |
| The app itself | The project folder you extracted/cloned |
| The "server" (when running) | Running in the terminal window opened by `start.bat`/`start.command` |
| The "website" you interact with | `http://localhost:3000` in your browser |

---

## Troubleshooting

### "I close the app and lose my API keys when I reopen it."

**This should NOT happen** with this version — the database uses `synchronous=FULL` and `WAL` mode, plus a graceful-shutdown handler that flushes everything to disk before the process exits. If it does happen:

1. Check that the `data/` folder exists in your project folder and contains an `app.db` file.
2. If `app.db` is there but the app shows no keys → most likely the app started from a different directory and created a fresh DB elsewhere. **Always launch via `start.bat` / `start.command`** (those scripts `cd` into the right folder first). Don't run `npm run dev` manually from some other terminal location.
3. If `app.db` keeps getting recreated empty → there might be an antivirus or sync service (OneDrive, iCloud) eating the WAL files. Move the project out of OneDrive/iCloud-synced folders.

### "Port 3000 is already in use."

Another app is using port 3000. Either:
- Quit the other app, OR
- Start this one on a different port: open Terminal in the project folder, run `npm run dev -- -p 3001` (use any port 3000–9999). Then open `http://localhost:3001` instead.

### "yt-dlp binary not found" (when transcribing)

The transcription engine couldn't find its helper binary. Re-run `install.bat` / `install.command` — that re-downloads it.

### "Access blocked: app has not completed verification" (Google OAuth)

The Google account you're trying to sign in with isn't in the **Test users** list. Add it: Google Cloud Console → APIs & Services → OAuth consent screen → Test users → Add.

### App won't start, terminal says "EADDRINUSE"

Same as "port in use" — fix above.

### The terminal window flashed and closed on Windows

Means there was an error and the script exited too fast to read it. Open the project folder in File Explorer, hold **Shift**, **right-click in empty space**, pick **Open PowerShell window here** (or **Open in Terminal**), then type `.\install.bat` or `.\start.bat` and press Enter. Now the window stays open and you can see the error.

### macOS says "install.command can't be opened because Apple cannot check it for malicious software"

System Preferences → Privacy & Security → scroll down → click **Open Anyway** next to the install.command warning. Then double-click the script again.

---

## Backup your data

The single most important file is `data/app.db`. If you lose it, you lose your API keys, OAuth tokens, transcripts, and chat history.

**Manual backup**: every week or so, copy `data/app.db` to a safe place (Dropbox, USB stick, wherever). To restore: replace the current `data/app.db` with the backup file while the app is **stopped**.

Don't try to back up the `data/` folder while the app is running — SQLite uses `.db-wal` and `.db-shm` helper files that are part of an in-progress transaction. Stop the app, then copy. Two seconds of downtime, full integrity.

---

## What if I need to fully reset?

1. Stop the app.
2. Delete the `data/` folder inside the project directory.
3. Launch the app again — it creates a fresh empty `data/app.db`.

You'll need to re-enter all API keys and reconnect channels. The app code, dependencies, and project files are untouched.

---

## Asking for help

If you get stuck:

1. Take a screenshot of whatever you're looking at.
2. If there's a terminal window with red text, screenshot that too.
3. Send both to the developer along with: **which step you're on**, **what you tried**, **what error message you see**.

That's everything they need to help in one round.
