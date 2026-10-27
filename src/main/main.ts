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
import mediaToolsManifest from "../../resources/media-tools/manifest.json";

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
  TabGroupColor,
  TabGroupUpdate,
  TabSelectionMode,
  SecureDnsMode,
  SitePermissionDecision,
  SitePermissionKey,
  SplitViewCommand,
  WebsiteControlsSnapshot,
  YouTubeDownloadsSnapshot,
  GallerySnapshot,
} from "../shared/browser";
import type { OfflinePagesSnapshot } from "../shared/offline-pages";
import type {
  AiGroupingMode,
  AiProviderId,
  AiToolsSnapshot,
  GeminiApiKeyUpdate,
  OrganiseTabsProposal,
  OrganiseTabsRequest,
} from "../shared/ai-tools";
import type {
  AssistantAttachment,
  AssistantElementContext,
  AssistantMessageRequest,
} from "../shared/ai-assistant";
import type {
  AgentRunCommand,
  AgentRunStartRequest,
  ScoutAgentSnapshot,
  ScoutPermissionMode,
} from "../shared/agent";
import type {
  CommitOnboardingGeminiKeyRequest,
  GeminiClipboardDetectionSnapshot,
  OnboardingViewBounds,
} from "../shared/onboarding";
import { isAllowedWebUrl } from "../shared/navigation";
import { BrowserDataStore } from "./browser-data";
import { ReadingPositionStore } from "./reading-position-store";
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
import { OfflinePageStore } from "./offline-page-store";
import { registerOfflinePageProtocol } from "./offline-page-protocol";
import {
  registerSmartReaderProtocol,
  SmartReaderDocumentStore,
} from "./smart-reader-protocol";
import { HyperdriveController } from "./hyperdrive/controller";
import { PreferencesStore } from "./preferences";
import { SearchSuggestionService } from "./search-suggestions";
import { TabManager } from "./tab-manager";
import { UblockService } from "./ublock-service";
import { UpdateManager } from "./update-manager";
import { UpdateStateStore } from "./update-state-store";
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
import { AiToolsController } from "./ai/controller";
import { GeminiCredentialStore } from "./ai/gemini-credential-store";
import { OllamaClient } from "./ai/ollama-client";
import { OrganiseTabsTool } from "./ai/organise-tabs-tool";
import { ScoutAgentController } from "./ai/scout-agent-controller";
import { ScoutAgentModelResolver } from "./ai/agent-provider-resolver";
import { AppMetricsCollector } from "./app-metrics-collector";
import { chromecraftIcon, chromecraftIconPath } from "./app-icon";
import { PerformanceCentreController } from "./performance-centre-controller";
import { OnboardingGeminiController } from "./onboarding-gemini-controller";
import { isPerformanceAction } from "../shared/performance-centre";
import {
  canonicalWebOrigin,
  isSecureDnsMode,
  isSitePermissionDecision,
  isSitePermissionKey,
  WebsiteControlsService,
  type WebsitePermissionPromptRequest as ManagedWebsitePermissionPrompt,
} from "./website-controls";

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
  {
    scheme: "chromecraft-offline",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      stream: true,
    },
  },
  {
    scheme: "chromecraft-reader",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
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
const forceOnboarding = process.argv.includes("--chromecraft-show-onboarding");

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
let websiteControls: WebsiteControlsService | null = null;
let youtubeDownloadService: YouTubeDownloadService | null = null;
let galleryStore: GalleryStore | null = null;
let offlinePageStore: OfflinePageStore | null = null;
let galleryMediaRepairService: GalleryMediaRepairService | null = null;
let smartDownloadsService: SmartDownloadsService | null = null;
let aiToolsController: AiToolsController | null = null;
let scoutAgentController: ScoutAgentController | null = null;
let smartDownloadsTray: Tray | null = null;
let quittingCompletely = false;
let deleteAllGalleryItemsInFlight = false;
let youtubeIndicatorHideTimer: NodeJS.Timeout | null = null;
let appMetricsCollector: AppMetricsCollector | null = null;
let performanceCentreController: PerformanceCentreController | null = null;
let onboardingGeminiController: OnboardingGeminiController | null = null;

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

async function promptForManagedWebsitePermission(
  request: ManagedWebsitePermissionPrompt,
): Promise<"allow-once" | "allow" | "block"> {
  if (
    smokeUserData &&
    process.argv.includes("--chromecraft-smoke-allow-site-permissions")
  ) {
    return "allow-once";
  }
  const hostname = new URL(request.origin).hostname;
  const names: Record<SitePermissionKey, string> = {
    camera: "camera",
    microphone: "microphone",
    location: "location",
    notifications: "notifications",
    popups: "pop-ups",
    clipboard: "clipboard",
    autoplay: "autoplay",
    downloads: "automatic downloads",
    network: "network access",
    javascript: "JavaScript",
    hyperdrive: "Hyperdrive",
  };
  const requested = request.permissions.map((key) => names[key]).join(" and ");
  const answer = await dialog.showMessageBox({
    type: "question",
    title: "Website permission",
    message: `${hostname} wants to use your ${requested}`,
    detail:
      "Allow once lasts while this page stays active and ends when you switch away, navigate, or close it. You can change saved access from the site controls beside the address bar.",
    buttons: ["Block", "Allow once", "Always allow"],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  return answer.response === 2
    ? "allow"
    : answer.response === 1
      ? "allow-once"
      : "block";
}

function sendWebsiteControls(snapshot: WebsiteControlsSnapshot): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(channels.websiteControlsChanged, snapshot);
}

function requireWebsiteControls(
  event: Pick<IpcMainInvokeEvent, "sender">,
): WebsiteControlsService {
  requireTrusted(event);
  if (!websiteControls) throw new Error("Website controls are unavailable.");
  return websiteControls;
}

function applySecureDns(mode: SecureDnsMode, providerUrl: string | null): void {
  app.configureHostResolver({
    secureDnsMode:
      mode === "system" ? "off" : mode === "secure" ? "secure" : "automatic",
    ...(providerUrl ? { secureDnsServers: [providerUrl] } : {}),
  });
}

async function syncHyperdriveSiteDecision(
  origin: string,
  decision: SitePermissionDecision,
): Promise<void> {
  const manager = tabManager;
  if (!manager) return;
  const hostname = new URL(origin).hostname.toLowerCase();
  const excluded = new Set(
    manager.snapshot.preferences.hyperdriveExcludedHosts.map((host) =>
      host.toLowerCase(),
    ),
  );
  if (decision === "block") excluded.add(hostname);
  else excluded.delete(hostname);
  await manager.setHyperdriveExcludedHosts([...excluded]);
}

function sendUpdateSnapshot(snapshot = updateManager?.snapshot): void {
  if (!snapshot) return;
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(channels.updatesChanged, snapshot);
}

function sendAiToolsSnapshot(snapshot: AiToolsSnapshot): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(channels.aiToolsChanged, snapshot);
}

function sendScoutAgentSnapshot(snapshot: ScoutAgentSnapshot): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(channels.scoutAgentChanged, snapshot);
}

function sendOnboardingGeminiClipboard(
  snapshot: GeminiClipboardDetectionSnapshot,
): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(
    channels.onboardingGeminiClipboardChanged,
    snapshot,
  );
}

function requireUpdateManager(): UpdateManager {
  if (!updateManager) throw new Error("The update service is unavailable.");
  return updateManager;
}

function requireAiTools(event: IpcMainInvokeEvent): AiToolsController {
  requireTrusted(event);
  if (!aiToolsController) throw new Error("AI tools are not ready.");
  return aiToolsController;
}

function requireOnboardingGemini(
  event: IpcMainInvokeEvent,
): OnboardingGeminiController {
  requireTrusted(event);
  if (!onboardingGeminiController) {
    throw new Error("Gemini onboarding is not ready.");
  }
  return onboardingGeminiController;
}

function requireScoutAgent(event: IpcMainInvokeEvent): ScoutAgentController {
  requireTrusted(event);
  if (!scoutAgentController) throw new Error("Scout research is not ready.");
  return scoutAgentController;
}

function prepareForUpdateRestart(): Promise<void> {
  if (updateShutdownPromise) return updateShutdownPromise;
  const restoreMarker = path.join(
    app.getPath("userData"),
    "restore-session-after-update",
  );
  const agentShutdown = (
    scoutAgentController?.dispose() ?? Promise.resolve()
  ).finally(() => aiToolsController?.dispose());
  updateShutdownPromise = Promise.all([
    agentShutdown,
    tabManager?.flushSession(true) ?? Promise.resolve(),
    downloadManager?.dispose() ?? Promise.resolve(),
    smartDownloadsService?.dispose() ?? Promise.resolve(),
    youtubeDownloadService?.dispose() ?? Promise.resolve(),
  ])
    .then(() =>
      fs.writeFile(
        restoreMarker,
        `${JSON.stringify({
          version: 1,
          preparedFromVersion: app.getVersion(),
          createdAt: Date.now(),
          attempts: 0,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      ),
    )
    .then(() => {
      updateRestartPrepared = true;
    })
    .catch(async (error) => {
      await fs.rm(restoreMarker, { force: true }).catch(() => undefined);
      updateShutdownPromise = null;
      throw error;
    });
  return updateShutdownPromise;
}

async function prepareUpdateSessionRecovery(
  markerPath: string,
): Promise<boolean> {
  const maximumAgeMs = 24 * 60 * 60 * 1_000;
  const maximumAttempts = 3;
  try {
    const raw = await fs.readFile(markerPath, "utf8");
    if (raw.length > 2_000)
      throw new Error("Update recovery marker is too large.");
    const marker = JSON.parse(raw) as Record<string, unknown>;
    const createdAt = marker.createdAt;
    const attempts = marker.attempts;
    if (
      marker.version !== 1 ||
      typeof marker.preparedFromVersion !== "string" ||
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt) ||
      createdAt < Date.now() - maximumAgeMs ||
      createdAt > Date.now() + 60_000 ||
      typeof attempts !== "number" ||
      !Number.isInteger(attempts) ||
      attempts < 0 ||
      attempts >= maximumAttempts
    ) {
      throw new Error("Update recovery marker is invalid or expired.");
    }
    await fs.writeFile(
      markerPath,
      `${JSON.stringify({ ...marker, attempts: attempts + 1 })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Discarding an unusable update recovery marker.", error);
      await fs.rm(markerPath, { force: true }).catch(() => undefined);
    }
    return false;
  }
}

function requireManager(event: IpcMainInvokeEvent): TabManager {
  if (!tabManager || !shellView || event.sender !== shellView.webContents) {
    throw new Error("Rejected IPC call from an untrusted renderer.");
  }
  return tabManager;
}

function requirePerformanceCentre(
  event: Pick<IpcMainInvokeEvent, "sender">,
): PerformanceCentreController {
  if (
    !performanceCentreController ||
    !performanceCentreController.isTrustedSender(event.sender)
  ) {
    throw new Error(
      "Rejected Performance Centre IPC from an untrusted renderer.",
    );
  }
  return performanceCentreController;
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
    toolbarPinned: tabManager?.isExtensionToolbarPinned(extension.id) ?? true,
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
    const snapshot = await getExtensionsSnapshot();
    updateManager?.setInstalledExtensions(
      snapshot.items.map((extension) => ({
        id: extension.id,
        name: extension.name,
        version: extension.version,
        enabled: extension.enabled,
        sourceUrl: extension.sourceUrl ?? `unpacked:${extension.id}`,
        iconDataUrl: extension.iconDataUrl,
      })),
    );
    if (!shellView || shellView.webContents.isDestroyed()) return;
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

function requireOfflinePages(event: IpcMainInvokeEvent): OfflinePageStore {
  requireTrusted(event);
  if (!offlinePageStore) throw new Error("Offline Pages is not ready.");
  return offlinePageStore;
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

function sendOfflinePagesSnapshot(snapshot: OfflinePagesSnapshot): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(channels.offlinePagesChanged, snapshot);
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
    const icon = chromecraftIcon(32);
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

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
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

function requireTabIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new TypeError("tabIds must be an array of at most 500 entries.");
  return value.map((entry) => requireString(entry, "tabId", 128));
}

function requireTabGroupColor(value: unknown): TabGroupColor {
  const colors: TabGroupColor[] = [
    "grey",
    "blue",
    "red",
    "yellow",
    "green",
    "pink",
    "purple",
    "cyan",
    "orange",
  ];
  if (!colors.includes(value as TabGroupColor))
    throw new TypeError("Unknown tab group color.");
  return value as TabGroupColor;
}

function requireTabGroupUpdate(value: unknown): TabGroupUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Tab group update is invalid.");
  const requested = value as Record<string, unknown>;
  const update: TabGroupUpdate = {};
  if (requested.name !== undefined)
    update.name = requireString(requested.name, "name", 128);
  if (requested.color !== undefined)
    update.color = requireTabGroupColor(requested.color);
  if (requested.collapsed !== undefined)
    update.collapsed = requireBoolean(requested.collapsed, "collapsed");
  if (requested.saved !== undefined)
    update.saved = requireBoolean(requested.saved, "saved");
  return update;
}

function requireSplitViewCommand(value: unknown): SplitViewCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Split View command is invalid.");
  const requested = value as Record<string, unknown>;
  const type = requested.type;
  const requireExactFields = (allowed: readonly string[]) => {
    if (Object.keys(requested).some((key) => !allowed.includes(key)))
      throw new TypeError("Split View command contains unexpected fields.");
  };
  if (type === "create") {
    requireExactFields(["type", "tabId", "side"]);
    if (requested.side !== "left" && requested.side !== "right")
      throw new TypeError("Split View side must be left or right.");
    return {
      type,
      tabId: requireString(requested.tabId, "tabId", 128),
      side: requested.side,
    };
  }
  if (type === "focus") {
    requireExactFields(["type", "pairId", "tabId"]);
    return {
      type,
      pairId: requireString(requested.pairId, "pairId", 128),
      tabId: requireString(requested.tabId, "tabId", 128),
    };
  }
  if (type === "resize") {
    requireExactFields(["type", "pairId", "ratio"]);
    if (
      typeof requested.ratio !== "number" ||
      !Number.isFinite(requested.ratio) ||
      requested.ratio < 0.15 ||
      requested.ratio > 0.85
    ) {
      throw new TypeError("Split View ratio must be between 0.15 and 0.85.");
    }
    return {
      type,
      pairId: requireString(requested.pairId, "pairId", 128),
      ratio: requested.ratio,
    };
  }
  if (type === "swap" || type === "exit") {
    requireExactFields(["type", "pairId"]);
    return {
      type,
      pairId: requireString(requested.pairId, "pairId", 128),
    };
  }
  throw new TypeError("Unknown Split View command.");
}

function requireAiProvider(value: unknown): AiProviderId {
  if (value !== "ollama" && value !== "gemini") {
    throw new TypeError("Unknown AI provider.");
  }
  return value;
}

function requireAiGroupingMode(value: unknown): AiGroupingMode {
  if (value !== "smart" && value !== "website") {
    throw new TypeError("Unknown tab grouping mode.");
  }
  return value;
}

function requireOrganiseTabsRequest(value: unknown): OrganiseTabsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The tab organisation request is invalid.");
  }
  const request = value as Record<string, unknown>;
  return {
    provider: requireAiProvider(request.provider),
    model:
      request.groupingMode === "website" && request.model === ""
        ? ""
        : requireString(request.model, "model", 256),
    groupingMode: requireAiGroupingMode(request.groupingMode),
    customInstructions:
      request.customInstructions === undefined ||
      request.customInstructions === ""
        ? undefined
        : requireString(
            request.customInstructions,
            "customInstructions",
            1_000,
          ),
    rememberCustomInstructions:
      request.rememberCustomInstructions === undefined
        ? undefined
        : requireBoolean(
            request.rememberCustomInstructions,
            "rememberCustomInstructions",
          ),
    cloudConsent: requireBoolean(request.cloudConsent, "cloudConsent"),
    reuseOriginalSnapshot:
      request.reuseOriginalSnapshot === undefined
        ? undefined
        : requireBoolean(
            request.reuseOriginalSnapshot,
            "reuseOriginalSnapshot",
          ),
  };
}

function optionalAssistantText(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  return value === undefined || value === null || value === ""
    ? undefined
    : requireString(value, label, maximum);
}

function requireAssistantAttachment(value: unknown): AssistantAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Scout context is invalid.");
  }
  const attachment = value as Record<string, unknown>;
  const kinds = [
    "page",
    "url",
    "title",
    "description",
    "selected-text",
    "screenshot",
    "element",
    "full-reader-article",
  ] as const;
  if (!kinds.includes(attachment.kind as (typeof kinds)[number])) {
    throw new TypeError("Scout context has an unknown kind.");
  }
  const rawData =
    attachment.data &&
    typeof attachment.data === "object" &&
    !Array.isArray(attachment.data)
      ? (attachment.data as Record<string, unknown>)
      : {};
  let element: AssistantElementContext | undefined;
  if (rawData.element !== undefined) {
    if (
      !rawData.element ||
      typeof rawData.element !== "object" ||
      Array.isArray(rawData.element)
    ) {
      throw new TypeError("The selected page element is invalid.");
    }
    const source = rawData.element as Record<string, unknown>;
    element = {
      tag: requireString(source.tag, "element tag", 64),
      role: optionalAssistantText(source.role, "element role", 128) ?? null,
      label: optionalAssistantText(source.label, "element label", 500) ?? null,
      text: optionalAssistantText(source.text, "element text", 2_000) ?? null,
      href: optionalAssistantText(source.href, "element href", 2_048) ?? null,
      alt: optionalAssistantText(source.alt, "element alt", 500) ?? null,
      placeholder:
        optionalAssistantText(source.placeholder, "element placeholder", 500) ??
        null,
      type: optionalAssistantText(source.type, "element type", 128) ?? null,
      markup: "",
    };
  }
  const screenshotDataUrl = optionalAssistantText(
    rawData.screenshotDataUrl,
    "screenshot",
    3 * 1024 * 1024,
  );
  if (
    screenshotDataUrl &&
    !/^data:image\/png;base64,[a-z0-9+/=]+$/iu.test(screenshotDataUrl)
  ) {
    throw new TypeError("The Scout screenshot is invalid.");
  }
  let readerArticle: AssistantAttachment["data"]["readerArticle"];
  if (rawData.readerArticle !== undefined) {
    if (
      !rawData.readerArticle ||
      typeof rawData.readerArticle !== "object" ||
      Array.isArray(rawData.readerArticle)
    ) {
      throw new TypeError("The Reader article context is invalid.");
    }
    const source = rawData.readerArticle as Record<string, unknown>;
    const url = requireString(source.url, "article URL", 2_048);
    if (!isAllowedWebUrl(url))
      throw new TypeError("The article URL is invalid.");
    if (!Array.isArray(source.headings) || source.headings.length > 100) {
      throw new TypeError("The article heading list is invalid.");
    }
    readerArticle = {
      tabId: requireString(source.tabId, "article tab id", 128),
      revision: Number.isSafeInteger(source.revision)
        ? (source.revision as number)
        : (() => {
            throw new TypeError("The article revision is invalid.");
          })(),
      url,
      title: requireString(source.title, "article title", 1_000),
      siteName:
        optionalAssistantText(source.siteName, "article website", 300) ?? null,
      byline:
        optionalAssistantText(source.byline, "article author", 500) ?? null,
      publishedTime:
        optionalAssistantText(
          source.publishedTime,
          "article publication date",
          200,
        ) ?? null,
      headings: source.headings.map((heading) =>
        requireString(heading, "article heading", 500),
      ),
      text: requireString(source.text, "article text", 1_000_000),
      complete: source.complete !== false,
    };
  }
  if (attachment.kind === "full-reader-article" && !readerArticle) {
    throw new TypeError("Full Reader article context is missing its article.");
  }
  if (attachment.kind !== "full-reader-article" && readerArticle) {
    throw new TypeError(
      "Reader article context has an invalid attachment kind.",
    );
  }
  return {
    id: requireString(attachment.id, "context id", 128),
    kind: attachment.kind as AssistantAttachment["kind"],
    label: requireString(attachment.label, "context label", 160),
    detail:
      optionalAssistantText(attachment.detail, "context detail", 500) ?? null,
    createdAt:
      typeof attachment.createdAt === "number" &&
      Number.isFinite(attachment.createdAt)
        ? attachment.createdAt
        : Date.now(),
    data: {
      url: optionalAssistantText(rawData.url, "context URL", 2_048),
      title: optionalAssistantText(rawData.title, "context title", 240),
      description: optionalAssistantText(
        rawData.description,
        "context description",
        2_000,
      ),
      selectedText: optionalAssistantText(
        rawData.selectedText,
        "selected text",
        8_000,
      ),
      screenshotDataUrl,
      element,
      readerArticle,
    },
  };
}

function requireAssistantMessageRequest(
  value: unknown,
): AssistantMessageRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The Scout message is invalid.");
  }
  const request = value as Record<string, unknown>;
  if (!Array.isArray(request.context) || request.context.length > 12) {
    throw new TypeError("Scout can include at most 12 context items.");
  }
  if (!Array.isArray(request.history) || request.history.length > 24) {
    throw new TypeError("Scout conversation history is too large.");
  }
  const prompt = requireString(request.prompt, "prompt", 16_000);
  const context = request.context.map(requireAssistantAttachment);
  const history: AssistantMessageRequest["history"] = request.history.map(
    (entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new TypeError("Scout conversation history is invalid.");
      }
      const turn = entry as Record<string, unknown>;
      const role = turn.role;
      if (role !== "user" && role !== "assistant") {
        throw new TypeError("Scout conversation history has an invalid role.");
      }
      return {
        role,
        text: requireString(turn.text, "conversation turn", 16_000),
      };
    },
  );
  const payloadSize =
    prompt.length +
    JSON.stringify(context).length +
    JSON.stringify(history).length;
  if (payloadSize > 4 * 1024 * 1024) {
    throw new TypeError("Scout context is too large to send safely.");
  }
  return {
    conversationId: requireString(
      request.conversationId,
      "conversation id",
      128,
    ),
    messageId: requireString(request.messageId, "message id", 128),
    prompt,
    createdAt:
      typeof request.createdAt === "number" &&
      Number.isFinite(request.createdAt)
        ? request.createdAt
        : Date.now(),
    provider: requireAiProvider(request.provider),
    model: requireString(request.model, "model", 256),
    context,
    history,
  };
}

function requireScoutAgentStartRequest(value: unknown): AgentRunStartRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The Scout research request is invalid.");
  }
  const source = value as Record<string, unknown>;
  const parsed = requireAssistantMessageRequest({
    ...source,
    prompt: source.objective,
  });
  return {
    conversationId: parsed.conversationId,
    messageId: parsed.messageId,
    objective: parsed.prompt,
    createdAt: parsed.createdAt,
    provider: parsed.provider,
    model: parsed.model,
    context: parsed.context,
    history: parsed.history,
    cloudConsent: requireBoolean(source.cloudConsent, "cloudConsent"),
  };
}

function requireScoutPermissionMode(value: unknown): ScoutPermissionMode {
  if (
    value !== "chat" &&
    value !== "ask" &&
    value !== "smart-approval" &&
    value !== "automated"
  ) {
    throw new TypeError("Choose a supported Scout permission mode.");
  }
  return value;
}

function requireScoutAgentCommand(value: unknown): AgentRunCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The Scout research command is invalid.");
  }
  const command = value as Record<string, unknown>;
  if (command.type === "set-mode") {
    return { type: "set-mode", mode: requireScoutPermissionMode(command.mode) };
  }
  if (command.type === "clear-conversation") {
    return {
      type: "clear-conversation",
      conversationId: requireString(
        command.conversationId,
        "conversation id",
        128,
      ),
    };
  }
  const runId = requireString(command.runId, "run id", 128);
  if (
    command.type === "pause" ||
    command.type === "resume" ||
    command.type === "cancel"
  ) {
    return { type: command.type, runId };
  }
  if (command.type === "open-source") {
    return {
      type: "open-source",
      runId,
      sourceId: requireString(command.sourceId, "source id", 128),
    };
  }
  if (command.type === "enqueue") {
    if (!command.message || typeof command.message !== "object") {
      throw new TypeError("The queued Scout message is invalid.");
    }
    const queued = command.message as Record<string, unknown>;
    return {
      type: "enqueue",
      runId,
      message: {
        id: requireString(queued.id, "queued message id", 128),
        text: requireString(queued.text, "queued message", 4_000),
        createdAt:
          typeof queued.createdAt === "number" &&
          Number.isFinite(queued.createdAt)
            ? queued.createdAt
            : Date.now(),
      },
    };
  }
  if (command.type === "approval") {
    if (!command.decision || typeof command.decision !== "object") {
      throw new TypeError("The Scout approval decision is invalid.");
    }
    const decision = command.decision as Record<string, unknown>;
    return {
      type: "approval",
      decision: {
        runId: requireString(decision.runId, "run id", 128),
        approvalId: requireString(decision.approvalId, "approval id", 128),
        preparedActionHash: requireString(
          decision.preparedActionHash,
          "prepared action hash",
          128,
        ),
        approved: requireBoolean(decision.approved, "approved"),
      },
    };
  }
  throw new TypeError("The Scout research command is not supported.");
}

function requireOrganiseTabsProposal(value: unknown): OrganiseTabsProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The tab proposal is invalid.");
  }
  const proposal = value as Record<string, unknown>;
  if (!Array.isArray(proposal.groups) || proposal.groups.length > 64) {
    throw new TypeError("The tab proposal has too many groups.");
  }
  const groups = proposal.groups.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("The tab proposal contains an invalid group.");
    }
    const group = entry as Record<string, unknown>;
    const tabIds = requireTabIds(group.tabIds);
    return {
      name: requireString(group.name, "group name", 48),
      color: requireTabGroupColor(group.color),
      tabIds,
      tabTitles: tabIds.map(() => ""),
      tabFavicons: tabIds.map(() => null),
    };
  });
  const ungroupedTabIds = requireTabIds(proposal.ungroupedTabIds);
  const provider =
    proposal.provider === "website"
      ? "website"
      : requireAiProvider(proposal.provider);
  return {
    id: requireString(proposal.id, "proposalId", 128),
    toolId: "organise-tabs",
    provider,
    model: requireString(proposal.model, "model", 256),
    createdAt:
      typeof proposal.createdAt === "number" &&
      Number.isFinite(proposal.createdAt)
        ? proposal.createdAt
        : Date.now(),
    groups,
    ungroupedTabIds,
    ungroupedTabTitles: ungroupedTabIds.map(() => ""),
    ungroupedTabFavicons: ungroupedTabIds.map(() => null),
    preservedTabCount: 0,
    summary: "Edited tab organisation",
    warnings: [],
  };
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
  ipcMain.handle(channels.openPerformanceCentre, async (event) => {
    requireTrusted(event);
    await performanceCentreController?.openOrFocus();
  });
  ipcMain.handle(channels.getPerformanceCentre, (event) =>
    requirePerformanceCentre(event).snapshot(),
  );
  ipcMain.handle(
    channels.setPerformanceCentreRefreshInterval,
    (event, interval: unknown) => {
      requirePerformanceCentre(event).setRefreshInterval(interval);
    },
  );
  ipcMain.handle(
    channels.runPerformanceCentreAction,
    (event, action: unknown) => {
      if (!isPerformanceAction(action)) {
        throw new TypeError("Invalid Performance Centre action.");
      }
      return requirePerformanceCentre(event).performAction(action);
    },
  );
  ipcMain.handle(channels.closePerformanceCentre, (event) => {
    requirePerformanceCentre(event).close();
  });
  ipcMain.handle(channels.getUpdates, (event) => {
    requireTrusted(event);
    return requireUpdateManager().snapshot;
  });
  ipcMain.handle(channels.checkForUpdates, async (event) => {
    requireTrusted(event);
    return requireUpdateManager().check();
  });
  ipcMain.handle(channels.updateAllExtensions, async (event) => {
    requireTrusted(event);
    return requireUpdateManager().updateExtensions();
  });
  ipcMain.handle(
    channels.updateExtension,
    async (event, extensionId: unknown) => {
      requireTrusted(event);
      return requireUpdateManager().updateExtension(
        requireString(extensionId, "extensionId", 32),
      );
    },
  );
  ipcMain.handle(
    channels.setUpdatePreferences,
    async (event, value: unknown) => {
      requireTrusted(event);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("Update preferences must be an object.");
      }
      const input = value as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        if (
          ![
            "automaticChecksEnabled",
            "automaticExtensionUpdatesEnabled",
            "notifyWhenReady",
          ].includes(key) ||
          typeof input[key] !== "boolean"
        ) {
          throw new TypeError("Invalid update preference.");
        }
      }
      return requireUpdateManager().setPreferences({
        ...(typeof input.automaticChecksEnabled === "boolean"
          ? { automaticChecksEnabled: input.automaticChecksEnabled }
          : {}),
        ...(typeof input.automaticExtensionUpdatesEnabled === "boolean"
          ? {
              automaticExtensionUpdatesEnabled:
                input.automaticExtensionUpdatesEnabled,
            }
          : {}),
        ...(typeof input.notifyWhenReady === "boolean"
          ? { notifyWhenReady: input.notifyWhenReady }
          : {}),
      });
    },
  );
  ipcMain.handle(channels.restartToUpdate, async (event) => {
    requireTrusted(event);
    await requireUpdateManager().restart();
  });
  ipcMain.handle(
    channels.getAiTools,
    (event) => requireAiTools(event).snapshot,
  );
  ipcMain.handle(channels.refreshAiModels, (event, provider: unknown) =>
    requireAiTools(event).refreshModels(
      provider === undefined ? undefined : requireAiProvider(provider),
    ),
  );
  ipcMain.handle(channels.installRecommendedOllamaModel, (event) =>
    requireAiTools(event).installRecommendedOllamaModel(),
  );
  ipcMain.handle(channels.setAiProvider, (event, provider: unknown) =>
    requireAiTools(event).setProvider(requireAiProvider(provider)),
  );
  ipcMain.handle(channels.setAiOrganiserProvider, (event, provider: unknown) =>
    requireAiTools(event).setOrganiserProvider(requireAiProvider(provider)),
  );
  ipcMain.handle(channels.setAiGroupingMode, (event, mode: unknown) =>
    requireAiTools(event).setGroupingMode(requireAiGroupingMode(mode)),
  );
  ipcMain.handle(
    channels.setAiModel,
    (event, provider: unknown, model: unknown) =>
      requireAiTools(event).setModel(
        requireAiProvider(provider),
        requireString(model, "model", 256),
      ),
  );
  ipcMain.handle(
    channels.setAiOrganiserModel,
    (event, provider: unknown, model: unknown) =>
      requireAiTools(event).setOrganiserModel(
        requireAiProvider(provider),
        requireString(model, "model", 256),
      ),
  );
  ipcMain.handle(channels.setGeminiApiKey, (event, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("The Gemini credential update is invalid.");
    }
    const update = value as Record<string, unknown>;
    return requireAiTools(event).setGeminiApiKey({
      apiKey: requireString(update.apiKey, "apiKey", 512),
      persist: requireBoolean(update.persist, "persist"),
    } satisfies GeminiApiKeyUpdate);
  });
  ipcMain.handle(channels.removeGeminiApiKey, (event) =>
    requireAiTools(event).removeGeminiApiKey(),
  );
  ipcMain.handle(channels.startOnboardingGeminiSetup, (event) =>
    requireOnboardingGemini(event).start(),
  );
  ipcMain.handle(
    channels.setOnboardingGeminiViewBounds,
    (event, value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("The onboarding browser frame is invalid.");
      }
      const bounds = value as Record<string, unknown>;
      requireOnboardingGemini(event).setBounds({
        x: requireNumber(bounds.x, "x"),
        y: requireNumber(bounds.y, "y"),
        width: requireNumber(bounds.width, "width"),
        height: requireNumber(bounds.height, "height"),
      } satisfies OnboardingViewBounds);
    },
  );
  ipcMain.handle(channels.stopOnboardingGeminiSetup, (event) => {
    requireOnboardingGemini(event).stop();
  });
  ipcMain.handle(channels.openOnboardingGeminiSetupExternal, (event) =>
    requireOnboardingGemini(event).openExternal(),
  );
  ipcMain.handle(
    channels.commitOnboardingGeminiClipboardKey,
    (event, value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("The Gemini credential request is invalid.");
      }
      const request = value as Record<string, unknown>;
      return requireOnboardingGemini(event).commit({
        stageId: requireString(request.stageId, "stageId", 128),
        persist: requireBoolean(request.persist, "persist"),
      } satisfies CommitOnboardingGeminiKeyRequest);
    },
  );
  ipcMain.handle(channels.previewAiTool, (event, request: unknown) =>
    requireAiTools(event).preview(requireOrganiseTabsRequest(request)),
  );
  ipcMain.handle(channels.applyAiTool, (event, proposal: unknown) =>
    requireAiTools(event).apply(requireOrganiseTabsProposal(proposal)),
  );
  ipcMain.handle(channels.cancelAiTool, (event) => {
    requireAiTools(event).cancel();
  });
  ipcMain.handle(channels.undoAiTool, (event) => requireAiTools(event).undo());
  ipcMain.handle(channels.getAssistantPageContext, (event, tabId: unknown) =>
    requireManager(event).getAssistantPageContext(
      requireString(tabId, "tabId", 128),
    ),
  );
  ipcMain.handle(channels.startAssistantSelection, (event, kind: unknown) => {
    if (kind !== "screenshot" && kind !== "element") {
      throw new TypeError("Choose a supported assistant selection mode.");
    }
    requireManager(event).startAssistantSelection(kind);
  });
  ipcMain.handle(channels.cancelAssistantSelection, (event) => {
    requireManager(event).cancelAssistantSelection();
  });
  ipcMain.handle(channels.sendAssistantMessage, (event, request: unknown) =>
    requireAiTools(event).sendAssistantMessage(
      requireAssistantMessageRequest(request),
    ),
  );
  ipcMain.handle(
    channels.cancelAssistantMessage,
    (event, messageId: unknown) => {
      requireAiTools(event).cancelAssistantMessage(
        requireString(messageId, "message id", 128),
      );
    },
  );
  ipcMain.handle(
    channels.getScoutAgent,
    (event) => requireScoutAgent(event).snapshot,
  );
  ipcMain.handle(channels.startScoutAgent, (event, request: unknown) =>
    requireScoutAgent(event).start(requireScoutAgentStartRequest(request)),
  );
  ipcMain.handle(channels.commandScoutAgent, (event, command: unknown) =>
    requireScoutAgent(event).command(requireScoutAgentCommand(command)),
  );
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
  ipcMain.handle(channels.updateSplitView, (event, command: unknown) =>
    requireManager(event).updateSplitView(requireSplitViewCommand(command)),
  );
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
  ipcMain.handle(channels.getSmartReader, (event, tabId: unknown) =>
    requireManager(event).getSmartReader(requireString(tabId, "tabId", 128)),
  );
  ipcMain.handle(
    channels.toggleSmartReader,
    (event, tabId: unknown, appearance: unknown) =>
      requireManager(event).toggleSmartReader(
        requireString(tabId, "tabId", 128),
        appearance,
      ),
  );
  ipcMain.handle(
    channels.trySmartReader,
    (event, tabId: unknown, appearance: unknown) =>
      requireManager(event).trySmartReader(
        requireString(tabId, "tabId", 128),
        appearance,
      ),
  );
  ipcMain.handle(
    channels.setSmartReaderAppearance,
    (event, tabId: unknown, appearance: unknown) =>
      requireManager(event).setSmartReaderAppearance(
        requireString(tabId, "tabId", 128),
        appearance,
      ),
  );
  ipcMain.handle(channels.toggleSavedArticle, (event, tabId: unknown) =>
    requireManager(event).toggleSavedArticle(
      requireString(tabId, "tabId", 128),
    ),
  );
  ipcMain.handle(channels.removeSavedArticle, (event, id: unknown) =>
    requireManager(event).removeSavedArticle(requireString(id, "id", 128)),
  );
  ipcMain.handle(
    channels.setSavedArticleRead,
    (event, id: unknown, isRead: unknown) => {
      if (typeof isRead !== "boolean") {
        throw new TypeError("Saved article reading state must be a boolean.");
      }
      return requireManager(event).setSavedArticleRead(
        requireString(id, "id", 128),
        isRead,
      );
    },
  );
  ipcMain.handle(channels.copySavedArticleLink, (event, id: unknown) =>
    requireManager(event).copySavedArticleLink(requireString(id, "id", 128)),
  );
  ipcMain.handle(
    channels.openSavedArticle,
    (event, id: unknown, appearance: unknown) =>
      requireManager(event).openSavedArticle(
        requireString(id, "id", 128),
        appearance,
      ),
  );
  ipcMain.handle(
    channels.setSmartReaderProgressVisible,
    (event, tabId: unknown, visible: unknown) =>
      requireManager(event).setSmartReaderProgressVisible(
        requireString(tabId, "tabId", 128),
        requireBoolean(visible, "visible"),
      ),
  );
  ipcMain.handle(
    channels.runSmartReaderCommand,
    (event, tabId: unknown, command: unknown) =>
      requireManager(event).runSmartReaderCommand(
        requireString(tabId, "tabId", 128),
        command,
      ),
  );
  ipcMain.handle(channels.getSmartReaderToolbar, (event) => {
    if (!tabManager) throw new Error("The browser window is unavailable.");
    return tabManager.getSmartReaderToolbarState(event.sender);
  });
  ipcMain.handle(
    channels.runSmartReaderToolbarAction,
    (event, action: unknown) => {
      if (!tabManager) throw new Error("The browser window is unavailable.");
      return tabManager.runSmartReaderToolbarAction(event.sender, action);
    },
  );
  ipcMain.handle(
    channels.getSmartReaderArticleAttachment,
    (event, tabId: unknown) =>
      requireManager(event).getSmartReaderArticleAttachment(
        requireString(tabId, "tabId", 128),
      ),
  );
  ipcMain.on(channels.smartReaderProgressChanged, (event, value: unknown) => {
    try {
      tabManager?.handleSmartReaderProgress(event.sender, value);
    } catch (error) {
      console.warn("Rejected Smart Reader progress update.", error);
    }
  });
  ipcMain.on(channels.smartReaderPanelClosed, (event, value: unknown) => {
    try {
      tabManager?.handleSmartReaderPanelClosed(event.sender, value);
    } catch (error) {
      console.warn("Rejected Smart Reader panel update.", error);
    }
  });
  ipcMain.handle(channels.getSmartReaderNarrationCapabilities, (event) => {
    if (!tabManager) throw new Error("The browser window is unavailable.");
    return tabManager.getSmartReaderNarrationCapabilities(event.sender);
  });
  ipcMain.handle(
    channels.startSmartReaderGeminiNarration,
    (event, request: unknown) => {
      if (!tabManager) throw new Error("The browser window is unavailable.");
      return tabManager.startSmartReaderGeminiNarration(event.sender, request);
    },
  );
  ipcMain.handle(
    channels.getSmartReaderGeminiSegment,
    (event, sessionId: unknown, index: unknown) => {
      if (!tabManager) throw new Error("The browser window is unavailable.");
      return tabManager.getSmartReaderGeminiSegment(
        event.sender,
        sessionId,
        index,
      );
    },
  );
  ipcMain.handle(
    channels.cancelSmartReaderGeminiNarration,
    (event, sessionId: unknown) => {
      if (!tabManager) throw new Error("The browser window is unavailable.");
      tabManager.cancelSmartReaderGeminiNarration(event.sender, sessionId);
    },
  );
  ipcMain.handle(channels.getSmartReaderSummary, (event) => {
    if (!tabManager) throw new Error("The browser window is unavailable.");
    return tabManager.getSmartReaderSummary(event.sender);
  });
  ipcMain.handle(
    channels.refreshSmartReaderSummaryModels,
    (event, provider: unknown) => {
      if (!tabManager) throw new Error("The browser window is unavailable.");
      return tabManager.refreshSmartReaderSummaryModels(event.sender, provider);
    },
  );
  ipcMain.handle(
    channels.setSmartReaderSummaryPreference,
    (event, request: unknown) => {
      if (!tabManager) throw new Error("The browser window is unavailable.");
      return tabManager.setSmartReaderSummaryPreference(event.sender, request);
    },
  );
  ipcMain.handle(
    channels.setSmartReaderSummaryConsent,
    (event, granted: unknown) => {
      if (!tabManager) throw new Error("The browser window is unavailable.");
      return tabManager.setSmartReaderSummaryConsent(event.sender, granted);
    },
  );
  ipcMain.handle(
    channels.generateSmartReaderSummary,
    (event, request: unknown) => {
      if (!tabManager) throw new Error("The browser window is unavailable.");
      return tabManager.generateSmartReaderSummary(event.sender, request);
    },
  );
  ipcMain.handle(channels.cancelSmartReaderSummary, (event) => {
    if (!tabManager) throw new Error("The browser window is unavailable.");
    return tabManager.cancelSmartReaderSummary(event.sender);
  });
  ipcMain.handle(channels.dismissSmartReaderSummary, (event) => {
    if (!tabManager) throw new Error("The browser window is unavailable.");
    return tabManager.dismissSmartReaderSummary(event.sender);
  });
  ipcMain.handle(channels.copySmartReaderSummary, async (event) => {
    if (!tabManager) throw new Error("The browser window is unavailable.");
    await tabManager.copySmartReaderSummary(event.sender);
  });
  ipcMain.handle(channels.openSmartReaderSummarySettings, (event) => {
    if (!tabManager) throw new Error("The browser window is unavailable.");
    tabManager.getSmartReaderSummary(event.sender);
    if (shellView && !shellView.webContents.isDestroyed()) {
      shellView.webContents.send(channels.showScoutSettings);
    }
  });
  ipcMain.handle(channels.duplicateTab, async (event, tabId: unknown) =>
    requireManager(event).duplicateTab(requireString(tabId, "tabId", 128)),
  );
  ipcMain.handle(channels.reopenClosedTab, (event, id: unknown) =>
    requireManager(event).reopenClosedTab(
      id === undefined ? undefined : requireString(id, "id", 128),
    ),
  );
  ipcMain.handle(
    channels.createTabGroup,
    (event, tabIds: unknown, name: unknown, color: unknown) =>
      requireManager(event).createTabGroup(
        requireTabIds(tabIds),
        name === undefined ? undefined : requireString(name, "name", 128),
        color === undefined ? undefined : requireTabGroupColor(color),
      ),
  );
  ipcMain.handle(
    channels.updateTabGroup,
    (event, groupId: unknown, update: unknown) =>
      requireManager(event).updateTabGroup(
        requireString(groupId, "groupId", 128),
        requireTabGroupUpdate(update),
      ),
  );
  ipcMain.handle(
    channels.deleteTabGroup,
    (event, groupId: unknown, closeTabs: unknown) =>
      requireManager(event).deleteTabGroup(
        requireString(groupId, "groupId", 128),
        closeTabs === undefined
          ? false
          : requireBoolean(closeTabs, "closeTabs"),
      ),
  );
  ipcMain.handle(channels.restoreSavedTabGroup, (event, groupId: unknown) =>
    requireManager(event).restoreSavedTabGroup(
      requireString(groupId, "groupId", 128),
    ),
  );
  ipcMain.handle(channels.removeSavedTabGroup, (event, groupId: unknown) =>
    requireManager(event).removeSavedTabGroup(
      requireString(groupId, "groupId", 128),
    ),
  );
  ipcMain.handle(
    channels.selectTabs,
    (event, tabIds: unknown, mode: unknown) => {
      if (!["replace", "add", "toggle", "range"].includes(String(mode)))
        throw new TypeError("Unknown tab selection mode.");
      requireManager(event).selectTabs(
        requireTabIds(tabIds),
        mode as TabSelectionMode,
      );
    },
  );
  ipcMain.handle(
    channels.moveTabs,
    (event, tabIds: unknown, targetIndex: unknown, groupId: unknown) => {
      if (!Number.isSafeInteger(targetIndex))
        throw new TypeError("targetIndex must be an integer.");
      requireManager(event).moveTabs(
        requireTabIds(tabIds),
        targetIndex as number,
        groupId === undefined || groupId === null
          ? (groupId as undefined | null)
          : requireString(groupId, "groupId", 128),
      );
    },
  );
  ipcMain.handle(channels.closeTabs, (event, tabIds: unknown) =>
    requireManager(event).closeTabs(requireTabIds(tabIds)),
  );
  ipcMain.handle(
    channels.setTabsPinned,
    (event, tabIds: unknown, pinned: unknown) =>
      requireManager(event).setTabsPinned(
        requireTabIds(tabIds),
        requireBoolean(pinned, "pinned"),
      ),
  );
  ipcMain.handle(channels.searchTabs, (event, query: unknown) => {
    if (typeof query !== "string" || query.length > 2_048)
      throw new TypeError("query must be a string of at most 2048 characters.");
    return requireManager(event).searchTabs(query);
  });
  ipcMain.handle(channels.reopenClosedWindow, (event, id: unknown) =>
    requireManager(event).reopenClosedWindow(
      id === undefined ? undefined : requireString(id, "id", 128),
    ),
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
  ipcMain.handle(channels.getWebsiteControls, (event) =>
    requireWebsiteControls(event).snapshot(),
  );
  ipcMain.handle(channels.getWebsiteControl, (event, originOrUrl: unknown) =>
    requireWebsiteControls(event).siteSnapshot(
      requireString(originOrUrl, "originOrUrl"),
    ),
  );
  ipcMain.handle(
    channels.setWebsitePermission,
    async (event, originOrUrl: unknown, key: unknown, decision: unknown) => {
      if (!isSitePermissionKey(key))
        throw new TypeError("Unknown website permission.");
      if (!isSitePermissionDecision(decision))
        throw new TypeError("Unknown website permission decision.");
      await requireWebsiteControls(event).setDecision(
        requireString(originOrUrl, "originOrUrl"),
        key,
        decision,
      );
    },
  );
  ipcMain.handle(
    channels.resetWebsitePermissions,
    async (event, originOrUrl: unknown) => {
      await requireWebsiteControls(event).resetSite(
        requireString(originOrUrl, "originOrUrl"),
      );
    },
  );
  ipcMain.handle(
    channels.clearWebsiteData,
    async (event, originOrUrl: unknown) => {
      await requireWebsiteControls(event).clearSiteData(
        requireString(originOrUrl, "originOrUrl"),
      );
    },
  );
  ipcMain.handle(
    channels.setSecureDns,
    async (event, mode: unknown, providerUrl: unknown) => {
      if (!isSecureDnsMode(mode))
        throw new TypeError("Unknown secure DNS mode.");
      if (providerUrl !== undefined && typeof providerUrl !== "string")
        throw new TypeError("Secure DNS provider must be a string.");
      await requireWebsiteControls(event).setSecureDns(mode, providerUrl);
    },
  );
  ipcMain.on(channels.getWebsiteDocumentPolicy, (event) => {
    const controls = websiteControls;
    const frameUrl = event.senderFrame?.url;
    const origin = frameUrl ? canonicalWebOrigin(frameUrl) : null;
    if (
      !controls ||
      !origin ||
      event.sender.session !== session.fromPartition(profilePartition)
    ) {
      event.returnValue = {
        autoplay: "ask",
        javascript: "ask",
        network: "ask",
      };
      return;
    }
    event.returnValue = controls.documentPolicy(origin);
  });
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
    channels.setExtensionToolbarPinned,
    async (event, id: unknown, pinned: unknown) => {
      const service = requireExtensions(event);
      if (typeof pinned !== "boolean") {
        throw new TypeError("pinned must be a boolean.");
      }
      const extensionId = requireString(id, "id", 32);
      const installed = await service.listInstalled();
      if (!installed.some((extension) => extension.id === extensionId)) {
        throw new Error("That extension is not installed.");
      }
      await requireManager(event).setExtensionToolbarPinned(
        extensionId,
        pinned,
      );
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
  ipcMain.handle(
    channels.setToolbarActionPinned,
    async (event, action: unknown, pinned: unknown) => {
      if (typeof pinned !== "boolean") {
        throw new TypeError("pinned must be a boolean.");
      }
      if (
        action !== "bookmark" &&
        action !== "find" &&
        action !== "hyperdrive" &&
        action !== "ublock"
      ) {
        throw new TypeError("Unknown toolbar action.");
      }
      await requireManager(event).setToolbarActionPinned(action, pinned);
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
  ipcMain.handle(
    channels.getOfflinePages,
    (event) => requireOfflinePages(event).snapshot,
  );
  ipcMain.handle(channels.savePageForOffline, async (event, tabId: unknown) => {
    const manager = requireManager(event);
    const library = requireOfflinePages(event);
    const capture = manager.createOfflinePageCapture(
      requireString(tabId, "tabId", 128),
    );
    return library.savePage(capture);
  });
  ipcMain.handle(
    channels.openOfflinePages,
    (event, entryId: unknown, forceNew: unknown) => {
      requireOfflinePages(event);
      const cleanId =
        entryId === undefined || entryId === null
          ? undefined
          : requireString(entryId, "entryId", 128);
      if (forceNew !== undefined && typeof forceNew !== "boolean") {
        throw new TypeError("forceNew must be a boolean.");
      }
      return requireManager(event).openOfflinePages(cleanId, forceNew === true);
    },
  );
  ipcMain.handle(channels.openOfflinePage, (event, id: unknown) => {
    const cleanId = requireString(id, "id", 128);
    const item = requireOfflinePages(event).snapshot.items.find(
      (candidate) => candidate.id === cleanId,
    );
    if (!item?.available) throw new Error("The offline page is unavailable.");
    return requireManager(event).openOfflinePage(cleanId);
  });
  ipcMain.handle(channels.deleteOfflinePage, async (event, id: unknown) => {
    const library = requireOfflinePages(event);
    const cleanId = requireString(id, "id", 128);
    const item = library.snapshot.items.find(
      (candidate) => candidate.id === cleanId,
    );
    if (!item) throw new Error("Unknown offline page.");
    await library.remove(cleanId);
  });
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
  const updateRestoreMarker = path.join(
    app.getPath("userData"),
    "restore-session-after-update",
  );
  const restoreSessionAfterUpdate =
    await prepareUpdateSessionRecovery(updateRestoreMarker);
  const browserSession = session.fromPartition(profilePartition);
  const controls = new WebsiteControlsService(browserSession, {
    filePath: path.join(app.getPath("userData"), "website-controls.json"),
    prompt: promptForManagedWebsitePermission,
    applySecureDns,
    onChanged: sendWebsiteControls,
    onHyperdriveDecisionChanged: syncHyperdriveSiteDecision,
  });
  await controls.initialize();
  websiteControls = controls;
  browserSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) => {
      if (permission === "fullscreen") {
        return Boolean(
          contents &&
          tabManager?.canGrantWebsiteFullscreen(contents, permission),
        );
      }
      const managed = controls.checkPermission(
        contents,
        permission,
        requestingOrigin,
        details,
      );
      if (managed !== null) return managed;
      return Boolean(
        contents &&
        websitePermissionController?.check(
          contents,
          permission,
          requestingOrigin,
        ),
      );
    },
  );
  browserSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      if (permission === "fullscreen") {
        callback(
          Boolean(tabManager?.canGrantWebsiteFullscreen(contents, permission)),
        );
        return;
      }
      void controls.requestPermission(contents, permission, details).then(
        (managed) => {
          if (managed !== null) {
            callback(managed);
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
        () => callback(false),
      );
    },
  );
  browserSession.setSpellCheckerEnabled(false);
  browserSession.setUserAgent(
    browserSession.getUserAgent().replace(/\sElectron\/[^\s]+/, ""),
  );
  registerInternalProtocol(browserSession);
  const smartReaderDocuments = new SmartReaderDocumentStore();
  registerSmartReaderProtocol(browserSession, smartReaderDocuments);

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
  const updateStateStore = new UpdateStateStore(
    path.join(app.getPath("userData"), "update-state.json"),
  );
  const updateState = await updateStateStore.load();
  const installedApplicationVersion = app.getVersion();
  const reconciledHistory = updateState.history.map((entry) =>
    entry.result === "ready" && entry.toVersion === installedApplicationVersion
      ? { ...entry, result: "installed" as const }
      : entry,
  );
  if (
    reconciledHistory.some(
      (entry, index) => entry.result !== updateState.history[index]?.result,
    )
  ) {
    updateState.history = reconciledHistory;
    await updateStateStore.save(updateState);
  }
  const installedExtensions = extensionService
    ? await extensionService.listInstalled()
    : [];
  const defaultUpdateFeedUrl = `https://update.electronjs.org/andomatthew1234/Chromecraft/${process.platform}-${process.arch}/${app.getVersion()}`;
  updateManager = new UpdateManager({
    adapter: new ElectronUpdateAdapter({
      isPackaged: app.isPackaged,
      platform: process.platform,
      executablePath: process.execPath,
      feedUrl: CHROMECRAFT_UPDATE_FEED_URL || defaultUpdateFeedUrl,
      releaseApiUrl:
        "https://api.github.com/repos/andomatthew1234/Chromecraft/releases/latest",
    }),
    extensions: {
      checkAndInstallUpdates: (report, extensionIds) =>
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
          }, extensionIds);
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
      {
        id: "deno",
        label: "Deno",
        version: mediaToolsManifest.denoVersion,
      },
    ],
    installedExtensions,
    persistentState: updateState,
    automaticEligible: app.isPackaged && !smokeUserData,
    emit: sendUpdateSnapshot,
    persist: (state) => updateStateStore.save(state),
    prepareForRestart: prepareForUpdateRestart,
    notifyUpdateReady: (release) => {
      if (!Notification.isSupported()) return;
      new Notification({
        title: "Chromecraft update ready",
        body: `Version ${release.version} is ready. Restart from Chromecraft Updates when convenient.`,
        silent: true,
      }).show();
    },
  });
  updateManager.startAutomaticChecks();

  const preferences = new PreferencesStore(
    path.join(app.getPath("userData"), "preferences.json"),
  );
  await preferences.load();
  if (forceOnboarding) {
    if (preferences.snapshot.onboardingComplete) {
      await preferences.setOnboardingComplete(false);
    }
  } else if (smokeUserData && !preferences.snapshot.onboardingComplete) {
    await preferences.setOnboardingComplete(true);
  }
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
  const readingPositions = new ReadingPositionStore(
    path.join(app.getPath("userData"), "smart-reader-positions.json"),
  );
  await readingPositions.load();
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
    icon: chromecraftIconPath(),
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
    shouldAllowDownload: (initiatorOrigin) => {
      try {
        return controls.shouldAllowDownload(initiatorOrigin);
      } catch {
        return true;
      }
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

  const offlinePages = new OfflinePageStore({
    directory: path.join(app.getPath("userData"), "offline-pages"),
    onChange: sendOfflinePagesSnapshot,
  });
  await offlinePages.initialize();
  offlinePageStore = offlinePages;
  const resolveOfflinePageResource = (id: string, relativePath: string) =>
    offlinePages.resolveResource(id, relativePath);
  registerOfflinePageProtocol(
    view.webContents.session,
    resolveOfflinePageResource,
  );
  registerOfflinePageProtocol(browserSession, resolveOfflinePageResource);

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

  const metrics = new AppMetricsCollector();
  appMetricsCollector = metrics;
  const performanceCentre = new PerformanceCentreController({
    iconPath: chromecraftIconPath(),
    preloadPath: path.join(__dirname, "performance-centre-preload.cjs"),
    stateFilePath: path.join(
      app.getPath("userData"),
      "performance-centre-window.json",
    ),
    developmentUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
    packagedHtmlPath: path.join(
      __dirname,
      `../renderer/${MAIN_WINDOW_VITE_NAME}/performance-centre.html`,
    ),
    metrics,
    manager: () => tabManager,
  });
  performanceCentreController?.dispose();
  performanceCentreController = performanceCentre;

  const manager = new TabManager(
    window,
    view,
    browserSession,
    ublock,
    extensionService,
    preferences,
    data,
    readingPositions,
    hyperdrive,
    smartReaderDocuments,
    sendBrowserData,
    () => void sendExtensionsSnapshot(),
    (input) => actionHost.handleCommandInput(input),
    (contents) => {
      websitePermissionController?.revoke(contents);
      controls.revoke(contents);
    },
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
    (openerUrl) => {
      try {
        return controls.shouldAllowPopup(openerUrl);
      } catch {
        return true;
      }
    },
    () => void performanceCentre.openOrFocus(),
    () => metrics.memoryByProcessId(),
    {
      configuration: () => {
        if (!aiToolsController) throw new Error("Scout is unavailable.");
        return aiToolsController.getSmartReaderSummaryConfiguration();
      },
      refresh: async (provider) => {
        if (!aiToolsController) throw new Error("Scout is unavailable.");
        await aiToolsController.refreshModels(provider);
      },
      setPreference: async (provider, model) => {
        if (!aiToolsController) throw new Error("Scout is unavailable.");
        await aiToolsController.setSmartReaderSummaryPreference(
          provider,
          model,
        );
      },
      setConsent: async (granted) => {
        if (!aiToolsController) throw new Error("Scout is unavailable.");
        await aiToolsController.setSmartReaderSummaryConsent(granted);
      },
      generate: (requestId, article, request) => {
        if (!aiToolsController) throw new Error("Scout is unavailable.");
        return aiToolsController.summarizeSmartReaderArticle(
          requestId,
          article,
          request.provider,
          request.model,
          request.cloudConsent,
        );
      },
      cancel: (requestId) =>
        aiToolsController?.cancelSmartReaderSummary(requestId),
    },
    {
      capabilities: () => {
        if (!aiToolsController) throw new Error("Scout is unavailable.");
        return aiToolsController.getSmartReaderNarrationCapabilities();
      },
      synthesize: (requestId, text, voice) => {
        if (!aiToolsController) throw new Error("Scout is unavailable.");
        return aiToolsController.synthesizeSmartReaderSpeech(
          requestId,
          text,
          voice,
        );
      },
      cancel: (requestId) =>
        aiToolsController?.cancelSmartReaderSpeech(requestId),
    },
    restoreSessionAfterUpdate,
  );
  tabManager = manager;
  const organiseTabs = new OrganiseTabsTool(manager);
  await scoutAgentController?.dispose();
  scoutAgentController = null;
  aiToolsController?.dispose();
  const ollama = new OllamaClient();
  const credentials = new GeminiCredentialStore(
    path.join(app.getPath("userData"), "gemini-api-key.bin"),
  );
  const aiTools = new AiToolsController({
    stateFilePath: path.join(app.getPath("userData"), "ai-tools.json"),
    ollama,
    credentials,
    organiseTabs,
    onChange: sendAiToolsSnapshot,
  });
  aiToolsController = aiTools;
  await aiTools.initialize();
  onboardingGeminiController?.dispose();
  const onboardingGemini = new OnboardingGeminiController(
    window,
    browserSession,
    {
      readClipboardText: () => clipboard.readText(),
      openExternal: (url) => shell.openExternal(url),
      commitKey: (apiKey, persist) =>
        aiTools.setGeminiApiKey({ apiKey, persist }),
      emit: sendOnboardingGeminiClipboard,
    },
  );
  onboardingGeminiController = onboardingGemini;
  const scoutAgent = new ScoutAgentController({
    settingsFilePath: path.join(
      app.getPath("userData"),
      "scout-agent-settings.json",
    ),
    runStorePath: path.join(app.getPath("userData"), "scout-agent-runs.json"),
    models: new ScoutAgentModelResolver(aiTools, ollama, credentials),
    browser: manager,
    onChange: sendScoutAgentSnapshot,
  });
  scoutAgentController = scoutAgent;
  await scoutAgent.initialize();
  websitePermissionController = new WebsitePermissionController({
    contextFor: (contents) =>
      manager.getActiveWebsitePermissionContext(contents),
    prompt: (request) => promptForWebsitePermission(request),
  });
  for (const site of (await controls.snapshot()).sites) {
    if (site.decisions.hyperdrive === "block") {
      await syncHyperdriveSiteDecision(site.origin, "block");
    }
  }
  actionHost.attachTabs(manager);
  registerIpc();
  await manager.initialize();
  if (restoreSessionAfterUpdate) {
    await fs.rm(updateRestoreMarker, { force: true });
  }

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
      onboardingGemini.dispose();
      performanceCentre.dispose();
      aiTools.dispose();
      void scoutAgent.dispose();
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
      manager.flushWindowStateForClose(),
      smartDownloads.dispose(),
      youtubeDownloads.dispose(),
      downloads.dispose(),
      scoutAgent.dispose(),
    ]).finally(() => {
      closingApproved = true;
      window.close();
    });
  });
  window.on("closed", () => {
    actionHost.dispose();
    onboardingGemini.dispose();
    if (extensionWebRequestHost === actionHost) extensionWebRequestHost = null;
    extensions.dispose();
    updateManager?.dispose();
    nativeTheme.removeListener("updated", syncWindowChromeTheme);
    if (mainWindow === window) {
      mainWindow = null;
      shellView = null;
      tabManager = null;
      if (performanceCentreController === performanceCentre) {
        performanceCentreController = null;
      }
      if (appMetricsCollector === metrics) appMetricsCollector = null;
      extensionService = null;
      browserData = null;
      downloadManager = null;
      searchSuggestionService = null;
      hyperdriveController = null;
      updateManager = null;
      websitePermissionController?.clear();
      websitePermissionController = null;
      websiteControls = null;
      youtubeDownloadService = null;
      galleryStore = null;
      offlinePageStore = null;
      smartDownloadsService = null;
      aiTools.dispose();
      if (aiToolsController === aiTools) aiToolsController = null;
      if (onboardingGeminiController === onboardingGemini) {
        onboardingGeminiController = null;
      }
      void scoutAgent.dispose();
      if (scoutAgentController === scoutAgent) scoutAgentController = null;
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
