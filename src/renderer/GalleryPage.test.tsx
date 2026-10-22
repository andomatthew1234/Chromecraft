import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GallerySnapshot } from "../shared/browser";
import { GalleryPage } from "./GalleryPage";

const snapshot: GallerySnapshot = {
  items: [
    {
      id: "video-1",
      title: "A local video",
      filename: "A local video.mp4",
      filePath: "C:\\Downloads\\A local video.mp4",
      mediaUrl: "chromecraft-media://video/video-1",
      durationSeconds: 125,
      width: 1920,
      height: 1080,
      fileSize: 12_345_678,
      downloadedAt: 1_700_000_000_000,
      sourceName: "YouTube",
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      available: true,
    },
  ],
};

describe("GalleryPage", () => {
  it("renders a local searchable library with file actions", () => {
    const markup = renderToStaticMarkup(
      <GalleryPage snapshot={snapshot} selectedId={null} />,
    );
    expect(markup).toContain("My Gallery");
    expect(markup).toContain("A local video");
    expect(markup).toContain("1920 × 1080");
    expect(markup).toContain("Copy file path");
    expect(markup).toContain("Delete from disk");
    expect(markup).toContain("chromecraft-media://video/video-1");
    expect(markup).toContain("Delete all");
    expect(markup).not.toContain("Import downloads");
  });

  it("opens a selected item in the built-in player", () => {
    const markup = renderToStaticMarkup(
      <GalleryPage snapshot={snapshot} selectedId="video-1" />,
    );
    expect(markup).toContain("Now playing");
    expect(markup).toContain("Picture in picture");
    expect(markup).toContain("Speed");
  });
});
