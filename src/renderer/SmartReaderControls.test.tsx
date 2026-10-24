import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BrowserTabSnapshot } from "../shared/browser";
import { SmartReaderControls } from "./SmartReaderControls";

function tab(
  availability: BrowserTabSnapshot["reader"]["availability"],
  active = false,
): BrowserTabSnapshot {
  return {
    id: "tab-1",
    title: "Article",
    url: "https://example.com/article",
    faviconDataUrl: null,
    isNewTab: false,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    error: null,
    isMuted: false,
    zoomFactor: 1,
    pinned: false,
    groupId: null,
    isSelected: false,
    isAudible: false,
    memoryBytes: null,
    thumbnailDataUrl: null,
    reader: { availability, active, revision: 2 },
  };
}

describe("SmartReaderControls", () => {
  it("stays hidden until a page is verified as readable", () => {
    expect(
      renderToStaticMarkup(
        <SmartReaderControls
          tab={tab("checking")}
          onPopoverOpenChange={vi.fn()}
        />,
      ),
    ).toBe("");
  });

  it("offers a single accessible entry button for readable pages", () => {
    const markup = renderToStaticMarkup(
      <SmartReaderControls
        tab={tab("available")}
        onPopoverOpenChange={vi.fn()}
      />,
    );
    expect(markup).toContain("Open Smart Reader");
    expect(markup).toContain("data-smart-reader-button");
    expect(markup).not.toContain("Reading appearance");
  });

  it("keeps exit and appearance controls visible while active", () => {
    const markup = renderToStaticMarkup(
      <SmartReaderControls
        tab={tab("available", true)}
        onPopoverOpenChange={vi.fn()}
      />,
    );
    expect(markup).toContain("Exit Smart Reader");
    expect(markup).toContain("Reading appearance");
    expect(markup).toContain('aria-pressed="true"');
  });
});
