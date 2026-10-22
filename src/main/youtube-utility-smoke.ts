import { promises as fs } from "node:fs";
import path from "node:path";

import type { DownloadManager } from "./download-manager";
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
  options: YouTubeUtilitySmokeOptions,
): Promise<boolean> {
  const startedAt = Date.now();
  const errors: string[] = [];
  let bannerVisible = false;
  let stage: string | null = null;
  let filename: string | null = null;
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
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
