import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  type BrowserWindowConstructorOptions,
  type NativeImage,
  type Session,
  type WebContents,
  WebContentsView,
} from "electron";

import type {
  BrowserSnapshot,
  BrowserTabSnapshot,
  ExtensionPopupAnchor,
  FindResultSnapshot,
  HyperdriveMode,
  HyperdriveOmniboxSignal,
  HyperdriveSnapshot,
  NewTabTheme,
  SavedArticleOpenResult,
  SplitViewCommand,
  TabGroupColor,
  TabGroupSnapshot,
  TabGroupUpdate,
  TabId,
  TabSearchResult,
  TabSelectionMode,
  ToolbarAction,
  WebStoreListingSnapshot,
  YouTubeWatchSnapshot,
} from "../shared/browser";
import type {
  SmartReaderAppearance,
  SmartReaderArticle,
  SmartReaderCommand,
  SmartReaderExtractionResult,
  SmartReaderGeminiSegment,
  SmartReaderGeminiSession,
  SmartReaderNarrationCapabilities,
  SmartReaderSummaryGenerateRequest,
  SmartReaderSummaryResult,
  SmartReaderSummarySnapshot,
  SmartReaderTabSnapshot,
  SmartReaderViewSnapshot,
} from "../shared/smart-reader";
import { normalizeSmartReaderAppearance } from "../shared/smart-reader";
import { faviconLimits, resolveFaviconDataUrl } from "./favicon";
import type {
  AssistantAttachment,
  AssistantContextCaptured,
  AssistantElementContext,
  AssistantPageContext,
} from "../shared/ai-assistant";
import { channels } from "../shared/channels";
import {
  isAllowedWebUrl,
  isNavigationInputAddress,
  resolveNavigationInput,
} from "../shared/navigation";
import { parseChromeWebStoreListingUrl } from "../shared/web-store-listing";
import { parseYouTubeWatchUrl } from "../shared/youtube-watch";
import { sidebarWidth } from "../shared/sidebar";
import { BrowserDataStore, type SessionTabInput } from "./browser-data";
import { ReadingPositionStore } from "./reading-position-store";
import { ChromeWebStoreExtensionService } from "./chrome-web-store-extension-service";
import { ExtensionPopupController } from "./extension-popup-controller";
import { FullscreenHintController } from "./fullscreen-hint-controller";
import { HyperdriveController } from "./hyperdrive/controller";
import {
  buildPageContextMenu,
  buildTextContextMenu,
} from "./page-context-menu";
import { PreferencesStore } from "./preferences";
import { SplitViewState } from "./split-view-state";
import {
  renderSmartReaderDocument,
  SmartReaderDocumentStore,
} from "./smart-reader-protocol";
import { UblockService } from "./ublock-service";
import type { OfflinePageCaptureSource } from "./offline-page-store";
import type { ActiveWebsitePermissionContext } from "./website-permission-controller";
import type { PerformanceTabTask } from "../shared/performance-centre";

export const SHELL_HEIGHT = 104;
export const BOOKMARK_BAR_HEIGHT = 32;
export const EXTENSION_INSTALL_BANNER_HEIGHT = 88;
export const YOUTUBE_DOWNLOAD_BANNER_HEIGHT = 48;
export const YOUTUBE_GLOBAL_PROGRESS_HEIGHT = 34;
export const HYPERDRIVE_MONITOR_WIDTH = 372;
const ASSISTANT_TEXT_LIMIT = 2_000;
const ASSISTANT_DESCRIPTION_LIMIT = 600;
const ASSISTANT_SCREENSHOT_LIMIT = 1_500_000;
const SESSION_WRITE_DELAY_MS = 300;
const SAVED_ARTICLE_READER_DEADLINE_MS = 20_000;
const EXTENSION_WINDOW_NAME_PREFIX = "__chromecraft_extension_window_";
const ZOOM_FACTORS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
  5,
];

export function isWebsiteFullscreenPermissionAllowed(
  permission: string,
  topLevelUrl: string,
): boolean {
  return permission === "fullscreen" && isAllowedWebUrl(topLevelUrl);
}

function cleanAssistantText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned.slice(0, maximum) : null;
}

function cleanAssistantUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.length <= 2_048 ? url.href : null;
  } catch {
    return null;
  }
}

function displayAssistantUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.slice(0, 240);
  } catch {
    return "Current page";
  }
}

function cleanAssistantElement(value: unknown): AssistantElementContext | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const tag = cleanAssistantText(source.tag, 40)?.toLowerCase();
  if (!tag || !/^[a-z][a-z0-9-]*$/u.test(tag)) return null;
  const text = cleanAssistantText(source.text, 800);
  const label = cleanAssistantText(source.label, 240);
  const role = cleanAssistantText(source.role, 80);
  const alt = cleanAssistantText(source.alt, 240);
  const placeholder = cleanAssistantText(source.placeholder, 240);
  const type = cleanAssistantText(source.type, 80);
  const href = cleanAssistantUrl(source.href);
  const markup = cleanAssistantText(source.markup, 1_200);
  if (!markup) return null;
  return { tag, role, label, text, href, alt, placeholder, type, markup };
}

interface TabRecord {
  id: TabId;
  title: string;
  url: string;
  faviconDataUrl: string | null;
  requestedUrl: string;
  isNewTab: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  error: string | null;
  isMuted: boolean;
  zoomFactor: number;
  pinned: boolean;
  view: WebContentsView | null;
  lastHistoryUrl: string;
  lastFindText: string;
  findRequestId: number;
  nextHistoryEntryTyped: boolean;
  documentEpoch: number;
  dismissedWebStoreExtensionId: string | null;
  dismissedYouTubeVideoId: string | null;
  webStoreListingTitle: string | null;
  webStoreListingDescription: string | null;
  groupId: string | null;
  thumbnailDataUrl: string | null;
  reader: SmartReaderTabSnapshot;
  readerView: WebContentsView | null;
  readerDocumentUrl: string | null;
  readerPendingRequestId: string | null;
  readerError: string | null;
  readerAppearanceCssKey: string | null;
  readerAppearanceRevision: number;
  readerMutationTimer: ReturnType<typeof setTimeout> | null;
  readerTimers: Set<ReturnType<typeof setTimeout>>;
  readerProgressTimer: ReturnType<typeof setTimeout> | null;
  readerProgressValue: number | null;
  readerArticle: SmartReaderArticle | null;
  readerSummary: {
    stage: SmartReaderSummarySnapshot["stage"];
    requestId: string | null;
    result: SmartReaderSummaryResult | null;
    error: string | null;
  };
}

interface PendingReaderExtraction {
  tabId: TabId;
  revision: number;
  resolve: (snapshot: SmartReaderViewSnapshot) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingSavedArticleReader {
  appearance: SmartReaderAppearance;
  expectedRevision: number | null;
  loadComplete: boolean;
  extracting: boolean;
  retryRequested: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: SavedArticleOpenResult) => void;
}

export interface SmartReaderSummaryBridge {
  configuration(): Pick<
    SmartReaderSummarySnapshot,
    "provider" | "model" | "providers"
  >;
  refresh(provider: "ollama" | "gemini"): Promise<void>;
  setPreference(
    provider: "ollama" | "gemini",
    model: string | null,
  ): Promise<void>;
  setConsent(granted: boolean): Promise<void>;
  generate(
    requestId: string,
    article: SmartReaderArticle,
    request: SmartReaderSummaryGenerateRequest,
  ): Promise<SmartReaderSummaryResult>;
  cancel(requestId: string): void;
}

export interface SmartReaderNarrationBridge {
  capabilities(): SmartReaderNarrationCapabilities;
  synthesize(
    requestId: string,
    text: string,
    voice: string,
  ): Promise<{ mimeType: string; data: string }>;
  cancel(requestId: string): void;
}

interface SmartReaderNarrationSessionRecord {
  id: string;
  tabId: string;
  revision: number;
  voice: string;
  segments: string[];
  activeRequestId: string | null;
}

export function splitNarrationText(text: string, maximum = 4_500): string[] {
  const paragraphs = text
    .replace(/\r\n?/gu, "\n")
    .split(/\n{2,}/u)
    .map((part) => part.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const result: string[] = [];
  let current = "";
  const append = (piece: string) => {
    if (!piece) return;
    if (current && current.length + piece.length + 2 > maximum) {
      result.push(current);
      current = "";
    }
    if (piece.length <= maximum) {
      current = current ? `${current}\n\n${piece}` : piece;
      return;
    }
    for (const sentence of piece.split(/(?<=[.!?])\s+/u)) {
      if (sentence.length > maximum) {
        if (current) result.push(current);
        current = "";
        for (let offset = 0; offset < sentence.length; offset += maximum) {
          result.push(sentence.slice(offset, offset + maximum));
        }
      } else {
        append(sentence);
      }
    }
  };
  for (const paragraph of paragraphs) append(paragraph);
  if (current) result.push(current);
  return result;
}

export interface AiTabOrganizationCandidate {
  id: TabId;
  title: string;
  hostname: string;
  pathHint: string;
}

export interface AiTabOrganizationContext {
  revision: string;
  candidates: AiTabOrganizationCandidate[];
  preservedTabIds: TabId[];
}

export interface AiTabOrganizationPlan {
  revision: string;
  groups: Array<{
    name: string;
    color: TabGroupColor;
    tabIds: TabId[];
  }>;
  ungroupedTabIds: TabId[];
}

export interface AppliedAiTabOrganization {
  undoToken: string;
  organisedTabCount: number;
  groupCount: number;
}

export class AiTabOrganizationUndoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiTabOrganizationUndoUnavailableError";
  }
}

interface TabOrganizationTopology {
  order: TabId[];
  groupIds: Map<TabId, string | null>;
  pinned: Map<TabId, boolean>;
  groups: Map<string, TabGroupSnapshot>;
}

interface AiTabOrganizationUndo {
  token: string;
  before: TabOrganizationTopology;
  afterRevision: string;
  organisedTabCount: number;
  groupCount: number;
}

class TabTopologyBusyError extends Error {}

export type ExtensionTabStatus = "loading" | "complete";

export interface ExtensionTabSnapshot {
  id: number;
  active: boolean;
  title: string;
  url: string;
  status: ExtensionTabStatus;
}

export type ExtensionTabChange = Partial<
  Pick<ExtensionTabSnapshot, "title" | "url" | "status">
>;

export type ExtensionTabTransition =
  | { type: "created"; tab: ExtensionTabSnapshot }
  | {
      type: "activated";
      tabId: number;
      previousTabId: number | null;
    }
  | {
      type: "updated";
      tabId: number;
      change: ExtensionTabChange;
      tab: ExtensionTabSnapshot;
    }
  | {
      type: "removed";
      tabId: number;
      wasActive: boolean;
    };

export type ExtensionTabTransitionListener = (
  transition: ExtensionTabTransition,
) => void;

/**
 * Owns the process-local identity and ordered transition stream exposed to the
 * extension host. Browser tab UUIDs remain an implementation detail.
 */
export class ExtensionTabLifecycle {
  private readonly tabsByBrowserId = new Map<TabId, ExtensionTabSnapshot>();
  private readonly tabsByExtensionId = new Map<number, ExtensionTabSnapshot>();
  private readonly listeners = new Set<ExtensionTabTransitionListener>();
  private activeId: number | null = null;
  private activeBrowserTabId: TabId | null = null;

  get snapshots(): ExtensionTabSnapshot[] {
    return [...this.tabsByBrowserId.values()].map(cloneExtensionTab);
  }

  get(extensionTabId: number): ExtensionTabSnapshot | null {
    const tab = this.tabsByExtensionId.get(extensionTabId);
    return tab ? cloneExtensionTab(tab) : null;
  }

  idForBrowserTab(browserTabId: TabId): number | null {
    return this.tabsByBrowserId.get(browserTabId)?.id ?? null;
  }

  subscribe(listener: ExtensionTabTransitionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(
    browserTabId: TabId,
    nativeWebContentsId: number,
    initial: Pick<ExtensionTabSnapshot, "title" | "url" | "status">,
  ): ExtensionTabSnapshot {
    const existing = this.tabsByBrowserId.get(browserTabId);
    if (existing) {
      if (existing.id !== nativeWebContentsId) {
        throw new Error("A browser tab cannot own multiple extension targets.");
      }
      return cloneExtensionTab(existing);
    }
    if (!Number.isSafeInteger(nativeWebContentsId) || nativeWebContentsId < 1) {
      throw new Error("Extension tab identifiers must be positive integers.");
    }
    if (this.tabsByExtensionId.has(nativeWebContentsId)) {
      throw new Error("An extension tab identifier is already attached.");
    }
    const tab: ExtensionTabSnapshot = {
      id: nativeWebContentsId,
      active: false,
      ...initial,
    };
    this.tabsByBrowserId.set(browserTabId, tab);
    this.tabsByExtensionId.set(tab.id, tab);
    this.emit({ type: "created", tab: cloneExtensionTab(tab) });
    if (this.activeBrowserTabId === browserTabId) this.activate(browserTabId);
    return cloneExtensionTab(tab);
  }

  activate(browserTabId: TabId): void {
    this.activeBrowserTabId = browserTabId;
    const tab = this.tabsByBrowserId.get(browserTabId);
    if (tab?.id === this.activeId) return;
    const previousTabId = this.activeId;
    if (previousTabId !== null) {
      const previous = this.tabsByExtensionId.get(previousTabId);
      if (previous) previous.active = false;
    }
    this.activeId = null;
    if (!tab) return;
    tab.active = true;
    this.activeId = tab.id;
    this.emit({ type: "activated", tabId: tab.id, previousTabId });
  }

  update(browserTabId: TabId, requested: ExtensionTabChange): void {
    const tab = this.tabsByBrowserId.get(browserTabId);
    if (!tab) return;
    const change: ExtensionTabChange = {};
    for (const key of ["title", "url", "status"] as const) {
      const value = requested[key];
      if (value !== undefined && value !== tab[key]) {
        Object.assign(change, { [key]: value });
        Object.assign(tab, { [key]: value });
      }
    }
    if (Object.keys(change).length === 0) return;
    this.emit({
      type: "updated",
      tabId: tab.id,
      change: { ...change },
      tab: cloneExtensionTab(tab),
    });
  }

  remove(browserTabId: TabId, expectedNativeId?: number): void {
    const tab = this.tabsByBrowserId.get(browserTabId);
    if (!tab) return;
    if (expectedNativeId !== undefined && tab.id !== expectedNativeId) return;
    this.tabsByBrowserId.delete(browserTabId);
    this.tabsByExtensionId.delete(tab.id);
    const wasActive = this.activeId === tab.id;
    if (wasActive) this.activeId = null;
    if (this.activeBrowserTabId === browserTabId)
      this.activeBrowserTabId = null;
    this.emit({ type: "removed", tabId: tab.id, wasActive });
  }

  dispose(): void {
    this.tabsByBrowserId.clear();
    this.tabsByExtensionId.clear();
    this.listeners.clear();
    this.activeId = null;
    this.activeBrowserTabId = null;
  }

  private emit(transition: ExtensionTabTransition): void {
    for (const listener of this.listeners) {
      try {
        listener(transition);
      } catch (error) {
        console.warn("Extension tab transition listener failed.", error);
      }
    }
  }
}

function cloneExtensionTab(tab: ExtensionTabSnapshot): ExtensionTabSnapshot {
  return { ...tab };
}

export class TabManager {
  private youtubeDownloadIndicatorVisible = false;
  private readonly tabs = new Map<TabId, TabRecord>();
  private readonly order: TabId[] = [];
  private readonly tabGroups = new Map<string, TabGroupSnapshot>();
  private readonly splitView = new SplitViewState();
  private readonly pendingReaderExtractions = new Map<
    string,
    PendingReaderExtraction
  >();
  private readonly pendingSavedArticleReaders = new Map<
    TabId,
    PendingSavedArticleReader
  >();
  private readonly readerNarrationSessions = new Map<
    string,
    SmartReaderNarrationSessionRecord
  >();
  private readonly selectedTabIds = new Set<TabId>();
  private aiTabOrganizationUndo: AiTabOrganizationUndo | null = null;
  private aiTabOrganizationMutationInProgress = false;
  private tabTopologyMutationOperations = 0;
  private selectionAnchorId: TabId | null = null;
  private readonly extensionTabs = new ExtensionTabLifecycle();
  private activeTabId = "";
  private disposed = false;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly extensionPopup: ExtensionPopupController | null;
  private readonly extensionWindows = new Set<BrowserWindow>();
  private readonly fullscreenHint: FullscreenHintController;
  private htmlFullscreenTabId: TabId | null = null;
  private pendingHtmlFullscreen: {
    tabId: TabId;
    restoreBrowserFullscreen: boolean;
    requestedAt: number;
  } | null = null;
  private restoreBrowserFullscreenAfterHtmlExit = false;
  private htmlFullscreenRestoreBrowserFullscreen = false;
  private fullscreenRestoreTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly window: BaseWindow,
    private readonly shellView: WebContentsView,
    private readonly browserSession: Session,
    private readonly ublock: UblockService,
    private readonly extensions: ChromeWebStoreExtensionService | null,
    private readonly preferences: PreferencesStore,
    private readonly browserData: BrowserDataStore,
    private readonly readingPositions: ReadingPositionStore,
    private readonly hyperdrive: HyperdriveController,
    private readonly smartReaderDocuments: SmartReaderDocumentStore,
    private readonly onBrowserDataChanged: () => void,
    private readonly onExtensionsChanged: () => void,
    private readonly onExtensionCommandInput?: (
      input: Electron.Input,
    ) => boolean,
    private readonly onWebsiteDocumentInvalidated?: (
      contents: WebContents,
    ) => void,
    private readonly onYouTubePlayback?: (signal: {
      observationId: string;
      videoId: string;
      playbackSeconds: number;
      occurredAt: number;
    }) => void,
    private readonly shouldAllowWebsitePopup?: (openerUrl: string) => boolean,
    private readonly onOpenPerformanceCentre?: () => void,
    private readonly getRendererMemoryByProcessId: () => ReadonlyMap<
      number,
      number
    > = () => new Map(),
    private readonly smartReaderSummary?: SmartReaderSummaryBridge,
    private readonly smartReaderNarration?: SmartReaderNarrationBridge,
  ) {
    this.extensionPopup = extensions
      ? new ExtensionPopupController(window, browserSession, extensions, {
          onStateChanged: onExtensionsChanged,
          openExternalUrl: (url) =>
            this.runNativeTabTopologyAction(() => this.createTab(url)),
        })
      : null;
    this.fullscreenHint = new FullscreenHintController(window);
    this.window.on("resize", () => this.scheduleLayout());
    const refreshFullscreenLayout = () => {
      this.layoutActiveView();
      this.emitSnapshot();
    };
    this.window.on("enter-full-screen", refreshFullscreenLayout);
    this.window.on("leave-full-screen", () => {
      if (this.restoreBrowserFullscreenAfterHtmlExit) {
        this.restoreBrowserFullscreenAfterHtmlExit = false;
        if (this.fullscreenRestoreTimer)
          clearTimeout(this.fullscreenRestoreTimer);
        this.fullscreenRestoreTimer = null;
        this.window.setFullScreen(true);
        return;
      }
      refreshFullscreenLayout();
    });
    this.attachShortcutHandler(this.shellView);
    this.attachShellContextMenuHandler();
    this.hyperdrive.setBrowserData(this.browserData.snapshot);
  }

  initialize(): void {
    const session = this.preferences.snapshot.restoreSession
      ? this.browserData.loadSession()
      : null;
    if (!session?.tabs.length) {
      this.createTab();
      return;
    }

    for (const group of session.tabGroups) {
      this.tabGroups.set(group.id, { ...group });
    }
    for (const saved of session.tabs.slice(0, 500)) {
      const tab = this.makeTab(
        saved.id,
        saved.title,
        saved.url,
        saved.isNewTab,
        saved.groupId,
        saved.pinned,
      );
      this.tabs.set(tab.id, tab);
      this.order.push(tab.id);
    }
    this.activeTabId = this.tabs.has(session.activeTabId ?? "")
      ? (session.activeTabId as string)
      : this.order[0];
    this.splitView.restore(
      session.splitViewPairs ?? [],
      this.splitEligibleTabIds(),
    );
    this.selectionAnchorId = this.activeTabId;
    this.extensionTabs.activate(this.activeTabId);
    this.hyperdrive.setActiveTab(this.activeTabId);
    const active = this.requireTab(this.activeTabId);
    const activePair = this.splitView.pairForTab(active.id);
    if (activePair) {
      const peerId =
        activePair.leftTabId === active.id
          ? activePair.rightTabId
          : activePair.leftTabId;
      const peer = this.tabs.get(peerId);
      if (peer && this.isSplitEligibleTab(peer) && !peer.view) {
        void this.navigateToUrl(
          peer,
          peer.url,
          this.isAllowedInternalUrl(peer.url),
          false,
        );
      }
    }
    if (!active.isNewTab && active.url && !isShellInternalUrl(active.url)) {
      void this.navigateToUrl(
        active,
        active.url,
        this.isAllowedInternalUrl(active.url),
        true,
      );
    } else {
      this.layoutActiveView();
      this.emitSnapshot();
    }
  }

  get snapshot(): BrowserSnapshot {
    const memoryByProcessId = this.rendererMemoryByProcessId();
    return {
      tabs: this.order.map((id) =>
        this.toSnapshot(this.requireTab(id), memoryByProcessId),
      ),
      tabGroups: [...this.tabGroups.values()].map((group) => ({ ...group })),
      selectedTabIds: this.order.filter((id) => this.selectedTabIds.has(id)),
      activeTabId: this.activeTabId,
      splitView: this.splitView.snapshot(this.activeTabId),
      ublock: this.ublock.snapshot,
      preferences: {
        restoreSession: this.preferences.snapshot.restoreSession,
        sidebarAttached: this.preferences.snapshot.sidebarAttached,
        sidebarOpen: this.preferences.snapshot.sidebarOpen,
        bookmarkBarVisible: this.preferences.snapshot.bookmarkBarVisible,
        newTabTheme: this.preferences.snapshot.newTabTheme,
        searchEngine: this.preferences.snapshot.searchEngine,
        remoteSearchSuggestionsEnabled:
          this.preferences.snapshot.remoteSearchSuggestionsEnabled,
        hyperdriveMode: this.preferences.snapshot.hyperdriveMode,
        hyperdriveRamBudgetMb: this.preferences.snapshot.hyperdriveRamBudgetMb,
        hyperdriveCrossSitePreloadingEnabled:
          this.preferences.snapshot.hyperdriveCrossSitePreloadingEnabled,
        hyperdriveSearchPreloadingEnabled:
          this.preferences.snapshot.hyperdriveSearchPreloadingEnabled,
        hyperdriveExcludedHosts: [
          ...this.preferences.snapshot.hyperdriveExcludedHosts,
        ],
        hyperdriveMonitorOpen: this.preferences.snapshot.hyperdriveMonitorOpen,
        hyperdriveDeveloperMode:
          this.preferences.snapshot.hyperdriveDeveloperMode,
        extensionDeveloperMode:
          this.preferences.snapshot.extensionDeveloperMode,
        hiddenToolbarActions: [
          ...this.preferences.snapshot.hiddenToolbarActions,
        ],
        showDownloadProgressInToolbar:
          this.preferences.snapshot.showDownloadProgressInToolbar,
        showDownloadCompletionNotification:
          this.preferences.snapshot.showDownloadCompletionNotification,
        addVideosToGallery: this.preferences.snapshot.addVideosToGallery,
        smartReaderProgressVisible:
          this.preferences.snapshot.smartReaderProgressVisible,
      },
      baseChromeHeight: this.baseChromeHeight,
      chromeHeight: this.chromeHeight,
      webStoreListing: this.activeWebStoreListing,
      youtubeWatch: this.activeYouTubeWatch,
    };
  }

  get liveViewCount(): number {
    return [...this.tabs.values()].filter(
      (tab) => tab.view && !tab.view.webContents.isDestroyed(),
    ).length;
  }

  get performanceTabTasks(): PerformanceTabTask[] {
    return this.order.flatMap((tabId) => {
      const tab = this.tabs.get(tabId);
      const contents = tab?.view?.webContents;
      if (!tab || !contents || contents.isDestroyed()) return [];
      let processId: number;
      try {
        processId = contents.getOSProcessId();
      } catch {
        return [];
      }
      if (!Number.isSafeInteger(processId) || processId < 1) return [];
      return [
        {
          id: tab.id,
          title: tab.title || "Untitled tab",
          hostname: hostFromUrl(tab.url),
          faviconDataUrl: tab.faviconDataUrl,
          processId,
          active: tab.id === this.activeTabId,
          crashed: tab.crashed,
        },
      ];
    });
  }

  focusTabFromPerformanceCentre(tabId: TabId): void {
    this.activateTab(tabId);
    if (!this.window.isVisible()) this.window.show();
    this.window.focus();
  }

  terminateRendererProcess(processId: number): number {
    if (!Number.isSafeInteger(processId) || processId < 1) return 0;
    const matches = [...this.tabs.values()].filter((tab) => {
      const contents = tab.view?.webContents;
      if (!contents || contents.isDestroyed()) return false;
      try {
        return contents.getOSProcessId() === processId;
      } catch {
        return false;
      }
    });
    const target = matches[0]?.view?.webContents;
    if (!target || target.isDestroyed()) return 0;
    target.forcefullyCrashRenderer();
    return matches.length;
  }

  get extensionPopupId(): string | null {
    return this.extensionPopup?.openExtensionId ?? null;
  }

  isExtensionToolbarPinned(extensionId: string): boolean {
    return !this.preferences.snapshot.hiddenToolbarExtensionIds.includes(
      extensionId,
    );
  }

  get activeExtensionTabId(): number | null {
    return this.extensionTabSnapshots.find((tab) => tab.active)?.id ?? null;
  }

  get extensionTabSnapshots(): ExtensionTabSnapshot[] {
    return this.order
      .map((browserTabId) => this.extensionTabs.idForBrowserTab(browserTabId))
      .filter((id): id is number => id !== null)
      .map((id) => this.extensionTabs.get(id))
      .filter((tab): tab is ExtensionTabSnapshot => tab !== null);
  }

  getExtensionTab(extensionTabId: number): ExtensionTabSnapshot | null {
    return this.extensionTabs.get(extensionTabId);
  }

  getExtensionTabId(browserTabId: TabId): number | null {
    return this.extensionTabs.idForBrowserTab(browserTabId);
  }

  getExtensionTabIdForWebContents(
    webContentsId: number | null | undefined,
  ): number | null {
    if (
      typeof webContentsId !== "number" ||
      !Number.isSafeInteger(webContentsId) ||
      webContentsId < 1
    )
      return null;
    for (const browserTabId of this.order) {
      const contents = this.tabs.get(browserTabId)?.view?.webContents;
      if (
        contents &&
        !contents.isDestroyed() &&
        contents.id === webContentsId
      ) {
        return this.extensionTabs.idForBrowserTab(browserTabId);
      }
    }
    return null;
  }

  subscribeExtensionTabTransitions(
    listener: ExtensionTabTransitionListener,
  ): () => void {
    return this.extensionTabs.subscribe(listener);
  }

  setChromeOverlayOpen(open: boolean): void {
    if (this.disposed || this.window.isDestroyed()) return;
    // Re-adding an existing child view only changes its stacking order.
    // The transparent shell is raised while browser-owned popups are open,
    // then returned beneath page contents when the popup closes.
    this.window.contentView.addChildView(this.shellView, open ? undefined : 0);
  }

  setYouTubeDownloadIndicatorVisible(visible: boolean): void {
    if (this.youtubeDownloadIndicatorVisible === visible) return;
    this.youtubeDownloadIndicatorVisible = visible;
    this.layoutActiveView();
    this.emitSnapshot();
  }

  dismissWebStoreInstallBanner(tabId: TabId, extensionId: string): void {
    const tab = this.requireTab(tabId);
    const listing = parseChromeWebStoreListingUrl(tab.url);
    if (!listing || listing.extensionId !== extensionId) {
      throw new Error("The requested Web Store banner is no longer active.");
    }
    tab.dismissedWebStoreExtensionId = extensionId;
    if (tab.id === this.activeTabId) this.layoutActiveView();
    this.emitSnapshot();
  }

  getActiveYouTubeDownloadTarget(tabId: TabId): YouTubeWatchSnapshot {
    if (tabId !== this.activeTabId) {
      throw new Error("The selected tab is no longer active.");
    }
    const tab = this.requireTab(tabId);
    const target = parseYouTubeWatchUrl(tab.url);
    if (!target) throw new Error("The active page is not a YouTube video.");
    return target;
  }

  dismissYouTubeDownloadBanner(tabId: TabId, videoId: string): void {
    const tab = this.requireTab(tabId);
    const target = parseYouTubeWatchUrl(tab.url);
    if (!target || target.videoId !== videoId) {
      throw new Error("The requested YouTube banner is no longer active.");
    }
    tab.dismissedYouTubeVideoId = videoId;
    if (tab.id === this.activeTabId) this.layoutActiveView();
    this.emitSnapshot();
  }

  resizeWindowForSmoke(width: number, height: number): void {
    this.window.setSize(width, height);
    this.layoutActiveView();
  }

  setWindowMaximizedForSmoke(maximized: boolean): void {
    if (maximized) this.window.maximize();
    else this.window.unmaximize();
    this.layoutActiveView();
  }

  async evaluateActive<T>(expression: string): Promise<T> {
    const tab = this.requireTab(this.activeTabId);
    if (!tab.view || tab.view.webContents.isDestroyed())
      throw new Error("The active tab has no live page.");
    return tab.view.webContents.executeJavaScript(
      expression,
      true,
    ) as Promise<T>;
  }

  async captureActivePage(): Promise<Buffer> {
    const tab = this.requireTab(this.activeTabId);
    if (!tab.view || tab.view.webContents.isDestroyed())
      throw new Error("The active tab has no live page.");
    return (await tab.view.webContents.capturePage()).toPNG();
  }

  async getAssistantPageContext(tabId: string): Promise<AssistantPageContext> {
    if (tabId !== this.activeTabId) {
      throw new Error(
        "The active page changed. Open the assistant again to refresh context.",
      );
    }
    const tab = this.requireTab(tabId);
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed() || !isAllowedWebUrl(tab.url)) {
      throw new Error("Page context is available only for loaded websites.");
    }
    const expectedUrl = tab.url;
    const expectedEpoch = tab.documentEpoch;
    const value = (await contents.executeJavaScript(
      `(() => {
        const meta = (selector) => document.querySelector(selector)?.getAttribute("content") || "";
        const selection = getSelection()?.toString() || "";
        return {
          title: document.title || "",
          description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
          selectedText: selection,
          contentType: document.contentType || "",
        };
      })()`,
      true,
    )) as Record<string, unknown>;
    const current = this.tabs.get(tabId);
    if (
      current !== tab ||
      this.activeTabId !== tabId ||
      tab.documentEpoch !== expectedEpoch ||
      tab.url !== expectedUrl ||
      contents.isDestroyed()
    ) {
      throw new Error("The page changed while its context was being read.");
    }
    const url = cleanAssistantUrl(expectedUrl);
    if (!url)
      throw new Error("This page cannot be included as assistant context.");
    return {
      tabId,
      url,
      displayUrl: displayAssistantUrl(url),
      title:
        cleanAssistantText(value.title, 240) ??
        cleanAssistantText(tab.title, 240) ??
        "Untitled page",
      description: cleanAssistantText(
        value.description,
        ASSISTANT_DESCRIPTION_LIMIT,
      ),
      selectedText: cleanAssistantText(
        value.selectedText,
        ASSISTANT_TEXT_LIMIT,
      ),
      contentType: cleanAssistantText(value.contentType, 100),
    };
  }

  startAssistantSelection(kind: "screenshot" | "element"): void {
    const tab = this.requireTab(this.activeTabId);
    const contents = tab.view?.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      tab.isLoading ||
      !isAllowedWebUrl(tab.url)
    ) {
      throw new Error(
        "Wait for a website to finish loading before selecting context.",
      );
    }
    contents.send(channels.assistantStartSelection, { kind });
  }

  cancelAssistantSelection(): void {
    const contents = this.tabs.get(this.activeTabId)?.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.send(channels.assistantCancelSelection);
  }

  private sendAssistantContextCaptured(value: AssistantContextCaptured): void {
    if (!this.shellView.webContents.isDestroyed()) {
      this.shellView.webContents.send(channels.assistantContextCaptured, value);
    }
  }

  private async handleAssistantSelection(
    tab: TabRecord,
    contents: WebContents,
    value: unknown,
  ): Promise<void> {
    if (!value || typeof value !== "object" || tab.id !== this.activeTabId)
      return;
    const source = value as Record<string, unknown>;
    const requestId = cleanAssistantText(source.requestId, 100);
    const kind =
      source.kind === "screenshot" || source.kind === "element"
        ? source.kind
        : null;
    if (
      !requestId ||
      !kind ||
      !isAllowedWebUrl(tab.url) ||
      contents.isDestroyed()
    )
      return;
    const url = cleanAssistantUrl(tab.url);
    if (!url) return;
    if (kind === "element") {
      const element = cleanAssistantElement(source.element);
      if (!element) return;
      const label = element.label ?? element.text ?? element.alt ?? element.tag;
      this.sendAssistantContextCaptured({
        requestId,
        attachment: {
          id: `element-${requestId}`,
          kind: "element",
          label:
            `${element.tag[0].toUpperCase()}${element.tag.slice(1)} · ${label}`.slice(
              0,
              180,
            ),
          detail: element.role ?? element.tag,
          createdAt: Date.now(),
          data: { element },
        },
      });
      return;
    }
    const rectangle = source.rectangle as Record<string, unknown> | undefined;
    const viewport = source.viewport as Record<string, unknown> | undefined;
    const numbers = [
      rectangle?.x,
      rectangle?.y,
      rectangle?.width,
      rectangle?.height,
      viewport?.width,
      viewport?.height,
    ];
    if (
      !numbers.every(
        (entry) => typeof entry === "number" && Number.isFinite(entry),
      )
    )
      return;
    const [x, y, width, height, viewportWidth, viewportHeight] =
      numbers as number[];
    if (
      width < 8 ||
      height < 8 ||
      width > viewportWidth ||
      height > viewportHeight ||
      x < 0 ||
      y < 0 ||
      x + width > viewportWidth + 1 ||
      y + height > viewportHeight + 1 ||
      viewportWidth < 1 ||
      viewportHeight < 1
    )
      return;
    try {
      const image = await contents.capturePage();
      if (
        contents.isDestroyed() ||
        tab.id !== this.activeTabId ||
        image.isEmpty()
      )
        return;
      const size = image.getSize();
      const scaleX = size.width / viewportWidth;
      const scaleY = size.height / viewportHeight;
      const crop = image.crop({
        x: Math.max(0, Math.floor(x * scaleX)),
        y: Math.max(0, Math.floor(y * scaleY)),
        width: Math.max(1, Math.floor(width * scaleX)),
        height: Math.max(1, Math.floor(height * scaleY)),
      });
      if (crop.isEmpty()) return;
      const croppedSize = crop.getSize();
      const targetWidth = Math.min(720, croppedSize.width);
      const resized = crop.resize({
        width: targetWidth,
        height: Math.max(
          1,
          Math.round((croppedSize.height / croppedSize.width) * targetWidth),
        ),
        quality: "good",
      });
      const png = resized.toPNG();
      if (png.byteLength > ASSISTANT_SCREENSHOT_LIMIT) {
        throw new Error(
          "The selected screenshot is too large. Select a smaller area.",
        );
      }
      this.sendAssistantContextCaptured({
        requestId,
        attachment: {
          id: `screenshot-${requestId}`,
          kind: "screenshot",
          label: "Screenshot · Selected area",
          detail: `${Math.round(width)} × ${Math.round(height)}`,
          createdAt: Date.now(),
          data: {
            screenshotDataUrl: `data:image/png;base64,${png.toString("base64")}`,
            url,
          },
        },
      });
    } catch (error) {
      console.warn("Could not capture assistant screenshot context.", error);
    }
  }

  createOfflinePageCapture(tabId: TabId): OfflinePageCaptureSource {
    if (tabId !== this.activeTabId) {
      throw new Error("The selected page is no longer active.");
    }
    const tab = this.requireTab(tabId);
    const contents = tab.view?.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      tab.isLoading ||
      !isAllowedWebUrl(tab.url)
    ) {
      throw new Error(
        "Wait for a web page to finish loading before saving it.",
      );
    }
    const expectedUrl = tab.url;
    const expectedEpoch = tab.documentEpoch;
    const assertUnchanged = () => {
      const current = this.tabs.get(tabId);
      if (
        this.activeTabId !== tabId ||
        current !== tab ||
        current.url !== expectedUrl ||
        current.documentEpoch !== expectedEpoch ||
        contents.isDestroyed()
      ) {
        throw new Error(
          "The page changed while it was being saved. Try again.",
        );
      }
    };
    return {
      tabId,
      title: tab.title,
      sourceUrl: expectedUrl,
      assertUnchanged,
      saveCompletePage: async (destinationHtml) => {
        assertUnchanged();
        await contents.savePage(destinationHtml, "HTMLComplete");
        assertUnchanged();
      },
      capturePreview: async () => {
        assertUnchanged();
        const image = await contents.capturePage();
        assertUnchanged();
        if (image.isEmpty()) return null;
        return image.resize({ width: 960, quality: "good" }).toPNG();
      },
    };
  }

  async captureShell(): Promise<Buffer> {
    try {
      const shellImage = await Promise.race<NativeImage>([
        this.shellView.webContents.capturePage(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Shell capture surface was unavailable.")),
            400,
          ),
        ),
      ]);
      if (!shellImage.isEmpty()) return shellImage.toPNG();
    } catch {
      // WebContentsView surfaces can be unavailable when another view overlaps
      // them. The smoke harness falls back to the renderer's DevTools target.
    }

    const debuggerClient = this.shellView.webContents.debugger;
    const attachedHere = !debuggerClient.isAttached();
    try {
      if (attachedHere) debuggerClient.attach("1.3");
      const capture = () =>
        Promise.race([
          debuggerClient.sendCommand("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("DevTools screenshot timed out.")),
              1_500,
            ),
          ),
        ]) as Promise<{ data?: string }>;
      await capture();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const result = await capture();
      if (!result.data)
        throw new Error("DevTools returned an empty screenshot.");
      return Buffer.from(result.data, "base64");
    } finally {
      if (attachedHere && debuggerClient.isAttached()) debuggerClient.detach();
    }
  }

  async evaluateShell<T>(expression: string): Promise<T> {
    return this.shellView.webContents.executeJavaScript(
      expression,
      true,
    ) as Promise<T>;
  }

  sendShellShortcut(
    keyCode: string,
    modifiers: Array<"control" | "shift" | "alt" | "meta">,
  ): void {
    this.shellView.webContents.focus();
    this.shellView.webContents.sendInputEvent({
      type: "keyDown",
      keyCode,
      modifiers,
    });
    this.shellView.webContents.sendInputEvent({
      type: "keyUp",
      keyCode,
      modifiers,
    });
  }

  createTab(input?: string, activate = true): TabId {
    this.assertTabTopologyMutable();
    const id = randomUUID();
    const tab = this.makeTab(id, "New Tab", "", true);
    this.tabs.set(id, tab);
    this.order.push(id);
    this.ensureView(tab);
    if (activate) this.activateTab(id);
    else this.emitSnapshot();
    if (input) {
      const target = resolveNavigationInput(input);
      if (target) void this.navigateToUrl(tab, target, false, activate);
    }
    this.scheduleSessionSave();
    return id;
  }

  openGallery(entryId?: string, forceNew = false): TabId {
    this.assertTabTopologyMutable();
    const suffix = entryId ? `?video=${encodeURIComponent(entryId)}` : "";
    const url = `chromecraft://gallery/${suffix}`;
    const active = this.tabs.get(this.activeTabId);
    const existing = forceNew
      ? undefined
      : active?.url.startsWith("chromecraft://gallery/")
        ? active
        : [...this.tabs.values()].find((tab) =>
            tab.url.startsWith("chromecraft://gallery/"),
          );
    if (existing) {
      existing.url = url;
      existing.requestedUrl = url;
      existing.title = "My Gallery";
      existing.isNewTab = false;
      this.activateTab(existing.id);
      this.emitSnapshot();
      this.scheduleSessionSave();
      return existing.id;
    }
    const id = randomUUID();
    const tab = this.makeTab(id, "My Gallery", url, false);
    this.tabs.set(id, tab);
    this.order.push(id);
    this.activateTab(id);
    this.scheduleSessionSave();
    return id;
  }

  openOfflinePages(entryId?: string, forceNew = false): TabId {
    this.assertTabTopologyMutable();
    if (entryId && !/^[a-z0-9_-]{1,128}$/u.test(entryId)) {
      throw new TypeError("Invalid offline page id.");
    }
    const suffix = entryId ? `?page=${encodeURIComponent(entryId)}` : "";
    const url = `chromecraft://offline-pages/${suffix}`;
    const active = this.tabs.get(this.activeTabId);
    const existing = forceNew
      ? undefined
      : isOfflinePagesUrl(active?.url ?? "")
        ? active
        : [...this.tabs.values()].find((tab) => isOfflinePagesUrl(tab.url));
    if (existing) {
      this.destroyView(existing);
      existing.url = url;
      existing.requestedUrl = url;
      existing.title = "Offline Pages";
      existing.isNewTab = false;
      existing.isLoading = false;
      existing.error = null;
      this.activateTab(existing.id);
      this.emitSnapshot();
      this.scheduleSessionSave();
      return existing.id;
    }
    const id = randomUUID();
    const tab = this.makeTab(id, "Offline Pages", url, false);
    this.tabs.set(id, tab);
    this.order.push(id);
    this.activateTab(id);
    this.scheduleSessionSave();
    return id;
  }

  openOfflinePage(entryId: string): TabId {
    if (!/^[a-z0-9_-]{1,128}$/u.test(entryId)) {
      throw new TypeError("Invalid offline page id.");
    }
    const tabId = this.createTab(undefined, false);
    const tab = this.requireTab(tabId);
    void this.navigateToUrl(
      tab,
      `chromecraft-offline://${entryId}/index.html`,
      true,
      true,
    );
    return tabId;
  }

  activateTab(tabId: TabId): void {
    const next = this.requireTab(tabId);
    const previous = this.tabs.get(this.activeTabId);
    if (previous?.id === next.id) {
      this.selectedTabIds.clear();
      this.selectionAnchorId = tabId;
      this.hyperdrive.setActiveTab(tabId);
      this.layoutActiveView();
      this.emitSnapshot();
      return;
    }
    if (previous && this.htmlFullscreenTabId === previous.id)
      this.exitWebsiteFullscreen(previous);
    if (previous && this.pendingHtmlFullscreen?.tabId === previous.id)
      this.pendingHtmlFullscreen = null;
    if (previous) this.releaseWebsiteInputCapture(previous);
    if (previous?.reader.active) {
      this.sendSmartReaderCommand(previous, { type: "pause-narration" });
    }
    if (previous?.view && !previous.view.webContents.isDestroyed())
      this.onWebsiteDocumentInvalidated?.(previous.view.webContents);
    if (previous) void this.captureTabThumbnail(previous);
    this.extensionPopup?.close();
    this.activeTabId = tabId;
    this.splitView.noteFocusedTab(tabId);
    this.selectedTabIds.clear();
    this.selectionAnchorId = tabId;
    this.extensionTabs.activate(tabId);
    this.hyperdrive.setActiveTab(tabId);
    if (
      !next.isNewTab &&
      next.url &&
      !next.view &&
      !isShellInternalUrl(next.url)
    ) {
      void this.navigateToUrl(
        next,
        next.url,
        this.isAllowedInternalUrl(next.url),
        false,
      );
    }
    const pair = this.splitView.pairForTab(tabId);
    if (pair) {
      const peer = this.tabs.get(
        pair.leftTabId === tabId ? pair.rightTabId : pair.leftTabId,
      );
      if (peer && this.isSplitEligibleTab(peer) && !peer.view) {
        void this.navigateToUrl(
          peer,
          peer.url,
          this.isAllowedInternalUrl(peer.url),
          false,
        );
      }
    }
    this.layoutActiveView();
    this.emitSnapshot();
    this.scheduleSessionSave();
  }

  async updateSplitView(command: SplitViewCommand): Promise<void> {
    const result = this.splitView.dispatch(command, {
      activeTabId: this.activeTabId,
      eligibleTabIds: this.splitEligibleTabIds(),
    });
    if (!result.changed) return;

    if (result.activeTabId !== this.activeTabId) {
      this.activateTab(result.activeTabId);
      const focused = this.tabs.get(result.activeTabId)?.view?.webContents;
      if (focused && !focused.isDestroyed()) focused.focus();
      return;
    }

    const activePair = this.splitView.pairForTab(this.activeTabId);
    if (activePair) {
      for (const memberId of [activePair.leftTabId, activePair.rightTabId]) {
        const member = this.tabs.get(memberId);
        if (member && this.isSplitEligibleTab(member) && !member.view) {
          await this.navigateToUrl(
            member,
            member.url,
            this.isAllowedInternalUrl(member.url),
            false,
          );
        }
      }
    }
    this.layoutActiveView();
    this.emitSnapshot();
    this.scheduleSessionSave();
  }

  closeTab(tabId: TabId): void {
    this.assertTabTopologyMutable();
    const tab = this.requireTab(tabId);
    this.finishSavedArticleReader(
      tabId,
      false,
      "The article tab was closed before Smart Reader could open it.",
    );
    const group = tab.groupId ? this.tabGroups.get(tab.groupId) : null;
    if (this.htmlFullscreenTabId === tab.id) this.exitWebsiteFullscreen(tab);
    if (this.pendingHtmlFullscreen?.tabId === tab.id)
      this.pendingHtmlFullscreen = null;
    this.releaseWebsiteInputCapture(tab);
    if (tab.view && !tab.view.webContents.isDestroyed())
      this.onWebsiteDocumentInvalidated?.(tab.view.webContents);
    const splitPeerId = this.splitView.removeTab(tabId);
    const closingIndex = this.order.indexOf(tabId);
    this.tabs.delete(tabId);
    this.order.splice(closingIndex, 1);
    this.selectedTabIds.delete(tabId);
    if (this.selectionAnchorId === tabId) this.selectionAnchorId = null;
    this.extensionTabs.remove(tabId);
    this.destroyView(tab);
    if (isAllowedWebUrl(tab.url)) {
      void this.browserData
        .addRecentlyClosedTab({
          title: tab.title || hostFromUrl(tab.url),
          url: tab.url,
          pinned: tab.pinned,
          groupId: group?.id ?? null,
          groupName: group?.name ?? null,
          groupColor: group?.color ?? null,
        })
        .then(this.onBrowserDataChanged)
        .catch((error) =>
          console.warn("Could not save the closed tab.", error),
        );
    }
    if (group?.saved) {
      void this.syncSavedTabGroup(group).catch((error) =>
        console.warn("Could not update the saved tab group.", error),
      );
    }
    this.removeEmptyGroup(tab.groupId);
    if (this.order.length === 0) {
      this.createTab();
      return;
    }
    if (this.activeTabId === tabId) {
      const nextIndex = Math.min(closingIndex, this.order.length - 1);
      const nextTabId =
        splitPeerId && this.tabs.has(splitPeerId)
          ? splitPeerId
          : this.order[nextIndex];
      this.activeTabId = "";
      this.activateTab(nextTabId);
      return;
    }
    this.layoutActiveView();
    this.emitSnapshot();
    this.scheduleSessionSave();
  }

  async duplicateTab(tabId: TabId): Promise<TabId> {
    const finish = this.beginTabTopologyMutation();
    try {
      const source = this.requireTab(tabId);
      if (isGalleryUrl(source.url)) {
        const videoId =
          new URL(source.url).searchParams.get("video") ?? undefined;
        return this.openGallery(videoId);
      }
      if (isOfflinePagesUrl(source.url)) {
        const entryId =
          new URL(source.url).searchParams.get("page") ?? undefined;
        return this.openOfflinePages(entryId, true);
      }
      const duplicateId = this.createTab(undefined, false);
      const currentIndex = this.order.indexOf(duplicateId);
      this.order.splice(currentIndex, 1);
      this.order.splice(this.order.indexOf(tabId) + 1, 0, duplicateId);
      const duplicate = this.requireTab(duplicateId);
      duplicate.isMuted = source.isMuted;
      duplicate.zoomFactor = source.zoomFactor;
      duplicate.groupId = source.groupId;
      duplicate.pinned = source.pinned;
      if (source.url) {
        await this.navigateToUrl(
          duplicate,
          source.url,
          this.isAllowedInternalUrl(source.url),
          true,
        );
      } else {
        this.activateTab(duplicateId);
      }
      return duplicateId;
    } finally {
      finish();
    }
  }

  async reopenClosedTab(id?: string): Promise<TabId | null> {
    const finish = this.beginTabTopologyMutation();
    try {
      const closed = await this.browserData.takeRecentlyClosedTab(id);
      if (!closed) return null;
      this.onBrowserDataChanged();
      const active = this.tabs.get(this.activeTabId);
      if (this.order.length === 1 && active?.isNewTab)
        this.closeTabWithoutHistory(active.id);
      const idOfTab = this.createTab(closed.url);
      this.requireTab(idOfTab).pinned = closed.pinned;
      if (closed.pinned) this.setTabsPinned([idOfTab], true);
      if (closed.groupId && closed.groupName && closed.groupColor) {
        const existing = this.tabGroups.get(closed.groupId);
        if (!existing) {
          this.tabGroups.set(closed.groupId, {
            id: closed.groupId,
            name: closed.groupName,
            color: closed.groupColor,
            collapsed: false,
            saved: this.browserData
              .listSavedTabGroups()
              .some((group) => group.id === closed.groupId),
            createdAt: Date.now(),
          });
        }
        this.requireTab(idOfTab).groupId = closed.groupId;
        this.emitSnapshot();
        this.scheduleSessionSave();
      }
      return idOfTab;
    } finally {
      finish();
    }
  }

  createTabGroup(
    requestedTabIds: TabId[],
    name = "New group",
    color: TabGroupColor = "grey",
  ): string {
    this.assertTabTopologyMutable();
    const tabIds = this.requireTabIds(requestedTabIds).sort(
      (left, right) => this.order.indexOf(left) - this.order.indexOf(right),
    );
    if (tabIds.length === 0) {
      throw new RangeError("A tab group must contain at least one tab.");
    }
    const group: TabGroupSnapshot = {
      id: randomUUID(),
      name: requireTabGroupName(name),
      color: requireTabGroupColor(color),
      collapsed: false,
      saved: false,
      createdAt: Date.now(),
    };
    this.tabGroups.set(group.id, group);
    const previousGroupIds = new Set(
      tabIds
        .map((tabId) => this.requireTab(tabId).groupId)
        .filter((id): id is string => id !== null),
    );
    const moving = new Set(tabIds);
    const earliestSelectedIndex = Math.min(
      ...tabIds.map((tabId) => this.order.indexOf(tabId)),
    );
    const remaining = this.order.filter((tabId) => !moving.has(tabId));
    const insertion = this.order
      .slice(0, earliestSelectedIndex)
      .filter((tabId) => !moving.has(tabId)).length;
    remaining.splice(insertion, 0, ...tabIds);
    this.order.splice(0, this.order.length, ...remaining);
    for (const tabId of tabIds) {
      const tab = this.requireTab(tabId);
      tab.pinned = false;
      tab.groupId = group.id;
    }
    this.removeUnreferencedGroups();
    for (const previousGroupId of previousGroupIds) {
      const previousGroup = this.tabGroups.get(previousGroupId);
      if (previousGroup?.saved) {
        void this.syncSavedTabGroup(previousGroup).catch((error) =>
          console.warn("Could not update the saved tab group.", error),
        );
      }
    }
    this.sortPinnedTabsFirst();
    this.emitSnapshot();
    this.scheduleSessionSave();
    return group.id;
  }

  async updateTabGroup(groupId: string, update: TabGroupUpdate): Promise<void> {
    const finish = this.beginTabTopologyMutation();
    try {
      const group = this.requireTabGroup(groupId);
      if (update.name !== undefined)
        group.name = requireTabGroupName(update.name);
      if (update.color !== undefined)
        group.color = requireTabGroupColor(update.color);
      if (update.collapsed !== undefined) {
        if (
          update.collapsed &&
          !group.collapsed &&
          this.requireTab(this.activeTabId).groupId === group.id
        ) {
          const activeIndex = this.order.indexOf(this.activeTabId);
          let nextVisibleTabId: TabId | null = null;
          for (let distance = 1; distance < this.order.length; distance += 1) {
            const candidates = [
              this.order[activeIndex + distance],
              this.order[activeIndex - distance],
            ];
            nextVisibleTabId =
              candidates.find((tabId) => {
                if (!tabId) return false;
                const tab = this.requireTab(tabId);
                if (tab.groupId === group.id) return false;
                return (
                  tab.groupId === null ||
                  this.tabGroups.get(tab.groupId)?.collapsed !== true
                );
              }) ?? null;
            if (nextVisibleTabId) break;
          }
          if (nextVisibleTabId) {
            this.activateTab(nextVisibleTabId);
            group.collapsed = true;
          }
        } else {
          group.collapsed = update.collapsed;
        }
      }
      if (update.saved !== undefined) group.saved = update.saved;
      if (group.saved) await this.syncSavedTabGroup(group);
      else if (update.saved === false) {
        await this.browserData.removeSavedTabGroup(group.id);
        this.onBrowserDataChanged();
      }
      this.emitSnapshot();
      this.scheduleSessionSave();
    } finally {
      finish();
    }
  }

  async deleteTabGroup(groupId: string, closeTabs = false): Promise<void> {
    const finish = this.beginTabTopologyMutation();
    try {
      const group = this.requireTabGroup(groupId);
      const tabIds = this.order.filter(
        (tabId) => this.requireTab(tabId).groupId === group.id,
      );
      if (closeTabs && group.saved) await this.syncSavedTabGroup(group);
      this.tabGroups.delete(group.id);
      if (closeTabs) {
        this.closeTabs(tabIds);
        return;
      }
      for (const tabId of tabIds) this.requireTab(tabId).groupId = null;
      this.emitSnapshot();
      this.scheduleSessionSave();
      if (group.saved) {
        await this.browserData.removeSavedTabGroup(group.id);
        this.onBrowserDataChanged();
      }
    } finally {
      finish();
    }
  }

  async restoreSavedTabGroup(groupId: string): Promise<TabId[]> {
    this.assertTabTopologyMutable();
    const saved = this.browserData
      .listSavedTabGroups()
      .find((group) => group.id === groupId);
    if (!saved) throw new Error(`Unknown saved tab group: ${groupId}`);
    const alreadyOpen = this.order.filter(
      (tabId) => this.requireTab(tabId).groupId === groupId,
    );
    if (alreadyOpen.length > 0) {
      this.activateTab(alreadyOpen[0]);
      return alreadyOpen;
    }
    const active = this.tabs.get(this.activeTabId);
    if (this.order.length === 1 && active?.isNewTab)
      this.closeTabWithoutHistory(active.id);
    this.tabGroups.set(groupId, {
      id: groupId,
      name: saved.name,
      color: saved.color,
      collapsed: false,
      saved: true,
      createdAt: saved.createdAt,
    });
    const created = saved.tabs.map((savedTab) => {
      const tabId = this.createTab(savedTab.url, false);
      this.requireTab(tabId).groupId = groupId;
      return tabId;
    });
    if (created[0]) this.activateTab(created[0]);
    else {
      this.tabGroups.delete(groupId);
      this.createTab();
    }
    this.emitSnapshot();
    this.scheduleSessionSave();
    return created;
  }

  async removeSavedTabGroup(groupId: string): Promise<void> {
    const finish = this.beginTabTopologyMutation();
    try {
      await this.browserData.removeSavedTabGroup(groupId);
      const group = this.tabGroups.get(groupId);
      if (group) group.saved = false;
      this.onBrowserDataChanged();
      this.emitSnapshot();
      this.scheduleSessionSave();
    } finally {
      finish();
    }
  }

  selectTabs(requestedTabIds: TabId[], mode: TabSelectionMode): void {
    const tabIds = this.requireTabIds(requestedTabIds);
    if (mode === "replace") {
      this.selectedTabIds.clear();
      for (const tabId of tabIds) this.selectedTabIds.add(tabId);
    } else if (mode === "add") {
      for (const tabId of tabIds) this.selectedTabIds.add(tabId);
    } else if (mode === "toggle") {
      for (const tabId of tabIds) {
        if (!this.selectedTabIds.delete(tabId)) this.selectedTabIds.add(tabId);
      }
    } else if (mode === "range") {
      const target = tabIds.at(-1);
      if (target) {
        const anchor =
          this.selectionAnchorId && this.tabs.has(this.selectionAnchorId)
            ? this.selectionAnchorId
            : this.activeTabId;
        const firstIndex = this.order.indexOf(anchor);
        const lastIndex = this.order.indexOf(target);
        this.selectedTabIds.clear();
        const from = Math.min(firstIndex, lastIndex);
        const to = Math.max(firstIndex, lastIndex);
        for (const tabId of this.order.slice(from, to + 1))
          this.selectedTabIds.add(tabId);
      }
    } else {
      throw new TypeError("Unknown tab selection mode.");
    }
    if (tabIds.at(-1)) this.selectionAnchorId = tabIds.at(-1) ?? null;
    this.emitSnapshot();
  }

  moveTabs(
    requestedTabIds: TabId[],
    targetIndex: number,
    groupId?: string | null,
  ): void {
    this.assertTabTopologyMutable();
    if (!Number.isSafeInteger(targetIndex))
      throw new TypeError("Tab target index must be an integer.");
    const moving = this.requireTabIds(requestedTabIds).sort(
      (left, right) => this.order.indexOf(left) - this.order.indexOf(right),
    );
    if (moving.length === 0) return;
    if (groupId !== undefined && groupId !== null)
      this.requireTabGroup(groupId);
    const affectedGroupIds = new Set(
      moving
        .map((tabId) => this.requireTab(tabId).groupId)
        .filter((id): id is string => id !== null),
    );
    if (groupId) affectedGroupIds.add(groupId);
    const remaining = this.order.filter((tabId) => !moving.includes(tabId));
    const insertion = Math.max(0, Math.min(targetIndex, remaining.length));
    remaining.splice(insertion, 0, ...moving);
    this.order.splice(0, this.order.length, ...remaining);
    if (groupId !== undefined) {
      for (const tabId of moving) {
        const tab = this.requireTab(tabId);
        if (groupId) tab.pinned = false;
        tab.groupId = groupId;
      }
      if (
        groupId &&
        moving.includes(this.activeTabId) &&
        this.requireTabGroup(groupId).collapsed
      ) {
        this.requireTabGroup(groupId).collapsed = false;
      }
    }
    this.sortPinnedTabsFirst();
    this.removeUnreferencedGroups();
    for (const affectedGroupId of affectedGroupIds) {
      const group = this.tabGroups.get(affectedGroupId);
      if (group?.saved) {
        void this.syncSavedTabGroup(group).catch((error) =>
          console.warn("Could not update the saved tab group.", error),
        );
      }
    }
    this.emitSnapshot();
    this.scheduleSessionSave();
  }

  closeTabs(requestedTabIds: TabId[]): void {
    this.assertTabTopologyMutable();
    const tabIds = this.requireTabIds(requestedTabIds);
    const active = tabIds.includes(this.activeTabId) ? this.activeTabId : null;
    for (const tabId of tabIds) {
      if (tabId !== active && this.tabs.has(tabId)) this.closeTab(tabId);
    }
    if (active && this.tabs.has(active)) this.closeTab(active);
  }

  setTabsPinned(requestedTabIds: TabId[], pinned: boolean): void {
    this.assertTabTopologyMutable();
    const tabIds = this.requireTabIds(requestedTabIds);
    const affectedGroups = new Set<string>();
    for (const tabId of tabIds) {
      const tab = this.requireTab(tabId);
      tab.pinned = pinned;
      if (pinned && tab.groupId) {
        affectedGroups.add(tab.groupId);
        tab.groupId = null;
      }
    }
    for (const groupId of affectedGroups) {
      const group = this.tabGroups.get(groupId);
      if (group?.saved) {
        void this.syncSavedTabGroup(group).catch((error) =>
          console.warn("Could not update the saved tab group.", error),
        );
      }
      this.removeEmptyGroup(groupId);
    }
    this.sortPinnedTabsFirst();
    this.emitSnapshot();
    this.scheduleSessionSave();
  }

  getAiTabOrganizationContext(): AiTabOrganizationContext {
    const protectedGroups = new Set<string>();
    for (const group of this.tabGroups.values()) {
      const members = this.order
        .map((tabId) => this.requireTab(tabId))
        .filter((tab) => tab.groupId === group.id);
      if (
        group.saved ||
        members.some((tab) => tab.pinned || !isAllowedWebUrl(tab.url))
      ) {
        protectedGroups.add(group.id);
      }
    }
    const candidates: AiTabOrganizationCandidate[] = [];
    const preservedTabIds: TabId[] = [];
    for (const tabId of this.order) {
      const tab = this.requireTab(tabId);
      if (
        tab.pinned ||
        !isAllowedWebUrl(tab.url) ||
        (tab.groupId !== null && protectedGroups.has(tab.groupId))
      ) {
        preservedTabIds.push(tab.id);
        continue;
      }
      const url = new URL(tab.url);
      candidates.push({
        id: tab.id,
        title: cleanAiPromptText(tab.title || url.hostname, 160),
        hostname: cleanAiPromptText(url.hostname, 255),
        pathHint: cleanAiPromptText(url.pathname, 180),
      });
    }
    return {
      revision: this.aiTabOrganizationRevision(),
      candidates,
      preservedTabIds,
    };
  }

  async applyAiTabOrganization(
    plan: AiTabOrganizationPlan,
    preserveUndoToken: string | null = null,
  ): Promise<AppliedAiTabOrganization> {
    this.assertAiTabTopologyMutable();
    this.aiTabOrganizationMutationInProgress = true;
    try {
      const context = this.getAiTabOrganizationContext();
      if (plan.revision !== context.revision) {
        throw new Error(
          "Your tabs changed while the plan was open. Refresh the snapshot before applying it.",
        );
      }
      const candidateIds = context.candidates.map((tab) => tab.id);
      const candidateSet = new Set(candidateIds);
      const requestedIds = [
        ...plan.groups.flatMap((group) => group.tabIds),
        ...plan.ungroupedTabIds,
      ];
      if (
        requestedIds.length !== candidateIds.length ||
        new Set(requestedIds).size !== requestedIds.length ||
        requestedIds.some((id) => !candidateSet.has(id))
      ) {
        throw new Error("The AI tab plan no longer matches the open tabs.");
      }
      const previous = this.captureTabOrganizationTopology();
      const preservedUndo = preserveUndoToken
        ? this.aiTabOrganizationUndo
        : null;
      if (
        preserveUndoToken &&
        (!preservedUndo ||
          preservedUndo.token !== preserveUndoToken ||
          preservedUndo.afterRevision !==
            this.tabOrganizationTopologyRevision())
      ) {
        throw new AiTabOrganizationUndoUnavailableError(
          "Your tabs changed after they were organised, so the original layout can no longer be replaced safely.",
        );
      }
      const nextGroups = new Map(
        [...this.tabGroups.entries()]
          .filter(([, group]) => {
            if (group.saved) return true;
            return this.order.some((tabId) => {
              const tab = this.requireTab(tabId);
              return tab.groupId === group.id && !candidateSet.has(tab.id);
            });
          })
          .map(([id, group]) => [id, { ...group }] as const),
      );
      const nextGroupIds = new Map<TabId, string | null>();
      for (const tabId of this.order)
        nextGroupIds.set(tabId, this.requireTab(tabId).groupId);
      for (const tabId of candidateIds) nextGroupIds.set(tabId, null);

      for (const requested of plan.groups) {
        if (requested.tabIds.length < 2)
          throw new Error("AI-created tab groups need at least two tabs.");
        const group: TabGroupSnapshot = {
          id: randomUUID(),
          name: requireTabGroupName(requested.name),
          color: requireTabGroupColor(requested.color),
          collapsed: false,
          saved: false,
          createdAt: Date.now(),
        };
        nextGroups.set(group.id, group);
        for (const tabId of requested.tabIds) nextGroupIds.set(tabId, group.id);
      }

      const arrangedCandidates = [
        ...plan.groups.flatMap((group) => group.tabIds),
        ...plan.ungroupedTabIds,
      ];
      const nextOrder: TabId[] = [];
      let candidatesInserted = false;
      for (const tabId of this.order) {
        if (!candidateSet.has(tabId)) {
          nextOrder.push(tabId);
        } else if (!candidatesInserted) {
          nextOrder.push(...arrangedCandidates);
          candidatesInserted = true;
        }
      }
      this.installTabOrganizationTopology({
        order: nextOrder,
        groupIds: nextGroupIds,
        pinned: new Map(previous.pinned),
        groups: nextGroups,
      });
      try {
        await this.flushSession();
      } catch (error) {
        this.installTabOrganizationTopology(previous);
        throw error;
      }
      this.emitSnapshot();
      const undoToken = preservedUndo?.token ?? randomUUID();
      this.aiTabOrganizationUndo = {
        token: undoToken,
        before: preservedUndo?.before ?? previous,
        afterRevision: this.tabOrganizationTopologyRevision(),
        organisedTabCount:
          preservedUndo?.organisedTabCount ?? candidateIds.length,
        groupCount: plan.groups.length,
      };
      return {
        undoToken,
        organisedTabCount: candidateIds.length,
        groupCount: plan.groups.length,
      };
    } finally {
      this.aiTabOrganizationMutationInProgress = false;
    }
  }

  async undoAiTabOrganization(
    undoToken: string,
  ): Promise<AppliedAiTabOrganization> {
    this.assertAiTabTopologyMutable();
    this.aiTabOrganizationMutationInProgress = true;
    try {
      const undo = this.aiTabOrganizationUndo;
      if (!undo || undo.token !== undoToken) {
        throw new AiTabOrganizationUndoUnavailableError(
          "There is no AI tab organisation to undo.",
        );
      }
      if (this.tabOrganizationTopologyRevision() !== undo.afterRevision) {
        this.aiTabOrganizationUndo = null;
        throw new AiTabOrganizationUndoUnavailableError(
          "Your tabs changed after they were organised, so this action can no longer be undone safely.",
        );
      }
      const current = this.captureTabOrganizationTopology();
      this.installTabOrganizationTopology(undo.before);
      try {
        await this.flushSession();
      } catch (error) {
        this.installTabOrganizationTopology(current);
        throw error;
      }
      this.aiTabOrganizationUndo = null;
      this.emitSnapshot();
      return {
        undoToken: "",
        organisedTabCount: undo.organisedTabCount,
        groupCount: undo.groupCount,
      };
    } finally {
      this.aiTabOrganizationMutationInProgress = false;
    }
  }

  searchTabs(query: string): TabSearchResult[] {
    const needle = query.trim().toLocaleLowerCase();
    const memoryByProcessId = this.rendererMemoryByProcessId();
    const score = (title: string, url: string): number => {
      if (!needle) return 1;
      const lowerTitle = title.toLocaleLowerCase();
      const lowerUrl = url.toLocaleLowerCase();
      if (lowerTitle === needle || lowerUrl === needle) return 5;
      if (lowerTitle.startsWith(needle)) return 4;
      if (lowerUrl.startsWith(needle)) return 3;
      return lowerTitle.includes(needle) || lowerUrl.includes(needle) ? 2 : 0;
    };
    const open = this.order
      .map((tabId, index) => {
        const tab = this.requireTab(tabId);
        return { tab, index, score: score(tab.title, tab.url) };
      })
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          Number(right.tab.id === this.activeTabId) -
            Number(left.tab.id === this.activeTabId) ||
          left.index - right.index,
      )
      .map(
        ({ tab }): TabSearchResult => ({
          kind: "open",
          id: tab.id,
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          groupId: tab.groupId,
          isActive: tab.id === this.activeTabId,
          isAudible: this.isTabAudible(tab),
          memoryBytes: this.tabMemoryBytes(tab, memoryByProcessId),
          closedAt: null,
        }),
      );
    const closed = this.browserData.searchRecentlyClosedTabs(query).map(
      (tab): TabSearchResult => ({
        kind: "recently-closed",
        id: tab.id,
        tabId: null,
        title: tab.title,
        url: tab.url,
        groupId: tab.groupId,
        isActive: false,
        isAudible: false,
        memoryBytes: null,
        closedAt: tab.closedAt,
      }),
    );
    return [...open, ...closed].slice(0, 100);
  }

  async reopenClosedWindow(id?: string): Promise<TabId[]> {
    const finish = this.beginTabTopologyMutation();
    try {
      const closed = await this.browserData.takeRecentlyClosedWindow(id);
      if (!closed) return [];
      const active = this.tabs.get(this.activeTabId);
      if (this.order.length === 1 && active?.isNewTab)
        this.closeTabWithoutHistory(active.id);
      const groupIdMap = new Map<string, string>();
      for (const group of closed.tabGroups) {
        const nextId = this.tabGroups.has(group.id) ? randomUUID() : group.id;
        groupIdMap.set(group.id, nextId);
        this.tabGroups.set(nextId, { ...group, id: nextId });
      }
      const created: TabId[] = [];
      const tabIdMap = new Map<TabId, TabId>();
      let activeId: TabId | null = null;
      for (const savedTab of closed.tabs) {
        const tabId = this.createTab(savedTab.url || undefined, false);
        const tab = this.requireTab(tabId);
        tab.title = savedTab.title;
        tab.pinned = savedTab.pinned;
        tab.groupId = savedTab.groupId
          ? (groupIdMap.get(savedTab.groupId) ?? null)
          : null;
        created.push(tabId);
        tabIdMap.set(savedTab.id, tabId);
        if (savedTab.id === closed.activeTabId) activeId = tabId;
      }
      const existingPairs = this.splitView.snapshot(this.activeTabId).pairs;
      const pairIds = new Set(existingPairs.map((pair) => pair.id));
      const restoredPairs = (closed.splitViewPairs ?? []).flatMap((pair) => {
        const leftTabId = tabIdMap.get(pair.leftTabId);
        const rightTabId = tabIdMap.get(pair.rightTabId);
        if (!leftTabId || !rightTabId) return [];
        const id = pairIds.has(pair.id) ? randomUUID() : pair.id;
        pairIds.add(id);
        return [
          {
            ...pair,
            id,
            leftTabId,
            rightTabId,
            focusedTabId:
              pair.focusedTabId === pair.rightTabId ? rightTabId : leftTabId,
          },
        ];
      });
      this.splitView.restore(
        [...existingPairs, ...restoredPairs],
        this.splitEligibleTabIds(),
      );
      this.sortPinnedTabsFirst();
      if (created.length === 0) this.createTab();
      else this.activateTab(activeId ?? created[0]);
      this.onBrowserDataChanged();
      this.emitSnapshot();
      this.scheduleSessionSave();
      return created;
    } finally {
      finish();
    }
  }

  async navigate(tabId: TabId, input: string, typed = false): Promise<void> {
    if (tabId === this.activeTabId) this.extensionPopup?.close();
    if (isGalleryUrl(input.trim())) {
      const tab = this.requireTab(tabId);
      this.splitView.removeTab(tab.id);
      this.destroyView(tab);
      const requested = new URL(input.trim());
      const entryId = requested.searchParams.get("video");
      tab.url = `chromecraft://gallery/${entryId ? `?video=${encodeURIComponent(entryId)}` : ""}`;
      tab.requestedUrl = tab.url;
      tab.title = "My Gallery";
      tab.isNewTab = false;
      tab.isLoading = false;
      tab.error = null;
      this.activateTab(tab.id);
      this.emitSnapshot();
      this.scheduleSessionSave();
      return;
    }
    if (isOfflinePagesUrl(input.trim())) {
      const tab = this.requireTab(tabId);
      this.splitView.removeTab(tab.id);
      this.destroyView(tab);
      const requested = new URL(input.trim());
      const entryId = requested.searchParams.get("page");
      tab.url = `chromecraft://offline-pages/${
        entryId ? `?page=${encodeURIComponent(entryId)}` : ""
      }`;
      tab.requestedUrl = tab.url;
      tab.title = "Offline Pages";
      tab.isNewTab = false;
      tab.isLoading = false;
      tab.error = null;
      this.activateTab(tab.id);
      this.emitSnapshot();
      this.scheduleSessionSave();
      return;
    }
    const target = resolveNavigationInput(input);
    if (target)
      await this.navigateToUrl(
        this.requireTab(tabId),
        target,
        false,
        true,
        typed && isNavigationInputAddress(input),
      );
  }

  goBack(tabId: TabId): void {
    const tab = this.requireTab(tabId);
    if (tab.view?.webContents.navigationHistory.canGoBack()) {
      this.invalidateSmartReader(tab);
      tab.view.webContents.navigationHistory.goBack();
    }
  }

  goForward(tabId: TabId): void {
    const tab = this.requireTab(tabId);
    if (tab.view?.webContents.navigationHistory.canGoForward()) {
      this.invalidateSmartReader(tab);
      tab.view.webContents.navigationHistory.goForward();
    }
  }

  reload(tabId: TabId): void {
    const tab = this.requireTab(tabId);
    this.invalidateSmartReader(tab);
    if (tab.crashed) {
      const target = tab.requestedUrl || tab.url;
      this.destroyView(tab);
      tab.crashed = false;
      tab.error = null;
      if (target)
        void this.navigateToUrl(
          tab,
          target,
          this.isAllowedInternalUrl(target),
          true,
        );
      return;
    }
    tab.view?.webContents.reload();
  }

  stop(tabId: TabId): void {
    this.requireTab(tabId).view?.webContents.stop();
  }

  getSmartReader(tabId: TabId): SmartReaderViewSnapshot {
    return this.smartReaderSnapshot(this.requireTab(tabId));
  }

  async toggleSmartReader(
    tabId: TabId,
    appearanceValue: unknown,
  ): Promise<SmartReaderViewSnapshot> {
    const tab = this.requireTab(tabId);
    if (tab.reader.active) {
      this.exitSmartReader(tab);
      return this.smartReaderSnapshot(tab);
    }
    if (!isAllowedWebUrl(tab.url)) {
      throw new Error("Smart Reader only supports web pages.");
    }
    if (!this.readerDocumentIsAvailable(tab)) {
      const detected = await this.requestSmartReaderExtraction(tab, false);
      if (!detected.article && detected.availability !== "available") {
        return detected;
      }
    }
    await this.enterSmartReader(
      tab,
      normalizeSmartReaderAppearance(appearanceValue),
    );
    return this.smartReaderSnapshot(tab);
  }

  async trySmartReader(
    tabId: TabId,
    appearanceValue: unknown,
  ): Promise<SmartReaderViewSnapshot> {
    const tab = this.requireTab(tabId);
    if (!isAllowedWebUrl(tab.url)) {
      throw new Error("Smart Reader only supports web pages.");
    }
    const detected = await this.requestSmartReaderExtraction(tab, true);
    if (detected.availability !== "available") return detected;
    await this.enterSmartReader(
      tab,
      normalizeSmartReaderAppearance(appearanceValue),
    );
    return this.smartReaderSnapshot(tab);
  }

  private async trySmartReaderFromNativeMenu(
    tabId: TabId,
    offerRetry = true,
  ): Promise<void> {
    let result: SmartReaderViewSnapshot | null = null;
    try {
      result = await this.trySmartReader(tabId, null);
    } catch {
      // The tab may have closed or navigated while extraction was running.
    }
    if (result?.active || !this.tabs.has(tabId) || this.window.isDestroyed()) {
      return;
    }
    const response = await dialog.showMessageBox({
      type: "info",
      title: "Smart Reader",
      message: "Smart Reader couldn't prepare this page.",
      detail:
        result?.error ??
        "No readable article was found. The original page has not been changed.",
      buttons: offerRetry ? ["Close", "Try again"] : ["Close"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (offerRetry && response.response === 1 && this.tabs.has(tabId)) {
      await this.trySmartReaderFromNativeMenu(tabId, false);
    }
  }

  async setSmartReaderAppearance(
    tabId: TabId,
    appearanceValue: unknown,
  ): Promise<SmartReaderViewSnapshot> {
    const tab = this.requireTab(tabId);
    if (!tab.readerView || tab.readerView.webContents.isDestroyed()) {
      return this.smartReaderSnapshot(tab);
    }
    await this.applySmartReaderAppearance(
      tab,
      normalizeSmartReaderAppearance(appearanceValue),
    );
    return this.smartReaderSnapshot(tab);
  }

  async toggleSavedArticle(tabId: TabId): Promise<SmartReaderViewSnapshot> {
    const tab = this.requireTab(tabId);
    const article = tab.readerArticle;
    if (!article || !tab.reader.active) {
      throw new Error("Open Smart Reader before saving this article.");
    }
    const existing = this.browserData.findSavedArticle(article.sourceUrl);
    if (existing) {
      await this.browserData.removeSavedArticle(existing.id);
    } else {
      const source = new URL(article.sourceUrl);
      source.username = "";
      source.password = "";
      source.hash = "";
      await this.browserData.saveArticle({
        canonicalUrl: source.href,
        originalUrl: article.sourceUrl,
        title: article.title,
        siteName: article.siteName || source.hostname,
        faviconDataUrl: tab.faviconDataUrl,
        description: article.excerpt,
      });
    }
    this.refreshSmartReaderSavedState();
    this.onBrowserDataChanged();
    this.emitSnapshot();
    return this.smartReaderSnapshot(tab);
  }

  refreshSmartReaderSavedState(): void {
    for (const tab of this.tabs.values()) {
      tab.reader.saved = Boolean(
        tab.readerArticle &&
        this.browserData.findSavedArticle(tab.readerArticle.sourceUrl),
      );
    }
    this.scheduleSnapshot();
  }

  async removeSavedArticle(id: string): Promise<void> {
    await this.browserData.removeSavedArticle(id);
    this.refreshSmartReaderSavedState();
    this.onBrowserDataChanged();
    this.emitSnapshot();
  }

  async setSavedArticleRead(id: string, isRead: boolean): Promise<void> {
    await this.browserData.setSavedArticleRead(id, isRead);
    this.onBrowserDataChanged();
  }

  async copySavedArticleLink(id: string): Promise<void> {
    const article = this.browserData.findSavedArticleById(id);
    if (!article) throw new Error("This saved article is no longer available.");
    clipboard.writeText(article.originalUrl);
  }

  openSavedArticle(
    id: string,
    appearanceValue: unknown,
  ): Promise<SavedArticleOpenResult> {
    const article = this.browserData.findSavedArticleById(id);
    if (!article) throw new Error("This saved article is no longer available.");
    const appearance = normalizeSmartReaderAppearance(appearanceValue);
    const tabId = this.createTab(undefined, false);
    const tab = this.requireTab(tabId);

    return new Promise<SavedArticleOpenResult>((resolve) => {
      const timer = setTimeout(() => {
        this.finishSavedArticleReader(
          tabId,
          false,
          "Smart Reader was unavailable for this article. The original page is still open.",
        );
      }, SAVED_ARTICLE_READER_DEADLINE_MS);
      this.pendingSavedArticleReaders.set(tabId, {
        appearance,
        expectedRevision: null,
        loadComplete: false,
        extracting: false,
        retryRequested: false,
        timer,
        resolve,
      });
      void this.navigateToUrl(tab, article.originalUrl, false, true).catch(
        (error: unknown) => {
          this.finishSavedArticleReader(
            tabId,
            false,
            error instanceof Error
              ? error.message
              : "The saved article could not be opened.",
          );
        },
      );
    });
  }

  async setSmartReaderProgressVisible(
    tabId: TabId,
    visible: boolean,
  ): Promise<SmartReaderViewSnapshot> {
    const tab = this.requireTab(tabId);
    await this.preferences.setSmartReaderProgressVisible(visible);
    this.sendSmartReaderCommand(tab, {
      type: "set-progress-visible",
      visible,
      resumeProgress: this.meaningfulReadingPosition(tab),
    });
    this.emitSnapshot();
    return this.smartReaderSnapshot(tab);
  }

  runSmartReaderCommand(tabId: TabId, value: unknown): void {
    const tab = this.requireTab(tabId);
    if (!tab.reader.active) throw new Error("Smart Reader is not open.");
    if (!value || typeof value !== "object") {
      throw new TypeError("Unknown Smart Reader command.");
    }
    const type = (value as { type?: unknown }).type;
    if (
      type !== "toggle-navigation" &&
      type !== "toggle-narration" &&
      type !== "stop-narration"
    ) {
      throw new TypeError("Unknown Smart Reader command.");
    }
    if (type === "toggle-navigation") {
      tab.reader.navigationOpen = !tab.reader.navigationOpen;
    } else if (type === "toggle-narration") {
      tab.reader.narrationOpen = !tab.reader.narrationOpen;
    } else if (type === "stop-narration") {
      tab.reader.narrationOpen = false;
    }
    this.sendSmartReaderCommand(tab, { type } as SmartReaderCommand);
    this.emitSnapshot();
  }

  handleSmartReaderPanelClosed(source: WebContents, value: unknown): void {
    const tab = this.requireReaderTab(source);
    if (value === "navigation") tab.reader.navigationOpen = false;
    else if (value === "narration") tab.reader.narrationOpen = false;
    else throw new TypeError("Unknown Smart Reader panel.");
    this.emitSnapshot();
  }

  getSmartReaderArticleAttachment(tabId: TabId): AssistantAttachment {
    const tab = this.requireTab(tabId);
    const article = tab.readerArticle;
    if (!article || !tab.reader.active || tab.id !== this.activeTabId) {
      throw new Error("Open Smart Reader before attaching this article.");
    }
    return structuredClone({
      id: `reader-article-${tab.id}-${tab.reader.revision}`,
      kind: "full-reader-article" as const,
      label: "Full Reader Article",
      detail: article.title.slice(0, 160),
      createdAt: Date.now(),
      data: {
        readerArticle: {
          tabId: tab.id,
          revision: tab.reader.revision,
          url: article.sourceUrl,
          title: article.title,
          siteName: article.siteName,
          byline: article.byline,
          publishedTime: article.publishedTime,
          headings: [...article.headings],
          text: article.textContent,
          complete: article.textContentTruncated !== true,
        },
      },
    });
  }

  handleSmartReaderProgress(source: WebContents, value: unknown): void {
    const tab = this.requireReaderTab(source);
    const progress = Number(value);
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) return;
    tab.readerProgressValue = progress;
    if (tab.readerProgressTimer) clearTimeout(tab.readerProgressTimer);
    tab.readerProgressTimer = setTimeout(() => {
      tab.readerProgressTimer = null;
      void this.flushReadingPosition(tab);
    }, 2_000);
  }

  getSmartReaderNarrationCapabilities(
    source: WebContents,
  ): SmartReaderNarrationCapabilities {
    this.requireReaderTab(source);
    return (
      this.smartReaderNarration?.capabilities() ?? {
        gemini: {
          available: false,
          model: "gemini-3.8-flash-lite-tts",
          voices: [],
          reason: "Scout narration is unavailable.",
        },
        local: {
          available: false,
          reason: "No local AI speech engine is integrated in this build.",
          setupHint: "Use Standard system speech to stay on-device.",
        },
      }
    );
  }

  startSmartReaderGeminiNarration(
    source: WebContents,
    value: unknown,
  ): SmartReaderGeminiSession {
    const tab = this.requireReaderTab(source);
    if (!this.smartReaderNarration || !value || typeof value !== "object") {
      throw new Error("Gemini voiceover is unavailable.");
    }
    const request = value as { voice?: unknown; cloudConsent?: unknown };
    const capabilities = this.smartReaderNarration.capabilities();
    const voice = typeof request.voice === "string" ? request.voice : "";
    if (!request.cloudConsent) {
      throw new Error("Confirm sending this article text to Google first.");
    }
    if (
      !capabilities.gemini.available ||
      !capabilities.gemini.voices.includes(voice)
    ) {
      throw new Error(
        capabilities.gemini.reason ?? "Choose a supported Gemini voice.",
      );
    }
    const segments = splitNarrationText(tab.readerArticle!.textContent);
    if (!segments.length)
      throw new Error("This article has no text to narrate.");
    this.cancelNarrationForTab(tab);
    const id = randomUUID();
    this.readerNarrationSessions.set(id, {
      id,
      tabId: tab.id,
      revision: tab.reader.revision,
      voice,
      segments,
      activeRequestId: null,
    });
    return {
      id,
      segmentCount: segments.length,
      model: capabilities.gemini.model,
      voice,
    };
  }

  async getSmartReaderGeminiSegment(
    source: WebContents,
    sessionIdValue: unknown,
    indexValue: unknown,
  ): Promise<SmartReaderGeminiSegment> {
    const tab = this.requireReaderTab(source);
    const sessionId = typeof sessionIdValue === "string" ? sessionIdValue : "";
    const index = Number(indexValue);
    const session = this.readerNarrationSessions.get(sessionId);
    if (
      !session ||
      session.tabId !== tab.id ||
      session.revision !== tab.reader.revision ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= session.segments.length ||
      !this.smartReaderNarration
    ) {
      throw new Error("That voiceover session is no longer available.");
    }
    if (session.activeRequestId) {
      throw new Error("Wait for the current voiceover part to finish.");
    }
    const requestId = randomUUID();
    session.activeRequestId = requestId;
    try {
      const audio = await this.smartReaderNarration.synthesize(
        requestId,
        session.segments[index],
        session.voice,
      );
      if (this.readerNarrationSessions.get(sessionId) !== session) {
        throw new DOMException("Cancelled", "AbortError");
      }
      return {
        sessionId,
        index,
        segmentCount: session.segments.length,
        mimeType: audio.mimeType,
        audioBase64: audio.data,
      };
    } finally {
      if (session.activeRequestId === requestId) session.activeRequestId = null;
    }
  }

  cancelSmartReaderGeminiNarration(
    source: WebContents,
    sessionIdValue?: unknown,
  ): void {
    const tab = this.requireReaderTab(source);
    const sessionId =
      typeof sessionIdValue === "string" ? sessionIdValue : null;
    if (sessionId) {
      const session = this.readerNarrationSessions.get(sessionId);
      if (session?.tabId === tab.id) this.cancelNarrationSession(session);
      return;
    }
    this.cancelNarrationForTab(tab);
  }

  getSmartReaderSummary(source: WebContents): SmartReaderSummarySnapshot {
    return this.smartReaderSummarySnapshot(this.requireReaderTab(source));
  }

  async refreshSmartReaderSummaryModels(
    source: WebContents,
    provider: unknown,
  ): Promise<SmartReaderSummarySnapshot> {
    const tab = this.requireReaderTab(source);
    const selected = this.requireSummaryProvider(provider);
    if (!this.smartReaderSummary) throw new Error("Scout is unavailable.");
    await this.smartReaderSummary.refresh(selected);
    return this.smartReaderSummarySnapshot(tab);
  }

  async setSmartReaderSummaryPreference(
    source: WebContents,
    value: unknown,
  ): Promise<SmartReaderSummarySnapshot> {
    const tab = this.requireReaderTab(source);
    const request = this.requireSummaryRequest(value, false);
    if (!this.smartReaderSummary) throw new Error("Scout is unavailable.");
    await this.smartReaderSummary.setPreference(
      request.provider,
      request.model,
    );
    this.sendSmartReaderSummary(tab);
    return this.smartReaderSummarySnapshot(tab);
  }

  async setSmartReaderSummaryConsent(
    source: WebContents,
    granted: unknown,
  ): Promise<SmartReaderSummarySnapshot> {
    const tab = this.requireReaderTab(source);
    if (typeof granted !== "boolean") {
      throw new TypeError("Choose whether Gemini may process Reader articles.");
    }
    if (!this.smartReaderSummary) throw new Error("Scout is unavailable.");
    await this.smartReaderSummary.setConsent(granted);
    this.sendSmartReaderSummary(tab);
    return this.smartReaderSummarySnapshot(tab);
  }

  async generateSmartReaderSummary(
    source: WebContents,
    value: unknown,
  ): Promise<SmartReaderSummarySnapshot> {
    const tab = this.requireReaderTab(source);
    const request = this.requireSummaryRequest(value, true);
    const article = tab.readerArticle;
    if (!article || !this.smartReaderSummary) {
      throw new Error("This Reader article is no longer available.");
    }
    if (tab.readerSummary.requestId) {
      this.smartReaderSummary.cancel(tab.readerSummary.requestId);
    }
    const requestId = randomUUID();
    const revision = tab.reader.revision;
    const previousResult = tab.readerSummary.result;
    tab.readerSummary = {
      stage: "loading",
      requestId,
      result: previousResult,
      error: null,
    };
    this.sendSmartReaderSummary(tab);
    try {
      const result = await this.smartReaderSummary.generate(
        requestId,
        article,
        request,
      );
      if (
        !this.tabs.has(tab.id) ||
        tab.reader.revision !== revision ||
        tab.readerArticle !== article ||
        tab.readerSummary.requestId !== requestId
      ) {
        return this.smartReaderSummarySnapshot(tab);
      }
      tab.readerSummary = {
        stage: "ready",
        requestId: null,
        result,
        error: null,
      };
    } catch (error) {
      if (
        this.tabs.has(tab.id) &&
        tab.reader.revision === revision &&
        tab.readerArticle === article &&
        tab.readerSummary.requestId === requestId
      ) {
        tab.readerSummary = {
          stage: previousResult ? "ready" : "error",
          requestId: null,
          result: previousResult,
          error:
            error instanceof Error
              ? error.message
              : "Scout could not finish this summary.",
        };
      }
    }
    this.sendSmartReaderSummary(tab);
    return this.smartReaderSummarySnapshot(tab);
  }

  cancelSmartReaderSummary(source: WebContents): SmartReaderSummarySnapshot {
    const tab = this.requireReaderTab(source);
    this.cancelSummaryForTab(tab);
    this.sendSmartReaderSummary(tab);
    return this.smartReaderSummarySnapshot(tab);
  }

  dismissSmartReaderSummary(source: WebContents): SmartReaderSummarySnapshot {
    const tab = this.requireReaderTab(source);
    this.cancelSummaryForTab(tab);
    tab.readerSummary = {
      stage: "idle",
      requestId: null,
      result: null,
      error: null,
    };
    this.sendSmartReaderSummary(tab);
    return this.smartReaderSummarySnapshot(tab);
  }

  async copySmartReaderSummary(source: WebContents): Promise<void> {
    const tab = this.requireReaderTab(source);
    const points = tab.readerSummary.result?.points;
    if (!points?.length) return;
    await clipboard.writeText(points.map((point) => `• ${point}`).join("\n"));
  }

  handleSmartReaderExtractionResult(source: WebContents, value: unknown): void {
    if (!value || typeof value !== "object") return;
    const result = value as Partial<SmartReaderExtractionResult>;
    if (
      typeof result.requestId !== "string" ||
      typeof result.sourceUrl !== "string" ||
      typeof result.revision !== "number" ||
      typeof result.available !== "boolean"
    ) {
      return;
    }
    const pending = this.pendingReaderExtractions.get(result.requestId);
    if (!pending) return;
    const tab = this.tabs.get(pending.tabId);
    if (
      !tab ||
      tab.view?.webContents !== source ||
      tab.readerPendingRequestId !== result.requestId ||
      tab.reader.revision !== pending.revision ||
      result.revision !== pending.revision ||
      result.sourceUrl !== tab.url
    ) {
      this.finishReaderExtraction(result.requestId, tab);
      if (
        tab &&
        this.tabs.has(tab.id) &&
        tab.view?.webContents === source &&
        tab.reader.revision === pending.revision &&
        isAllowedWebUrl(tab.url)
      ) {
        tab.reader.availability = "unavailable";
        tab.readerError = null;
        this.scheduleReaderMutationDetection(tab, 100);
        this.scheduleSnapshot();
      }
      return;
    }

    tab.readerPendingRequestId = null;
    tab.readerError =
      typeof result.error === "string" && result.error
        ? result.error.slice(0, 500)
        : null;
    if (
      result.available &&
      this.isValidReaderArticle(result.article, tab.url)
    ) {
      this.smartReaderDocuments.removeUrl(tab.readerDocumentUrl);
      try {
        tab.readerDocumentUrl = this.smartReaderDocuments.put(
          renderSmartReaderDocument(
            result.article,
            normalizeSmartReaderAppearance(null),
          ),
        );
        tab.readerArticle = structuredClone(result.article);
        this.resetSummaryForTab(tab);
        tab.reader.availability = "available";
        tab.readerError = null;
        this.clearReaderTimers(tab);
      } catch (error) {
        tab.readerDocumentUrl = null;
        tab.reader.availability = "error";
        tab.readerError =
          error instanceof Error ? error.message : "Reader preparation failed.";
      }
    } else {
      tab.reader.availability = tab.readerError ? "error" : "unavailable";
    }
    this.finishReaderExtraction(result.requestId, tab);
    this.scheduleSnapshot();
    if (
      tab.reader.availability === "available" &&
      this.pendingSavedArticleReaders.has(tab.id)
    ) {
      void this.attemptSavedArticleReader(tab);
    }
  }

  toggleMute(tabId: TabId): void {
    const tab = this.requireTab(tabId);
    tab.isMuted = !tab.isMuted;
    tab.view?.webContents.setAudioMuted(tab.isMuted);
    this.emitSnapshot();
  }

  setZoom(tabId: TabId, factor: number): void {
    if (!Number.isFinite(factor))
      throw new TypeError("Zoom factor must be finite.");
    const tab = this.requireTab(tabId);
    tab.zoomFactor = Math.min(5, Math.max(0.25, factor));
    for (const view of [tab.view, tab.readerView]) {
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.setZoomFactor(tab.zoomFactor);
      }
    }
    this.emitSnapshot();
  }

  findInPage(tabId: TabId, text: string, forward: boolean): void {
    if (text.length > 1024) throw new RangeError("Find text is too long.");
    const tab = this.requireTab(tabId);
    const contents = tab.reader.active
      ? tab.readerView?.webContents
      : tab.view?.webContents;
    if (!contents || contents.isDestroyed() || !text) return;
    tab.findRequestId = contents.findInPage(text, {
      forward,
      findNext: tab.lastFindText === text,
    });
    tab.lastFindText = text;
  }

  stopFindInPage(tabId: TabId): void {
    const tab = this.requireTab(tabId);
    tab.lastFindText = "";
    tab.findRequestId = 0;
    for (const view of [tab.view, tab.readerView]) {
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.stopFindInPage("clearSelection");
      }
    }
  }

  setFullscreen(fullscreen: boolean): void {
    this.extensionPopup?.close();
    if (!fullscreen && this.htmlFullscreenTabId) {
      const tab = this.tabs.get(this.htmlFullscreenTabId);
      if (tab) this.exitWebsiteFullscreen(tab, false);
      else this.htmlFullscreenTabId = null;
    }
    this.window.setFullScreen(fullscreen);
  }

  canGrantWebsiteFullscreen(
    contents: WebContents,
    permission: string,
  ): boolean {
    const context = this.getActiveWebsitePermissionContext(contents);
    const allowed = Boolean(
      context &&
      isWebsiteFullscreenPermissionAllowed(permission, context.topLevelUrl),
    );
    if (
      allowed &&
      !context?.websiteFullscreen &&
      this.pendingHtmlFullscreen?.tabId !== this.activeTabId
    ) {
      this.pendingHtmlFullscreen = {
        tabId: this.activeTabId,
        restoreBrowserFullscreen: this.window.isFullScreen(),
        requestedAt: Date.now(),
      };
    }
    return allowed;
  }

  getActiveWebsitePermissionContext(
    contents: WebContents,
  ): ActiveWebsitePermissionContext | null {
    if (
      contents.isDestroyed() ||
      this.window.isDestroyed() ||
      !this.window.isVisible() ||
      !this.window.isFocused()
    )
      return null;
    const active = this.tabs.get(this.activeTabId);
    if (
      !active?.view ||
      active.view.webContents !== contents ||
      !isAllowedWebUrl(contents.getURL())
    )
      return null;
    return {
      topLevelUrl: contents.getURL(),
      websiteFullscreen: this.htmlFullscreenTabId === active.id,
      documentId: `${active.id}:${active.documentEpoch}`,
    };
  }

  async setSidebarOpen(open: boolean): Promise<void> {
    await this.preferences.setSidebarOpen(open);
    this.layoutActiveView();
    this.emitSnapshot();
  }

  async setSidebarAttached(attached: boolean): Promise<void> {
    await this.preferences.setSidebarAttached(attached);
    this.layoutActiveView();
    this.emitSnapshot();
  }

  async setBookmarkBarVisible(visible: boolean): Promise<void> {
    await this.preferences.setBookmarkBarVisible(visible);
    this.layoutActiveView();
    this.emitSnapshot();
  }

  async setRestoreSession(enabled: boolean): Promise<void> {
    await this.preferences.setRestoreSession(enabled);
    if (enabled) await this.flushSession();
    else await this.browserData.clearSession();
    this.emitSnapshot();
  }

  async setNewTabTheme(theme: NewTabTheme): Promise<void> {
    await this.preferences.setNewTabTheme(theme);
    this.emitSnapshot();
  }

  async setRemoteSearchSuggestionsEnabled(enabled: boolean): Promise<void> {
    await this.preferences.setRemoteSearchSuggestionsEnabled(enabled);
    this.emitSnapshot();
  }

  async setExtensionDeveloperMode(enabled: boolean): Promise<void> {
    await this.preferences.setExtensionDeveloperMode(enabled);
    this.emitSnapshot();
  }

  async setExtensionToolbarPinned(
    extensionId: string,
    pinned: boolean,
  ): Promise<void> {
    await this.preferences.setExtensionToolbarPinned(extensionId, pinned);
    if (!pinned && this.extensionPopupId === extensionId) {
      this.closeExtensionPopup();
    } else {
      this.onExtensionsChanged();
    }
  }

  async setToolbarActionPinned(
    action: ToolbarAction,
    pinned: boolean,
  ): Promise<void> {
    await this.preferences.setToolbarActionPinned(action, pinned);
    this.emitSnapshot();
  }

  async setShowDownloadProgressInToolbar(enabled: boolean): Promise<void> {
    await this.preferences.setShowDownloadProgressInToolbar(enabled);
    this.layoutActiveView();
    this.emitSnapshot();
  }

  async setShowDownloadCompletionNotification(enabled: boolean): Promise<void> {
    await this.preferences.setShowDownloadCompletionNotification(enabled);
    this.emitSnapshot();
  }

  async setAddVideosToGallery(enabled: boolean): Promise<void> {
    await this.preferences.setAddVideosToGallery(enabled);
    this.emitSnapshot();
  }

  get hyperdriveSnapshot(): HyperdriveSnapshot {
    return this.hyperdrive.snapshot;
  }

  async setHyperdriveMode(mode: HyperdriveMode): Promise<void> {
    await this.hyperdrive.setMode(mode);
    this.emitSnapshot();
  }

  async setHyperdriveRamBudgetMb(megabytes: number): Promise<void> {
    await this.hyperdrive.setRamBudgetMb(megabytes);
    this.emitSnapshot();
  }

  async setHyperdriveCrossSitePreloadingEnabled(
    enabled: boolean,
  ): Promise<void> {
    await this.hyperdrive.setCrossSiteEnabled(enabled);
    this.emitSnapshot();
  }

  async setHyperdriveSearchPreloadingEnabled(enabled: boolean): Promise<void> {
    await this.hyperdrive.setSearchPreloadingEnabled(enabled);
    this.emitSnapshot();
  }

  async setHyperdriveExcludedHosts(hosts: string[]): Promise<void> {
    await this.hyperdrive.setExcludedHosts(hosts);
    this.emitSnapshot();
  }

  async setHyperdriveMonitorOpen(open: boolean): Promise<void> {
    await this.hyperdrive.setMonitorOpen(open);
    this.layoutActiveView();
    this.emitSnapshot();
  }

  async setHyperdriveDeveloperMode(enabled: boolean): Promise<void> {
    await this.preferences.setHyperdriveDeveloperMode(enabled);
    if (!enabled) this.hyperdrive.setMonitorPaused(false);
    this.emitSnapshot();
  }

  setHyperdriveMonitorPaused(paused: boolean): void {
    this.hyperdrive.setMonitorPaused(paused);
  }

  clearHyperdriveSpeculation(): void {
    this.hyperdrive.clearSpeculation();
  }

  clearHyperdriveEvents(): void {
    this.hyperdrive.clearEvents();
  }

  updateHyperdriveOmnibox(signal: HyperdriveOmniboxSignal): void {
    if (signal.tabId !== this.activeTabId) return;
    const active = this.tabs.get(this.activeTabId);
    if (!active) return;
    this.hyperdrive.updateOmnibox(signal, active.url);
  }

  sendHyperdrivePreparation(
    tabId: string,
    request: { id: string; url: string },
  ): void {
    const contents = this.tabs.get(tabId)?.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.send(channels.hyperdrivePrepareDocument, request);
  }

  cancelHyperdrivePreparation(tabId: string, id: string): void {
    const contents = this.tabs.get(tabId)?.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.send(channels.hyperdriveCancelDocument, id);
  }

  async setUblockEnabled(enabled: boolean): Promise<void> {
    try {
      await this.ublock.setEnabled(enabled);
    } finally {
      this.hyperdrive.refreshPreparationReadiness();
      this.emitSnapshot();
    }
  }

  refreshProtectionState(): void {
    this.hyperdrive.refreshPreparationReadiness();
    this.emitSnapshot();
  }

  openUblockDashboard(): void {
    const dashboardUrl = this.ublock.getDashboardUrl();
    if (!dashboardUrl) return;
    const tabId = this.createTab();
    void this.navigateToUrl(this.requireTab(tabId), dashboardUrl, true, true);
  }

  openExtensionPage(url: string): void {
    if (!this.extensions?.isAllowedExtensionUrl(url)) return;
    const tabId = this.createTab();
    void this.navigateToUrl(this.requireTab(tabId), url, true, true);
  }

  async toggleExtensionPopup(
    extensionId: string,
    anchor: ExtensionPopupAnchor,
    popupUrl?: string,
  ): Promise<void> {
    if (!this.extensionPopup) throw new Error("Extensions are unavailable.");
    await this.extensionPopup.toggle(extensionId, anchor, popupUrl);
  }

  async openExtensionPopup(
    extensionId: string,
    popupUrl: string,
  ): Promise<void> {
    if (!this.extensionPopup) throw new Error("Extensions are unavailable.");
    await this.extensionPopup.open(extensionId, popupUrl);
  }

  closeExtensionPopup(): void {
    this.extensionPopup?.close();
  }

  focusOmnibox(): void {
    if (!this.shellView.webContents.isDestroyed()) {
      this.shellView.webContents.focus();
      this.shellView.webContents.send(channels.focusOmnibox);
    }
  }

  async flushSession(): Promise<void> {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    await Promise.all(
      [...this.tabGroups.values()]
        .filter((group) => group.saved)
        .map((group) => this.syncSavedTabGroup(group)),
    );
    if (!this.preferences.snapshot.restoreSession || this.order.length === 0)
      return;
    const tabs = this.serializableTabs();
    if (tabs.length === 0) {
      await this.browserData.clearSession();
      return;
    }
    const activeId = tabs.some((tab) => tab.id === this.activeTabId)
      ? this.activeTabId
      : tabs[0].id;
    await this.browserData.saveSession(
      tabs,
      activeId,
      this.serializableTabGroups(tabs),
      this.splitView.snapshot(activeId).pairs,
    );
  }

  async flushWindowStateForClose(): Promise<void> {
    await Promise.all(
      [...this.tabs.values()].map((tab) => {
        if (tab.readerProgressTimer) clearTimeout(tab.readerProgressTimer);
        tab.readerProgressTimer = null;
        return this.flushReadingPosition(tab);
      }),
    );
    if (this.preferences.snapshot.restoreSession) {
      await this.flushSession();
      return;
    }
    const tabs = this.serializableTabs();
    if (tabs.length === 0) return;
    await this.browserData.addRecentlyClosedWindow({
      tabs,
      tabGroups: this.serializableTabGroups(tabs),
      splitViewPairs: this.splitView.snapshot(this.activeTabId).pairs,
      activeTabId: tabs.some((tab) => tab.id === this.activeTabId)
        ? this.activeTabId
        : tabs[0].id,
    });
    this.onBrowserDataChanged();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tabId of this.pendingSavedArticleReaders.keys()) {
      this.finishSavedArticleReader(
        tabId,
        false,
        "The browser closed before Smart Reader could open this article.",
      );
    }
    this.extensionPopup?.dispose();
    this.fullscreenHint.dispose();
    if (this.fullscreenRestoreTimer) clearTimeout(this.fullscreenRestoreTimer);
    this.fullscreenRestoreTimer = null;
    for (const extensionWindow of this.extensionWindows) {
      if (!extensionWindow.isDestroyed()) extensionWindow.destroy();
    }
    this.extensionWindows.clear();
    void this.flushSession().catch((error) =>
      console.warn("Could not save the browser session.", error),
    );
    for (const tab of this.tabs.values()) this.destroyView(tab);
    this.smartReaderDocuments.clear();
    this.tabs.clear();
    this.order.length = 0;
    this.extensionTabs.dispose();
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.snapshotTimer = null;
    this.layoutTimer = null;
    this.sessionTimer = null;
    if (!this.shellView.webContents.isDestroyed())
      this.shellView.webContents.close();
  }

  private makeTab(
    id: string,
    title: string,
    url: string,
    isNewTab: boolean,
    groupId: string | null = null,
    pinned = false,
  ): TabRecord {
    const tab: TabRecord = {
      id,
      title: title || "New Tab",
      url,
      faviconDataUrl: null,
      requestedUrl: url,
      isNewTab,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      error: null,
      isMuted: false,
      zoomFactor: 1,
      pinned,
      view: null,
      lastHistoryUrl: "",
      lastFindText: "",
      findRequestId: 0,
      nextHistoryEntryTyped: false,
      documentEpoch: 0,
      dismissedWebStoreExtensionId: null,
      dismissedYouTubeVideoId: null,
      webStoreListingTitle: null,
      webStoreListingDescription: null,
      groupId,
      thumbnailDataUrl: null,
      reader: {
        availability: "unavailable",
        active: false,
        revision: 0,
        saved: false,
        navigationOpen: false,
        narrationOpen: false,
      },
      readerView: null,
      readerDocumentUrl: null,
      readerPendingRequestId: null,
      readerError: null,
      readerAppearanceCssKey: null,
      readerAppearanceRevision: 0,
      readerMutationTimer: null,
      readerTimers: new Set(),
      readerProgressTimer: null,
      readerProgressValue: null,
      readerArticle: null,
      readerSummary: {
        stage: "idle",
        requestId: null,
        result: null,
        error: null,
      },
    };
    return tab;
  }

  private async navigateToUrl(
    tab: TabRecord,
    target: string,
    internal: boolean,
    activate: boolean,
    typed = false,
  ): Promise<void> {
    if (!internal && !isAllowedWebUrl(target)) return;
    if (internal && !this.isAllowedInternalUrl(target)) return;
    if (!internal) {
      await this.ublock.readyForNavigation();
      if (!this.tabs.has(tab.id)) return;
    }
    this.invalidateSmartReader(tab);
    // Attach the real Electron target before mutating navigation state so the
    // extension event stream observes one canonical native tab ID from
    // creation through the first navigation.
    const view = this.ensureView(tab);
    this.resetWebStoreVisitIfChanged(tab, target);
    this.resetYouTubeVisitIfChanged(tab, target);
    tab.title = "Loading…";
    if (tab.url !== target) tab.faviconDataUrl = null;
    tab.url = target;
    tab.requestedUrl = target;
    tab.isNewTab = false;
    tab.isLoading = true;
    tab.crashed = false;
    tab.error = null;
    tab.nextHistoryEntryTyped = typed;
    this.extensionTabs.update(tab.id, {
      title: tab.title,
      url: tab.url,
      status: "loading",
    });
    const changedActiveTab = activate && tab.id !== this.activeTabId;
    if (activate) this.activateTab(tab.id);
    if (!changedActiveTab) this.scheduleSnapshot();
    this.scheduleSessionSave();
    void view.webContents.loadURL(target).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ERR_ABORTED"))
        console.warn(`Navigation failed for ${target}: ${message}`);
    });
    if (tab.id === this.activeTabId || this.splitView.pairForTab(tab.id))
      this.layoutActiveView();
  }

  private ensureView(tab: TabRecord): WebContentsView {
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view;
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "page-preload.cjs"),
        session: this.browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
        spellcheck: false,
        backgroundThrottling: true,
      },
    });
    tab.view = view;
    this.window.contentView.addChildView(view);
    view.setBounds(this.currentPageBounds());
    view.setVisible(false);
    this.attachShortcutHandler(view);
    const contents = view.webContents;
    contents.setZoomMode("isolated");
    contents.setZoomFactor(tab.zoomFactor);
    contents.on("found-in-page", (_event, result) => {
      if (
        result.requestId !== tab.findRequestId ||
        tab.id !== this.activeTabId ||
        this.shellView.webContents.isDestroyed()
      ) {
        return;
      }
      const snapshot: FindResultSnapshot = {
        requestId: result.requestId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate,
      };
      this.shellView.webContents.send(channels.findResult, snapshot);
    });
    contents.on("zoom-changed", () =>
      queueMicrotask(() => {
        if (!contents.isDestroyed() && tab.reader.active) {
          tab.zoomFactor = contents.getZoomFactor();
          if (tab.view && !tab.view.webContents.isDestroyed()) {
            tab.view.webContents.setZoomFactor(tab.zoomFactor);
          }
          this.scheduleSnapshot();
        }
      }),
    );
    contents.on("focus", () => {
      if (
        this.tabs.has(tab.id) &&
        tab.id !== this.activeTabId &&
        this.splitView.pairForTab(tab.id)
      ) {
        this.activateTab(tab.id);
      }
    });
    contents.on("context-menu", (_event, params) => {
      if (
        !this.tabs.has(tab.id) ||
        contents.isDestroyed() ||
        this.window.isDestroyed()
      )
        return;
      this.extensionPopup?.close();
      const withLiveTab = (action: () => void) => () => {
        if (!this.tabs.has(tab.id) || contents.isDestroyed()) return;
        action();
      };
      const menu = Menu.buildFromTemplate(
        buildPageContextMenu(
          params,
          {
            canGoBack: contents.navigationHistory.canGoBack(),
            canGoForward: contents.navigationHistory.canGoForward(),
          },
          {
            goBack: withLiveTab(() => this.goBack(tab.id)),
            goForward: withLiveTab(() => this.goForward(tab.id)),
            reload: withLiveTab(() => this.reload(tab.id)),
            openInNewTab: (url) =>
              withLiveTab(() =>
                this.runNativeTabTopologyAction(() => this.createTab(url)),
              )(),
            download: (url) => {
              if (!contents.isDestroyed()) contents.downloadURL(url);
            },
            copyText: (text) =>
              clipboard
                .writeText(text)
                .catch((error: unknown) =>
                  console.warn("Could not copy context-menu text.", error),
                ),
            copyImageAt: (x, y) => {
              if (!contents.isDestroyed()) contents.copyImageAt(x, y);
            },
            inspectAt: (x, y) => {
              if (!contents.isDestroyed()) contents.inspectElement(x, y);
            },
            trySmartReader: isAllowedWebUrl(tab.url)
              ? () => {
                  void this.trySmartReaderFromNativeMenu(tab.id);
                }
              : undefined,
          },
        ),
      );
      menu.popup({
        window: this.window,
        frame: params.frame ?? undefined,
        sourceType: params.menuSourceType,
      });
    });
    this.extensionTabs.attach(tab.id, contents.id, {
      title: tab.title,
      url: tab.url,
      status: tab.isLoading ? "loading" : "complete",
    });
    contents.once("destroyed", () => {
      this.onWebsiteDocumentInvalidated?.(contents);
      if (this.htmlFullscreenTabId === tab.id) {
        this.finishWebsiteFullscreen(tab.id);
        if (!this.window.isDestroyed()) this.window.setFullScreen(false);
      }
      if (this.pendingHtmlFullscreen?.tabId === tab.id)
        this.pendingHtmlFullscreen = null;
      this.extensionTabs.remove(tab.id, contents.id);
      if (tab.view === view) tab.view = null;
      if (this.tabs.has(tab.id) && tab.id === this.activeTabId)
        this.extensionTabs.activate(tab.id);
      if (this.tabs.has(tab.id)) this.layoutActiveView();
    });
    contents.on("enter-html-full-screen", () => {
      if (
        tab.id !== this.activeTabId ||
        tab.view !== view ||
        !isAllowedWebUrl(contents.getURL())
      ) {
        this.requestDocumentFullscreenExit(contents);
        return;
      }
      const pending = this.pendingHtmlFullscreen;
      this.htmlFullscreenRestoreBrowserFullscreen = Boolean(
        pending?.tabId === tab.id &&
        Date.now() - pending.requestedAt <= 5_000 &&
        pending.restoreBrowserFullscreen,
      );
      this.pendingHtmlFullscreen = null;
      this.htmlFullscreenTabId = tab.id;
      this.extensionPopup?.close();
      this.layoutActiveView();
      this.fullscreenHint.show();
      contents.focus();
    });
    contents.on("leave-html-full-screen", () => {
      if (!this.finishWebsiteFullscreen(tab.id)) return;
      if (!contents.isDestroyed()) contents.focus();
    });
    contents.ipc.on(channels.closeExtensionPopup, () => {
      if (tab.id !== this.activeTabId || contents.isDestroyed()) return;
      this.closeExtensionPopup();
    });
    contents.ipc.on(channels.hyperdrivePageSignals, (event, value: unknown) => {
      if (
        event.senderFrame !== contents.mainFrame ||
        tab.id !== this.activeTabId ||
        contents.isDestroyed()
      ) {
        return;
      }
      this.hyperdrive.updatePageSignals(tab.id, contents.getURL(), value);
    });
    contents.ipc.on(
      channels.smartDownloadsPlayback,
      (event, value: unknown) => {
        if (
          event.senderFrame !== contents.mainFrame ||
          tab.id !== this.activeTabId ||
          contents.isDestroyed() ||
          !value ||
          typeof value !== "object"
        ) {
          return;
        }
        const current = parseYouTubeWatchUrl(contents.getURL());
        const signal = value as Record<string, unknown>;
        if (
          !current ||
          typeof signal.observationId !== "string" ||
          signal.observationId.length < 1 ||
          signal.observationId.length > 160 ||
          typeof signal.videoId !== "string" ||
          signal.videoId !== current.videoId ||
          !/^[A-Za-z0-9_-]{11}$/u.test(signal.videoId) ||
          typeof signal.playbackSeconds !== "number" ||
          !Number.isFinite(signal.playbackSeconds) ||
          signal.playbackSeconds < 5 ||
          signal.playbackSeconds > 120 ||
          typeof signal.occurredAt !== "number" ||
          !Number.isSafeInteger(signal.occurredAt) ||
          Math.abs(Date.now() - signal.occurredAt) > 60_000
        ) {
          return;
        }
        this.onYouTubePlayback?.({
          observationId: signal.observationId,
          videoId: signal.videoId,
          playbackSeconds: signal.playbackSeconds,
          occurredAt: signal.occurredAt,
        });
      },
    );
    contents.ipc.on(
      channels.hyperdrivePreparationResult,
      (event, value: unknown) => {
        if (event.senderFrame !== contents.mainFrame) return;
        this.hyperdrive.handlePreparationResult(tab.id, value);
      },
    );
    contents.ipc.on(
      channels.assistantSelectionResult,
      (event, value: unknown) => {
        if (event.senderFrame !== contents.mainFrame || contents.isDestroyed())
          return;
        void this.handleAssistantSelection(tab, contents, value);
      },
    );
    contents.ipc.on(
      channels.smartReaderExtractionResult,
      (event, value: unknown) => {
        if (event.senderFrame !== contents.mainFrame || contents.isDestroyed())
          return;
        this.handleSmartReaderExtractionResult(contents, value);
      },
    );
    contents.ipc.on(
      channels.smartReaderContentChanged,
      (event, value: unknown) => {
        if (
          event.senderFrame !== contents.mainFrame ||
          contents.isDestroyed() ||
          !value ||
          typeof value !== "object" ||
          (value as { url?: unknown }).url !== tab.url
        ) {
          return;
        }
        if (this.pendingSavedArticleReaders.has(tab.id)) {
          const pendingSavedReader = this.pendingSavedArticleReaders.get(
            tab.id,
          );
          if (pendingSavedReader?.extracting) {
            pendingSavedReader.retryRequested = true;
          } else {
            void this.attemptSavedArticleReader(tab);
          }
        } else {
          this.scheduleReaderMutationDetection(tab);
        }
      },
    );
    contents.setZoomMode("isolated");
    contents.setZoomFactor(tab.zoomFactor);
    contents.setAudioMuted(tab.isMuted);
    contents.on("media-started-playing", () => this.scheduleSnapshot());
    contents.on("media-paused", () => this.scheduleSnapshot());

    const updateNavigationState = () => {
      if (!this.tabs.has(tab.id) || contents.isDestroyed()) return;
      const history = contents.navigationHistory;
      tab.canGoBack = history.canGoBack();
      tab.canGoForward = history.canGoForward();
      this.scheduleSnapshot();
    };
    contents.on("did-start-loading", () => {
      if (this.tabs.has(tab.id)) {
        tab.isLoading = true;
        tab.error = null;
        this.extensionTabs.update(tab.id, { status: "loading" });
        this.scheduleSnapshot();
      }
    });
    contents.on("did-stop-loading", () => {
      if (this.tabs.has(tab.id)) {
        tab.isLoading = false;
        this.extensionTabs.update(tab.id, { status: "complete" });
        updateNavigationState();
        this.scheduleReaderDetection(tab);
      }
    });
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        if (details.url !== tab.url) tab.faviconDataUrl = null;
        tab.documentEpoch += 1;
        this.invalidateSmartReader(tab);
        const pendingSavedReader = this.pendingSavedArticleReaders.get(tab.id);
        if (pendingSavedReader) {
          if (pendingSavedReader.expectedRevision === null) {
            pendingSavedReader.expectedRevision = tab.reader.revision;
          } else {
            this.finishSavedArticleReader(
              tab.id,
              false,
              "The page changed before Smart Reader could open it.",
            );
          }
        }
        if (this.pendingHtmlFullscreen?.tabId === tab.id)
          this.pendingHtmlFullscreen = null;
        if (this.htmlFullscreenTabId === tab.id)
          this.exitWebsiteFullscreen(tab);
        this.releaseWebsiteInputCapture(tab);
        this.onWebsiteDocumentInvalidated?.(contents);
        this.hyperdrive.navigationStarted(tab.id, details.url);
      }
    });
    contents.on("did-redirect-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        this.hyperdrive.navigationRedirected(tab.id, details.url);
      }
    });
    contents.on("did-finish-load", () => {
      this.recordHistory(tab);
      const loadedUrl = contents.getURL();
      void this.refreshWebStoreListingMetadata(tab, contents);
      this.scheduleReaderDetection(tab);
      const pendingSavedReader = this.pendingSavedArticleReaders.get(tab.id);
      if (pendingSavedReader) {
        pendingSavedReader.loadComplete = true;
        void this.attemptSavedArticleReader(tab);
      }
      void contents
        .executeJavaScript(
          "(() => { const entry = performance.getEntriesByType('navigation')[0]; return { transferSize: Number(entry?.transferSize ?? -1), activationStart: Number(entry?.activationStart ?? 0) }; })()",
          true,
        )
        .then(
          (timing: { transferSize?: unknown; activationStart?: unknown }) => {
            this.hyperdrive.noteNavigationTiming(tab.id, loadedUrl, {
              transferSize:
                typeof timing.transferSize === "number"
                  ? timing.transferSize
                  : -1,
              activationStart:
                typeof timing.activationStart === "number"
                  ? timing.activationStart
                  : 0,
            });
          },
        )
        .catch(() => undefined)
        .finally(() => {
          this.hyperdrive.navigationFinished(tab.id, loadedUrl);
        });
    });
    contents.on("did-navigate", (_event, url) => {
      this.updateNavigatedUrl(tab, url);
      updateNavigationState();
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      const previousUrl = tab.url;
      this.updateNavigatedUrl(tab, url);
      try {
        const previous = new URL(previousUrl);
        const next = new URL(url);
        if (
          previous.origin !== next.origin ||
          previous.pathname !== next.pathname ||
          previous.search !== next.search
        ) {
          this.invalidateSmartReader(tab);
          this.finishSavedArticleReader(
            tab.id,
            false,
            "The page changed before Smart Reader could open it.",
          );
          this.scheduleReaderDetection(tab);
        }
      } catch {
        this.invalidateSmartReader(tab);
        this.finishSavedArticleReader(
          tab.id,
          false,
          "The page changed before Smart Reader could open it.",
        );
      }
      updateNavigationState();
      this.recordHistory(tab);
    });
    contents.on("page-title-updated", (_event, title) => {
      if (!this.tabs.has(tab.id)) return;
      const nextTitle = title.trim() || hostFromUrl(tab.url) || "Untitled";
      if (tab.title !== nextTitle) {
        tab.title = nextTitle;
        this.extensionTabs.update(tab.id, { title: nextTitle });
        this.scheduleSnapshot();
        this.scheduleSessionSave();
      }
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      const documentEpoch = tab.documentEpoch;
      const pageUrl = contents.getURL();
      void resolveFaviconDataUrl(
        favicons,
        pageUrl,
        (url, init) => this.browserSession.fetch(url, init),
        (url) => this.readBlobFavicon(contents, url),
      ).then((faviconDataUrl) => {
        if (
          !faviconDataUrl ||
          !this.tabs.has(tab.id) ||
          tab.view !== view ||
          contents.isDestroyed() ||
          tab.documentEpoch !== documentEpoch ||
          contents.getURL() !== pageUrl ||
          tab.faviconDataUrl === faviconDataUrl
        )
          return;
        tab.faviconDataUrl = faviconDataUrl;
        this.scheduleSnapshot();
      });
    });
    contents.on("found-in-page", (_event, result) => {
      if (
        result.requestId !== tab.findRequestId ||
        tab.id !== this.activeTabId ||
        this.shellView.webContents.isDestroyed()
      )
        return;
      const snapshot: FindResultSnapshot = {
        requestId: result.requestId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate,
      };
      this.shellView.webContents.send(channels.findResult, snapshot);
    });
    contents.on("zoom-changed", () =>
      queueMicrotask(() => {
        if (!contents.isDestroyed()) {
          tab.zoomFactor = contents.getZoomFactor();
          this.scheduleSnapshot();
        }
      }),
    );
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3 || !this.tabs.has(tab.id)) return;
        this.finishSavedArticleReader(
          tab.id,
          false,
          "Smart Reader could not open this article because the page failed to load.",
        );
        this.hyperdrive.navigationFailed(
          tab.id,
          validatedUrl || tab.requestedUrl,
          errorDescription,
        );
        tab.isLoading = false;
        this.invalidateSmartReader(tab);
        tab.nextHistoryEntryTyped = false;
        tab.error = errorDescription;
        tab.title = "Page unavailable";
        if (validatedUrl && isAllowedWebUrl(validatedUrl)) {
          tab.url = validatedUrl;
          tab.requestedUrl = validatedUrl;
        }
        this.extensionTabs.update(tab.id, {
          title: tab.title,
          url: tab.url,
          status: "complete",
        });
        this.emitSnapshot();
        const errorUrl = `chromecraft://error/?url=${encodeURIComponent(tab.requestedUrl)}&description=${encodeURIComponent(errorDescription)}`;
        void contents.loadURL(errorUrl).catch(() => undefined);
      },
    );
    contents.on("render-process-gone", (_event, details) => {
      if (this.tabs.has(tab.id)) {
        this.finishSavedArticleReader(
          tab.id,
          false,
          "Smart Reader could not open this article because the page stopped responding.",
        );
        if (this.pendingHtmlFullscreen?.tabId === tab.id)
          this.pendingHtmlFullscreen = null;
        if (this.htmlFullscreenTabId === tab.id)
          this.exitWebsiteFullscreen(tab);
        this.onWebsiteDocumentInvalidated?.(contents);
        this.invalidateSmartReader(tab);
        tab.isLoading = false;
        tab.crashed = true;
        tab.error = `The page process stopped (${details.reason}).`;
        tab.title = "Page crashed";
        this.extensionTabs.update(tab.id, {
          title: tab.title,
          status: "complete",
        });
        this.emitSnapshot();
      }
    });
    contents.on("unresponsive", () => {
      if (this.tabs.has(tab.id)) {
        tab.error = "This page is not responding.";
        this.emitSnapshot();
      }
    });
    contents.on("responsive", () => {
      if (
        this.tabs.has(tab.id) &&
        !tab.crashed &&
        tab.error === "This page is not responding."
      ) {
        tab.error = null;
        this.emitSnapshot();
      }
    });
    contents.on("will-navigate", (event, url) => {
      if (shouldBlockOfflineArchiveNavigation(contents.getURL(), url)) {
        event.preventDefault();
        return;
      }
      if (!isAllowedWebUrl(url) && !this.isAllowedInternalUrl(url))
        event.preventDefault();
    });
    contents.setWindowOpenHandler((details) => {
      if (isOfflineArchiveUrl(contents.getURL())) return { action: "deny" };
      if (
        details.frameName.startsWith(EXTENSION_WINDOW_NAME_PREFIX) &&
        this.extensions?.isAllowedExtensionUrl(details.url)
      ) {
        return {
          action: "allow",
          outlivesOpener: false,
          createWindow: (options) => {
            const overrides = this.extensionWindowOptions(details.features);
            const windowOptions = {
              ...(options as BrowserWindowConstructorOptions & {
                webContents?: unknown;
              }),
            };
            delete windowOptions.webContents;
            const extensionWindow = new BrowserWindow({
              ...windowOptions,
              ...overrides,
              webPreferences: {
                ...options.webPreferences,
                ...overrides.webPreferences,
              },
            });
            this.configureExtensionWindow(
              extensionWindow,
              details.url,
              details.frameName,
            );
            setImmediate(() => {
              if (
                extensionWindow.isDestroyed() ||
                extensionWindow.webContents.isDestroyed()
              ) {
                return;
              }
              extensionWindow.show();
              void extensionWindow.webContents
                .loadURL(details.url)
                .catch((error: unknown) => {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  if (!message.includes("ERR_ABORTED")) {
                    console.warn(
                      `Extension popup navigation failed: ${message}`,
                    );
                  }
                });
            });
            return extensionWindow.webContents;
          },
        };
      }
      if (
        isAllowedWebUrl(details.url) &&
        (this.shouldAllowWebsitePopup?.(contents.getURL()) ?? true)
      )
        queueMicrotask(() =>
          this.runNativeTabTopologyAction(() =>
            this.createTab(
              details.url,
              details.disposition !== "background-tab",
            ),
          ),
        );
      return { action: "deny" };
    });
    return view;
  }

  private configureExtensionWindow(
    extensionWindow: BrowserWindow,
    initialUrl: string,
    frameName: string,
  ): void {
    if (
      !frameName.startsWith(EXTENSION_WINDOW_NAME_PREFIX) ||
      !this.extensions?.isAllowedExtensionUrl(initialUrl)
    ) {
      extensionWindow.destroy();
      return;
    }
    this.extensionWindows.add(extensionWindow);
    extensionWindow.setMenuBarVisibility(false);
    extensionWindow.webContents.on("did-finish-load", () => {
      if (extensionWindow.webContents.isDestroyed()) return;
      void extensionWindow.webContents
        .executeJavaScript(`window.name = ${JSON.stringify(frameName)}`, true)
        .catch(() => undefined);
    });
    extensionWindow.webContents.on("will-navigate", (event, url) => {
      if (this.extensions?.isAllowedExtensionUrl(url)) return;
      event.preventDefault();
      if (isAllowedWebUrl(url)) {
        this.runNativeTabTopologyAction(() => this.createTab(url));
      }
    });
    extensionWindow.webContents.setWindowOpenHandler((request) => {
      if (isAllowedWebUrl(request.url)) {
        queueMicrotask(() =>
          this.runNativeTabTopologyAction(() => this.createTab(request.url)),
        );
      }
      return { action: "deny" };
    });
    extensionWindow.on("closed", () => {
      this.extensionWindows.delete(extensionWindow);
    });
  }

  private extensionWindowOptions(
    features: string,
  ): BrowserWindowConstructorOptions {
    const values = new Map<string, number>();
    for (const feature of features.split(",")) {
      const [rawName, rawValue] = feature.split("=", 2);
      const value = Number(rawValue);
      if (rawName && Number.isFinite(value)) {
        values.set(rawName.trim().toLowerCase(), Math.round(value));
      }
    }
    const bounded = (
      name: string,
      fallback: number,
      minimum: number,
      maximum: number,
    ) => Math.min(maximum, Math.max(minimum, values.get(name) ?? fallback));
    return {
      title: "Extension",
      width: bounded("width", 420, 280, 1600),
      height: bounded("height", 630, 320, 1400),
      x: bounded("left", 100, -32768, 32768),
      y: bounded("top", 100, -32768, 32768),
      minWidth: 280,
      minHeight: 320,
      autoHideMenuBar: true,
      show: true,
      backgroundColor: "#ffffff",
      webPreferences: {
        session: this.browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        safeDialogs: true,
        spellcheck: false,
      },
    };
  }

  private recordHistory(tab: TabRecord): void {
    if (!this.tabs.has(tab.id) || !isAllowedWebUrl(tab.url)) {
      tab.nextHistoryEntryTyped = false;
      return;
    }
    if (tab.url === tab.lastHistoryUrl && !tab.nextHistoryEntryTyped) return;
    tab.lastHistoryUrl = tab.url;
    const typed = tab.nextHistoryEntryTyped;
    tab.nextHistoryEntryTyped = false;
    void this.browserData
      .recordHistory({
        title: tab.title === "Loading…" ? hostFromUrl(tab.url) : tab.title,
        url: tab.url,
        typed,
      })
      .then(this.onBrowserDataChanged)
      .catch((error) => console.warn("Could not save history.", error));
  }

  private updateNavigatedUrl(tab: TabRecord, url: string): void {
    if (!this.tabs.has(tab.id) || url.startsWith("chromecraft://error")) return;
    if (isAllowedWebUrl(url) || this.isAllowedInternalUrl(url)) {
      this.resetWebStoreVisitIfChanged(tab, url);
      this.resetYouTubeVisitIfChanged(tab, url);
      tab.url = url;
      tab.requestedUrl = url;
      tab.error = null;
      this.extensionTabs.update(tab.id, { url });
      if (tab.id === this.activeTabId) this.layoutActiveView();
      this.scheduleSnapshot();
      this.scheduleSessionSave();
    }
  }

  private resetWebStoreVisitIfChanged(tab: TabRecord, nextUrl: string): void {
    const previousId = parseChromeWebStoreListingUrl(tab.url)?.extensionId;
    const nextId = parseChromeWebStoreListingUrl(nextUrl)?.extensionId;
    if (previousId === nextId) return;
    tab.dismissedWebStoreExtensionId = null;
    tab.webStoreListingTitle = null;
    tab.webStoreListingDescription = null;
  }

  private resetYouTubeVisitIfChanged(tab: TabRecord, nextUrl: string): void {
    const previousId = parseYouTubeWatchUrl(tab.url)?.videoId;
    const nextId = parseYouTubeWatchUrl(nextUrl)?.videoId;
    if (previousId === nextId) return;
    tab.dismissedYouTubeVideoId = null;
  }

  private async refreshWebStoreListingMetadata(
    tab: TabRecord,
    contents: Electron.WebContents,
  ): Promise<void> {
    const listing = parseChromeWebStoreListingUrl(contents.getURL());
    if (!listing || contents.isDestroyed()) return;
    try {
      const metadata = (await contents.executeJavaScript(
        `(() => {
          const content = (selector) => document.querySelector(selector)?.getAttribute("content") ?? "";
          return {
            title: content('meta[property="og:title"]') || document.title || "",
            description: content('meta[property="og:description"]') || content('meta[name="description"]') || "",
          };
        })()`,
        true,
      )) as { title?: unknown; description?: unknown };
      if (
        !this.tabs.has(tab.id) ||
        parseChromeWebStoreListingUrl(tab.url)?.extensionId !==
          listing.extensionId
      ) {
        return;
      }
      tab.webStoreListingTitle = cleanListingText(metadata.title, 120);
      tab.webStoreListingDescription = cleanListingText(
        metadata.description,
        280,
      );
      this.scheduleSnapshot();
    } catch {
      // The Web Store can change or block metadata access. The banner retains
      // its safe generic fallback until verified package details are available.
    }
  }

  private attachShortcutHandler(view: WebContentsView): void {
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const key = input.key.toLowerCase();
      const command = input.control || input.meta;
      const active = this.tabs.get(this.activeTabId);
      if (!command && !input.alt && input.shift && key === "escape") {
        event.preventDefault();
        this.onOpenPerformanceCentre?.();
      } else if (command && input.shift && key === "t") {
        event.preventDefault();
        this.runNativeTabTopologyPromise(this.reopenClosedTab());
      } else if (command && input.shift && key === "p") {
        event.preventDefault();
        this.shellView.webContents.send(channels.openCommandPalette);
      } else if (
        (command && !input.shift && key === "l") ||
        (input.alt && key === "d") ||
        key === "f6"
      ) {
        event.preventDefault();
        this.focusOmnibox();
      } else if (command && !input.shift && key === "t") {
        event.preventDefault();
        this.runNativeTabTopologyAction(() => {
          this.createTab();
          this.focusOmnibox();
        });
      } else if (command && key === "w") {
        event.preventDefault();
        if (active)
          this.runNativeTabTopologyAction(() => this.closeTab(active.id));
      } else if (command && key === "f") {
        event.preventDefault();
        this.shellView.webContents.focus();
        this.shellView.webContents.send(channels.showFind);
      } else if (command && (key === "+" || key === "=" || key === "add")) {
        event.preventDefault();
        if (active) this.stepZoom(active, 1);
      } else if (command && (key === "-" || key === "subtract")) {
        event.preventDefault();
        if (active) this.stepZoom(active, -1);
      } else if (command && key === "0") {
        event.preventDefault();
        if (active) this.setZoom(active.id, 1);
      } else if (command && key === "tab") {
        event.preventDefault();
        this.activateByOffset(input.shift ? -1 : 1);
      } else if (command && !input.shift && /^[1-9]$/.test(key)) {
        event.preventDefault();
        const requested =
          Number(key) === 9 ? this.order.length - 1 : Number(key) - 1;
        const tabId = this.order[Math.min(requested, this.order.length - 1)];
        if (tabId) this.activateTab(tabId);
      } else if ((command && key === "r") || key === "f5") {
        event.preventDefault();
        if (active) this.reload(active.id);
      } else if (input.alt && key === "left") {
        event.preventDefault();
        if (active) this.goBack(active.id);
      } else if (input.alt && key === "right") {
        event.preventDefault();
        if (active) this.goForward(active.id);
      } else if (key === "f11") {
        event.preventDefault();
        this.setFullscreen(!this.window.isFullScreen());
      } else if (key === "escape" && active?.reader.active) {
        event.preventDefault();
        this.exitSmartReader(active);
      } else if (key === "escape" && active?.id === this.htmlFullscreenTabId) {
        // Let Chromium leave HTML fullscreen, pointer lock, and keyboard lock
        // together so the page receives the standard fullscreenchange event.
        return;
      } else if (key === "escape" && this.window.isFullScreen()) {
        event.preventDefault();
        this.setFullscreen(false);
      } else if (key === "escape" && active?.isLoading) {
        event.preventDefault();
        this.stop(active.id);
      } else if (this.onExtensionCommandInput?.(input)) {
        event.preventDefault();
      }
    });
  }

  private smartReaderSnapshot(tab: TabRecord): SmartReaderViewSnapshot {
    tab.reader.saved = Boolean(
      tab.readerArticle &&
      this.browserData.findSavedArticle(tab.readerArticle.sourceUrl),
    );
    return {
      tabId: tab.id,
      ...tab.reader,
      article: null,
      error: tab.readerError,
    };
  }

  private meaningfulReadingPosition(tab: TabRecord): number | null {
    const progress = tab.readerArticle
      ? this.readingPositions.get(tab.readerArticle.sourceUrl)
      : null;
    return progress !== null && progress >= 0.05 && progress <= 0.95
      ? progress
      : null;
  }

  private sendSmartReaderCommand(
    tab: TabRecord,
    command: SmartReaderCommand,
  ): void {
    const contents = tab.readerView?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.send(channels.smartReaderCommand, command);
  }

  private async flushReadingPosition(tab: TabRecord): Promise<void> {
    const progress = tab.readerProgressValue;
    const url = tab.readerArticle?.sourceUrl;
    tab.readerProgressValue = null;
    if (progress === null || !url) return;
    await this.readingPositions
      .set(url, progress)
      .catch((error) =>
        console.warn("Could not save Smart Reader position.", error),
      );
  }

  private cancelNarrationSession(
    session: SmartReaderNarrationSessionRecord,
  ): void {
    if (session.activeRequestId) {
      this.smartReaderNarration?.cancel(session.activeRequestId);
    }
    this.readerNarrationSessions.delete(session.id);
  }

  private cancelNarrationForTab(tab: TabRecord): void {
    for (const session of this.readerNarrationSessions?.values() ?? []) {
      if (session.tabId === tab.id) this.cancelNarrationSession(session);
    }
  }

  private smartReaderSummarySnapshot(
    tab: TabRecord,
  ): SmartReaderSummarySnapshot {
    const configuration = this.smartReaderSummary?.configuration() ?? {
      provider: "ollama" as const,
      model: null,
      providers: {
        ollama: {
          connection: "unavailable" as const,
          models: [],
          selectedModel: null,
          error: "Scout is unavailable.",
        },
        gemini: {
          connection: "unavailable" as const,
          models: [],
          selectedModel: null,
          error: "Scout is unavailable.",
          apiKeyConfigured: false,
          cloudConsentGranted: false,
        },
      },
    };
    return structuredClone({
      tabId: tab.id,
      revision: tab.reader.revision,
      sourceUrl: tab.readerArticle?.sourceUrl ?? tab.url,
      ...tab.readerSummary,
      ...configuration,
    });
  }

  private requireReaderTab(source: WebContents): TabRecord {
    for (const tab of this.tabs.values()) {
      if (
        tab.readerView?.webContents === source &&
        !source.isDestroyed() &&
        tab.readerArticle !== null
      ) {
        return tab;
      }
    }
    throw new Error("Rejected Smart Reader request from an untrusted page.");
  }

  private requireSummaryProvider(value: unknown): "ollama" | "gemini" {
    if (value !== "ollama" && value !== "gemini") {
      throw new TypeError("Choose Local Ollama or Google Gemini.");
    }
    return value;
  }

  private requireSummaryRequest(
    value: unknown,
    includeConsent: boolean,
  ): SmartReaderSummaryGenerateRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Choose a Scout provider and model.");
    }
    const candidate = value as Record<string, unknown>;
    const provider = this.requireSummaryProvider(candidate.provider);
    const model =
      typeof candidate.model === "string" ? candidate.model.trim() : null;
    if (
      model !== null &&
      (!model || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model))
    ) {
      throw new TypeError("Choose a valid Scout model.");
    }
    return {
      provider,
      model,
      cloudConsent: includeConsent && candidate.cloudConsent === true,
    };
  }

  private sendSmartReaderSummary(tab: TabRecord): void {
    const contents = tab.readerView?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.send(
      channels.smartReaderSummaryChanged,
      this.smartReaderSummarySnapshot(tab),
    );
  }

  private cancelSummaryForTab(tab: TabRecord): void {
    const requestId = tab.readerSummary.requestId;
    if (requestId) this.smartReaderSummary?.cancel(requestId);
    tab.readerSummary = {
      stage: tab.readerSummary.result ? "ready" : "idle",
      requestId: null,
      result: tab.readerSummary.result,
      error: null,
    };
  }

  private resetSummaryForTab(tab: TabRecord): void {
    const requestId = tab.readerSummary.requestId;
    if (requestId) this.smartReaderSummary?.cancel(requestId);
    tab.readerSummary = {
      stage: "idle",
      requestId: null,
      result: null,
      error: null,
    };
  }

  private isValidReaderArticle(
    value: unknown,
    expectedUrl: string,
  ): value is SmartReaderArticle {
    if (!value || typeof value !== "object") return false;
    const article = value as Partial<SmartReaderArticle>;
    return (
      article.sourceUrl === expectedUrl &&
      typeof article.title === "string" &&
      article.title.length > 0 &&
      article.title.length <= 1_000 &&
      typeof article.content === "string" &&
      article.content.length > 0 &&
      article.content.length <= 5 * 1024 * 1024 &&
      typeof article.textContent === "string" &&
      article.textContent.length > 0 &&
      article.textContent.length <= 1_000_000 &&
      Array.isArray(article.headings) &&
      article.headings.length <= 100 &&
      article.headings.every(
        (heading) => typeof heading === "string" && heading.length <= 500,
      ) &&
      (article.sections === undefined ||
        (Array.isArray(article.sections) &&
          article.sections.length <= 100 &&
          article.sections.every(
            (section) =>
              section !== null &&
              typeof section === "object" &&
              typeof section.id === "string" &&
              section.id.length <= 160 &&
              typeof section.text === "string" &&
              section.text.length <= 500 &&
              [1, 2, 3, 4].includes(section.level),
          ))) &&
      typeof article.textLength === "number" &&
      article.textLength >= 80 &&
      article.textLength <= 10_000_000 &&
      [
        article.byline,
        article.publishedTime,
        article.siteName,
        article.excerpt,
      ].every(
        (item) =>
          item === null || item === undefined || typeof item === "string",
      )
    );
  }

  private requestSmartReaderExtraction(
    tab: TabRecord,
    force: boolean,
  ): Promise<SmartReaderViewSnapshot> {
    const contents = tab.view?.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      !isAllowedWebUrl(tab.url) ||
      tab.crashed
    ) {
      tab.reader.availability = "unavailable";
      return Promise.resolve(this.smartReaderSnapshot(tab));
    }
    if (tab.readerPendingRequestId) {
      this.cancelReaderExtraction(tab, "A newer Reader check started.");
    }
    const requestId = randomUUID();
    const revision = tab.reader.revision;
    tab.readerPendingRequestId = requestId;
    tab.reader.availability = "checking";
    tab.readerError = null;
    this.scheduleSnapshot();

    return new Promise<SmartReaderViewSnapshot>((resolve) => {
      const timer = setTimeout(() => {
        const current = this.pendingReaderExtractions.get(requestId);
        if (!current) return;
        this.pendingReaderExtractions.delete(requestId);
        if (tab.readerPendingRequestId === requestId) {
          tab.readerPendingRequestId = null;
          tab.reader.availability = "error";
          tab.readerError = "Smart Reader could not finish checking this page.";
          this.scheduleSnapshot();
        }
        resolve(this.smartReaderSnapshot(tab));
      }, 12_000);
      this.pendingReaderExtractions.set(requestId, {
        tabId: tab.id,
        revision,
        resolve,
        timer,
      });
      contents.send(channels.smartReaderExtract, {
        requestId,
        expectedUrl: tab.url,
        revision,
        force,
      });
    });
  }

  private finishReaderExtraction(requestId: string, tab?: TabRecord): void {
    const pending = this.pendingReaderExtractions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingReaderExtractions.delete(requestId);
    if (tab?.readerPendingRequestId === requestId) {
      tab.readerPendingRequestId = null;
    }
    pending.resolve(
      tab && this.tabs.has(tab.id)
        ? this.smartReaderSnapshot(tab)
        : {
            tabId: pending.tabId,
            availability: "unavailable",
            active: false,
            revision: pending.revision,
            saved: false,
            article: null,
            error: "The page changed before Smart Reader finished.",
          },
    );
  }

  private finishSavedArticleReader(
    tabId: TabId,
    readerActive: boolean,
    error: string | null,
  ): void {
    const pending = this.pendingSavedArticleReaders.get(tabId);
    if (!pending) return;
    this.pendingSavedArticleReaders.delete(tabId);
    clearTimeout(pending.timer);
    pending.resolve({ tabId, readerActive, error });
  }

  private async attemptSavedArticleReader(tab: TabRecord): Promise<void> {
    const pending = this.pendingSavedArticleReaders.get(tab.id);
    if (
      !pending ||
      !pending.loadComplete ||
      pending.extracting ||
      !this.tabs.has(tab.id)
    ) {
      return;
    }
    if (
      pending.expectedRevision !== null &&
      pending.expectedRevision !== tab.reader.revision
    ) {
      this.finishSavedArticleReader(
        tab.id,
        false,
        "The page changed before Smart Reader could open it.",
      );
      return;
    }

    pending.extracting = true;
    pending.retryRequested = false;
    try {
      const detected = this.readerDocumentIsAvailable(tab)
        ? this.smartReaderSnapshot(tab)
        : await this.requestSmartReaderExtraction(tab, true);
      if (this.pendingSavedArticleReaders.get(tab.id) !== pending) return;
      if (
        detected.availability !== "available" ||
        !this.readerDocumentIsAvailable(tab)
      ) {
        // Dynamic article shells can become readable after their initial load.
        // The page preload's MutationObserver will call us again when content
        // actually changes; the deadline only prevents a permanently pending UI.
        return;
      }
      await this.enterSmartReader(tab, pending.appearance);
      if (this.pendingSavedArticleReaders.get(tab.id) !== pending) return;
      if (tab.reader.active) {
        this.finishSavedArticleReader(tab.id, true, null);
      }
    } catch (error) {
      if (this.pendingSavedArticleReaders.get(tab.id) !== pending) return;
      const message =
        error instanceof Error
          ? error.message
          : "Smart Reader was unavailable for this article.";
      if (!this.tabs.has(tab.id)) {
        this.finishSavedArticleReader(tab.id, false, message);
      }
    } finally {
      if (this.pendingSavedArticleReaders.get(tab.id) === pending) {
        pending.extracting = false;
        if (pending.retryRequested) {
          queueMicrotask(() => void this.attemptSavedArticleReader(tab));
        }
      }
    }
  }

  private cancelReaderExtraction(tab: TabRecord, message: string): void {
    const requestId = tab.readerPendingRequestId;
    tab.readerPendingRequestId = null;
    if (!requestId) return;
    const pending = this.pendingReaderExtractions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingReaderExtractions.delete(requestId);
    pending.resolve({
      ...this.smartReaderSnapshot(tab),
      error: message,
    });
  }

  private scheduleReaderDetection(tab: TabRecord): void {
    this.clearReaderTimers(tab);
    if (!isAllowedWebUrl(tab.url) || tab.crashed) return;
    const revision = tab.reader.revision;
    for (const delay of [100, 700, 1_800, 4_000, 8_000]) {
      const timer = setTimeout(() => {
        tab.readerTimers.delete(timer);
        if (
          !this.tabs.has(tab.id) ||
          tab.reader.revision !== revision ||
          tab.reader.availability === "available" ||
          tab.readerPendingRequestId
        ) {
          return;
        }
        void this.requestSmartReaderExtraction(tab, false);
      }, delay);
      tab.readerTimers.add(timer);
    }
  }

  private scheduleReaderMutationDetection(tab: TabRecord, delay = 250): void {
    if (
      tab.readerMutationTimer ||
      tab.reader.active ||
      tab.reader.availability === "available" ||
      !isAllowedWebUrl(tab.url) ||
      tab.crashed
    ) {
      return;
    }
    const revision = tab.reader.revision;
    const timer = setTimeout(() => {
      tab.readerTimers.delete(timer);
      if (tab.readerMutationTimer === timer) tab.readerMutationTimer = null;
      if (
        !this.tabs.has(tab.id) ||
        tab.reader.revision !== revision ||
        tab.reader.active ||
        tab.reader.availability === "available" ||
        tab.readerPendingRequestId
      ) {
        return;
      }
      void this.requestSmartReaderExtraction(tab, false);
    }, delay);
    tab.readerMutationTimer = timer;
    tab.readerTimers.add(timer);
  }

  private clearReaderTimers(tab: TabRecord): void {
    for (const timer of tab.readerTimers) clearTimeout(timer);
    tab.readerTimers.clear();
    tab.readerMutationTimer = null;
  }

  private invalidateSmartReader(tab: TabRecord): void {
    this.sendSmartReaderCommand(tab, { type: "stop-narration" });
    this.cancelNarrationForTab(tab);
    if (tab.readerProgressTimer) clearTimeout(tab.readerProgressTimer);
    tab.readerProgressTimer = null;
    void this.flushReadingPosition(tab);
    this.clearReaderTimers(tab);
    this.cancelReaderExtraction(tab, "The page changed.");
    tab.reader.revision += 1;
    tab.reader.availability = isAllowedWebUrl(tab.url)
      ? "checking"
      : "unavailable";
    tab.reader.active = false;
    tab.reader.saved = false;
    tab.reader.navigationOpen = false;
    tab.reader.narrationOpen = false;
    tab.readerError = null;
    tab.readerArticle = null;
    this.resetSummaryForTab(tab);
    this.smartReaderDocuments.removeUrl(tab.readerDocumentUrl);
    tab.readerDocumentUrl = null;
    this.destroyReaderView(tab);
  }

  private readerDocumentIsAvailable(tab: TabRecord): boolean {
    return Boolean(
      tab.readerDocumentUrl &&
      this.smartReaderDocuments.get(new URL(tab.readerDocumentUrl).hostname) !==
        null,
    );
  }

  private async enterSmartReader(
    tab: TabRecord,
    appearance: SmartReaderAppearance,
  ): Promise<void> {
    if (!tab.readerDocumentUrl || !this.readerDocumentIsAvailable(tab)) {
      const result = await this.requestSmartReaderExtraction(tab, true);
      if (result.availability !== "available" || !tab.readerDocumentUrl) return;
    }
    const revision = tab.reader.revision;
    const view = this.ensureReaderView(tab);
    if (view.webContents.getURL() !== tab.readerDocumentUrl) {
      await view.webContents.loadURL(tab.readerDocumentUrl);
    }
    if (
      !this.tabs.has(tab.id) ||
      tab.reader.revision !== revision ||
      tab.readerView !== view
    ) {
      return;
    }
    await this.applySmartReaderAppearance(tab, appearance);
    if (
      !this.tabs.has(tab.id) ||
      tab.reader.revision !== revision ||
      tab.readerView !== view ||
      view.webContents.isDestroyed()
    ) {
      return;
    }
    tab.reader.active = true;
    tab.reader.availability = "available";
    tab.reader.saved = Boolean(
      tab.readerArticle &&
      this.browserData.findSavedArticle(tab.readerArticle.sourceUrl),
    );
    this.sendSmartReaderCommand(tab, {
      type: "set-progress-visible",
      visible: this.preferences.snapshot.smartReaderProgressVisible,
      resumeProgress: this.meaningfulReadingPosition(tab),
    });
    if (tab.id === this.activeTabId) {
      this.layoutActiveView();
      view.webContents.focus();
    }
    this.emitSnapshot();
  }

  private exitSmartReader(tab: TabRecord): void {
    if (!tab.reader.active) return;
    if (tab.reader.navigationOpen) {
      this.sendSmartReaderCommand(tab, { type: "toggle-navigation" });
    }
    this.sendSmartReaderCommand(tab, { type: "stop-narration" });
    tab.reader.navigationOpen = false;
    tab.reader.narrationOpen = false;
    this.cancelNarrationForTab(tab);
    if (tab.readerProgressTimer) clearTimeout(tab.readerProgressTimer);
    tab.readerProgressTimer = null;
    void this.flushReadingPosition(tab);
    tab.reader.active = false;
    this.cancelSummaryForTab(tab);
    if (tab.id === this.activeTabId) {
      this.layoutActiveView();
      tab.view?.webContents.focus();
    }
    this.emitSnapshot();
  }

  private ensureReaderView(tab: TabRecord): WebContentsView {
    if (tab.readerView && !tab.readerView.webContents.isDestroyed()) {
      return tab.readerView;
    }
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "smart-reader-preload.cjs"),
        session: this.browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
        spellcheck: false,
        backgroundThrottling: true,
      },
    });
    tab.readerView = view;
    this.window.contentView.addChildView(view);
    view.setBounds(this.currentPageBounds());
    view.setVisible(false);
    this.attachShortcutHandler(view);
    const contents = view.webContents;
    contents.on("focus", () => {
      if (
        this.tabs.has(tab.id) &&
        tab.id !== this.activeTabId &&
        this.splitView.pairForTab(tab.id)
      ) {
        this.activateTab(tab.id);
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedWebUrl(url)) {
        this.runNativeTabTopologyAction(() => this.createTab(url));
      }
      return { action: "deny" };
    });
    contents.on("context-menu", (_event, params) => {
      if (
        !this.tabs.has(tab.id) ||
        contents.isDestroyed() ||
        this.window.isDestroyed()
      ) {
        return;
      }
      this.extensionPopup?.close();
      const sourceContents = tab.view?.webContents;
      const withLiveReader = (action: () => void) => () => {
        if (!this.tabs.has(tab.id) || contents.isDestroyed()) return;
        action();
      };
      const menu = Menu.buildFromTemplate(
        buildPageContextMenu(
          params,
          {
            canGoBack: sourceContents?.navigationHistory.canGoBack() ?? false,
            canGoForward:
              sourceContents?.navigationHistory.canGoForward() ?? false,
          },
          {
            goBack: withLiveReader(() => this.goBack(tab.id)),
            goForward: withLiveReader(() => this.goForward(tab.id)),
            reload: withLiveReader(() => this.reload(tab.id)),
            openInNewTab: (url) =>
              withLiveReader(() =>
                this.runNativeTabTopologyAction(() => this.createTab(url)),
              )(),
            download: (url) => {
              if (!contents.isDestroyed()) contents.downloadURL(url);
            },
            copyText: (text) =>
              clipboard
                .writeText(text)
                .catch((error: unknown) =>
                  console.warn(
                    "Could not copy Reader context-menu text.",
                    error,
                  ),
                ),
            copyImageAt: (x, y) => {
              if (!contents.isDestroyed()) contents.copyImageAt(x, y);
            },
            inspectAt: (x, y) => {
              if (!contents.isDestroyed()) contents.inspectElement(x, y);
            },
          },
        ),
      );
      menu.popup({
        window: this.window,
        frame: params.frame ?? undefined,
        sourceType: params.menuSourceType,
      });
    });
    contents.on("will-navigate", (event, url) => {
      if (url.startsWith(`${tab.readerDocumentUrl ?? ""}#`)) return;
      event.preventDefault();
      if (!isAllowedWebUrl(url) || !this.tabs.has(tab.id)) return;
      this.exitSmartReader(tab);
      void this.navigateToUrl(tab, url, false, tab.id !== this.activeTabId);
    });
    contents.on("render-process-gone", () => {
      this.recoverFromReaderViewLoss(tab, view);
    });
    contents.once("destroyed", () => {
      this.recoverFromReaderViewLoss(tab, view);
    });
    return view;
  }

  private recoverFromReaderViewLoss(
    tab: TabRecord,
    view: WebContentsView,
  ): void {
    if (tab.readerView !== view) return;
    tab.readerView = null;
    tab.readerAppearanceCssKey = null;
    tab.readerAppearanceRevision += 1;
    const wasActive = tab.reader.active;
    tab.reader.active = false;
    tab.reader.navigationOpen = false;
    tab.reader.narrationOpen = false;
    if (!this.tabs.has(tab.id) || !wasActive) return;
    if (tab.id === this.activeTabId) {
      this.layoutActiveView();
      tab.view?.webContents.focus();
    }
    this.emitSnapshot();
  }

  private smartReaderAppearanceCss(appearance: SmartReaderAppearance): string {
    const themes = {
      light: ["#fffdfa", "#24221f", "#68635c", "#ddd8ce", "#155ab6", "#f1eee8"],
      warm: ["#f4ecd8", "#302b23", "#716758", "#d7c9ad", "#75521b", "#e9ddc3"],
      dark: ["#171717", "#e7e1d7", "#aaa39a", "#45413c", "#a8c7fa", "#242321"],
    } as const;
    const theme =
      appearance.theme === "system" ? null : themes[appearance.theme];
    const variables = theme
      ? `--paper:${theme[0]}!important;--ink:${theme[1]}!important;--muted:${theme[2]}!important;--line:${theme[3]}!important;--link:${theme[4]}!important;--code:${theme[5]}!important;`
      : "";
    const family =
      appearance.font === "sans" ? "var(--font-sans)" : "var(--font-serif)";
    return `:root{${variables}--reader-scale:${appearance.textScale}!important}body,h1,.article-body h2,.article-body h3,.article-body h4{font-family:${family}!important}`;
  }

  private async applySmartReaderAppearance(
    tab: TabRecord,
    appearance: SmartReaderAppearance,
  ): Promise<void> {
    const view = tab.readerView;
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const revision = ++tab.readerAppearanceRevision;
    const previousKey = tab.readerAppearanceCssKey;
    let nextKey: string;
    try {
      nextKey = await contents.insertCSS(
        this.smartReaderAppearanceCss(appearance),
      );
    } catch {
      return;
    }
    if (
      tab.readerAppearanceRevision !== revision ||
      tab.readerView !== view ||
      contents.isDestroyed()
    ) {
      if (!contents.isDestroyed()) {
        await contents.removeInsertedCSS(nextKey).catch(() => undefined);
      }
      return;
    }
    tab.readerAppearanceCssKey = nextKey;
    if (previousKey && previousKey !== nextKey) {
      await contents.removeInsertedCSS(previousKey).catch(() => undefined);
    }
  }

  private destroyReaderView(tab: TabRecord): void {
    const view = tab.readerView;
    tab.readerView = null;
    tab.readerAppearanceCssKey = null;
    tab.readerAppearanceRevision += 1;
    if (!view) return;
    try {
      this.window.contentView.removeChildView(view);
    } catch {
      // Window is closing.
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  private attachShellContextMenuHandler(): void {
    const contents = this.shellView.webContents;
    contents.on("context-menu", (_event, params) => {
      if (contents.isDestroyed() || this.window.isDestroyed()) return;
      const template = buildTextContextMenu(params);
      if (template.length === 0) return;
      Menu.buildFromTemplate(template).popup({
        window: this.window,
        frame: params.frame ?? undefined,
        sourceType: params.menuSourceType,
      });
    });
  }

  private stepZoom(tab: TabRecord, direction: number): void {
    const current = ZOOM_FACTORS.reduce(
      (best, factor) =>
        Math.abs(factor - tab.zoomFactor) < Math.abs(best - tab.zoomFactor)
          ? factor
          : best,
      1,
    );
    const index = ZOOM_FACTORS.indexOf(current);
    this.setZoom(
      tab.id,
      ZOOM_FACTORS[
        Math.max(0, Math.min(ZOOM_FACTORS.length - 1, index + direction))
      ],
    );
  }

  private activateByOffset(offset: number): void {
    if (this.order.length < 2) return;
    const current = this.order.indexOf(this.activeTabId);
    this.activateTab(
      this.order[(current + offset + this.order.length) % this.order.length],
    );
  }

  private scheduleLayout(): void {
    if (this.layoutTimer || this.disposed) return;
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = null;
      this.layoutActiveView();
    }, 8);
  }

  private currentPageBounds(): Electron.Rectangle {
    const { width, height } = this.window.getContentBounds();
    if (
      this.window.isFullScreen() ||
      this.htmlFullscreenTabId === this.activeTabId
    )
      return { x: 0, y: 0, width, height };
    const currentSidebarWidth = sidebarWidth(
      this.preferences.snapshot.sidebarAttached,
      this.preferences.snapshot.sidebarOpen,
    );
    const monitorWidth = this.preferences.snapshot.hyperdriveMonitorOpen
      ? HYPERDRIVE_MONITOR_WIDTH
      : 0;
    const chromeHeight = this.chromeHeight;
    return {
      x: currentSidebarWidth,
      y: chromeHeight,
      width: Math.max(0, width - currentSidebarWidth - monitorWidth),
      height: Math.max(0, height - chromeHeight),
    };
  }

  private get chromeHeight(): number {
    return (
      this.baseChromeHeight +
      (this.youtubeDownloadIndicatorVisible &&
      this.preferences.snapshot.showDownloadProgressInToolbar
        ? YOUTUBE_GLOBAL_PROGRESS_HEIGHT
        : 0) +
      (this.activeWebStoreListing ? EXTENSION_INSTALL_BANNER_HEIGHT : 0) +
      (this.activeYouTubeWatch ? YOUTUBE_DOWNLOAD_BANNER_HEIGHT : 0)
    );
  }

  private get baseChromeHeight(): number {
    return (
      SHELL_HEIGHT +
      (this.preferences.snapshot.bookmarkBarVisible ? BOOKMARK_BAR_HEIGHT : 0)
    );
  }

  private get activeWebStoreListing(): WebStoreListingSnapshot | null {
    if (this.window.isFullScreen()) return null;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return null;
    const listing = parseChromeWebStoreListingUrl(tab.url);
    if (!listing || tab.dismissedWebStoreExtensionId === listing.extensionId) {
      return null;
    }
    const fallbackTitle =
      tab.title && tab.title !== "Loading…"
        ? tab.title.replace(/\s*-\s*Chrome Web Store\s*$/iu, "").trim()
        : "Chrome Web Store extension";
    return {
      extensionId: listing.extensionId,
      itemUrl: tab.url,
      title: tab.webStoreListingTitle || fallbackTitle,
      description: tab.webStoreListingDescription,
    };
  }

  private get activeYouTubeWatch(): YouTubeWatchSnapshot | null {
    if (this.window.isFullScreen()) return null;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return null;
    const target = parseYouTubeWatchUrl(tab.url);
    if (!target || tab.dismissedYouTubeVideoId === target.videoId) return null;
    return target;
  }

  private layoutActiveView(): void {
    if (this.window.isDestroyed()) return;
    const { width, height } = this.window.getContentBounds();
    this.shellView.setBounds({ x: 0, y: 0, width, height });
    this.shellView.setVisible(this.htmlFullscreenTabId !== this.activeTabId);
    const presentation = this.splitView.presentation(
      this.activeTabId,
      this.currentPageBounds(),
      this.htmlFullscreenTabId,
    );
    const panes = new Map(
      presentation.panes.map((pane) => [pane.tabId, pane.bounds] as const),
    );
    for (const tab of this.tabs.values()) {
      const view = tab.view;
      const bounds = panes.get(tab.id);
      const showPage = Boolean(
        bounds && !tab.isNewTab && !isShellInternalUrl(tab.url),
      );
      if (view && !view.webContents.isDestroyed()) {
        if (showPage && !tab.reader.active) {
          view.setBounds(bounds!);
          view.setVisible(true);
        } else {
          view.setVisible(false);
        }
      }
      const readerView = tab.readerView;
      if (readerView && !readerView.webContents.isDestroyed()) {
        if (showPage && tab.reader.active) {
          readerView.setBounds(bounds!);
          readerView.setVisible(true);
        } else {
          readerView.setVisible(false);
        }
      }
    }
    this.fullscreenHint.layout();
  }

  private exitWebsiteFullscreen(
    tab: TabRecord,
    restorePreviousWindowMode = true,
  ): void {
    if (this.htmlFullscreenTabId !== tab.id) return;
    const shouldRestore =
      restorePreviousWindowMode && this.htmlFullscreenRestoreBrowserFullscreen;
    this.restoreBrowserFullscreenAfterHtmlExit = shouldRestore;
    this.htmlFullscreenTabId = null;
    this.htmlFullscreenRestoreBrowserFullscreen = false;
    this.fullscreenHint.hide();
    const contents = tab.view?.webContents;
    if (contents && !contents.isDestroyed())
      this.requestDocumentFullscreenExit(contents);
    if (!this.window.isDestroyed()) {
      this.window.setFullScreen(false);
      this.layoutActiveView();
    }
    if (shouldRestore) this.scheduleBrowserFullscreenRestoreDecision();
  }

  private finishWebsiteFullscreen(tabId: TabId): boolean {
    if (this.htmlFullscreenTabId !== tabId) return false;
    const shouldRestore = this.htmlFullscreenRestoreBrowserFullscreen;
    this.htmlFullscreenTabId = null;
    this.htmlFullscreenRestoreBrowserFullscreen = false;
    this.restoreBrowserFullscreenAfterHtmlExit = shouldRestore;
    this.fullscreenHint.hide();
    this.layoutActiveView();
    if (shouldRestore) this.scheduleBrowserFullscreenRestoreDecision();
    return true;
  }

  private scheduleBrowserFullscreenRestoreDecision(): void {
    if (this.fullscreenRestoreTimer) clearTimeout(this.fullscreenRestoreTimer);
    this.fullscreenRestoreTimer = setTimeout(() => {
      this.fullscreenRestoreTimer = null;
      if (!this.restoreBrowserFullscreenAfterHtmlExit) return;
      this.restoreBrowserFullscreenAfterHtmlExit = false;
      if (
        !this.window.isDestroyed() &&
        !this.window.isFullScreen() &&
        this.htmlFullscreenTabId === null
      )
        this.window.setFullScreen(true);
    }, 120);
  }

  private requestDocumentFullscreenExit(contents: WebContents): void {
    if (contents.isDestroyed()) return;
    void contents
      .executeJavaScript(
        "document.fullscreenElement ? document.exitFullscreen() : undefined",
        true,
      )
      .catch(() => {
        // The document may navigate or be destroyed while fullscreen is closing.
      });
  }

  private releaseWebsiteInputCapture(tab: TabRecord): void {
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    void contents
      .executeJavaScript(
        "document.pointerLockElement && document.exitPointerLock(); navigator.keyboard?.unlock?.();",
        false,
      )
      .catch(() => {
        // The document may navigate or be destroyed during capture cleanup.
      });
  }

  private closeTabWithoutHistory(tabId: TabId): void {
    const tab = this.requireTab(tabId);
    this.splitView.removeTab(tabId);
    this.tabs.delete(tabId);
    this.order.splice(this.order.indexOf(tabId), 1);
    this.selectedTabIds.delete(tabId);
    if (this.selectionAnchorId === tabId) this.selectionAnchorId = null;
    this.extensionTabs.remove(tabId);
    this.destroyView(tab);
    this.removeEmptyGroup(tab.groupId);
    this.activeTabId = "";
  }

  private destroyView(tab: TabRecord): void {
    this.sendSmartReaderCommand(tab, { type: "stop-narration" });
    this.cancelNarrationForTab(tab);
    if (tab.readerProgressTimer) clearTimeout(tab.readerProgressTimer);
    tab.readerProgressTimer = null;
    void this.flushReadingPosition(tab);
    this.clearReaderTimers(tab);
    this.cancelReaderExtraction(tab, "The tab closed.");
    this.smartReaderDocuments.removeUrl(tab.readerDocumentUrl);
    tab.readerDocumentUrl = null;
    tab.readerArticle = null;
    this.resetSummaryForTab(tab);
    this.destroyReaderView(tab);
    const view = tab.view;
    tab.view = null;
    if (!view) return;
    this.hyperdrive.cancelTab(tab.id);
    try {
      this.window.contentView.removeChildView(view);
    } catch {
      /* Window is closing. */
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  private toSnapshot(
    tab: TabRecord,
    memoryByProcessId: ReadonlyMap<number, number>,
  ): BrowserTabSnapshot {
    tab.reader.saved = Boolean(
      tab.readerArticle &&
      this.browserData.findSavedArticle(tab.readerArticle.sourceUrl),
    );
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      faviconDataUrl: tab.faviconDataUrl,
      isNewTab: tab.isNewTab,
      isLoading: tab.isLoading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      crashed: tab.crashed,
      error: tab.error,
      isMuted: tab.isMuted,
      zoomFactor: tab.zoomFactor,
      pinned: tab.pinned,
      groupId: tab.groupId,
      isSelected: this.selectedTabIds.has(tab.id),
      isAudible: this.isTabAudible(tab),
      memoryBytes: this.tabMemoryBytes(tab, memoryByProcessId),
      thumbnailDataUrl: tab.thumbnailDataUrl,
      reader: { ...tab.reader },
    };
  }

  private async readBlobFavicon(
    contents: WebContents,
    url: string,
  ): Promise<string | null> {
    if (contents.isDestroyed()) return null;
    const code = `(async () => {
      try {
        const response = await fetch(${JSON.stringify(url)});
        const blob = await response.blob();
        if (blob.size < 1 || blob.size > ${faviconLimits.maxBytes} || !blob.type.toLowerCase().startsWith("image/")) return null;
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    })()`;
    try {
      const value = await contents.executeJavaScriptInIsolatedWorld(1001, [
        { code },
      ]);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  private rendererMemoryByProcessId(): ReadonlyMap<number, number> {
    return this.getRendererMemoryByProcessId();
  }

  private tabMemoryBytes(
    tab: TabRecord,
    memoryByProcessId: ReadonlyMap<number, number>,
  ): number | null {
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed()) return null;
    try {
      return memoryByProcessId.get(contents.getOSProcessId()) ?? null;
    } catch {
      return null;
    }
  }

  private isTabAudible(tab: TabRecord): boolean {
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed()) return false;
    try {
      return contents.isCurrentlyAudible();
    } catch {
      return false;
    }
  }

  private async captureTabThumbnail(tab: TabRecord): Promise<void> {
    const contents = tab.view?.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      tab.isNewTab ||
      tab.isLoading ||
      tab.crashed
    )
      return;
    try {
      const image = await contents.capturePage();
      if (image.isEmpty() || !this.tabs.has(tab.id)) return;
      const size = image.getSize();
      if (size.width < 1 || size.height < 1) return;
      const width = Math.min(240, size.width);
      const height = Math.max(
        1,
        Math.round((size.height / size.width) * width),
      );
      tab.thumbnailDataUrl = `data:image/jpeg;base64,${image
        .resize({ width, height })
        .toJPEG(55)
        .toString("base64")}`;
      this.scheduleSnapshot();
    } catch {
      // The renderer can disappear between deactivation and capture.
    }
  }

  private requireTabIds(requested: readonly TabId[]): TabId[] {
    if (!Array.isArray(requested) || requested.length > 500)
      throw new RangeError("A tab operation is limited to 500 tabs.");
    const seen = new Set<TabId>();
    const result: TabId[] = [];
    for (const tabId of requested) {
      if (typeof tabId !== "string")
        throw new TypeError("Tab identifiers must be strings.");
      this.requireTab(tabId);
      if (!seen.has(tabId)) {
        seen.add(tabId);
        result.push(tabId);
      }
    }
    return result;
  }

  private requireTabGroup(groupId: string): TabGroupSnapshot {
    const group = this.tabGroups.get(groupId);
    if (!group) throw new Error(`Unknown tab group: ${groupId}`);
    return group;
  }

  private removeEmptyGroup(groupId: string | null): void {
    if (
      groupId &&
      ![...this.tabs.values()].some((tab) => tab.groupId === groupId)
    ) {
      this.tabGroups.delete(groupId);
    }
  }

  private removeUnreferencedGroups(): void {
    const referenced = new Set(
      [...this.tabs.values()]
        .map((tab) => tab.groupId)
        .filter((id): id is string => id !== null),
    );
    for (const groupId of this.tabGroups.keys()) {
      if (!referenced.has(groupId)) this.tabGroups.delete(groupId);
    }
  }

  private sortPinnedTabsFirst(): void {
    const originalIndex = new Map(
      this.order.map((tabId, index) => [tabId, index] as const),
    );
    this.order.sort(
      (left, right) =>
        Number(this.requireTab(right).pinned) -
          Number(this.requireTab(left).pinned) ||
        (originalIndex.get(left) ?? 0) - (originalIndex.get(right) ?? 0),
    );
  }

  private aiTabOrganizationRevision(): string {
    const tabs = this.order.map((tabId) => {
      const tab = this.requireTab(tabId);
      return {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        pinned: tab.pinned,
        groupId: tab.groupId,
      };
    });
    const groups = [...this.tabGroups.values()]
      .map((group) => ({ ...group }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return createHash("sha256")
      .update(JSON.stringify({ tabs, groups }))
      .digest("hex");
  }

  private tabOrganizationTopologyRevision(): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          order: this.order,
          pinned: this.order.map((tabId) => this.requireTab(tabId).pinned),
          groupIds: this.order.map((tabId) => this.requireTab(tabId).groupId),
          groups: [...this.tabGroups.values()]
            .map((group) => ({ ...group }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }),
      )
      .digest("hex");
  }

  private captureTabOrganizationTopology(): TabOrganizationTopology {
    return {
      order: [...this.order],
      groupIds: new Map(
        this.order.map((tabId) => [tabId, this.requireTab(tabId).groupId]),
      ),
      pinned: new Map(
        this.order.map((tabId) => [tabId, this.requireTab(tabId).pinned]),
      ),
      groups: new Map(
        [...this.tabGroups.entries()].map(([id, group]) => [id, { ...group }]),
      ),
    };
  }

  private installTabOrganizationTopology(
    topology: TabOrganizationTopology,
  ): void {
    if (
      topology.order.length !== this.order.length ||
      new Set(topology.order).size !== topology.order.length ||
      topology.order.some((tabId) => !this.tabs.has(tabId)) ||
      this.order.some((tabId) => !topology.order.includes(tabId))
    ) {
      throw new Error(
        "The stored tab organisation no longer matches this window.",
      );
    }
    for (const tabId of topology.order) {
      const groupId = topology.groupIds.get(tabId) ?? null;
      if (
        (groupId !== null && !topology.groups.has(groupId)) ||
        typeof topology.pinned.get(tabId) !== "boolean"
      ) {
        throw new Error("The tab organisation references an unknown group.");
      }
    }
    this.order.splice(0, this.order.length, ...topology.order);
    this.tabGroups.clear();
    for (const [id, group] of topology.groups)
      this.tabGroups.set(id, { ...group });
    for (const tabId of this.order) {
      const groupId = topology.groupIds.get(tabId) ?? null;
      const tab = this.requireTab(tabId);
      tab.groupId = groupId;
      tab.pinned = topology.pinned.get(tabId) ?? false;
    }
  }

  private assertTabTopologyMutable(): void {
    if (this.aiTabOrganizationMutationInProgress) {
      throw new TabTopologyBusyError(
        "Tabs are being organised. Wait for the current AI action to finish.",
      );
    }
  }

  private assertAiTabTopologyMutable(): void {
    this.assertTabTopologyMutable();
    if (this.tabTopologyMutationOperations > 0) {
      throw new Error(
        "Tabs are changing. Wait for the current tab action to finish, then try again.",
      );
    }
  }

  private beginTabTopologyMutation(): () => void {
    this.assertTabTopologyMutable();
    this.tabTopologyMutationOperations += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.tabTopologyMutationOperations = Math.max(
        0,
        this.tabTopologyMutationOperations - 1,
      );
    };
  }

  private runNativeTabTopologyAction(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (!(error instanceof TabTopologyBusyError)) {
        console.warn("A browser tab action failed.", error);
      }
    }
  }

  private runNativeTabTopologyPromise(promise: Promise<unknown>): void {
    void promise.catch((error: unknown) => {
      if (!(error instanceof TabTopologyBusyError)) {
        console.warn("A browser tab action failed.", error);
      }
    });
  }

  private serializableTabs(): SessionTabInput[] {
    return this.order
      .map((id): SessionTabInput | null => {
        const tab = this.requireTab(id);
        if (
          !tab.isNewTab &&
          !isAllowedWebUrl(tab.url) &&
          !isShellInternalUrl(tab.url) &&
          !isOfflineArchiveUrl(tab.url)
        )
          return null;
        return {
          id: tab.id,
          title: tab.title || "New Tab",
          url: tab.isNewTab ? "" : tab.url,
          isNewTab: tab.isNewTab,
          pinned: tab.pinned,
          groupId: tab.groupId,
        };
      })
      .filter((tab): tab is SessionTabInput => tab !== null);
  }

  private serializableTabGroups(
    tabs: readonly SessionTabInput[],
  ): TabGroupSnapshot[] {
    const referenced = new Set(
      tabs
        .map((tab) => tab.groupId)
        .filter((id): id is string => typeof id === "string"),
    );
    return [...this.tabGroups.values()]
      .filter((group) => referenced.has(group.id))
      .map((group) => ({ ...group }));
  }

  private async syncSavedTabGroup(group: TabGroupSnapshot): Promise<void> {
    if (!group.saved) return;
    const tabs = this.order
      .map((tabId) => this.requireTab(tabId))
      .filter((tab) => tab.groupId === group.id && isAllowedWebUrl(tab.url))
      .map((tab) => ({
        title: tab.title || hostFromUrl(tab.url),
        url: tab.url,
      }));
    const existing = this.browserData
      .listSavedTabGroups()
      .find((candidate) => candidate.id === group.id);
    if (
      existing &&
      existing.name === group.name &&
      existing.color === group.color &&
      JSON.stringify(existing.tabs) === JSON.stringify(tabs)
    )
      return;
    await this.browserData.upsertSavedTabGroup({
      id: group.id,
      name: group.name,
      color: group.color,
      createdAt: group.createdAt,
      tabs,
    });
    this.onBrowserDataChanged();
  }

  private isAllowedInternalUrl(url: string): boolean {
    const origin = this.ublock.extensionOrigin;
    return Boolean(
      isShellInternalUrl(url) ||
      isOfflineArchiveUrl(url) ||
      (origin && url.startsWith(`${origin}/`)) ||
      this.extensions?.isAllowedExtensionUrl(url),
    );
  }

  private isSplitEligibleTab(tab: TabRecord): boolean {
    return Boolean(
      !tab.isNewTab &&
      tab.url &&
      !isShellInternalUrl(tab.url) &&
      (isAllowedWebUrl(tab.url) || this.isAllowedInternalUrl(tab.url)),
    );
  }

  private splitEligibleTabIds(): Set<TabId> {
    return new Set(
      this.order.filter((tabId) => {
        const tab = this.tabs.get(tabId);
        return Boolean(tab && this.isSplitEligibleTab(tab));
      }),
    );
  }

  private requireTab(tabId: TabId): TabRecord {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Unknown tab: ${tabId}`);
    return tab;
  }

  private emitSnapshot(): void {
    if (this.disposed || this.shellView.webContents.isDestroyed()) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    this.shellView.webContents.send(channels.snapshotChanged, this.snapshot);
  }

  private scheduleSnapshot(): void {
    if (
      this.snapshotTimer ||
      this.disposed ||
      this.shellView.webContents.isDestroyed()
    )
      return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.emitSnapshot();
    }, 8);
  }

  private scheduleSessionSave(): void {
    if (
      this.disposed ||
      (!this.preferences.snapshot.restoreSession &&
        ![...this.tabGroups.values()].some((group) => group.saved))
    )
      return;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      void this.flushSession().catch((error) =>
        console.warn("Could not save the browser session.", error),
      );
    }, SESSION_WRITE_DELAY_MS);
  }
}

function isGalleryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "chromecraft:" && url.hostname === "gallery";
  } catch {
    return false;
  }
}

function isOfflinePagesUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "chromecraft:" && url.hostname === "offline-pages";
  } catch {
    return false;
  }
}

function isShellInternalUrl(value: string): boolean {
  return isGalleryUrl(value) || isOfflinePagesUrl(value);
}

function isOfflineArchiveUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "chromecraft-offline:" &&
      /^[a-z0-9_-]{1,128}$/u.test(url.hostname)
    );
  } catch {
    return false;
  }
}

/** Keeps a static offline archive within its browser-owned archive origin. */
export function shouldBlockOfflineArchiveNavigation(
  currentUrl: string,
  targetUrl: string,
): boolean {
  if (!isOfflineArchiveUrl(currentUrl)) return false;
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return (
      !isOfflineArchiveUrl(targetUrl) ||
      current.protocol !== target.protocol ||
      current.hostname !== target.hostname
    );
  } catch {
    return true;
  }
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname || "Untitled";
  } catch {
    return "Untitled";
  }
}

function cleanListingText(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  if (!text) return null;
  return text.slice(0, maximumLength);
}

function cleanAiPromptText(value: string, maximumLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumLength);
}

const TAB_GROUP_COLORS = new Set<TabGroupColor>([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

function requireTabGroupName(value: unknown): string {
  if (typeof value !== "string")
    throw new TypeError("Tab group names must be strings.");
  const name = value.replace(/\s+/gu, " ").trim();
  if (!name || name.length > 128)
    throw new TypeError(
      "Tab group names must be between 1 and 128 characters.",
    );
  return name;
}

function requireTabGroupColor(value: unknown): TabGroupColor {
  if (
    typeof value !== "string" ||
    !TAB_GROUP_COLORS.has(value as TabGroupColor)
  )
    throw new TypeError("Unknown tab group color.");
  return value as TabGroupColor;
}
