import { EventEmitter } from "node:events";
import type { Extension, ServiceWorkerMain, Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  EXTENSION_NETWORK_OBSERVER_ID,
  EXTENSION_NETWORK_OBSERVER_ORIGIN,
  extensionHostChannels,
  type ExtensionWebRequestEventDetails,
} from "../shared/extension-host-protocol";
import {
  ExtensionWebRequestHost,
  type ExtensionTabsSource,
  extensionIdFromScope,
  matchesExtensionUrlPattern,
} from "./extension-web-request-host";
import type {
  ExtensionTabSnapshot,
  ExtensionTabTransition,
} from "./tab-manager";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

describe("ExtensionWebRequestHost", () => {
  it("authenticates an MV3 worker and delivers matching requests", async () => {
    const fixture = createFixture();
    const host = new ExtensionWebRequestHost(fixture.session, {
      ...hostPaths(),
      ipc: fixture.ipc,
    });
    await host.start();

    fixture.serviceWorkers.emit("running-status-changed", {
      versionId: 42,
      runningStatus: "running",
    });
    fixture.workerIpc.emit(
      extensionHostChannels.workerMessage,
      { serviceWorker: fixture.worker },
      {
        type: "webRequest-subscriptions",
        eventName: "onBeforeRequest",
        filters: [
          { urls: ["https://allowed.example/*"], types: ["xmlhttprequest"] },
        ],
      },
    );

    fixture.emitRequest(
      requestDetails({
        url: "https://allowed.example/vault?refresh=1",
        tabId: 7,
      }),
    );
    await vi.waitFor(() =>
      expect(fixture.worker.send).toHaveBeenCalledWith(
        extensionHostChannels.hostMessage,
        expect.objectContaining({
          type: "webRequest-event",
          details: expect.objectContaining({
            url: "https://allowed.example/vault?refresh=1",
            tabId: 7,
            type: "xmlhttprequest",
          }),
        }),
      ),
    );

    host.dispose();
    expect(fixture.unregisterPreloadScript).toHaveBeenCalledTimes(2);
  });

  it("does not deliver requests outside declared host permissions", async () => {
    const fixture = createFixture();
    const host = new ExtensionWebRequestHost(fixture.session, {
      ...hostPaths(),
      ipc: fixture.ipc,
    });
    await host.start();
    fixture.serviceWorkers.emit("running-status-changed", {
      versionId: 42,
      runningStatus: "running",
    });
    fixture.workerIpc.emit(
      extensionHostChannels.workerMessage,
      { serviceWorker: fixture.worker },
      {
        type: "webRequest-subscriptions",
        eventName: "onBeforeRequest",
        filters: [{ urls: ["<all_urls>"] }],
      },
    );
    fixture.worker.send.mockClear();

    fixture.emitRequest(
      requestDetails({ url: "https://private.example/account" }),
    );
    await Promise.resolve();
    expect(fixture.worker.send).not.toHaveBeenCalled();
    host.dispose();
  });

  it("rejects observer messages from ordinary website frames", async () => {
    const fixture = createFixture();
    const host = new ExtensionWebRequestHost(fixture.session, {
      ...hostPaths(),
      ipc: fixture.ipc,
    });
    await host.start();
    fixture.serviceWorkers.emit("running-status-changed", {
      versionId: 42,
      runningStatus: "running",
    });
    fixture.workerIpc.emit(
      extensionHostChannels.workerMessage,
      { serviceWorker: fixture.worker },
      {
        type: "webRequest-subscriptions",
        eventName: "onBeforeRequest",
        filters: [{ urls: ["<all_urls>"] }],
      },
    );
    fixture.worker.send.mockClear();

    fixture.emitRequest(
      requestDetails(),
      "https://allowed.example/pretend-observer",
    );
    await Promise.resolve();
    expect(fixture.worker.send).not.toHaveBeenCalled();
    host.dispose();
  });

  it("rejects worker identity spoofing by deriving identity from scope", () => {
    expect(extensionIdFromScope(`chrome-extension://${EXTENSION_ID}/`)).toBe(
      EXTENSION_ID,
    );
    expect(
      extensionIdFromScope(`https://${EXTENSION_ID}.attacker.example/`),
    ).toBeNull();
    expect(extensionIdFromScope("chrome-extension://invalid/")).toBeNull();
  });

  it("delivers Chrome-shaped tab lifecycle events with native tab IDs", async () => {
    const fixture = createFixture();
    const tabs = createTabsSource();
    const host = new ExtensionWebRequestHost(fixture.session, {
      ...hostPaths(),
      ipc: fixture.ipc,
    });
    host.attachTabs(tabs.source);
    await host.start();
    fixture.serviceWorkers.emit("running-status-changed", {
      versionId: 42,
      runningStatus: "running",
    });
    fixture.workerIpc.emit(
      extensionHostChannels.workerMessage,
      { serviceWorker: fixture.worker },
      {
        type: "tabs-subscriptions",
        events: ["onCreated", "onActivated", "onUpdated", "onRemoved"],
      },
    );
    await vi.waitFor(() =>
      expect(fixture.worker.send).toHaveBeenCalledWith(
        extensionHostChannels.hostMessage,
        expect.objectContaining({ type: "tabs-snapshot" }),
      ),
    );
    fixture.worker.send.mockClear();

    const tab: ExtensionTabSnapshot = {
      id: 42,
      active: false,
      title: "Allowed",
      url: "https://allowed.example/page",
      status: "loading",
    };
    tabs.emit({ type: "created", tab });
    tabs.emit({ type: "activated", tabId: 42, previousTabId: null });
    tabs.emit({
      type: "updated",
      tabId: 42,
      change: { title: "Ready", status: "complete" },
      tab: { ...tab, active: true, title: "Ready", status: "complete" },
    });
    tabs.emit({ type: "removed", tabId: 42, wasActive: true });

    await vi.waitFor(() =>
      expect(
        fixture.worker.send.mock.calls.filter(
          (call) => (call[1] as { type?: string }).type === "tabs-event",
        ),
      ).toHaveLength(4),
    );
    expect(
      fixture.worker.send.mock.calls
        .map((call) => call[1])
        .filter(
          (message) => (message as { type?: string }).type === "tabs-event",
        ),
    ).toEqual([
      expect.objectContaining({
        type: "tabs-event",
        eventName: "onCreated",
        args: [expect.objectContaining({ id: 42, url: tab.url })],
      }),
      {
        type: "tabs-event",
        eventName: "onActivated",
        args: [{ tabId: 42, windowId: 0 }],
      },
      expect.objectContaining({
        type: "tabs-event",
        eventName: "onUpdated",
        args: [
          42,
          { title: "Ready", status: "complete" },
          expect.objectContaining({ id: 42, title: "Ready" }),
        ],
      }),
      {
        type: "tabs-event",
        eventName: "onRemoved",
        args: [42, { windowId: 0, isWindowClosing: false }],
      },
    ]);
    host.dispose();
  });

  it("redacts tab URLs and titles outside an extension's permissions", async () => {
    const fixture = createFixture();
    const tabs = createTabsSource();
    const host = new ExtensionWebRequestHost(fixture.session, {
      ...hostPaths(),
      ipc: fixture.ipc,
    });
    host.attachTabs(tabs.source);
    await host.start();
    fixture.serviceWorkers.emit("running-status-changed", {
      versionId: 42,
      runningStatus: "running",
    });
    fixture.workerIpc.emit(
      extensionHostChannels.workerMessage,
      { serviceWorker: fixture.worker },
      { type: "tabs-subscriptions", events: ["onCreated", "onUpdated"] },
    );
    await vi.waitFor(() =>
      expect(fixture.worker.send).toHaveBeenCalledWith(
        extensionHostChannels.hostMessage,
        expect.objectContaining({ type: "tabs-snapshot" }),
      ),
    );
    fixture.worker.send.mockClear();

    const tab: ExtensionTabSnapshot = {
      id: 73,
      active: true,
      title: "Private account",
      url: "https://private.example/account",
      status: "complete",
    };
    tabs.emit({ type: "created", tab });
    tabs.emit({
      type: "updated",
      tabId: 73,
      change: { title: tab.title, url: tab.url },
      tab,
    });

    await vi.waitFor(() =>
      expect(
        fixture.worker.send.mock.calls.filter(
          (call) => (call[1] as { type?: string }).type === "tabs-event",
        ),
      ).toHaveLength(2),
    );
    const messages = fixture.worker.send.mock.calls
      .map((call) => call[1])
      .filter(
        (message) => (message as { type?: string }).type === "tabs-event",
      ) as Array<{ args: Array<Record<string, unknown>> }>;
    expect(messages[0].args[0]).not.toHaveProperty("url");
    expect(messages[0].args[0]).not.toHaveProperty("title");
    expect(messages[1].args[1]).not.toHaveProperty("url");
    expect(messages[1].args[1]).not.toHaveProperty("title");
    expect(messages[1].args[2]).not.toHaveProperty("url");
    expect(messages[1].args[2]).not.toHaveProperty("title");
    host.dispose();
  });
});

describe("extension URL match patterns", () => {
  it("supports wildcard schemes, subdomains, paths, and all URLs", () => {
    expect(
      matchesExtensionUrlPattern(
        "*://*.example.com/api/*",
        "https://vault.example.com/api/items?fresh=1",
      ),
    ).toBe(true);
    expect(
      matchesExtensionUrlPattern(
        "*://*.example.com/api/*",
        "https://example.com/api/items",
      ),
    ).toBe(true);
    expect(
      matchesExtensionUrlPattern(
        "*://*.example.com/api/*",
        "https://attacker.example.net/api/items",
      ),
    ).toBe(false);
    expect(matchesExtensionUrlPattern("<all_urls>", "file:///tmp/a.txt")).toBe(
      true,
    );
  });
});

function createFixture(): {
  session: Session;
  ipc: EventEmitter;
  serviceWorkers: EventEmitter;
  workerIpc: EventEmitter;
  worker: ServiceWorkerMain & { send: ReturnType<typeof vi.fn> };
  emitRequest: (
    details: ExtensionWebRequestEventDetails,
    senderUrl?: string,
  ) => void;
  unregisterPreloadScript: ReturnType<typeof vi.fn>;
} {
  const extension = {
    id: EXTENSION_ID,
    manifest: {
      manifest_version: 3,
      permissions: ["webRequest"],
      host_permissions: ["https://allowed.example/*"],
    },
    name: "Fixture",
    path: "C:\\fixture",
    url: `chrome-extension://${EXTENSION_ID}/`,
    version: "1.0.0",
  } satisfies Extension;
  const observerExtension = {
    id: EXTENSION_NETWORK_OBSERVER_ID,
    manifest: { manifest_version: 2 },
    name: "Chromecraft Network Observer",
    path: "C:\\observer",
    url: `${EXTENSION_NETWORK_OBSERVER_ORIGIN}/`,
    version: "1.0.0",
  } satisfies Extension;
  const workerIpc = new EventEmitter();
  const worker = {
    scope: `chrome-extension://${EXTENSION_ID}/`,
    versionId: 42,
    ipc: workerIpc,
    send: vi.fn(),
  } as unknown as ServiceWorkerMain & { send: ReturnType<typeof vi.fn> };
  const serviceWorkers = new EventEmitter();
  Object.assign(serviceWorkers, {
    getAllRunning: () => ({}),
    getWorkerFromVersionID: (versionId: number) =>
      versionId === 42 ? worker : undefined,
    startWorkerForScope: vi.fn(async () => worker),
  });
  const extensions = new EventEmitter();
  Object.assign(extensions, {
    getExtension: (id: string) =>
      id === EXTENSION_ID
        ? extension
        : id === EXTENSION_NETWORK_OBSERVER_ID
          ? observerExtension
          : null,
    loadExtension: vi.fn(async () => {
      queueMicrotask(() =>
        extensions.emit("extension-ready", {}, observerExtension),
      );
      return observerExtension;
    }),
    removeExtension: vi.fn(async () => undefined),
  });
  const ipc = new EventEmitter();
  const unregisterPreloadScript = vi.fn();
  let nextPreloadId = 0;
  const session = {
    extensions,
    serviceWorkers,
    registerPreloadScript: vi.fn(() => `preload-${++nextPreloadId}`),
    unregisterPreloadScript,
  } as unknown as Session;
  return {
    session,
    ipc,
    serviceWorkers,
    workerIpc,
    worker,
    emitRequest: (
      details,
      senderUrl = `${EXTENSION_NETWORK_OBSERVER_ORIGIN}/background.html`,
    ) =>
      ipc.emit(
        extensionHostChannels.observerRequest,
        {
          sender: {
            session,
            getURL: () => senderUrl,
          },
          senderFrame: {
            url: senderUrl,
          },
        },
        details,
      ),
    unregisterPreloadScript,
  };
}

function createTabsSource(): {
  source: ExtensionTabsSource;
  emit: (transition: ExtensionTabTransition) => void;
} {
  const listeners = new Set<(transition: ExtensionTabTransition) => void>();
  return {
    source: {
      extensionTabSnapshots: [],
      getExtensionTab: () => null,
      subscribeExtensionTabTransitions: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit: (transition) => {
      for (const listener of listeners) listener(transition);
    },
  };
}

function requestDetails(
  overrides: Partial<ExtensionWebRequestEventDetails> = {},
): ExtensionWebRequestEventDetails {
  return {
    requestId: "12",
    url: "https://allowed.example/resource",
    method: "GET",
    type: "xmlhttprequest",
    timeStamp: 123,
    frameId: 0,
    parentFrameId: -1,
    tabId: 7,
    ...overrides,
  };
}

function hostPaths() {
  return {
    serviceWorkerPreloadPath: "C:\\chromecraft\\extension-worker-preload.cjs",
    observerPreloadPath: "C:\\chromecraft\\observer-preload.cjs",
    observerExtensionPath: "C:\\chromecraft\\observer",
    readyTimeoutMs: 100,
  };
}
