import {
  ipcMain,
  type Extension,
  type ServiceWorkerMain,
  type Session,
} from "electron";
import {
  EXTENSION_NETWORK_OBSERVER_ID,
  EXTENSION_NETWORK_OBSERVER_ORIGIN,
  extensionHostChannels,
  type ExtensionHostMessage,
  type ExtensionWebRequestEventDetails,
  type ExtensionWebRequestFilter,
  type ExtensionWorkerMessage,
} from "../shared/extension-host-protocol";

const EXTENSION_SCOPE = /^chrome-extension:\/\/([a-p]{32})\/$/u;
const MAX_FILTERS = 64;
const MAX_PATTERNS_PER_FILTER = 128;
const MAX_PATTERN_LENGTH = 2_048;

interface ExtensionSubscription {
  scope: string;
  filters: ExtensionWebRequestFilter[];
}

interface BoundWorker {
  worker: ServiceWorkerMain;
  listener: (
    event: Electron.IpcMainServiceWorkerEvent,
    message: unknown,
  ) => void;
}

export interface ExtensionWebRequestHostOptions {
  serviceWorkerPreloadPath: string;
  observerPreloadPath: string;
  observerExtensionPath: string;
  readyTimeoutMs?: number;
  ipc?: ExtensionObserverIpc;
}

interface ExtensionObserverIpc {
  on(
    channel: string,
    listener: (event: Electron.IpcMainEvent, details: unknown) => void,
  ): unknown;
  removeListener(
    channel: string,
    listener: (event: Electron.IpcMainEvent, details: unknown) => void,
  ): unknown;
}

/**
 * Bridges Electron's missing MV3 webRequest event routing into extension workers.
 *
 * The main process authenticates every registration from ServiceWorkerMain.scope,
 * validates declared permissions, receives requests from an internal native MV2
 * observer that composes with uBlock, and wakes suspended workers before delivery.
 * The worker never supplies its identity.
 */
export class ExtensionWebRequestHost {
  private readonly subscriptions = new Map<string, ExtensionSubscription>();
  private readonly boundWorkers = new Map<number, BoundWorker>();
  private readonly ipc: ExtensionObserverIpc;
  private readonly preloadRegistrationIds: string[] = [];
  private observerExtension: Extension | null = null;
  private started = false;

  private readonly onWorkerStatusChanged = (
    details: Electron.Event<Electron.ServiceWorkersRunningStatusChangedEventParams>,
  ): void => {
    if (details.runningStatus === "running") {
      this.bindWorker(details.versionId);
      return;
    }
    if (details.runningStatus === "stopped")
      this.unbindWorker(details.versionId);
  };

  private readonly onExtensionUnloaded = (
    _event: Electron.Event,
    extension: Extension,
  ): void => {
    this.subscriptions.delete(extension.id);
  };

  private readonly onObserverRequest = (
    event: Electron.IpcMainEvent,
    rawDetails: unknown,
  ): void => {
    if (event.sender.session !== this.browserSession) return;
    const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
    if (!senderUrl.startsWith(`${EXTENSION_NETWORK_OBSERVER_ORIGIN}/`)) return;
    if (
      this.browserSession.extensions.getExtension(EXTENSION_NETWORK_OBSERVER_ID)
        ?.id !== EXTENSION_NETWORK_OBSERVER_ID
    ) {
      return;
    }
    const eventDetails = parseObservedRequest(rawDetails);
    if (!eventDetails) return;
    this.dispatchRequest(eventDetails);
  };

  private dispatchRequest(eventDetails: ExtensionWebRequestEventDetails): void {
    for (const [extensionId, subscription] of this.subscriptions) {
      const extension =
        this.browserSession.extensions.getExtension(extensionId);
      if (
        !extension ||
        !canObserveRequest(extension, eventDetails.url) ||
        !subscription.filters.some((filter) =>
          matchesWebRequestFilter(filter, eventDetails),
        )
      ) {
        continue;
      }
      void this.deliver(extensionId, subscription.scope, {
        type: "webRequest-event",
        eventName: "onBeforeRequest",
        details: eventDetails,
      });
    }
  }

  constructor(
    private readonly browserSession: Session,
    private readonly options: ExtensionWebRequestHostOptions,
  ) {
    this.ipc = options.ipc ?? ipcMain;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.preloadRegistrationIds.push(
      this.browserSession.registerPreloadScript({
        type: "service-worker",
        filePath: this.options.serviceWorkerPreloadPath,
      }),
      this.browserSession.registerPreloadScript({
        type: "frame",
        filePath: this.options.observerPreloadPath,
      }),
    );
    this.browserSession.serviceWorkers.on(
      "running-status-changed",
      this.onWorkerStatusChanged,
    );
    this.browserSession.extensions.on(
      "extension-unloaded",
      this.onExtensionUnloaded,
    );
    this.ipc.on(extensionHostChannels.observerRequest, this.onObserverRequest);
    for (const versionId of Object.keys(
      this.browserSession.serviceWorkers.getAllRunning(),
    )) {
      this.bindWorker(Number(versionId));
    }
    try {
      this.observerExtension = await this.loadObserverExtension();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    if (!this.started) return;
    this.browserSession.serviceWorkers.removeListener(
      "running-status-changed",
      this.onWorkerStatusChanged,
    );
    this.browserSession.extensions.removeListener(
      "extension-unloaded",
      this.onExtensionUnloaded,
    );
    this.ipc.removeListener(
      extensionHostChannels.observerRequest,
      this.onObserverRequest,
    );
    for (const versionId of [...this.boundWorkers.keys()])
      this.unbindWorker(versionId);
    for (const registrationId of this.preloadRegistrationIds.splice(0)) {
      this.browserSession.unregisterPreloadScript(registrationId);
    }
    if (this.observerExtension) {
      void this.browserSession.extensions.removeExtension(
        this.observerExtension.id,
      );
      this.observerExtension = null;
    }
    this.subscriptions.clear();
    this.started = false;
  }

  private async loadObserverExtension(): Promise<Extension> {
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveReady!: (extension: Extension) => void;
    const ready = new Promise<Extension>((resolve) => {
      resolveReady = resolve;
    });
    const onReady = (_event: Electron.Event, extension: Extension) => {
      if (extension.id === EXTENSION_NETWORK_OBSERVER_ID)
        resolveReady(extension);
    };
    this.browserSession.extensions.on("extension-ready", onReady);
    try {
      const loaded = await this.browserSession.extensions.loadExtension(
        this.options.observerExtensionPath,
        { allowFileAccess: false },
      );
      if (loaded.id !== EXTENSION_NETWORK_OBSERVER_ID) {
        await this.browserSession.extensions.removeExtension(loaded.id);
        throw new Error("The internal network observer has an unexpected id.");
      }
      return await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          readyTimer = setTimeout(
            () =>
              reject(
                new Error(
                  "The internal extension network observer did not become ready.",
                ),
              ),
            Math.max(1, this.options.readyTimeoutMs ?? 15_000),
          );
        }),
      ]);
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
      this.browserSession.extensions.removeListener("extension-ready", onReady);
    }
  }

  private bindWorker(versionId: number): void {
    if (!Number.isSafeInteger(versionId) || this.boundWorkers.has(versionId))
      return;
    const worker =
      this.browserSession.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || extensionIdFromScope(worker.scope) === null) return;
    const listener = (
      event: Electron.IpcMainServiceWorkerEvent,
      message: unknown,
    ) => this.receiveWorkerMessage(event.serviceWorker, message);
    worker.ipc.on(extensionHostChannels.workerMessage, listener);
    this.boundWorkers.set(versionId, { worker, listener });
    worker.send(extensionHostChannels.workerReady);
  }

  private unbindWorker(versionId: number): void {
    const bound = this.boundWorkers.get(versionId);
    if (!bound) return;
    bound.worker.ipc.removeListener(
      extensionHostChannels.workerMessage,
      bound.listener,
    );
    this.boundWorkers.delete(versionId);
  }

  private receiveWorkerMessage(
    worker: ServiceWorkerMain,
    rawMessage: unknown,
  ): void {
    const extensionId = extensionIdFromScope(worker.scope);
    if (!extensionId) return;
    const extension = this.browserSession.extensions.getExtension(extensionId);
    if (!extension || !isManifestV3(extension)) return;
    const message = parseWorkerMessage(rawMessage);
    if (!message) return;
    if (message.type === "worker-ready") {
      worker.send(extensionHostChannels.workerReady);
      return;
    }
    if (!hasPermission(extension, "webRequest")) return;
    this.subscriptions.set(extensionId, {
      scope: worker.scope,
      filters: message.filters,
    });
  }

  private async deliver(
    extensionId: string,
    scope: string,
    message: ExtensionHostMessage,
  ): Promise<void> {
    if (!this.browserSession.extensions.getExtension(extensionId)) return;
    try {
      const worker =
        await this.browserSession.serviceWorkers.startWorkerForScope(scope);
      if (extensionIdFromScope(worker.scope) !== extensionId) return;
      worker.send(extensionHostChannels.hostMessage, message);
    } catch (error) {
      console.warn(
        `Could not deliver an extension host event to ${extensionId}.`,
        error,
      );
    }
  }
}

export function extensionIdFromScope(scope: string): string | null {
  return EXTENSION_SCOPE.exec(scope)?.[1] ?? null;
}

function parseWorkerMessage(raw: unknown): ExtensionWorkerMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const type = (raw as { type?: unknown }).type;
  if (type === "worker-ready") return { type };
  if (type !== "webRequest-subscriptions") return null;
  const eventName = (raw as { eventName?: unknown }).eventName;
  const rawFilters = (raw as { filters?: unknown }).filters;
  if (eventName !== "onBeforeRequest" || !Array.isArray(rawFilters))
    return null;
  const filters = rawFilters
    .slice(0, MAX_FILTERS)
    .map(parseFilter)
    .filter((filter): filter is ExtensionWebRequestFilter => filter !== null);
  return { type, eventName, filters };
}

function parseFilter(raw: unknown): ExtensionWebRequestFilter | null {
  if (!raw || typeof raw !== "object") return null;
  const urls = (raw as { urls?: unknown }).urls;
  if (!Array.isArray(urls) || urls.length === 0) return null;
  const validUrls = urls
    .slice(0, MAX_PATTERNS_PER_FILTER)
    .filter(
      (value): value is string =>
        typeof value === "string" &&
        value.length <= MAX_PATTERN_LENGTH &&
        isSupportedMatchPattern(value),
    );
  if (validUrls.length === 0) return null;
  const types = (raw as { types?: unknown }).types;
  return {
    urls: validUrls,
    ...(Array.isArray(types)
      ? {
          types: types
            .slice(0, 32)
            .filter(
              (value): value is string =>
                typeof value === "string" && value.length <= 64,
            ),
        }
      : {}),
    ...(Number.isSafeInteger((raw as { tabId?: unknown }).tabId)
      ? { tabId: (raw as { tabId: number }).tabId }
      : {}),
    ...(Number.isSafeInteger((raw as { windowId?: unknown }).windowId)
      ? { windowId: (raw as { windowId: number }).windowId }
      : {}),
  };
}

function isManifestV3(extension: Extension): boolean {
  return extension.manifest?.manifest_version === 3;
}

function manifestStrings(extension: Extension, key: string): string[] {
  const value = extension.manifest?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function hasPermission(extension: Extension, permission: string): boolean {
  return manifestStrings(extension, "permissions").includes(permission);
}

function canObserveRequest(extension: Extension, url: string): boolean {
  if (!hasPermission(extension, "webRequest")) return false;
  const hostPermissions = [
    ...manifestStrings(extension, "host_permissions"),
    ...manifestStrings(extension, "permissions").filter(
      (value) => value === "<all_urls>" || value.includes("://"),
    ),
  ];
  return hostPermissions.some((pattern) =>
    matchesExtensionUrlPattern(pattern, url),
  );
}

function parseObservedRequest(
  raw: unknown,
): ExtensionWebRequestEventDetails | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (
    (typeof value.requestId !== "string" &&
      typeof value.requestId !== "number") ||
    typeof value.url !== "string" ||
    value.url.length > 65_536 ||
    typeof value.method !== "string" ||
    value.method.length > 32 ||
    typeof value.type !== "string" ||
    value.type.length > 64 ||
    typeof value.timeStamp !== "number" ||
    !Number.isFinite(value.timeStamp)
  ) {
    return null;
  }
  try {
    new URL(value.url);
  } catch {
    return null;
  }
  return {
    requestId: String(value.requestId).slice(0, 256),
    url: value.url,
    method: value.method,
    frameId: Number.isSafeInteger(value.frameId)
      ? (value.frameId as number)
      : -1,
    parentFrameId: Number.isSafeInteger(value.parentFrameId)
      ? (value.parentFrameId as number)
      : -1,
    tabId: Number.isSafeInteger(value.tabId) ? (value.tabId as number) : -1,
    type: value.type,
    timeStamp: value.timeStamp,
    ...(typeof value.initiator === "string" && value.initiator.length <= 2_048
      ? { initiator: value.initiator }
      : {}),
  };
}

export function matchesWebRequestFilter(
  filter: ExtensionWebRequestFilter,
  details: ExtensionWebRequestEventDetails,
): boolean {
  if (
    !filter.urls.some((pattern) =>
      matchesExtensionUrlPattern(pattern, details.url),
    )
  )
    return false;
  if (
    filter.types &&
    filter.types.length > 0 &&
    !filter.types.includes(details.type)
  )
    return false;
  if (filter.tabId !== undefined && filter.tabId !== details.tabId)
    return false;
  // Chromecraft currently has one ordinary browser window. WINDOW_ID_NONE and
  // extension popup windows are not represented by network request details.
  if (filter.windowId !== undefined && filter.windowId < 0) return false;
  return true;
}

export function matchesExtensionUrlPattern(
  pattern: string,
  candidate: string,
): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (pattern === "<all_urls>") {
    return ["http:", "https:", "ws:", "wss:", "ftp:", "file:"].includes(
      url.protocol,
    );
  }
  const match = /^(\*|http|https|ws|wss|ftp|file):\/\/([^/]*)(\/.*)$/u.exec(
    pattern,
  );
  if (!match) return false;
  const [, scheme, hostPattern, pathPattern] = match;
  if (scheme === "*") {
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  } else if (url.protocol !== `${scheme}:`) {
    return false;
  }
  if (scheme !== "file") {
    const host = url.hostname.toLowerCase();
    const expected = hostPattern.toLowerCase();
    if (
      expected !== "*" &&
      !(expected.startsWith("*.")
        ? host === expected.slice(2) || host.endsWith(expected.slice(1))
        : host === expected)
    ) {
      return false;
    }
  }
  return wildcardPathMatches(pathPattern, `${url.pathname}${url.search}`);
}

function isSupportedMatchPattern(pattern: string): boolean {
  return (
    pattern === "<all_urls>" ||
    /^(\*|http|https|ws|wss|ftp|file):\/\/[^/]*(\/.*)$/u.test(pattern)
  );
}

function wildcardPathMatches(pattern: string, candidate: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "u").test(candidate);
}
