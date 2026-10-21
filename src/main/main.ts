import { performance } from "node:perf_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  app,
  BaseWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  session,
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
import { HyperdriveController } from "./hyperdrive/controller";
import { PreferencesStore } from "./preferences";
import { SearchSuggestionService } from "./search-suggestions";
import { TabManager } from "./tab-manager";
import { UblockService } from "./ublock-service";
import { UpdateManager } from "./update-manager";
import { parseChromeWebStoreListingUrl } from "../shared/web-store-listing";

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

const updateManager = new UpdateManager({
  adapter: new ElectronUpdateAdapter({
    isPackaged: app.isPackaged,
    platform: process.platform,
    executablePath: process.execPath,
    feedUrl: CHROMECRAFT_UPDATE_FEED_URL,
  }),
  installedVersions: [
    { id: "chromecraft", label: "ChromeCraft", version: app.getVersion() },
    {
      id: "electron",
      label: "Electron",
      version: process.versions.electron,
    },
    { id: "chromium", label: "Chromium", version: process.versions.chrome },
    { id: "node", label: "Node.js", version: process.versions.node },
  ],
  emit: sendUpdateSnapshot,
  prepareForRestart: prepareForUpdateRestart,
});

function sendUpdateSnapshot(snapshot = updateManager.snapshot): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(channels.updatesChanged, snapshot);
}

function prepareForUpdateRestart(): Promise<void> {
  if (updateShutdownPromise) return updateShutdownPromise;
  updateShutdownPromise = Promise.all([
    tabManager?.flushSession() ?? Promise.resolve(),
    downloadManager?.dispose() ?? Promise.resolve(),
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
    return updateManager.snapshot;
  });
  ipcMain.handle(channels.checkForUpdates, async (event) => {
    requireTrusted(event);
    return updateManager.check();
  });
  ipcMain.handle(channels.restartToUpdate, async (event) => {
    requireTrusted(event);
    await updateManager.restart();
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
      await requireManager(event).toggleExtensionPopup(
        requireString(id, "id", 32),
        requireExtensionPopupAnchor(anchor),
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
}

async function createMainWindow(): Promise<void> {
  const smokeTheme = argumentValue("chromecraft-smoke-theme");
  if (smokeTheme === "light" || smokeTheme === "dark")
    nativeTheme.themeSource = smokeTheme;
  const browserSession = session.fromPartition(profilePartition);
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  browserSession.setSpellCheckerEnabled(false);
  browserSession.setUserAgent(
    browserSession.getUserAgent().replace(/\sElectron\/[^\s]+/, ""),
  );
  registerInternalProtocol(browserSession);

  const extensionWebRequestHost = new ExtensionWebRequestHost(browserSession, {
    serviceWorkerPreloadPath: path.join(
      __dirname,
      "extension-service-worker-preload.cjs",
    ),
    observerPreloadPath: path.join(
      __dirname,
      "extension-network-observer-preload.cjs",
    ),
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
  });
  await extensionWebRequestHost.start();

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

  const downloads = new DownloadManager(browserSession, {
    downloadsDirectory: smokeUserData
      ? path.join(app.getPath("userData"), "downloads")
      : undefined,
    historyFilePath: path.join(app.getPath("userData"), "downloads.json"),
    onChange: (items) => {
      if (!view.webContents.isDestroyed())
        view.webContents.send(channels.downloadsChanged, mapDownloads(items));
    },
  });
  await downloads.initialize();
  downloadManager = downloads;

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
  );
  tabManager = manager;
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
    event.preventDefault();
    void Promise.all([manager.flushSession(), downloads.dispose()]).finally(
      () => {
        closingApproved = true;
        window.close();
      },
    );
  });
  window.on("closed", () => {
    extensionWebRequestHost.dispose();
    extensions.dispose();
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
  window.show();
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

app.on("window-all-closed", () => app.quit());

app.on("activate", () => {
  if (!handlingSquirrelStartup && !mainWindow) void createMainWindow();
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
