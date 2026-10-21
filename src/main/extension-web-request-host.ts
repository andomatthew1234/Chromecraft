import { promises as fs } from "node:fs";
import path from "node:path";

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
  type ExtensionActionCommandMessage,
  type ExtensionTabsEventMessage,
  type ExtensionTabsEventName,
  type ExtensionWebRequestEventDetails,
  type ExtensionWebRequestFilter,
  type ExtensionWorkerMessage,
} from "../shared/extension-host-protocol";
import {
  ExtensionActionHost,
  type ResolvedExtensionAction,
} from "./extension-action-host";
import type {
  ExtensionTabSnapshot,
  ExtensionTabTransition,
} from "./tab-manager";

const EXTENSION_SCOPE = /^chrome-extension:\/\/([a-p]{32})\/$/u;
const MAX_FILTERS = 64;
const MAX_PATTERNS_PER_FILTER = 128;
const MAX_PATTERN_LENGTH = 2_048;

interface ExtensionSubscription {
  scope: string;
  filters: ExtensionWebRequestFilter[];
}

interface ExtensionTabsSubscription {
  scope: string;
  events: Set<ExtensionTabsEventName>;
}

export interface ExtensionTabsSource {
  readonly extensionTabSnapshots: ExtensionTabSnapshot[];
  getExtensionTab(extensionTabId: number): ExtensionTabSnapshot | null;
  subscribeExtensionTabTransitions(
    listener: (transition: ExtensionTabTransition) => void,
  ): () => void;
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
  framePreloadPath: string;
  observerExtensionPath: string;
  readyTimeoutMs?: number;
  ipc?: ExtensionObserverIpc;
  onActionChanged?: (extensionId: string) => void;
  openActionPopup?: (
    extensionId: string,
    popupUrl: string,
    tabId: number | null,
  ) => Promise<void>;
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
  private readonly tabsSubscriptions = new Map<
    string,
    ExtensionTabsSubscription
  >();
  private readonly deliveryQueues = new Map<string, Promise<void>>();
  private readonly boundWorkers = new Map<number, BoundWorker>();
  private readonly ipc: ExtensionObserverIpc;
  private readonly preloadRegistrationIds: string[] = [];
  private readonly actions: ExtensionActionHost;
  private observerExtension: Extension | null = null;
  private tabsSource: ExtensionTabsSource | null = null;
  private unsubscribeTabs: (() => void) | null = null;
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
    this.tabsSubscriptions.delete(extension.id);
    this.actions.unregister(extension.id);
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

  private readonly onFrameMessage = (
    event: Electron.IpcMainEvent,
    rawMessage: unknown,
  ): void => {
    if (event.sender.session !== this.browserSession || !event.senderFrame)
      return;
    let extensionId: string;
    try {
      const url = new URL(event.senderFrame.url);
      if (
        url.protocol !== "chrome-extension:" ||
        !/^[a-p]{32}$/u.test(url.hostname)
      )
        return;
      extensionId = url.hostname;
    } catch {
      return;
    }
    const extension = this.browserSession.extensions.getExtension(extensionId);
    if (!extension) return;
    const message = parseWorkerMessage(rawMessage);
    if (!message || message.type !== "action-command") return;
    this.registerAction(extension);
    void this.executeActionCommand(extension, message).then((response) => {
      try {
        event.senderFrame?.send(
          extensionHostChannels.frameHostMessage,
          response,
        );
      } catch {
        // The extension frame may have navigated while the command ran.
      }
    });
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
    this.actions = new ExtensionActionHost({
      changed: options.onActionChanged,
      activeTabId: () =>
        this.tabsSource?.extensionTabSnapshots.find((tab) => tab.active)?.id ??
        null,
      openPopup: options.openActionPopup,
      resolveIcon: (extensionId, iconUrl) =>
        this.resolveActionIcon(extensionId, iconUrl),
    });
  }

  resolveAction(
    extensionId: string,
    tabId: number | null = null,
  ): ResolvedExtensionAction | null {
    const extension = this.browserSession.extensions.getExtension(extensionId);
    if (!extension) return null;
    this.registerAction(extension);
    return this.actions.resolve(extensionId, tabId);
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
      this.browserSession.registerPreloadScript({
        type: "frame",
        filePath: this.options.framePreloadPath,
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
    this.ipc.on(extensionHostChannels.frameMessage, this.onFrameMessage);
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

  attachTabs(source: ExtensionTabsSource): void {
    this.unsubscribeTabs?.();
    this.tabsSource = source;
    this.unsubscribeTabs = source.subscribeExtensionTabTransitions(
      (transition) => this.dispatchTabTransition(transition),
    );
    for (const [extensionId, subscription] of this.tabsSubscriptions) {
      const extension =
        this.browserSession.extensions.getExtension(extensionId);
      if (extension)
        this.sendTabsSnapshotToRunning(extension, subscription.scope);
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
    this.ipc.removeListener(
      extensionHostChannels.frameMessage,
      this.onFrameMessage,
    );
    for (const versionId of [...this.boundWorkers.keys()])
      this.unbindWorker(versionId);
    this.unsubscribeTabs?.();
    this.unsubscribeTabs = null;
    this.tabsSource = null;
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
    this.tabsSubscriptions.clear();
    this.deliveryQueues.clear();
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
    ) => void this.receiveWorkerMessage(event.serviceWorker, message);
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

  private async receiveWorkerMessage(
    worker: ServiceWorkerMain,
    rawMessage: unknown,
  ): Promise<void> {
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
    if (message.type === "webRequest-subscriptions") {
      if (!hasPermission(extension, "webRequest")) return;
      this.subscriptions.set(extensionId, {
        scope: worker.scope,
        filters: message.filters,
      });
      return;
    }
    if (message.type === "action-command") {
      this.registerAction(extension);
      const response: ExtensionHostMessage = await this.executeActionCommand(
        extension,
        message,
      );
      try {
        worker.send(extensionHostChannels.hostMessage, response);
      } catch {
        // The worker may stop while the command is executing.
      }
      return;
    }
    this.tabsSubscriptions.set(extensionId, {
      scope: worker.scope,
      events: new Set(message.events),
    });
    this.deliver(extensionId, worker.scope, this.tabsSnapshot(extension));
  }

  private dispatchTabTransition(transition: ExtensionTabTransition): void {
    if (transition.type === "removed") this.actions.removeTab(transition.tabId);
    if (transition.type === "updated" && transition.change.url !== undefined)
      this.actions.navigatedTab(transition.tabId);
    if (transition.type === "activated") {
      for (const extensionId of this.actions.extensionIds)
        this.options.onActionChanged?.(extensionId);
    }
    const index =
      transition.type === "created" || transition.type === "updated"
        ? (this.tabsSource?.extensionTabSnapshots.findIndex(
            (tab) => tab.id === transition.tab.id,
          ) ?? -1)
        : -1;
    const event = tabTransitionMessage(transition, Math.max(0, index));
    if (!event) return;
    for (const [extensionId, subscription] of this.tabsSubscriptions) {
      const extension =
        this.browserSession.extensions.getExtension(extensionId);
      if (!extension) continue;
      // Keep query/get state current for a running worker without waking a
      // sleeping worker that did not subscribe to this event.
      this.sendTabsSnapshotToRunning(extension, subscription.scope);
      if (!subscription.events.has(event.eventName)) continue;
      const sanitized = sanitizeTabsEvent(extension, event);
      void this.deliver(extensionId, subscription.scope, sanitized);
    }
  }

  private registerAction(extension: Extension): void {
    this.actions.register({
      id: extension.id,
      name: extension.name,
      baseUrl: extension.url,
      manifest: extension.manifest as Record<string, unknown>,
    });
  }

  private async resolveActionIcon(
    extensionId: string,
    iconUrl: string,
  ): Promise<string | null> {
    const extension = this.browserSession.extensions.getExtension(extensionId);
    if (!extension) throw new Error("The extension is not loaded.");
    const url = new URL(iconUrl);
    if (url.protocol !== "chrome-extension:" || url.hostname !== extensionId)
      throw new Error("The action icon belongs to another extension.");
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const root = path.resolve(extension.path);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`))
      throw new Error("The action icon path is unsafe.");
    const file = await fs.open(target, "r");
    try {
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > 1024 * 1024)
        throw new Error("The action icon is unavailable or too large.");
      const extensionName = path.extname(target).toLowerCase();
      const mime =
        extensionName === ".png"
          ? "image/png"
          : extensionName === ".jpg" || extensionName === ".jpeg"
            ? "image/jpeg"
            : extensionName === ".gif"
              ? "image/gif"
              : extensionName === ".webp"
                ? "image/webp"
                : extensionName === ".svg"
                  ? "image/svg+xml"
                  : null;
      if (!mime) throw new Error("The action icon format is unsupported.");
      return `data:${mime};base64,${(await file.readFile()).toString("base64")}`;
    } finally {
      await file.close();
    }
  }

  private async executeActionCommand(
    extension: Extension,
    message: ExtensionActionCommandMessage,
  ): Promise<ExtensionHostMessage> {
    const manifest = extension.manifest as Record<string, unknown>;
    const declaredNamespace = manifest.action
      ? "action"
      : manifest.browser_action
        ? "browserAction"
        : manifest.page_action
          ? "pageAction"
          : null;
    if (declaredNamespace !== message.namespace) {
      return {
        type: "action-result",
        requestId: message.requestId,
        ok: false,
        error:
          "The requested action namespace is not declared by the extension.",
      };
    }
    try {
      const value = await this.actions.execute(
        extension.id,
        message.method,
        message.details,
      );
      return {
        type: "action-result",
        requestId: message.requestId,
        ok: true,
        ...(value === undefined ? {} : { value }),
      };
    } catch (error) {
      return {
        type: "action-result",
        requestId: message.requestId,
        ok: false,
        error:
          error instanceof Error ? error.message : "Action command failed.",
      };
    }
  }

  private tabsSnapshot(extension: Extension): ExtensionHostMessage {
    const tabs = this.tabsSource?.extensionTabSnapshots ?? [];
    return {
      type: "tabs-snapshot",
      tabs: tabs.map((tab, index) =>
        sanitizeTabSnapshot(extension, chromeTabSnapshot(tab, index)),
      ),
    };
  }

  private sendTabsSnapshotToRunning(extension: Extension, scope: string): void {
    const bound = [...this.boundWorkers.values()].find(
      ({ worker }) => worker.scope === scope,
    );
    if (!bound) return;
    try {
      bound.worker.send(
        extensionHostChannels.hostMessage,
        this.tabsSnapshot(extension),
      );
    } catch {
      // The worker stopped between the running-status event and this send.
    }
  }

  private deliver(
    extensionId: string,
    scope: string,
    message: ExtensionHostMessage,
  ): void {
    const previous = this.deliveryQueues.get(extensionId) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => this.deliverNow(extensionId, scope, message));
    this.deliveryQueues.set(extensionId, queued);
    void queued.finally(() => {
      if (this.deliveryQueues.get(extensionId) === queued)
        this.deliveryQueues.delete(extensionId);
    });
  }

  private async deliverNow(
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
  if (type === "tabs-subscriptions") {
    const rawEvents = (raw as { events?: unknown }).events;
    if (!Array.isArray(rawEvents)) return null;
    const allowed = new Set<ExtensionTabsEventName>([
      "onCreated",
      "onActivated",
      "onUpdated",
      "onRemoved",
    ]);
    const events = [
      ...new Set(
        rawEvents
          .slice(0, allowed.size)
          .filter(
            (event): event is ExtensionTabsEventName =>
              typeof event === "string" &&
              allowed.has(event as ExtensionTabsEventName),
          ),
      ),
    ];
    return { type, events };
  }
  if (type === "action-command") {
    const value = raw as Record<string, unknown>;
    const requestId = value.requestId;
    const namespace = value.namespace;
    const method = value.method;
    const namespaces = new Set(["action", "browserAction", "pageAction"]);
    const methods = new Set([
      "enable",
      "disable",
      "isEnabled",
      "show",
      "hide",
      "setTitle",
      "getTitle",
      "setPopup",
      "getPopup",
      "setBadgeText",
      "getBadgeText",
      "setBadgeBackgroundColor",
      "getBadgeBackgroundColor",
      "setBadgeTextColor",
      "getBadgeTextColor",
      "setIcon",
      "getUserSettings",
      "openPopup",
    ]);
    if (
      typeof requestId !== "string" ||
      requestId.length < 1 ||
      requestId.length > 128 ||
      typeof namespace !== "string" ||
      !namespaces.has(namespace) ||
      typeof method !== "string" ||
      !methods.has(method)
    )
      return null;
    return {
      type,
      requestId,
      namespace: namespace as ExtensionActionCommandMessage["namespace"],
      method: method as ExtensionActionCommandMessage["method"],
      ...(value.details === undefined ? {} : { details: value.details }),
    };
  }
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

function tabTransitionMessage(
  transition: ExtensionTabTransition,
  index: number,
): ExtensionTabsEventMessage | null {
  switch (transition.type) {
    case "created":
      return {
        type: "tabs-event",
        eventName: "onCreated",
        args: [chromeTabSnapshot(transition.tab, index)],
      };
    case "activated":
      return {
        type: "tabs-event",
        eventName: "onActivated",
        args: [{ tabId: transition.tabId, windowId: 0 }],
      };
    case "updated":
      return {
        type: "tabs-event",
        eventName: "onUpdated",
        args: [
          transition.tabId,
          { ...transition.change },
          chromeTabSnapshot(transition.tab, index),
        ],
      };
    case "removed":
      return {
        type: "tabs-event",
        eventName: "onRemoved",
        args: [transition.tabId, { windowId: 0, isWindowClosing: false }],
      };
  }
}

function chromeTabSnapshot(
  tab: ExtensionTabSnapshot,
  index: number,
): Record<string, unknown> {
  return {
    id: tab.id,
    index,
    windowId: 0,
    active: tab.active,
    highlighted: tab.active,
    selected: tab.active,
    pinned: false,
    incognito: false,
    status: tab.status,
    title: tab.title,
    url: tab.url,
    pendingUrl: tab.status === "loading" ? tab.url : undefined,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
  };
}

function sanitizeTabsEvent(
  extension: Extension,
  event: ExtensionTabsEventMessage,
): ExtensionTabsEventMessage {
  if (event.eventName === "onRemoved" || event.eventName === "onActivated")
    return event;
  const tab = event.eventName === "onCreated" ? event.args[0] : event.args[2];
  if (!tab || typeof tab !== "object") return event;
  const candidate = tab as Record<string, unknown>;
  const redacted = sanitizeTabSnapshot(extension, candidate);
  if (redacted === candidate) return event;
  if (event.eventName === "onCreated") return { ...event, args: [redacted] };
  const change = { ...(event.args[1] as Record<string, unknown>) };
  delete change.url;
  delete change.title;
  return { ...event, args: [event.args[0], change, redacted] };
}

function sanitizeTabSnapshot(
  extension: Extension,
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const url = typeof candidate.url === "string" ? candidate.url : "";
  if (hasPermission(extension, "tabs") || canAccessUrl(extension, url))
    return candidate;
  const redacted = { ...candidate };
  delete redacted.url;
  delete redacted.pendingUrl;
  delete redacted.title;
  return redacted;
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
  return canAccessUrl(extension, url);
}

function canAccessUrl(extension: Extension, url: string): boolean {
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
