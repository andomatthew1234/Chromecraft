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
  extensionIdFromScope,
  matchesExtensionUrlPattern,
} from "./extension-web-request-host";

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
