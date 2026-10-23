import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SMART_DOWNLOADS_QUOTA_BYTES,
  SMART_DOWNLOADS_DOCUMENT_VERSION,
  youtubeSourceKey,
} from "./model";
import { SmartDownloadsStore } from "./store";

const CHANNEL_A = `UC${"a".repeat(22)}`;
const CHANNEL_B = `UC${"b".repeat(22)}`;
const CHANNEL_C = `UC${"c".repeat(22)}`;
const VIDEO_A = "aaaaaaaaaaa";
const VIDEO_B = "bbbbbbbbbbb";
const VIDEO_C = "ccccccccccc";
const VIDEO_D = "ddddddddddd";
const VIDEO_E = "eeeeeeeeeee";
const MIB = 1024 ** 2;

describe("SmartDownloadsStore", () => {
  let directory: string;
  let filePath: string;
  let now: number;
  let idCounter: number;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "chromecraft-smart-downloads-"),
    );
    filePath = path.join(directory, "smart-downloads.json");
    now = Date.UTC(2026, 9, 23, 4, 0, 0);
    idCounter = 0;
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createStore(pathname = filePath): SmartDownloadsStore {
    return new SmartDownloadsStore({
      filePath: pathname,
      now: () => now,
      generateId: () => `generated_${++idCounter}`,
    });
  }

  async function initializedStore(): Promise<SmartDownloadsStore> {
    const store = createStore();
    await store.initialize();
    return store;
  }

  it("starts opt-in with conservative storage, quality, cleanup, and privacy defaults", async () => {
    const store = await initializedStore();

    expect(store.snapshot.version).toBe(SMART_DOWNLOADS_DOCUMENT_VERSION);
    expect(store.snapshot.config).toEqual({
      enabled: false,
      storageQuotaBytes: DEFAULT_SMART_DOWNLOADS_QUOTA_BYTES,
      quality: "720p",
      cleanupPolicy: "pause",
      checkIntervalMinutes: 60,
      includeShorts: false,
      includeLivestreamReplays: false,
      maxConcurrentAutomaticDownloads: 1,
      pauseDuringHeavyActivity: true,
      backgroundEnabled: false,
      startWithWindows: false,
      recommendationsEnabled: false,
    });
    expect(store.snapshot.channels).toEqual([]);
    expect(store.snapshot.queue).toEqual([]);
  });

  it("persists config atomically and emits detached snapshots", async () => {
    const changes: boolean[] = [];
    const store = new SmartDownloadsStore({
      filePath,
      now: () => now,
      onChange: (snapshot) => changes.push(snapshot.config.enabled),
    });
    await store.initialize();
    await store.updateConfig({
      enabled: true,
      quality: "1080p",
      cleanupPolicy: "oldest",
      checkIntervalMinutes: 15,
      recommendationsEnabled: true,
    });

    const external = store.snapshot;
    external.config.enabled = false;
    const reloaded = createStore();
    await reloaded.initialize();

    expect(reloaded.snapshot.config).toMatchObject({
      enabled: true,
      quality: "1080p",
      cleanupPolicy: "oldest",
      checkIntervalMinutes: 15,
      recommendationsEnabled: true,
    });
    expect(changes).toEqual([false, true]);
    expect(
      (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("recovers malformed JSON to a valid safe document", async () => {
    await fs.writeFile(filePath, "{ definitely-not-json", "utf8");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const store = createStore();
    await store.initialize();

    expect(store.snapshot.config.enabled).toBe(false);
    expect(store.snapshot.channels).toEqual([]);
    const persisted = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      version: number;
      config: { enabled: boolean };
    };
    expect(persisted).toMatchObject({
      version: SMART_DOWNLOADS_DOCUMENT_VERSION,
      config: { enabled: false },
    });
  });

  it("migrates a version-one document and normalises malformed values", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        config: {
          enabled: true,
          quality: "8k",
          cleanupPolicy: "delete-everything",
          checkIntervalMinutes: 60,
        },
        channels: [
          {
            id: CHANNEL_A,
            title: "Channel A",
            enabled: true,
            addedAt: now,
            baselineAt: now,
            lastCheckedAt: null,
            lastSuccessfulCheckAt: null,
            nextCheckAt: null,
          },
          { id: "not-canonical", title: "discard me" },
        ],
        seenVideos: [],
        queue: [],
      }),
      "utf8",
    );

    const store = createStore();
    await store.initialize();

    expect(store.snapshot.version).toBe(2);
    expect(store.snapshot.config.enabled).toBe(true);
    expect(store.snapshot.config.quality).toBe("720p");
    expect(store.snapshot.config.cleanupPolicy).toBe("pause");
    expect(store.snapshot.channels.map((channel) => channel.id)).toEqual([
      CHANNEL_A,
    ]);
    expect(store.snapshot.downloads).toEqual([]);
    expect(store.snapshot.recommendationObservationIds).toEqual([]);
  });

  it("uses canonical channel IDs, prevents duplicates, and keeps history after unsubscribe", async () => {
    const store = await initializedStore();
    const first = await store.subscribeChannel({
      id: CHANNEL_A,
      title: "Original title",
      handle: "@channel.a",
      avatarUrl: "https://example.test/avatar.jpg",
      baselineAt: now - 1_000,
    });
    const duplicate = await store.subscribeChannel({
      id: CHANNEL_A,
      title: "Updated title",
      handle: "@channel.a",
    });
    await store.markVideoSeen({ videoId: VIDEO_A, channelId: CHANNEL_A });

    expect(first.added).toBe(true);
    expect(duplicate.added).toBe(false);
    expect(store.snapshot.channels).toHaveLength(1);
    expect(store.snapshot.channels[0]?.title).toBe("Updated title");
    await store.scheduleChannelCheck(CHANNEL_A, now + 60_000);
    expect(store.snapshot.channels[0]).toMatchObject({
      lastCheckedAt: null,
      lastSuccessfulCheckAt: null,
      nextCheckAt: now + 60_000,
    });
    await expect(
      store.subscribeChannel({ id: "@channel", title: "Not canonical" }),
    ).rejects.toThrow("canonical YouTube channel ID");

    expect(await store.removeChannel(CHANNEL_A)).toBe(true);
    expect(store.snapshot.channels).toEqual([]);
    expect(store.hasSeenVideo(VIDEO_A)).toBe(true);
  });

  it("persists the durable seen-video index independently of completion", async () => {
    const store = await initializedStore();
    await store.markVideoSeen({
      videoId: VIDEO_A,
      channelId: CHANNEL_A,
      state: "discovered",
      publishedAt: now - 20_000,
    });
    now += 5_000;
    await store.markVideoSeen({
      videoId: VIDEO_A,
      channelId: CHANNEL_A,
      state: "failed",
    });

    const reloaded = createStore();
    await reloaded.initialize();
    expect(reloaded.hasSeenVideo(VIDEO_A)).toBe(true);
    expect(reloaded.snapshot.seenVideos).toEqual([
      expect.objectContaining({
        sourceKey: youtubeSourceKey(VIDEO_A),
        state: "failed",
        publishedAt: now - 25_000,
      }),
    ]);
  });

  it("deduplicates queue jobs and enforces the lifecycle", async () => {
    const store = await initializedStore();
    const first = await store.enqueueVideo({
      videoId: VIDEO_A,
      channelId: CHANNEL_A,
      title: "Video A",
      estimatedBytes: 100 * MIB,
    });
    const duplicate = await store.enqueueVideo({
      videoId: VIDEO_A,
      channelId: CHANNEL_B,
      title: "Same canonical video",
    });

    expect(first.added).toBe(true);
    expect(duplicate).toMatchObject({
      added: false,
      job: { id: first.job.id },
    });
    expect(store.snapshot.queue).toHaveLength(1);
    await expect(
      store.transitionJob(first.job.id, "completed"),
    ).rejects.toThrow("pending to completed");

    const preparing = await store.transitionJob(first.job.id, "preparing");
    expect(preparing.attempts).toBe(1);
    await store.transitionJob(first.job.id, "downloading");
    await store.transitionJob(first.job.id, "processing");
    const completed = await store.transitionJob(first.job.id, "completed", {
      galleryEntryId: "gallery_a",
    });
    expect(completed).toMatchObject({
      state: "completed",
      galleryEntryId: "gallery_a",
    });
    expect(store.snapshot.seenVideos[0]?.state).toBe("completed");
  });

  it("canonicalises supported YouTube URLs and rejects mismatched sources", async () => {
    const store = await initializedStore();
    const { job } = await store.enqueueVideo({
      videoId: VIDEO_A,
      channelId: CHANNEL_A,
      sourceUrl: `https://youtu.be/${VIDEO_A}?feature=share`,
    });

    expect(job.sourceUrl).toBe(`https://www.youtube.com/watch?v=${VIDEO_A}`);
    await expect(
      store.enqueueVideo({
        videoId: VIDEO_B,
        channelId: CHANNEL_A,
        sourceUrl: `https://www.youtube.com/watch?v=${VIDEO_C}`,
      }),
    ).rejects.toThrow("does not match");
    await expect(
      store.enqueueVideo({
        videoId: VIDEO_B,
        channelId: CHANNEL_A,
        sourceUrl: `https://example.test/watch?v=${VIDEO_B}`,
      }),
    ).rejects.toThrow("does not match");
  });

  it("backs off failures, exposes due retries, and retries explicitly", async () => {
    const store = await initializedStore();
    const { job } = await store.enqueueVideo({
      videoId: VIDEO_A,
      channelId: CHANNEL_A,
    });
    await store.transitionJob(job.id, "preparing");
    const failedAt = now;
    const failed = await store.failJob(job.id, "Network unavailable");

    expect(failed).toMatchObject({
      state: "failed",
      lastError: "Network unavailable",
      retryAt: failedAt + 30_000,
    });
    expect(store.dueRetryJobs(failedAt + 29_999)).toEqual([]);
    expect(store.dueRetryJobs(failedAt + 30_000)).toHaveLength(1);

    const retried = await store.retryJob(job.id);
    expect(retried).toMatchObject({
      state: "pending",
      attempts: 1,
      retryAt: null,
      lastError: null,
    });
  });

  it("recovers interrupted queue work as pending after restart", async () => {
    const store = await initializedStore();
    const { job } = await store.enqueueVideo({
      videoId: VIDEO_A,
      channelId: CHANNEL_A,
    });
    await store.transitionJob(job.id, "preparing");
    await store.transitionJob(job.id, "downloading");
    now += 1_000;

    const reloaded = createStore();
    await reloaded.initialize();

    expect(reloaded.snapshot.queue[0]).toMatchObject({
      state: "pending",
      updatedAt: now,
      retryAt: null,
      lastError: null,
    });
  });

  it("counts only verified present Smart Downloads and includes reservations", async () => {
    const store = await initializedStore();
    await store.updateConfig({ storageQuotaBytes: 512 * MIB });
    await store.recordManagedDownload({
      videoId: VIDEO_A,
      channelId: CHANNEL_A,
      ownership: "smart",
      ownershipVerified: true,
      mediaRelativePath: "videos/a.mp4",
      mediaBytes: 100 * MIB,
      assetBytes: 2 * MIB,
    });
    await store.recordManagedDownload({
      videoId: VIDEO_B,
      channelId: CHANNEL_A,
      ownership: "manual",
      ownershipVerified: true,
      mediaRelativePath: "videos/b.mp4",
      mediaBytes: 200 * MIB,
    });
    await store.recordManagedDownload({
      videoId: VIDEO_C,
      channelId: CHANNEL_A,
      ownership: "smart",
      ownershipVerified: false,
      mediaRelativePath: null,
      mediaBytes: 300 * MIB,
    });
    await store.enqueueVideo({
      videoId: VIDEO_D,
      channelId: CHANNEL_A,
      estimatedBytes: 50 * MIB,
    });

    expect(store.storageAccounting()).toEqual({
      quotaBytes: 512 * MIB,
      usedBytes: 102 * MIB,
      reservedBytes: 50 * MIB,
      availableBytes: 360 * MIB,
      managedDownloadCount: 1,
    });
  });

  it("plans oldest cleanup while protecting manual, keep-forever, current, and uncertain files", async () => {
    const store = await initializedStore();
    await store.updateConfig({
      storageQuotaBytes: 512 * MIB,
      cleanupPolicy: "oldest",
    });
    const records = [
      [VIDEO_A, 1, "smart", true, false],
      [VIDEO_B, 2, "manual", true, false],
      [VIDEO_C, 3, "smart", true, true],
      [VIDEO_D, 4, "smart", false, false],
      [VIDEO_E, 5, "smart", true, false],
    ] as const;
    for (const [videoId, age, ownership, verified, keepForever] of records) {
      await store.recordManagedDownload({
        videoId,
        channelId: CHANNEL_A,
        ownership,
        ownershipVerified: verified,
        mediaRelativePath: verified ? `videos/${videoId}.mp4` : null,
        mediaBytes: 150 * MIB,
        downloadedAt: now + age,
        keepForever,
      });
    }

    const plan = store.planCleanup(200 * MIB, {
      currentlyPlayingSourceKeys: [youtubeSourceKey(VIDEO_E)],
    });

    expect(plan).toMatchObject({
      bytesToFree: 138 * MIB,
      bytesPlanned: 150 * MIB,
      sufficient: true,
    });
    expect(plan.candidates.map((candidate) => candidate.sourceKey)).toEqual([
      youtubeSourceKey(VIDEO_A),
    ]);
  });

  it("prioritises watched downloads and pauses cleanup when configured", async () => {
    const store = await initializedStore();
    await store.updateConfig({
      storageQuotaBytes: 512 * MIB,
      cleanupPolicy: "watched-first",
    });
    await store.recordManagedDownload({
      videoId: VIDEO_A,
      channelId: CHANNEL_A,
      ownershipVerified: true,
      mediaRelativePath: "videos/a.mp4",
      mediaBytes: 300 * MIB,
      downloadedAt: now,
    });
    await store.recordManagedDownload({
      videoId: VIDEO_B,
      channelId: CHANNEL_A,
      ownershipVerified: true,
      mediaRelativePath: "videos/b.mp4",
      mediaBytes: 300 * MIB,
      downloadedAt: now + 100,
      watchedAt: now + 200,
    });

    expect(store.planCleanup(1).candidates[0]?.sourceKey).toBe(
      youtubeSourceKey(VIDEO_B),
    );
    await store.updateConfig({ cleanupPolicy: "pause" });
    expect(store.planCleanup(1)).toMatchObject({
      bytesToFree: 88 * MIB + 1,
      bytesPlanned: 0,
      sufficient: false,
      candidates: [],
    });
  });

  it("rejects unsafe managed paths", async () => {
    const store = await initializedStore();
    await expect(
      store.recordManagedDownload({
        videoId: VIDEO_A,
        channelId: CHANNEL_A,
        ownershipVerified: true,
        mediaRelativePath: path.resolve(directory, "outside.mp4"),
        mediaBytes: 10,
      }),
    ).rejects.toThrow("relative path");
    await expect(
      store.recordManagedDownload({
        videoId: VIDEO_A,
        channelId: CHANNEL_A,
        ownershipVerified: true,
        mediaRelativePath: `..${path.sep}outside.mp4`,
        mediaBytes: 10,
      }),
    ).rejects.toThrow("relative path");
  });

  it("collects private local recommendation statistics without double counting observations", async () => {
    const store = await initializedStore();
    const disabled = await store.recordRecommendationObservation({
      observationId: "observation_disabled",
      channelId: CHANNEL_A,
      channelTitle: "Channel A",
      videoId: VIDEO_A,
      playbackSeconds: 600,
    });
    await store.updateConfig({ recommendationsEnabled: true });
    const privateResult = await store.recordRecommendationObservation({
      observationId: "observation_private",
      channelId: CHANNEL_A,
      channelTitle: "Channel A",
      videoId: VIDEO_A,
      playbackSeconds: 600,
      privateBrowsing: true,
    });
    const accepted = await store.recordRecommendationObservation({
      observationId: "observation_a",
      channelId: CHANNEL_A,
      channelTitle: "Channel A",
      handle: "@channel.a",
      videoId: VIDEO_A,
      playbackSeconds: 600,
    });
    const duplicate = await store.recordRecommendationObservation({
      observationId: "observation_a",
      channelId: CHANNEL_A,
      channelTitle: "Channel A",
      videoId: VIDEO_A,
      playbackSeconds: 600,
    });

    expect({ disabled, privateResult, accepted, duplicate }).toEqual({
      disabled: false,
      privateResult: false,
      accepted: true,
      duplicate: false,
    });
    expect(store.snapshot.recommendationStats[0]).toMatchObject({
      distinctVideoIds: [VIDEO_A],
      totalPlaybackSeconds: 600,
      playbackEventCount: 1,
    });
  });

  it("scores sufficient evidence, excludes followed channels, persists dismissals, and clears everything", async () => {
    const store = await initializedStore();
    await store.updateConfig({ recommendationsEnabled: true });
    for (const [index, videoId] of [VIDEO_A, VIDEO_B, VIDEO_C].entries()) {
      now += 24 * 60 * 60 * 1_000;
      await store.recordRecommendationObservation({
        observationId: `observation_${index}`,
        channelId: CHANNEL_A,
        channelTitle: "Channel A",
        videoId,
        playbackSeconds: 500,
      });
    }
    await store.recordRecommendationObservation({
      observationId: "observation_brief",
      channelId: CHANNEL_B,
      channelTitle: "Brief channel",
      videoId: VIDEO_D,
      playbackSeconds: 5,
    });

    expect(store.recommendations()).toEqual([
      expect.objectContaining({
        channel: expect.objectContaining({ channelId: CHANNEL_A }),
        score: expect.any(Number),
      }),
    ]);
    await store.subscribeChannel({ id: CHANNEL_A, title: "Channel A" });
    expect(store.recommendations()).toEqual([]);
    await store.removeChannel(CHANNEL_A);
    expect(await store.dismissRecommendation(CHANNEL_A)).toBe(true);

    const reloaded = createStore();
    await reloaded.initialize();
    expect(reloaded.recommendations()).toEqual([]);
    expect(reloaded.snapshot.dismissedChannelIds).toEqual([CHANNEL_A]);

    await reloaded.clearRecommendationHistory();
    expect(reloaded.snapshot).toMatchObject({
      recommendationStats: [],
      recommendationObservationIds: [],
      dismissedChannelIds: [],
    });
  });

  it("serialises concurrent writes without losing state", async () => {
    const store = await initializedStore();
    await Promise.all([
      store.subscribeChannel({ id: CHANNEL_A, title: "Channel A" }),
      store.subscribeChannel({ id: CHANNEL_B, title: "Channel B" }),
      store.subscribeChannel({ id: CHANNEL_C, title: "Channel C" }),
    ]);

    const reloaded = createStore();
    await reloaded.initialize();
    expect(
      reloaded.snapshot.channels.map((channel) => channel.id).sort(),
    ).toEqual([CHANNEL_A, CHANNEL_B, CHANNEL_C].sort());
  });
});
