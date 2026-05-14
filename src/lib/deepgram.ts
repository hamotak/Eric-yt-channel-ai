import "server-only";
import youtubeDl from "youtube-dl-exec";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getSetting } from "./db";

/**
 * Cloud-only Deepgram transcription for YouTube videos.
 *
 * Flow:
 *   1. yt-dlp (invoked via youtube-dl-exec) resolves a YouTube videoId →
 *      signed audio stream URL on googlevideo.com. We only request JSON
 *      metadata (--skip-download / --dump-single-json) — the audio bytes
 *      never touch disk.
 *   2. We hand that URL to Deepgram's /v1/listen endpoint. Deepgram fetches
 *      the audio from Google CDN to their own cloud, transcribes, returns
 *      text.
 *
 * Nothing stays on the user's disk beyond a few KB of JSON. The yt-dlp
 * binary itself (~20MB) is shipped with the youtube-dl-exec package and
 * installed into node_modules at npm-install time.
 *
 * Why yt-dlp and not a pure-JS library: the JS ports (@distube/ytdl-core,
 * etc.) are either archived or regularly break when YouTube updates its
 * player internals. yt-dlp is maintained by a large community and ships
 * fixes within hours of YouTube changes. Much more reliable for long-term.
 */

export const DEEPGRAM_MODEL = "nova-3";
/** Deepgram Nova-3 pre-recorded pricing: $0.0043 per audio minute. */
const COST_PER_MINUTE_USD = 0.0043;

/**
 * Cost for a given audio duration, rounded UP to the nearest cent. We round
 * up so our total is always ≥ what Deepgram actually bills — better to
 * over-estimate the creator's spend than surprise them later.
 */
export function estimateCostCents(durationSeconds: number): number {
  const minutes = Math.max(0, durationSeconds) / 60;
  const usd = minutes * COST_PER_MINUTE_USD;
  return Math.max(1, Math.ceil(usd * 100));
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export class DeepgramError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "DeepgramError";
  }
}

export class AudioUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioUrlError";
  }
}

// Subset of the JSON yt-dlp dumps with --dump-single-json. We only pull
// the few fields we actually need; yt-dlp's full shape has ~150 properties.
type YtDlpFormat = {
  format_id?: string;
  url?: string;
  acodec?: string;
  vcodec?: string;
  audio_channels?: number;
  abr?: number;
  tbr?: number;
  filesize?: number;
  protocol?: string;
};

type YtDlpInfo = {
  id?: string;
  title?: string;
  duration?: number;
  formats?: YtDlpFormat[];
  url?: string;
};

/**
 * Bot-detection mitigation. YouTube increasingly blocks data-center IPs
 * (Railway, Render, Fly, Vercel functions, etc.) with a "Sign in to
 * confirm you're not a bot" gate. Two layered mitigations:
 *
 *   1. Switch yt-dlp to alternate player clients that don't rely on
 *      web-page cookies. `tv_embedded` and `ios` are the best bets right
 *      now — they sign URLs differently and frequently bypass the bot
 *      challenge that the default `web` client trips. We try them in
 *      priority order via the `player_client` extractor arg.
 *
 *   2. Optional cookies file. The user can paste their YouTube cookies
 *      (Netscape format from a cookies.txt browser export) into the
 *      `youtube.cookies` setting. We materialise it to a tempfile on
 *      every yt-dlp invocation, pass `--cookies <path>`, then unlink.
 *      This is the nuclear option — costs the user 30s of work but works
 *      around almost any bot challenge.
 */
const PLAYER_CLIENTS = "tv_embedded,ios,android,web";

/**
 * Write the configured YouTube cookies (if any) to a fresh temp file so
 * yt-dlp can use them via `--cookies`. Returns the path + a cleanup
 * callback. Returns null if no cookies are configured.
 */
function maybeWriteCookiesTempFile(): { path: string; cleanup: () => void } | null {
  const raw = getSetting("youtube.cookies");
  if (!raw || !raw.trim()) return null;
  // Random filename per invocation to avoid two parallel transcriptions
  // racing on the same path. /tmp is always writable in Linux containers
  // (Railway uses tmpfs), local dev too.
  const tmp = path.join(
    os.tmpdir(),
    `yt-cookies-${crypto.randomBytes(8).toString("hex")}.txt`
  );
  fs.writeFileSync(tmp, raw, { encoding: "utf8", mode: 0o600 });
  return {
    path: tmp,
    cleanup: () => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Best-effort — leftover temp files are harmless on tmpfs.
      }
    },
  };
}

/**
 * Common yt-dlp flag set used for both metadata-only and audio-stream
 * invocations. Centralised here so the bot-detection workarounds stay
 * in one place.
 */
function ytDlpCommonFlags(cookiesPath: string | null): Record<string, unknown> {
  return {
    noWarnings: true,
    noCheckCertificates: true,
    // youtube-dl-exec serialises this into `--extractor-args
    // "youtube:player_client=tv_embedded,ios,android,web"`. yt-dlp
    // walks the list in order, so a bot-blocked default `web` client
    // simply gets skipped over.
    extractorArgs: `youtube:player_client=${PLAYER_CLIENTS}`,
    // A realistic Chrome UA — yt-dlp ships its own default but recent
    // versions have been getting flagged by string matching, so we
    // override.
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ...(cookiesPath ? { cookies: cookiesPath } : {}),
  };
}

/**
 * Pick the best audio-only HTTP stream from yt-dlp's format list. We prefer
 * audio-only streams (vcodec === "none") over muxed, and reject streams
 * requiring HLS/DASH manifests — Deepgram's URL ingestion wants a plain
 * HTTPS fetch, not a manifest. Among candidates we pick the lowest bitrate
 * that's still > 32kbps so transcription stays fast without losing accuracy.
 */
function pickAudioFormat(formats: YtDlpFormat[]): YtDlpFormat | null {
  const candidates = formats.filter(
    (f) =>
      !!f.url &&
      f.acodec &&
      f.acodec !== "none" &&
      f.vcodec === "none" &&
      // `https` is a plain-fetch stream. m3u8/dash would need a client to
      // stitch segments; Deepgram won't do that.
      (f.protocol === "https" || f.protocol === "http" || !f.protocol)
  );
  if (candidates.length === 0) return null;

  // Rank by bitrate ascending, but skip obviously-too-low (< 32 kbps).
  const usable = candidates
    .filter((f) => (f.abr ?? f.tbr ?? 0) >= 32)
    .sort((a, b) => (a.abr ?? a.tbr ?? 999) - (b.abr ?? b.tbr ?? 999));

  return usable[0] ?? candidates[0];
}

/**
 * Pull the direct audio stream URL for a YouTube video. yt-dlp does the
 * heavy lifting — signature decipher, format selection, everything YouTube
 * requires to hand out a signed googlevideo.com URL. We get JSON metadata
 * only; `--skip-download` is implicit when using dumpSingleJson.
 */
export async function resolveAudioUrl(videoId: string): Promise<{
  url: string;
  durationSeconds: number;
  title: string;
}> {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cookies = maybeWriteCookiesTempFile();
  let info: YtDlpInfo;
  try {
    info = (await youtubeDl(ytUrl, {
      dumpSingleJson: true,
      ...ytDlpCommonFlags(cookies?.path ?? null),
    })) as unknown as YtDlpInfo;
  } catch (err) {
    // `err.message` from execa-based wrappers is often empty — the real
    // diagnostic is on stderr. Pull everything we can so the /logs page
    // actually shows what yt-dlp complained about.
    const e = err as {
      message?: string;
      stderr?: unknown;
      stdout?: unknown;
      exitCode?: number;
      shortMessage?: string;
    };
    const parts: string[] = [];
    if (e.shortMessage) parts.push(e.shortMessage);
    else if (e.message) parts.push(e.message);
    if (typeof e.exitCode === "number") parts.push(`exitCode=${e.exitCode}`);
    const stderr = typeof e.stderr === "string" ? e.stderr : String(e.stderr ?? "");
    if (stderr.trim()) parts.push(`stderr: ${stderr.slice(0, 800)}`);
    const stdout = typeof e.stdout === "string" ? e.stdout : String(e.stdout ?? "");
    if (stdout.trim() && stdout.length < 300) parts.push(`stdout: ${stdout.slice(0, 200)}`);
    const detail = parts.join(" | ") || "(yt-dlp threw with no message/stderr — binary may be missing or blocked)";
    throw new AudioUrlError(
      `yt-dlp failed for ${videoId}: ${detail}. If this persists, update youtube-dl-exec or paste a YouTube cookies.txt under Settings → YouTube cookies.`
    );
  } finally {
    cookies?.cleanup();
  }

  if (!info.formats || info.formats.length === 0) {
    throw new AudioUrlError(
      `yt-dlp returned no formats for ${videoId}. Video may be private, age-restricted, region-locked, or removed.`
    );
  }

  const chosen = pickAudioFormat(info.formats);
  if (!chosen?.url) {
    throw new AudioUrlError(
      `No audio-only HTTP stream found for ${videoId}. The video exists but only ships muxed or DASH streams; Deepgram can't fetch those by URL.`
    );
  }

  return {
    url: chosen.url,
    durationSeconds: Math.round(info.duration ?? 0),
    title: info.title ?? "",
  };
}

type DeepgramListenResponse = {
  results?: {
    channels?: Array<{
      alternatives?: Array<{ transcript?: string; confidence?: number }>;
      detected_language?: string;
    }>;
  };
  metadata?: { duration?: number; request_id?: string };
};

/**
 * Download the full audio track for a YouTube video into RAM by letting
 * yt-dlp handle the entire transfer. yt-dlp knows how to do the ranged /
 * DASH-segmented fetches that googlevideo's CDN requires for long audio —
 * a plain Node fetch on the signed URL only gets the first chunk and
 * silently ends, which is why transcripts were coming out 30 seconds long
 * for 30-minute videos.
 *
 * No disk I/O: yt-dlp writes its audio output to stdout (`-o -`), we read
 * its stdout into memory. Peak RAM ≈ one audio track (typically 20-80MB
 * for a 30-60min video, since YouTube's bestaudio is opus/webm @ 128 kbps).
 */
/**
 * One attempt at running yt-dlp with the given options into a RAM
 * buffer. Returns the bytes or throws AudioUrlError. Split out from the
 * caller below so we can retry with different flags on a known-bad
 * exit (e.g. "Requested format is not available").
 */
async function runYtDlpToBuffer(
  ytUrl: string,
  ytdlpOptions: Record<string, unknown>,
  signal: AbortSignal | undefined,
  videoId: string
): Promise<{ buffer: Buffer; totalBytes: number }> {
  const subprocess = youtubeDl.exec(
    ytUrl,
    ytdlpOptions,
    // Force binary-safe pipes; on Windows the default can sometimes corrupt
    // non-text stdout. Also explicitly ignore stdin so yt-dlp doesn't wait.
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const onAbort = () => subprocess.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let stderrAcc = "";
  subprocess.stdout?.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    totalBytes += chunk.length;
  });
  subprocess.stderr?.on("data", (chunk: Buffer) => {
    stderrAcc += chunk.toString();
  });

  try {
    await subprocess;
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    throw new AudioUrlError(
      `yt-dlp audio download failed for ${videoId} (exit ${e.exitCode ?? "?"}): ${
        stderrAcc.slice(-600).trim() || e.message || "(no output)"
      }`
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  return { buffer: Buffer.concat(chunks, totalBytes), totalBytes };
}

/**
 * Download the full audio track for a YouTube video into RAM via yt-dlp.
 *
 * Two attempts:
 *   1. With the standard bot-defense flags (alternate player clients,
 *      Chrome UA) and `bestaudio/best` selector. The `/best` fallback is
 *      crucial — some restricted/newer videos only offer muxed formats,
 *      and the bare `bestaudio` selector explodes with "Requested format
 *      is not available" on those.
 *   2. If attempt 1 fails with a format error, retry without the
 *      `player_client` extractor args. The alternate clients (tv_embedded
 *      / ios / android) sometimes only expose a subset of formats; the
 *      default `web` client has the full list. Costs us nothing if attempt
 *      1 already failed.
 *
 * No disk I/O: yt-dlp writes its audio output to stdout (`-o -`), we read
 * its stdout into memory. Peak RAM ≈ one audio track (typically 20-80MB
 * for a 30-60min video).
 */
async function downloadAudioToBuffer(
  videoId: string,
  opts: { signal?: AbortSignal } = {}
): Promise<{ buffer: Buffer; contentType: string }> {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cookies = maybeWriteCookiesTempFile();

  // `bestaudio/best`: prefer audio-only; fall back to the best combined
  // (muxed) format when audio-only isn't offered. Deepgram auto-detects
  // codec from body bytes, so feeding it muxed mp4 is fine — the inner
  // audio track gets transcribed and the video stream is ignored.
  //
  // Two-attempt strategy:
  //   1. With the standard bot-defense flags (alternate player clients,
  //      Chrome UA).
  //   2. On a "Requested format is not available" error, retry WITHOUT
  //      the `player_client` override — some videos only expose the
  //      muxed/audio-only formats to the default `web` client, not to
  //      tv_embedded/ios/android.
  const commonFlags = ytDlpCommonFlags(cookies?.path ?? null);
  const optionsWithClients: Record<string, unknown> = {
    ...commonFlags,
    format: "bestaudio/best",
    output: "-",
    quiet: true,
  };
  // Build the fallback options by spreading commonFlags WITHOUT the
  // extractorArgs key. Destructuring is the cleanest way to drop one
  // field in TS strict mode — `delete` on an object literal can trip
  // strict-mode + some bundlers.
  const { extractorArgs: _omit, ...flagsNoClients } = commonFlags as {
    extractorArgs?: unknown;
    [k: string]: unknown;
  };
  void _omit;
  const optionsDefaultClient: Record<string, unknown> = {
    ...flagsNoClients,
    format: "bestaudio/best",
    output: "-",
    quiet: true,
  };

  let result: { buffer: Buffer; totalBytes: number } | null = null;

  try {
    // ---- Attempt 1 ----
    try {
      result = await runYtDlpToBuffer(
        ytUrl,
        optionsWithClients,
        opts.signal,
        videoId
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isFormatError = /requested format is not available/i.test(msg);
      if (!isFormatError) {
        // Re-throw the original AudioUrlError so the chained error
        // message keeps its diagnostic detail.
        throw err;
      }

      // ---- Attempt 2 (default web client) ----
      result = await runYtDlpToBuffer(
        ytUrl,
        optionsDefaultClient,
        opts.signal,
        videoId
      );
    }
  } finally {
    cookies?.cleanup();
  }

  if (!result || result.totalBytes === 0) {
    throw new AudioUrlError(
      `yt-dlp produced no audio bytes for ${videoId}. Video may be private, region-locked, or age-restricted.`
    );
  }

  // YouTube's bestaudio is typically webm/opus; bestaudio/best fallback
  // can return mp4/m4a or muxed mp4. Deepgram auto-detects from body
  // bytes, so the declared Content-Type is a hint at best.
  return { buffer: result.buffer, contentType: "audio/webm" };
}

/**
 * Transcribe a YouTube video by downloading its audio via yt-dlp into RAM
 * and POSTing the bytes to Deepgram. Everything stays in memory — nothing
 * is written to disk.
 *
 * `audioUrl` is still accepted for backward compatibility but is ignored;
 * we always re-resolve via yt-dlp so CDN expiries and signature rotations
 * don't bite us between the URL resolution and the actual fetch.
 */
export async function transcribeVideoAudio(
  videoId: string,
  apiKey: string,
  opts: { model?: string; signal?: AbortSignal } = {}
): Promise<{ text: string; language: string | null; durationSeconds: number }> {
  const model = opts.model ?? DEEPGRAM_MODEL;

  const { buffer, contentType } = await downloadAudioToBuffer(videoId, opts);

  const qs = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
    detect_language: "true",
  });

  // Node's Buffer is a valid BodyInit at runtime (undici accepts it) but the
  // TS DOM lib's BodyInit type doesn't include it and has a SharedArrayBuffer
  // quirk that rejects Uint8Array too. Cast through unknown — this is the
  // runtime-correct, Node-idiomatic way to send binary POST bodies.
  const res = await fetch(`https://api.deepgram.com/v1/listen?${qs.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": contentType,
    },
    body: buffer as unknown as BodyInit,
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DeepgramError(
      res.status,
      `Deepgram /listen failed (${res.status}): ${body.slice(0, 300)}`
    );
  }

  const data = (await res.json()) as DeepgramListenResponse;
  const channel = data.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  const text = alt?.transcript ?? "";
  if (!text.trim()) {
    throw new DeepgramError(
      200,
      "Deepgram returned an empty transcript. The video may be music-only, silent, or spoken in a language Deepgram can't detect."
    );
  }

  return {
    text,
    language: channel?.detected_language ?? null,
    durationSeconds: Math.round(data.metadata?.duration ?? 0),
  };
}

/**
 * @deprecated URL-based transcription kept around only as a compile-time
 * re-export — the actual implementation now uses yt-dlp stdout instead of
 * fetching the URL ourselves. This shim exists so any older callers keep
 * compiling; it just forwards to the videoId-based path.
 */
export async function transcribeByUrl(
  _audioUrl: string,
  _apiKey: string,
  _opts: { model?: string; signal?: AbortSignal } = {}
): Promise<{ text: string; language: string | null; durationSeconds: number }> {
  throw new Error(
    "transcribeByUrl is deprecated — use transcribeYouTubeVideo(videoId, apiKey) which goes through yt-dlp stdout."
  );
}

/**
 * Generic Deepgram URL ingestion — works for ANY publicly fetchable
 * audio/video URL, not just YouTube. Used by:
 *   - the Innertube → Deepgram path below (YouTube-specific)
 *   - the "Transcribe from URL" UI option where the user pastes a
 *     Drive / Dropbox / S3 link directly
 *
 * Deepgram pulls the bytes from THEIR side — we never download or
 * store anything. The URL just has to be reachable from Deepgram's
 * infrastructure (most cloud storage public links work; YouTube
 * googlevideo URLs are signed and expire ~6h).
 */
export async function transcribeFromUrl(
  audioUrl: string,
  apiKey: string,
  opts: { model?: string; signal?: AbortSignal } = {}
): Promise<{
  text: string;
  language: string | null;
  durationSeconds: number;
  costCents: number;
  model: string;
}> {
  const r = await transcribeViaDeepgramUrl(audioUrl, apiKey, opts);
  return {
    text: r.text,
    language: r.language,
    durationSeconds: r.durationSeconds,
    costCents: estimateCostCents(r.durationSeconds),
    model: opts.model ?? DEEPGRAM_MODEL,
  };
}

/**
 * Transcribe an already-in-memory audio/video file. Used by the
 * "Upload file" UI path: the browser POSTs a multipart blob, the
 * route handler buffers it and hands the bytes here. Nothing hits
 * disk on the server — the only persistence is the resulting
 * transcript text written into the SQLite `transcripts` table.
 *
 * Deepgram auto-detects encoding from the binary body, so the
 * Content-Type we send is a hint at best. We pass it through anyway
 * because it can help with marginal codecs.
 */
export async function transcribeFromFileBuffer(
  buffer: Buffer,
  contentType: string,
  apiKey: string,
  opts: { model?: string; signal?: AbortSignal } = {}
): Promise<{
  text: string;
  language: string | null;
  durationSeconds: number;
  costCents: number;
  model: string;
}> {
  const model = opts.model ?? DEEPGRAM_MODEL;
  const qs = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
    detect_language: "true",
  });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${qs.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": contentType,
    },
    body: buffer as unknown as BodyInit,
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DeepgramError(
      res.status,
      `Deepgram /listen failed (${res.status}): ${body.slice(0, 300)}`
    );
  }
  const data = (await res.json()) as DeepgramListenResponse;
  const channel = data.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  const text = alt?.transcript ?? "";
  if (!text.trim()) {
    throw new DeepgramError(
      200,
      "Deepgram returned an empty transcript. The file may be silent, music-only, or in a language Deepgram can't detect."
    );
  }
  const durationSeconds = Math.round(data.metadata?.duration ?? 0);
  return {
    text,
    language: channel?.detected_language ?? null,
    durationSeconds,
    costCents: estimateCostCents(durationSeconds),
    model,
  };
}

/**
 * Resolve a YouTube videoId to a signed `googlevideo.com` audio URL via
 * Innertube. This is the cloud-friendly path: we don't download a single
 * byte on Railway — Deepgram fetches the URL from Google CDN on its own
 * residential-friendly infrastructure. Tries multiple player clients
 * because some get 400'd from datacenter IPs but `/v1/player` survives
 * for others (different endpoint than `/v1/get_transcript`).
 *
 * Returns null if every client refuses, in which case callers fall back
 * to yt-dlp + bytes (works locally on residential IPs).
 */
async function getAudioUrlViaInnertube(videoId: string): Promise<
  | {
      url: string;
      durationSeconds: number;
      mimeType: string;
      via: string;
    }
  | null
> {
  type AudioFormat = {
    mime_type?: string;
    mimeType?: string;
    url?: string;
    bitrate?: number;
    average_bitrate?: number;
    has_audio?: boolean;
    has_video?: boolean;
  };
  type InnertubeStreamingShape = {
    streaming_data?: {
      adaptive_formats?: AudioFormat[];
      formats?: AudioFormat[];
    };
    basic_info?: { duration?: number };
  };

  try {
    const { Innertube } = await import("youtubei.js");
    const yt = await Innertube.create({ retrieve_player: true });
    // Same client walk pattern we use for transcripts — different
    // clients sign their `/v1/player` payloads slightly differently
    // and Google's bot-defense decisions are per-client.
    const clients = ["IOS", "TV_EMBEDDED", "WEB_EMBEDDED", "ANDROID", "WEB"];
    for (const client of clients) {
      try {
        const info = (await yt.getInfo(
          videoId,
          client as unknown as Parameters<typeof yt.getInfo>[1]
        )) as unknown as InnertubeStreamingShape;
        const adaptive = info.streaming_data?.adaptive_formats ?? [];
        // Prefer audio-only formats (has_audio=true, has_video=false) so
        // we don't waste Deepgram fetch bandwidth on bundled video.
        const audioOnly = adaptive.filter((f) => {
          const mt = f.mime_type ?? f.mimeType ?? "";
          if (mt.startsWith("audio/")) return true;
          if (f.has_audio === true && f.has_video === false) return true;
          return false;
        });
        // Pick LOWEST bitrate to minimise Deepgram's download time / our
        // billable minute count. Deepgram bills per audio minute, not
        // per byte — going from 256kbps→64kbps changes nothing for the
        // bill but cuts CDN fetch time noticeably.
        audioOnly.sort(
          (a, b) =>
            (a.average_bitrate ?? a.bitrate ?? 1e9) -
            (b.average_bitrate ?? b.bitrate ?? 1e9)
        );
        const choice = audioOnly[0];
        if (choice?.url) {
          return {
            url: choice.url,
            durationSeconds: info.basic_info?.duration ?? 0,
            mimeType: choice.mime_type ?? choice.mimeType ?? "audio/webm",
            via: `innertube/${client}`,
          };
        }
      } catch {
        continue; // try next client
      }
    }
  } catch {
    /* youtubei.js itself blew up — fall through to null */
  }
  return null;
}

/**
 * Transcribe via Deepgram's URL ingestion: we POST the signed audio
 * URL and Deepgram pulls the bytes from Google's CDN itself. Zero
 * audio transfer through Railway, which is what makes this work even
 * though our IP can't yt-dlp directly.
 */
async function transcribeViaDeepgramUrl(
  audioUrl: string,
  apiKey: string,
  opts: { model?: string; signal?: AbortSignal } = {}
): Promise<{ text: string; language: string | null; durationSeconds: number }> {
  const model = opts.model ?? DEEPGRAM_MODEL;
  const qs = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
    detect_language: "true",
  });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${qs.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: audioUrl }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DeepgramError(
      res.status,
      `Deepgram URL ingestion failed (${res.status}): ${body.slice(0, 300)}`
    );
  }
  const data = (await res.json()) as DeepgramListenResponse;
  const channel = data.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  const text = alt?.transcript ?? "";
  if (!text.trim()) {
    throw new DeepgramError(
      200,
      "Deepgram returned an empty transcript via URL ingestion. The audio URL may have expired before Deepgram could fetch it (googlevideo URLs expire ~6h after issue)."
    );
  }
  return {
    text,
    language: channel?.detected_language ?? null,
    durationSeconds: Math.round(data.metadata?.duration ?? 0),
  };
}

/**
 * Tier 3 last-resort audio source: cobalt.tools, an open-source
 * YouTube→media proxy with residential-friendly egress. We POST a
 * YouTube URL to their /api/json endpoint, they hand back a stream
 * URL pointing into their proxy. Deepgram then fetches THAT URL —
 * cobalt's server downloads from YouTube on its end (where the IP
 * isn't blacklisted) and pipes the bytes to Deepgram.
 *
 * Public cobalt instances rate-limit (~1 req / 5s per IP) but are
 * free; for heavy use we can self-host the cobalt container later.
 *
 * Returns null on any failure — caller falls through to the next
 * tier (or the BYO-audio UI paths).
 */
async function getAudioUrlViaCobalt(
  videoId: string
): Promise<{ url: string; via: string } | null> {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  // Several public cobalt mirrors. Try them in order — the first one
  // to return a usable stream wins. Self-hosted instances are easy to
  // add to this list later by appending the base URL.
  const COBALT_INSTANCES = [
    "https://api.cobalt.tools",
    "https://co.wuk.sh",
    "https://api.cobalt.tools/api",
  ];

  for (const base of COBALT_INSTANCES) {
    try {
      const r = await fetch(`${base}/api/json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // cobalt expects a polite user agent so abusive scrapers
          // get filtered out — picking a real-looking Chrome string
          // keeps our requests in the "real client" bucket.
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({
          url: ytUrl,
          isAudioOnly: true,
          // mp3 is the codec Deepgram handles fastest; cobalt also
          // supports ogg/wav/opus, fall through to those if we ever
          // see "format unsupported" from this endpoint.
          aFormat: "mp3",
        }),
      });
      if (!r.ok) continue;
      const data = (await r.json()) as {
        status?: string;
        url?: string;
        text?: string;
      };
      if (
        (data.status === "stream" ||
          data.status === "redirect" ||
          data.status === "tunnel") &&
        data.url
      ) {
        return { url: data.url, via: base };
      }
    } catch {
      // Network error, JSON parse, etc. — try next mirror.
      continue;
    }
  }
  return null;
}

/**
 * End-to-end: given a videoId and a Deepgram key, produce a transcript.
 *
 * Tier order tuned for **local installs** (this project is local-only).
 * On a residential IP yt-dlp Just Works — it's the fastest, most reliable
 * path. The Innertube and cobalt paths exist as fallbacks for unusual
 * networks (corporate proxy that strips video traffic, ISP-level YouTube
 * blocks, etc.).
 *
 *   Tier 1 — yt-dlp into RAM → Deepgram bytes POST. Residential-IP first
 *     choice. Reliable, fast, single-process.
 *
 *   Tier 2 — Innertube audio URL → Deepgram URL ingestion. Lightweight
 *     fallback if yt-dlp itself is missing or fails (e.g. binary not
 *     installed by the postinstall script). Lets Deepgram fetch directly
 *     from Google CDN.
 *
 *   Tier 3 — cobalt.tools proxy → Deepgram URL ingestion. Last resort —
 *     cobalt fetches YouTube on its end and hands us a stream URL.
 *     Useful when both yt-dlp and Innertube get blocked locally.
 *
 * On total failure the thrown AudioUrlError lists every tier's specific
 * error so /logs shows the full diagnostic chain.
 */
export async function transcribeYouTubeVideo(
  videoId: string,
  apiKey: string,
  opts: { model?: string; signal?: AbortSignal } = {}
): Promise<{
  text: string;
  language: string | null;
  durationSeconds: number;
  costCents: number;
  model: string;
}> {
  // ----- Tier 1: yt-dlp + bytes (residential-IP, the local path) -----
  let tier1Error: string | null = null;
  try {
    const r = await transcribeVideoAudio(videoId, apiKey, opts);
    return {
      text: r.text,
      language: r.language,
      durationSeconds: r.durationSeconds,
      costCents: estimateCostCents(r.durationSeconds),
      model: opts.model ?? DEEPGRAM_MODEL,
    };
  } catch (e) {
    tier1Error = e instanceof Error ? e.message : String(e);
  }

  // ----- Tier 2: Innertube → Deepgram URL ingestion -----
  let tier2Error: string | null = null;
  try {
    const audio = await getAudioUrlViaInnertube(videoId);
    if (audio?.url) {
      const r = await transcribeViaDeepgramUrl(audio.url, apiKey, opts);
      const durationSeconds = r.durationSeconds || audio.durationSeconds;
      return {
        text: r.text,
        language: r.language,
        durationSeconds,
        costCents: estimateCostCents(durationSeconds),
        model: opts.model ?? DEEPGRAM_MODEL,
      };
    }
    tier2Error = "Innertube returned no audio URL across all player clients";
  } catch (e) {
    tier2Error = e instanceof Error ? e.message : String(e);
  }

  // ----- Tier 3: cobalt.tools → Deepgram URL ingestion -----
  try {
    const cobalt = await getAudioUrlViaCobalt(videoId);
    if (cobalt?.url) {
      const r = await transcribeViaDeepgramUrl(cobalt.url, apiKey, opts);
      return {
        text: r.text,
        language: r.language,
        durationSeconds: r.durationSeconds,
        costCents: estimateCostCents(r.durationSeconds),
        model: opts.model ?? DEEPGRAM_MODEL,
      };
    }
    throw new AudioUrlError(
      `All transcription tiers failed for ${videoId}.\n` +
        `  Tier 1 (yt-dlp + bytes): ${tier1Error}\n` +
        `  Tier 2 (Innertube → Deepgram URL): ${tier2Error}\n` +
        `  Tier 3 (cobalt.tools): no stream URL from any mirror\n\n` +
        `If yt-dlp keeps failing, the most reliable fix is to paste a YouTube ` +
        `cookies.txt under Integrations → YouTube cookies. Or use the ` +
        `file-upload / URL-input options on the video Transcript tab.`
    );
  } catch (e) {
    if (e instanceof AudioUrlError) throw e;
    const tier3Msg = e instanceof Error ? e.message : String(e);
    throw new AudioUrlError(
      `All transcription tiers failed for ${videoId}.\n` +
        `  Tier 1 (yt-dlp + bytes): ${tier1Error}\n` +
        `  Tier 2 (Innertube → Deepgram URL): ${tier2Error}\n` +
        `  Tier 3 (cobalt.tools): ${tier3Msg}\n\n` +
        `If yt-dlp keeps failing, the most reliable fix is to paste a YouTube ` +
        `cookies.txt under Integrations → YouTube cookies. Or use the ` +
        `file-upload / URL-input options on the video Transcript tab.`
    );
  }
}
