import { describe, expect, it } from "vitest";

import {
  ExtensionTabLifecycle,
  TabManager,
  type ExtensionTabTransition,
} from "./tab-manager";

describe("ExtensionTabLifecycle", () => {
  it("assigns stable, unique positive integer identifiers", () => {
    const lifecycle = new ExtensionTabLifecycle();
    const first = lifecycle.create("browser-a", {
      title: "First",
      url: "https://example.test/first",
      status: "complete",
    });
    const second = lifecycle.create("browser-b", {
      title: "Second",
      url: "https://example.test/second",
      status: "complete",
    });

    expect(Number.isSafeInteger(first.id)).toBe(true);
    expect(first.id).toBeGreaterThan(0);
    expect(second.id).toBeGreaterThan(first.id);
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

    const created = lifecycle.create("browser-a", {
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
    lifecycle.create("browser-a", {
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
    const tab = lifecycle.create("browser-a", {
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
});
