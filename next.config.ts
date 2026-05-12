import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep these packages out of Next's server bundler:
  //   - better-sqlite3: native C++ addon, can't be bundled.
  //   - youtube-dl-exec: ships yt-dlp.exe alongside its JS — Next's bundler
  //     rewrites require() paths and breaks the binary lookup; symptom is
  //     yt-dlp failing silently with an empty error message.
  //   - youtubei.js: large, heavy CJS/ESM interop, and our two callers use
  //     dynamic `await import()`. Leaving it external avoids any chance of
  //     Next inlining the wrong build and crashing at runtime.
  serverExternalPackages: ["better-sqlite3", "youtube-dl-exec", "youtubei.js"],
};

export default nextConfig;
