import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OfflinePagesSnapshot } from "../shared/offline-pages";
import { OfflinePagesPage } from "./OfflinePagesPage";

const snapshot: OfflinePagesSnapshot = {
  save: {
    stage: "idle",
    tabId: null,
    title: null,
    sourceUrl: null,
    entryId: null,
    error: null,
  },
  items: [
    {
      id: "page-1",
      title: "A useful article",
      sourceUrl: "https://example.com/article",
      archiveUrl: "chromecraft-offline://page-1/index.html",
      savedAt: Date.UTC(2026, 9, 23),
      fileSize: 1_572_864,
      thumbnailUrl: "chromecraft-offline://page-1/thumbnail.png",
      available: true,
    },
  ],
};

describe("OfflinePagesPage", () => {
  it("renders searchable saved-page cards without filesystem paths", () => {
    const markup = renderToStaticMarkup(
      <OfflinePagesPage snapshot={snapshot} selectedId="page-1" />,
    );

    expect(markup).toContain("Offline Pages");
    expect(markup).toContain("A useful article");
    expect(markup).toContain("example.com");
    expect(markup).toContain("1.5 MB");
    expect(markup).toContain("Open offline");
    expect(markup).not.toContain("C:\\");
  });

  it("explains how to save the first offline page", () => {
    const markup = renderToStaticMarkup(
      <OfflinePagesPage
        snapshot={{ ...snapshot, items: [] }}
        selectedId={null}
      />,
    );

    expect(markup).toContain("No offline pages yet");
    expect(markup).toContain("press the info icon");
    expect(markup).toContain("Save for later");
  });
});
