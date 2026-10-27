import type { UpdatePreferences, UpdateSnapshot } from "./updates";
import type {
  OfflinePageEntrySnapshot,
  OfflinePagesSnapshot,
} from "./offline-pages";
import type {
  AiToolApplyResult,
  AiGroupingMode,
  AiProviderId,
  AiToolsSnapshot,
  GeminiApiKeyUpdate,
  OrganiseTabsProposal,
  OrganiseTabsRequest,
} from "./ai-tools";
import type {
  AssistantAttachment,
  AssistantContextCaptured,
  AssistantMessageRequest,
  AssistantMessageResponse,
  AssistantPageContext,
} from "./ai-assistant";
import type {
  AgentRunCommand,
  AgentRunSnapshot,
  AgentRunStartRequest,
  ScoutAgentSnapshot,
} from "./agent";
import type {
  SmartReaderAppearance,
  SmartReaderCommand,
  SmartReaderTabSnapshot,
  SmartReaderViewSnapshot,
} from "./smart-reader";
import type {
  CommitOnboardingGeminiKeyRequest,
  GeminiClipboardDetectionSnapshot,
  OnboardingViewBounds,
  OnboardingLocalAiSnapshot,
  OnboardingOllamaModel,
  OnboardingRecommendedSettings,
} from "./onboarding";

export type TabId = string;

export type TabGroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

export interface TabGroupSnapshot {
  id: string;
  name: string;
  color: TabGroupColor;
  collapsed: boolean;
  saved: boolean;
  createdAt: number;
}

export interface TabGroupUpdate {
  name?: string;
  color?: TabGroupColor;
  collapsed?: boolean;
  saved?: boolean;
}

export type TabSelectionMode = "replace" | "add" | "toggle" | "range";

export interface TabSearchResult {
  kind: "open" | "recently-closed";
  id: string;
  tabId: TabId | null;
  title: string;
  url: string;
  groupId: string | null;
  isActive: boolean;
  isAudible: boolean;
  memoryBytes: number | null;
  closedAt: number | null;
}

export interface BrowserTabSnapshot {
  id: TabId;
  title: string;
  url: string;
  /** Shell-safe image data discovered by Chromium for the current document. */
  faviconDataUrl: string | null;
  isNewTab: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  error: string | null;
  isMuted: boolean;
  zoomFactor: number;
  pinned: boolean;
  groupId: string | null;
  isSelected: boolean;
  isAudible: boolean;
  /** Best-effort renderer process working-set estimate. Shared processes may overlap. */
  memoryBytes: number | null;
  /** Ephemeral, low-resolution preview captured while the page was visible. */
  thumbnailDataUrl: string | null;
  reader: SmartReaderTabSnapshot;
}

export type SplitViewSide = "left" | "right";

export interface SplitViewPairSnapshot {
  id: string;
  leftTabId: TabId;
  rightTabId: TabId;
  ratio: number;
  focusedTabId: TabId;
}

export interface SplitViewSnapshot {
  pairs: SplitViewPairSnapshot[];
  activePairId: string | null;
}

export type SplitViewCommand =
  | { type: "create"; tabId: TabId; side: SplitViewSide }
  | { type: "focus"; pairId: string; tabId: TabId }
  | { type: "resize"; pairId: string; ratio: number }
  | { type: "swap"; pairId: string }
  | { type: "exit"; pairId: string };

export interface WebStoreListingSnapshot {
  extensionId: string;
  itemUrl: string;
  title: string;
  description: string | null;
}

export interface YouTubeWatchSnapshot {
  videoId: string;
  url: string;
}

export type YouTubeDownloadStage =
  | "pending"
  | "downloading"
  | "finishing"
  | "completed"
  | "interrupted"
  | "cancelled"
  | "failed";

export interface YouTubeDownloadItemSnapshot {
  id: string;
  videoId: string;
  sourceUrl: string;
  filename: string | null;
  stage: YouTubeDownloadStage;
  percent: number | null;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  error: string | null;
  /** True only after the completed file has been committed to My Gallery. */
  savedToGallery?: boolean;
  /** Identifies user-requested work from locally scheduled Smart Downloads. */
  origin?: "manual" | "smart";
  /** Present only for Smart Downloads resolved from a canonical channel. */
  smartChannelId?: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface GalleryEntrySnapshot {
  id: string;
  title: string;
  filename: string;
  filePath: string;
  mediaUrl: string;
  thumbnailUrl?: string | null;
  /** Main-process validated local path; renderer access still uses thumbnailUrl. */
  thumbnailPath?: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  /** Container/format label recovered once and cached in the Gallery index. */
  videoFormat?: string | null;
  /** Size of the media file when its technical metadata was last inspected. */
  metadataFileSize?: number | null;
  /** Timestamp of the last completed local metadata inspection. */
  metadataCheckedAt?: number | null;
  fileSize: number;
  downloadedAt: number;
  sourceName: string | null;
  sourceUrl: string | null;
  /** Original publisher title, retained independently from user renames. */
  sourceTitle?: string | null;
  available: boolean;
  managedBy?: "manual" | "smart";
  smartChannelId?: string | null;
  keepForever?: boolean;
  watchedAt?: number | null;
}

export interface GallerySnapshot {
  items: GalleryEntrySnapshot[];
}

export interface GalleryMediaRepairRequest {
  /** Allows the explicit operation to contact YouTube for original artwork. */
  fetchOriginalThumbnails: boolean;
  /** Allows a local ffmpeg installation to generate a frame as a last resort. */
  generateLocalFallbacks: boolean;
}

export interface GalleryMediaRepairResult {
  scanned: number;
  thumbnailsRepaired: number;
  originalThumbnailsFetched: number;
  localFallbacksGenerated: number;
  metadataRecovered: number;
  missingThumbnails: number;
  metadataUnavailable: number;
  errors: Array<{ id: string; message: string }>;
}

export interface YouTubeDownloadsSnapshot {
  available: boolean;
  ytDlpVersion: string;
  items: YouTubeDownloadItemSnapshot[];
}

export type SmartDownloadQuality = "best" | "1080p" | "720p" | "480p" | "audio";
export type SmartDownloadCleanupPolicy = "oldest" | "watched-first" | "pause";
export type SmartDownloadInitialMode = "future" | 1 | 3 | 5;

export interface SmartDownloadsConfigSnapshot {
  enabled: boolean;
  storageQuotaBytes: number;
  quality: SmartDownloadQuality;
  cleanupPolicy: SmartDownloadCleanupPolicy;
  checkIntervalMinutes: 15 | 30 | 60 | 180 | 360 | 720 | 1440;
  includeShorts: boolean;
  includeLivestreamReplays: boolean;
  pauseDuringHeavyActivity: boolean;
  backgroundEnabled: boolean;
  startWithWindows: boolean;
  recommendationsEnabled: boolean;
}

export interface SmartDownloadsChannelSnapshot {
  id: string;
  title: string;
  handle: string | null;
  avatarUrl: string | null;
  enabled: boolean;
  lastCheckedAt: number | null;
  lastSuccessfulCheckAt: number | null;
  nextCheckAt: number | null;
  downloadedCount: number;
  pendingCount: number;
  status: "active" | "paused" | "checking" | "error";
  error: string | null;
}

export interface SmartDownloadsQueueSnapshot {
  id: string;
  videoId: string;
  channelId: string;
  title: string | null;
  state:
    | "pending"
    | "preparing"
    | "downloading"
    | "processing"
    | "completed"
    | "paused"
    | "failed"
    | "cancelled"
    | "skipped";
  attempts: number;
  error: string | null;
  createdAt: number;
}

export interface SmartDownloadsRecommendationSnapshot {
  channelId: string;
  title: string;
  handle: string | null;
  avatarUrl: string | null;
  reason: string;
  score: number;
}

export interface SmartDownloadsCleanupCandidateSnapshot {
  sourceKey: string;
  galleryEntryId: string | null;
  bytes: number;
  watched: boolean;
  downloadedAt: number;
}

export type SmartDownloadsCheckState =
  | "idle"
  | "checking"
  | "completed"
  | "partial"
  | "failed"
  | "blocked";

export interface SmartDownloadsCheckSnapshot {
  state: SmartDownloadsCheckState;
  trigger: "manual" | "scheduled" | null;
  reason: "disabled" | "no-channels" | "no-enabled-channels" | null;
  channelId: string | null;
  totalChannels: number;
  checkedChannels: number;
  newVideosFound: number;
  queuedVideos: number;
  failures: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
}

export interface SmartDownloadsCheckResult extends SmartDownloadsCheckSnapshot {
  state: Exclude<SmartDownloadsCheckState, "idle" | "checking">;
  trigger: "manual" | "scheduled";
  startedAt: number;
  completedAt: number;
}

export type SmartDownloadsOperationalState =
  | "not-configured"
  | "disabled"
  | "paused"
  | "checking"
  | "attention"
  | "active";

export interface SmartDownloadsStatusSnapshot {
  /** Derived from persisted followed channels, never from renderer state. */
  configured: boolean;
  state: SmartDownloadsOperationalState;
  paused: boolean;
  enabledChannelCount: number;
  error: string | null;
}

export interface SmartDownloadsSnapshot {
  config: SmartDownloadsConfigSnapshot;
  storage: {
    quotaBytes: number;
    usedBytes: number;
    availableBytes: number;
    reservedBytes: number;
    diskAvailableBytes: number | null;
    maximumQuotaBytes: number;
    managedDownloadCount: number;
  };
  channels: SmartDownloadsChannelSnapshot[];
  queue: SmartDownloadsQueueSnapshot[];
  recommendations: SmartDownloadsRecommendationSnapshot[];
  cleanupPreview: SmartDownloadsCleanupCandidateSnapshot[];
  queuePaused: boolean;
  checking: boolean;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  backgroundRunning: boolean;
  error: string | null;
  status: SmartDownloadsStatusSnapshot;
  check: SmartDownloadsCheckSnapshot;
}

export type NewTabTheme = "overworld" | "nether" | "end" | "minimal";
export type SearchEngine = "duckduckgo";
export type ToolbarAction = "bookmark" | "find" | "hyperdrive" | "ublock";
export type HyperdriveMode = "off" | "balanced" | "aggressive" | "maximum";
export type HyperdrivePreparationState =
  | "predicted"
  | "queued"
  | "connecting"
  | "prefetching"
  | "prefetched"
  | "preparing-page"
  | "ready"
  | "activated"
  | "blocked"
  | "deduplicated"
  | "cache-reused"
  | "not-reused"
  | "cancelled"
  | "failed"
  | "evicted";

export type HyperdrivePredictionTrigger =
  | "visible-link"
  | "pointer-trajectory"
  | "hover"
  | "history"
  | "site-adapter"
  | "omnibox-typing"
  | "omnibox-autocomplete"
  | "omnibox-selection"
  | "search-suggestion";

export interface BrowserPreferencesSnapshot {
  onboardingComplete: boolean;
  anonymousReportsEnabled: boolean;
  enhancedAnonymousReportsEnabled: boolean;
  restoreSession: boolean;
  sidebarAttached: boolean;
  sidebarOpen: boolean;
  bookmarkBarVisible: boolean;
  newTabTheme: NewTabTheme;
  searchEngine: SearchEngine;
  remoteSearchSuggestionsEnabled: boolean;
  hyperdriveMode: HyperdriveMode;
  hyperdriveRamBudgetMb: number;
  hyperdriveCrossSitePreloadingEnabled: boolean;
  hyperdriveSearchPreloadingEnabled: boolean;
  hyperdriveExcludedHosts: string[];
  hyperdriveMonitorOpen: boolean;
  hyperdriveDeveloperMode: boolean;
  extensionDeveloperMode: boolean;
  hiddenToolbarActions: ToolbarAction[];
  showDownloadProgressInToolbar: boolean;
  showDownloadCompletionNotification: boolean;
  addVideosToGallery: boolean;
  smartReaderProgressVisible?: boolean;
}

export interface HyperdriveDestinationSnapshot {
  id: string;
  title: string;
  displayUrl: string;
  host: string;
  confidence: number;
  trigger: HyperdrivePredictionTrigger;
  state: HyperdrivePreparationState;
  preparation: "none" | "preconnect" | "document-prefetch";
  source: "pointer" | "omnibox";
  adapter: string | null;
  estimatedBytes: number | null;
  elapsedMs: number;
  ready: boolean;
  reused: boolean;
  reuseEvidence: "none" | "navigation-transfer-size-zero";
  reason: string;
}

export interface HyperdriveEventSnapshot {
  id: string;
  timestamp: number;
  state: HyperdrivePreparationState;
  host: string | null;
  message: string;
  warning: boolean;
}

export interface HyperdriveMetricsSnapshot {
  activePredictions: number;
  activePreloads: number;
  preparedDestinations: number;
  cacheReuseSuccesses: number;
  successfulPredictions: number;
  missedPredictions: number;
  cancelledPreloads: number;
  wastedPreparations: number;
  observedSpeculativeBytes: number | null;
  estimatedSpeculativeMemoryBytes: number;
  processPrivateMemoryBytes: number | null;
  navigationTimeSavedMs: number | null;
  rankingTimeMs: number;
  predictionsEvaluated: number;
}

export interface HyperdriveSnapshot {
  status: "off" | "idle" | "predicting" | "memory-pressure";
  mode: HyperdriveMode;
  ramBudgetMb: number;
  availableMemoryMb: number;
  totalMemoryMb: number;
  paused: boolean;
  monitorOpen: boolean;
  warning: string | null;
  metrics: HyperdriveMetricsSnapshot;
  destinations: HyperdriveDestinationSnapshot[];
  events: HyperdriveEventSnapshot[];
}

export interface HyperdriveOmniboxSignal {
  tabId: TabId;
  input: string;
  destination: string | null;
  title: string;
  trigger:
    | "omnibox-typing"
    | "omnibox-autocomplete"
    | "omnibox-selection"
    | "search-suggestion";
  confidence: number;
  search: boolean;
}

export interface UblockSnapshot {
  enabled: boolean;
  initializing: boolean;
  ready: boolean;
  name: string | null;
  version: string | null;
  error: string | null;
}

export type BrowserExtensionStatus =
  | "ready"
  | "disabled"
  | "loading"
  | "incompatible"
  | "error";

export interface BrowserExtensionSnapshot {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  ready: boolean;
  status: BrowserExtensionStatus;
  permissions: string[];
  hostPermissions: string[];
  warnings: string[];
  error: string | null;
  sourceUrl: string | null;
  optionsUrl: string | null;
  popupUrl: string | null;
  iconDataUrl: string | null;
  toolbarPinned: boolean;
  action: {
    kind: "action" | "browserAction" | "pageAction";
    title: string;
    popupUrl: string | null;
    enabled: boolean;
    visible: boolean;
    badgeText: string;
    badgeBackgroundColor: [number, number, number, number];
    badgeTextColor: [number, number, number, number];
    iconUrl: string | null;
  } | null;
}

export interface ExtensionPopupAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtensionsSnapshot {
  initialized: boolean;
  operation: "idle" | "reviewing" | "installing" | "updating" | "removing";
  operationExtensionId: string | null;
  popupExtensionId: string | null;
  error: string | null;
  errorExtensionId: string | null;
  progress: ExtensionOperationProgressSnapshot | null;
  items: BrowserExtensionSnapshot[];
}

export type ExtensionOperationStage =
  | "downloading"
  | "verifying"
  | "preparing"
  | "installing"
  | "finishing"
  | "removing";

export interface ExtensionOperationProgressSnapshot {
  stage: ExtensionOperationStage;
  label: string;
  receivedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
}

export interface ExtensionInstallPreviewSnapshot {
  token: string;
  extensionId: string;
  itemUrl: string;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  hostPermissions: string[];
  warnings: string[];
}

export interface BrowserSnapshot {
  tabs: BrowserTabSnapshot[];
  tabGroups: TabGroupSnapshot[];
  selectedTabIds: TabId[];
  activeTabId: TabId;
  splitView: SplitViewSnapshot;
  ublock: UblockSnapshot;
  preferences: BrowserPreferencesSnapshot;
  baseChromeHeight: number;
  chromeHeight: number;
  webStoreListing: WebStoreListingSnapshot | null;
  youtubeWatch: YouTubeWatchSnapshot | null;
}

export type SitePermissionKey =
  | "camera"
  | "microphone"
  | "location"
  | "notifications"
  | "popups"
  | "clipboard"
  | "autoplay"
  | "downloads"
  | "network"
  | "javascript"
  | "hyperdrive";

export type SitePermissionDecision = "ask" | "allow" | "block";
export type SecureDnsMode = "system" | "automatic" | "secure";

export interface WebsiteControlSnapshot {
  origin: string;
  hostname: string;
  decisions: Record<SitePermissionKey, SitePermissionDecision>;
  /** True when cookies are present; null means other storage could not be measured. */
  hasStoredData: boolean | null;
}

export interface WebsiteControlsSnapshot {
  secureDns: {
    mode: SecureDnsMode;
    providerUrl: string | null;
  };
  /** Only origins with at least one non-default decision are included. */
  sites: WebsiteControlSnapshot[];
  limitations: {
    autoplay: string;
    javascript: string;
  };
}

export interface BookmarkEntry {
  id: string;
  title: string;
  url: string;
  folder: string;
  createdAt: number;
}

export interface SavedArticleEntry {
  id: string;
  canonicalUrl: string;
  originalUrl: string;
  title: string;
  siteName: string;
  faviconDataUrl: string | null;
  description: string | null;
  savedAt: number;
  /** Existing records are migrated to unread when this field is absent. */
  isRead: boolean;
}

export interface SavedArticleOpenResult {
  tabId: TabId;
  readerActive: boolean;
  error: string | null;
}

export interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  visitedAt: number;
  typed: boolean;
}

export interface SearchSuggestionsSnapshot {
  query: string;
  provider: SearchEngine;
  suggestions: string[];
}

export interface ClosedTabEntry {
  id: string;
  title: string;
  url: string;
  closedAt: number;
  pinned: boolean;
  groupId: string | null;
  groupName: string | null;
  groupColor: TabGroupColor | null;
}

export interface SavedTabGroupEntry {
  id: string;
  name: string;
  color: TabGroupColor;
  createdAt: number;
  updatedAt: number;
  tabs: Array<{ title: string; url: string }>;
}

export interface ClosedWindowEntry {
  id: string;
  tabs: Array<{
    id: string;
    title: string;
    url: string;
    isNewTab: boolean;
    pinned: boolean;
    groupId: string | null;
  }>;
  tabGroups: TabGroupSnapshot[];
  activeTabId: string | null;
  closedAt: number;
}

export interface QuickLinkEntry {
  id: string;
  title: string;
  url: string;
  createdAt: number;
}

export interface BrowserDataSnapshot {
  bookmarks: BookmarkEntry[];
  savedArticles?: SavedArticleEntry[];
  history: HistoryEntry[];
  recentlyClosed: ClosedTabEntry[];
  quickLinks: QuickLinkEntry[];
  savedTabGroups: SavedTabGroupEntry[];
  recentlyClosedWindows: ClosedWindowEntry[];
}

export type DownloadState =
  | "progressing"
  | "paused"
  | "completed"
  | "cancelled"
  | "interrupted";

export interface DownloadRecord {
  id: string;
  filename: string;
  sourceUrl: string;
  savePath: string;
  receivedBytes: number;
  totalBytes: number;
  state: DownloadState;
  startedAt: number;
  finishedAt: number | null;
  danger: string | null;
}

export interface DownloadSnapshot {
  items: DownloadRecord[];
}

export interface FindResultSnapshot {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

export interface BookmarkInput {
  title: string;
  url: string;
  folder?: string;
}

export interface QuickLinkInput {
  title: string;
  url: string;
}

export interface ChromecraftApi {
  getSnapshot(): Promise<BrowserSnapshot>;
  createTab(input?: string): Promise<TabId>;
  activateTab(tabId: TabId): Promise<void>;
  closeTab(tabId: TabId): Promise<void>;
  updateSplitView(command: SplitViewCommand): Promise<void>;
  navigate(tabId: TabId, input: string, typed?: boolean): Promise<void>;
  goBack(tabId: TabId): Promise<void>;
  goForward(tabId: TabId): Promise<void>;
  reload(tabId: TabId): Promise<void>;
  stop(tabId: TabId): Promise<void>;
  getSmartReader(tabId: TabId): Promise<SmartReaderViewSnapshot>;
  toggleSmartReader(
    tabId: TabId,
    appearance: SmartReaderAppearance,
  ): Promise<SmartReaderViewSnapshot>;
  trySmartReader(
    tabId: TabId,
    appearance: SmartReaderAppearance,
  ): Promise<SmartReaderViewSnapshot>;
  setSmartReaderAppearance(
    tabId: TabId,
    appearance: SmartReaderAppearance,
  ): Promise<SmartReaderViewSnapshot>;
  toggleSavedArticle(tabId: TabId): Promise<SmartReaderViewSnapshot>;
  removeSavedArticle(id: string): Promise<void>;
  setSavedArticleRead(id: string, isRead: boolean): Promise<void>;
  copySavedArticleLink(id: string): Promise<void>;
  openSavedArticle(
    id: string,
    appearance: SmartReaderAppearance,
  ): Promise<SavedArticleOpenResult>;
  setSmartReaderProgressVisible(
    tabId: TabId,
    visible: boolean,
  ): Promise<SmartReaderViewSnapshot>;
  runSmartReaderCommand(
    tabId: TabId,
    command: SmartReaderCommand,
  ): Promise<void>;
  getSmartReaderArticleAttachment(tabId: TabId): Promise<AssistantAttachment>;
  onSmartReaderOpenScout(listener: (tabId: TabId) => void): () => void;
  duplicateTab(tabId: TabId): Promise<TabId>;
  reopenClosedTab(id?: string): Promise<TabId | null>;
  createTabGroup(
    tabIds: TabId[],
    name?: string,
    color?: TabGroupColor,
  ): Promise<string>;
  updateTabGroup(groupId: string, update: TabGroupUpdate): Promise<void>;
  deleteTabGroup(groupId: string, closeTabs?: boolean): Promise<void>;
  restoreSavedTabGroup(groupId: string): Promise<TabId[]>;
  removeSavedTabGroup(groupId: string): Promise<void>;
  selectTabs(tabIds: TabId[], mode: TabSelectionMode): Promise<void>;
  moveTabs(
    tabIds: TabId[],
    targetIndex: number,
    groupId?: string | null,
  ): Promise<void>;
  closeTabs(tabIds: TabId[]): Promise<void>;
  setTabsPinned(tabIds: TabId[], pinned: boolean): Promise<void>;
  searchTabs(query: string): Promise<TabSearchResult[]>;
  reopenClosedWindow(id?: string): Promise<TabId[]>;
  toggleMute(tabId: TabId): Promise<void>;
  setZoom(tabId: TabId, factor: number): Promise<void>;
  findInPage(tabId: TabId, text: string, forward: boolean): Promise<void>;
  stopFindInPage(tabId: TabId): Promise<void>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  openPerformanceCentre(): Promise<void>;
  setChromeOverlayOpen(open: boolean): Promise<void>;
  setSidebarAttached(attached: boolean): Promise<void>;
  setSidebarOpen(open: boolean): Promise<void>;
  setBookmarkBarVisible(visible: boolean): Promise<void>;
  setRestoreSession(enabled: boolean): Promise<void>;
  setNewTabTheme(theme: NewTabTheme): Promise<void>;
  setRemoteSearchSuggestionsEnabled(enabled: boolean): Promise<void>;
  getSearchSuggestions(query: string): Promise<SearchSuggestionsSnapshot>;
  getWebsiteControls(): Promise<WebsiteControlsSnapshot>;
  getWebsiteControl(originOrUrl: string): Promise<WebsiteControlSnapshot>;
  setWebsitePermission(
    originOrUrl: string,
    key: SitePermissionKey,
    decision: SitePermissionDecision,
  ): Promise<void>;
  resetWebsitePermissions(originOrUrl: string): Promise<void>;
  clearWebsiteData(originOrUrl: string): Promise<void>;
  setSecureDns(mode: SecureDnsMode, providerUrl?: string): Promise<void>;
  getHyperdriveSnapshot(): Promise<HyperdriveSnapshot>;
  setHyperdriveMode(mode: HyperdriveMode): Promise<void>;
  setHyperdriveRamBudgetMb(megabytes: number): Promise<void>;
  setHyperdriveCrossSitePreloadingEnabled(enabled: boolean): Promise<void>;
  setHyperdriveSearchPreloadingEnabled(enabled: boolean): Promise<void>;
  setHyperdriveExcludedHosts(hosts: string[]): Promise<void>;
  setHyperdriveMonitorOpen(open: boolean): Promise<void>;
  setHyperdriveDeveloperMode(enabled: boolean): Promise<void>;
  setHyperdriveMonitorPaused(paused: boolean): Promise<void>;
  clearHyperdriveSpeculation(): Promise<void>;
  clearHyperdriveEvents(): Promise<void>;
  updateHyperdriveOmnibox(signal: HyperdriveOmniboxSignal): void;
  setUblockEnabled(enabled: boolean): Promise<void>;
  openUblockDashboard(): Promise<void>;
  getExtensions(): Promise<ExtensionsSnapshot>;
  installExtensionFromWebStore(itemUrl: string): Promise<void>;
  prepareExtensionFromWebStore(
    itemUrl: string,
  ): Promise<ExtensionInstallPreviewSnapshot>;
  commitPreparedExtension(token: string): Promise<void>;
  cancelPreparedExtension(token: string): Promise<void>;
  dismissWebStoreInstallBanner(
    tabId: TabId,
    extensionId: string,
  ): Promise<void>;
  setExtensionEnabled(id: string, enabled: boolean): Promise<void>;
  setExtensionToolbarPinned(id: string, pinned: boolean): Promise<void>;
  setExtensionDeveloperMode(enabled: boolean): Promise<void>;
  setToolbarActionPinned(action: ToolbarAction, pinned: boolean): Promise<void>;
  importUnpackedExtension(): Promise<boolean>;
  removeExtension(id: string): Promise<void>;
  openExtensionPage(id: string, page: "options"): Promise<void>;
  toggleExtensionPopup(id: string, anchor: ExtensionPopupAnchor): Promise<void>;
  closeExtensionPopup(): Promise<void>;
  getBrowserData(): Promise<BrowserDataSnapshot>;
  addBookmark(input: BookmarkInput): Promise<void>;
  removeBookmark(id: string): Promise<void>;
  importBookmarks(): Promise<number>;
  exportBookmarks(): Promise<boolean>;
  removeHistory(id: string): Promise<void>;
  clearHistory(range?: "hour" | "day" | "week" | "all"): Promise<void>;
  addQuickLink(input: QuickLinkInput): Promise<void>;
  removeQuickLink(id: string): Promise<void>;
  getDownloads(): Promise<DownloadSnapshot>;
  getYouTubeDownloads(): Promise<YouTubeDownloadsSnapshot>;
  getSmartDownloads(): Promise<SmartDownloadsSnapshot>;
  setSmartDownloadsEnabled(enabled: boolean): Promise<void>;
  setSmartDownloadsQuotaBytes(bytes: number): Promise<void>;
  setSmartDownloadsQuality(quality: SmartDownloadQuality): Promise<void>;
  setSmartDownloadsCleanupPolicy(
    policy: SmartDownloadCleanupPolicy,
  ): Promise<void>;
  setSmartDownloadsCheckInterval(minutes: number): Promise<void>;
  setSmartDownloadsIncludeShorts(enabled: boolean): Promise<void>;
  setSmartDownloadsIncludeLivestreamReplays(enabled: boolean): Promise<void>;
  setSmartDownloadsPauseDuringHeavyActivity(enabled: boolean): Promise<void>;
  setSmartDownloadsBackgroundEnabled(enabled: boolean): Promise<void>;
  setSmartDownloadsStartWithWindows(enabled: boolean): Promise<void>;
  setSmartDownloadsRecommendationsEnabled(enabled: boolean): Promise<void>;
  addSmartDownloadsChannel(
    input: string,
    initialMode: SmartDownloadInitialMode,
  ): Promise<void>;
  setSmartDownloadsChannelEnabled(id: string, enabled: boolean): Promise<void>;
  checkSmartDownloads(channelId?: string): Promise<SmartDownloadsCheckResult>;
  removeSmartDownloadsChannel(id: string): Promise<void>;
  pauseSmartDownloadsQueue(): Promise<void>;
  resumeSmartDownloadsQueue(): Promise<void>;
  retrySmartDownloadJob(id: string): Promise<void>;
  cancelSmartDownloadJob(id: string): Promise<void>;
  dismissSmartDownloadsRecommendation(channelId: string): Promise<void>;
  clearSmartDownloadsRecommendationHistory(): Promise<void>;
  downloadActiveYouTubeVideo(tabId: TabId): Promise<string>;
  cancelYouTubeDownload(id: string): Promise<void>;
  retryYouTubeDownload(id: string): Promise<string>;
  openYouTubeDownload(id: string): Promise<void>;
  dismissYouTubeDownload(id: string): Promise<void>;
  dismissYouTubeDownloadBanner(tabId: TabId, videoId: string): Promise<void>;
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  retryDownload(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  openDownload(id: string): Promise<void>;
  showDownloadInFolder(id: string): Promise<void>;
  removeDownload(id: string): Promise<void>;
  clearFinishedDownloads(): Promise<void>;
  getGallery(): Promise<GallerySnapshot>;
  openGallery(entryId?: string, forceNew?: boolean): Promise<TabId>;
  openGalleryFile(id: string): Promise<void>;
  showGalleryFile(id: string): Promise<void>;
  copyGalleryPath(id: string): Promise<void>;
  copyGallerySourceUrl(id: string): Promise<void>;
  renameGalleryItem(id: string, title: string): Promise<void>;
  removeGalleryItem(id: string): Promise<void>;
  deleteGalleryItem(id: string): Promise<void>;
  deleteAllGalleryItems(): Promise<void>;
  importGalleryDownloads(): Promise<number>;
  updateGalleryMediaMetadata(
    id: string,
    durationSeconds: number,
    width: number,
    height: number,
  ): Promise<void>;
  repairGalleryMedia(
    request: GalleryMediaRepairRequest,
  ): Promise<GalleryMediaRepairResult>;
  setSmartDownloadKeepForever(id: string, keepForever: boolean): Promise<void>;
  markGalleryItemWatched(id: string): Promise<void>;
  getOfflinePages(): Promise<OfflinePagesSnapshot>;
  savePageForOffline(tabId: TabId): Promise<OfflinePageEntrySnapshot>;
  openOfflinePages(entryId?: string, forceNew?: boolean): Promise<TabId>;
  openOfflinePage(id: string): Promise<TabId>;
  deleteOfflinePage(id: string): Promise<void>;
  setShowDownloadProgressInToolbar(enabled: boolean): Promise<void>;
  setShowDownloadCompletionNotification(enabled: boolean): Promise<void>;
  setAddVideosToGallery(enabled: boolean): Promise<void>;
  getUpdateSnapshot(): Promise<UpdateSnapshot>;
  checkForUpdates(): Promise<UpdateSnapshot>;
  updateAllExtensions(): Promise<UpdateSnapshot>;
  updateExtension(extensionId: string): Promise<UpdateSnapshot>;
  setUpdatePreferences(
    preferences: Partial<UpdatePreferences>,
  ): Promise<UpdateSnapshot>;
  restartToUpdate(): Promise<void>;
  getAiTools(): Promise<AiToolsSnapshot>;
  refreshAiModels(provider?: AiProviderId): Promise<AiToolsSnapshot>;
  installRecommendedOllamaModel(): Promise<AiToolsSnapshot>;
  setAiProvider(provider: AiProviderId): Promise<AiToolsSnapshot>;
  setAiOrganiserProvider(provider: AiProviderId): Promise<AiToolsSnapshot>;
  setAiGroupingMode(mode: AiGroupingMode): Promise<AiToolsSnapshot>;
  setAiModel(provider: AiProviderId, model: string): Promise<AiToolsSnapshot>;
  setAiOrganiserModel(
    provider: AiProviderId,
    model: string,
  ): Promise<AiToolsSnapshot>;
  setGeminiApiKey(update: GeminiApiKeyUpdate): Promise<AiToolsSnapshot>;
  removeGeminiApiKey(): Promise<AiToolsSnapshot>;
  startOnboardingGeminiSetup(): Promise<GeminiClipboardDetectionSnapshot>;
  setOnboardingGeminiViewBounds(bounds: OnboardingViewBounds): Promise<void>;
  stopOnboardingGeminiSetup(): Promise<void>;
  openOnboardingGeminiSetupExternal(): Promise<void>;
  commitOnboardingGeminiClipboardKey(
    request: CommitOnboardingGeminiKeyRequest,
  ): Promise<AiToolsSnapshot>;
  startOnboardingLocalAi(): Promise<OnboardingLocalAiSnapshot>;
  installOnboardingOllama(): Promise<OnboardingLocalAiSnapshot>;
  installOnboardingOllamaModel(
    model: OnboardingOllamaModel,
  ): Promise<OnboardingLocalAiSnapshot>;
  completeOnboarding(settings: OnboardingRecommendedSettings): Promise<void>;
  checkOnboardingUpdate(): Promise<UpdateSnapshot>;
  previewAiTool(request: OrganiseTabsRequest): Promise<OrganiseTabsProposal>;
  applyAiTool(proposal: OrganiseTabsProposal): Promise<AiToolApplyResult>;
  cancelAiTool(): Promise<void>;
  undoAiTool(): Promise<AiToolApplyResult>;
  getAssistantPageContext(tabId: TabId): Promise<AssistantPageContext>;
  startAssistantSelection(kind: "screenshot" | "element"): Promise<void>;
  cancelAssistantSelection(): Promise<void>;
  sendAssistantMessage(
    request: AssistantMessageRequest,
  ): Promise<AssistantMessageResponse>;
  cancelAssistantMessage(messageId: string): Promise<void>;
  getScoutAgent(): Promise<ScoutAgentSnapshot>;
  startScoutAgent(request: AgentRunStartRequest): Promise<AgentRunSnapshot>;
  commandScoutAgent(command: AgentRunCommand): Promise<void>;
  onSnapshot(listener: (snapshot: BrowserSnapshot) => void): () => void;
  onBrowserData(listener: (snapshot: BrowserDataSnapshot) => void): () => void;
  onDownloads(listener: (snapshot: DownloadSnapshot) => void): () => void;
  onYouTubeDownloads(
    listener: (snapshot: YouTubeDownloadsSnapshot) => void,
  ): () => void;
  onSmartDownloads(
    listener: (snapshot: SmartDownloadsSnapshot) => void,
  ): () => void;
  onShowSmartDownloadsSettings(listener: () => void): () => void;
  onGallery(listener: (snapshot: GallerySnapshot) => void): () => void;
  onOfflinePages(
    listener: (snapshot: OfflinePagesSnapshot) => void,
  ): () => void;
  onFindResult(listener: (snapshot: FindResultSnapshot) => void): () => void;
  onShowFind(listener: () => void): () => void;
  onOpenCommandPalette(listener: () => void): () => void;
  onFocusOmnibox(listener: () => void): () => void;
  onWebsiteControls(
    listener: (snapshot: WebsiteControlsSnapshot) => void,
  ): () => void;
  onHyperdriveSnapshot(
    listener: (snapshot: HyperdriveSnapshot) => void,
  ): () => void;
  onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void;
  onUpdateSnapshot(listener: (snapshot: UpdateSnapshot) => void): () => void;
  onAiTools(listener: (snapshot: AiToolsSnapshot) => void): () => void;
  onOnboardingGeminiClipboard(
    listener: (snapshot: GeminiClipboardDetectionSnapshot) => void,
  ): () => void;
  onOnboardingLocalAi(
    listener: (snapshot: OnboardingLocalAiSnapshot) => void,
  ): () => void;
  onScoutAgent(listener: (snapshot: ScoutAgentSnapshot) => void): () => void;
  onShowScoutSettings(listener: () => void): () => void;
  onAssistantContextCaptured(
    listener: (context: AssistantContextCaptured) => void,
  ): () => void;
}
