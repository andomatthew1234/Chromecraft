import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  shouldRaiseDownloadOverlay,
  YouTubeDownloadProgress,
} from "./YouTubeDownloadProgress";

describe("YouTubeDownloadProgress", () => {
  it("shows truthful determinate yt-dlp progress", () => {
    const markup = renderToStaticMarkup(
      <YouTubeDownloadProgress
        snapshot={{
          available: true,
          ytDlpVersion: "test",
          items: [
            {
              id: "job",
              videoId: "abcdefghijk",
              sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
              filename: "Video.mp4",
              stage: "downloading",
              percent: 42,
              receivedBytes: 42_000_000,
              totalBytes: 100_000_000,
              bytesPerSecond: 5_000_000,
              etaSeconds: 12,
              error: null,
              startedAt: 1,
              finishedAt: null,
            },
          ],
        }}
        onCancel={() => undefined}
        onRetry={() => undefined}
        onOpenGallery={() => undefined}
        onOpenFile={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(markup).toContain("Downloading video… 42%");
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain("MB/s");
    expect(markup).toContain("12s left");
  });

  it("only claims Gallery registration after the main process confirms it", () => {
    const item = {
      id: "done",
      videoId: "abcdefghijk",
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      filename: "Video.mp4",
      stage: "completed" as const,
      percent: 100,
      receivedBytes: 100,
      totalBytes: 100,
      bytesPerSecond: null,
      etaSeconds: null,
      error: null,
      startedAt: 1,
      finishedAt: 2,
    };
    const render = (savedToGallery: boolean) =>
      renderToStaticMarkup(
        <YouTubeDownloadProgress
          snapshot={{
            available: true,
            ytDlpVersion: "test",
            items: [{ ...item, savedToGallery }],
          }}
          onCancel={() => undefined}
          onRetry={() => undefined}
          onOpenGallery={() => undefined}
          onOpenFile={() => undefined}
          onDismiss={() => undefined}
        />,
      );
    expect(render(false)).toContain("Saved to Downloads");
    expect(render(false)).not.toContain("Saved to My Gallery");
    expect(render(true)).toContain("Saved to My Gallery");
  });

  it("drops the website-covering overlay after a terminal item auto-hides", () => {
    const completed = {
      id: "done",
      videoId: "abcdefghijk",
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      filename: "Video.mp4",
      stage: "completed" as const,
      percent: 100,
      receivedBytes: 100,
      totalBytes: 100,
      bytesPerSecond: null,
      etaSeconds: null,
      error: null,
      startedAt: 1,
      finishedAt: 2,
    };
    expect(shouldRaiseDownloadOverlay(true, completed, null)).toBe(true);
    expect(shouldRaiseDownloadOverlay(true, completed, completed.id)).toBe(
      false,
    );
  });
});
