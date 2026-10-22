import { contextBridge, ipcRenderer } from "electron";

import type {
  BrowserDataSnapshot,
  BrowserSnapshot,
  ChromecraftApi,
  DownloadSnapshot,
  ExtensionInstallPreviewSnapshot,
  ExtensionsSnapshot,
  FindResultSnapshot,
  HyperdriveSnapshot,
  TabId,
  YouTubeDownloadsSnapshot,
} from "../shared/browser";
import { channels } from "../shared/channels";
import type { UpdateSnapshot } from "../shared/updates";

const api: ChromecraftApi = {
  getSnapshot: () =>
    ipcRenderer.invoke(channels.getSnapshot) as Promise<BrowserSnapshot>,
  createTab: (input?: string) =>
    ipcRenderer.invoke(channels.createTab, input) as Promise<TabId>,
  activateTab: (tabId) =>
    ipcRenderer.invoke(channels.activateTab, tabId) as Promise<void>,
  closeTab: (tabId) =>
    ipcRenderer.invoke(channels.closeTab, tabId) as Promise<void>,
  navigate: (tabId, input, typed) =>
    ipcRenderer.invoke(channels.navigate, tabId, input, typed) as Promise<void>,
  goBack: (tabId) =>
    ipcRenderer.invoke(channels.goBack, tabId) as Promise<void>,
  goForward: (tabId) =>
    ipcRenderer.invoke(channels.goForward, tabId) as Promise<void>,
  reload: (tabId) =>
    ipcRenderer.invoke(channels.reload, tabId) as Promise<void>,
  stop: (tabId) => ipcRenderer.invoke(channels.stop, tabId) as Promise<void>,
  duplicateTab: (tabId) =>
    ipcRenderer.invoke(channels.duplicateTab, tabId) as Promise<TabId>,
  reopenClosedTab: () =>
    ipcRenderer.invoke(channels.reopenClosedTab) as Promise<TabId | null>,
  toggleMute: (tabId) =>
    ipcRenderer.invoke(channels.toggleMute, tabId) as Promise<void>,
  setZoom: (tabId, factor) =>
    ipcRenderer.invoke(channels.setZoom, tabId, factor) as Promise<void>,
  findInPage: (tabId, text, forward) =>
    ipcRenderer.invoke(
      channels.findInPage,
      tabId,
      text,
      forward,
    ) as Promise<void>,
  stopFindInPage: (tabId) =>
    ipcRenderer.invoke(channels.stopFindInPage, tabId) as Promise<void>,
  setFullscreen: (fullscreen) =>
    ipcRenderer.invoke(channels.setFullscreen, fullscreen) as Promise<void>,
  setChromeOverlayOpen: (open) =>
    ipcRenderer.invoke(channels.setChromeOverlayOpen, open) as Promise<void>,
  setSidebarAttached: (attached) =>
    ipcRenderer.invoke(channels.setSidebarAttached, attached) as Promise<void>,
  setSidebarOpen: (open) =>
    ipcRenderer.invoke(channels.setSidebarOpen, open) as Promise<void>,
  setBookmarkBarVisible: (visible) =>
    ipcRenderer.invoke(
      channels.setBookmarkBarVisible,
      visible,
    ) as Promise<void>,
  setRestoreSession: (enabled) =>
    ipcRenderer.invoke(channels.setRestoreSession, enabled) as Promise<void>,
  setNewTabTheme: (theme) =>
    ipcRenderer.invoke(channels.setNewTabTheme, theme) as Promise<void>,
  setRemoteSearchSuggestionsEnabled: (enabled) =>
    ipcRenderer.invoke(
      channels.setRemoteSearchSuggestionsEnabled,
      enabled,
    ) as Promise<void>,
  getSearchSuggestions: (query) =>
    ipcRenderer.invoke(channels.getSearchSuggestions, query),
  getHyperdriveSnapshot: () =>
    ipcRenderer.invoke(
      channels.getHyperdriveSnapshot,
    ) as Promise<HyperdriveSnapshot>,
  setHyperdriveMode: (mode) =>
    ipcRenderer.invoke(channels.setHyperdriveMode, mode) as Promise<void>,
  setHyperdriveRamBudgetMb: (megabytes) =>
    ipcRenderer.invoke(
      channels.setHyperdriveRamBudgetMb,
      megabytes,
    ) as Promise<void>,
  setHyperdriveCrossSitePreloadingEnabled: (enabled) =>
    ipcRenderer.invoke(
      channels.setHyperdriveCrossSitePreloadingEnabled,
      enabled,
    ) as Promise<void>,
  setHyperdriveSearchPreloadingEnabled: (enabled) =>
    ipcRenderer.invoke(
      channels.setHyperdriveSearchPreloadingEnabled,
      enabled,
    ) as Promise<void>,
  setHyperdriveExcludedHosts: (hosts) =>
    ipcRenderer.invoke(
      channels.setHyperdriveExcludedHosts,
      hosts,
    ) as Promise<void>,
  setHyperdriveMonitorOpen: (open) =>
    ipcRenderer.invoke(
      channels.setHyperdriveMonitorOpen,
      open,
    ) as Promise<void>,
  setHyperdriveDeveloperMode: (enabled) =>
    ipcRenderer.invoke(
      channels.setHyperdriveDeveloperMode,
      enabled,
    ) as Promise<void>,
  setHyperdriveMonitorPaused: (paused) =>
    ipcRenderer.invoke(
      channels.setHyperdriveMonitorPaused,
      paused,
    ) as Promise<void>,
  clearHyperdriveSpeculation: () =>
    ipcRenderer.invoke(channels.clearHyperdriveSpeculation) as Promise<void>,
  clearHyperdriveEvents: () =>
    ipcRenderer.invoke(channels.clearHyperdriveEvents) as Promise<void>,
  updateHyperdriveOmnibox: (signal) =>
    ipcRenderer.send(channels.updateHyperdriveOmnibox, signal),
  setUblockEnabled: (enabled) =>
    ipcRenderer.invoke(channels.setUblockEnabled, enabled) as Promise<void>,
  openUblockDashboard: () =>
    ipcRenderer.invoke(channels.openUblockDashboard) as Promise<void>,
  getExtensions: () =>
    ipcRenderer.invoke(channels.getExtensions) as Promise<ExtensionsSnapshot>,
  installExtensionFromWebStore: (itemUrl) =>
    ipcRenderer.invoke(
      channels.installExtensionFromWebStore,
      itemUrl,
    ) as Promise<void>,
  prepareExtensionFromWebStore: (itemUrl) =>
    ipcRenderer.invoke(
      channels.prepareExtensionFromWebStore,
      itemUrl,
    ) as Promise<ExtensionInstallPreviewSnapshot>,
  commitPreparedExtension: (token) =>
    ipcRenderer.invoke(
      channels.commitPreparedExtension,
      token,
    ) as Promise<void>,
  cancelPreparedExtension: (token) =>
    ipcRenderer.invoke(
      channels.cancelPreparedExtension,
      token,
    ) as Promise<void>,
  dismissWebStoreInstallBanner: (tabId, extensionId) =>
    ipcRenderer.invoke(
      channels.dismissWebStoreInstallBanner,
      tabId,
      extensionId,
    ) as Promise<void>,
  setExtensionEnabled: (id, enabled) =>
    ipcRenderer.invoke(
      channels.setExtensionEnabled,
      id,
      enabled,
    ) as Promise<void>,
  setExtensionDeveloperMode: (enabled) =>
    ipcRenderer.invoke(
      channels.setExtensionDeveloperMode,
      enabled,
    ) as Promise<void>,
  importUnpackedExtension: () =>
    ipcRenderer.invoke(channels.importUnpackedExtension) as Promise<boolean>,
  removeExtension: (id) =>
    ipcRenderer.invoke(channels.removeExtension, id) as Promise<void>,
  openExtensionPage: (id, page) =>
    ipcRenderer.invoke(channels.openExtensionPage, id, page) as Promise<void>,
  toggleExtensionPopup: (id, anchor) =>
    ipcRenderer.invoke(
      channels.toggleExtensionPopup,
      id,
      anchor,
    ) as Promise<void>,
  closeExtensionPopup: () =>
    ipcRenderer.invoke(channels.closeExtensionPopup) as Promise<void>,
  getBrowserData: () =>
    ipcRenderer.invoke(channels.getBrowserData) as Promise<BrowserDataSnapshot>,
  addBookmark: (input) =>
    ipcRenderer.invoke(channels.addBookmark, input) as Promise<void>,
  removeBookmark: (id) =>
    ipcRenderer.invoke(channels.removeBookmark, id) as Promise<void>,
  importBookmarks: () =>
    ipcRenderer.invoke(channels.importBookmarks) as Promise<number>,
  exportBookmarks: () =>
    ipcRenderer.invoke(channels.exportBookmarks) as Promise<boolean>,
  removeHistory: (id) =>
    ipcRenderer.invoke(channels.removeHistory, id) as Promise<void>,
  clearHistory: (range) =>
    ipcRenderer.invoke(channels.clearHistory, range) as Promise<void>,
  addQuickLink: (input) =>
    ipcRenderer.invoke(channels.addQuickLink, input) as Promise<void>,
  removeQuickLink: (id) =>
    ipcRenderer.invoke(channels.removeQuickLink, id) as Promise<void>,
  getDownloads: () =>
    ipcRenderer.invoke(channels.getDownloads) as Promise<DownloadSnapshot>,
  getYouTubeDownloads: () =>
    ipcRenderer.invoke(
      channels.getYouTubeDownloads,
    ) as Promise<YouTubeDownloadsSnapshot>,
  downloadActiveYouTubeVideo: (tabId) =>
    ipcRenderer.invoke(channels.startYouTubeDownload, tabId) as Promise<string>,
  dismissYouTubeDownloadBanner: (tabId, videoId) =>
    ipcRenderer.invoke(
      channels.dismissYouTubeDownloadBanner,
      tabId,
      videoId,
    ) as Promise<void>,
  pauseDownload: (id) =>
    ipcRenderer.invoke(channels.pauseDownload, id) as Promise<void>,
  resumeDownload: (id) =>
    ipcRenderer.invoke(channels.resumeDownload, id) as Promise<void>,
  retryDownload: (id) =>
    ipcRenderer.invoke(channels.retryDownload, id) as Promise<void>,
  cancelDownload: (id) =>
    ipcRenderer.invoke(channels.cancelDownload, id) as Promise<void>,
  openDownload: (id) =>
    ipcRenderer.invoke(channels.openDownload, id) as Promise<void>,
  showDownloadInFolder: (id) =>
    ipcRenderer.invoke(channels.showDownloadInFolder, id) as Promise<void>,
  removeDownload: (id) =>
    ipcRenderer.invoke(channels.removeDownload, id) as Promise<void>,
  clearFinishedDownloads: () =>
    ipcRenderer.invoke(channels.clearFinishedDownloads) as Promise<void>,
  getUpdateSnapshot: () =>
    ipcRenderer.invoke(channels.getUpdates) as Promise<UpdateSnapshot>,
  checkForUpdates: () =>
    ipcRenderer.invoke(channels.checkForUpdates) as Promise<UpdateSnapshot>,
  restartToUpdate: () =>
    ipcRenderer.invoke(channels.restartToUpdate) as Promise<void>,
  onSnapshot: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: BrowserSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(channels.snapshotChanged, handler);
    return () => ipcRenderer.removeListener(channels.snapshotChanged, handler);
  },
  onBrowserData: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: BrowserDataSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(channels.browserDataChanged, handler);
    return () =>
      ipcRenderer.removeListener(channels.browserDataChanged, handler);
  },
  onDownloads: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: DownloadSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(channels.downloadsChanged, handler);
    return () => ipcRenderer.removeListener(channels.downloadsChanged, handler);
  },
  onYouTubeDownloads: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: YouTubeDownloadsSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(channels.youtubeDownloadsChanged, handler);
    return () =>
      ipcRenderer.removeListener(channels.youtubeDownloadsChanged, handler);
  },
  onFindResult: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: FindResultSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(channels.findResult, handler);
    return () => ipcRenderer.removeListener(channels.findResult, handler);
  },
  onShowFind: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(channels.showFind, handler);
    return () => ipcRenderer.removeListener(channels.showFind, handler);
  },
  onOpenCommandPalette: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(channels.openCommandPalette, handler);
    return () =>
      ipcRenderer.removeListener(channels.openCommandPalette, handler);
  },
  onFocusOmnibox: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(channels.focusOmnibox, handler);
    return () => ipcRenderer.removeListener(channels.focusOmnibox, handler);
  },
  onHyperdriveSnapshot: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: HyperdriveSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(channels.hyperdriveSnapshotChanged, handler);
    return () =>
      ipcRenderer.removeListener(channels.hyperdriveSnapshotChanged, handler);
  },
  onExtensions: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: ExtensionsSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(channels.extensionsChanged, handler);
    return () =>
      ipcRenderer.removeListener(channels.extensionsChanged, handler);
  },
  onUpdateSnapshot: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: UpdateSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(channels.updatesChanged, handler);
    return () => ipcRenderer.removeListener(channels.updatesChanged, handler);
  },
};

contextBridge.exposeInMainWorld("chromecraft", api);
