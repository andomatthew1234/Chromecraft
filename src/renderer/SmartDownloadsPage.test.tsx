import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SmartDownloadsSnapshot } from "../shared/browser";
import { SmartDownloadsPage } from "./SmartDownloadsPage";

const snapshot: SmartDownloadsSnapshot = {
  config: {
    enabled: false,
    storageQuotaBytes: 10 * 1024 ** 3,
    quality: "720p",
    cleanupPolicy: "pause",
    checkIntervalMinutes: 60,
    includeShorts: false,
    includeLivestreamReplays: false,
    pauseDuringHeavyActivity: true,
    backgroundEnabled: false,
    startWithWindows: false,
    recommendationsEnabled: false,
  },
  storage: {
    quotaBytes: 10 * 1024 ** 3,
    usedBytes: 0,
    availableBytes: 10 * 1024 ** 3,
    reservedBytes: 0,
    diskAvailableBytes: 100 * 1024 ** 3,
    maximumQuotaBytes: 99 * 1024 ** 3,
    managedDownloadCount: 0,
  },
  channels: [],
  queue: [],
  recommendations: [],
  cleanupPreview: [],
  queuePaused: false,
  checking: false,
  lastCheckAt: null,
  nextCheckAt: null,
  backgroundRunning: false,
  error: null,
};

describe("SmartDownloadsPage", () => {
  it("renders the real empty, storage, privacy and background controls", () => {
    const markup = renderToStaticMarkup(
      <SmartDownloadsPage snapshot={snapshot} onBack={vi.fn()} />,
    );

    expect(markup).toContain("Smart Downloads");
    expect(markup).toContain("No channels followed yet");
    expect(markup).toContain("10 GB");
    expect(markup).toContain(
      "Use YouTube viewing activity for recommendations",
    );
    expect(markup).toContain("Keep checking while Chromecraft is closed");
    expect(markup).not.toContain("Example channel");
  });
});
