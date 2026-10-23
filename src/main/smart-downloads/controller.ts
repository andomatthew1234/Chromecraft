import { EventEmitter } from "node:events";

import type {
  FollowedChannel,
  SmartDownloadQueueJob,
  SmartDownloadQueueState,
  SmartDownloadsConfig,
  SmartDownloadsSnapshot,
} from "./model";
import type {
  QueueResult,
  QueueVideoInput,
  SeenVideoInput,
  SubscribeChannelInput,
} from "./store";

const MINUTE_MS = 60_000;
const CHANNEL_RETRY_BASE_MS = 5 * MINUTE_MS;
const MAX_RETRY_MS = 6 * 60 * MINUTE_MS;
const MAX_DOWNLOAD_ATTEMPTS = 5;
const PENDING_QUEUE_RETRY_MS = 2_500;
type TimerHandle = ReturnType<typeof setTimeout> | number;

export type InitialDownloadMode = "future" | 1 | 3 | 5;
export interface ResolvedSmartDownloadVideo {
  videoId: string;
  title: string;
  publishedAt: number | null;
  sourceUrl?: string;
  thumbnailUrl?: string | null;
  kind?: "video" | "short" | "livestream-replay" | "live" | "premiere";
}
export interface ResolvedSmartDownloadChannel {
  channelId: string;
  title: string;
  handle: string | null;
  canonicalUrl: string;
  avatarUrl: string | null;
  recentVideos: ResolvedSmartDownloadVideo[];
}
export interface SmartDownloadChannelDiscovery {
  resolveChannel(
    input: string,
    recentLimit: number,
  ): Promise<ResolvedSmartDownloadChannel>;
  discoverRecent(
    channel: FollowedChannel,
    recentLimit: number,
  ): Promise<ResolvedSmartDownloadVideo[]>;
}
export interface SmartDownloadEnqueuer {
  /** False while a manual download needs the shared manager slot. */
  canStartAutomatic(): boolean | Promise<boolean>;
  enqueueAutomatic(request: {
    videoId: string;
    sourceUrl: string;
    channelId: string;
    queueJobId: string;
  }): Promise<string>;
}
/** Narrow port matching SmartDownloadsStore; the store is the sole durable owner. */
export interface SmartDownloadsControllerStore {
  readonly snapshot: SmartDownloadsSnapshot;
  initialize(): Promise<void>;
  updateConfig(
    patch: Partial<SmartDownloadsConfig>,
  ): Promise<SmartDownloadsConfig>;
  subscribeChannel(
    input: SubscribeChannelInput,
  ): Promise<{ channel: FollowedChannel; added: boolean }>;
  setChannelEnabled(id: string, enabled: boolean): Promise<FollowedChannel>;
  scheduleChannelCheck(
    id: string,
    nextCheckAt: number | null,
  ): Promise<FollowedChannel>;
  recordChannelCheck(
    id: string,
    options: { successful: boolean; nextCheckAt: number | null },
  ): Promise<FollowedChannel>;
  removeChannel(id: string): Promise<boolean>;
  markVideoSeen(input: SeenVideoInput): Promise<unknown>;
  hasSeenVideo(videoId: string): boolean;
  enqueueVideo(input: QueueVideoInput): Promise<QueueResult>;
  transitionJob(
    id: string,
    state: SmartDownloadQueueState,
  ): Promise<SmartDownloadQueueJob>;
  failJob(
    id: string,
    error: string,
    options?: { retryable?: boolean },
  ): Promise<SmartDownloadQueueJob>;
  retryJob(id: string): Promise<SmartDownloadQueueJob>;
  dueRetryJobs(at?: number): SmartDownloadQueueJob[];
}
export interface SmartDownloadsControllerSnapshot extends SmartDownloadsSnapshot {
  queuePaused: boolean;
  checking: boolean;
  channelErrors: Record<string, string>;
}
export interface SmartDownloadsControllerOptions {
  store: SmartDownloadsControllerStore;
  discovery: SmartDownloadChannelDiscovery;
  enqueuer: SmartDownloadEnqueuer;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  recentLimit?: number;
  onChange?: (snapshot: SmartDownloadsControllerSnapshot) => void;
}
export interface SmartDownloadCheckResult {
  checkedChannels: number;
  discoveredVideos: number;
  queuedVideos: number;
  failures: number;
}

export function retryDelayMs(failures: number): number {
  const exponent = Math.max(0, Math.min(16, Math.floor(failures) - 1));
  return Math.min(MAX_RETRY_MS, CHANNEL_RETRY_BASE_MS * 2 ** exponent);
}

/** Main-process scheduling around the durable store and existing downloader. */
export class SmartDownloadsController extends EventEmitter {
  private readonly now: () => number;
  private readonly recentLimit: number;
  private readonly channelFailures = new Map<string, number>();
  private readonly channelErrors = new Map<string, string>();
  private timer: TimerHandle | null = null;
  private initialized = false;
  private disposed = false;
  private queuePaused = false;
  private checking: Promise<SmartDownloadCheckResult> | null = null;
  private pumping: Promise<void> | null = null;

  constructor(private readonly options: SmartDownloadsControllerOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.recentLimit = Math.max(5, Math.min(50, options.recentLimit ?? 15));
  }

  get snapshot(): SmartDownloadsControllerSnapshot {
    return {
      ...this.options.store.snapshot,
      queuePaused: this.queuePaused,
      checking: this.checking !== null,
      channelErrors: Object.fromEntries(this.channelErrors),
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.options.store.initialize();
    this.initialized = true;
    this.queuePaused = this.options.store.snapshot.queue.some(
      (job) => job.state === "paused",
    );
    this.emitChange();
    if (this.options.store.snapshot.config.enabled) {
      await this.checkDue();
      await this.pumpQueue();
    }
    this.scheduleWake();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.assertReady();
    await this.options.store.updateConfig({ enabled });
    if (!enabled) this.clearScheduledWake();
    this.emitChange();
    if (enabled) {
      await this.checkDue();
      await this.pumpQueue();
    }
    this.scheduleWake();
  }

  async setCheckInterval(
    minutes: SmartDownloadsConfig["checkIntervalMinutes"],
  ): Promise<void> {
    this.assertReady();
    await this.options.store.updateConfig({ checkIntervalMinutes: minutes });
    // Existing due times are left intact. Rewriting them through
    // recordChannelCheck would falsely claim that a network check happened.
    // The new interval is applied after each real successful check.
    this.emitChange();
    this.scheduleWake();
  }

  async addChannel(
    input: string,
    initialDownloads: InitialDownloadMode = "future",
  ): Promise<FollowedChannel> {
    this.assertReady();
    const resolved = validateChannel(
      await this.options.discovery.resolveChannel(input, this.recentLimit),
    );
    if (
      this.options.store.snapshot.channels.some(
        (channel) => channel.id === resolved.channelId,
      )
    ) {
      throw new Error("This YouTube channel is already followed.");
    }
    const now = this.now();
    const result = await this.options.store.subscribeChannel({
      id: resolved.channelId,
      title: resolved.title,
      handle: resolved.handle,
      avatarUrl: resolved.avatarUrl,
      baselineAt: now,
    });
    const recent = sanitizeVideos(resolved.recentVideos);
    for (const item of recent) {
      await this.options.store.markVideoSeen({
        videoId: item.videoId,
        channelId: resolved.channelId,
        state: "discovered",
        publishedAt: item.publishedAt,
      });
    }
    const count = initialDownloads === "future" ? 0 : initialDownloads;
    for (const item of sortNewest(recent).slice(0, count)) {
      await this.queueVideo(resolved.channelId, item, 20);
    }
    await this.options.store.recordChannelCheck(resolved.channelId, {
      successful: true,
      nextCheckAt:
        now +
        this.options.store.snapshot.config.checkIntervalMinutes * MINUTE_MS,
    });
    this.emitChange();
    await this.pumpQueue();
    this.scheduleWake();
    return result.channel;
  }

  async removeChannel(channelId: string): Promise<boolean> {
    this.assertReady();
    const removed = await this.options.store.removeChannel(channelId);
    this.channelFailures.delete(channelId);
    this.channelErrors.delete(channelId);
    if (removed) this.emitChange();
    this.scheduleWake();
    return removed;
  }

  async setChannelEnabled(channelId: string, enabled: boolean): Promise<void> {
    this.assertReady();
    await this.options.store.setChannelEnabled(channelId, enabled);
    if (enabled) {
      await this.options.store.scheduleChannelCheck(channelId, this.now());
    }
    this.emitChange();
    this.scheduleWake();
  }

  async checkDue(): Promise<SmartDownloadCheckResult> {
    this.assertReady();
    if (!this.options.store.snapshot.config.enabled) return emptyResult();
    const now = this.now();
    const ids = this.options.store.snapshot.channels
      .filter(
        (channel) =>
          channel.enabled &&
          (channel.nextCheckAt === null || channel.nextCheckAt <= now),
      )
      .map((channel) => channel.id);
    return this.runCheck(ids);
  }

  async checkNow(channelId?: string): Promise<SmartDownloadCheckResult> {
    this.assertReady();
    const channels = this.options.store.snapshot.channels;
    const ids = channelId
      ? [requireChannel(channels, channelId).id]
      : channels
          .filter((channel) => channel.enabled)
          .map((channel) => channel.id);
    return this.runCheck(ids);
  }

  async pauseQueue(): Promise<void> {
    this.assertReady();
    this.queuePaused = true;
    for (const job of this.options.store.snapshot.queue.filter(
      (candidate) => candidate.state === "pending",
    )) {
      await this.options.store.transitionJob(job.id, "paused");
    }
    // Running yt-dlp work finishes: the existing manager cannot truthfully
    // suspend/resume a process cross-platform without risking corrupt output.
    this.emitChange();
    this.scheduleWake();
  }

  async resumeQueue(): Promise<void> {
    this.assertReady();
    this.queuePaused = false;
    for (const job of this.options.store.snapshot.queue.filter(
      (candidate) => candidate.state === "paused",
    )) {
      await this.options.store.retryJob(job.id);
    }
    this.emitChange();
    await this.pumpQueue();
    this.scheduleWake();
  }

  async reportDownloadState(
    videoId: string,
    state: "downloading" | "processing" | "completed" | "failed" | "cancelled",
    error?: string,
  ): Promise<void> {
    this.assertReady();
    let job = this.options.store.snapshot.queue.find(
      (candidate) => candidate.videoId === videoId,
    );
    if (!job || job.state === state) return;
    if (state === "failed") {
      await this.options.store.failJob(
        job.id,
        error?.slice(0, 1_000) || "The automatic download failed.",
        { retryable: job.attempts < MAX_DOWNLOAD_ATTEMPTS },
      );
    } else if (state === "completed") {
      if (job.state === "downloading") {
        await this.options.store.transitionJob(job.id, "processing");
        job = this.options.store.snapshot.queue.find(
          (candidate) => candidate.id === job?.id,
        )!;
      }
      if (job.state === "processing") {
        await this.options.store.transitionJob(job.id, "completed");
      }
    } else {
      await this.options.store.transitionJob(job.id, state);
    }
    this.emitChange();
    await this.pumpQueue();
    this.scheduleWake();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearScheduledWake();
    this.removeAllListeners();
  }

  private async runCheck(ids: string[]): Promise<SmartDownloadCheckResult> {
    if (this.checking) return this.checking;
    this.checking = this.performCheck(ids).finally(() => {
      this.checking = null;
      this.emitChange();
      this.scheduleWake();
    });
    this.emitChange();
    return this.checking;
  }

  private async performCheck(ids: string[]): Promise<SmartDownloadCheckResult> {
    const result = emptyResult();
    for (const channelId of [...new Set(ids)]) {
      const channel = this.options.store.snapshot.channels.find(
        (item) => item.id === channelId,
      );
      if (!channel) continue;
      result.checkedChannels += 1;
      try {
        const recent = sanitizeVideos(
          await this.options.discovery.discoverRecent(
            channel,
            this.recentLimit,
          ),
        );
        for (const item of recent) {
          if (this.options.store.hasSeenVideo(item.videoId)) continue;
          if (item.kind === "live" || item.kind === "premiere") continue;
          if (!this.isEligible(item)) {
            await this.options.store.markVideoSeen({
              videoId: item.videoId,
              channelId,
              state: "skipped",
              publishedAt: item.publishedAt,
            });
            continue;
          }
          await this.options.store.markVideoSeen({
            videoId: item.videoId,
            channelId,
            state: "discovered",
            publishedAt: item.publishedAt,
          });
          result.discoveredVideos += 1;
          if (await this.queueVideo(channelId, item, 10))
            result.queuedVideos += 1;
        }
        this.channelFailures.delete(channelId);
        this.channelErrors.delete(channelId);
        await this.options.store.recordChannelCheck(channelId, {
          successful: true,
          nextCheckAt:
            this.now() +
            this.options.store.snapshot.config.checkIntervalMinutes * MINUTE_MS,
        });
      } catch (error) {
        const failures = (this.channelFailures.get(channelId) ?? 0) + 1;
        this.channelFailures.set(channelId, failures);
        this.channelErrors.set(channelId, safeError(error));
        await this.options.store.recordChannelCheck(channelId, {
          successful: false,
          nextCheckAt: this.now() + retryDelayMs(failures),
        });
        result.failures += 1;
      }
      this.emitChange();
    }
    await this.pumpQueue();
    return result;
  }

  private async queueVideo(
    channelId: string,
    item: ResolvedSmartDownloadVideo,
    priority: number,
  ): Promise<boolean> {
    return (
      await this.options.store.enqueueVideo({
        videoId: item.videoId,
        channelId,
        sourceUrl: `https://www.youtube.com/watch?v=${item.videoId}`,
        title: item.title,
        priority,
      })
    ).added;
  }

  private async pumpQueue(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = this.performPump().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async performPump(): Promise<void> {
    const config = this.options.store.snapshot.config;
    if (
      !this.initialized ||
      this.disposed ||
      !config.enabled ||
      this.queuePaused
    )
      return;
    for (const job of this.options.store.dueRetryJobs(this.now())) {
      if (job.attempts < MAX_DOWNLOAD_ATTEMPTS) {
        await this.options.store.retryJob(job.id);
      }
    }
    const activeStates = new Set<SmartDownloadQueueState>([
      "preparing",
      "downloading",
      "processing",
    ]);
    const active = this.options.store.snapshot.queue.filter((job) =>
      activeStates.has(job.state),
    ).length;
    let slots = Math.max(0, config.maxConcurrentAutomaticDownloads - active);
    if (slots === 0 || !(await this.options.enqueuer.canStartAutomatic()))
      return;
    const pending = this.options.store.snapshot.queue
      .filter((job) => job.state === "pending")
      .sort(
        (left, right) =>
          right.priority - left.priority || left.createdAt - right.createdAt,
      );
    for (const job of pending) {
      if (slots <= 0 || !(await this.options.enqueuer.canStartAutomatic()))
        break;
      await this.options.store.transitionJob(job.id, "preparing");
      this.emitChange();
      try {
        await this.options.enqueuer.enqueueAutomatic({
          videoId: job.videoId,
          sourceUrl: job.sourceUrl,
          channelId: job.channelId,
          queueJobId: job.id,
        });
        await this.options.store.transitionJob(job.id, "downloading");
        slots -= 1;
      } catch (error) {
        const current = this.options.store.snapshot.queue.find(
          (candidate) => candidate.id === job.id,
        );
        await this.options.store.failJob(job.id, safeError(error), {
          retryable:
            (current?.attempts ?? MAX_DOWNLOAD_ATTEMPTS) <
            MAX_DOWNLOAD_ATTEMPTS,
        });
      }
      this.emitChange();
    }
  }

  private isEligible(item: ResolvedSmartDownloadVideo): boolean {
    const config = this.options.store.snapshot.config;
    if (item.kind === "short" && !config.includeShorts) return false;
    return !(
      item.kind === "livestream-replay" && !config.includeLivestreamReplays
    );
  }

  private emitChange(): void {
    const snapshot = this.snapshot;
    this.options.onChange?.(snapshot);
    this.emit("change", snapshot);
  }

  private scheduleWake(): void {
    this.clearScheduledWake();
    if (
      !this.initialized ||
      this.disposed ||
      !this.options.store.snapshot.config.enabled
    )
      return;
    const candidates = [
      ...this.options.store.snapshot.channels.flatMap((channel) =>
        channel.enabled && channel.nextCheckAt !== null
          ? [channel.nextCheckAt]
          : [],
      ),
      ...this.options.store.snapshot.queue.flatMap((job) =>
        job.state === "failed" && job.retryAt !== null ? [job.retryAt] : [],
      ),
      ...(this.options.store.snapshot.queue.some(
        (job) => job.state === "pending",
      ) && !this.queuePaused
        ? [this.now() + PENDING_QUEUE_RETRY_MS]
        : []),
    ];
    if (candidates.length === 0) return;
    const setTimer = this.options.setTimer ?? setTimeout;
    this.timer = setTimer(
      () => {
        void this.checkDue().then(() => this.pumpQueue());
      },
      Math.max(0, Math.min(...candidates) - this.now()),
    );
    if (typeof this.timer === "object") this.timer.unref?.();
  }

  private clearScheduledWake(): void {
    if (this.timer === null) return;
    if (this.options.clearTimer) this.options.clearTimer(this.timer);
    else clearTimeout(this.timer);
    this.timer = null;
  }

  private assertReady(): void {
    if (!this.initialized)
      throw new Error("Smart Downloads has not initialized.");
    if (this.disposed) throw new Error("Smart Downloads is shutting down.");
  }
}

function emptyResult(): SmartDownloadCheckResult {
  return {
    checkedChannels: 0,
    discoveredVideos: 0,
    queuedVideos: 0,
    failures: 0,
  };
}
function safeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : "An unknown Smart Downloads error occurred.";
  return (
    message.trim().slice(0, 1_000) ||
    "An unknown Smart Downloads error occurred."
  );
}
function sanitizeVideos(
  values: readonly ResolvedSmartDownloadVideo[],
): ResolvedSmartDownloadVideo[] {
  const result: ResolvedSmartDownloadVideo[] = [];
  const seen = new Set<string>();
  for (const item of values.slice(0, 100)) {
    if (!/^[A-Za-z0-9_-]{11}$/u.test(item.videoId) || seen.has(item.videoId))
      continue;
    seen.add(item.videoId);
    result.push({
      ...item,
      title: item.title?.trim().slice(0, 240) || "YouTube video",
      publishedAt:
        Number.isSafeInteger(item.publishedAt) && (item.publishedAt ?? -1) >= 0
          ? item.publishedAt
          : null,
    });
  }
  return result;
}
function sortNewest(
  videos: readonly ResolvedSmartDownloadVideo[],
): ResolvedSmartDownloadVideo[] {
  return [...videos].sort(
    (left, right) => (right.publishedAt ?? 0) - (left.publishedAt ?? 0),
  );
}
function validateChannel(
  value: ResolvedSmartDownloadChannel,
): ResolvedSmartDownloadChannel {
  if (!/^UC[A-Za-z0-9_-]{22}$/u.test(value.channelId))
    throw new Error("The channel could not be resolved to a canonical ID.");
  if (!value.title.trim())
    throw new Error("The resolved channel has no title.");
  let url: URL;
  try {
    url = new URL(value.canonicalUrl);
  } catch {
    throw new Error("The channel resolver returned an invalid URL.");
  }
  if (url.protocol !== "https:" || !/(^|\.)youtube\.com$/iu.test(url.hostname))
    throw new Error("The channel resolver returned a non-YouTube URL.");
  return {
    ...value,
    title: value.title.trim().slice(0, 240),
    handle: value.handle?.trim().slice(0, 64) || null,
    canonicalUrl: url.href,
    avatarUrl: value.avatarUrl?.slice(0, 8_192) ?? null,
  };
}
function requireChannel(
  channels: readonly FollowedChannel[],
  channelId: string,
): FollowedChannel {
  const channel = channels.find((item) => item.id === channelId);
  if (!channel) throw new Error("Smart Downloads channel was not found.");
  return channel;
}
