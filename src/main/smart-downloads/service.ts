import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  SmartDownloadCleanupPolicy,
  SmartDownloadInitialMode,
  SmartDownloadQuality,
  SmartDownloadsSnapshot as RendererSmartDownloadsSnapshot,
  YouTubeDownloadItemSnapshot,
  YouTubeDownloadsSnapshot,
} from "../../shared/browser";
import type { GalleryStore } from "../gallery-store";
import {
  mediaToolPaths,
  type YouTubeDownloadCompletionContext,
  type YouTubeDownloadService,
} from "../youtube-download-service";
import {
  SmartDownloadsController,
  type InitialDownloadMode,
  type SmartDownloadsControllerSnapshot,
} from "./controller";
import type { SmartDownloadsConfig } from "./model";
import { SmartDownloadsStore } from "./store";
import { YtDlpChannelDiscovery } from "./yt-dlp-discovery";

const DEFAULT_VIDEO_RESERVATION_BYTES = 768 * 1024 ** 2;
const DEFAULT_AUDIO_RESERVATION_BYTES = 160 * 1024 ** 2;
const DISK_SAFETY_MARGIN_BYTES = 512 * 1024 ** 2;
const MIN_QUOTA_BYTES = 512 * 1024 ** 2;

export interface SmartDownloadsServiceOptions {
  stateFilePath: string;
  managedDirectory: string;
  thumbnailDirectory: string;
  mediaToolsDirectory: string;
  downloader: YouTubeDownloadService;
  gallery: GalleryStore;
  onChange?: (snapshot: RendererSmartDownloadsSnapshot) => void;
  onBackgroundPreferenceChanged?: (
    backgroundEnabled: boolean,
    startWithWindows: boolean,
  ) => void | Promise<void>;
  currentlyPlayingSourceKeys?: () => Iterable<string>;
  isBrowserBusy?: () => boolean;
}

/**
 * The application-facing Smart Downloads facade. Renderers receive a compact
 * DTO and dedicated operations; raw seen indexes and owned paths never cross
 * the preload boundary.
 */
export class SmartDownloadsService {
  readonly store: SmartDownloadsStore;
  readonly controller: SmartDownloadsController;
  private diskAvailableBytes: number | null = null;
  private lastError: string | null = null;
  private disposed = false;
  private readonly observedDownloadStages = new Map<string, string>();
  private readonly discovery: YtDlpChannelDiscovery;
  private readonly videoChannelCache = new Map<
    string,
    {
      channelId: string;
      title: string;
      handle: string | null;
      avatarUrl: string | null;
    }
  >();

  constructor(private readonly options: SmartDownloadsServiceOptions) {
    this.store = new SmartDownloadsStore({
      filePath: options.stateFilePath,
      onChange: () => this.emit(),
    });
    const tools = mediaToolPaths(options.mediaToolsDirectory);
    this.discovery = new YtDlpChannelDiscovery({
      executable: tools.ytDlp,
      denoPath: tools.deno,
    });
    this.controller = new SmartDownloadsController({
      store: this.store,
      discovery: this.discovery,
      enqueuer: {
        canStartAutomatic: () => {
          const config = this.store.snapshot.config;
          return (
            options.downloader.canStartAutomaticDownload() &&
            (!config.pauseDuringHeavyActivity || !options.isBrowserBusy?.())
          );
        },
        enqueueAutomatic: async ({ videoId, channelId }) => {
          await this.ensureCapacity();
          return options.downloader.startWithOptions(
            {
              videoId,
              url: `https://www.youtube.com/watch?v=${videoId}`,
            },
            {
              origin: "smart",
              quality: this.store.snapshot.config.quality,
              smartChannelId: channelId,
            },
          );
        },
      },
      onChange: () => this.emit(),
    });
  }

  get snapshot(): RendererSmartDownloadsSnapshot {
    return this.toRendererSnapshot(this.controller.snapshot);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.options.managedDirectory, { recursive: true });
    await fs.mkdir(this.options.thumbnailDirectory, { recursive: true });
    await this.controller.initialize();
    await this.refreshDiskSpace();
    const maximumQuota = this.maximumQuotaBytes();
    if (this.store.snapshot.config.storageQuotaBytes > maximumQuota) {
      await this.store.updateConfig({ storageQuotaBytes: maximumQuota });
    }
    this.emit();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.controller.setEnabled(enabled);
  }

  async setQuota(bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < MIN_QUOTA_BYTES) {
      throw new RangeError("Smart Downloads storage must be at least 0.5 GB.");
    }
    await this.refreshDiskSpace();
    const maximum = this.maximumQuotaBytes();
    if (bytes > maximum) {
      throw new RangeError(
        "The requested storage allocation exceeds available disk space.",
      );
    }
    await this.store.updateConfig({ storageQuotaBytes: bytes });
  }

  async setQuality(quality: SmartDownloadQuality): Promise<void> {
    await this.store.updateConfig({ quality });
  }

  async setCleanupPolicy(policy: SmartDownloadCleanupPolicy): Promise<void> {
    await this.store.updateConfig({ cleanupPolicy: policy });
  }

  async setCheckInterval(minutes: number): Promise<void> {
    if (![15, 30, 60, 180, 360, 720, 1_440].includes(minutes)) {
      throw new RangeError("Unsupported channel check interval.");
    }
    await this.controller.setCheckInterval(
      minutes as SmartDownloadsConfig["checkIntervalMinutes"],
    );
  }

  async setConfigFlag(
    field:
      | "includeShorts"
      | "includeLivestreamReplays"
      | "pauseDuringHeavyActivity"
      | "backgroundEnabled"
      | "startWithWindows"
      | "recommendationsEnabled",
    enabled: boolean,
  ): Promise<void> {
    await this.store.updateConfig({ [field]: enabled });
    if (field === "recommendationsEnabled" && !enabled) {
      await this.store.clearRecommendationHistory();
    }
    if (field === "backgroundEnabled" || field === "startWithWindows") {
      const config = this.store.snapshot.config;
      await this.options.onBackgroundPreferenceChanged?.(
        config.backgroundEnabled,
        config.startWithWindows,
      );
    }
  }

  async addChannel(
    input: string,
    initialMode: SmartDownloadInitialMode,
  ): Promise<void> {
    await this.controller.addChannel(input, initialMode as InitialDownloadMode);
  }

  async setChannelEnabled(id: string, enabled: boolean): Promise<void> {
    await this.controller.setChannelEnabled(id, enabled);
  }

  async removeChannel(id: string): Promise<void> {
    await this.controller.removeChannel(id);
  }

  async checkNow(channelId?: string): Promise<void> {
    await this.controller.checkNow(channelId);
  }

  async pauseQueue(): Promise<void> {
    await this.controller.pauseQueue();
  }

  async resumeQueue(): Promise<void> {
    await this.controller.resumeQueue();
  }

  async retryJob(id: string): Promise<void> {
    await this.store.retryJob(id);
    await this.controller.resumeQueue();
  }

  async cancelJob(id: string): Promise<void> {
    const job = this.store.snapshot.queue.find(
      (candidate) => candidate.id === id,
    );
    if (!job) throw new Error("Smart Download was not found.");
    const active = this.options.downloader.snapshot.items.find(
      (item) =>
        item.videoId === job.videoId &&
        item.origin === "smart" &&
        ["pending", "downloading", "finishing"].includes(item.stage),
    );
    if (active) await this.options.downloader.cancel(active.id);
    if (["pending", "preparing", "paused", "failed"].includes(job.state)) {
      await this.store.transitionJob(job.id, "cancelled");
    }
  }

  async dismissRecommendation(channelId: string): Promise<void> {
    await this.store.dismissRecommendation(channelId);
  }

  async clearRecommendationHistory(): Promise<void> {
    await this.store.clearRecommendationHistory();
  }

  async setKeepForever(
    galleryEntryId: string,
    keepForever: boolean,
  ): Promise<void> {
    const record = this.store.snapshot.downloads.find(
      (candidate) =>
        candidate.galleryEntryId === galleryEntryId && candidate.present,
    );
    if (!record)
      throw new Error("This video is not managed by Smart Downloads.");
    await this.store.setKeepForever(record.sourceKey, keepForever);
    await this.options.gallery.setKeepForever(galleryEntryId, keepForever);
  }

  async markGalleryItemWatched(galleryEntryId: string): Promise<void> {
    const record = this.store.snapshot.downloads.find(
      (candidate) =>
        candidate.galleryEntryId === galleryEntryId && candidate.present,
    );
    if (!record || record.watchedAt !== null) return;
    const watchedAt = Date.now();
    await this.store.markDownloadWatched(record.sourceKey, watchedAt);
    await this.options.gallery.markWatched(galleryEntryId, watchedAt);
  }

  async recordGalleryDeletion(galleryEntryId: string): Promise<void> {
    const record = this.store.snapshot.downloads.find(
      (candidate) =>
        candidate.galleryEntryId === galleryEntryId && candidate.present,
    );
    if (!record) return;
    for (const asset of record.assetRelativePaths) {
      await fs.rm(safeOwnedPath(this.options.thumbnailDirectory, asset), {
        force: true,
      });
    }
    await this.store.markDownloadRemoved(record.sourceKey);
  }

  async recordPlayback(input: {
    observationId: string;
    channelId: string;
    channelTitle: string;
    handle: string | null;
    avatarUrl: string | null;
    videoId: string;
    playbackSeconds: number;
    occurredAt: number;
  }): Promise<void> {
    if (!this.store.snapshot.config.recommendationsEnabled) return;
    await this.store.recordRecommendationObservation(input);
  }

  async recordYouTubePlayback(input: {
    observationId: string;
    videoId: string;
    playbackSeconds: number;
    occurredAt: number;
  }): Promise<void> {
    if (!this.store.snapshot.config.recommendationsEnabled) return;
    let channel = this.videoChannelCache.get(input.videoId);
    if (!channel) {
      channel = await this.discovery.resolveVideoChannel(input.videoId);
      this.videoChannelCache.set(input.videoId, channel);
      if (this.videoChannelCache.size > 500) {
        const oldest = this.videoChannelCache.keys().next().value;
        if (oldest) this.videoChannelCache.delete(oldest);
      }
    }
    await this.recordPlayback({
      ...input,
      channelId: channel.channelId,
      channelTitle: channel.title,
      handle: channel.handle,
      avatarUrl: channel.avatarUrl,
    });
  }

  syncDownloads(snapshot: YouTubeDownloadsSnapshot): void {
    for (const item of snapshot.items) {
      if (item.origin !== "smart") continue;
      const previous = this.observedDownloadStages.get(item.id);
      if (previous === item.stage) continue;
      this.observedDownloadStages.set(item.id, item.stage);
      const mapped =
        item.stage === "finishing"
          ? "processing"
          : item.stage === "completed"
            ? "completed"
            : item.stage === "failed" || item.stage === "interrupted"
              ? "failed"
              : item.stage === "cancelled"
                ? "cancelled"
                : "downloading";
      void this.controller
        .reportDownloadState(item.videoId, mapped, item.error ?? undefined)
        .catch((error) => this.captureError(error));
    }
  }

  async registerCompletedDownload(
    item: YouTubeDownloadItemSnapshot,
    savePath: string,
    context: YouTubeDownloadCompletionContext,
    galleryEntryId: string | null,
  ): Promise<void> {
    if (context.origin !== "smart" || !context.smartChannelId) return;
    const [mediaStat, thumbnailStat] = await Promise.all([
      fs.stat(savePath),
      context.thumbnailPath
        ? fs.stat(context.thumbnailPath).catch(() => null)
        : Promise.resolve(null),
    ]);
    const relative = path.relative(this.options.managedDirectory, savePath);
    if (!isSafeRelative(relative)) {
      throw new Error(
        "Completed Smart Download is outside its managed directory.",
      );
    }
    const assetRelativePaths: string[] = [];
    if (context.thumbnailPath) {
      const thumbnailRelative = path.relative(
        this.options.thumbnailDirectory,
        context.thumbnailPath,
      );
      if (isSafeRelative(thumbnailRelative))
        assetRelativePaths.push(thumbnailRelative);
    }
    await this.store.recordManagedDownload({
      videoId: item.videoId,
      channelId: context.smartChannelId,
      queueJobId:
        this.store.snapshot.queue.find((job) => job.videoId === item.videoId)
          ?.id ?? null,
      galleryEntryId,
      ownership: "smart",
      ownershipVerified: true,
      mediaRelativePath: relative,
      assetRelativePaths,
      mediaBytes: mediaStat.size,
      assetBytes: thumbnailStat?.size ?? 0,
      downloadedAt: item.finishedAt ?? Date.now(),
    });
    await this.refreshDiskSpace();
    this.emit();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.controller.dispose();
  }

  private async ensureCapacity(): Promise<void> {
    const config = this.store.snapshot.config;
    const reservation =
      config.quality === "audio"
        ? DEFAULT_AUDIO_RESERVATION_BYTES
        : DEFAULT_VIDEO_RESERVATION_BYTES;
    await this.refreshDiskSpace();
    if (
      this.diskAvailableBytes !== null &&
      this.diskAvailableBytes < reservation + DISK_SAFETY_MARGIN_BYTES
    ) {
      throw new Error("Smart Downloads paused because disk space is low.");
    }
    let accounting = this.store.storageAccounting();
    if (accounting.availableBytes >= reservation) return;
    const plan = this.store.planCleanup(reservation, {
      currentlyPlayingSourceKeys: this.options.currentlyPlayingSourceKeys?.(),
    });
    if (!plan.sufficient) {
      throw new Error("Smart Downloads storage allocation has been reached.");
    }
    for (const candidate of plan.candidates) {
      await this.deleteCleanupCandidate(candidate);
    }
    accounting = this.store.storageAccounting();
    if (accounting.availableBytes < reservation) {
      throw new Error("Smart Downloads could not free enough managed storage.");
    }
  }

  private async deleteCleanupCandidate(candidate: {
    sourceKey: string;
    galleryEntryId: string | null;
    mediaRelativePath: string;
    assetRelativePaths: string[];
  }): Promise<void> {
    const media = safeOwnedPath(
      this.options.managedDirectory,
      candidate.mediaRelativePath,
    );
    await fs.rm(media, { force: true });
    for (const asset of candidate.assetRelativePaths) {
      await fs.rm(safeOwnedPath(this.options.thumbnailDirectory, asset), {
        force: true,
      });
    }
    if (candidate.galleryEntryId) {
      await this.options.gallery.remove(candidate.galleryEntryId);
    }
    await this.store.markDownloadRemoved(candidate.sourceKey);
  }

  private async refreshDiskSpace(): Promise<void> {
    try {
      const stats = await fs.statfs(this.options.managedDirectory);
      this.diskAvailableBytes = stats.bavail * stats.bsize;
    } catch {
      this.diskAvailableBytes = null;
    }
  }

  private maximumQuotaBytes(): number {
    const used = this.store.storageAccounting().usedBytes;
    if (this.diskAvailableBytes === null) return 1 * 1024 ** 4;
    return Math.max(
      MIN_QUOTA_BYTES,
      Math.floor(
        Math.max(
          used,
          used + this.diskAvailableBytes - DISK_SAFETY_MARGIN_BYTES,
        ),
      ),
    );
  }

  private toRendererSnapshot(
    source: SmartDownloadsControllerSnapshot,
  ): RendererSmartDownloadsSnapshot {
    const storage = this.store.storageAccounting();
    const recommendations = this.store.recommendations(8);
    const cleanupPreview = this.store.planCleanup(
      source.config.quality === "audio"
        ? DEFAULT_AUDIO_RESERVATION_BYTES
        : DEFAULT_VIDEO_RESERVATION_BYTES,
      {
        currentlyPlayingSourceKeys: this.options.currentlyPlayingSourceKeys?.(),
      },
    );
    const lastChecks = source.channels.flatMap((channel) =>
      channel.lastCheckedAt === null ? [] : [channel.lastCheckedAt],
    );
    const nextChecks = source.channels.flatMap((channel) =>
      channel.enabled && channel.nextCheckAt !== null
        ? [channel.nextCheckAt]
        : [],
    );
    return {
      config: source.config,
      storage: {
        ...storage,
        diskAvailableBytes: this.diskAvailableBytes,
        maximumQuotaBytes: this.maximumQuotaBytes(),
      },
      channels: source.channels.map((channel) => {
        const channelJobs = source.queue.filter(
          (job) => job.channelId === channel.id,
        );
        return {
          id: channel.id,
          title: channel.title,
          handle: channel.handle,
          avatarUrl: channel.avatarUrl,
          enabled: channel.enabled,
          lastCheckedAt: channel.lastCheckedAt,
          lastSuccessfulCheckAt: channel.lastSuccessfulCheckAt,
          nextCheckAt: channel.nextCheckAt,
          downloadedCount: source.downloads.filter(
            (download) => download.channelId === channel.id && download.present,
          ).length,
          pendingCount: channelJobs.filter((job) =>
            [
              "pending",
              "preparing",
              "downloading",
              "processing",
              "paused",
            ].includes(job.state),
          ).length,
          status: source.channelErrors[channel.id]
            ? "error"
            : !channel.enabled
              ? "paused"
              : source.checking
                ? "checking"
                : "active",
          error: source.channelErrors[channel.id] ?? null,
        };
      }),
      queue: source.queue.slice(-100).map((job) => ({
        id: job.id,
        videoId: job.videoId,
        channelId: job.channelId,
        title: job.title,
        state: job.state,
        attempts: job.attempts,
        error: job.lastError,
        createdAt: job.createdAt,
      })),
      recommendations: recommendations.map((result) => ({
        channelId: result.channel.channelId,
        title: result.channel.title,
        handle: result.channel.handle,
        avatarUrl: result.channel.avatarUrl,
        reason: result.reason,
        score: result.score,
      })),
      cleanupPreview: cleanupPreview.candidates.map((candidate) => ({
        sourceKey: candidate.sourceKey,
        galleryEntryId: candidate.galleryEntryId,
        bytes: candidate.bytes,
        watched: candidate.watched,
        downloadedAt: candidate.downloadedAt,
      })),
      queuePaused: source.queuePaused,
      checking: source.checking,
      lastCheckAt: lastChecks.length ? Math.max(...lastChecks) : null,
      nextCheckAt: nextChecks.length ? Math.min(...nextChecks) : null,
      backgroundRunning: source.config.backgroundEnabled,
      error: this.lastError,
    };
  }

  private captureError(error: unknown): void {
    this.lastError =
      error instanceof Error
        ? error.message.slice(0, 1_000)
        : "Smart Downloads failed.";
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    try {
      this.options.onChange?.(this.snapshot);
    } catch (error) {
      console.error("Smart Downloads change listener failed.", error);
    }
  }
}

function isSafeRelative(value: string): boolean {
  return Boolean(
    value &&
    value !== ".." &&
    !value.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(value),
  );
}

function safeOwnedPath(root: string, relative: string): string {
  if (!isSafeRelative(relative)) throw new Error("Unsafe managed file path.");
  const resolved = path.resolve(root, relative);
  const check = path.relative(path.resolve(root), resolved);
  if (!isSafeRelative(check)) throw new Error("Unsafe managed file path.");
  return resolved;
}
