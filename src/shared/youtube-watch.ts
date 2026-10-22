export interface YouTubeWatchTarget {
  videoId: string;
  url: string;
}

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Accepts only ordinary, public YouTube watch-page URLs. Keeping this parser
 * shared lets the UI describe the same target that the main process validates
 * again immediately before starting yt-dlp.
 */
export function parseYouTubeWatchUrl(input: string): YouTubeWatchTarget | null {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hostname.toLowerCase() !== "www.youtube.com" ||
      url.pathname !== "/watch"
    ) {
      return null;
    }
    const videoId = url.searchParams.get("v")?.trim() ?? "";
    if (!VIDEO_ID_PATTERN.test(videoId)) return null;
    return { videoId, url: url.href };
  } catch {
    return null;
  }
}
