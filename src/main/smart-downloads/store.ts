import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  canonicalYouTubeChannelId,
  canonicalYouTubeVideoId,
  createEmptySmartDownloadsDocument,
  DEFAULT_SMART_DOWNLOADS_CONFIG,
  SMART_DOWNLOADS_DOCUMENT_VERSION,
  youtubeSourceKey,
  type CleanupCandidate,
  type CleanupPlan,
  type FollowedChannel,
  type ManagedDownloadRecord,
  type RecommendationChannelStats,
  type RecommendationResult,
  type SeenVideoRecord,
  type SmartDownloadCleanupPolicy,
  type SmartDownloadDiscoveryState,
  type SmartDownloadQueueJob,
  type SmartDownloadQueueState,
  type SmartDownloadsConfig,
  type SmartDownloadsDocument,
  type SmartDownloadsSnapshot,
  type StorageAccounting,
} from "./model";

const MAX_CHANNELS = 2_000;
const MAX_SEEN_VIDEOS = 100_000;
const MAX_QUEUE_JOBS = 25_000;
const MAX_DOWNLOAD_RECORDS = 25_000;
const MAX_RECOMMENDATION_CHANNELS = 5_000;
const MAX_RECOMMENDATION_VIDEOS_PER_CHANNEL = 500;
const MAX_RECOMMENDATION_DAYS_PER_CHANNEL = 366;
const MAX_OBSERVATION_IDS = 5_000;
const MAX_DISMISSED_CHANNELS = 5_000;
const MAX_TEXT = 240;
const MAX_ERROR_TEXT = 1_000;
const MAX_URL = 8_192;
const MAX_RELATIVE_ASSETS = 16;
const MIN_STORAGE_QUOTA_BYTES = 512 * 1024 ** 2;
const MAX_STORAGE_QUOTA_BYTES = 16 * 1024 ** 4;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;

const queueTransitions: Readonly<
  Record<SmartDownloadQueueState, ReadonlySet<SmartDownloadQueueState>>
> = {
  pending: new Set(["preparing", "paused", "cancelled", "skipped"]),
  preparing: new Set(["downloading", "paused", "failed", "cancelled"]),
  downloading: new Set(["processing", "paused", "failed", "cancelled"]),
  processing: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  paused: new Set(["pending", "cancelled"]),
  failed: new Set(["pending", "cancelled", "skipped"]),
  cancelled: new Set(["pending"]),
  skipped: new Set(["pending"]),
};

export interface SmartDownloadsStoreOptions {
  filePath: string;
  now?: () => number;
  generateId?: () => string;
  onChange?: (snapshot: SmartDownloadsSnapshot) => void;
}

export interface SubscribeChannelInput {
  id: string;
  title: string;
  handle?: string | null;
  avatarUrl?: string | null;
  baselineAt?: number;
  enabled?: boolean;
}

export interface SeenVideoInput {
  videoId: string;
  channelId: string;
  state?: SmartDownloadDiscoveryState;
  publishedAt?: number | null;
}

export interface QueueVideoInput {
  videoId: string;
  channelId: string;
  sourceUrl?: string;
  title?: string | null;
  priority?: number;
  estimatedBytes?: number | null;
}

export interface QueueResult {
  job: SmartDownloadQueueJob;
  added: boolean;
}

export interface RecordManagedDownloadInput {
  videoId: string;
  channelId: string;
  queueJobId?: string | null;
  galleryEntryId?: string | null;
  ownership?: "smart" | "manual" | "unknown";
  ownershipVerified?: boolean;
  mediaRelativePath?: string | null;
  assetRelativePaths?: string[];
  mediaBytes: number;
  assetBytes?: number;
  downloadedAt?: number;
  watchedAt?: number | null;
  keepForever?: boolean;
  present?: boolean;
}

export interface RecommendationObservationInput {
  observationId: string;
  channelId: string;
  channelTitle: string;
  handle?: string | null;
  avatarUrl?: string | null;
  videoId: string;
  playbackSeconds: number;
  occurredAt?: number;
  privateBrowsing?: boolean;
}

interface LoadResult {
  document: SmartDownloadsDocument;
  shouldPersist: boolean;
}

/**
 * Durable policy and metadata owner for Smart Downloads. It performs no
 * network requests, process spawning, or filesystem deletion; callers execute
 * queue jobs and cleanup plans through the existing download/gallery services.
 */
export class SmartDownloadsStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly onChange?: SmartDownloadsStoreOptions["onChange"];
  private document = createEmptySmartDownloadsDocument();
  private operationQueue: Promise<void> = Promise.resolve();
  private temporaryFileCounter = 0;
  private initialized = false;

  constructor(options: SmartDownloadsStoreOptions) {
    this.filePath = path.resolve(options.filePath);
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? randomUUID;
    this.onChange = options.onChange;
  }

  get snapshot(): SmartDownloadsSnapshot {
    return structuredClone(this.document);
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      if (this.initialized) return;
      const loaded = await this.loadDocument();
      this.document = loaded.document;
      const recoveredJobs = this.recoverInterruptedJobs(this.document);
      this.initialized = true;
      if (loaded.shouldPersist || recoveredJobs) {
        await this.writeAtomically(this.document);
      }
      this.emit();
    });
  }

  async updateConfig(
    patch: Partial<SmartDownloadsConfig>,
  ): Promise<SmartDownloadsConfig> {
    const clean = validateConfig({ ...this.document.config, ...patch });
    return this.mutate((draft) => {
      draft.config = clean;
      return { result: structuredClone(clean), changed: true };
    });
  }

  async subscribeChannel(
    input: SubscribeChannelInput,
  ): Promise<{ channel: FollowedChannel; added: boolean }> {
    const id = canonicalYouTubeChannelId(input.id);
    const title = requireText(input.title, "channel title");
    const handle = cleanHandle(input.handle);
    const avatarUrl = cleanWebUrl(input.avatarUrl);
    const now = this.now();
    const baselineAt = cleanTimestamp(input.baselineAt ?? now, "baselineAt");
    return this.mutate<{ channel: FollowedChannel; added: boolean }>(
      (draft) => {
        const existing = draft.channels.find((channel) => channel.id === id);
        if (existing) {
          const changed =
            existing.title !== title ||
            existing.handle !== handle ||
            existing.avatarUrl !== avatarUrl;
          existing.title = title;
          existing.handle = handle;
          existing.avatarUrl = avatarUrl;
          return {
            result: { channel: structuredClone(existing), added: false },
            changed,
          };
        }
        if (draft.channels.length >= MAX_CHANNELS) {
          throw new RangeError("The followed-channel limit has been reached.");
        }
        const channel: FollowedChannel = {
          id,
          title,
          handle,
          avatarUrl,
          enabled: input.enabled ?? true,
          addedAt: now,
          baselineAt,
          lastCheckedAt: null,
          lastSuccessfulCheckAt: null,
          nextCheckAt: null,
        };
        draft.channels.push(channel);
        return {
          result: { channel: structuredClone(channel), added: true },
          changed: true,
        };
      },
    );
  }

  async setChannelEnabled(
    channelId: string,
    enabled: boolean,
  ): Promise<FollowedChannel> {
    const id = canonicalYouTubeChannelId(channelId);
    return this.mutate((draft) => {
      const channel = requireChannel(draft, id);
      if (channel.enabled === enabled) {
        return { result: structuredClone(channel), changed: false };
      }
      channel.enabled = enabled;
      return { result: structuredClone(channel), changed: true };
    });
  }

  async recordChannelCheck(
    channelId: string,
    options: { successful: boolean; nextCheckAt: number | null },
  ): Promise<FollowedChannel> {
    const id = canonicalYouTubeChannelId(channelId);
    const nextCheckAt = cleanNullableTimestamp(
      options.nextCheckAt,
      "nextCheckAt",
    );
    const now = this.now();
    return this.mutate((draft) => {
      const channel = requireChannel(draft, id);
      channel.lastCheckedAt = now;
      if (options.successful) channel.lastSuccessfulCheckAt = now;
      channel.nextCheckAt = nextCheckAt;
      return { result: structuredClone(channel), changed: true };
    });
  }

  async scheduleChannelCheck(
    channelId: string,
    nextCheckAt: number | null,
  ): Promise<FollowedChannel> {
    const id = canonicalYouTubeChannelId(channelId);
    const scheduledAt = cleanNullableTimestamp(nextCheckAt, "nextCheckAt");
    return this.mutate((draft) => {
      const channel = requireChannel(draft, id);
      if (channel.nextCheckAt === scheduledAt) {
        return { result: structuredClone(channel), changed: false };
      }
      channel.nextCheckAt = scheduledAt;
      return { result: structuredClone(channel), changed: true };
    });
  }

  async removeChannel(channelId: string): Promise<boolean> {
    const id = canonicalYouTubeChannelId(channelId);
    return this.mutate((draft) => {
      const index = draft.channels.findIndex((channel) => channel.id === id);
      if (index < 0) return { result: false, changed: false };
      draft.channels.splice(index, 1);
      return { result: true, changed: true };
    });
  }

  async markVideoSeen(input: SeenVideoInput): Promise<SeenVideoRecord> {
    const videoId = canonicalYouTubeVideoId(input.videoId);
    const channelId = canonicalYouTubeChannelId(input.channelId);
    const sourceKey = youtubeSourceKey(videoId);
    const state = input.state ?? "discovered";
    requireDiscoveryState(state);
    const publishedAt = cleanNullableTimestamp(
      input.publishedAt ?? null,
      "publishedAt",
    );
    const now = this.now();
    return this.mutate((draft) => {
      const existing = draft.seenVideos.find(
        (video) => video.sourceKey === sourceKey,
      );
      if (existing) {
        existing.state = state;
        existing.updatedAt = now;
        existing.publishedAt ??= publishedAt;
        return { result: structuredClone(existing), changed: true };
      }
      if (draft.seenVideos.length >= MAX_SEEN_VIDEOS) {
        throw new RangeError("The seen-video limit has been reached.");
      }
      const video: SeenVideoRecord = {
        sourceKey,
        videoId,
        channelId,
        state,
        firstSeenAt: now,
        updatedAt: now,
        publishedAt,
      };
      draft.seenVideos.push(video);
      return { result: structuredClone(video), changed: true };
    });
  }

  hasSeenVideo(videoId: string): boolean {
    this.requireInitialized();
    const sourceKey = youtubeSourceKey(videoId);
    return this.document.seenVideos.some(
      (video) => video.sourceKey === sourceKey,
    );
  }

  async enqueueVideo(input: QueueVideoInput): Promise<QueueResult> {
    const videoId = canonicalYouTubeVideoId(input.videoId);
    const channelId = canonicalYouTubeChannelId(input.channelId);
    const sourceKey = youtubeSourceKey(videoId);
    const sourceUrl = canonicalYouTubeVideoUrl(input.sourceUrl, videoId);
    const title = cleanOptionalText(input.title);
    const priority = cleanInteger(
      input.priority ?? 0,
      -1_000,
      1_000,
      "priority",
    );
    const estimatedBytes = cleanNullableBytes(input.estimatedBytes ?? null);
    const now = this.now();
    return this.mutate<QueueResult>((draft) => {
      const existing = draft.queue.find((job) => job.sourceKey === sourceKey);
      if (existing) {
        return {
          result: { job: structuredClone(existing), added: false },
          changed: false,
        };
      }
      if (
        draft.downloads.some(
          (record) => record.sourceKey === sourceKey && record.present,
        )
      ) {
        throw new Error("This video is already managed by Smart Downloads.");
      }
      if (draft.queue.length >= MAX_QUEUE_JOBS) {
        throw new RangeError(
          "The Smart Downloads queue limit has been reached.",
        );
      }
      const id = requireOpaqueId(this.generateId(), "queue job ID");
      const job: SmartDownloadQueueJob = {
        id,
        sourceKey,
        videoId,
        channelId,
        sourceUrl,
        title,
        state: "pending",
        priority,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        retryAt: null,
        lastError: null,
        estimatedBytes,
        galleryEntryId: null,
      };
      draft.queue.push(job);
      upsertSeenDraft(draft, {
        sourceKey,
        videoId,
        channelId,
        state: "queued",
        firstSeenAt: now,
        updatedAt: now,
        publishedAt: null,
      });
      return {
        result: { job: structuredClone(job), added: true },
        changed: true,
      };
    });
  }

  async transitionJob(
    jobId: string,
    nextState: SmartDownloadQueueState,
    patch: {
      galleryEntryId?: string | null;
      estimatedBytes?: number | null;
    } = {},
  ): Promise<SmartDownloadQueueJob> {
    const id = requireOpaqueId(jobId, "queue job ID");
    requireQueueState(nextState);
    const galleryEntryId = cleanOptionalOpaqueId(
      patch.galleryEntryId,
      "Gallery entry ID",
    );
    const estimatedBytes =
      patch.estimatedBytes === undefined
        ? undefined
        : cleanNullableBytes(patch.estimatedBytes);
    const now = this.now();
    return this.mutate((draft) => {
      const job = requireJob(draft, id);
      if (job.state === nextState) {
        return { result: structuredClone(job), changed: false };
      }
      if (!queueTransitions[job.state].has(nextState)) {
        throw new Error(
          `Cannot transition a Smart Download from ${job.state} to ${nextState}.`,
        );
      }
      job.state = nextState;
      job.updatedAt = now;
      job.retryAt = null;
      if (nextState === "preparing") job.attempts += 1;
      if (galleryEntryId !== undefined) job.galleryEntryId = galleryEntryId;
      if (estimatedBytes !== undefined) job.estimatedBytes = estimatedBytes;
      if (nextState !== "failed") job.lastError = null;
      updateSeenStateForQueue(draft, job, nextState, now);
      return { result: structuredClone(job), changed: true };
    });
  }

  async failJob(
    jobId: string,
    error: string,
    options: { retryable?: boolean } = {},
  ): Promise<SmartDownloadQueueJob> {
    const id = requireOpaqueId(jobId, "queue job ID");
    const message = requireText(error, "download error", MAX_ERROR_TEXT);
    const now = this.now();
    return this.mutate((draft) => {
      const job = requireJob(draft, id);
      if (!queueTransitions[job.state].has("failed")) {
        throw new Error(
          `Cannot fail a Smart Download in the ${job.state} state.`,
        );
      }
      job.state = "failed";
      job.updatedAt = now;
      job.lastError = message;
      job.retryAt =
        options.retryable === false
          ? null
          : now + retryDelayMilliseconds(Math.max(1, job.attempts));
      updateSeenStateForQueue(draft, job, "failed", now);
      return { result: structuredClone(job), changed: true };
    });
  }

  async retryJob(jobId: string): Promise<SmartDownloadQueueJob> {
    const id = requireOpaqueId(jobId, "queue job ID");
    const now = this.now();
    return this.mutate((draft) => {
      const job = requireJob(draft, id);
      if (
        !new Set(["failed", "paused", "cancelled", "skipped"]).has(job.state)
      ) {
        throw new Error(`A ${job.state} Smart Download cannot be retried.`);
      }
      job.state = "pending";
      job.updatedAt = now;
      job.retryAt = null;
      job.lastError = null;
      updateSeenStateForQueue(draft, job, "pending", now);
      return { result: structuredClone(job), changed: true };
    });
  }

  dueRetryJobs(at = this.now()): SmartDownloadQueueJob[] {
    this.requireInitialized();
    cleanTimestamp(at, "retry time");
    return this.document.queue
      .filter(
        (job) =>
          job.state === "failed" && job.retryAt !== null && job.retryAt <= at,
      )
      .map((job) => structuredClone(job));
  }

  async recordManagedDownload(
    input: RecordManagedDownloadInput,
  ): Promise<ManagedDownloadRecord> {
    const videoId = canonicalYouTubeVideoId(input.videoId);
    const channelId = canonicalYouTubeChannelId(input.channelId);
    const sourceKey = youtubeSourceKey(videoId);
    const record: ManagedDownloadRecord = {
      sourceKey,
      videoId,
      channelId,
      queueJobId:
        cleanOptionalOpaqueId(input.queueJobId, "queue job ID") ?? null,
      galleryEntryId:
        cleanOptionalOpaqueId(input.galleryEntryId, "Gallery entry ID") ?? null,
      ownership: input.ownership ?? "smart",
      ownershipVerified: input.ownershipVerified ?? false,
      mediaRelativePath: cleanRelativePath(input.mediaRelativePath ?? null),
      assetRelativePaths: cleanRelativePaths(input.assetRelativePaths ?? []),
      mediaBytes: cleanBytes(input.mediaBytes, "mediaBytes"),
      assetBytes: cleanBytes(input.assetBytes ?? 0, "assetBytes"),
      downloadedAt: cleanTimestamp(
        input.downloadedAt ?? this.now(),
        "downloadedAt",
      ),
      watchedAt: cleanNullableTimestamp(input.watchedAt ?? null, "watchedAt"),
      keepForever: input.keepForever ?? false,
      present: input.present ?? true,
    };
    if (
      record.ownership === "smart" &&
      record.ownershipVerified &&
      !record.mediaRelativePath
    ) {
      throw new TypeError(
        "Verified Smart Downloads require a managed relative media path.",
      );
    }
    return this.mutate((draft) => {
      const index = draft.downloads.findIndex(
        (candidate) => candidate.sourceKey === sourceKey,
      );
      if (index >= 0) draft.downloads[index] = record;
      else {
        if (draft.downloads.length >= MAX_DOWNLOAD_RECORDS) {
          throw new RangeError(
            "The managed-download record limit has been reached.",
          );
        }
        draft.downloads.push(record);
      }
      const job = draft.queue.find(
        (candidate) => candidate.sourceKey === sourceKey,
      );
      if (job) {
        job.galleryEntryId = record.galleryEntryId;
        if (job.state === "processing") {
          job.state = "completed";
          job.updatedAt = this.now();
        }
      }
      const now = this.now();
      upsertSeenDraft(draft, {
        sourceKey,
        videoId,
        channelId,
        state: "completed",
        firstSeenAt: now,
        updatedAt: now,
        publishedAt: null,
      });
      return { result: structuredClone(record), changed: true };
    });
  }

  storageAccounting(): StorageAccounting {
    this.requireInitialized();
    const usedBytes = this.document.downloads.reduce(
      (sum, record) => sum + countManagedBytes(record),
      0,
    );
    const reservedBytes = this.document.queue.reduce(
      (sum, job) =>
        isActiveQueueState(job.state) && job.estimatedBytes !== null
          ? sum + job.estimatedBytes
          : sum,
      0,
    );
    const quotaBytes = this.document.config.storageQuotaBytes;
    return {
      quotaBytes,
      usedBytes,
      availableBytes: Math.max(0, quotaBytes - usedBytes - reservedBytes),
      reservedBytes,
      managedDownloadCount: this.document.downloads.filter(
        (record) => countManagedBytes(record) > 0,
      ).length,
    };
  }

  planCleanup(
    requiredBytes: number,
    options: { currentlyPlayingSourceKeys?: Iterable<string> } = {},
  ): CleanupPlan {
    this.requireInitialized();
    const required = cleanBytes(requiredBytes, "requiredBytes");
    const accounting = this.storageAccounting();
    const bytesToFree = Math.max(
      0,
      accounting.usedBytes +
        accounting.reservedBytes +
        required -
        accounting.quotaBytes,
    );
    const policy = this.document.config.cleanupPolicy;
    if (bytesToFree === 0 || policy === "pause") {
      return {
        policy,
        requiredBytes: required,
        bytesToFree,
        bytesPlanned: 0,
        sufficient: bytesToFree === 0,
        candidates: [],
      };
    }
    const currentlyPlaying = new Set(options.currentlyPlayingSourceKeys ?? []);
    const eligible = this.document.downloads
      .filter(
        (record) =>
          record.present &&
          record.ownership === "smart" &&
          record.ownershipVerified &&
          record.mediaRelativePath !== null &&
          !record.keepForever &&
          !currentlyPlaying.has(record.sourceKey),
      )
      .sort((left, right) => compareCleanupRecords(left, right, policy));
    const candidates: CleanupCandidate[] = [];
    let bytesPlanned = 0;
    for (const record of eligible) {
      const bytes = record.mediaBytes + record.assetBytes;
      if (bytes <= 0) continue;
      candidates.push({
        sourceKey: record.sourceKey,
        galleryEntryId: record.galleryEntryId,
        mediaRelativePath: record.mediaRelativePath!,
        assetRelativePaths: [...record.assetRelativePaths],
        bytes,
        watched: record.watchedAt !== null,
        downloadedAt: record.downloadedAt,
      });
      bytesPlanned += bytes;
      if (bytesPlanned >= bytesToFree) break;
    }
    return {
      policy,
      requiredBytes: required,
      bytesToFree,
      bytesPlanned,
      sufficient: bytesPlanned >= bytesToFree,
      candidates,
    };
  }

  async markDownloadRemoved(sourceKey: string): Promise<boolean> {
    const clean = requireSourceKey(sourceKey);
    return this.mutate((draft) => {
      const record = draft.downloads.find((item) => item.sourceKey === clean);
      if (!record || !record.present) return { result: false, changed: false };
      record.present = false;
      const seen = draft.seenVideos.find((item) => item.sourceKey === clean);
      if (seen) {
        seen.state = "removed";
        seen.updatedAt = this.now();
      }
      return { result: true, changed: true };
    });
  }

  async setKeepForever(
    sourceKey: string,
    keepForever: boolean,
  ): Promise<ManagedDownloadRecord> {
    const clean = requireSourceKey(sourceKey);
    return this.mutate((draft) => {
      const record = requireDownload(draft, clean);
      if (record.keepForever === keepForever) {
        return { result: structuredClone(record), changed: false };
      }
      record.keepForever = keepForever;
      return { result: structuredClone(record), changed: true };
    });
  }

  async markDownloadWatched(
    sourceKey: string,
    watchedAt = this.now(),
  ): Promise<ManagedDownloadRecord> {
    const clean = requireSourceKey(sourceKey);
    const timestamp = cleanTimestamp(watchedAt, "watchedAt");
    return this.mutate((draft) => {
      const record = requireDownload(draft, clean);
      record.watchedAt = timestamp;
      return { result: structuredClone(record), changed: true };
    });
  }

  async recordRecommendationObservation(
    input: RecommendationObservationInput,
  ): Promise<boolean> {
    this.requireInitialized();
    if (!this.document.config.recommendationsEnabled || input.privateBrowsing) {
      return false;
    }
    const observationId = requireOpaqueId(
      input.observationId,
      "observation ID",
    );
    const channelId = canonicalYouTubeChannelId(input.channelId);
    const videoId = canonicalYouTubeVideoId(input.videoId);
    const title = requireText(input.channelTitle, "channel title");
    const handle = cleanHandle(input.handle);
    const avatarUrl = cleanWebUrl(input.avatarUrl);
    if (!Number.isFinite(input.playbackSeconds) || input.playbackSeconds <= 0) {
      throw new RangeError("playbackSeconds must be positive.");
    }
    const playbackSeconds = Math.min(input.playbackSeconds, 24 * 60 * 60);
    const occurredAt = cleanTimestamp(
      input.occurredAt ?? this.now(),
      "occurredAt",
    );
    return this.mutate((draft) => {
      if (!draft.config.recommendationsEnabled) {
        return { result: false, changed: false };
      }
      if (draft.recommendationObservationIds.includes(observationId)) {
        return { result: false, changed: false };
      }
      draft.recommendationObservationIds.push(observationId);
      trimFromStart(draft.recommendationObservationIds, MAX_OBSERVATION_IDS);
      let stats = draft.recommendationStats.find(
        (entry) => entry.channelId === channelId,
      );
      if (!stats) {
        if (draft.recommendationStats.length >= MAX_RECOMMENDATION_CHANNELS) {
          draft.recommendationStats.sort(
            (left, right) => left.lastWatchedAt - right.lastWatchedAt,
          );
          draft.recommendationStats.shift();
        }
        stats = {
          channelId,
          title,
          handle,
          avatarUrl,
          distinctVideoIds: [],
          watchDays: [],
          totalPlaybackSeconds: 0,
          playbackEventCount: 0,
          firstWatchedAt: occurredAt,
          lastWatchedAt: occurredAt,
        };
        draft.recommendationStats.push(stats);
      }
      stats.title = title;
      stats.handle = handle;
      stats.avatarUrl = avatarUrl;
      if (!stats.distinctVideoIds.includes(videoId)) {
        stats.distinctVideoIds.push(videoId);
        trimFromStart(
          stats.distinctVideoIds,
          MAX_RECOMMENDATION_VIDEOS_PER_CHANNEL,
        );
      }
      const day = new Date(occurredAt).toISOString().slice(0, 10);
      if (!stats.watchDays.includes(day)) {
        stats.watchDays.push(day);
        trimFromStart(stats.watchDays, MAX_RECOMMENDATION_DAYS_PER_CHANNEL);
      }
      stats.totalPlaybackSeconds = Math.min(
        Number.MAX_SAFE_INTEGER,
        stats.totalPlaybackSeconds + playbackSeconds,
      );
      stats.playbackEventCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        stats.playbackEventCount + 1,
      );
      stats.firstWatchedAt = Math.min(stats.firstWatchedAt, occurredAt);
      stats.lastWatchedAt = Math.max(stats.lastWatchedAt, occurredAt);
      return { result: true, changed: true };
    });
  }

  recommendations(limit = 10, at = this.now()): RecommendationResult[] {
    this.requireInitialized();
    const maximum = cleanInteger(limit, 1, 100, "recommendation limit");
    cleanTimestamp(at, "recommendation time");
    if (!this.document.config.recommendationsEnabled) return [];
    const followed = new Set(
      this.document.channels.map((channel) => channel.id),
    );
    const dismissed = new Set(this.document.dismissedChannelIds);
    return this.document.recommendationStats
      .filter(
        (stats) =>
          !followed.has(stats.channelId) &&
          !dismissed.has(stats.channelId) &&
          hasRecommendationEvidence(stats),
      )
      .map((stats) => ({
        channel: structuredClone(stats),
        score: recommendationScore(stats, at),
        reason: recommendationReason(stats, at),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.channel.lastWatchedAt - left.channel.lastWatchedAt,
      )
      .slice(0, maximum);
  }

  async dismissRecommendation(channelId: string): Promise<boolean> {
    const id = canonicalYouTubeChannelId(channelId);
    return this.mutate((draft) => {
      if (draft.dismissedChannelIds.includes(id)) {
        return { result: false, changed: false };
      }
      draft.dismissedChannelIds.push(id);
      trimFromStart(draft.dismissedChannelIds, MAX_DISMISSED_CHANNELS);
      return { result: true, changed: true };
    });
  }

  async clearRecommendationHistory(): Promise<void> {
    await this.mutate((draft) => {
      const changed =
        draft.recommendationStats.length > 0 ||
        draft.recommendationObservationIds.length > 0 ||
        draft.dismissedChannelIds.length > 0;
      draft.recommendationStats = [];
      draft.recommendationObservationIds = [];
      draft.dismissedChannelIds = [];
      return { result: undefined, changed };
    });
  }

  private async loadDocument(): Promise<LoadResult> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return migrateAndValidate(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          document: createEmptySmartDownloadsDocument(),
          shouldPersist: false,
        };
      }
      console.warn(
        "Could not read Smart Downloads state; recovering with safe defaults.",
        error,
      );
      return {
        document: createEmptySmartDownloadsDocument(),
        shouldPersist: true,
      };
    }
  }

  private recoverInterruptedJobs(document: SmartDownloadsDocument): boolean {
    let changed = false;
    const now = this.now();
    for (const job of document.queue) {
      if (
        job.state === "preparing" ||
        job.state === "downloading" ||
        job.state === "processing"
      ) {
        job.state = "paused";
        job.updatedAt = now;
        job.retryAt = null;
        job.lastError = "Chromecraft closed before this download finished.";
        changed = true;
      }
    }
    return changed;
  }

  private async mutate<T>(
    operation: (
      draft: SmartDownloadsDocument,
    ) =>
      | { result: T; changed: boolean }
      | Promise<{ result: T; changed: boolean }>,
  ): Promise<T> {
    this.requireInitialized();
    let result!: T;
    await this.enqueue(async () => {
      const draft = structuredClone(this.document);
      const outcome = await operation(draft);
      result = outcome.result;
      if (!outcome.changed) return;
      await this.writeAtomically(draft);
      this.document = draft;
      this.emit();
    });
    return result;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.catch(() => undefined);
    return next;
  }

  private async writeAtomically(
    document: SmartDownloadsDocument,
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${++this.temporaryFileCounter}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private emit(): void {
    try {
      this.onChange?.(this.snapshot);
    } catch (error) {
      console.error("Smart Downloads change listener failed.", error);
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("SmartDownloadsStore must be initialized before use.");
    }
  }
}

function migrateAndValidate(value: unknown): LoadResult {
  if (!isRecord(value)) {
    return {
      document: createEmptySmartDownloadsDocument(),
      shouldPersist: true,
    };
  }
  if (value.version === 1) {
    const migrated = {
      ...value,
      version: SMART_DOWNLOADS_DOCUMENT_VERSION,
      downloads: Array.isArray(value.downloads) ? value.downloads : [],
      recommendationStats: Array.isArray(value.recommendationStats)
        ? value.recommendationStats
        : [],
      recommendationObservationIds: [],
      dismissedChannelIds: Array.isArray(value.dismissedChannelIds)
        ? value.dismissedChannelIds
        : [],
    };
    return { document: validateDocument(migrated), shouldPersist: true };
  }
  if (value.version !== SMART_DOWNLOADS_DOCUMENT_VERSION) {
    return {
      document: createEmptySmartDownloadsDocument(),
      shouldPersist: true,
    };
  }
  const document = validateDocument(value);
  return {
    document,
    shouldPersist: JSON.stringify(document) !== JSON.stringify(value),
  };
}

function validateDocument(
  value: Record<string, unknown>,
): SmartDownloadsDocument {
  const empty = createEmptySmartDownloadsDocument();
  const config = validateConfig(isRecord(value.config) ? value.config : {});
  return {
    version: SMART_DOWNLOADS_DOCUMENT_VERSION,
    config,
    channels: validateArray(
      value.channels,
      validateChannel,
      MAX_CHANNELS,
      "id",
    ),
    seenVideos: validateArray(
      value.seenVideos,
      validateSeenVideo,
      MAX_SEEN_VIDEOS,
      "sourceKey",
    ),
    queue: validateArray(
      value.queue,
      validateQueueJob,
      MAX_QUEUE_JOBS,
      "sourceKey",
    ),
    downloads: validateArray(
      value.downloads,
      validateDownload,
      MAX_DOWNLOAD_RECORDS,
      "sourceKey",
    ),
    recommendationStats: validateArray(
      value.recommendationStats,
      validateRecommendationStats,
      MAX_RECOMMENDATION_CHANNELS,
      "channelId",
    ),
    recommendationObservationIds: cleanOpaqueIds(
      value.recommendationObservationIds,
      MAX_OBSERVATION_IDS,
    ),
    dismissedChannelIds: cleanChannelIds(
      value.dismissedChannelIds,
      MAX_DISMISSED_CHANNELS,
    ),
  } satisfies SmartDownloadsDocument;
}

function validateConfig(
  value: Record<string, unknown> | SmartDownloadsConfig,
): SmartDownloadsConfig {
  const qualityValues = new Set(["best", "1080p", "720p", "480p", "audio"]);
  const cleanupValues = new Set(["oldest", "watched-first", "pause"]);
  const intervalValues = new Set([15, 30, 60, 180, 360, 720, 1440]);
  const concurrencyValues = new Set([1, 2, 3]);
  return {
    enabled: booleanOr(value.enabled, DEFAULT_SMART_DOWNLOADS_CONFIG.enabled),
    storageQuotaBytes:
      typeof value.storageQuotaBytes === "number" &&
      Number.isSafeInteger(value.storageQuotaBytes) &&
      value.storageQuotaBytes >= MIN_STORAGE_QUOTA_BYTES &&
      value.storageQuotaBytes <= MAX_STORAGE_QUOTA_BYTES
        ? value.storageQuotaBytes
        : DEFAULT_SMART_DOWNLOADS_CONFIG.storageQuotaBytes,
    quality: qualityValues.has(value.quality as string)
      ? (value.quality as SmartDownloadsConfig["quality"])
      : DEFAULT_SMART_DOWNLOADS_CONFIG.quality,
    cleanupPolicy: cleanupValues.has(value.cleanupPolicy as string)
      ? (value.cleanupPolicy as SmartDownloadCleanupPolicy)
      : DEFAULT_SMART_DOWNLOADS_CONFIG.cleanupPolicy,
    checkIntervalMinutes: intervalValues.has(
      value.checkIntervalMinutes as number,
    )
      ? (value.checkIntervalMinutes as SmartDownloadsConfig["checkIntervalMinutes"])
      : DEFAULT_SMART_DOWNLOADS_CONFIG.checkIntervalMinutes,
    includeShorts: booleanOr(
      value.includeShorts,
      DEFAULT_SMART_DOWNLOADS_CONFIG.includeShorts,
    ),
    includeLivestreamReplays: booleanOr(
      value.includeLivestreamReplays,
      DEFAULT_SMART_DOWNLOADS_CONFIG.includeLivestreamReplays,
    ),
    maxConcurrentAutomaticDownloads: concurrencyValues.has(
      value.maxConcurrentAutomaticDownloads as number,
    )
      ? (value.maxConcurrentAutomaticDownloads as 1 | 2 | 3)
      : DEFAULT_SMART_DOWNLOADS_CONFIG.maxConcurrentAutomaticDownloads,
    pauseDuringHeavyActivity: booleanOr(
      value.pauseDuringHeavyActivity,
      DEFAULT_SMART_DOWNLOADS_CONFIG.pauseDuringHeavyActivity,
    ),
    backgroundEnabled: booleanOr(
      value.backgroundEnabled,
      DEFAULT_SMART_DOWNLOADS_CONFIG.backgroundEnabled,
    ),
    startWithWindows: booleanOr(
      value.startWithWindows,
      DEFAULT_SMART_DOWNLOADS_CONFIG.startWithWindows,
    ),
    recommendationsEnabled: booleanOr(
      value.recommendationsEnabled,
      DEFAULT_SMART_DOWNLOADS_CONFIG.recommendationsEnabled,
    ),
  };
}

function validateChannel(value: unknown): FollowedChannel | null {
  if (!isRecord(value)) return null;
  try {
    return {
      id: canonicalYouTubeChannelId(value.id),
      title: requireText(value.title, "channel title"),
      handle: cleanHandle(value.handle),
      avatarUrl: cleanWebUrl(value.avatarUrl),
      enabled: typeof value.enabled === "boolean" ? value.enabled : true,
      addedAt: cleanTimestamp(value.addedAt, "addedAt"),
      baselineAt: cleanTimestamp(value.baselineAt, "baselineAt"),
      lastCheckedAt: cleanNullableTimestamp(
        value.lastCheckedAt,
        "lastCheckedAt",
      ),
      lastSuccessfulCheckAt: cleanNullableTimestamp(
        value.lastSuccessfulCheckAt,
        "lastSuccessfulCheckAt",
      ),
      nextCheckAt: cleanNullableTimestamp(value.nextCheckAt, "nextCheckAt"),
    };
  } catch {
    return null;
  }
}

function validateSeenVideo(value: unknown): SeenVideoRecord | null {
  if (!isRecord(value)) return null;
  try {
    const videoId = canonicalYouTubeVideoId(value.videoId);
    const sourceKey = requireSourceKey(value.sourceKey);
    if (sourceKey !== youtubeSourceKey(videoId)) return null;
    const state = requireDiscoveryState(value.state);
    return {
      sourceKey,
      videoId,
      channelId: canonicalYouTubeChannelId(value.channelId),
      state,
      firstSeenAt: cleanTimestamp(value.firstSeenAt, "firstSeenAt"),
      updatedAt: cleanTimestamp(value.updatedAt, "updatedAt"),
      publishedAt: cleanNullableTimestamp(value.publishedAt, "publishedAt"),
    };
  } catch {
    return null;
  }
}

function validateQueueJob(value: unknown): SmartDownloadQueueJob | null {
  if (!isRecord(value)) return null;
  try {
    const videoId = canonicalYouTubeVideoId(value.videoId);
    const sourceKey = requireSourceKey(value.sourceKey);
    if (sourceKey !== youtubeSourceKey(videoId)) return null;
    return {
      id: requireOpaqueId(value.id, "queue job ID"),
      sourceKey,
      videoId,
      channelId: canonicalYouTubeChannelId(value.channelId),
      sourceUrl: canonicalYouTubeVideoUrl(value.sourceUrl, videoId),
      title: cleanOptionalText(value.title),
      state: requireQueueState(value.state),
      priority: cleanInteger(value.priority, -1_000, 1_000, "priority"),
      attempts: cleanInteger(value.attempts, 0, 1_000, "attempts"),
      createdAt: cleanTimestamp(value.createdAt, "createdAt"),
      updatedAt: cleanTimestamp(value.updatedAt, "updatedAt"),
      retryAt: cleanNullableTimestamp(value.retryAt, "retryAt"),
      lastError: cleanOptionalText(value.lastError, MAX_ERROR_TEXT),
      estimatedBytes: cleanNullableBytes(value.estimatedBytes),
      galleryEntryId:
        cleanOptionalOpaqueId(value.galleryEntryId, "Gallery entry ID") ?? null,
    };
  } catch {
    return null;
  }
}

function validateDownload(value: unknown): ManagedDownloadRecord | null {
  if (!isRecord(value)) return null;
  try {
    const videoId = canonicalYouTubeVideoId(value.videoId);
    const sourceKey = requireSourceKey(value.sourceKey);
    if (sourceKey !== youtubeSourceKey(videoId)) return null;
    const ownership = new Set(["smart", "manual", "unknown"]).has(
      value.ownership as string,
    )
      ? (value.ownership as ManagedDownloadRecord["ownership"])
      : "unknown";
    const ownershipVerified = value.ownershipVerified === true;
    const mediaRelativePath = cleanRelativePath(
      value.mediaRelativePath ?? null,
    );
    if (ownership === "smart" && ownershipVerified && !mediaRelativePath)
      return null;
    return {
      sourceKey,
      videoId,
      channelId: canonicalYouTubeChannelId(value.channelId),
      queueJobId:
        cleanOptionalOpaqueId(value.queueJobId, "queue job ID") ?? null,
      galleryEntryId:
        cleanOptionalOpaqueId(value.galleryEntryId, "Gallery entry ID") ?? null,
      ownership,
      ownershipVerified,
      mediaRelativePath,
      assetRelativePaths: cleanRelativePaths(value.assetRelativePaths),
      mediaBytes: cleanBytes(value.mediaBytes, "mediaBytes"),
      assetBytes: cleanBytes(value.assetBytes, "assetBytes"),
      downloadedAt: cleanTimestamp(value.downloadedAt, "downloadedAt"),
      watchedAt: cleanNullableTimestamp(value.watchedAt, "watchedAt"),
      keepForever: value.keepForever === true,
      present: value.present === true,
    };
  } catch {
    return null;
  }
}

function validateRecommendationStats(
  value: unknown,
): RecommendationChannelStats | null {
  if (!isRecord(value)) return null;
  try {
    const distinctVideoIds = Array.isArray(value.distinctVideoIds)
      ? [
          ...new Set(
            value.distinctVideoIds.flatMap((id) => {
              try {
                return [canonicalYouTubeVideoId(id)];
              } catch {
                return [];
              }
            }),
          ),
        ].slice(-MAX_RECOMMENDATION_VIDEOS_PER_CHANNEL)
      : [];
    const watchDays = Array.isArray(value.watchDays)
      ? [
          ...new Set(
            value.watchDays.filter(
              (day): day is string =>
                typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(day),
            ),
          ),
        ].slice(-MAX_RECOMMENDATION_DAYS_PER_CHANNEL)
      : [];
    return {
      channelId: canonicalYouTubeChannelId(value.channelId),
      title: requireText(value.title, "channel title"),
      handle: cleanHandle(value.handle),
      avatarUrl: cleanWebUrl(value.avatarUrl),
      distinctVideoIds,
      watchDays,
      totalPlaybackSeconds: cleanFiniteNumber(
        value.totalPlaybackSeconds,
        0,
        Number.MAX_SAFE_INTEGER,
        "totalPlaybackSeconds",
      ),
      playbackEventCount: cleanInteger(
        value.playbackEventCount,
        0,
        Number.MAX_SAFE_INTEGER,
        "playbackEventCount",
      ),
      firstWatchedAt: cleanTimestamp(value.firstWatchedAt, "firstWatchedAt"),
      lastWatchedAt: cleanTimestamp(value.lastWatchedAt, "lastWatchedAt"),
    };
  } catch {
    return null;
  }
}

function validateArray<T extends object>(
  value: unknown,
  validate: (item: unknown) => T | null,
  maximum: number,
  uniqueKey: keyof T,
): T[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<unknown>();
  const result: T[] = [];
  for (const item of value.slice(0, maximum)) {
    const clean = validate(item);
    if (!clean || keys.has(clean[uniqueKey])) continue;
    keys.add(clean[uniqueKey]);
    result.push(clean);
  }
  return result;
}

function upsertSeenDraft(
  draft: SmartDownloadsDocument,
  record: SeenVideoRecord,
): void {
  const existing = draft.seenVideos.find(
    (video) => video.sourceKey === record.sourceKey,
  );
  if (existing) {
    existing.state = record.state;
    existing.updatedAt = record.updatedAt;
    existing.publishedAt ??= record.publishedAt;
    return;
  }
  if (draft.seenVideos.length < MAX_SEEN_VIDEOS) draft.seenVideos.push(record);
}

function updateSeenStateForQueue(
  draft: SmartDownloadsDocument,
  job: SmartDownloadQueueJob,
  state: SmartDownloadQueueState,
  now: number,
): void {
  const discoveryState: SmartDownloadDiscoveryState =
    state === "pending" || state === "preparing" || state === "paused"
      ? "queued"
      : state === "cancelled"
        ? "skipped"
        : state;
  upsertSeenDraft(draft, {
    sourceKey: job.sourceKey,
    videoId: job.videoId,
    channelId: job.channelId,
    state: discoveryState,
    firstSeenAt: now,
    updatedAt: now,
    publishedAt: null,
  });
}

function countManagedBytes(record: ManagedDownloadRecord): number {
  return record.present &&
    record.ownership === "smart" &&
    record.ownershipVerified &&
    record.mediaRelativePath !== null
    ? record.mediaBytes + record.assetBytes
    : 0;
}

function isActiveQueueState(state: SmartDownloadQueueState): boolean {
  return new Set([
    "pending",
    "preparing",
    "downloading",
    "processing",
    "paused",
  ]).has(state);
}

function compareCleanupRecords(
  left: ManagedDownloadRecord,
  right: ManagedDownloadRecord,
  policy: SmartDownloadCleanupPolicy,
): number {
  if (policy === "watched-first") {
    const watchedDifference =
      Number(right.watchedAt !== null) - Number(left.watchedAt !== null);
    if (watchedDifference !== 0) return watchedDifference;
  }
  return left.downloadedAt - right.downloadedAt;
}

function hasRecommendationEvidence(stats: RecommendationChannelStats): boolean {
  return (
    (stats.distinctVideoIds.length >= 2 &&
      stats.totalPlaybackSeconds >= 10 * 60) ||
    (stats.watchDays.length >= 2 && stats.totalPlaybackSeconds >= 20 * 60) ||
    stats.distinctVideoIds.length >= 4
  );
}

export function recommendationScore(
  stats: RecommendationChannelStats,
  at: number,
): number {
  const ageDays = Math.max(
    0,
    (at - stats.lastWatchedAt) / (24 * 60 * 60 * 1_000),
  );
  const videoScore = Math.min(100, stats.distinctVideoIds.length * 20);
  const durationScore = Math.min(90, (stats.totalPlaybackSeconds / 60) * 0.5);
  const consistencyScore = Math.min(75, stats.watchDays.length * 15);
  const recencyScore = Math.max(0, 60 - ageDays * 2);
  return (
    Math.round(
      (videoScore + durationScore + consistencyScore + recencyScore) * 100,
    ) / 100
  );
}

function recommendationReason(
  stats: RecommendationChannelStats,
  at: number,
): RecommendationResult["reason"] {
  const ageDays = Math.max(
    0,
    (at - stats.lastWatchedAt) / (24 * 60 * 60 * 1_000),
  );
  if (stats.watchDays.length >= 4 || stats.distinctVideoIds.length >= 5) {
    return "One of your most-watched channels";
  }
  if (ageDays <= 7) return "Recently watched";
  return "You watch this channel often";
}

function retryDelayMilliseconds(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 30_000 * 2 ** Math.min(10, attempts - 1));
}

function requireChannel(
  draft: SmartDownloadsDocument,
  id: string,
): FollowedChannel {
  const channel = draft.channels.find((candidate) => candidate.id === id);
  if (!channel) throw new Error("Unknown followed channel.");
  return channel;
}

function requireJob(
  draft: SmartDownloadsDocument,
  id: string,
): SmartDownloadQueueJob {
  const job = draft.queue.find((candidate) => candidate.id === id);
  if (!job) throw new Error("Unknown Smart Download queue job.");
  return job;
}

function requireDownload(
  draft: SmartDownloadsDocument,
  sourceKey: string,
): ManagedDownloadRecord {
  const record = draft.downloads.find(
    (candidate) => candidate.sourceKey === sourceKey,
  );
  if (!record) throw new Error("Unknown managed Smart Download.");
  return record;
}

function requireSourceKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^youtube:[A-Za-z0-9_-]{11}$/u.test(value)
  ) {
    throw new TypeError("A canonical source key is required.");
  }
  return value;
}

function requireQueueState(value: unknown): SmartDownloadQueueState {
  if (
    typeof value !== "string" ||
    !new Set([
      "pending",
      "preparing",
      "downloading",
      "processing",
      "completed",
      "paused",
      "failed",
      "cancelled",
      "skipped",
    ]).has(value)
  ) {
    throw new TypeError("Unknown Smart Download queue state.");
  }
  return value as SmartDownloadQueueState;
}

function requireDiscoveryState(value: unknown): SmartDownloadDiscoveryState {
  if (
    typeof value !== "string" ||
    !new Set([
      "discovered",
      "queued",
      "downloading",
      "processing",
      "completed",
      "failed",
      "skipped",
      "removed",
    ]).has(value)
  ) {
    throw new TypeError("Unknown Smart Download discovery state.");
  }
  return value as SmartDownloadDiscoveryState;
}

function requireText(
  value: unknown,
  field: string,
  maximum = MAX_TEXT,
): string {
  const clean = cleanOptionalText(value, maximum);
  if (!clean) throw new TypeError(`A valid ${field} is required.`);
  return clean;
}

function cleanOptionalText(value: unknown, maximum = MAX_TEXT): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string")
    throw new TypeError("Text metadata is invalid.");
  const clean = value.trim().replace(/\s+/gu, " ");
  if (!clean || clean.length > maximum)
    throw new TypeError("Text metadata is invalid.");
  return clean;
}

function cleanHandle(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string")
    throw new TypeError("The channel handle is invalid.");
  const clean = value.trim();
  if (!/^@[A-Za-z0-9._-]{3,64}$/u.test(clean)) {
    throw new TypeError("The channel handle is invalid.");
  }
  return clean;
}

function cleanWebUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_URL) {
    throw new TypeError("The URL is invalid.");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("The URL is invalid.");
  }
  return url.href;
}

function canonicalYouTubeVideoUrl(
  value: unknown,
  expectedVideoId: string,
): string {
  if (value === null || value === undefined || value === "") {
    return `https://www.youtube.com/watch?v=${expectedVideoId}`;
  }
  const clean = cleanWebUrl(value);
  if (!clean) throw new TypeError("A valid YouTube video URL is required.");
  const url = new URL(clean);
  const hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
  let actualVideoId: string | null = null;
  if (hostname === "youtu.be") {
    actualVideoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (hostname === "youtube.com" || hostname === "m.youtube.com") {
    if (url.pathname === "/watch") actualVideoId = url.searchParams.get("v");
    else if (/^\/(?:shorts|live)\//u.test(url.pathname)) {
      actualVideoId = url.pathname.split("/").filter(Boolean)[1] ?? null;
    }
  }
  if (actualVideoId !== expectedVideoId) {
    throw new TypeError(
      "The YouTube URL does not match the canonical video ID.",
    );
  }
  return `https://www.youtube.com/watch?v=${expectedVideoId}`;
}

function requireOpaqueId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new TypeError(`A valid ${field} is required.`);
  }
  return value;
}

function cleanOptionalOpaqueId(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return requireOpaqueId(value, field);
}

function cleanRelativePath(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    path.isAbsolute(value)
  ) {
    throw new TypeError("A safe managed relative path is required.");
  }
  const normalized = path.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.includes(`..${path.sep}`) ||
    normalized.includes("\0")
  ) {
    throw new TypeError("A safe managed relative path is required.");
  }
  return normalized;
}

function cleanRelativePaths(value: unknown): string[] {
  if (!Array.isArray(value))
    throw new TypeError("Managed asset paths are invalid.");
  return [
    ...new Set(
      value
        .map(cleanRelativePath)
        .filter((entry): entry is string => entry !== null),
    ),
  ].slice(0, MAX_RELATIVE_ASSETS);
}

function cleanTimestamp(value: unknown, field: string): number {
  return cleanInteger(value, 0, Number.MAX_SAFE_INTEGER, field);
}

function cleanNullableTimestamp(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return cleanTimestamp(value, field);
}

function cleanBytes(value: unknown, field: string): number {
  return cleanInteger(value, 0, Number.MAX_SAFE_INTEGER, field);
}

function cleanNullableBytes(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return cleanBytes(value, "byte count");
}

function cleanInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${field} is outside its supported range.`);
  }
  return value;
}

function cleanFiniteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${field} is outside its supported range.`);
  }
  return value;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function cleanOpaqueIds(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((id) => {
        try {
          return [requireOpaqueId(id, "opaque ID")];
        } catch {
          return [];
        }
      }),
    ),
  ].slice(-maximum);
}

function cleanChannelIds(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((id) => {
        try {
          return [canonicalYouTubeChannelId(id)];
        } catch {
          return [];
        }
      }),
    ),
  ].slice(-maximum);
}

function trimFromStart<T>(items: T[], maximum: number): void {
  if (items.length > maximum) items.splice(0, items.length - maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
