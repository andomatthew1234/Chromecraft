import type { UpdateSnapshot } from "./updates";

export type TabId = string;

export interface BrowserTabSnapshot {
  id: TabId;
  title: string;
  url: string;
  isNewTab: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  error: string | null;
  isMuted: boolean;
  zoomFactor: number;
}

export interface WebStoreListingSnapshot {
  extensionId: string;
  itemUrl: string;
  title: string;
  description: string | null;
}

export type NewTabTheme = "overworld" | "nether" | "end" | "minimal";
export type SearchEngine = "duckduckgo";
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
  activeTabId: TabId;
  ublock: UblockSnapshot;
  preferences: BrowserPreferencesSnapshot;
  baseChromeHeight: number;
  chromeHeight: number;
  webStoreListing: WebStoreListingSnapshot | null;
}

export interface BookmarkEntry {
  id: string;
  title: string;
  url: string;
  folder: string;
  createdAt: number;
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
}

export interface QuickLinkEntry {
  id: string;
  title: string;
  url: string;
  createdAt: number;
}

export interface BrowserDataSnapshot {
  bookmarks: BookmarkEntry[];
  history: HistoryEntry[];
  recentlyClosed: ClosedTabEntry[];
  quickLinks: QuickLinkEntry[];
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
  navigate(tabId: TabId, input: string, typed?: boolean): Promise<void>;
  goBack(tabId: TabId): Promise<void>;
  goForward(tabId: TabId): Promise<void>;
  reload(tabId: TabId): Promise<void>;
  stop(tabId: TabId): Promise<void>;
  duplicateTab(tabId: TabId): Promise<TabId>;
  reopenClosedTab(): Promise<TabId | null>;
  toggleMute(tabId: TabId): Promise<void>;
  setZoom(tabId: TabId, factor: number): Promise<void>;
  findInPage(tabId: TabId, text: string, forward: boolean): Promise<void>;
  stopFindInPage(tabId: TabId): Promise<void>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  setChromeOverlayOpen(open: boolean): Promise<void>;
  setSidebarAttached(attached: boolean): Promise<void>;
  setSidebarOpen(open: boolean): Promise<void>;
  setBookmarkBarVisible(visible: boolean): Promise<void>;
  setRestoreSession(enabled: boolean): Promise<void>;
  setNewTabTheme(theme: NewTabTheme): Promise<void>;
  setRemoteSearchSuggestionsEnabled(enabled: boolean): Promise<void>;
  getSearchSuggestions(query: string): Promise<SearchSuggestionsSnapshot>;
  getHyperdriveSnapshot(): Promise<HyperdriveSnapshot>;
  setHyperdriveMode(mode: HyperdriveMode): Promise<void>;
  setHyperdriveRamBudgetMb(megabytes: number): Promise<void>;
  setHyperdriveCrossSitePreloadingEnabled(enabled: boolean): Promise<void>;
  setHyperdriveSearchPreloadingEnabled(enabled: boolean): Promise<void>;
  setHyperdriveExcludedHosts(hosts: string[]): Promise<void>;
  setHyperdriveMonitorOpen(open: boolean): Promise<void>;
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
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  retryDownload(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  openDownload(id: string): Promise<void>;
  showDownloadInFolder(id: string): Promise<void>;
  removeDownload(id: string): Promise<void>;
  clearFinishedDownloads(): Promise<void>;
  getUpdateSnapshot(): Promise<UpdateSnapshot>;
  checkForUpdates(): Promise<UpdateSnapshot>;
  restartToUpdate(): Promise<void>;
  onSnapshot(listener: (snapshot: BrowserSnapshot) => void): () => void;
  onBrowserData(listener: (snapshot: BrowserDataSnapshot) => void): () => void;
  onDownloads(listener: (snapshot: DownloadSnapshot) => void): () => void;
  onFindResult(listener: (snapshot: FindResultSnapshot) => void): () => void;
  onShowFind(listener: () => void): () => void;
  onOpenCommandPalette(listener: () => void): () => void;
  onFocusOmnibox(listener: () => void): () => void;
  onHyperdriveSnapshot(
    listener: (snapshot: HyperdriveSnapshot) => void,
  ): () => void;
  onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void;
  onUpdateSnapshot(listener: (snapshot: UpdateSnapshot) => void): () => void;
}
