import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrowserDataStore } from "./browser-data";

describe("BrowserDataStore", () => {
  let directory: string;
  let filePath: string;
  let nextId: number;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "chromecraft-data-"));
    filePath = path.join(directory, "browser-data.json");
    nextId = 0;
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  function createStore(
    options: {
      maxHistoryEntries?: number;
      maxRecentlyClosedTabs?: number;
      maxQuickLinks?: number;
    } = {},
  ): BrowserDataStore {
    return new BrowserDataStore(filePath, {
      ...options,
      generateId: () => `id-${++nextId}`,
      now: () => new Date("2026-10-15T00:00:00.000Z"),
    });
  }

  it("persists and searches bookmarks without leaking mutable references", async () => {
    const store = createStore();
    await store.load();
    const bookmark = await store.addBookmark({
      title: "Electron Documentation",
      url: "https://electronjs.org/docs",
      folder: "Development",
    });

    expect(store.searchBookmarks("develop")).toEqual([bookmark]);
    const listed = store.listBookmarks();
    listed[0]!.title = "mutated";
    expect(store.listBookmarks()[0]!.title).toBe("Electron Documentation");

    const reloaded = createStore();
    await reloaded.load();
    expect(reloaded.searchBookmarks("electronjs.org")).toHaveLength(1);
    expect(await reloaded.removeBookmark(bookmark.id)).toBe(true);
    expect(await reloaded.removeBookmark(bookmark.id)).toBe(false);
  });

  it("imports bookmarks in one bounded mutation", async () => {
    const store = createStore();
    await store.load();
    const imported = await store.importBookmarks([
      { title: "One", url: "https://example.com/one", folder: "Examples" },
      { title: "Two", url: "https://example.com/two" },
    ]);

    expect(imported).toBe(2);
    expect(store.listBookmarks().map((bookmark) => bookmark.title)).toEqual([
      "One",
      "Two",
    ]);
    const reloaded = createStore();
    await reloaded.load();
    expect(reloaded.listBookmarks()).toHaveLength(2);
  });

  it("records bounded history and supports deletion and time-range clearing", async () => {
    const store = createStore({ maxHistoryEntries: 3 });
    await store.load();

    const first = await store.recordHistory({
      title: "First",
      url: "https://example.com/first",
      visitedAt: new Date("2026-10-15T01:00:00Z"),
      typed: true,
    });
    await store.recordHistory({
      title: "Second",
      url: "https://example.com/second",
      visitedAt: new Date("2026-10-15T02:00:00Z"),
    });
    await store.recordHistory({
      title: "Third",
      url: "https://example.com/third",
      visitedAt: new Date("2026-10-15T03:00:00Z"),
    });
    await store.recordHistory({
      title: "Newest",
      url: "https://example.com/newest",
      visitedAt: new Date("2026-10-15T04:00:00Z"),
    });

    expect(store.listHistory().map((entry) => entry.title)).toEqual([
      "Newest",
      "Third",
      "Second",
    ]);
    expect(store.listHistory().find((entry) => entry.title === "First")).toBe(
      undefined,
    );
    expect(await store.deleteHistoryEntry(first.id)).toBe(false);
    expect(
      await store.clearHistory({
        from: new Date("2026-10-15T02:30:00Z"),
        to: new Date("2026-10-15T03:30:00Z"),
      }),
    ).toBe(1);
    expect(store.searchHistory("second")).toHaveLength(1);
    expect(await store.clearHistory()).toBe(2);
  });

  it("persists typed-navigation evidence and defaults legacy entries safely", async () => {
    const store = createStore();
    await store.load();
    await store.recordHistory({
      title: "Typed",
      url: "https://typed.example/",
      typed: true,
    });
    const reloaded = createStore();
    await reloaded.load();
    expect(reloaded.listHistory()[0]?.typed).toBe(true);

    const persisted = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      history: Array<Record<string, unknown>>;
    };
    delete persisted.history[0]!.typed;
    await fs.writeFile(filePath, JSON.stringify(persisted), "utf8");
    const legacy = createStore();
    await legacy.load();
    expect(legacy.listHistory()[0]?.typed).toBe(false);
  });

  it("saves a validated session and returns a defensive snapshot", async () => {
    const store = createStore();
    await store.load();
    const saved = await store.saveSession(
      [
        {
          id: "tab-1",
          title: "New tab",
          url: "",
          isNewTab: true,
        },
        {
          id: "tab-2",
          title: "Example",
          url: "https://example.com",
          isNewTab: false,
          pinned: true,
        },
      ],
      "tab-2",
    );

    expect(saved.activeTabId).toBe("tab-2");
    expect(saved.tabs[1]!.pinned).toBe(true);
    saved.tabs[0]!.title = "changed";
    expect(store.loadSession()?.tabs[0]?.title).toBe("New tab");
    expect(await store.clearSession()).toBe(true);
    expect(store.loadSession()).toBeNull();
  });

  it("caps recently closed tabs and consumes them newest-first", async () => {
    const store = createStore({ maxRecentlyClosedTabs: 2 });
    await store.load();
    await store.addRecentlyClosedTab({
      title: "One",
      url: "https://example.com/one",
    });
    await store.addRecentlyClosedTab({
      title: "Two",
      url: "https://example.com/two",
    });
    const newest = await store.addRecentlyClosedTab({
      title: "Three",
      url: "https://example.com/three",
    });

    expect(store.listRecentlyClosedTabs().map((tab) => tab.title)).toEqual([
      "Three",
      "Two",
    ]);
    expect(await store.takeRecentlyClosedTab()).toEqual(newest);
    expect(store.listRecentlyClosedTabs().map((tab) => tab.title)).toEqual([
      "Two",
    ]);
  });

  it("upserts pinned shortcuts by URL and enforces their limit", async () => {
    const store = createStore({ maxQuickLinks: 1 });
    await store.load();
    const original = await store.pinShortcut({
      title: "Example",
      url: "https://example.com",
    });
    const renamed = await store.pinShortcut({
      title: "Example Home",
      url: "https://example.com/",
    });

    expect(renamed.id).toBe(original.id);
    expect(store.listPinnedShortcuts()[0]!.title).toBe("Example Home");
    await expect(
      store.pinShortcut({ title: "Other", url: "https://other.example" }),
    ).rejects.toThrow(RangeError);
    expect(await store.unpinShortcut(original.id)).toBe(true);
  });

  it("defensively filters malformed persisted JSON", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        bookmarks: [
          {
            id: "good",
            title: "Good",
            url: "https://example.com",
            folder: "",
            createdAt: 1_760_486_400_000,
          },
          {
            id: "script",
            title: "Unsafe",
            url: "javascript:alert(1)",
            folder: "",
            createdAt: 1_760_486_400_000,
          },
          null,
        ],
        history: "not-an-array",
        session: { tabs: "not-an-array" },
        recentlyClosed: [],
        quickLinks: [],
      }),
      "utf8",
    );
    const store = createStore();
    await store.load();

    expect(store.listBookmarks().map((bookmark) => bookmark.id)).toEqual([
      "good",
    ]);
    expect(store.listHistory()).toEqual([]);
    expect(store.loadSession()).toBeNull();
  });

  it("serializes concurrent writes and leaves valid atomic JSON", async () => {
    const store = createStore({ maxHistoryEntries: 50 });
    await store.load();
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        store.recordHistory({
          title: `Page ${index}`,
          url: `https://example.com/${index}`,
        }),
      ),
    );

    const persisted = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      history: unknown[];
    };
    expect(persisted.history).toHaveLength(30);
    expect(store.listHistory()).toHaveLength(30);
    expect(
      (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("rejects invalid URLs, dates, duplicate session IDs, and limits", async () => {
    expect(
      () => new BrowserDataStore(filePath, { maxHistoryEntries: 0 }),
    ).toThrow(RangeError);

    const store = createStore();
    await store.load();
    await expect(
      store.addBookmark({ title: "Unsafe", url: "javascript:alert(1)" }),
    ).rejects.toThrow(TypeError);
    await expect(
      store.recordHistory({
        title: "Invalid date",
        url: "https://example.com",
        visitedAt: new Date(Number.NaN),
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      store.saveSession(
        [
          { id: "same", title: "One", url: "", isNewTab: true },
          { id: "same", title: "Two", url: "", isNewTab: true },
        ],
        "same",
      ),
    ).rejects.toThrow(/duplicated/);
  });
});
