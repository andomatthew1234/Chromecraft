import { describe, expect, it } from "vitest";

import {
  ExtensionTabLifecycle,
  isWebsiteFullscreenPermissionAllowed,
  normalizeOnboardingPageBounds,
  shouldBlockOfflineArchiveNavigation,
  TabManager,
  type ExtensionTabTransition,
} from "./tab-manager";
import { SplitViewState } from "./split-view-state";

describe("onboarding page bounds", () => {
  it("keeps a valid renderer frame inside the native window", () => {
    expect(
      normalizeOnboardingPageBounds(
        { x: 900, y: 700, width: 500, height: 400 },
        { x: 0, y: 0, width: 1_000, height: 800 },
      ),
    ).toEqual({ x: 488, y: 388, width: 500, height: 400 });
  });

  it("rejects undersized and non-finite renderer frames", () => {
    expect(() =>
      normalizeOnboardingPageBounds(
        { x: 0, y: 0, width: 319, height: 240 },
        { x: 0, y: 0, width: 1_000, height: 800 },
      ),
    ).toThrow("invalid");
    expect(() =>
      normalizeOnboardingPageBounds(
        { x: Number.NaN, y: 0, width: 500, height: 400 },
        { x: 0, y: 0, width: 1_000, height: 800 },
      ),
    ).toThrow("invalid");
  });
});

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

describe("Gallery tabs", () => {
  it("creates a new sidebar tab and keeps player navigation in the active Gallery tab", () => {
    const first = {
      id: "gallery-a",
      title: "My Gallery",
      url: "chromecraft://gallery/",
      requestedUrl: "chromecraft://gallery/",
      isNewTab: false,
    };
    const tabs = new Map([[first.id, first]]);
    const manager = Object.create(TabManager.prototype) as TabManager;
    Object.assign(manager as unknown as Record<string, unknown>, {
      tabs,
      order: [first.id],
      activeTabId: first.id,
      activateTab(tabId: string) {
        Object.assign(manager as unknown as Record<string, unknown>, {
          activeTabId: tabId,
        });
      },
      emitSnapshot() {},
      scheduleSessionSave() {},
    });

    const secondId = manager.openGallery("video-1", true);
    expect(secondId).not.toBe(first.id);
    expect(tabs).toHaveLength(2);

    expect(manager.openGallery("video-2")).toBe(secondId);
    expect(tabs).toHaveLength(2);
    expect(tabs.get(secondId)?.url).toBe(
      "chromecraft://gallery/?video=video-2",
    );
    expect(tabs.get(first.id)?.url).toBe("chromecraft://gallery/");
  });
});

describe("Offline Pages tabs", () => {
  it("keeps archived documents inside their isolated offline origin", () => {
    expect(
      shouldBlockOfflineArchiveNavigation(
        "chromecraft-offline://archive-1/index.html",
        "https://tracker.example/redirect",
      ),
    ).toBe(true);
    expect(
      shouldBlockOfflineArchiveNavigation(
        "chromecraft-offline://archive-1/index.html",
        "chromecraft-offline://archive-2/index.html",
      ),
    ).toBe(true);
    expect(
      shouldBlockOfflineArchiveNavigation(
        "chromecraft-offline://archive-1/index.html",
        "chromecraft-offline://archive-1/index_files/details.html",
      ),
    ).toBe(false);
    expect(
      shouldBlockOfflineArchiveNavigation(
        "https://example.com/",
        "https://other.example/",
      ),
    ).toBe(false);
  });

  it("creates a dedicated library tab and reuses it for library selection", () => {
    const first = {
      id: "new-tab",
      title: "New Tab",
      url: "",
      requestedUrl: "",
      isNewTab: true,
      view: null,
    };
    const tabs = new Map([[first.id, first]]);
    const manager = Object.create(TabManager.prototype) as TabManager;
    Object.assign(manager as unknown as Record<string, unknown>, {
      tabs,
      order: [first.id],
      activeTabId: first.id,
      smartReaderDocuments: { removeUrl() {} },
      activateTab(tabId: string) {
        Object.assign(manager as unknown as Record<string, unknown>, {
          activeTabId: tabId,
        });
      },
      emitSnapshot() {},
      scheduleSessionSave() {},
    });

    const libraryId = manager.openOfflinePages("archive-1", true);
    expect(libraryId).not.toBe(first.id);
    expect(tabs.get(libraryId)?.url).toBe(
      "chromecraft://offline-pages/?page=archive-1",
    );

    expect(manager.openOfflinePages("archive-2")).toBe(libraryId);
    expect(tabs).toHaveLength(2);
    expect(tabs.get(libraryId)?.url).toBe(
      "chromecraft://offline-pages/?page=archive-2",
    );
  });
});

describe("tab organization", () => {
  function organizedManager() {
    const tabs = new Map(
      ["a", "b", "c"].map((id) => [
        id,
        {
          id,
          title: `Tab ${id.toUpperCase()}`,
          url: `https://${id}.example/`,
          groupId: null,
          pinned: false,
          view: null,
        },
      ]),
    );
    const manager = Object.create(TabManager.prototype) as TabManager;
    Object.assign(manager as unknown as Record<string, unknown>, {
      tabs,
      order: ["a", "b", "c"],
      tabGroups: new Map(),
      selectedTabIds: new Set(["a"]),
      aiTabOrganizationMutationInProgress: false,
      tabTopologyMutationOperations: 0,
      selectionAnchorId: "a",
      activeTabId: "a",
      splitView: new SplitViewState(),
      getRendererMemoryByProcessId: () => new Map(),
      browserData: {
        searchRecentlyClosedTabs: () => [],
        listSavedTabGroups: () => [],
      },
      preferences: { snapshot: { restoreSession: false } },
      sessionTimer: null,
      onBrowserDataChanged() {},
      emitSnapshot() {},
      scheduleSessionSave() {},
    });
    return { manager, tabs };
  }

  it("groups, range-selects, moves, and ungroups tabs deterministically", () => {
    const { manager, tabs } = organizedManager();
    const groupId = manager.createTabGroup(["b", "c"], "Research", "blue");

    expect(tabs.get("b")?.groupId).toBe(groupId);
    manager.selectTabs(["c"], "range");
    expect(
      (manager as unknown as { selectedTabIds: Set<string> }).selectedTabIds,
    ).toEqual(new Set(["a", "b", "c"]));

    manager.moveTabs(["b", "c"], 0, null);
    expect((manager as unknown as { order: string[] }).order).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(tabs.get("b")?.groupId).toBeNull();
    expect(
      (manager as unknown as { tabGroups: Map<string, unknown> }).tabGroups,
    ).toHaveLength(0);
    manager.selectTabs([], "replace");
    expect(
      (manager as unknown as { selectedTabIds: Set<string> }).selectedTabIds,
    ).toEqual(new Set());
  });

  it("keeps newly grouped tabs contiguous in their authoritative order", () => {
    const { manager } = organizedManager();

    manager.createTabGroup(["c", "a"], "Research", "blue");

    expect((manager as unknown as { order: string[] }).order).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("moves away from an active group before collapsing it", async () => {
    const { manager } = organizedManager();
    const groupId = manager.createTabGroup(["a", "b"], "Research", "blue");
    const activated: string[] = [];
    Object.assign(manager as unknown as Record<string, unknown>, {
      activateTab(tabId: string) {
        activated.push(tabId);
        Object.assign(manager as unknown as Record<string, unknown>, {
          activeTabId: tabId,
        });
      },
    });

    await manager.updateTabGroup(groupId, { collapsed: true });

    expect(activated).toEqual(["c"]);
    expect(
      (
        manager as unknown as {
          tabGroups: Map<string, { collapsed: boolean }>;
        }
      ).tabGroups.get(groupId)?.collapsed,
    ).toBe(true);
  });

  it("keeps an active group expanded when no visible tab exists", async () => {
    const { manager } = organizedManager();
    const groupId = manager.createTabGroup(
      ["a", "b", "c"],
      "Everything",
      "blue",
    );

    await manager.updateTabGroup(groupId, { collapsed: true });

    expect(
      (
        manager as unknown as {
          tabGroups: Map<string, { collapsed: boolean }>;
        }
      ).tabGroups.get(groupId)?.collapsed,
    ).toBe(false);
  });

  it("syncs saved groups affected by membership changes", async () => {
    const { manager } = organizedManager();
    const synced: Array<{ id: string; tabs: Array<{ url: string }> }> = [];
    Object.assign(manager as unknown as Record<string, unknown>, {
      browserData: {
        listSavedTabGroups: () => [],
        upsertSavedTabGroup: async (entry: {
          id: string;
          tabs: Array<{ url: string }>;
        }) => {
          synced.push(structuredClone(entry));
          return entry;
        },
      },
    });
    const groupId = manager.createTabGroup(["a", "b"], "Saved", "green");
    await manager.updateTabGroup(groupId, { saved: true });
    synced.splice(0);

    manager.moveTabs(["c"], 2, groupId);
    await Promise.resolve();

    expect(synced.at(-1)).toEqual(
      expect.objectContaining({
        id: groupId,
        tabs: [
          expect.objectContaining({ url: "https://a.example/" }),
          expect.objectContaining({ url: "https://b.example/" }),
          expect.objectContaining({ url: "https://c.example/" }),
        ],
      }),
    );
  });

  it("expands a collapsed destination when the active tab moves into it", () => {
    const { manager } = organizedManager();
    const groupId = manager.createTabGroup(["b", "c"], "Research", "blue");
    const groups = (
      manager as unknown as {
        tabGroups: Map<string, { collapsed: boolean }>;
      }
    ).tabGroups;
    const group = groups.get(groupId);
    if (!group) throw new Error("Missing tab group.");
    group.collapsed = true;

    manager.moveTabs(["a"], 0, groupId);

    expect(group.collapsed).toBe(false);
  });

  it("preserves collapsed groups when reopening a closed window", async () => {
    const manager = Object.create(TabManager.prototype) as TabManager;
    const tabs = new Map<string, Record<string, unknown>>();
    let nextTab = 0;
    Object.assign(manager as unknown as Record<string, unknown>, {
      tabs,
      order: [],
      tabGroups: new Map(),
      selectedTabIds: new Set(),
      activeTabId: "",
      splitView: new SplitViewState(),
      tabTopologyMutationOperations: 0,
      aiTabOrganizationMutationInProgress: false,
      browserData: {
        takeRecentlyClosedWindow: async () => ({
          id: "closed-window",
          tabs: [
            {
              id: "old-tab",
              title: "Restored tab",
              url: "https://example.com/",
              isNewTab: false,
              pinned: false,
              groupId: "old-group",
            },
          ],
          tabGroups: [
            {
              id: "old-group",
              name: "Collapsed",
              color: "purple",
              collapsed: true,
              saved: false,
              createdAt: 1,
            },
          ],
          activeTabId: "old-tab",
          closedAt: 2,
        }),
      },
      createTab(url: string) {
        const id = `restored-${(nextTab += 1)}`;
        tabs.set(id, { id, url, groupId: null, pinned: false });
        (manager as unknown as { order: string[] }).order.push(id);
        return id;
      },
      activateTab(tabId: string) {
        Object.assign(manager as unknown as Record<string, unknown>, {
          activeTabId: tabId,
        });
      },
      onBrowserDataChanged() {},
      emitSnapshot() {},
      scheduleSessionSave() {},
    });

    await manager.reopenClosedWindow();

    expect(
      [
        ...(
          manager as unknown as {
            tabGroups: Map<string, { collapsed: boolean }>;
          }
        ).tabGroups.values(),
      ][0]?.collapsed,
    ).toBe(true);
  });

  it("pins selected tabs first while preserving their relative order", () => {
    const { manager, tabs } = organizedManager();
    manager.setTabsPinned(["c", "b"], true);

    expect((manager as unknown as { order: string[] }).order).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(tabs.get("b")?.pinned).toBe(true);
    expect(tabs.get("c")?.pinned).toBe(true);
  });

  it("counts website tabs even when an internal Settings tab is active", () => {
    const { manager, tabs } = organizedManager();
    tabs.set("settings", {
      id: "settings",
      title: "Settings",
      url: "",
      groupId: null,
      pinned: false,
      view: null,
    });
    Object.assign(manager as unknown as Record<string, unknown>, {
      order: ["a", "b", "settings"],
      activeTabId: "settings",
    });

    const context = manager.getAiTabOrganizationContext();

    expect(context.candidates.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(context.preservedTabIds).toEqual(["settings"]);
  });

  it("keeps a saved group restorable when its live tabs are closed", async () => {
    const { manager } = organizedManager();
    const saved: Array<Record<string, unknown>> = [];
    let removed = false;
    let closed: string[] = [];
    Object.assign(manager as unknown as Record<string, unknown>, {
      browserData: {
        listSavedTabGroups: () => structuredClone(saved),
        upsertSavedTabGroup: async (entry: Record<string, unknown>) => {
          saved.splice(0, saved.length, { ...entry });
          return entry;
        },
        removeSavedTabGroup: async () => {
          removed = true;
          return true;
        },
      },
      closeTabs(tabIds: string[]) {
        closed = [...tabIds];
      },
    });
    const groupId = manager.createTabGroup(["b", "c"], "Saved", "green");
    await manager.updateTabGroup(groupId, { saved: true });
    await manager.deleteTabGroup(groupId, true);

    expect(closed).toEqual(["b", "c"]);
    expect(saved).toHaveLength(1);
    expect(removed).toBe(false);
  });

  it("searches open tabs and recently closed entries together", () => {
    const { manager } = organizedManager();
    Object.assign(manager as unknown as Record<string, unknown>, {
      browserData: {
        searchRecentlyClosedTabs: () => [
          {
            id: "closed-1",
            title: "Closed docs",
            url: "https://closed.example/",
            closedAt: 10,
            pinned: false,
            groupId: null,
            groupName: null,
            groupColor: null,
          },
        ],
      },
    });

    const results = manager.searchTabs("closed");
    expect(results).toEqual([
      expect.objectContaining({
        kind: "recently-closed",
        id: "closed-1",
        tabId: null,
      }),
    ]);
  });

  it("sanitises AI context and applies and undoes a validated plan atomically", async () => {
    const { manager, tabs } = organizedManager();
    const first = tabs.get("a");
    if (!first) throw new Error("Missing test tab.");
    first.title = "  Account\u0000 overview  ";
    first.url =
      "https://person:secret@a.example/private/path?token=hidden#fragment";
    const protectedTab = tabs.get("c");
    if (!protectedTab) throw new Error("Missing test tab.");
    protectedTab.pinned = true;

    const context = manager.getAiTabOrganizationContext();

    expect(context.candidates).toEqual([
      {
        id: "a",
        title: "Account overview",
        hostname: "a.example",
        pathHint: "/private/path",
      },
      expect.objectContaining({ id: "b", hostname: "b.example" }),
    ]);
    expect(JSON.stringify(context)).not.toContain("secret");
    expect(JSON.stringify(context)).not.toContain("hidden");
    expect(JSON.stringify(context)).not.toContain("fragment");
    expect(context.preservedTabIds).toEqual(["c"]);

    const applied = await manager.applyAiTabOrganization({
      revision: context.revision,
      groups: [{ name: "Accounts", color: "blue", tabIds: ["a", "b"] }],
      ungroupedTabIds: [],
    });
    const groupId = tabs.get("a")?.groupId;
    expect(groupId).toBeTruthy();
    expect(tabs.get("b")?.groupId).toBe(groupId);
    expect(tabs.get("c")?.groupId).toBeNull();

    await manager.undoAiTabOrganization(applied.undoToken);
    expect(tabs.get("a")?.groupId).toBeNull();
    expect(tabs.get("b")?.groupId).toBeNull();
  });

  it("rejects a stale AI plan without changing the tab layout", async () => {
    const { manager, tabs } = organizedManager();
    const context = manager.getAiTabOrganizationContext();
    const changed = tabs.get("a");
    if (!changed) throw new Error("Missing test tab.");
    changed.title = "Changed while thinking";

    await expect(
      manager.applyAiTabOrganization({
        revision: context.revision,
        groups: [{ name: "Work", color: "green", tabIds: ["a", "b"] }],
        ungroupedTabIds: ["c"],
      }),
    ).rejects.toThrow("changed while the plan was open");
    expect([...tabs.values()].map((tab) => tab.groupId)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("keeps Scout Undo available across normal title and URL changes", async () => {
    const { manager, tabs } = organizedManager();
    const context = manager.getAiTabOrganizationContext();
    const applied = await manager.applyAiTabOrganization({
      revision: context.revision,
      groups: [{ name: "Work", color: "green", tabIds: ["a", "b"] }],
      ungroupedTabIds: ["c"],
    });
    const changed = tabs.get("a");
    if (!changed) throw new Error("Missing test tab.");
    changed.title = "A page changed its title";
    changed.url = "https://a.example/another-page";

    await expect(
      manager.undoAiTabOrganization(applied.undoToken),
    ).resolves.toMatchObject({ organisedTabCount: 3 });
    expect(tabs.get("a")?.groupId).toBeNull();
    expect(tabs.get("b")?.groupId).toBeNull();
  });

  it("keeps AI-created group members contiguous around protected tabs", async () => {
    const { manager, tabs } = organizedManager();
    const protectedTab = tabs.get("b");
    if (!protectedTab) throw new Error("Missing test tab.");
    protectedTab.url = "chromecraft://gallery/";
    const context = manager.getAiTabOrganizationContext();

    await manager.applyAiTabOrganization({
      revision: context.revision,
      groups: [{ name: "Work", color: "green", tabIds: ["a", "c"] }],
      ungroupedTabIds: [],
    });

    expect((manager as unknown as { order: string[] }).order).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(tabs.get("a")?.groupId).toBe(tabs.get("c")?.groupId);
    expect(tabs.get("b")?.groupId).toBeNull();
  });

  it("locks concurrent topology mutations until an AI apply is persisted", async () => {
    const { manager, tabs } = organizedManager();
    let release!: () => void;
    const persistence = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(manager as unknown as Record<string, unknown>, {
      flushSession: () => persistence,
    });
    const context = manager.getAiTabOrganizationContext();
    const applying = manager.applyAiTabOrganization({
      revision: context.revision,
      groups: [{ name: "Work", color: "blue", tabIds: ["a", "b"] }],
      ungroupedTabIds: ["c"],
    });

    expect(() => manager.setTabsPinned(["a"], true)).toThrow(
      "Tabs are being organised",
    );
    expect(() => manager.moveTabs(["c"], 0)).toThrow(
      "Tabs are being organised",
    );
    await expect(manager.reopenClosedTab()).rejects.toThrow(
      "Tabs are being organised",
    );
    release();
    await applying;
    expect(tabs.get("a")?.pinned).toBe(false);
  });

  it("rolls back the complete AI topology when persistence fails", async () => {
    const { manager, tabs } = organizedManager();
    let fail!: (error: Error) => void;
    const persistence = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    Object.assign(manager as unknown as Record<string, unknown>, {
      flushSession: () => persistence,
    });
    const context = manager.getAiTabOrganizationContext();
    const applying = manager.applyAiTabOrganization({
      revision: context.revision,
      groups: [{ name: "Work", color: "blue", tabIds: ["a", "b"] }],
      ungroupedTabIds: ["c"],
    });
    const rejected = expect(applying).rejects.toThrow("disk full");

    expect(() => manager.closeTab("c")).toThrow("Tabs are being organised");
    fail(new Error("disk full"));
    await rejected;
    expect((manager as unknown as { order: string[] }).order).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect([...tabs.values()].map((tab) => tab.groupId)).toEqual([
      null,
      null,
      null,
    ]);
    expect([...tabs.values()].map((tab) => tab.pinned)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("does not let AI start while a destructive restore lookup is in flight", async () => {
    const { manager } = organizedManager();
    let finishLookup!: () => void;
    const lookup = new Promise<null>((resolve) => {
      finishLookup = () => resolve(null);
    });
    Object.assign(manager as unknown as Record<string, unknown>, {
      browserData: {
        takeRecentlyClosedTab: () => lookup,
        listSavedTabGroups: () => [],
      },
    });
    const restoring = manager.reopenClosedTab();
    const context = manager.getAiTabOrganizationContext();

    await expect(
      manager.applyAiTabOrganization({
        revision: context.revision,
        groups: [{ name: "Work", color: "blue", tabIds: ["a", "b"] }],
        ungroupedTabIds: ["c"],
      }),
    ).rejects.toThrow("Tabs are changing");
    finishLookup();
    await expect(restoring).resolves.toBeNull();
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
