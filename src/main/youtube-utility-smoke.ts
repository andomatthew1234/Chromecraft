import { promises as fs } from "node:fs";
import path from "node:path";

import type { DownloadManager } from "./download-manager";
import type { GalleryStore } from "./gallery-store";
import type { TabManager } from "./tab-manager";
import type { YouTubeDownloadService } from "./youtube-download-service";

interface YouTubeUtilitySmokeOptions {
  url: string;
  reportPath: string;
  screenshotPath: string;
}

export async function runYouTubeUtilitySmoke(
  manager: TabManager,
  downloads: DownloadManager,
  service: YouTubeDownloadService,
  gallery: GalleryStore,
  options: YouTubeUtilitySmokeOptions,
): Promise<boolean> {
  const startedAt = Date.now();
  const errors: string[] = [];
  let bannerVisible = false;
  let stage: string | null = null;
  let filename: string | null = null;
  let galleryIndexed = false;
  let galleryPageVisible = false;
  let galleryMediaReady = false;
  try {
    const tabId = manager.createTab(options.url);
    await waitFor(
      () => {
        const tab = manager.snapshot.tabs.find(
          (candidate) => candidate.id === tabId,
        );
        return Boolean(tab && !tab.isLoading && manager.snapshot.youtubeWatch);
      },
      45_000,
      "YouTube watch page and banner",
    );
    bannerVisible = manager.snapshot.youtubeWatch !== null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.mkdir(path.dirname(options.screenshotPath), { recursive: true });
    await fs.writeFile(options.screenshotPath, await manager.captureShell());

    const target = manager.getActiveYouTubeDownloadTarget(tabId);
    const id = await service.start(target);
    await waitFor(
      () => {
        const item = service.snapshot.items.find(
          (candidate) => candidate.id === id,
        );
        return Boolean(
          item && ["completed", "failed", "cancelled"].includes(item.stage),
        );
      },
      120_000,
      "yt-dlp completion",
    );
    const item = service.snapshot.items.find(
      (candidate) => candidate.id === id,
    );
    stage = item?.stage ?? null;
    filename = item?.filename ?? null;
    if (stage !== "completed")
      errors.push(item?.error ?? "The download did not complete.");
    if (
      !downloads.snapshot.some(
        (entry) => entry.url === target.url && entry.state === "completed",
      )
    ) {
      errors.push("The completed video was not added to Downloads.");
    }
    await waitFor(
      () =>
        gallery.snapshot.items.some((entry) => entry.sourceUrl === target.url),
      10_000,
      "completed video in My Gallery",
    );
    const galleryEntry = gallery.snapshot.items.find(
      (entry) => entry.sourceUrl === target.url,
    );
    galleryIndexed = Boolean(galleryEntry?.available);
    if (galleryEntry) {
      manager.openGallery(galleryEntry.id);
      await waitFor(
        () =>
          manager.snapshot.tabs.some(
            (tab) =>
              tab.id === manager.snapshot.activeTabId &&
              tab.url.includes(galleryEntry.id),
          ),
        5_000,
        "My Gallery player tab",
      );
      await waitFor(
        async () => {
          galleryPageVisible = await manager.evaluateShell<boolean>(
            `Boolean(document.querySelector('.gallery-player-page video'))`,
          );
          return galleryPageVisible;
        },
        5_000,
        "built-in Gallery player UI",
      );
      await waitFor(
        async () => {
          galleryMediaReady = await manager.evaluateShell<boolean>(
            `Boolean(document.querySelector('.gallery-player-page video')?.readyState >= 1)`,
          );
          return galleryMediaReady;
        },
        10_000,
        "local Gallery video metadata",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const galleryScreenshotPath = options.screenshotPath.replace(
        /\.png$/iu,
        "-gallery.png",
      );
      await fs.writeFile(galleryScreenshotPath, await manager.captureShell());
    }
    if (!galleryIndexed)
      errors.push("The completed video was not indexed in My Gallery.");
    if (!galleryPageVisible)
      errors.push("The built-in Gallery player did not open.");
    if (!galleryMediaReady)
      errors.push("The local Gallery video did not become playable.");
  } catch (error) {
    errors.push(
      error instanceof Error ? error.stack || error.message : String(error),
    );
  }

  const report = {
    success: errors.length === 0 && bannerVisible && stage === "completed",
    bannerVisible,
    stage,
    filename,
    galleryIndexed,
    galleryPageVisible,
    galleryMediaReady,
    elapsedMs: Date.now() - startedAt,
    errors,
  };
  await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
  await fs.writeFile(
    options.reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report.success;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
