import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { YouTubeDownloadBanner } from "./YouTubeDownloadBanner";

describe("YouTubeDownloadBanner", () => {
  it("offers a download and can be dismissed", () => {
    const markup = renderToStaticMarkup(
      <YouTubeDownloadBanner
        available
        download={null}
        onDownload={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(markup).toContain("Download this video for later?");
    expect(markup).toContain(">Download</button>");
    expect(markup).toContain('aria-label="Close YouTube download banner"');
  });

  it("reports truthful progress", () => {
    const markup = renderToStaticMarkup(
      <YouTubeDownloadBanner
        available
        download={{
          id: "job",
          videoId: "dQw4w9WgXcQ",
          sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          filename: null,
          stage: "downloading",
          percent: 42,
          receivedBytes: 42,
          totalBytes: 100,
          error: null,
          startedAt: 1,
          finishedAt: null,
        }}
        onDownload={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(markup).toContain("Downloading video… 42%");
    expect(markup).toContain('value="42"');
  });
});
