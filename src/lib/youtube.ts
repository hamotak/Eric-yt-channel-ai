import "server-only";

/**
 * YouTube Data API v3 client — API-key (public data) only.
 * Docs: https://developers.google.com/youtube/v3/docs
 *
 * Cost-aware: we use /channels, /search (only as last resort — 100 units),
 * /playlistItems (1 unit/page of 50), /videos (1 unit/page of 50).
 */

const BASE = "https://www.googleapis.com/youtube/v3";

export type ResolvedChannel = {
  id: string;
  title: string;
  handle: string | null;
  description: string;
  subscribers: number | null;
  views: number | null;
  videoCount: number | null;
  uploadsPlaylistId: string;
  thumbnail: string | null;
};

export type YtVideo = {
  id: string;
  title: string;
  description: string;
  publishedAt: number; // unix seconds
  durationSeconds: number | null;
  views: number;
  likes: number;
  comments: number;
  thumbnail: string | null;
  tags: string[];
  channelId: string;
};

export class YouTubeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string
): Promise<T> {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? "";
    } catch {
      /* ignore */
    }
    throw new YouTubeApiError(
      `YouTube API ${res.status}: ${detail || res.statusText}`,
      res.status
    );
  }
  return (await res.json()) as T;
}

/** Parse ISO 8601 duration like PT1H2M3S → seconds. */
export function parseIsoDuration(iso: string): number | null {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, h, mi, s] = m;
  return (parseInt(h ?? "0", 10) || 0) * 3600 +
    (parseInt(mi ?? "0", 10) || 0) * 60 +
    (parseInt(s ?? "0", 10) || 0);
}

/**
 * Accepts any of:
 *  - UC-prefixed channel ID (UCxxxxx)
 *  - @handle (e.g. @mrbeast)
 *  - full youtube.com URL: /channel/UC..., /@handle, /c/Name, /user/Name
 *  - bare handle (mrbeast)
 * Returns resolved channel or throws YouTubeApiError.
 */
export async function resolveChannel(
  input: string,
  apiKey: string
): Promise<ResolvedChannel> {
  const raw = input.trim();
  if (!raw) throw new YouTubeApiError("empty input", 400);

  // Try to pull a channel id or handle out of URLs
  let channelId: string | null = null;
  let handle: string | null = null;
  let legacyName: string | null = null;

  if (raw.startsWith("UC") && raw.length >= 20 && !raw.includes("/")) {
    channelId = raw;
  } else if (raw.startsWith("@")) {
    handle = raw.slice(1);
  } else {
    try {
      const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0]?.startsWith("@")) handle = parts[0].slice(1);
      else if (parts[0] === "channel" && parts[1]?.startsWith("UC")) channelId = parts[1];
      else if (parts[0] === "c" && parts[1]) legacyName = parts[1];
      else if (parts[0] === "user" && parts[1]) legacyName = parts[1];
    } catch {
      // not a URL — treat as handle
      handle = raw;
    }
  }

  // Resolve to channel id
  if (!channelId) {
    if (handle) {
      const res = await call<{ items: { id: string }[] }>(
        "channels",
        { part: "id", forHandle: handle },
        apiKey
      );
      if (res.items?.[0]) channelId = res.items[0].id;
    }
    if (!channelId && legacyName) {
      // Fallback via search (costs 100 units — only for legacy /c/Name)
      const res = await call<{ items: { id: { channelId?: string } }[] }>(
        "search",
        { part: "snippet", q: legacyName, type: "channel", maxResults: 1 },
        apiKey
      );
      channelId = res.items?.[0]?.id?.channelId ?? null;
    }
  }

  if (!channelId) {
    throw new YouTubeApiError(`Could not resolve channel from "${raw}"`, 404);
  }

  // Fetch full channel data
  const res = await call<{
    items: {
      id: string;
      snippet: {
        title: string;
        description: string;
        customUrl?: string;
        thumbnails?: {
          high?: { url: string };
          medium?: { url: string };
          default?: { url: string };
        };
      };
      statistics?: {
        subscriberCount?: string;
        viewCount?: string;
        videoCount?: string;
        hiddenSubscriberCount?: boolean;
      };
      contentDetails: { relatedPlaylists: { uploads: string } };
    }[];
  }>(
    "channels",
    { part: "snippet,statistics,contentDetails", id: channelId },
    apiKey
  );

  const item = res.items?.[0];
  if (!item) throw new YouTubeApiError(`Channel ${channelId} not found`, 404);

  const st = item.statistics ?? {};
  return {
    id: item.id,
    title: item.snippet.title,
    handle: item.snippet.customUrl ?? (handle ? `@${handle}` : null),
    description: item.snippet.description,
    // Hidden-subs sentinel: -1 (not null) so the UI can render "Hidden"
    // rather than "—". Real null still means "couldn't fetch / no data".
    subscribers: st.hiddenSubscriberCount
      ? -1
      : st.subscriberCount
        ? parseInt(st.subscriberCount, 10)
        : null,
    views: st.viewCount ? parseInt(st.viewCount, 10) : null,
    videoCount: st.videoCount ? parseInt(st.videoCount, 10) : null,
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    // Hi-to-lo thumbnail fallback. .medium was missing from the chain,
    // which is the most common available size when .high is absent.
    thumbnail:
      item.snippet.thumbnails?.high?.url ??
      item.snippet.thumbnails?.medium?.url ??
      item.snippet.thumbnails?.default?.url ??
      null,
  };
}

/** List *all* video IDs in a channel's uploads playlist (paginated). */
export async function listUploadIds(
  uploadsPlaylistId: string,
  apiKey: string,
  opts: { max?: number; onPage?: (soFar: number) => void } = {}
): Promise<string[]> {
  const max = opts.max ?? 10_000;
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await call<{
      nextPageToken?: string;
      items: { contentDetails: { videoId: string } }[];
    }>(
      "playlistItems",
      { part: "contentDetails", playlistId: uploadsPlaylistId, maxResults: 50, pageToken },
      apiKey
    );
    for (const it of res.items ?? []) {
      ids.push(it.contentDetails.videoId);
      if (ids.length >= max) break;
    }
    opts.onPage?.(ids.length);
    pageToken = res.nextPageToken;
  } while (pageToken && ids.length < max);

  return ids;
}

/** Batch-fetch full video metadata for up to N video IDs. */
export async function fetchVideos(
  videoIds: string[],
  apiKey: string,
  opts: { onBatch?: (done: number) => void } = {}
): Promise<YtVideo[]> {
  const out: YtVideo[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const res = await call<{
      items: {
        id: string;
        snippet: {
          channelId: string;
          title: string;
          description: string;
          publishedAt: string;
          tags?: string[];
          thumbnails?: { high?: { url: string }; medium?: { url: string } };
        };
        contentDetails: { duration: string };
        statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
      }[];
    }>(
      "videos",
      { part: "snippet,contentDetails,statistics", id: batch.join(",") },
      apiKey
    );

    for (const v of res.items ?? []) {
      out.push({
        id: v.id,
        channelId: v.snippet.channelId,
        title: v.snippet.title,
        description: v.snippet.description,
        publishedAt: Math.floor(new Date(v.snippet.publishedAt).getTime() / 1000),
        durationSeconds: parseIsoDuration(v.contentDetails.duration),
        views: v.statistics.viewCount ? parseInt(v.statistics.viewCount, 10) : 0,
        likes: v.statistics.likeCount ? parseInt(v.statistics.likeCount, 10) : 0,
        comments: v.statistics.commentCount ? parseInt(v.statistics.commentCount, 10) : 0,
        thumbnail:
          v.snippet.thumbnails?.high?.url ?? v.snippet.thumbnails?.medium?.url ?? null,
        tags: v.snippet.tags ?? [],
      });
    }
    opts.onBatch?.(out.length);
  }
  return out;
}

/** Fetch top-level comments for a video (up to `max`). */
export async function fetchComments(
  videoId: string,
  apiKey: string,
  max = 100
): Promise<{ author: string; text: string; likes: number; publishedAt: number }[]> {
  const out: { author: string; text: string; likes: number; publishedAt: number }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await call<{
      nextPageToken?: string;
      items: {
        snippet: {
          topLevelComment: {
            snippet: {
              authorDisplayName: string;
              textDisplay: string;
              likeCount: number;
              publishedAt: string;
            };
          };
        };
      }[];
    }>(
      "commentThreads",
      { part: "snippet", videoId, maxResults: 100, pageToken, order: "relevance" },
      apiKey
    );
    for (const it of res.items ?? []) {
      const s = it.snippet.topLevelComment.snippet;
      out.push({
        author: s.authorDisplayName,
        text: s.textDisplay,
        likes: s.likeCount,
        publishedAt: Math.floor(new Date(s.publishedAt).getTime() / 1000),
      });
      if (out.length >= max) return out;
    }
    pageToken = res.nextPageToken;
  } while (pageToken && out.length < max);
  return out;
}

export type YtCommentThread = {
  id: string;
  parentId: string | null;
  author: string;
  authorChannelId: string | null;
  text: string;
  likes: number;
  publishedAt: number;
  updatedAt: number;
  replyCount: number;
};

/**
 * Fetch comment threads for a video with replies inlined.
 * Uses `part=snippet,replies` to get up to 5 replies per thread in a single
 * call. For threads with more replies, the caller should hit
 * `fetchCommentReplies(parentId, ...)` separately.
 * Quota: 1 unit per page of 100 threads.
 */
export async function fetchCommentThreads(
  videoId: string,
  apiKey: string,
  opts: { maxThreads?: number; order?: "relevance" | "time" } = {}
): Promise<YtCommentThread[]> {
  const maxThreads = opts.maxThreads ?? 200;
  const order = opts.order ?? "relevance";
  const out: YtCommentThread[] = [];
  let pageToken: string | undefined;

  type CommentSnippet = {
    authorDisplayName: string;
    authorChannelId?: { value?: string };
    textDisplay: string;
    likeCount: number;
    publishedAt: string;
    updatedAt: string;
  };

  do {
    const res = await call<{
      nextPageToken?: string;
      items: {
        id: string;
        snippet: {
          totalReplyCount: number;
          topLevelComment: { id: string; snippet: CommentSnippet };
        };
        replies?: { comments: { id: string; snippet: CommentSnippet }[] };
      }[];
    }>(
      "commentThreads",
      {
        part: "snippet,replies",
        videoId,
        maxResults: 100,
        pageToken,
        order,
        textFormat: "plainText",
      },
      apiKey
    );

    for (const thread of res.items ?? []) {
      const top = thread.snippet.topLevelComment;
      const ts = top.snippet;
      const threadId = top.id;
      out.push({
        id: threadId,
        parentId: null,
        author: ts.authorDisplayName,
        authorChannelId: ts.authorChannelId?.value ?? null,
        text: ts.textDisplay,
        likes: ts.likeCount,
        publishedAt: Math.floor(new Date(ts.publishedAt).getTime() / 1000),
        updatedAt: Math.floor(new Date(ts.updatedAt).getTime() / 1000),
        replyCount: thread.snippet.totalReplyCount ?? 0,
      });
      for (const r of thread.replies?.comments ?? []) {
        const rs = r.snippet;
        out.push({
          id: r.id,
          parentId: threadId,
          author: rs.authorDisplayName,
          authorChannelId: rs.authorChannelId?.value ?? null,
          text: rs.textDisplay,
          likes: rs.likeCount,
          publishedAt: Math.floor(new Date(rs.publishedAt).getTime() / 1000),
          updatedAt: Math.floor(new Date(rs.updatedAt).getTime() / 1000),
          replyCount: 0,
        });
      }
      if (out.filter((c) => c.parentId === null).length >= maxThreads) {
        return out;
      }
    }
    pageToken = res.nextPageToken;
  } while (pageToken);

  return out;
}

/**
 * Fetch ALL replies for a single parent comment (for threads where the
 * inlined replies in fetchCommentThreads were truncated at 5).
 * Quota: 1 unit per page of 100.
 */
export async function fetchCommentReplies(
  parentId: string,
  apiKey: string,
  max = 200
): Promise<YtCommentThread[]> {
  const out: YtCommentThread[] = [];
  let pageToken: string | undefined;

  do {
    const res = await call<{
      nextPageToken?: string;
      items: {
        id: string;
        snippet: {
          authorDisplayName: string;
          authorChannelId?: { value?: string };
          textDisplay: string;
          likeCount: number;
          publishedAt: string;
          updatedAt: string;
        };
      }[];
    }>(
      "comments",
      { part: "snippet", parentId, maxResults: 100, pageToken, textFormat: "plainText" },
      apiKey
    );
    for (const r of res.items ?? []) {
      const s = r.snippet;
      out.push({
        id: r.id,
        parentId,
        author: s.authorDisplayName,
        authorChannelId: s.authorChannelId?.value ?? null,
        text: s.textDisplay,
        likes: s.likeCount,
        publishedAt: Math.floor(new Date(s.publishedAt).getTime() / 1000),
        updatedAt: Math.floor(new Date(s.updatedAt).getTime() / 1000),
        replyCount: 0,
      });
      if (out.length >= max) return out;
    }
    pageToken = res.nextPageToken;
  } while (pageToken && out.length < max);

  return out;
}

/**
 * YouTube Search Autocomplete / Suggest (free, no API key).
 * Returns what YouTube users literally type.
 */
export async function youtubeSuggest(
  query: string,
  opts: { hl?: string; gl?: string } = {}
): Promise<string[]> {
  const url = new URL("https://suggestqueries.google.com/complete/search");
  url.searchParams.set("client", "youtube");
  url.searchParams.set("ds", "yt");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", opts.hl ?? "en");
  if (opts.gl) url.searchParams.set("gl", opts.gl);
  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Suggest ${res.status}`);
  const text = await res.text();
  // JSONP-like: window.google.ac.h([...]); — extract the array.
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const data = JSON.parse(m[0]) as [string, [string, unknown][]];
    return (data[1] ?? [])
      .map((pair) => (Array.isArray(pair) ? String(pair[0]) : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * YouTube Trending videos by region.
 * Uses Data API chart=mostPopular. Cheap (1 unit per page of 50).
 */
export async function fetchTrending(
  apiKey: string,
  opts: { regionCode?: string; categoryId?: string; maxResults?: number } = {}
): Promise<YtVideo[]> {
  const res = await call<{
    items: {
      id: string;
      snippet: {
        channelId: string;
        channelTitle?: string;
        title: string;
        description: string;
        publishedAt: string;
        tags?: string[];
        thumbnails?: { high?: { url: string }; medium?: { url: string } };
      };
      contentDetails: { duration: string };
      statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
    }[];
  }>(
    "videos",
    {
      part: "snippet,contentDetails,statistics",
      chart: "mostPopular",
      regionCode: opts.regionCode ?? "US",
      videoCategoryId: opts.categoryId,
      maxResults: Math.min(50, opts.maxResults ?? 25),
    },
    apiKey
  );
  return (res.items ?? []).map((v) => ({
    id: v.id,
    channelId: v.snippet.channelId,
    title: v.snippet.title,
    description: v.snippet.description,
    publishedAt: Math.floor(new Date(v.snippet.publishedAt).getTime() / 1000),
    durationSeconds: parseIsoDuration(v.contentDetails.duration),
    views: v.statistics.viewCount ? parseInt(v.statistics.viewCount, 10) : 0,
    likes: v.statistics.likeCount ? parseInt(v.statistics.likeCount, 10) : 0,
    comments: v.statistics.commentCount ? parseInt(v.statistics.commentCount, 10) : 0,
    thumbnail: v.snippet.thumbnails?.high?.url ?? v.snippet.thumbnails?.medium?.url ?? null,
    tags: v.snippet.tags ?? [],
  }));
}
/**
 * Niche Explorer — find top channels and outlier videos for a topic/niche.
 * Replacement for NexLev's niche finder, built on public Data API.
 */
export async function nicheExplorer(
  topic: string,
  apiKey: string,
  opts: { maxChannels?: number } = {}
): Promise<{
  topChannels: {
    id: string;
    title: string;
    subscribers: number | null;
    videoCount: number | null;
    totalViews: number | null;
  }[];
  outliers: {
    videoId: string;
    title: string;
    channelId: string;
    channelTitle: string;
    views: number;
    publishedAt: string;
  }[];
}> {
  const maxChannels = Math.min(10, opts.maxChannels ?? 5);

  // Phase 1: search channels in topic
  const chSearch = await call<{
    items: { id: { channelId: string } }[];
  }>(
    "search",
    { part: "snippet", q: topic, type: "channel", maxResults: maxChannels },
    apiKey
  );
  const ids = (chSearch.items ?? []).map((i) => i.id.channelId).filter(Boolean);
  if (!ids.length) return { topChannels: [], outliers: [] };

  // Phase 2: batch stats for channels
  const chStats = await call<{
    items: {
      id: string;
      snippet: { title: string };
      statistics: { subscriberCount?: string; viewCount?: string; videoCount?: string };
    }[];
  }>(
    "channels",
    { part: "snippet,statistics", id: ids.join(",") },
    apiKey
  );

  const topChannels = (chStats.items ?? []).map((c) => ({
    id: c.id,
    title: c.snippet.title,
    subscribers: c.statistics.subscriberCount
      ? parseInt(c.statistics.subscriberCount, 10)
      : null,
    videoCount: c.statistics.videoCount ? parseInt(c.statistics.videoCount, 10) : null,
    totalViews: c.statistics.viewCount ? parseInt(c.statistics.viewCount, 10) : null,
  }));

  // Phase 3: search recent high-view videos in topic (outliers proxy)
  const vidSearch = await call<{
    items: {
      id: { videoId: string };
      snippet: { channelId: string; channelTitle: string; title: string; publishedAt: string };
    }[];
  }>(
    "search",
    {
      part: "snippet",
      q: topic,
      type: "video",
      order: "viewCount",
      maxResults: 15,
      publishedAfter: new Date(Date.now() - 180 * 86400_000).toISOString(),
    },
    apiKey
  );

  const vidIds = (vidSearch.items ?? []).map((v) => v.id.videoId);
  const vidStats = vidIds.length
    ? await call<{
        items: { id: string; statistics: { viewCount?: string } }[];
      }>(
        "videos",
        { part: "statistics", id: vidIds.join(",") },
        apiKey
      )
    : { items: [] };
  const viewMap = new Map(
    (vidStats.items ?? []).map((v) => [v.id, parseInt(v.statistics.viewCount ?? "0", 10)])
  );

  const outliers = (vidSearch.items ?? [])
    .map((v) => ({
      videoId: v.id.videoId,
      title: v.snippet.title,
      channelId: v.snippet.channelId,
      channelTitle: v.snippet.channelTitle,
      views: viewMap.get(v.id.videoId) ?? 0,
      publishedAt: v.snippet.publishedAt,
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 10);

  return { topChannels, outliers };
}

/** Public search across YouTube (100 units — use sparingly). */
export async function searchYouTube(
  query: string,
  apiKey: string,
  opts: { maxResults?: number; type?: "video" | "channel" } = {}
): Promise<{ id: string; kind: string; title: string; channelTitle: string; publishedAt: string }[]> {
  const res = await call<{
    items: {
      id: { kind: string; videoId?: string; channelId?: string };
      snippet: { title: string; channelTitle: string; publishedAt: string };
    }[];
  }>(
    "search",
    {
      part: "snippet",
      q: query,
      type: opts.type ?? "video",
      maxResults: opts.maxResults ?? 10,
    },
    apiKey
  );
  return (res.items ?? []).map((it) => ({
    id: it.id.videoId ?? it.id.channelId ?? "",
    kind: it.id.kind,
    title: it.snippet.title,
    channelTitle: it.snippet.channelTitle,
    publishedAt: it.snippet.publishedAt,
  }));
}
