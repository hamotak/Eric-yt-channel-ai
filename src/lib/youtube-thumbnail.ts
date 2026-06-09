const YT_THUMB_BASE = "https://i.ytimg.com/vi";

export function youtubeThumbnailUrl(
  videoId: string | null | undefined,
  quality: "hqdefault" | "mqdefault" | "default" = "hqdefault"
): string | null {
  const id = videoId?.trim();
  return id ? `${YT_THUMB_BASE}/${encodeURIComponent(id)}/${quality}.jpg` : null;
}

export function fallbackYouTubeThumbnailUrl(
  videoId: string | null | undefined
): string | null {
  return youtubeThumbnailUrl(videoId, "mqdefault");
}
