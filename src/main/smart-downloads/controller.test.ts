import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SmartDownloadsStore } from "./store";
import {
  retryDelayMs,
  SmartDownloadsController,
  type ResolvedSmartDownloadChannel,
  type ResolvedSmartDownloadVideo,
} from "./controller";

const CHANNEL_ID = "UC1234567890123456789012";
const directories: string[] = [];

function video(
  videoId: string,
  publishedAt: number,
  kind: ResolvedSmartDownloadVideo["kind"] = "video",
): ResolvedSmartDownloadVideo {
  return { videoId, title: `Video ${videoId}`, publishedAt, kind };
}

function resolved(
  videos: ResolvedSmartDownloadVideo[],
): ResolvedSmartDownloadChannel {
  return {
    channelId: CHANNEL_ID,
    title: "A channel",
    handle: "@channel",
    canonicalUrl: "https://www.youtube.com/@channel",
    avatarUrl: null,
    recentVideos: videos,
  };
}

async function harness() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chromecraft-smart-controller-"),
  );
  directories.push(directory);
  let now = 1_000_000;
  let recent: ResolvedSmartDownloadVideo[] = [];
  const store = new SmartDownloadsStore({
    filePath: path.join(directory, "smart-downloads.json"),
    now: () => now,
    generateId: (() => {
      let id = 0;
      return () => `job_${++id}`;
    })(),
  });
  const resolveChannel = vi.fn(async () => resolved(recent));
  const discoverRecent = vi.fn(async () => recent);
  const enqueueAutomatic = vi.fn(
    async ({ videoId }: { videoId: string }) => `download-${videoId}`,
  );
  const canStartAutomatic = vi.fn(() => true);
  const controller = new SmartDownloadsController({
    store,
    discovery: { resolveChannel, discoverRecent },
    enqueuer: { enqueueAutomatic, canStartAutomatic },
    now: () => now,
    setTimer: (() => ({ unref: () => undefined })) as never,
    clearTimer: () => undefined,
  });
  return {
    controller,
    store,
    discoverRecent,
    enqueueAutomatic,
    canStartAutomatic,
    setRecent: (value: ResolvedSmartDownloadVideo[]) => {
      recent = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("SmartDownloadsController", () => {
  it("records a baseline without downloading channel history by default", async () => {
    const test = await harness();
    test.setRecent([video("aaaaaaaaaaa", 2), video("bbbbbbbbbbb", 1)]);
    await test.controller.initialize();
    await test.controller.addChannel("https://youtube.com/@channel");

    expect(test.store.snapshot.seenVideos).toHaveLength(2);
    expect(test.store.snapshot.queue).toHaveLength(0);
    expect(test.enqueueAutomatic).not.toHaveBeenCalled();
  });

  it("queues only the requested newest videos and respects concurrency one", async () => {
    const test = await harness();
    test.setRecent([
      video("aaaaaaaaaaa", 1),
      video("bbbbbbbbbbb", 4),
      video("ccccccccccc", 3),
      video("ddddddddddd", 2),
    ]);
    await test.controller.initialize();
    await test.controller.setEnabled(true);
    await test.controller.addChannel("@channel", 3);

    expect(test.store.snapshot.queue.map((job) => job.videoId)).toEqual([
      "bbbbbbbbbbb",
      "ccccccccccc",
      "ddddddddddd",
    ]);
    expect(test.enqueueAutomatic).toHaveBeenCalledOnce();
    expect(
      test.store.snapshot.queue.filter((job) => job.state === "downloading"),
    ).toHaveLength(1);
  });

  it("deduplicates stable video IDs across repeated discovery", async () => {
    const test = await harness();
    test.setRecent([video("aaaaaaaaaaa", 1)]);
    await test.controller.initialize();
    await test.controller.setEnabled(true);
    await test.controller.addChannel("@channel");
    test.setRecent([
      video("aaaaaaaaaaa", 1),
      video("bbbbbbbbbbb", 2),
      video("bbbbbbbbbbb", 2),
    ]);

    expect(await test.controller.checkNow()).toMatchObject({
      discoveredVideos: 1,
      queuedVideos: 1,
    });
    expect(await test.controller.checkNow()).toMatchObject({
      discoveredVideos: 0,
      queuedVideos: 0,
    });
    expect(test.store.snapshot.seenVideos).toHaveLength(2);
    expect(test.store.snapshot.queue).toHaveLength(1);
  });

  it("uses bounded exponential channel-check backoff", async () => {
    const test = await harness();
    test.setRecent([]);
    await test.controller.initialize();
    await test.controller.addChannel("@channel");
    test.discoverRecent.mockRejectedValue(new Error("offline"));

    await test.controller.checkNow(CHANNEL_ID);
    expect(test.store.snapshot.channels[0].nextCheckAt).toBe(
      1_000_000 + retryDelayMs(1),
    );
    await test.controller.checkNow(CHANNEL_ID);
    expect(test.store.snapshot.channels[0].nextCheckAt).toBe(
      1_000_000 + retryDelayMs(2),
    );
    expect(test.controller.snapshot.channelErrors[CHANNEL_ID]).toBe("offline");
  });

  it("pauses pending jobs and resumes through the existing queue", async () => {
    const test = await harness();
    test.setRecent([video("aaaaaaaaaaa", 2), video("bbbbbbbbbbb", 1)]);
    await test.controller.initialize();
    await test.controller.addChannel("@channel", 3);
    await test.controller.pauseQueue();
    await test.controller.setEnabled(true);
    expect(test.enqueueAutomatic).not.toHaveBeenCalled();
    expect(
      test.store.snapshot.queue.every((job) => job.state === "paused"),
    ).toBe(true);

    await test.controller.resumeQueue();
    expect(test.enqueueAutomatic).toHaveBeenCalledOnce();
    expect(
      test.store.snapshot.queue.filter((job) => job.state === "downloading"),
    ).toHaveLength(1);
  });

  it("defers automatic work while manual work owns the shared manager", async () => {
    const test = await harness();
    test.canStartAutomatic.mockReturnValue(false);
    test.setRecent([video("aaaaaaaaaaa", 1)]);
    await test.controller.initialize();
    await test.controller.setEnabled(true);
    await test.controller.addChannel("@channel", 1);
    expect(test.enqueueAutomatic).not.toHaveBeenCalled();
    expect(test.store.snapshot.queue[0].state).toBe("pending");

    test.canStartAutomatic.mockReturnValue(true);
    await test.controller.resumeQueue();
    expect(test.enqueueAutomatic).toHaveBeenCalledOnce();
  });

  it("does not mark a live stream seen before it becomes a replay", async () => {
    const test = await harness();
    await test.controller.initialize();
    await test.controller.setEnabled(true);
    await test.controller.addChannel("@channel");
    test.setRecent([video("aaaaaaaaaaa", 1, "live")]);
    await test.controller.checkNow();
    expect(test.store.hasSeenVideo("aaaaaaaaaaa")).toBe(false);

    test.setRecent([video("aaaaaaaaaaa", 1, "video")]);
    await test.controller.checkNow();
    expect(test.store.hasSeenVideo("aaaaaaaaaaa")).toBe(true);
  });
});

describe("retryDelayMs", () => {
  it("backs off exponentially with a six-hour ceiling", () => {
    expect(retryDelayMs(1)).toBe(5 * 60_000);
    expect(retryDelayMs(2)).toBe(10 * 60_000);
    expect(retryDelayMs(100)).toBe(6 * 60 * 60_000);
  });
});

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
