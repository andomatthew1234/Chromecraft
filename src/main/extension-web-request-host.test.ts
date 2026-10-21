import { EventEmitter } from "node:events";
import type {
  Extension,
  OnBeforeRequestListenerDetails,
  ServiceWorkerMain,
  Session,
} from "electron";
import { describe, expect, it, vi } from "vitest";

import { extensionHostChannels } from "../shared/extension-host-protocol";
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
      preloadPath: "C:\\chromecraft\\extension-worker-preload.cjs",
      resolveTabId: () => 7,
    });
    host.start();

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

    const callback = vi.fn();
    fixture.emitRequest(
      requestDetails({
        url: "https://allowed.example/vault?refresh=1",
        resourceType: "xhr",
      }),
      callback,
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
    expect(callback).toHaveBeenCalledWith({});

    host.dispose();
    expect(fixture.unregisterPreloadScript).toHaveBeenCalledWith("preload-id");
  });

  it("does not deliver requests outside declared host permissions", async () => {
    const fixture = createFixture();
    const host = new ExtensionWebRequestHost(fixture.session, {
      preloadPath: "C:\\chromecraft\\extension-worker-preload.cjs",
    });
    host.start();
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
      vi.fn(),
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
  serviceWorkers: EventEmitter;
  workerIpc: EventEmitter;
  worker: ServiceWorkerMain & { send: ReturnType<typeof vi.fn> };
  emitRequest: (
    details: OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void,
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
    getExtension: (id: string) => (id === EXTENSION_ID ? extension : null),
  });
  let requestListener:
    | ((
        details: OnBeforeRequestListenerDetails,
        callback: (response: Electron.CallbackResponse) => void,
      ) => void)
    | null = null;
  const unregisterPreloadScript = vi.fn();
  const session = {
    extensions,
    serviceWorkers,
    webRequest: {
      onBeforeRequest: vi.fn(
        (
          filterOrListener: unknown,
          maybeListener?: (
            details: OnBeforeRequestListenerDetails,
            callback: (response: Electron.CallbackResponse) => void,
          ) => void,
        ) => {
          requestListener =
            typeof filterOrListener === "function"
              ? (filterOrListener as typeof requestListener)
              : (maybeListener ?? null);
        },
      ),
    },
    registerPreloadScript: vi.fn(() => "preload-id"),
    unregisterPreloadScript,
  } as unknown as Session;
  return {
    session,
    serviceWorkers,
    workerIpc,
    worker,
    emitRequest: (details, callback) => requestListener?.(details, callback),
    unregisterPreloadScript,
  };
}

function requestDetails(
  overrides: Partial<OnBeforeRequestListenerDetails> = {},
): OnBeforeRequestListenerDetails {
  return {
    id: 12,
    url: "https://allowed.example/resource",
    method: "GET",
    resourceType: "xhr",
    referrer: "",
    timestamp: 123,
    uploadData: [],
    webContentsId: 99,
    ...overrides,
  };
}
