"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { youtubeThumbnailUrl } from "@/lib/youtube-thumbnail";

type YouTubeThumbnailProps = {
  videoId: string | null | undefined;
  src?: string | null;
  alt?: string;
  className?: string;
  imgClassName?: string;
  loading?: "eager" | "lazy";
};

export function YouTubeThumbnail({
  videoId,
  src,
  alt = "",
  className,
  imgClassName,
  loading = "lazy",
}: YouTubeThumbnailProps) {
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const urls = [
      src?.trim() || null,
      youtubeThumbnailUrl(videoId, "hqdefault"),
      youtubeThumbnailUrl(videoId, "mqdefault"),
      youtubeThumbnailUrl(videoId, "default"),
    ];
    return urls.filter((url): url is string => {
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  }, [src, videoId]);

  const [index, setIndex] = useState(0);
  const current = candidates[index] ?? null;

  useEffect(() => {
    setIndex(0);
  }, [candidates]);

  return (
    <span
      className={cn(
        "relative block aspect-video shrink-0 overflow-hidden bg-black",
        className
      )}
    >
      {current ? (
        // YouTube thumbnails are cross-origin and do not need Next image optimization here.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={current}
          src={current}
          alt={alt}
          className={cn("h-full w-full object-cover", imgClassName)}
          loading={loading}
          referrerPolicy="no-referrer"
          onError={() => setIndex((next) => next + 1)}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[10px] font-semibold uppercase tracking-wider text-white/70">
          YouTube
        </span>
      )}
    </span>
  );
}
