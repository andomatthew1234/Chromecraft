import { performance } from "node:perf_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  app,
  BaseWindow,
  dialog,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  WebContentsView,
} from "electron";
import electronSquirrelStartup from "electron-squirrel-startup";

import { channels } from "../shared/channels";
import type {
  BookmarkInput,
  BrowserExtensionSnapshot,
  DownloadSnapshot,
  ExtensionInstallPreviewSnapshot,
  ExtensionOperationProgressSnapshot,
  ExtensionPopupAnchor,
  ExtensionsSnapshot,
  HyperdriveMode,
  HyperdriveOmniboxSignal,
  NewTabTheme,
  QuickLinkInput,
  SmartDownloadCleanupPolicy,
  SmartDownloadInitialMode,
  SmartDownloadQuality,
  SmartDownloadsSnapshot,
  YouTubeDownloadsSnapshot,
  GallerySnapshot,
} from "../shared/browser";
import { isAllowedWebUrl } from "../shared/navigation";
import { BrowserDataStore } from "./browser-data";
import {
  ChromeWebStoreExtensionService,
  type ExtensionInstallProgress,
  type InstalledExtensionSnapshot,
  type PreparedExtensionPreview,
} from "./chrome-web-store-extension-service";
import { isExpectedExtensionCancellation } from "./extension-operation";
import { ExtensionWebRequestHost } from "./extension-web-request-host";
import {
  DownloadManager,
  type DownloadSnapshot as ManagerDownload,
} from "./download-manager";
import { ElectronUpdateAdapter } from "./electron-update-adapter";
import { registerInternalProtocol } from "./internal-protocol";
import { GalleryStore } from "./gallery-store";
import { registerGalleryMediaProtocol } from "./gallery-media-protocol";
import { GalleryMediaRepairService } from "./gallery-media-repair";
import { HyperdriveController } from "./hyperdrive/controller";
import { PreferencesStore } from "./preferences";
import { SearchSuggestionService } from "./search-suggestions";
import { TabManager } from "./tab-manager";
import { UblockService } from "./ublock-service";
import { UpdateManager } from "./update-manager";
import {
  YouTubeDownloadService,
  YT_DLP_VERSION,
  mediaToolPaths,
} from "./youtube-download-service";
import { parseChromeWebStoreListingUrl } from "../shared/web-store-listing";
import {
  WebsitePermissionController,
  type WebsitePermissionPrompt,
} from "./website-permission-controller";
import { SmartDownloadsService } from "./smart-downloads/service";

const startedAt = performance.now();
const profilePartition = "persist:chromecraft-default";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "chromecraft",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
    },
  },
  {
    scheme: "chromecraft-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function argumentValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

const smokeUserData = argumentValue("chromecraft-user-data");
if (smokeUserData) app.setPath("userData", path.resolve(smokeUserData));

const smokeFixtureUrl = argumentValue("chromecraft-smoke-url");
if (smokeFixtureUrl) {
  app.commandLine.appendSwitch(
    "host-resolver-rules",
    "MAP publisher.test 127.0.0.1, MAP youtube.test 127.0.0.1, MAP doubleclick.net 127.0.0.1, EXCLUDE localhost",
  );
}

app.setName("Chromecraft");
if (process.platform === "win32") {
  app.setAppUserModelId("com.squirrel.Chromecraft.chromecraft");
}

const handlingSquirrelStartup = electronSquirrelStartup;

let mainWindow: BaseWindow | null = null;
let shellView: WebContentsView | null = null;
let tabManager: TabManager | null = null;
let browserData: BrowserDataStore | null = null;
let downloadManager: DownloadManager | null = null;
let searchSuggestionService: SearchSuggestionService | null = null;
let hyperdriveController: HyperdriveController | null = null;
let extensionService: ChromeWebStoreExtensionService | null = null;
let extensionWebRequestHost: ExtensionWebRequestHost | null = null;
let extensionOperation: ExtensionsSnapshot["operation"] = "idle";
let extensionOperationId: string | null = null;
let extensionError: string | null = null;
let extensionErrorId: string | null = null;
let extensionProgress: ExtensionOperationProgressSnapshot | null = null;
let preparedExtensionToken: string | null = null;
let preparedExtensionId: string | null = null;
let extensionSnapshotSendQueue: Promise<void> = Promise.resolve();
let updateRestartPrepared = false;
let updateShutdownPromise: Promise<void> | null = null;
let ipcRegistered = false;
let updateManager: UpdateManager | null = null;
let websitePermissionController: WebsitePermissionController | null = null;
let youtubeDownloadService: YouTubeDownloadService | null = null;
let galleryStore: GalleryStore | null = null;
let galleryMediaRepairService: GalleryMediaRepairService | null = null;
let smartDownloadsService: SmartDownloadsService | null = null;
let smartDownloadsTray: Tray | null = null;
let quittingCompletely = false;
let deleteAllGalleryItemsInFlight = false;
let youtubeIndicatorHideTimer: NodeJS.Timeout | null = null;

async function promptForWebsitePermission(
  request: WebsitePermissionPrompt,
): Promise<boolean> {
  if (
    smokeUserData &&
    process.argv.includes("--chromecraft-smoke-allow-site-permissions")
  )
    return true;
  const hostname = new URL(request.origin).hostname;
  const copy = {
    pointerLock: {
      message: `${hostname} wants to capture your mouse`,
      detail:
        "This lets games and interactive sites continue receiving mouse movement while the pointer is hidden. Press Esc to release it.",
    },
    keyboardLock: {
      message: `${hostname} wants to capture keyboard input`,
      detail:
        "This is available only while the site is fullscreen. Press Esc to leave fullscreen and release the keyboard.",
    },
    "screen-wake-lock": {
      message: `${hostname} wants to keep your screen awake`,
      detail:
        "This is useful for videos and presentations. The permission ends when this page navigates or closes.",
    },
  }[request.permission];
  const answer = await dialog.showMessageBox({
    type: "question",
    title: "Website permission",
    message: copy.message,
    detail: copy.detail,
    buttons: ["Block", "Allow once"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return answer.response === 1;
}

function sendUpdateSnapshot(snapshot = updateManager?.snapshot): void {
  if (!snapshot) return;
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(channels.updatesChanged, snapshot);
}

function requireUpdateManager(): UpdateManager {
  if (!updateManager) throw new Error("The update service is unavailable.");
  return updateManager;
}

function prepareForUpdateRestart(): Promise<void> {
  if (updateShutdownPromise) return updateShutdownPromise;
  updateShutdownPromise = Promise.all([
    tabManager?.flushSession() ?? Promise.resolve(),
    downloadManager?.dispose() ?? Promise.resolve(),
    smartDownloadsService?.dispose() ?? Promise.resolve(),
    youtubeDownloadService?.dispose() ?? Promise.resolve(),
  ]).then(() => {
    updateRestartPrepared = true;
  });
  return updateShutdownPromise;
}

function requireManager(event: IpcMainInvokeEvent): TabManager {
  if (!tabManager || !shellView || event.sender !== shellView.webContents) {
    throw new Error("Rejected IPC call from an untrusted renderer.");
  }
  return tabManager;
}

function requireSearchSuggestions(
  event: IpcMainInvokeEvent,
): SearchSuggestionService {
  if (
    !searchSuggestionService ||
    !shellView ||
    event.sender !== shellView.webContents
  ) {
    throw new Error("Rejected IPC call from an untrusted renderer.");
  }
  return searchSuggestionService;
}

function requireTrusted(event: Pick<IpcMainInvokeEvent, "sender">): void {
  if (!shellView || event.sender !== shellView.webContents) {
    throw new Error("Rejected IPC call from an untrusted renderer.");
  }
}

function requireExtensions(
  event: Pick<IpcMainInvokeEvent, "sender">,
): ChromeWebStoreExtensionService {
  requireTrusted(event);
  if (!extensionService) throw new Error("Extensions are not initialized.");
  return extensionService;
}

function mapExtension(
  extension: InstalledExtensionSnapshot,
): BrowserExtensionSnapshot {
  const action =
    extensionWebRequestHost?.resolveAction(
      extension.id,
      tabManager?.activeExtensionTabId ?? null,
    ) ?? null;
  return {
    ...extension,
    sourceUrl: extension.sourceUrl || null,
    status: extension.error
      ? "error"
      : !extension.enabled
        ? "disabled"
        : extension.ready
          ? "ready"
          : "loading",
    action: action
      ? {
          ...action,
          iconUrl: action.iconUrl?.startsWith("data:")
            ? action.iconUrl
            : extension.iconDataUrl,
        }
      : null,
  };
}

async function getExtensionsSnapshot(): Promise<ExtensionsSnapshot> {
  const items = extensionService
    ? (await extensionService.listInstalled()).map(mapExtension)
    : [];
  return {
    initialized: extensionService !== null,
    operation: extensionOperation,
    operationExtensionId: extensionOperationId,
    popupExtensionId: tabManager?.extensionPopupId ?? null,
    error: extensionError,
    errorExtensionId: extensionErrorId,
    progress: extensionProgress,
    items,
  };
}

function sendExtensionsSnapshot(): Promise<void> {
  const state = {
    operation: extensionOperation,
    operationExtensionId: extensionOperationId,
    error: extensionError,
    errorExtensionId: extensionErrorId,
    progress: extensionProgress ? { ...extensionProgress } : null,
    popupExtensionId: tabManager?.extensionPopupId ?? null,
  };
  const pending = extensionSnapshotSendQueue.then(async () => {
    if (!shellView || shellView.webContents.isDestroyed()) return;
    const snapshot = await getExtensionsSnapshot();
    shellView.webContents.send(channels.extensionsChanged, {
      ...snapshot,
      ...state,
    });
  });
  extensionSnapshotSendQueue = pending.catch((error) => {
    console.warn("Could not send the extension snapshot.", error);
  });
  return pending;
}

async function runExtensionOperation<T>(
  operation: ExtensionsSnapshot["operation"],
  extensionId: string | null,
  action: () => Promise<T>,
): Promise<T> {
  if (extensionOperation !== "idle") {
    throw new Error("Another extension operation is already running.");
  }
  tabManager?.closeExtensionPopup();
  extensionOperation = operation;
  extensionOperationId = extensionId;
  extensionError = null;
  extensionErrorId = null;
  extensionProgress =
    operation === "removing"
      ? {
          stage: "removing",
          label: "Removing…",
          receivedBytes: null,
          totalBytes: null,
          percent: null,
        }
      : null;
  await sendExtensionsSnapshot();
  try {
    const result = await action();
    return result;
  } catch (error) {
    if (!isExpectedExtensionCancellation(operation, error)) {
      extensionError = error instanceof Error ? error.message : String(error);
      extensionErrorId = extensionId;
    }
    throw error;
  } finally {
    extensionOperation = "idle";
    extensionOperationId = null;
    extensionProgress = null;
    await sendExtensionsSnapshot();
  }
}

function mapPreparedExtension(
  preview: PreparedExtensionPreview,
): ExtensionInstallPreviewSnapshot {
  return {
    token: preview.token,
    extensionId: preview.id,
    itemUrl: preview.sourceUrl,
    name: preview.name,
    version: preview.version,
    description: preview.description,
    permissions: [...preview.permissions],
    hostPermissions: [...preview.hostPermissions],
    warnings: [...preview.warnings],
  };
}

const extensionProgressLabels: Record<
  ExtensionInstallProgress["stage"],
  string
> = {
  downloading: "Downloading…",
  verifying: "Verifying package…",
  preparing: "Preparing extension…",
  installing: "Installing…",
  finishing: "Finishing…",
  installed: "Finishing…",
};

function reportExtensionProgress(progress: ExtensionInstallProgress): void {
  const receivedBytes =
    typeof progress.receivedBytes === "number" ? progress.receivedBytes : null;
  const totalBytes =
    typeof progress.totalBytes === "number" && progress.totalBytes > 0
      ? progress.totalBytes
      : null;
  const percent =
    receivedBytes !== null && totalBytes !== null
      ? Math.min(100, Math.max(0, (receivedBytes / totalBytes) * 100))
      : progress.stage === "installed"
        ? 100
        : null;
  const next: ExtensionOperationProgressSnapshot = {
    stage: progress.stage === "installed" ? "finishing" : progress.stage,
    label: extensionProgressLabels[progress.stage],
    receivedBytes,
    totalBytes,
    percent,
  };
  const changed =
    extensionProgress?.stage !== next.stage ||
    extensionProgress?.percent === null ||
    next.percent === null ||
    Math.floor(extensionProgress?.percent ?? -1) !== Math.floor(next.percent);
  extensionProgress = next;
  if (changed) void sendExtensionsSnapshot();
}

function requireHyperdriveOmniboxSignal(
  value: unknown,
): HyperdriveOmniboxSignal {
  if (!value || typeof value !== "object")
    throw new TypeError("Hyperdrive Omnibox signal is invalid.");
  const signal = value as Record<string, unknown>;
  const triggers = new Set([
    "omnibox-typing",
    "omnibox-autocomplete",
    "omnibox-selection",
    "search-suggestion",
  ]);
  if (
    typeof signal.tabId !== "string" ||
    signal.tabId.length === 0 ||
    signal.tabId.length > 128 ||
    typeof signal.input !== "string" ||
    signal.input.length > 2_048 ||
    (signal.destination !== null &&
      (typeof signal.destination !== "string" ||
        signal.destination.length > 8_192 ||
        !isAllowedWebUrl(signal.destination))) ||
    typeof signal.title !== "string" ||
    signal.title.length > 240 ||
    typeof signal.trigger !== "string" ||
    !triggers.has(signal.trigger) ||
    typeof signal.confidence !== "number" ||
    !Number.isFinite(signal.confidence) ||
    signal.confidence < 0 ||
    signal.confidence > 1 ||
    typeof signal.search !== "boolean"
  ) {
    throw new TypeError("Hyperdrive Omnibox signal is invalid.");
  }
  return signal as unknown as HyperdriveOmniboxSignal;
}

function requireData(event: IpcMainInvokeEvent): BrowserDataStore {
  requireTrusted(event);
  if (!browserData) throw new Error("Browser data is not ready.");
  return browserData;
}

function requireDownloads(event: IpcMainInvokeEvent): DownloadManager {
  requireTrusted(event);
  if (!downloadManager) throw new Error("Downloads are not ready.");
  return downloadManager;
}

function requireYouTubeDownloads(
  event: IpcMainInvokeEvent,
): YouTubeDownloadService {
  requireTrusted(event);
  if (!youtubeDownloadService) {
    throw new Error("YouTube downloads are not ready.");
  }
  return youtubeDownloadService;
}

function requireGallery(event: IpcMainInvokeEvent): GalleryStore {
  requireTrusted(event);
  if (!galleryStore) throw new Error("My Gallery is not ready.");
  return galleryStore;
}

function requireGalleryMediaRepair(
  event: IpcMainInvokeEvent,
): GalleryMediaRepairService {
  requireTrusted(event);
  if (!galleryMediaRepairService) {
    throw new Error("Gallery media repair is not ready.");
  }
  return galleryMediaRepairService;
}

function requireSmartDownloads(
  event: IpcMainInvokeEvent,
): SmartDownloadsService {
  requireTrusted(event);
  if (!smartDownloadsService) throw new Error("Smart Downloads is not ready.");
  return smartDownloadsService;
}

function sendGallerySnapshot(snapshot: GallerySnapshot): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(channels.galleryChanged, snapshot);
}

function sendSmartDownloadsSnapshot(snapshot: SmartDownloadsSnapshot): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(channels.smartDownloadsChanged, snapshot);
}

function showChromecraft(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createMainWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function rebuildSmartDownloadsTray(): void {
  if (!smartDownloadsTray) return;
  const paused = smartDownloadsService?.snapshot.queuePaused ?? false;
  smartDownloadsTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Chromecraft", click: showChromecraft },
      {
        label: "Open My Gallery",
        click: () => {
          showChromecraft();
          void tabManager?.openGallery(undefined, true);
        },
      },
      {
        label: "View Smart Downloads",
        click: () => {
          showChromecraft();
          shellView?.webContents.send(channels.showSmartDownloadsSettings);
        },
      },
      { type: "separator" },
      {
        label: paused ? "Resume Smart Downloads" : "Pause Smart Downloads",
        click: () => {
          const operation = paused
            ? smartDownloadsService?.resumeQueue()
            : smartDownloadsService?.pauseQueue();
          void operation?.finally(rebuildSmartDownloadsTray);
        },
      },
      { type: "separator" },
      {
        label: "Quit Chromecraft completely",
        click: () => {
          quittingCompletely = true;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
          else app.quit();
        },
      },
    ]),
  );
}

async function syncSmartBackgroundPreferences(
  backgroundEnabled: boolean,
  startWithWindows: boolean,
): Promise<void> {
  if (process.platform === "win32" && app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: startWithWindows,
      args: ["--chromecraft-background"],
    });
  }
  if (backgroundEnabled && !smartDownloadsTray) {
    const icon = nativeImage.createFromDataURL(
      "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#0b57d0"/><path d="M9 10h14v4H13v8h10v-4h-6v-4h10v12H9z" fill="white"/></svg>',
        ),
    );
    smartDownloadsTray = new Tray(icon);
    smartDownloadsTray.setToolTip("Chromecraft Smart Downloads");
    smartDownloadsTray.on("double-click", showChromecraft);
  } else if (!backgroundEnabled && smartDownloadsTray) {
    smartDownloadsTray.destroy();
    smartDownloadsTray = null;
  }
  rebuildSmartDownloadsTray();
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${name} must be a boolean.`);
  return value;
}

function requireString(value: unknown, name: string, maximum = 8_192): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new TypeError(
      `${name} must be a non-empty string of at most ${maximum} characters.`,
    );
  }
  return value;
}

function requireBookmarkInput(value: unknown): BookmarkInput {
  if (!value || typeof value !== "object")
    throw new TypeError("Bookmark input is invalid.");
  const input = value as Record<string, unknown>;
  return {
    title: requireString(input.title, "title", 1_024),
    url: requireString(input.url, "url"),
    folder:
      input.folder === undefined
        ? undefined
        : requireString(input.folder, "folder", 256),
  };
}

function requireQuickLinkInput(value: unknown): QuickLinkInput {
  if (!value || typeof value !== "object")
    throw new TypeError("Quick-link input is invalid.");
  const input = value as Record<string, unknown>;
  return {
    title: requireString(input.title, "title", 1_024),
    url: requireString(input.url, "url"),
  };
}

function requireExtensionPopupAnchor(value: unknown): ExtensionPopupAnchor {
  if (!value || typeof value !== "object") {
    throw new TypeError("The extension popup anchor is invalid.");
  }
  const anchor = value as Record<string, unknown>;
  const values = [anchor.x, anchor.y, anchor.width, anchor.height];
  if (
    values.some(
      (entry) =>
        typeof entry !== "number" ||
        !Number.isFinite(entry) ||
        entry < 0 ||
        entry > 16_384,
    ) ||
    anchor.width === 0 ||
    anchor.height === 0
  ) {
    throw new TypeError("The extension popup anchor is invalid.");
  }
  return anchor as unknown as ExtensionPopupAnchor;
}

function mapDownloads(items: readonly ManagerDownload[]): DownloadSnapshot {
  return {
    items: items.map((item) => ({
      id: item.id,
      filename: item.filename,
      sourceUrl: item.url,
      savePath: item.savePath,
      receivedBytes: item.receivedBytes,
      totalBytes: item.totalBytes,
      state: item.state,
      startedAt: item.startedAt,
      finishedAt: item.endedAt,
      danger: item.potentiallyDangerous
        ? "This file type can run programs."
        : null,
    })),
  };
}

function sendBrowserData(): void {
  if (browserData) hyperdriveController?.setBrowserData(browserData.snapshot);
  if (shellView && browserData && !shellView.webContents.isDestroyed()) {
    shellView.webContents.send(
      channels.browserDataChanged,
      browserData.snapshot,
    );
  }
}

function escapeBookmarkHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function decodeBookmarkHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function registerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(
    channels.getSnapshot,
    (event) => requireManager(event).snapshot,
  );
  ipcMain.handle(channels.getUpdates, (event) => {
    requireTrusted(event);
    return requireUpdateManager().snapshot;
  });
  ipcMain.handle(channels.checkForUpdates, async (event) => {
    requireTrusted(event);
    return requireUpdateManager().check();
  });
  ipcMain.handle(channels.restartToUpdate, async (event) => {
    requireTrusted(event);
    await requireUpdateManager().restart();
  });
  ipcMain.handle(channels.createTab, (event, input?: unknown) =>
    requireManager(event).createTab(
      typeof input === "string" ? input : undefined,
    ),
  );
  ipcMain.handle(channels.activateTab, (event, tabId: unknown) => {
    if (typeof tabId !== "string")
      throw new TypeError("tabId must be a string.");
    requireManager(event).activateTab(tabId);
  });
  ipcMain.handle(channels.closeTab, (event, tabId: unknown) => {
    if (typeof tabId !== "string")
      throw new TypeError("tabId must be a string.");
    requireManager(event).closeTab(tabId);
  });
  ipcMain.handle(
    channels.navigate,
    async (event, tabId: unknown, input: unknown, typed: unknown) => {
      if (
        typeof tabId !== "string" ||
        typeof input !== "string" ||
        (typed !== undefined && typeof typed !== "boolean")
      ) {
        throw new TypeError("navigate requires string tabId and input values.");
      }
      await requireManager(event).navigate(tabId, input, typed === true);
    },
  );
  ipcMain.handle(channels.goBack, (event, tabId: unknown) => {
    if (typeof tabId !== "string")
      throw new TypeError("tabId must be a string.");
    requireManager(event).goBack(tabId);
  });
  ipcMain.handle(channels.goForward, (event, tabId: unknown) => {
    if (typeof tabId !== "string")
      throw new TypeError("tabId must be a string.");
    requireManager(event).goForward(tabId);
  });
  ipcMain.handle(channels.reload, (event, tabId: unknown) => {
    if (typeof tabId !== "string")
      throw new TypeError("tabId must be a string.");
    requireManager(event).reload(tabId);
  });
  ipcMain.handle(channels.stop, (event, tabId: unknown) => {
    if (typeof tabId !== "string")
      throw new TypeError("tabId must be a string.");
    requireManager(event).stop(tabId);
  });
  ipcMain.handle(channels.duplicateTab, async (event, tabId: unknown) =>
    requireManager(event).duplicateTab(requireString(tabId, "tabId", 128)),
  );
  ipcMain.handle(channels.reopenClosedTab, (event) =>
    requireManager(event).reopenClosedTab(),
  );
  ipcMain.handle(channels.toggleMute, (event, tabId: unknown) =>
    requireManager(event).toggleMute(requireString(tabId, "tabId", 128)),
  );
  ipcMain.handle(channels.setZoom, (event, tabId: unknown, factor: unknown) => {
    if (typeof factor !== "number")
      throw new TypeError("factor must be a number.");
    requireManager(event).setZoom(requireString(tabId, "tabId", 128), factor);
  });
  ipcMain.handle(
    channels.findInPage,
    (event, tabId: unknown, text: unknown, forward: unknown) => {
      if (typeof text !== "string" || typeof forward !== "boolean")
        throw new TypeError("Invalid find request.");
      requireManager(event).findInPage(
        requireString(tabId, "tabId", 128),
        text,
        forward,
      );
    },
  );
  ipcMain.handle(channels.stopFindInPage, (event, tabId: unknown) =>
    requireManager(event).stopFindInPage(requireString(tabId, "tabId", 128)),
  );
  ipcMain.handle(channels.setFullscreen, (event, fullscreen: unknown) => {
    if (typeof fullscreen !== "boolean")
      throw new TypeError("fullscreen must be boolean.");
    requireManager(event).setFullscreen(fullscreen);
  });
  ipcMain.handle(channels.setSidebarOpen, async (event, open: unknown) => {
    if (typeof open !== "boolean") throw new TypeError("open must be boolean.");
    await requireManager(event).setSidebarOpen(open);
  });
  ipcMain.handle(
    channels.setSidebarAttached,
    async (event, attached: unknown) => {
      if (typeof attached !== "boolean")
        throw new TypeError("attached must be boolean.");
      await requireManager(event).setSidebarAttached(attached);
    },
  );
  ipcMain.handle(channels.setChromeOverlayOpen, (event, open: unknown) => {
    if (typeof open !== "boolean")
      throw new TypeError("open must be a boolean.");
    requireManager(event).setChromeOverlayOpen(open);
  });
  ipcMain.handle(
    channels.setBookmarkBarVisible,
    async (event, visible: unknown) => {
      if (typeof visible !== "boolean")
        throw new TypeError("visible must be boolean.");
      await requireManager(event).setBookmarkBarVisible(visible);
    },
  );
  ipcMain.handle(
    channels.setRestoreSession,
    async (event, enabled: unknown) => {
      if (typeof enabled !== "boolean")
        throw new TypeError("enabled must be boolean.");
      await requireManager(event).setRestoreSession(enabled);
    },
  );
  ipcMain.handle(channels.setNewTabTheme, async (event, theme: unknown) => {
    if (
      typeof theme !== "string" ||
      !["overworld", "nether", "end", "minimal"].includes(theme)
    )
      throw new TypeError("Unknown new-tab theme.");
    await requireManager(event).setNewTabTheme(theme as NewTabTheme);
  });
  ipcMain.handle(
    channels.setRemoteSearchSuggestionsEnabled,
    async (event, enabled: unknown) => {
      if (typeof enabled !== "boolean")
        throw new TypeError("enabled must be boolean.");
      await requireManager(event).setRemoteSearchSuggestionsEnabled(enabled);
      if (!enabled) requireSearchSuggestions(event).cancel();
    },
  );
  ipcMain.handle(
    channels.getSearchSuggestions,
    async (event, query: unknown) => {
      if (typeof query !== "string" || query.length > 200)
        throw new TypeError(
          "query must be a string of at most 200 characters.",
        );
      return requireSearchSuggestions(event).getSuggestions(query);
    },
  );
  ipcMain.handle(
    channels.getHyperdriveSnapshot,
    (event) => requireManager(event).hyperdriveSnapshot,
  );
  ipcMain.handle(channels.setHyperdriveMode, async (event, mode: unknown) => {
    if (
      typeof mode !== "string" ||
      !["off", "balanced", "aggressive", "maximum"].includes(mode)
    ) {
      throw new TypeError("Unknown Hyperdrive mode.");
    }
    await requireManager(event).setHyperdriveMode(mode as HyperdriveMode);
  });
  ipcMain.handle(
    channels.setHyperdriveRamBudgetMb,
    async (event, megabytes: unknown) => {
      if (
        typeof megabytes !== "number" ||
        !Number.isInteger(megabytes) ||
        megabytes < 64 ||
        megabytes > 4_096
      ) {
        throw new RangeError("Hyperdrive RAM budget must be 64-4096 MB.");
      }
      await requireManager(event).setHyperdriveRamBudgetMb(megabytes);
    },
  );
  ipcMain.handle(
    channels.setHyperdriveCrossSitePreloadingEnabled,
    async (event, enabled: unknown) => {
      if (typeof enabled !== "boolean")
        throw new TypeError("enabled must be boolean.");
      await requireManager(event).setHyperdriveCrossSitePreloadingEnabled(
        enabled,
      );
    },
  );
  ipcMain.handle(
    channels.setHyperdriveSearchPreloadingEnabled,
    async (event, enabled: unknown) => {
      if (typeof enabled !== "boolean")
        throw new TypeError("enabled must be boolean.");
      await requireManager(event).setHyperdriveSearchPreloadingEnabled(enabled);
    },
  );
  ipcMain.handle(
    channels.setHyperdriveExcludedHosts,
    async (event, hosts: unknown) => {
      if (
        !Array.isArray(hosts) ||
        hosts.length > 200 ||
        hosts.some((host) => typeof host !== "string" || host.length > 253)
      ) {
        throw new TypeError("Excluded hosts must be a bounded string array.");
      }
      await requireManager(event).setHyperdriveExcludedHosts(hosts as string[]);
    },
  );
  ipcMain.handle(
    channels.setHyperdriveMonitorOpen,
    async (event, open: unknown) => {
      if (typeof open !== "boolean")
        throw new TypeError("open must be boolean.");
      await requireManager(event).setHyperdriveMonitorOpen(open);
    },
  );
  ipcMain.handle(
    channels.setHyperdriveDeveloperMode,
    async (event, enabled: unknown) => {
      if (typeof enabled !== "boolean")
        throw new TypeError("enabled must be boolean.");
      await requireManager(event).setHyperdriveDeveloperMode(enabled);
    },
  );
  ipcMain.handle(
    channels.setHyperdriveMonitorPaused,
    (event, paused: unknown) => {
      if (typeof paused !== "boolean")
        throw new TypeError("paused must be boolean.");
      requireManager(event).setHyperdriveMonitorPaused(paused);
    },
  );
  ipcMain.handle(channels.clearHyperdriveSpeculation, (event) => {
    requireManager(event).clearHyperdriveSpeculation();
  });
  ipcMain.handle(channels.clearHyperdriveEvents, (event) => {
    requireManager(event).clearHyperdriveEvents();
  });
  ipcMain.on(channels.updateHyperdriveOmnibox, (event, value: unknown) => {
    try {
      requireTrusted(event);
      tabManager?.updateHyperdriveOmnibox(
        requireHyperdriveOmniboxSignal(value),
      );
    } catch (error) {
      console.warn("Rejected Hyperdrive Omnibox signal.", error);
    }
  });
  ipcMain.handle(channels.setUblockEnabled, async (event, enabled: unknown) => {
    if (typeof enabled !== "boolean")
      throw new TypeError("enabled must be a boolean.");
    await requireManager(event).setUblockEnabled(enabled);
  });
  ipcMain.handle(channels.openUblockDashboard, (event) => {
    requireManager(event).openUblockDashboard();
  });
  ipcMain.handle(channels.getExtensions, async (event) => {
    requireTrusted(event);
    return getExtensionsSnapshot();
  });
  ipcMain.handle(
    channels.installExtensionFromWebStore,
    async (event, itemUrl: unknown) => {
      const service = requireExtensions(event);
      const url = requireString(itemUrl, "itemUrl", 4_096);
      const listing = parseChromeWebStoreListingUrl(url);
      if (!listing)
        throw new TypeError("The Web Store listing URL is invalid.");
      await runExtensionOperation(
        "installing",
        listing.extensionId,
        async () => {
          const preview = await service.prepareFromWebStoreUrl(
            url,
            reportExtensionProgress,
          );
          await service.commitPreparedExtension(
            preview.token,
            reportExtensionProgress,
          );
        },
      );
    },
  );
  ipcMain.handle(
    channels.prepareExtensionFromWebStore,
    async (event, itemUrl: unknown) => {
      const service = requireExtensions(event);
      const url = requireString(itemUrl, "itemUrl", 4_096);
      const listing = parseChromeWebStoreListingUrl(url);
      if (!listing)
        throw new TypeError("The Web Store listing URL is invalid.");
      const preview = await runExtensionOperation(
        "reviewing",
        listing.extensionId,
        () => service.prepareFromWebStoreUrl(url, reportExtensionProgress),
      );
      preparedExtensionToken = preview.token;
      preparedExtensionId = preview.id;
      return mapPreparedExtension(preview);
    },
  );
  ipcMain.handle(
    channels.commitPreparedExtension,
    async (event, token: unknown) => {
      const service = requireExtensions(event);
      const previewToken = requireString(token, "token", 128);
      if (previewToken !== preparedExtensionToken || !preparedExtensionId) {
        throw new Error(
          "The prepared extension preview is no longer available.",
        );
      }
      const extensionId = preparedExtensionId;
      try {
        await runExtensionOperation("installing", extensionId, () =>
          service.commitPreparedExtension(
            previewToken,
            reportExtensionProgress,
          ),
        );
      } finally {
        preparedExtensionToken = null;
        preparedExtensionId = null;
      }
    },
  );
  ipcMain.handle(channels.cancelPreparedExtension, (event, token: unknown) => {
    const service = requireExtensions(event);
    if (typeof token !== "string" || token.length > 128) {
      throw new TypeError(
        "token must be a string no longer than 128 characters.",
      );
    }
    const cancelled = service.cancelPreparedExtension(token || undefined);
    if (!token || token === preparedExtensionToken) {
      preparedExtensionToken = null;
      preparedExtensionId = null;
    }
    return cancelled;
  });
  ipcMain.handle(
    channels.dismissWebStoreInstallBanner,
    (event, tabId: unknown, extensionId: unknown) => {
      requireManager(event).dismissWebStoreInstallBanner(
        requireString(tabId, "tabId", 128),
        requireString(extensionId, "extensionId", 32),
      );
    },
  );
  ipcMain.handle(
    channels.setExtensionEnabled,
    async (event, id: unknown, enabled: unknown) => {
      const service = requireExtensions(event);
      if (typeof enabled !== "boolean") {
        throw new TypeError("enabled must be a boolean.");
      }
      const extensionId = requireString(id, "id", 32);
      await runExtensionOperation("updating", extensionId, async () => {
        await service.setEnabled(extensionId, enabled);
      });
    },
  );
  ipcMain.handle(
    channels.setExtensionDeveloperMode,
    async (event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new TypeError("enabled must be a boolean.");
      }
      await requireManager(event).setExtensionDeveloperMode(enabled);
    },
  );
  ipcMain.handle(channels.importUnpackedExtension, async (event) => {
    const service = requireExtensions(event);
    const manager = requireManager(event);
    if (!manager.snapshot.preferences.extensionDeveloperMode) {
      throw new Error("Enable extension developer mode before importing.");
    }
    const result = await dialog.showOpenDialog({
      title: "Load unpacked extension",
      buttonLabel: "Load extension",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return false;
    await runExtensionOperation("installing", null, () =>
      service.importUnpacked(result.filePaths[0]),
    );
    return true;
  });
  ipcMain.handle(channels.removeExtension, async (event, id: unknown) => {
    const service = requireExtensions(event);
    const extensionId = requireString(id, "id", 32);
    await runExtensionOperation("removing", extensionId, async () => {
      await service.uninstall(extensionId);
    });
  });
  ipcMain.handle(
    channels.openExtensionPage,
    (event, id: unknown, page: unknown) => {
      const service = requireExtensions(event);
      const extensionId = requireString(id, "id", 32);
      if (page !== "options") {
        throw new TypeError("Unknown extension page.");
      }
      const url = service.getExtensionPage(extensionId, page);
      if (!url) throw new Error("That extension page is unavailable.");
      requireManager(event).openExtensionPage(url);
    },
  );
  ipcMain.handle(
    channels.toggleExtensionPopup,
    async (event, id: unknown, anchor: unknown) => {
      requireExtensions(event);
      const manager = requireManager(event);
      const extensionId = requireString(id, "id", 32);
      const tabId = manager.activeExtensionTabId;
      if (!extensionWebRequestHost)
        throw new Error("That extension action is unavailable.");
      const invocation = await extensionWebRequestHost.invokeActionFromToolbar(
        extensionId,
        tabId,
      );
      if (invocation.kind === "clicked") {
        manager.closeExtensionPopup();
        return;
      }
      await manager.toggleExtensionPopup(
        extensionId,
        requireExtensionPopupAnchor(anchor),
        invocation.popupUrl,
      );
    },
  );
  ipcMain.handle(channels.closeExtensionPopup, (event) => {
    requireManager(event).closeExtensionPopup();
  });
  ipcMain.handle(
    channels.getBrowserData,
    (event) => requireData(event).snapshot,
  );
  ipcMain.handle(channels.addBookmark, async (event, input: unknown) => {
    await requireData(event).addBookmark(requireBookmarkInput(input));
    sendBrowserData();
  });
  ipcMain.handle(channels.removeBookmark, async (event, id: unknown) => {
    await requireData(event).removeBookmark(requireString(id, "id", 128));
    sendBrowserData();
  });
  ipcMain.handle(channels.removeHistory, async (event, id: unknown) => {
    await requireData(event).deleteHistoryEntry(requireString(id, "id", 128));
    sendBrowserData();
  });
  ipcMain.handle(channels.clearHistory, async (event, range: unknown) => {
    const selected = range === undefined ? "all" : range;
    if (!["hour", "day", "week", "all"].includes(String(selected))) {
      throw new TypeError("Unknown history range.");
    }
    const durations: Record<string, number> = {
      hour: 60 * 60 * 1_000,
      day: 24 * 60 * 60 * 1_000,
      week: 7 * 24 * 60 * 60 * 1_000,
    };
    const duration = durations[String(selected)];
    await requireData(event).clearHistory(
      duration ? { from: new Date(Date.now() - duration) } : {},
    );
    sendBrowserData();
  });
  ipcMain.handle(channels.addQuickLink, async (event, input: unknown) => {
    await requireData(event).addQuickLink(requireQuickLinkInput(input));
    sendBrowserData();
  });
  ipcMain.handle(channels.removeQuickLink, async (event, id: unknown) => {
    await requireData(event).removeQuickLink(requireString(id, "id", 128));
    sendBrowserData();
  });
  ipcMain.handle(channels.importBookmarks, async (event) => {
    const data = requireData(event);
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Bookmark HTML", extensions: ["html", "htm"] }],
    });
    if (result.canceled || !result.filePaths[0]) return 0;
    const raw = await fs.readFile(result.filePaths[0], "utf8");
    if (raw.length > 20_000_000)
      throw new RangeError("Bookmark file is too large.");
    const pattern = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const importedBookmarks: BookmarkInput[] = [];
    for (const match of raw.matchAll(pattern)) {
      const url = decodeBookmarkHtml(match[1]);
      const title =
        decodeBookmarkHtml(match[2].replace(/<[^>]*>/g, "").trim()) || url;
      if (!isAllowedWebUrl(url)) continue;
      importedBookmarks.push({ title: title.slice(0, 1_024), url });
      if (importedBookmarks.length >= 10_000) break;
    }
    const imported = await data.importBookmarks(importedBookmarks);
    sendBrowserData();
    return imported;
  });
  ipcMain.handle(channels.exportBookmarks, async (event) => {
    const data = requireData(event);
    const result = await dialog.showSaveDialog({
      defaultPath: "chromecraft-bookmarks.html",
      filters: [{ name: "Bookmark HTML", extensions: ["html"] }],
    });
    if (result.canceled || !result.filePath) return false;
    const entries = data
      .listBookmarks()
      .map(
        (item) =>
          `    <DT><A HREF="${escapeBookmarkHtml(item.url)}">${escapeBookmarkHtml(item.title)}</A>`,
      )
      .join("\n");
    await fs.writeFile(
      result.filePath,
      `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Chromecraft Bookmarks</TITLE>\n<H1>Chromecraft Bookmarks</H1>\n<DL><p>\n${entries}\n</DL><p>\n`,
      "utf8",
    );
    return true;
  });
  ipcMain.handle(channels.getDownloads, (event) =>
    mapDownloads(requireDownloads(event).snapshot),
  );
  ipcMain.handle(
    channels.getYouTubeDownloads,
    (event) => requireYouTubeDownloads(event).snapshot,
  );
  ipcMain.handle(
    channels.getSmartDownloads,
    (event) => requireSmartDownloads(event).snapshot,
  );
  ipcMain.handle(channels.setSmartDownloadsEnabled, (event, value: unknown) =>
    requireSmartDownloads(event).setEnabled(requireBoolean(value, "enabled")),
  );
  ipcMain.handle(channels.setSmartDownloadsQuota, (event, value: unknown) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new TypeError("Storage allocation must be an integer byte count.");
    }
    return requireSmartDownloads(event).setQuota(value);
  });
  ipcMain.handle(channels.setSmartDownloadsQuality, (event, value: unknown) => {
    if (
      !new Set(["best", "1080p", "720p", "480p", "audio"]).has(String(value))
    ) {
      throw new TypeError("Download quality is invalid.");
    }
    return requireSmartDownloads(event).setQuality(
      value as SmartDownloadQuality,
    );
  });
  ipcMain.handle(
    channels.setSmartDownloadsCleanupPolicy,
    (event, value: unknown) => {
      if (!new Set(["oldest", "watched-first", "pause"]).has(String(value))) {
        throw new TypeError("Cleanup policy is invalid.");
      }
      return requireSmartDownloads(event).setCleanupPolicy(
        value as SmartDownloadCleanupPolicy,
      );
    },
  );
  ipcMain.handle(
    channels.setSmartDownloadsCheckInterval,
    (event, value: unknown) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new TypeError("Check interval must be an integer.");
      }
      return requireSmartDownloads(event).setCheckInterval(value);
    },
  );
  for (const [channel, field] of [
    [channels.setSmartDownloadsIncludeShorts, "includeShorts"],
    [
      channels.setSmartDownloadsIncludeLivestreamReplays,
      "includeLivestreamReplays",
    ],
    [
      channels.setSmartDownloadsPauseDuringHeavyActivity,
      "pauseDuringHeavyActivity",
    ],
    [channels.setSmartDownloadsBackgroundEnabled, "backgroundEnabled"],
    [
      channels.setSmartDownloadsRecommendationsEnabled,
      "recommendationsEnabled",
    ],
  ] as const) {
    ipcMain.handle(channel, (event, value: unknown) =>
      requireSmartDownloads(event).setConfigFlag(
        field,
        requireBoolean(value, field),
      ),
    );
  }
  ipcMain.handle(
    channels.setSmartDownloadsStartWithWindows,
    (event, value: unknown) => {
      const enabled = requireBoolean(value, "startWithWindows");
      if (enabled && process.platform !== "win32") {
        throw new Error("Start with Windows is available on Windows only.");
      }
      return requireSmartDownloads(event).setConfigFlag(
        "startWithWindows",
        enabled,
      );
    },
  );
  ipcMain.handle(
    channels.addSmartDownloadsChannel,
    (event, input: unknown, mode: unknown) => {
      const initialMode =
        mode === "future" || mode === 1 || mode === 3 || mode === 5
          ? (mode as SmartDownloadInitialMode)
          : null;
      if (initialMode === null)
        throw new TypeError("Initial download mode is invalid.");
      return requireSmartDownloads(event).addChannel(
        requireString(input, "channel", 2_048),
        initialMode,
      );
    },
  );
  ipcMain.handle(
    channels.setSmartDownloadsChannelEnabled,
    (event, id: unknown, enabled: unknown) =>
      requireSmartDownloads(event).setChannelEnabled(
        requireString(id, "channelId", 64),
        requireBoolean(enabled, "enabled"),
      ),
  );
  ipcMain.handle(channels.checkSmartDownloads, (event, id: unknown) =>
    requireSmartDownloads(event).checkNow(
      id === undefined || id === null
        ? undefined
        : requireString(id, "channelId", 64),
    ),
  );
  ipcMain.handle(channels.removeSmartDownloadsChannel, (event, id: unknown) =>
    requireSmartDownloads(event).removeChannel(
      requireString(id, "channelId", 64),
    ),
  );
  ipcMain.handle(channels.pauseSmartDownloadsQueue, (event) =>
    requireSmartDownloads(event).pauseQueue(),
  );
  ipcMain.handle(channels.resumeSmartDownloadsQueue, (event) =>
    requireSmartDownloads(event).resumeQueue(),
  );
  ipcMain.handle(channels.retrySmartDownloadJob, (event, id: unknown) =>
    requireSmartDownloads(event).retryJob(requireString(id, "jobId", 128)),
  );
  ipcMain.handle(channels.cancelSmartDownloadJob, (event, id: unknown) =>
    requireSmartDownloads(event).cancelJob(requireString(id, "jobId", 128)),
  );
  ipcMain.handle(
    channels.dismissSmartDownloadsRecommendation,
    (event, id: unknown) =>
      requireSmartDownloads(event).dismissRecommendation(
        requireString(id, "channelId", 64),
      ),
  );
  ipcMain.handle(channels.clearSmartDownloadsRecommendationHistory, (event) =>
    requireSmartDownloads(event).clearRecommendationHistory(),
  );
  ipcMain.handle(
    channels.startYouTubeDownload,
    async (event, tabId: unknown) => {
      const manager = requireManager(event);
      const target = manager.getActiveYouTubeDownloadTarget(
        requireString(tabId, "tabId", 128),
      );
      return requireYouTubeDownloads(event).start(target);
    },
  );
  ipcMain.handle(channels.cancelYouTubeDownload, async (event, id: unknown) => {
    await requireYouTubeDownloads(event).cancel(requireString(id, "id", 128));
  });
  ipcMain.handle(channels.retryYouTubeDownload, (event, id: unknown) =>
    requireYouTubeDownloads(event).retry(requireString(id, "id", 128)),
  );
  ipcMain.handle(channels.openYouTubeDownload, async (event, id: unknown) => {
    const file = await requireYouTubeDownloads(event).resolveCompletedPath(
      requireString(id, "id", 128),
    );
    if (!file) throw new Error("The completed video is unavailable.");
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
  });
  ipcMain.handle(channels.dismissYouTubeDownload, (event, id: unknown) => {
    requireYouTubeDownloads(event).dismiss(requireString(id, "id", 128));
  });
  ipcMain.handle(
    channels.dismissYouTubeDownloadBanner,
    (event, tabId: unknown, videoId: unknown) => {
      requireManager(event).dismissYouTubeDownloadBanner(
        requireString(tabId, "tabId", 128),
        requireString(videoId, "videoId", 64),
      );
    },
  );
  ipcMain.handle(channels.pauseDownload, (event, id: unknown) => {
    requireDownloads(event).pause(requireString(id, "id", 128));
  });
  ipcMain.handle(channels.resumeDownload, (event, id: unknown) => {
    requireDownloads(event).resume(requireString(id, "id", 128));
  });
  ipcMain.handle(channels.retryDownload, (event, id: unknown) => {
    requireDownloads(event).retry(requireString(id, "id", 128));
  });
  ipcMain.handle(channels.cancelDownload, (event, id: unknown) => {
    requireDownloads(event).cancel(requireString(id, "id", 128));
  });
  ipcMain.handle(channels.openDownload, async (event, id: unknown) => {
    const manager = requireDownloads(event);
    const downloadId = requireString(id, "id", 128);
    const result = await manager.open(downloadId);
    if (result.status !== "confirmation-required") return;
    const answer = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Cancel", "Open anyway"],
      defaultId: 0,
      cancelId: 0,
      title: "Potentially dangerous file",
      message: "This file type can run programs and change your computer.",
      detail: "Only open it if you trust where it came from.",
    });
    if (answer.response === 1) await manager.open(downloadId, true);
  });
  ipcMain.handle(channels.showDownloadInFolder, (event, id: unknown) => {
    requireDownloads(event).showInFolder(requireString(id, "id", 128));
  });
  ipcMain.handle(channels.removeDownload, (event, id: unknown) => {
    requireDownloads(event).removeRecord(requireString(id, "id", 128));
  });
  ipcMain.handle(channels.clearFinishedDownloads, (event) => {
    requireDownloads(event).clearFinished();
  });
  ipcMain.handle(
    channels.getGallery,
    (event) => requireGallery(event).snapshot,
  );
  ipcMain.handle(
    channels.openGallery,
    (event, entryId: unknown, forceNew: unknown) => {
      requireTrusted(event);
      const cleanId =
        entryId === undefined || entryId === null
          ? undefined
          : requireString(entryId, "entryId", 128);
      if (forceNew !== undefined && typeof forceNew !== "boolean") {
        throw new TypeError("forceNew must be a boolean.");
      }
      return requireManager(event).openGallery(cleanId, forceNew === true);
    },
  );
  ipcMain.handle(channels.openGalleryFile, async (event, id: unknown) => {
    const file = await requireGallery(event).resolveFile(
      requireString(id, "id", 128),
    );
    if (!file) throw new Error("The gallery file is unavailable.");
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
  });
  ipcMain.handle(channels.showGalleryFile, async (event, id: unknown) => {
    const file = await requireGallery(event).resolveFile(
      requireString(id, "id", 128),
    );
    if (!file) throw new Error("The gallery file is unavailable.");
    shell.showItemInFolder(file);
  });
  ipcMain.handle(channels.copyGalleryPath, async (event, id: unknown) => {
    const file = await requireGallery(event).resolveFile(
      requireString(id, "id", 128),
    );
    if (!file) throw new Error("The gallery file is unavailable.");
    clipboard.writeText(file);
  });
  ipcMain.handle(channels.copyGallerySourceUrl, (event, id: unknown) => {
    const cleanId = requireString(id, "id", 128);
    const item = requireGallery(event).snapshot.items.find(
      (candidate) => candidate.id === cleanId,
    );
    if (!item?.sourceUrl) throw new Error("This item has no source URL.");
    clipboard.writeText(item.sourceUrl);
  });
  ipcMain.handle(
    channels.renameGalleryItem,
    async (event, id: unknown, title: unknown) => {
      await requireGallery(event).rename(
        requireString(id, "id", 128),
        requireString(title, "title", 240),
      );
    },
  );
  ipcMain.handle(channels.removeGalleryItem, async (event, id: unknown) => {
    await requireGallery(event).remove(requireString(id, "id", 128));
  });
  ipcMain.handle(channels.deleteGalleryItem, async (event, id: unknown) => {
    const gallery = requireGallery(event);
    const cleanId = requireString(id, "id", 128);
    const item = gallery.snapshot.items.find((entry) => entry.id === cleanId);
    if (!item) throw new Error("Unknown gallery item.");
    const answer = await dialog.showMessageBox({
      type: "warning",
      title: "Delete video from disk?",
      message: `Delete “${item.title}”?`,
      detail:
        "The video will be moved to the Recycle Bin or Trash and removed from My Gallery.",
      buttons: ["Cancel", "Delete"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1) return;
    const file = await gallery.resolveFile(cleanId);
    if (!file) throw new Error("The gallery file is unavailable.");
    await shell.trashItem(file);
    await gallery.remove(cleanId);
    await smartDownloadsService?.recordGalleryDeletion(cleanId);
  });
  ipcMain.handle(channels.deleteAllGalleryItems, async (event) => {
    const gallery = requireGallery(event);
    if (deleteAllGalleryItemsInFlight) {
      throw new Error("Gallery deletion is already in progress.");
    }
    deleteAllGalleryItemsInFlight = true;
    try {
      const items = gallery.snapshot.items;
      if (items.length === 0) return;
      const answer = await dialog.showMessageBox({
        type: "warning",
        title: "Delete every video?",
        message: `Delete all ${items.length} videos from My Gallery?`,
        detail:
          "The files will be moved to the Recycle Bin or Trash. Videos that cannot be deleted will remain in My Gallery.",
        buttons: ["Cancel", "Delete all"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return;
      const failures: string[] = [];
      const deletedIds: string[] = [];
      for (const item of items) {
        try {
          const file = await gallery.resolveFile(item.id);
          if (file) await shell.trashItem(file);
          deletedIds.push(item.id);
        } catch {
          failures.push(item.title);
        }
      }
      await gallery.removeMany(deletedIds);
      await Promise.all(
        deletedIds.map((id) =>
          smartDownloadsService?.recordGalleryDeletion(id),
        ),
      );
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} video${failures.length === 1 ? "" : "s"} could not be deleted and remain in My Gallery.`,
        );
      }
    } finally {
      deleteAllGalleryItemsInFlight = false;
    }
  });
  ipcMain.handle(channels.importGalleryDownloads, (event) =>
    requireGallery(event).importDownloads(),
  );
  ipcMain.handle(
    channels.updateGalleryMediaMetadata,
    async (
      event,
      id: unknown,
      durationSeconds: unknown,
      width: unknown,
      height: unknown,
    ) => {
      if (
        typeof durationSeconds !== "number" ||
        typeof width !== "number" ||
        typeof height !== "number"
      ) {
        throw new TypeError("Gallery media metadata is invalid.");
      }
      await requireGallery(event).updateMediaMetadata(
        requireString(id, "id", 128),
        durationSeconds,
        width,
        height,
      );
    },
  );
  ipcMain.handle(channels.repairGalleryMedia, (event, request: unknown) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("Gallery media repair options are invalid.");
    }
    const options = request as Record<string, unknown>;
    if (
      typeof options.fetchOriginalThumbnails !== "boolean" ||
      typeof options.generateLocalFallbacks !== "boolean"
    ) {
      throw new TypeError("Gallery media repair options are invalid.");
    }
    return requireGalleryMediaRepair(event).repair({
      fetchOriginalThumbnails: options.fetchOriginalThumbnails,
      generateLocalFallbacks: options.generateLocalFallbacks,
    });
  });
  ipcMain.handle(
    channels.setSmartDownloadKeepForever,
    (event, id: unknown, keepForever: unknown) =>
      requireSmartDownloads(event).setKeepForever(
        requireString(id, "galleryId", 128),
        requireBoolean(keepForever, "keepForever"),
      ),
  );
  ipcMain.handle(channels.markGalleryItemWatched, (event, id: unknown) =>
    requireSmartDownloads(event).markGalleryItemWatched(
      requireString(id, "galleryId", 128),
    ),
  );
  ipcMain.handle(
    channels.setShowDownloadProgressInToolbar,
    async (event, enabled: unknown) => {
      if (typeof enabled !== "boolean")
        throw new TypeError("enabled must be boolean.");
      await requireManager(event).setShowDownloadProgressInToolbar(enabled);
    },
  );
  ipcMain.handle(
    channels.setShowDownloadCompletionNotification,
    async (event, enabled: unknown) => {
      if (typeof enabled !== "boolean")
        throw new TypeError("enabled must be boolean.");
      await requireManager(event).setShowDownloadCompletionNotification(
        enabled,
      );
    },
  );
  ipcMain.handle(
    channels.setAddVideosToGallery,
    async (event, enabled: unknown) => {
      if (typeof enabled !== "boolean")
        throw new TypeError("enabled must be boolean.");
      await requireManager(event).setAddVideosToGallery(enabled);
    },
  );
}

async function createMainWindow(): Promise<void> {
  const smokeTheme = argumentValue("chromecraft-smoke-theme");
  if (smokeTheme === "light" || smokeTheme === "dark")
    nativeTheme.themeSource = smokeTheme;
  const browserSession = session.fromPartition(profilePartition);
  browserSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin) =>
      Boolean(
        contents &&
        (permission === "fullscreen"
          ? tabManager?.canGrantWebsiteFullscreen(contents, permission)
          : websitePermissionController?.check(
              contents,
              permission,
              requestingOrigin,
            )),
      ),
  );
  browserSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      if (permission === "fullscreen") {
        callback(
          Boolean(tabManager?.canGrantWebsiteFullscreen(contents, permission)),
        );
        return;
      }
      const controller = websitePermissionController;
      if (!controller) {
        callback(false);
        return;
      }
      void controller
        .request(contents, permission, details.requestingUrl)
        .then(callback, () => callback(false));
    },
  );
  browserSession.setSpellCheckerEnabled(false);
  browserSession.setUserAgent(
    browserSession.getUserAgent().replace(/\sElectron\/[^\s]+/, ""),
  );
  registerInternalProtocol(browserSession);

  const actionHost = new ExtensionWebRequestHost(browserSession, {
    serviceWorkerPreloadPath: path.join(
      __dirname,
      "extension-service-worker-preload.cjs",
    ),
    observerPreloadPath: path.join(
      __dirname,
      "extension-network-observer-preload.cjs",
    ),
    framePreloadPath: path.join(__dirname, "extension-frame-preload.cjs"),
    observerExtensionPath: app.isPackaged
      ? path.join(
          process.resourcesPath,
          "extensions",
          "chromecraft-network-observer",
        )
      : path.join(
          app.getAppPath(),
          "resources",
          "extensions",
          "chromecraft-network-observer",
        ),
    onActionChanged: () => void sendExtensionsSnapshot(),
    openActionPopup: async (extensionId, popupUrl) => {
      if (!tabManager) throw new Error("The browser window is unavailable.");
      await tabManager.openExtensionPopup(extensionId, popupUrl);
    },
  });
  extensionWebRequestHost = actionHost;
  await actionHost.start();

  const extensions = new ChromeWebStoreExtensionService(browserSession, {
    storagePath: path.join(app.getPath("userData"), "extensions"),
    fetch: (input, init) =>
      browserSession.fetch(
        input instanceof URL ? input.toString() : input,
        init,
      ),
    chromiumVersion: process.versions.chrome,
    onChanged: () => void sendExtensionsSnapshot(),
  });
  try {
    await extensions.initialize();
    extensionService = extensions;
    extensionError = null;
  } catch (error) {
    extensionService = null;
    extensionError =
      error instanceof Error ? error.message : "Extensions failed to load.";
    console.error("Extension initialization failed.", error);
  }

  updateManager?.dispose();
  updateManager = new UpdateManager({
    adapter: new ElectronUpdateAdapter({
      isPackaged: app.isPackaged,
      platform: process.platform,
      executablePath: process.execPath,
      feedUrl: CHROMECRAFT_UPDATE_FEED_URL,
    }),
    extensions: {
      checkAndInstallUpdates: (report) =>
        runExtensionOperation("updating", null, () => {
          if (!extensionService) {
            throw new Error("The extension service did not initialize.");
          }
          return extensionService.checkAndInstallUpdates((progress) => {
            report({
              label: `${extensionProgressLabels[progress.stage].replace(/…$/u, "")} ${progress.name} (${progress.index}/${progress.total})`,
              ...(progress.receivedBytes === undefined
                ? {}
                : { receivedBytes: progress.receivedBytes }),
              ...(progress.totalBytes === undefined
                ? {}
                : { totalBytes: progress.totalBytes }),
            });
          });
        }),
    },
    installedVersions: [
      { id: "chromecraft", label: "ChromeCraft", version: app.getVersion() },
      {
        id: "electron",
        label: "Electron",
        version: process.versions.electron,
      },
      { id: "chromium", label: "Chromium", version: process.versions.chrome },
      { id: "node", label: "Node.js", version: process.versions.node },
      { id: "yt-dlp", label: "yt-dlp", version: YT_DLP_VERSION },
    ],
    emit: sendUpdateSnapshot,
    prepareForRestart: prepareForUpdateRestart,
  });

  const preferences = new PreferencesStore(
    path.join(app.getPath("userData"), "preferences.json"),
  );
  await preferences.load();
  const data = new BrowserDataStore(
    path.join(app.getPath("userData"), "browser-data.json"),
    {
      maxHistoryEntries: 10_000,
      maxRecentlyClosedTabs: 25,
      maxQuickLinks: 12,
    },
  );
  await data.load();
  browserData = data;
  const ublock = new UblockService(browserSession, preferences);
  const suggestions = new SearchSuggestionService(
    preferences,
    (input, init) => browserSession.fetch(input, init),
    smokeUserData
      ? argumentValue("chromecraft-smoke-suggestions-url")
      : undefined,
  );
  searchSuggestionService = suggestions;

  const titleBarColors = () =>
    nativeTheme.shouldUseDarkColors
      ? { background: "#111318", chrome: "#1d2024", foreground: "#e2e2e9" }
      : { background: "#f9f9ff", chrome: "#eef0f9", foreground: "#1a1b20" };
  const initialWindowColors = titleBarColors();
  const window = new BaseWindow({
    title: "Chromecraft",
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: initialWindowColors.background,
    titleBarStyle: "hidden",
    ...(process.platform !== "darwin"
      ? {
          titleBarOverlay: {
            color: initialWindowColors.chrome,
            symbolColor: initialWindowColors.foreground,
            height: 42,
          },
        }
      : {}),
  });
  mainWindow = window;
  Menu.setApplicationMenu(null);

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  view.setBackgroundColor("#00000000");
  shellView = view;
  window.contentView.addChildView(view);

  const downloadsDirectory = smokeUserData
    ? path.join(app.getPath("userData"), "downloads")
    : app.getPath("downloads");
  const smartDownloadsDirectory = path.join(
    downloadsDirectory,
    ".chromecraft-smart-downloads",
  );
  const smartDownloadsDataDirectory = path.join(
    app.getPath("userData"),
    "smart-downloads",
  );
  const smartDownloadsThumbnailDirectory = path.join(
    smartDownloadsDataDirectory,
    "thumbnails",
  );
  const mediaToolsDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "media-tools")
    : path.join(app.getAppPath(), "resources", "media-tools");
  const downloads = new DownloadManager(browserSession, {
    downloadsDirectory,
    historyFilePath: path.join(app.getPath("userData"), "downloads.json"),
    onChange: (items) => {
      if (!view.webContents.isDestroyed())
        view.webContents.send(channels.downloadsChanged, mapDownloads(items));
    },
  });
  await downloads.initialize();
  downloadManager = downloads;

  const gallery = new GalleryStore({
    filePath: path.join(app.getPath("userData"), "gallery.json"),
    downloadsDirectory,
    thumbnailDirectory: smartDownloadsThumbnailDirectory,
    onChange: sendGallerySnapshot,
  });
  await gallery.initialize();
  galleryStore = gallery;
  registerGalleryMediaProtocol(view.webContents.session, (kind, id) =>
    kind === "thumbnail"
      ? gallery.resolveThumbnail(id)
      : gallery.resolveFile(id),
  );

  const youtubeDownloads = new YouTubeDownloadService({
    downloadsDirectory,
    smartDownloadsDirectory,
    thumbnailDirectory: smartDownloadsThumbnailDirectory,
    toolsDirectory: mediaToolsDirectory,
    onChange: (snapshot: YouTubeDownloadsSnapshot) => {
      smartDownloadsService?.syncDownloads(snapshot);
      const active = snapshot.items.some((item) =>
        ["pending", "downloading", "finishing"].includes(item.stage),
      );
      if (youtubeIndicatorHideTimer) {
        clearTimeout(youtubeIndicatorHideTimer);
        youtubeIndicatorHideTimer = null;
      }
      tabManager?.setYouTubeDownloadIndicatorVisible(true);
      if (!active) {
        youtubeIndicatorHideTimer = setTimeout(() => {
          youtubeIndicatorHideTimer = null;
          tabManager?.setYouTubeDownloadIndicatorVisible(false);
        }, 5_200);
      }
      if (!view.webContents.isDestroyed()) {
        view.webContents.send(channels.youtubeDownloadsChanged, snapshot);
      }
    },
    onCompleted: async (item, savePath, context) => {
      try {
        downloads.recordCompletedExternalDownload({
          url: item.sourceUrl,
          savePath,
          mimeType:
            path.extname(savePath).toLowerCase() === ".webm"
              ? "video/webm"
              : "video/mp4",
          startedAt: item.startedAt,
          endedAt: item.finishedAt ?? undefined,
        });
      } catch (error) {
        console.warn(
          "Could not add the YouTube video to download history.",
          error,
        );
      }
      let savedToGallery = false;
      let galleryEntryId: string | null = null;
      if (
        preferences.snapshot.addVideosToGallery ||
        context.origin === "smart"
      ) {
        try {
          const galleryEntry = await gallery.addCompleted({
            filePath: savePath,
            title:
              context.mediaMetadata?.title ??
              item.filename
                ?.replace(/\s+\[[a-zA-Z0-9_-]{6,}\](?=\.[^.]+$)/u, "")
                .replace(/\.[^.]+$/u, ""),
            sourceTitle: context.mediaMetadata?.title,
            durationSeconds: context.mediaMetadata?.durationSeconds,
            width: context.mediaMetadata?.width,
            height: context.mediaMetadata?.height,
            videoFormat: context.mediaMetadata?.videoFormat,
            downloadedAt: item.finishedAt ?? Date.now(),
            sourceName: "YouTube",
            sourceUrl: item.sourceUrl,
            thumbnailPath: context.thumbnailPath,
            managedBy: context.origin,
            smartChannelId: context.smartChannelId,
          });
          galleryEntryId = galleryEntry.id;
          savedToGallery = true;
        } catch (error) {
          console.warn("Could not add video to My Gallery.", error);
        }
      }
      if (context.origin === "smart") {
        try {
          await smartDownloadsService?.registerCompletedDownload(
            item,
            savePath,
            context,
            galleryEntryId,
          );
        } catch (error) {
          console.warn("Could not register managed Smart Download.", error);
        }
      } else if (!savedToGallery && context.thumbnailPath) {
        await fs
          .rm(context.thumbnailPath, { force: true })
          .catch(() => undefined);
      }
      if (
        preferences.snapshot.showDownloadCompletionNotification &&
        Notification.isSupported()
      ) {
        new Notification({
          title: "Video downloaded",
          body: item.filename
            ? `${item.filename} was saved${savedToGallery ? " to My Gallery" : " to Downloads"}.`
            : `Your video was saved${savedToGallery ? " to My Gallery" : " to Downloads"}.`,
          silent: true,
        }).show();
      }
      return savedToGallery;
    },
  });
  youtubeDownloadService = youtubeDownloads;
  try {
    await youtubeDownloads.initialize();
  } catch (error) {
    console.error("Bundled YouTube downloader is unavailable.", error);
  }
  const repairTools = mediaToolPaths(mediaToolsDirectory);
  galleryMediaRepairService = new GalleryMediaRepairService({
    gallery,
    downloadsDirectory,
    thumbnailDirectory: smartDownloadsThumbnailDirectory,
    ytDlpPath: repairTools.ytDlp,
    denoPath: repairTools.deno,
    canFetchOriginals: () => youtubeDownloads.snapshot.available,
  });

  const smartDownloads = new SmartDownloadsService({
    stateFilePath: path.join(smartDownloadsDataDirectory, "state.json"),
    managedDirectory: smartDownloadsDirectory,
    thumbnailDirectory: smartDownloadsThumbnailDirectory,
    mediaToolsDirectory,
    downloader: youtubeDownloads,
    gallery,
    onChange: sendSmartDownloadsSnapshot,
    onBackgroundPreferenceChanged: syncSmartBackgroundPreferences,
    isBrowserBusy: () => {
      const snapshot = tabManager?.snapshot;
      return (
        snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId)
          ?.isLoading ?? false
      );
    },
    currentlyPlayingSourceKeys: () => {
      const snapshot = tabManager?.snapshot;
      const active = snapshot?.tabs.find(
        (tab) => tab.id === snapshot.activeTabId,
      );
      if (!active?.url.startsWith("chromecraft://gallery/")) return [];
      let galleryEntryId: string | null = null;
      try {
        galleryEntryId = new URL(active.url).searchParams.get("video");
      } catch {
        return [];
      }
      if (!galleryEntryId) return [];
      const record = smartDownloadsService?.store.snapshot.downloads.find(
        (download) =>
          download.present && download.galleryEntryId === galleryEntryId,
      );
      return record ? [record.sourceKey] : [];
    },
  });
  smartDownloadsService = smartDownloads;
  await smartDownloads.initialize();
  await syncSmartBackgroundPreferences(
    smartDownloads.snapshot.config.backgroundEnabled,
    smartDownloads.snapshot.config.startWithWindows,
  );

  const hyperdrive = new HyperdriveController(browserSession, preferences, {
    learningFilePath: path.join(
      app.getPath("userData"),
      "hyperdrive-learning.json",
    ),
    emit: (snapshot) => {
      if (shellView && !shellView.webContents.isDestroyed()) {
        shellView.webContents.send(
          channels.hyperdriveSnapshotChanged,
          snapshot,
        );
      }
    },
    prepareDocument: (tabId, request) =>
      tabManager?.sendHyperdrivePreparation(tabId, request),
    cancelDocument: (tabId, id) =>
      tabManager?.cancelHyperdrivePreparation(tabId, id),
    canPrepare: () => !ublock.snapshot.enabled || ublock.snapshot.ready,
  });
  await hyperdrive.initialize();
  hyperdrive.setBrowserData(data.snapshot);
  hyperdriveController = hyperdrive;

  const manager = new TabManager(
    window,
    view,
    browserSession,
    ublock,
    extensionService,
    preferences,
    data,
    hyperdrive,
    sendBrowserData,
    () => void sendExtensionsSnapshot(),
    (input) => actionHost.handleCommandInput(input),
    (contents) => websitePermissionController?.revoke(contents),
    (signal) => {
      void smartDownloads
        .recordYouTubePlayback(signal)
        .catch((error) =>
          console.warn(
            "Could not record local YouTube viewing activity.",
            error,
          ),
        );
    },
  );
  tabManager = manager;
  websitePermissionController = new WebsitePermissionController({
    contextFor: (contents) =>
      manager.getActiveWebsitePermissionContext(contents),
    prompt: (request) => promptForWebsitePermission(request),
  });
  actionHost.attachTabs(manager);
  manager.initialize();
  registerIpc();

  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event, url) => {
    const developmentOrigin = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
      : null;
    const allowed =
      url.startsWith("file://") ||
      (developmentOrigin !== null && new URL(url).origin === developmentOrigin);
    if (!allowed) event.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await view.webContents.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await view.webContents.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  let closingApproved = false;
  window.on("close", (event) => {
    if (closingApproved || updateRestartPrepared) {
      suggestions.dispose();
      hyperdrive.dispose();
      manager.dispose();
      return;
    }
    if (
      !quittingCompletely &&
      smartDownloads.snapshot.config.backgroundEnabled
    ) {
      event.preventDefault();
      window.hide();
      if (Notification.isSupported()) {
        new Notification({
          title: "Chromecraft is still running",
          body: "Smart Downloads will keep checking from the system tray.",
          silent: true,
        }).show();
      }
      return;
    }
    event.preventDefault();
    void Promise.all([
      manager.flushSession(),
      smartDownloads.dispose(),
      youtubeDownloads.dispose(),
      downloads.dispose(),
    ]).finally(() => {
      closingApproved = true;
      window.close();
    });
  });
  window.on("closed", () => {
    actionHost.dispose();
    if (extensionWebRequestHost === actionHost) extensionWebRequestHost = null;
    extensions.dispose();
    updateManager?.dispose();
    nativeTheme.removeListener("updated", syncWindowChromeTheme);
    if (mainWindow === window) {
      mainWindow = null;
      shellView = null;
      tabManager = null;
      extensionService = null;
      browserData = null;
      downloadManager = null;
      searchSuggestionService = null;
      hyperdriveController = null;
      updateManager = null;
      websitePermissionController?.clear();
      websitePermissionController = null;
      youtubeDownloadService = null;
      galleryStore = null;
      smartDownloadsService = null;
      smartDownloadsTray?.destroy();
      smartDownloadsTray = null;
      if (youtubeIndicatorHideTimer) clearTimeout(youtubeIndicatorHideTimer);
      youtubeIndicatorHideTimer = null;
    }
  });

  const syncWindowChromeTheme = () => {
    if (window.isDestroyed()) return;
    const colors = titleBarColors();
    window.setBackgroundColor(colors.background);
    if (process.platform !== "darwin") {
      window.setTitleBarOverlay({
        color: colors.chrome,
        symbolColor: colors.foreground,
        height: 42,
      });
    }
  };
  nativeTheme.on("updated", syncWindowChromeTheme);

  const reportPath = argumentValue("chromecraft-smoke-report");
  const screenshotPath = argumentValue("chromecraft-smoke-screenshot");
  const shellScreenshotPath = argumentValue(
    "chromecraft-smoke-shell-screenshot",
  );
  if (
    process.argv.includes("--chromecraft-background") &&
    smartDownloads.snapshot.config.backgroundEnabled
  ) {
    window.hide();
  } else {
    window.show();
  }
  const ublockInitialization = ublock.initialize();
  void ublockInitialization.finally(() => manager.refreshProtectionState());

  if (smokeFixtureUrl && reportPath && screenshotPath && shellScreenshotPath) {
    await ublockInitialization;
    const { runSmokeTest } = await import("./smoke");
    const report = await runSmokeTest(manager, ublock, downloads, {
      reportPath: path.resolve(reportPath),
      screenshotPath: path.resolve(screenshotPath),
      shellScreenshotPath: path.resolve(shellScreenshotPath),
      fixtureUrl: smokeFixtureUrl,
      liveUrl: argumentValue("chromecraft-live-url"),
      startedAt,
    });
    console.info(JSON.stringify(report));
    app.exit(report.success ? 0 : 1);
    return;
  }

  const youtubeSmokeUrl = argumentValue("chromecraft-youtube-smoke-url");
  const youtubeSmokeReport = argumentValue("chromecraft-youtube-smoke-report");
  const youtubeSmokeScreenshot = argumentValue(
    "chromecraft-youtube-smoke-screenshot",
  );
  if (youtubeSmokeUrl && youtubeSmokeReport && youtubeSmokeScreenshot) {
    await ublockInitialization;
    const { runYouTubeUtilitySmoke } = await import("./youtube-utility-smoke");
    const success = await runYouTubeUtilitySmoke(
      manager,
      downloads,
      youtubeDownloads,
      gallery,
      {
        url: youtubeSmokeUrl,
        reportPath: path.resolve(youtubeSmokeReport),
        screenshotPath: path.resolve(youtubeSmokeScreenshot),
      },
    );
    await youtubeDownloads.dispose();
    await smartDownloads.dispose();
    await downloads.dispose();
    app.exit(success ? 0 : 1);
  }
}

if (handlingSquirrelStartup) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    try {
      await createMainWindow();
    } catch (error) {
      console.error("Chromecraft failed to start.", error);
      app.exit(1);
    }
  });
}

app.on("before-quit", () => {
  quittingCompletely = true;
});

app.on("window-all-closed", () => {
  if (
    !quittingCompletely &&
    smartDownloadsService?.snapshot.config.backgroundEnabled
  )
    return;
  app.quit();
});

app.on("activate", () => {
  if (handlingSquirrelStartup) return;
  if (mainWindow && !mainWindow.isDestroyed()) showChromecraft();
  else void createMainWindow();
});

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught main-process error.", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled main-process rejection.", reason);
});
