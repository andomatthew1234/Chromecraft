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
  type ExtensionActionEventMessage,
  type ExtensionActionNamespace,
  type ExtensionCommandsEventMessage,
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
import {
  ExtensionCommandHost,
  type ExtensionCommandInput,
  type ExtensionCommandInvocation,
} from "./extension-command-host";
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

interface ExtensionActionSubscription {
  scope: string;
  namespaces: Set<ExtensionActionNamespace>;
}

interface ExtensionActionFrameSubscription {
  frame: Electron.WebFrameMain;
  namespaces: Set<ExtensionActionNamespace>;
}

interface ExtensionCommandsSubscription {
  scope: string;
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
  ready: boolean;
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
  private readonly actionSubscriptions = new Map<
    string,
    ExtensionActionSubscription
  >();
  private readonly actionFrameSubscriptions = new Map<
    string,
    Set<ExtensionActionFrameSubscription>
  >();
  private readonly commandsSubscriptions = new Map<
    string,
    ExtensionCommandsSubscription
  >();
  private readonly commandsFrameSubscriptions = new Map<
    string,
    Set<Electron.WebFrameMain>
  >();
  private readonly deliveryQueues = new Map<string, Promise<void>>();
  private readonly boundWorkers = new Map<number, BoundWorker>();
  private readonly workerReadyWaiters = new Map<
    number,
    Set<(ready: boolean) => void>
  >();
  private readonly actionAckWaiters = new Map<
    string,
    (acknowledged: boolean) => void
  >();
  private readonly commandsAckWaiters = new Map<
    string,
    (acknowledged: boolean) => void
  >();
  private readonly ipc: ExtensionObserverIpc;
  private readonly preloadRegistrationIds: string[] = [];
  private readonly actions: ExtensionActionHost;
  private readonly commands = new ExtensionCommandHost(process.platform);
  private observerExtension: Extension | null = null;
  private tabsSource: ExtensionTabsSource | null = null;
  private unsubscribeTabs: (() => void) | null = null;
  private nextActionEventId = 1;
  private nextCommandEventId = 1;
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
    this.actionSubscriptions.delete(extension.id);
    this.actionFrameSubscriptions.delete(extension.id);
    this.commandsSubscriptions.delete(extension.id);
    this.commandsFrameSubscriptions.delete(extension.id);
    this.actions.unregister(extension.id);
    this.commands.unregister(extension.id);
  };

  private readonly onExtensionLoaded = (
    _event: Electron.Event,
    extension: Extension,
  ): void => {
    this.registerCommands(extension);
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
    if (!message) return;
    if (message.type === "action-event-ack") {
      this.resolveActionAck(message.eventId, true);
      return;
    }
    if (message.type === "commands-event-ack") {
      this.resolveCommandsAck(message.eventId, true);
      return;
    }
    if (message.type === "commands-subscriptions") {
      this.registerCommands(extension);
      this.registerFrameCommandsSubscription(
        extension,
        event.senderFrame,
        message.listening,
      );
      return;
    }
    if (message.type === "commands-get-all") {
      this.registerCommands(extension);
      event.senderFrame.send(extensionHostChannels.frameHostMessage, {
        type: "commands-result",
        requestId: message.requestId,
        commands: this.commands.getAll(extension.id),
      });
      return;
    }
    this.registerAction(extension);
    if (message.type === "action-subscriptions") {
      this.registerFrameActionSubscriptions(
        extension,
        event.senderFrame,
        message.namespaces,
      );
      return;
    }
    if (message.type !== "action-command") return;
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

  async invokeActionFromToolbar(
    extensionId: string,
    tabId: number | null,
  ): Promise<{ kind: "popup"; popupUrl: string } | { kind: "clicked" }> {
    const extension = this.browserSession.extensions.getExtension(extensionId);
    if (!extension) throw new Error("The extension is not loaded.");
    this.registerAction(extension);
    if (tabId === null) {
      const action = this.actions.resolve(extensionId, null);
      if (!action?.enabled || !action.visible)
        throw new Error("The extension action is disabled or hidden.");
      if (!action.popupUrl)
        throw new Error("A popup-less action requires an active website tab.");
      return { kind: "popup", popupUrl: action.popupUrl };
    }
    const tab = this.tabsSource?.getExtensionTab(tabId);
    if (!tab) throw new Error("The active browser tab is unavailable.");
    const invocation = this.actions.invokeFromToolbar(extensionId, {
      id: tab.id,
      url: tab.url,
    });
    const tabsSubscription = this.tabsSubscriptions.get(extensionId);
    if (tabsSubscription)
      this.sendTabsSnapshotToRunning(extension, tabsSubscription.scope);
    const actionSubscription = this.actionSubscriptions.get(extensionId);
    if (actionSubscription)
      this.sendTabsSnapshotToRunning(extension, actionSubscription.scope);
    if (invocation.kind === "popup") return invocation;
    const index = Math.max(
      0,
      this.tabsSource?.extensionTabSnapshots.findIndex(
        (candidate) => candidate.id === tab.id,
      ) ?? -1,
    );
    this.dispatchActionClick(
      extension,
      this.actions.resolve(extensionId, tab.id)?.kind ?? "action",
      sanitizeTabSnapshot(
        extension,
        chromeTabSnapshot(tab, index),
        this.actions.hasActiveTabGrant(extensionId, tab.id, tab.url),
      ),
    );
    return invocation;
  }

  handleCommandInput(input: ExtensionCommandInput): boolean {
    const tab =
      this.tabsSource?.extensionTabSnapshots.find(
        (candidate) => candidate.active,
      ) ?? null;
    const invocation = this.commands.match(
      input,
      tab ? { id: tab.id, url: tab.url } : null,
    );
    if (!invocation) return false;
    void this.dispatchCommandInvocation(invocation, tab);
    return true;
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
    this.browserSession.extensions.on(
      "extension-loaded",
      this.onExtensionLoaded,
    );
    this.ipc.on(extensionHostChannels.observerRequest, this.onObserverRequest);
    this.ipc.on(extensionHostChannels.frameMessage, this.onFrameMessage);
    for (const versionId of Object.keys(
      this.browserSession.serviceWorkers.getAllRunning(),
    )) {
      this.bindWorker(Number(versionId));
    }
    const loadedExtensions =
      this.browserSession.extensions.getAllExtensions?.() ?? [];
    for (const extension of loadedExtensions) this.registerCommands(extension);
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
    this.browserSession.extensions.removeListener(
      "extension-loaded",
      this.onExtensionLoaded,
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
    this.actionSubscriptions.clear();
    this.actionFrameSubscriptions.clear();
    this.commandsSubscriptions.clear();
    this.commandsFrameSubscriptions.clear();
    this.deliveryQueues.clear();
    for (const eventId of [...this.actionAckWaiters.keys()])
      this.resolveActionAck(eventId, false);
    for (const eventId of [...this.commandsAckWaiters.keys()])
      this.resolveCommandsAck(eventId, false);
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
    this.boundWorkers.set(versionId, { worker, listener, ready: false });
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
    this.resolveWorkerReady(versionId, false);
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
      const bound = this.boundWorkers.get(worker.versionId);
      if (bound) bound.ready = true;
      this.resolveWorkerReady(worker.versionId, true);
      return;
    }
    if (message.type === "action-event-ack") {
      this.resolveActionAck(message.eventId, true);
      return;
    }
    if (message.type === "commands-event-ack") {
      this.resolveCommandsAck(message.eventId, true);
      return;
    }
    if (message.type === "commands-get-all") {
      this.registerCommands(extension);
      worker.send(extensionHostChannels.hostMessage, {
        type: "commands-result",
        requestId: message.requestId,
        commands: this.commands.getAll(extensionId),
      });
      return;
    }
    if (message.type === "commands-subscriptions") {
      this.registerCommands(extension);
      if (message.listening) {
        this.commandsSubscriptions.set(extensionId, { scope: worker.scope });
      } else {
        this.commandsSubscriptions.delete(extensionId);
      }
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
    if (message.type === "action-subscriptions") {
      this.registerAction(extension);
      this.actionSubscriptions.set(extensionId, {
        scope: worker.scope,
        namespaces: new Set(message.namespaces),
      });
      this.deliver(extensionId, worker.scope, this.tabsSnapshot(extension));
      return;
    }
    this.tabsSubscriptions.set(extensionId, {
      scope: worker.scope,
      events: new Set(message.events),
    });
    this.deliver(extensionId, worker.scope, this.tabsSnapshot(extension));
  }

  private dispatchTabTransition(transition: ExtensionTabTransition): void {
    if (transition.type === "removed") {
      this.actions.removeTab(transition.tabId);
      this.commands.removeTab(transition.tabId);
    }
    if (transition.type === "updated" && transition.change.url !== undefined) {
      this.actions.navigatedTab(transition.tabId, transition.tab.url);
      this.commands.navigatedTab(transition.tabId, transition.tab.url);
    }
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
      const eventTab =
        event.eventName === "onCreated"
          ? event.args[0]
          : event.eventName === "onUpdated"
            ? event.args[2]
            : null;
      const eventTabRecord =
        eventTab && typeof eventTab === "object"
          ? (eventTab as Record<string, unknown>)
          : null;
      const sanitized = sanitizeTabsEvent(
        extension,
        event,
        Number.isInteger(eventTabRecord?.id) &&
          typeof eventTabRecord?.url === "string"
          ? this.actions.hasActiveTabGrant(
              extension.id,
              eventTabRecord.id as number,
              eventTabRecord.url,
            )
          : false,
      );
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

  private registerCommands(extension: Extension): void {
    this.commands.register({
      id: extension.id,
      manifest: extension.manifest as Record<string, unknown>,
    });
  }

  private registerFrameCommandsSubscription(
    extension: Extension,
    frame: Electron.WebFrameMain,
    listening: boolean,
  ): void {
    const subscriptions =
      this.commandsFrameSubscriptions.get(extension.id) ?? new Set();
    subscriptions.delete(frame);
    if (listening) subscriptions.add(frame);
    if (subscriptions.size > 0)
      this.commandsFrameSubscriptions.set(extension.id, subscriptions);
    else this.commandsFrameSubscriptions.delete(extension.id);
  }

  private async dispatchCommandInvocation(
    invocation: ExtensionCommandInvocation,
    tab: ExtensionTabSnapshot | null,
  ): Promise<void> {
    const extension = this.browserSession.extensions.getExtension(
      invocation.extensionId,
    );
    if (!extension) return;
    if (invocation.reservedAction) {
      try {
        const action = await this.invokeActionFromToolbar(
          extension.id,
          tab?.id ?? null,
        );
        if (action.kind === "popup") {
          await this.options.openActionPopup?.(
            extension.id,
            action.popupUrl,
            tab?.id ?? null,
          );
        }
      } catch {
        // Chrome silently ignores disabled, hidden, or unavailable actions.
      }
      return;
    }
    const index = tab
      ? Math.max(
          0,
          this.tabsSource?.extensionTabSnapshots.findIndex(
            (candidate) => candidate.id === tab.id,
          ) ?? -1,
        )
      : -1;
    const event: ExtensionCommandsEventMessage = {
      type: "commands-event",
      eventId: `command-${Date.now().toString(36)}-${(this
        .nextCommandEventId++).toString(36)}`,
      command: invocation.command,
      ...(tab
        ? {
            tab: sanitizeTabSnapshot(
              extension,
              chromeTabSnapshot(tab, index),
              this.commands.hasActiveTabGrant(extension.id, tab.id, tab.url),
            ),
          }
        : {}),
    };
    const workerSubscription = this.commandsSubscriptions.get(extension.id);
    if (workerSubscription)
      this.deliver(extension.id, workerSubscription.scope, event);
    const frames = this.commandsFrameSubscriptions.get(extension.id);
    if (!frames) return;
    for (const frame of [...frames]) {
      try {
        frame.send(extensionHostChannels.frameHostMessage, event);
      } catch {
        frames.delete(frame);
      }
    }
    if (frames.size === 0) this.commandsFrameSubscriptions.delete(extension.id);
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
        sanitizeTabSnapshot(
          extension,
          chromeTabSnapshot(tab, index),
          this.actions.hasActiveTabGrant(extension.id, tab.id, tab.url),
        ),
      ),
    };
  }

  private registerFrameActionSubscriptions(
    extension: Extension,
    frame: Electron.WebFrameMain,
    namespaces: ExtensionActionNamespace[],
  ): void {
    const subscriptions =
      this.actionFrameSubscriptions.get(extension.id) ??
      new Set<ExtensionActionFrameSubscription>();
    for (const existing of [...subscriptions]) {
      if (existing.frame === frame) subscriptions.delete(existing);
    }
    if (namespaces.length > 0) {
      subscriptions.add({ frame, namespaces: new Set(namespaces) });
    }
    if (subscriptions.size > 0)
      this.actionFrameSubscriptions.set(extension.id, subscriptions);
    else this.actionFrameSubscriptions.delete(extension.id);
  }

  private dispatchActionClick(
    extension: Extension,
    namespace: ExtensionActionNamespace,
    tab: Record<string, unknown>,
  ): void {
    const message: ExtensionActionEventMessage = {
      type: "action-event",
      eventId: `action-${Date.now().toString(36)}-${(this
        .nextActionEventId++).toString(36)}`,
      namespace,
      eventName: "onClicked",
      args: [tab],
    };
    const workerSubscription = this.actionSubscriptions.get(extension.id);
    if (workerSubscription?.namespaces.has(namespace)) {
      this.deliver(extension.id, workerSubscription.scope, message);
    }
    const frameSubscriptions = this.actionFrameSubscriptions.get(extension.id);
    if (!frameSubscriptions) return;
    for (const subscription of [...frameSubscriptions]) {
      if (!subscription.namespaces.has(namespace)) continue;
      try {
        subscription.frame.send(
          extensionHostChannels.frameHostMessage,
          message,
        );
      } catch {
        frameSubscriptions.delete(subscription);
      }
    }
    if (frameSubscriptions.size === 0)
      this.actionFrameSubscriptions.delete(extension.id);
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
    if (message.type === "action-event") {
      await this.deliverActionEvent(extensionId, scope, message);
      return;
    }
    if (message.type === "commands-event") {
      await this.deliverCommandsEvent(extensionId, scope, message);
      return;
    }
    try {
      let worker =
        await this.browserSession.serviceWorkers.startWorkerForScope(scope);
      if (!(await this.waitForWorkerReady(worker))) {
        worker =
          await this.browserSession.serviceWorkers.startWorkerForScope(scope);
        if (!(await this.waitForWorkerReady(worker))) {
          throw new Error("The extension worker bridge did not become ready.");
        }
      }
      if (extensionIdFromScope(worker.scope) !== extensionId) return;
      const task = worker.startTask();
      try {
        worker.send(extensionHostChannels.hostMessage, message);
        const keepAlive = setTimeout(() => {
          try {
            task.end();
          } catch {
            // A force-stopped worker has already released this task.
          }
        }, 250);
        keepAlive.unref();
      } catch (error) {
        task.end();
        throw error;
      }
    } catch (error) {
      console.warn(
        `Could not deliver an extension host event to ${extensionId}.`,
        error,
      );
    }
  }

  private async deliverActionEvent(
    extensionId: string,
    scope: string,
    message: ExtensionActionEventMessage,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.browserSession.extensions.getExtension(extensionId)) return;
      try {
        let worker =
          await this.browserSession.serviceWorkers.startWorkerForScope(scope);
        if (!(await this.waitForWorkerReady(worker))) {
          worker =
            await this.browserSession.serviceWorkers.startWorkerForScope(scope);
          if (!(await this.waitForWorkerReady(worker))) continue;
        }
        if (extensionIdFromScope(worker.scope) !== extensionId) return;
        const task = worker.startTask();
        try {
          const acknowledged = this.waitForActionAck(message.eventId, 1_250);
          worker.send(extensionHostChannels.hostMessage, message);
          if (await acknowledged) {
            safelyEndWorkerTask(task);
            return;
          }
        } finally {
          safelyEndWorkerTask(task);
        }
      } catch {
        // A force-stopped version can remain visible briefly; retry once.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.warn(
      `Could not confirm delivery of an extension action event to ${extensionId}.`,
    );
  }

  private async deliverCommandsEvent(
    extensionId: string,
    scope: string,
    message: ExtensionCommandsEventMessage,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.browserSession.extensions.getExtension(extensionId)) return;
      try {
        let worker =
          await this.browserSession.serviceWorkers.startWorkerForScope(scope);
        if (!(await this.waitForWorkerReady(worker))) {
          worker =
            await this.browserSession.serviceWorkers.startWorkerForScope(scope);
          if (!(await this.waitForWorkerReady(worker))) continue;
        }
        if (extensionIdFromScope(worker.scope) !== extensionId) return;
        const task = worker.startTask();
        try {
          const acknowledged = this.waitForCommandsAck(message.eventId, 1_250);
          worker.send(extensionHostChannels.hostMessage, message);
          if (await acknowledged) {
            safelyEndWorkerTask(task);
            return;
          }
        } finally {
          safelyEndWorkerTask(task);
        }
      } catch {
        // A force-stopped version can remain visible briefly; retry once.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.warn(
      `Could not confirm delivery of an extension command event to ${extensionId}.`,
    );
  }

  private waitForActionAck(
    eventId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (acknowledged: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.actionAckWaiters.get(eventId) === finish)
          this.actionAckWaiters.delete(eventId);
        resolve(acknowledged);
      };
      this.actionAckWaiters.set(eventId, finish);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      timeout.unref();
    });
  }

  private resolveActionAck(eventId: string, acknowledged: boolean): void {
    this.actionAckWaiters.get(eventId)?.(acknowledged);
  }

  private waitForCommandsAck(
    eventId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (acknowledged: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.commandsAckWaiters.get(eventId) === finish)
          this.commandsAckWaiters.delete(eventId);
        resolve(acknowledged);
      };
      this.commandsAckWaiters.set(eventId, finish);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      timeout.unref();
    });
  }

  private resolveCommandsAck(eventId: string, acknowledged: boolean): void {
    this.commandsAckWaiters.get(eventId)?.(acknowledged);
  }

  private waitForWorkerReady(worker: ServiceWorkerMain): Promise<boolean> {
    if (!this.isWorkerRunning(worker)) {
      this.unbindWorker(worker.versionId);
    } else if (this.boundWorkers.get(worker.versionId)?.ready) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiters =
        this.workerReadyWaiters.get(worker.versionId) ?? new Set();
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        waiters.delete(finish);
        if (waiters.size === 0)
          this.workerReadyWaiters.delete(worker.versionId);
        resolve(ready);
      };
      waiters.add(finish);
      this.workerReadyWaiters.set(worker.versionId, waiters);
      const timeout = setTimeout(() => {
        finish(false);
      }, 1_000);
      timeout.unref();
    });
  }

  private isWorkerRunning(worker: ServiceWorkerMain): boolean {
    if (worker.isDestroyed()) return false;
    return Object.hasOwn(
      this.browserSession.serviceWorkers.getAllRunning(),
      String(worker.versionId),
    );
  }

  private resolveWorkerReady(versionId: number, ready: boolean): void {
    const waiters = this.workerReadyWaiters.get(versionId);
    if (!waiters) return;
    this.workerReadyWaiters.delete(versionId);
    for (const resolve of waiters) resolve(ready);
  }
}

function safelyEndWorkerTask(task: Electron.StartTask): void {
  try {
    task.end();
  } catch {
    // A force-stopped worker has already released this task.
  }
}

export function extensionIdFromScope(scope: string): string | null {
  return EXTENSION_SCOPE.exec(scope)?.[1] ?? null;
}

function parseWorkerMessage(raw: unknown): ExtensionWorkerMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const type = (raw as { type?: unknown }).type;
  if (type === "worker-ready") return { type };
  if (type === "action-event-ack") {
    const eventId = (raw as { eventId?: unknown }).eventId;
    if (
      typeof eventId !== "string" ||
      eventId.length < 1 ||
      eventId.length > 128
    )
      return null;
    return { type, eventId };
  }
  if (type === "commands-event-ack") {
    const eventId = (raw as { eventId?: unknown }).eventId;
    if (
      typeof eventId !== "string" ||
      eventId.length < 1 ||
      eventId.length > 128
    )
      return null;
    return { type, eventId };
  }
  if (type === "commands-subscriptions") {
    const listening = (raw as { listening?: unknown }).listening;
    return typeof listening === "boolean" ? { type, listening } : null;
  }
  if (type === "commands-get-all") {
    const requestId = (raw as { requestId?: unknown }).requestId;
    if (
      typeof requestId !== "string" ||
      requestId.length < 1 ||
      requestId.length > 128
    )
      return null;
    return { type, requestId };
  }
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
  if (type === "action-subscriptions") {
    const rawNamespaces = (raw as { namespaces?: unknown }).namespaces;
    if (!Array.isArray(rawNamespaces)) return null;
    const allowed = new Set<ExtensionActionNamespace>([
      "action",
      "browserAction",
      "pageAction",
    ]);
    const namespaces = [
      ...new Set(
        rawNamespaces
          .slice(0, allowed.size)
          .filter(
            (namespace): namespace is ExtensionActionNamespace =>
              typeof namespace === "string" &&
              allowed.has(namespace as ExtensionActionNamespace),
          ),
      ),
    ];
    return { type, namespaces };
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
  activeTabAccess = false,
): ExtensionTabsEventMessage {
  if (event.eventName === "onRemoved" || event.eventName === "onActivated")
    return event;
  const tab = event.eventName === "onCreated" ? event.args[0] : event.args[2];
  if (!tab || typeof tab !== "object") return event;
  const candidate = tab as Record<string, unknown>;
  const redacted = sanitizeTabSnapshot(extension, candidate, activeTabAccess);
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
  activeTabAccess = false,
): Record<string, unknown> {
  const url = typeof candidate.url === "string" ? candidate.url : "";
  if (
    activeTabAccess ||
    hasPermission(extension, "tabs") ||
    canAccessUrl(extension, url)
  )
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
