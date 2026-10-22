import { contextBridge, ipcRenderer } from "electron";

import type {
  BrowserDataSnapshot,
  BrowserSnapshot,
  ChromecraftApi,
  DownloadSnapshot,
  ExtensionInstallPreviewSnapshot,
  ExtensionsSnapshot,
  FindResultSnapshot,
  GallerySnapshot,
  HyperdriveSnapshot,
  SmartDownloadsSnapshot,
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
  getSmartDownloads: () =>
    ipcRenderer.invoke(
      channels.getSmartDownloads,
    ) as Promise<SmartDownloadsSnapshot>,
  setSmartDownloadsEnabled: (enabled) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadsEnabled,
      enabled,
    ) as Promise<void>,
  setSmartDownloadsQuotaBytes: (bytes) =>
    ipcRenderer.invoke(channels.setSmartDownloadsQuota, bytes) as Promise<void>,
  setSmartDownloadsQuality: (quality) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadsQuality,
      quality,
    ) as Promise<void>,
  setSmartDownloadsCleanupPolicy: (policy) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadsCleanupPolicy,
      policy,
    ) as Promise<void>,
  setSmartDownloadsCheckInterval: (minutes) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadsCheckInterval,
      minutes,
    ) as Promise<void>,
  setSmartDownloadsIncludeShorts: (enabled) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadsIncludeShorts,
      enabled,
    ) as Promise<void>,
  setSmartDownloadsIncludeLivestreamReplays: (enabled) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadsIncludeLivestreamReplays,
      enabled,
    ) as Promise<void>,
  setSmartDownloadsPauseDuringHeavyActivity: (enabled) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadsPauseDuringHeavyActivity,
      enabled,
    ) as Promise<void>,
  setSmartDownloadsBackgroundEnabled: (enabled) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadsBackgroundEnabled,
      enabled,
    ) as Promise<void>,
  setSmartDownloadsStartWithWindows: (enabled) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadsStartWithWindows,
      enabled,
    ) as Promise<void>,
  setSmartDownloadsRecommendationsEnabled: (enabled) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadsRecommendationsEnabled,
      enabled,
    ) as Promise<void>,
  addSmartDownloadsChannel: (input, initialMode) =>
    ipcRenderer.invoke(
      channels.addSmartDownloadsChannel,
      input,
      initialMode,
    ) as Promise<void>,
  setSmartDownloadsChannelEnabled: (id, enabled) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadsChannelEnabled,
      id,
      enabled,
    ) as Promise<void>,
  checkSmartDownloads: (channelId) =>
    ipcRenderer.invoke(
      channels.checkSmartDownloads,
      channelId,
    ) as Promise<void>,
  removeSmartDownloadsChannel: (id) =>
    ipcRenderer.invoke(
      channels.removeSmartDownloadsChannel,
      id,
    ) as Promise<void>,
  pauseSmartDownloadsQueue: () =>
    ipcRenderer.invoke(channels.pauseSmartDownloadsQueue) as Promise<void>,
  resumeSmartDownloadsQueue: () =>
    ipcRenderer.invoke(channels.resumeSmartDownloadsQueue) as Promise<void>,
  retrySmartDownloadJob: (id) =>
    ipcRenderer.invoke(channels.retrySmartDownloadJob, id) as Promise<void>,
  cancelSmartDownloadJob: (id) =>
    ipcRenderer.invoke(channels.cancelSmartDownloadJob, id) as Promise<void>,
  dismissSmartDownloadsRecommendation: (channelId) =>
    ipcRenderer.invoke(
      channels.dismissSmartDownloadsRecommendation,
      channelId,
    ) as Promise<void>,
  clearSmartDownloadsRecommendationHistory: () =>
    ipcRenderer.invoke(
      channels.clearSmartDownloadsRecommendationHistory,
    ) as Promise<void>,
  downloadActiveYouTubeVideo: (tabId) =>
    ipcRenderer.invoke(channels.startYouTubeDownload, tabId) as Promise<string>,
  cancelYouTubeDownload: (id) =>
    ipcRenderer.invoke(channels.cancelYouTubeDownload, id) as Promise<void>,
  retryYouTubeDownload: (id) =>
    ipcRenderer.invoke(channels.retryYouTubeDownload, id) as Promise<string>,
  openYouTubeDownload: (id) =>
    ipcRenderer.invoke(channels.openYouTubeDownload, id) as Promise<void>,
  dismissYouTubeDownload: (id) =>
    ipcRenderer.invoke(channels.dismissYouTubeDownload, id) as Promise<void>,
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
  getGallery: () =>
    ipcRenderer.invoke(channels.getGallery) as Promise<GallerySnapshot>,
  openGallery: (entryId, forceNew) =>
    ipcRenderer.invoke(
      channels.openGallery,
      entryId,
      forceNew,
    ) as Promise<TabId>,
  openGalleryFile: (id) =>
    ipcRenderer.invoke(channels.openGalleryFile, id) as Promise<void>,
  showGalleryFile: (id) =>
    ipcRenderer.invoke(channels.showGalleryFile, id) as Promise<void>,
  copyGalleryPath: (id) =>
    ipcRenderer.invoke(channels.copyGalleryPath, id) as Promise<void>,
  copyGallerySourceUrl: (id) =>
    ipcRenderer.invoke(channels.copyGallerySourceUrl, id) as Promise<void>,
  renameGalleryItem: (id, title) =>
    ipcRenderer.invoke(channels.renameGalleryItem, id, title) as Promise<void>,
  removeGalleryItem: (id) =>
    ipcRenderer.invoke(channels.removeGalleryItem, id) as Promise<void>,
  deleteGalleryItem: (id) =>
    ipcRenderer.invoke(channels.deleteGalleryItem, id) as Promise<void>,
  deleteAllGalleryItems: () =>
    ipcRenderer.invoke(channels.deleteAllGalleryItems) as Promise<void>,
  importGalleryDownloads: () =>
    ipcRenderer.invoke(channels.importGalleryDownloads) as Promise<number>,
  updateGalleryMediaMetadata: (id, durationSeconds, width, height) =>
    ipcRenderer.invoke(
      channels.updateGalleryMediaMetadata,
      id,
      durationSeconds,
      width,
      height,
    ) as Promise<void>,
  setSmartDownloadKeepForever: (id, keepForever) =>
    ipcRenderer.invoke(
      channels.setSmartDownloadKeepForever,
      id,
      keepForever,
    ) as Promise<void>,
  markGalleryItemWatched: (id) =>
    ipcRenderer.invoke(channels.markGalleryItemWatched, id) as Promise<void>,
  setShowDownloadProgressInToolbar: (enabled) =>
    ipcRenderer.invoke(
      channels.setShowDownloadProgressInToolbar,
      enabled,
    ) as Promise<void>,
  setShowDownloadCompletionNotification: (enabled) =>
    ipcRenderer.invoke(
      channels.setShowDownloadCompletionNotification,
      enabled,
    ) as Promise<void>,
  setAddVideosToGallery: (enabled) =>
    ipcRenderer.invoke(
      channels.setAddVideosToGallery,
      enabled,
    ) as Promise<void>,
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
  onSmartDownloads: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: SmartDownloadsSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(channels.smartDownloadsChanged, handler);
    return () =>
      ipcRenderer.removeListener(channels.smartDownloadsChanged, handler);
  },
  onShowSmartDownloadsSettings: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(channels.showSmartDownloadsSettings, handler);
    return () =>
      ipcRenderer.removeListener(channels.showSmartDownloadsSettings, handler);
  },
  onGallery: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: GallerySnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(channels.galleryChanged, handler);
    return () => ipcRenderer.removeListener(channels.galleryChanged, handler);
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
