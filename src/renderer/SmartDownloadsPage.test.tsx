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
  status: {
    configured: false,
    state: "not-configured",
    paused: false,
    enabledChannelCount: 0,
    error: null,
  },
  check: {
    state: "idle",
    trigger: null,
    reason: null,
    channelId: null,
    totalChannels: 0,
    checkedChannels: 0,
    newVideosFound: 0,
    queuedVideos: 0,
    failures: 0,
    startedAt: null,
    completedAt: null,
    error: null,
  },
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

  it("renders real check progress and result messages", () => {
    const checking = renderToStaticMarkup(
      <SmartDownloadsPage
        snapshot={{
          ...snapshot,
          checking: true,
          check: {
            ...snapshot.check,
            state: "checking",
            trigger: "manual",
            totalChannels: 5,
            checkedChannels: 1,
            startedAt: 1,
          },
        }}
        onBack={vi.fn()}
      />,
    );
    expect(checking).toContain("Checking 2 of 5 channels");

    const completed = renderToStaticMarkup(
      <SmartDownloadsPage
        snapshot={{
          ...snapshot,
          check: {
            ...snapshot.check,
            state: "completed",
            trigger: "manual",
            totalChannels: 2,
            checkedChannels: 2,
            newVideosFound: 3,
            queuedVideos: 3,
            startedAt: 1,
            completedAt: 2,
          },
        }}
        onBack={vi.fn()}
      />,
    );
    expect(completed).toContain("3 new videos found");
  });
});
