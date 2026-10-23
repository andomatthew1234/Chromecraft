import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  GallerySnapshot,
  SmartDownloadsSnapshot,
} from "../shared/browser";
import { formatGalleryRepairResult, GalleryPage } from "./GalleryPage";

const snapshot: GallerySnapshot = {
  items: [
    {
      id: "video-1",
      title: "A local video with a title that can use two balanced lines",
      filename: "A local video.mp4",
      filePath: "C:\\Downloads\\A local video.mp4",
      mediaUrl: "chromecraft-media://video/video-1",
      thumbnailUrl: "chromecraft-media://thumbnail/video-1",
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

const smartDownloadsBase: SmartDownloadsSnapshot = {
  config: {
    enabled: true,
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
    diskAvailableBytes: null,
    maximumQuotaBytes: 10 * 1024 ** 3,
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

function renderGallery(smartDownloads: SmartDownloadsSnapshot) {
  return renderToStaticMarkup(
    <GalleryPage
      snapshot={snapshot}
      selectedId={null}
      onOpenSmartDownloads={vi.fn()}
      smartDownloads={smartDownloads}
    />,
  );
}

describe("GalleryPage", () => {
  it("renders a polished local library with secure thumbnails and custom controls", () => {
    const markup = renderGallery(smartDownloadsBase);
    expect(markup).toContain("My Gallery");
    expect(markup).toContain("A local video");
    expect(markup).toContain("1080p");
    expect(markup).toContain("12 MB");
    expect(markup).toContain("chromecraft-media://thumbnail/video-1");
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('aria-label="More actions for');
    expect(markup).toContain("Delete all");
    expect(markup).toContain("Manage My Gallery");
    expect(markup).toContain("Repair Gallery");
    expect(markup).not.toContain("Import downloads");
    expect(markup).not.toContain("Resolution unknown");
    expect(markup).not.toContain("Duration unknown");
  });

  it("summarises real Gallery repair results without exposing raw errors", () => {
    expect(
      formatGalleryRepairResult({
        scanned: 4,
        thumbnailsRepaired: 2,
        originalThumbnailsFetched: 1,
        localFallbacksGenerated: 1,
        metadataRecovered: 1,
        missingThumbnails: 0,
        metadataUnavailable: 0,
        errors: [{ id: "video-4", message: "raw internal detail" }],
      }),
    ).toBe("2 thumbnails repaired · 1 video updated · 1 item needs attention.");
    expect(
      formatGalleryRepairResult({
        scanned: 2,
        thumbnailsRepaired: 0,
        originalThumbnailsFetched: 0,
        localFallbacksGenerated: 0,
        metadataRecovered: 0,
        missingThumbnails: 0,
        metadataUnavailable: 0,
        errors: [],
      }),
    ).toBe("Your Gallery is already healthy.");
    expect(
      formatGalleryRepairResult({
        scanned: 1,
        thumbnailsRepaired: 0,
        originalThumbnailsFetched: 0,
        localFallbacksGenerated: 0,
        metadataRecovered: 0,
        missingThumbnails: 1,
        metadataUnavailable: 1,
        errors: [],
      }),
    ).toBe("1 thumbnail is still unavailable · 1 video has limited metadata.");
  });

  it("shows setup only when persisted Smart Downloads state is not configured", () => {
    const setupMarkup = renderGallery(smartDownloadsBase);
    expect(setupMarkup).toContain("Set up Smart Downloads?");
    expect(setupMarkup).toContain("Check Smart Downloads");

    const configuredMarkup = renderGallery({
      ...smartDownloadsBase,
      channels: [
        {
          id: "channel-1",
          title: "A creator",
          handle: "@creator",
          avatarUrl: null,
          enabled: true,
          lastCheckedAt: null,
          lastSuccessfulCheckAt: null,
          nextCheckAt: null,
          downloadedCount: 0,
          pendingCount: 0,
          status: "active",
          error: null,
        },
      ],
      status: {
        configured: true,
        state: "active",
        paused: false,
        enabledChannelCount: 1,
        error: null,
      },
    });
    expect(configuredMarkup).not.toContain("Set up Smart Downloads?");
    expect(configuredMarkup).toContain("Check Smart Downloads now");
  });

  it("shows a compact paused state instead of the setup banner", () => {
    const markup = renderGallery({
      ...smartDownloadsBase,
      config: { ...smartDownloadsBase.config, enabled: false },
      status: {
        configured: true,
        state: "disabled",
        paused: true,
        enabledChannelCount: 0,
        error: null,
      },
    });
    expect(markup).toContain("Smart Downloads is paused");
    expect(markup).not.toContain("Set up Smart Downloads?");
  });

  it("shows real structured check progress", () => {
    const markup = renderGallery({
      ...smartDownloadsBase,
      status: {
        configured: true,
        state: "checking",
        paused: false,
        enabledChannelCount: 5,
        error: null,
      },
      check: {
        ...smartDownloadsBase.check,
        state: "checking",
        trigger: "manual",
        totalChannels: 5,
        checkedChannels: 1,
        startedAt: 1_700_000_000_000,
      },
    });
    expect(markup).toContain("Checking Smart Downloads");
    expect(markup).toContain("Checking 2 of 5 channels");
  });

  it("opens a selected item in the built-in player", () => {
    const markup = renderToStaticMarkup(
      <GalleryPage
        snapshot={snapshot}
        selectedId="video-1"
        onOpenSmartDownloads={vi.fn()}
        smartDownloads={smartDownloadsBase}
      />,
    );
    expect(markup).toContain("Now playing");
    expect(markup).toContain('aria-label="Picture in picture"');
    expect(markup).toContain('aria-label="Playback speed"');
    expect(markup).toContain('aria-label="Play video"');
    expect(markup).toContain('aria-label="Video progress"');
    expect(markup).toContain('type="range"');
  });
});
