export const SMART_DOWNLOADS_DOCUMENT_VERSION = 2 as const;
export const DEFAULT_SMART_DOWNLOADS_QUOTA_BYTES = 10 * 1024 ** 3;

export type SmartDownloadQuality = "best" | "1080p" | "720p" | "480p" | "audio";

export type SmartDownloadCleanupPolicy = "oldest" | "watched-first" | "pause";

export type SmartDownloadQueueState =
  | "pending"
  | "preparing"
  | "downloading"
  | "processing"
  | "completed"
  | "paused"
  | "failed"
  | "cancelled"
  | "skipped";

export type SmartDownloadDiscoveryState =
  | "discovered"
  | "queued"
  | "downloading"
  | "processing"
  | "completed"
  | "failed"
  | "skipped"
  | "removed";

export interface SmartDownloadsConfig {
  enabled: boolean;
  storageQuotaBytes: number;
  quality: SmartDownloadQuality;
  cleanupPolicy: SmartDownloadCleanupPolicy;
  checkIntervalMinutes: 15 | 30 | 60 | 180 | 360 | 720 | 1440;
  includeShorts: boolean;
  includeLivestreamReplays: boolean;
  maxConcurrentAutomaticDownloads: 1 | 2 | 3;
  pauseDuringHeavyActivity: boolean;
  backgroundEnabled: boolean;
  startWithWindows: boolean;
  recommendationsEnabled: boolean;
}

export interface FollowedChannel {
  id: string;
  title: string;
  handle: string | null;
  avatarUrl: string | null;
  enabled: boolean;
  addedAt: number;
  baselineAt: number;
  lastCheckedAt: number | null;
  lastSuccessfulCheckAt: number | null;
  nextCheckAt: number | null;
  /** Sanitized failure from the most recent channel check, cleared on success. */
  lastError: string | null;
}

export interface SeenVideoRecord {
  sourceKey: string;
  videoId: string;
  channelId: string;
  state: SmartDownloadDiscoveryState;
  firstSeenAt: number;
  updatedAt: number;
  publishedAt: number | null;
}

export interface SmartDownloadQueueJob {
  id: string;
  sourceKey: string;
  videoId: string;
  channelId: string;
  sourceUrl: string;
  title: string | null;
  state: SmartDownloadQueueState;
  priority: number;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  retryAt: number | null;
  lastError: string | null;
  estimatedBytes: number | null;
  galleryEntryId: string | null;
}

export type DownloadOwnership = "smart" | "manual" | "unknown";

/**
 * File paths are relative to the Smart Downloads managed directory. The store
 * deliberately does not persist arbitrary absolute paths or perform deletion.
 */
export interface ManagedDownloadRecord {
  sourceKey: string;
  videoId: string;
  channelId: string;
  queueJobId: string | null;
  galleryEntryId: string | null;
  ownership: DownloadOwnership;
  ownershipVerified: boolean;
  mediaRelativePath: string | null;
  assetRelativePaths: string[];
  mediaBytes: number;
  assetBytes: number;
  downloadedAt: number;
  watchedAt: number | null;
  keepForever: boolean;
  present: boolean;
}

export interface RecommendationChannelStats {
  channelId: string;
  title: string;
  handle: string | null;
  avatarUrl: string | null;
  distinctVideoIds: string[];
  watchDays: string[];
  totalPlaybackSeconds: number;
  playbackEventCount: number;
  firstWatchedAt: number;
  lastWatchedAt: number;
}

export interface SmartDownloadsDocument {
  version: typeof SMART_DOWNLOADS_DOCUMENT_VERSION;
  config: SmartDownloadsConfig;
  channels: FollowedChannel[];
  seenVideos: SeenVideoRecord[];
  queue: SmartDownloadQueueJob[];
  downloads: ManagedDownloadRecord[];
  recommendationStats: RecommendationChannelStats[];
  recommendationObservationIds: string[];
  dismissedChannelIds: string[];
}

export interface SmartDownloadsSnapshot extends SmartDownloadsDocument {}

export interface RecommendationResult {
  channel: RecommendationChannelStats;
  score: number;
  reason:
    | "You watch this channel often"
    | "Recently watched"
    | "One of your most-watched channels";
}

export interface StorageAccounting {
  quotaBytes: number;
  usedBytes: number;
  availableBytes: number;
  reservedBytes: number;
  managedDownloadCount: number;
}

export interface CleanupCandidate {
  sourceKey: string;
  galleryEntryId: string | null;
  mediaRelativePath: string;
  assetRelativePaths: string[];
  bytes: number;
  watched: boolean;
  downloadedAt: number;
}

export interface CleanupPlan {
  policy: SmartDownloadCleanupPolicy;
  requiredBytes: number;
  bytesToFree: number;
  bytesPlanned: number;
  sufficient: boolean;
  candidates: CleanupCandidate[];
}

export const DEFAULT_SMART_DOWNLOADS_CONFIG: Readonly<SmartDownloadsConfig> =
  Object.freeze({
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

export function createEmptySmartDownloadsDocument(): SmartDownloadsDocument {
  return {
    version: SMART_DOWNLOADS_DOCUMENT_VERSION,
    config: { ...DEFAULT_SMART_DOWNLOADS_CONFIG },
    channels: [],
    seenVideos: [],
    queue: [],
    downloads: [],
    recommendationStats: [],
    recommendationObservationIds: [],
    dismissedChannelIds: [],
  };
}

export function canonicalYouTubeChannelId(value: unknown): string {
  if (typeof value !== "string" || !/^UC[A-Za-z0-9_-]{22}$/u.test(value)) {
    throw new TypeError("A canonical YouTube channel ID is required.");
  }
  return value;
}

export function canonicalYouTubeVideoId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{11}$/u.test(value)) {
    throw new TypeError("A canonical YouTube video ID is required.");
  }
  return value;
}

export function youtubeSourceKey(videoId: unknown): string {
  return `youtube:${canonicalYouTubeVideoId(videoId)}`;
}
