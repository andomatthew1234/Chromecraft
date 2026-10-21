import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  BaseWindow,
  BrowserWindow,
  clipboard,
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
  TabId,
  WebStoreListingSnapshot,
} from "../shared/browser";
import { channels } from "../shared/channels";
import {
  isAllowedWebUrl,
  isNavigationInputAddress,
  resolveNavigationInput,
} from "../shared/navigation";
import { parseChromeWebStoreListingUrl } from "../shared/web-store-listing";
import { sidebarWidth } from "../shared/sidebar";
import { BrowserDataStore } from "./browser-data";
import { ChromeWebStoreExtensionService } from "./chrome-web-store-extension-service";
import { ExtensionPopupController } from "./extension-popup-controller";
import { HyperdriveController } from "./hyperdrive/controller";
import {
  buildPageContextMenu,
  buildTextContextMenu,
} from "./page-context-menu";
import { PreferencesStore } from "./preferences";
import { UblockService } from "./ublock-service";

export const SHELL_HEIGHT = 104;
export const BOOKMARK_BAR_HEIGHT = 32;
export const EXTENSION_INSTALL_BANNER_HEIGHT = 88;
export const HYPERDRIVE_MONITOR_WIDTH = 372;
const SESSION_WRITE_DELAY_MS = 300;
const EXTENSION_WINDOW_NAME_PREFIX = "__chromecraft_extension_window_";
const ZOOM_FACTORS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
  5,
];

export function isWebsiteFullscreenPermissionAllowed(
  permission: string,
  topLevelUrl: string,
  requestingUrl?: string,
): boolean {
  return (
    permission === "fullscreen" &&
    isAllowedWebUrl(topLevelUrl) &&
    (!requestingUrl || isAllowedWebUrl(requestingUrl))
  );
}

interface TabRecord {
  id: TabId;
  title: string;
  url: string;
  requestedUrl: string;
  isNewTab: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  error: string | null;
  isMuted: boolean;
  zoomFactor: number;
  view: WebContentsView | null;
  lastHistoryUrl: string;
  lastFindText: string;
  findRequestId: number;
  nextHistoryEntryTyped: boolean;
  dismissedWebStoreExtensionId: string | null;
  webStoreListingTitle: string | null;
  webStoreListingDescription: string | null;
}

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
  private readonly tabs = new Map<TabId, TabRecord>();
  private readonly order: TabId[] = [];
  private readonly extensionTabs = new ExtensionTabLifecycle();
  private activeTabId = "";
  private disposed = false;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly extensionPopup: ExtensionPopupController | null;
  private readonly extensionWindows = new Set<BrowserWindow>();
  private htmlFullscreenTabId: TabId | null = null;

  constructor(
    private readonly window: BaseWindow,
    private readonly shellView: WebContentsView,
    private readonly browserSession: Session,
    private readonly ublock: UblockService,
    private readonly extensions: ChromeWebStoreExtensionService | null,
    private readonly preferences: PreferencesStore,
    private readonly browserData: BrowserDataStore,
    private readonly hyperdrive: HyperdriveController,
    private readonly onBrowserDataChanged: () => void,
    private readonly onExtensionsChanged: () => void,
    private readonly onExtensionCommandInput?: (
      input: Electron.Input,
    ) => boolean,
  ) {
    this.extensionPopup = extensions
      ? new ExtensionPopupController(window, browserSession, extensions, {
          onStateChanged: onExtensionsChanged,
          openExternalUrl: (url) => this.createTab(url),
        })
      : null;
    this.window.on("resize", () => this.scheduleLayout());
    const refreshFullscreenLayout = () => {
      this.layoutActiveView();
      this.emitSnapshot();
    };
    this.window.on("enter-full-screen", refreshFullscreenLayout);
    this.window.on("leave-full-screen", refreshFullscreenLayout);
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

    for (const saved of session.tabs.slice(0, 50)) {
      const tab = this.makeTab(
        saved.id,
        saved.title,
        saved.url,
        saved.isNewTab,
      );
      this.tabs.set(tab.id, tab);
      this.order.push(tab.id);
    }
    this.activeTabId = this.tabs.has(session.activeTabId ?? "")
      ? (session.activeTabId as string)
      : this.order[0];
    this.extensionTabs.activate(this.activeTabId);
    this.hyperdrive.setActiveTab(this.activeTabId);
    const active = this.requireTab(this.activeTabId);
    if (!active.isNewTab && active.url) {
      void this.navigateToUrl(active, active.url, false, true);
    } else {
      this.layoutActiveView();
      this.emitSnapshot();
    }
  }

  get snapshot(): BrowserSnapshot {
    return {
      tabs: this.order.map((id) => this.toSnapshot(this.requireTab(id))),
      activeTabId: this.activeTabId,
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
        extensionDeveloperMode:
          this.preferences.snapshot.extensionDeveloperMode,
      },
      baseChromeHeight: this.baseChromeHeight,
      chromeHeight: this.chromeHeight,
      webStoreListing: this.activeWebStoreListing,
    };
  }

  get liveViewCount(): number {
    return [...this.tabs.values()].filter(
      (tab) => tab.view && !tab.view.webContents.isDestroyed(),
    ).length;
  }

  get extensionPopupId(): string | null {
    return this.extensionPopup?.openExtensionId ?? null;
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

  activateTab(tabId: TabId): void {
    const next = this.requireTab(tabId);
    const previous = this.tabs.get(this.activeTabId);
    if (previous?.id === next.id) {
      this.hyperdrive.setActiveTab(tabId);
      this.layoutActiveView();
      return;
    }
    if (previous && this.htmlFullscreenTabId === previous.id)
      this.exitWebsiteFullscreen(previous);
    this.extensionPopup?.close();
    previous?.view?.setVisible(false);
    this.activeTabId = tabId;
    this.extensionTabs.activate(tabId);
    this.hyperdrive.setActiveTab(tabId);
    if (!next.isNewTab && next.url && !next.view) {
      void this.navigateToUrl(
        next,
        next.url,
        this.isAllowedInternalUrl(next.url),
        false,
      );
    }
    this.layoutActiveView();
    next.view?.setVisible(!next.isNewTab);
    this.emitSnapshot();
    this.scheduleSessionSave();
  }

  closeTab(tabId: TabId): void {
    const tab = this.requireTab(tabId);
    if (this.htmlFullscreenTabId === tab.id) this.exitWebsiteFullscreen(tab);
    const closingIndex = this.order.indexOf(tabId);
    this.tabs.delete(tabId);
    this.order.splice(closingIndex, 1);
    this.extensionTabs.remove(tabId);
    this.destroyView(tab);
    if (isAllowedWebUrl(tab.url)) {
      void this.browserData
        .addRecentlyClosedTab({
          title: tab.title || hostFromUrl(tab.url),
          url: tab.url,
        })
        .then(this.onBrowserDataChanged)
        .catch((error) =>
          console.warn("Could not save the closed tab.", error),
        );
    }
    if (this.order.length === 0) {
      this.createTab();
      return;
    }
    if (this.activeTabId === tabId) {
      const nextIndex = Math.min(closingIndex, this.order.length - 1);
      this.activeTabId = "";
      this.activateTab(this.order[nextIndex]);
      return;
    }
    this.emitSnapshot();
    this.scheduleSessionSave();
  }

  async duplicateTab(tabId: TabId): Promise<TabId> {
    const source = this.requireTab(tabId);
    const duplicateId = this.createTab(undefined, false);
    const currentIndex = this.order.indexOf(duplicateId);
    this.order.splice(currentIndex, 1);
    this.order.splice(this.order.indexOf(tabId) + 1, 0, duplicateId);
    const duplicate = this.requireTab(duplicateId);
    duplicate.isMuted = source.isMuted;
    duplicate.zoomFactor = source.zoomFactor;
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
  }

  async reopenClosedTab(): Promise<TabId | null> {
    const closed = await this.browserData.takeRecentlyClosedTab();
    if (!closed) return null;
    this.onBrowserDataChanged();
    const active = this.tabs.get(this.activeTabId);
    if (this.order.length === 1 && active?.isNewTab)
      this.closeTabWithoutHistory(active.id);
    return this.createTab(closed.url);
  }

  async navigate(tabId: TabId, input: string, typed = false): Promise<void> {
    if (tabId === this.activeTabId) this.extensionPopup?.close();
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
    if (tab.view?.webContents.navigationHistory.canGoBack())
      tab.view.webContents.navigationHistory.goBack();
  }

  goForward(tabId: TabId): void {
    const tab = this.requireTab(tabId);
    if (tab.view?.webContents.navigationHistory.canGoForward())
      tab.view.webContents.navigationHistory.goForward();
  }

  reload(tabId: TabId): void {
    const tab = this.requireTab(tabId);
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
    tab.view?.webContents.setZoomFactor(tab.zoomFactor);
    this.emitSnapshot();
  }

  findInPage(tabId: TabId, text: string, forward: boolean): void {
    if (text.length > 1024) throw new RangeError("Find text is too long.");
    const contents = this.requireTab(tabId).view?.webContents;
    if (!contents || contents.isDestroyed() || !text) return;
    const tab = this.requireTab(tabId);
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
    tab.view?.webContents.stopFindInPage("clearSelection");
  }

  setFullscreen(fullscreen: boolean): void {
    this.extensionPopup?.close();
    if (!fullscreen && this.htmlFullscreenTabId) {
      const tab = this.tabs.get(this.htmlFullscreenTabId);
      if (tab) this.exitWebsiteFullscreen(tab);
      else this.htmlFullscreenTabId = null;
    }
    this.window.setFullScreen(fullscreen);
  }

  canGrantWebsiteFullscreen(
    contents: WebContents,
    permission: string,
    requestingUrl?: string,
  ): boolean {
    if (contents.isDestroyed()) return false;
    const active = this.tabs.get(this.activeTabId);
    return Boolean(
      active?.view?.webContents === contents &&
      isWebsiteFullscreenPermissionAllowed(
        permission,
        contents.getURL(),
        requestingUrl,
      ),
    );
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
    if (!this.preferences.snapshot.restoreSession || this.order.length === 0)
      return;
    const tabs = this.order
      .map((id) => {
        const tab = this.requireTab(id);
        if (!tab.isNewTab && !isAllowedWebUrl(tab.url)) return null;
        return {
          id: tab.id,
          title: tab.title || "New Tab",
          url: tab.isNewTab ? "" : tab.url,
          isNewTab: tab.isNewTab,
        };
      })
      .filter((tab): tab is NonNullable<typeof tab> => tab !== null);
    if (tabs.length === 0) {
      await this.browserData.clearSession();
      return;
    }
    const activeId = tabs.some((tab) => tab.id === this.activeTabId)
      ? this.activeTabId
      : tabs[0].id;
    await this.browserData.saveSession(tabs, activeId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.extensionPopup?.dispose();
    for (const extensionWindow of this.extensionWindows) {
      if (!extensionWindow.isDestroyed()) extensionWindow.destroy();
    }
    this.extensionWindows.clear();
    void this.flushSession().catch((error) =>
      console.warn("Could not save the browser session.", error),
    );
    for (const tab of this.tabs.values()) this.destroyView(tab);
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
  ): TabRecord {
    const tab: TabRecord = {
      id,
      title: title || "New Tab",
      url,
      requestedUrl: url,
      isNewTab,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      error: null,
      isMuted: false,
      zoomFactor: 1,
      view: null,
      lastHistoryUrl: "",
      lastFindText: "",
      findRequestId: 0,
      nextHistoryEntryTyped: false,
      dismissedWebStoreExtensionId: null,
      webStoreListingTitle: null,
      webStoreListingDescription: null,
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
    // Attach the real Electron target before mutating navigation state so the
    // extension event stream observes one canonical native tab ID from
    // creation through the first navigation.
    const view = this.ensureView(tab);
    this.resetWebStoreVisitIfChanged(tab, target);
    tab.title = "Loading…";
    tab.url = target;
    tab.requestedUrl = target;
    tab.isNewTab = false;
    tab.isLoading = true;
    tab.crashed = false;
    tab.error = null;
    tab.nextHistoryEntryTyped = typed;
    if (tab.id === this.activeTabId) view.setVisible(true);
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
    view.setVisible(tab.id === this.activeTabId);
    this.attachShortcutHandler(view);
    const contents = view.webContents;
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
            openInNewTab: (url) => withLiveTab(() => this.createTab(url))(),
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
      if (this.htmlFullscreenTabId === tab.id) {
        this.htmlFullscreenTabId = null;
        if (!this.window.isDestroyed()) {
          this.window.setFullScreen(false);
          this.layoutActiveView();
        }
      }
      this.extensionTabs.remove(tab.id, contents.id);
      if (tab.view === view) tab.view = null;
      if (this.tabs.has(tab.id) && tab.id === this.activeTabId)
        this.extensionTabs.activate(tab.id);
    });
    contents.on("enter-html-full-screen", () => {
      if (
        tab.id !== this.activeTabId ||
        tab.view !== view ||
        !this.canGrantWebsiteFullscreen(contents, "fullscreen")
      ) {
        this.requestDocumentFullscreenExit(contents);
        return;
      }
      this.htmlFullscreenTabId = tab.id;
      this.extensionPopup?.close();
      this.layoutActiveView();
      contents.focus();
    });
    contents.on("leave-html-full-screen", () => {
      if (this.htmlFullscreenTabId !== tab.id) return;
      this.htmlFullscreenTabId = null;
      this.layoutActiveView();
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
      channels.hyperdrivePreparationResult,
      (event, value: unknown) => {
        if (event.senderFrame !== contents.mainFrame) return;
        this.hyperdrive.handlePreparationResult(tab.id, value);
      },
    );
    contents.setZoomMode("isolated");
    contents.setZoomFactor(tab.zoomFactor);
    contents.setAudioMuted(tab.isMuted);

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
      }
    });
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
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
      this.updateNavigatedUrl(tab, url);
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
        this.hyperdrive.navigationFailed(
          tab.id,
          validatedUrl || tab.requestedUrl,
          errorDescription,
        );
        tab.isLoading = false;
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
      if (!isAllowedWebUrl(url) && !this.isAllowedInternalUrl(url))
        event.preventDefault();
    });
    contents.setWindowOpenHandler((details) => {
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
      if (isAllowedWebUrl(details.url))
        queueMicrotask(() =>
          this.createTab(details.url, details.disposition !== "background-tab"),
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
      if (isAllowedWebUrl(url)) this.createTab(url);
    });
    extensionWindow.webContents.setWindowOpenHandler((request) => {
      if (isAllowedWebUrl(request.url)) {
        queueMicrotask(() => this.createTab(request.url));
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
      if (command && input.shift && key === "t") {
        event.preventDefault();
        void this.reopenClosedTab();
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
        this.createTab();
        this.focusOmnibox();
      } else if (command && key === "w") {
        event.preventDefault();
        if (active) this.closeTab(active.id);
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
      } else if (key === "escape" && active?.id === this.htmlFullscreenTabId) {
        event.preventDefault();
        this.exitWebsiteFullscreen(active);
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
      (this.activeWebStoreListing ? EXTENSION_INSTALL_BANNER_HEIGHT : 0)
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

  private layoutActiveView(): void {
    if (this.window.isDestroyed()) return;
    const { width, height } = this.window.getContentBounds();
    this.shellView.setBounds({ x: 0, y: 0, width, height });
    this.shellView.setVisible(this.htmlFullscreenTabId !== this.activeTabId);
    this.tabs.get(this.activeTabId)?.view?.setBounds(this.currentPageBounds());
  }

  private exitWebsiteFullscreen(tab: TabRecord): void {
    if (this.htmlFullscreenTabId !== tab.id) return;
    this.htmlFullscreenTabId = null;
    const contents = tab.view?.webContents;
    if (contents && !contents.isDestroyed())
      this.requestDocumentFullscreenExit(contents);
    if (!this.window.isDestroyed()) {
      this.window.setFullScreen(false);
      this.layoutActiveView();
    }
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

  private closeTabWithoutHistory(tabId: TabId): void {
    const tab = this.requireTab(tabId);
    this.tabs.delete(tabId);
    this.order.splice(this.order.indexOf(tabId), 1);
    this.extensionTabs.remove(tabId);
    this.destroyView(tab);
    this.activeTabId = "";
  }

  private destroyView(tab: TabRecord): void {
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

  private toSnapshot(tab: TabRecord): BrowserTabSnapshot {
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      isNewTab: tab.isNewTab,
      isLoading: tab.isLoading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      crashed: tab.crashed,
      error: tab.error,
      isMuted: tab.isMuted,
      zoomFactor: tab.zoomFactor,
    };
  }

  private isAllowedInternalUrl(url: string): boolean {
    const origin = this.ublock.extensionOrigin;
    return Boolean(
      (origin && url.startsWith(`${origin}/`)) ||
      this.extensions?.isAllowedExtensionUrl(url),
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
    if (!this.preferences.snapshot.restoreSession || this.disposed) return;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      void this.flushSession().catch((error) =>
        console.warn("Could not save the browser session.", error),
      );
    }, SESSION_WRITE_DELAY_MS);
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
