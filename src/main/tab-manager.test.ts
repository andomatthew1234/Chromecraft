import { describe, expect, it } from "vitest";

import {
  ExtensionTabLifecycle,
  isWebsiteFullscreenPermissionAllowed,
  TabManager,
  type ExtensionTabTransition,
} from "./tab-manager";

describe("website fullscreen permissions", () => {
  it("allows only user-initiated fullscreen on HTTP and HTTPS pages", () => {
    expect(
      isWebsiteFullscreenPermissionAllowed(
        "fullscreen",
        "https://video.example/watch",
      ),
    ).toBe(true);
    expect(
      isWebsiteFullscreenPermissionAllowed(
        "fullscreen",
        "http://localhost:3000/watch",
      ),
    ).toBe(true);

    expect(
      isWebsiteFullscreenPermissionAllowed(
        "automatic-fullscreen",
        "https://video.example/watch",
      ),
    ).toBe(false);
    expect(
      isWebsiteFullscreenPermissionAllowed(
        "fullscreen",
        "chrome-extension://extension-id/player.html",
      ),
    ).toBe(false);
    expect(
      isWebsiteFullscreenPermissionAllowed(
        "fullscreen",
        "https://video.example/watch",
      ),
    ).toBe(true);
    expect(
      isWebsiteFullscreenPermissionAllowed(
        "geolocation",
        "https://video.example/watch",
      ),
    ).toBe(false);
  });

  it("grants fullscreen only to the active browser-owned WebContents", () => {
    const activeContents = {
      getURL: () => "https://video.example/watch",
      isDestroyed: () => false,
    } as Electron.WebContents;
    const inactiveContents = {
      getURL: () => "https://other.example/",
      isDestroyed: () => false,
    } as Electron.WebContents;
    const manager = Object.create(TabManager.prototype) as TabManager;
    Object.assign(manager as unknown as Record<string, unknown>, {
      activeTabId: "active",
      htmlFullscreenTabId: null,
      pendingHtmlFullscreen: null,
      window: {
        isDestroyed: () => false,
        isVisible: () => true,
        isFocused: () => true,
        isFullScreen: () => false,
      },
      tabs: new Map([
        [
          "active",
          {
            id: "active",
            documentEpoch: 1,
            view: { webContents: activeContents },
          },
        ],
        [
          "inactive",
          {
            id: "inactive",
            documentEpoch: 1,
            view: { webContents: inactiveContents },
          },
        ],
      ]),
    });

    expect(
      manager.canGrantWebsiteFullscreen(activeContents, "fullscreen"),
    ).toBe(true);
    expect(
      manager.canGrantWebsiteFullscreen(inactiveContents, "fullscreen"),
    ).toBe(false);
    expect(
      manager.canGrantWebsiteFullscreen(activeContents, "automatic-fullscreen"),
    ).toBe(false);
  });
});

describe("ExtensionTabLifecycle", () => {
  it("uses stable Electron WebContents identifiers", () => {
    const lifecycle = new ExtensionTabLifecycle();
    const first = lifecycle.attach("browser-a", 42, {
      title: "First",
      url: "https://example.test/first",
      status: "complete",
    });
    const second = lifecycle.attach("browser-b", 73, {
      title: "Second",
      url: "https://example.test/second",
      status: "complete",
    });

    expect(Number.isSafeInteger(first.id)).toBe(true);
    expect(first.id).toBe(42);
    expect(second.id).toBe(73);
    expect(lifecycle.idForBrowserTab("browser-a")).toBe(first.id);
    expect(lifecycle.get(first.id)).toEqual(first);

    lifecycle.update("browser-a", { title: "Renamed" });

    expect(lifecycle.idForBrowserTab("browser-a")).toBe(first.id);
    expect(lifecycle.get(first.id)?.title).toBe("Renamed");
  });

  it("emits create, activate, navigation updates, and removal in exact order", () => {
    const lifecycle = new ExtensionTabLifecycle();
    const transitions: ExtensionTabTransition[] = [];
    lifecycle.subscribe((transition) => transitions.push(transition));

    const created = lifecycle.attach("browser-a", 42, {
      title: "New Tab",
      url: "",
      status: "complete",
    });
    lifecycle.activate("browser-a");
    lifecycle.update("browser-a", {
      title: "Loading…",
      url: "https://example.test/",
      status: "loading",
    });
    lifecycle.update("browser-a", {
      title: "Example",
      status: "complete",
    });
    lifecycle.remove("browser-a");

    expect(transitions).toEqual([
      {
        type: "created",
        tab: {
          id: created.id,
          active: false,
          title: "New Tab",
          url: "",
          status: "complete",
        },
      },
      { type: "activated", tabId: created.id, previousTabId: null },
      {
        type: "updated",
        tabId: created.id,
        change: {
          title: "Loading…",
          url: "https://example.test/",
          status: "loading",
        },
        tab: {
          id: created.id,
          active: true,
          title: "Loading…",
          url: "https://example.test/",
          status: "loading",
        },
      },
      {
        type: "updated",
        tabId: created.id,
        change: { title: "Example", status: "complete" },
        tab: {
          id: created.id,
          active: true,
          title: "Example",
          url: "https://example.test/",
          status: "complete",
        },
      },
      { type: "removed", tabId: created.id, wasActive: true },
    ]);
  });

  it("never emits transitions for callbacks arriving after removal", () => {
    const lifecycle = new ExtensionTabLifecycle();
    const transitions: ExtensionTabTransition[] = [];
    lifecycle.subscribe((transition) => transitions.push(transition));
    lifecycle.attach("browser-a", 42, {
      title: "Example",
      url: "https://example.test/",
      status: "loading",
    });
    lifecycle.remove("browser-a");
    const countAfterRemoval = transitions.length;

    lifecycle.update("browser-a", {
      title: "Late title",
      status: "complete",
    });
    lifecycle.activate("browser-a");
    lifecycle.remove("browser-a");

    expect(transitions).toHaveLength(countAfterRemoval);
    expect(lifecycle.snapshots).toEqual([]);
  });

  it("resolves live Electron contents IDs without exposing WebContents", () => {
    const lifecycle = new ExtensionTabLifecycle();
    const tab = lifecycle.attach("browser-a", 42, {
      title: "Example",
      url: "https://example.test/",
      status: "complete",
    });
    let destroyed = false;
    const manager = Object.create(TabManager.prototype) as TabManager;
    Object.assign(manager as unknown as Record<string, unknown>, {
      tabs: new Map([
        [
          "browser-a",
          {
            view: {
              webContents: {
                id: 42,
                isDestroyed: () => destroyed,
              },
            },
          },
        ],
      ]),
      order: ["browser-a"],
      extensionTabs: lifecycle,
    });

    expect(manager.getExtensionTabIdForWebContents(42)).toBe(tab.id);
    expect(manager.getExtensionTabIdForWebContents(41)).toBeNull();
    expect(manager.getExtensionTabIdForWebContents(Number.NaN)).toBeNull();
    expect(manager.getExtensionTabIdForWebContents(undefined)).toBeNull();

    destroyed = true;
    expect(manager.getExtensionTabIdForWebContents(42)).toBeNull();
  });

  it("rejects invalid and colliding Electron WebContents identifiers", () => {
    const lifecycle = new ExtensionTabLifecycle();
    lifecycle.attach("browser-a", 42, {
      title: "First",
      url: "https://example.test/first",
      status: "complete",
    });

    expect(() =>
      lifecycle.attach("browser-b", 42, {
        title: "Second",
        url: "https://example.test/second",
        status: "complete",
      }),
    ).toThrow("already attached");
    expect(() =>
      lifecycle.attach("browser-c", 0, {
        title: "Invalid",
        url: "",
        status: "complete",
      }),
    ).toThrow("positive integers");
  });

  it("activates an attached target after a virtual tab became active", () => {
    const lifecycle = new ExtensionTabLifecycle();
    const transitions: ExtensionTabTransition[] = [];
    lifecycle.subscribe((transition) => transitions.push(transition));

    lifecycle.activate("browser-a");
    lifecycle.attach("browser-a", 42, {
      title: "Example",
      url: "https://example.test/",
      status: "loading",
    });

    expect(transitions).toEqual([
      {
        type: "created",
        tab: {
          id: 42,
          active: false,
          title: "Example",
          url: "https://example.test/",
          status: "loading",
        },
      },
      { type: "activated", tabId: 42, previousTabId: null },
    ]);
  });
});
