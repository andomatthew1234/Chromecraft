import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GalleryStore } from "../gallery-store";
import type { YouTubeDownloadService } from "../youtube-download-service";
import { SmartDownloadsService } from "./service";

const CHANNEL_ID = `UC${"s".repeat(22)}`;
const directories: string[] = [];

async function createService(): Promise<SmartDownloadsService> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chromecraft-smart-service-"),
  );
  directories.push(directory);
  const service = new SmartDownloadsService({
    stateFilePath: path.join(directory, "smart-downloads.json"),
    managedDirectory: path.join(directory, "media"),
    thumbnailDirectory: path.join(directory, "thumbnails"),
    mediaToolsDirectory: path.join(directory, "tools"),
    downloader: {
      canStartAutomaticDownload: () => true,
    } as unknown as YouTubeDownloadService,
    gallery: {} as GalleryStore,
  });
  await service.initialize();
  return service;
}

describe("SmartDownloadsService renderer status", () => {
  it("derives setup, pause, active, and attention states from durable data", async () => {
    const service = await createService();
    expect(service.snapshot.status).toMatchObject({
      configured: false,
      state: "not-configured",
      paused: false,
    });

    await service.store.subscribeChannel({
      id: CHANNEL_ID,
      title: "Saved creator",
      handle: "@savedcreator",
    });
    expect(service.snapshot.status).toMatchObject({
      configured: true,
      state: "disabled",
      paused: true,
    });

    await service.store.updateConfig({ enabled: true });
    await service.store.setChannelEnabled(CHANNEL_ID, false);
    expect(service.snapshot.status).toMatchObject({
      state: "paused",
      enabledChannelCount: 0,
      paused: true,
    });

    await service.store.setChannelEnabled(CHANNEL_ID, true);
    expect(service.snapshot.status).toMatchObject({
      state: "active",
      enabledChannelCount: 1,
      paused: false,
    });

    await service.store.recordChannelCheck(CHANNEL_ID, {
      successful: false,
      nextCheckAt: Date.now() + 60_000,
      error: "YouTube could not be reached.",
    });
    expect(service.snapshot.status).toMatchObject({
      state: "attention",
      error: "YouTube could not be reached.",
    });

    await service.dispose();
  });
});

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
