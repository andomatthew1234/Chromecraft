import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  BookmarkEntry,
  BrowserDataSnapshot,
  ClosedTabEntry,
  HistoryEntry,
  QuickLinkEntry,
} from "../shared/browser";

export type {
  BookmarkEntry,
  BrowserDataSnapshot,
  ClosedTabEntry,
  HistoryEntry,
  QuickLinkEntry,
} from "../shared/browser";

const DATA_VERSION = 1;
const DEFAULT_MAX_HISTORY_ENTRIES = 10_000;
const DEFAULT_MAX_RECENTLY_CLOSED_TABS = 25;
const DEFAULT_MAX_PINNED_SHORTCUTS = 12;
const MAX_BOOKMARKS = 10_000;
const MAX_SESSION_TABS = 500;
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 1_024;
const MAX_FOLDER_LENGTH = 256;
const MAX_URL_LENGTH = 8_192;

export interface BookmarkInput {
  title: string;
  url: string;
  folder?: string;
}

export interface HistoryEntryInput {
  title: string;
  url: string;
  visitedAt?: Date;
  typed?: boolean;
}

export interface HistoryClearOptions {
  from?: Date;
  to?: Date;
}

export interface SessionTabInput {
  id: string;
  title: string;
  url: string;
  isNewTab: boolean;
  pinned?: boolean;
}

export interface SessionTab extends SessionTabInput {
  pinned: boolean;
}

export interface BrowserSessionSnapshot {
  tabs: SessionTab[];
  activeTabId: string | null;
  savedAt: number;
}

export interface RecentlyClosedTabInput {
  title: string;
  url: string;
  closedAt?: Date;
}

export interface QuickLinkInput {
  title: string;
  url: string;
}

export interface BrowserDataStoreOptions {
  maxHistoryEntries?: number;
  maxRecentlyClosedTabs?: number;
  maxQuickLinks?: number;
  /** @deprecated Use maxQuickLinks. */
  maxPinnedShortcuts?: number;
  now?: () => Date;
  generateId?: () => string;
}

interface PersistedBrowserData {
  version: typeof DATA_VERSION;
  bookmarks: BookmarkEntry[];
  history: HistoryEntry[];
  session: BrowserSessionSnapshot | null;
  recentlyClosed: ClosedTabEntry[];
  quickLinks: QuickLinkEntry[];
}

interface MutationResult<T> {
  result: T;
  changed: boolean;
}

function emptyData(): PersistedBrowserData {
  return {
    version: DATA_VERSION,
    bookmarks: [],
    history: [],
    session: null,
    recentlyClosed: [],
    quickLinks: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): string | null {
  if (typeof value !== "string" || value.length > maximumLength) {
    return null;
  }

  const cleaned = value.trim();
  return allowEmpty || cleaned.length > 0 ? cleaned : null;
}

function cleanId(value: unknown): string | null {
  return cleanString(value, MAX_ID_LENGTH);
}

function cleanTitle(value: unknown): string | null {
  return cleanString(value, MAX_TITLE_LENGTH);
}

function cleanWebUrl(value: unknown): string | null {
  const raw = cleanString(value, MAX_URL_LENGTH);
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function cleanTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function cloneData(value: PersistedBrowserData): PersistedBrowserData {
  return structuredClone(value);
}

function filterUniqueById<T extends { id: string }>(items: T[]): T[] {
  const ids = new Set<string>();
  return items.filter((item) => {
    if (ids.has(item.id)) {
      return false;
    }
    ids.add(item.id);
    return true;
  });
}

function validateBookmark(value: unknown): BookmarkEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = cleanId(value.id);
  const title = cleanTitle(value.title);
  const url = cleanWebUrl(value.url);
  const createdAt = cleanTimestamp(value.createdAt);
  const folder = cleanString(value.folder ?? "", MAX_FOLDER_LENGTH, true);

  return id && title && url && createdAt !== null && folder !== null
    ? { id, title, url, folder, createdAt }
    : null;
}

function validateHistoryEntry(value: unknown): HistoryEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = cleanId(value.id);
  const title = cleanTitle(value.title);
  const url = cleanWebUrl(value.url);
  const visitedAt = cleanTimestamp(value.visitedAt);
  return id && title && url && visitedAt !== null
    ? { id, title, url, visitedAt, typed: value.typed === true }
    : null;
}

function validateSessionTab(value: unknown): SessionTab | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = cleanId(value.id);
  const title = cleanTitle(value.title);
  const isNewTab = value.isNewTab === true;
  const rawUrl = cleanString(value.url, MAX_URL_LENGTH, true);
  const url =
    isNewTab && rawUrl === ""
      ? ""
      : (cleanWebUrl(rawUrl) ?? cleanGalleryUrl(rawUrl));

  return id && title && url !== null && typeof value.isNewTab === "boolean"
    ? {
        id,
        title,
        url,
        isNewTab,
        pinned: value.pinned === true,
      }
    : null;
}

function cleanGalleryUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "chromecraft:" || url.hostname !== "gallery")
      return null;
    const video = url.searchParams.get("video");
    if (video !== null && !/^[a-zA-Z0-9_-]{1,128}$/u.test(video)) return null;
    return `chromecraft://gallery/${video ? `?video=${encodeURIComponent(video)}` : ""}`;
  } catch {
    return null;
  }
}

function validateSession(value: unknown): BrowserSessionSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) {
    return null;
  }

  const tabs = filterUniqueById(
    value.tabs
      .slice(0, MAX_SESSION_TABS)
      .map(validateSessionTab)
      .filter((tab): tab is SessionTab => tab !== null),
  );
  const requestedActiveId =
    value.activeTabId === null ? null : cleanId(value.activeTabId);
  const activeTabId = tabs.some((tab) => tab.id === requestedActiveId)
    ? requestedActiveId
    : (tabs[0]?.id ?? null);
  const savedAt = cleanTimestamp(value.savedAt);

  return savedAt !== null ? { tabs, activeTabId, savedAt } : null;
}

function validateRecentlyClosedTab(value: unknown): ClosedTabEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = cleanId(value.id);
  const title = cleanTitle(value.title);
  const url = cleanWebUrl(value.url);
  const closedAt = cleanTimestamp(value.closedAt);
  return id && title && url && closedAt !== null
    ? { id, title, url, closedAt }
    : null;
}

function validateQuickLink(value: unknown): QuickLinkEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = cleanId(value.id);
  const title = cleanTitle(value.title);
  const url = cleanWebUrl(value.url);
  const createdAt = cleanTimestamp(value.createdAt);
  return id && title && url && createdAt !== null
    ? { id, title, url, createdAt }
    : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Storage limits must be positive integers.");
  }
  return value;
}

/**
 * Owns Chromecraft's local browser data. Call load() once before exposing the
 * store to the rest of the application. Returned objects are defensive copies.
 */
export class BrowserDataStore {
  private data = emptyData();
  private operationQueue: Promise<void> = Promise.resolve();
  private temporaryFileCounter = 0;
  private readonly maxHistoryEntries: number;
  private readonly maxRecentlyClosedTabs: number;
  private readonly maxPinnedShortcuts: number;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(
    private readonly filePath: string,
    options: BrowserDataStoreOptions = {},
  ) {
    this.maxHistoryEntries = positiveInteger(
      options.maxHistoryEntries,
      DEFAULT_MAX_HISTORY_ENTRIES,
    );
    this.maxRecentlyClosedTabs = positiveInteger(
      options.maxRecentlyClosedTabs,
      DEFAULT_MAX_RECENTLY_CLOSED_TABS,
    );
    this.maxPinnedShortcuts = positiveInteger(
      options.maxQuickLinks ?? options.maxPinnedShortcuts,
      DEFAULT_MAX_PINNED_SHORTCUTS,
    );
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
  }

  async load(): Promise<void> {
    await this.enqueue(async () => {
      try {
        const raw = await fs.readFile(this.filePath, "utf8");
        this.data = this.validateDocument(JSON.parse(raw) as unknown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(
            "Could not read browser data; an empty local store will be used.",
            error,
          );
        }
        this.data = emptyData();
      }
    });
  }

  get snapshot(): BrowserDataSnapshot {
    return this.getSnapshot();
  }

  getSnapshot(): BrowserDataSnapshot {
    return structuredClone({
      bookmarks: this.data.bookmarks,
      history: this.data.history,
      recentlyClosed: this.data.recentlyClosed,
      quickLinks: this.data.quickLinks,
    });
  }

  listBookmarks(): BookmarkEntry[] {
    return structuredClone(this.data.bookmarks);
  }

  searchBookmarks(query: string): BookmarkEntry[] {
    const needle = query.trim().toLocaleLowerCase();
    return structuredClone(
      needle.length === 0
        ? this.data.bookmarks
        : this.data.bookmarks.filter((bookmark) =>
            [bookmark.title, bookmark.url, bookmark.folder ?? ""].some((part) =>
              part.toLocaleLowerCase().includes(needle),
            ),
          ),
    );
  }

  async addBookmark(input: BookmarkInput): Promise<BookmarkEntry> {
    const bookmark: BookmarkEntry = {
      id: this.newId(),
      title: this.requireTitle(input.title),
      url: this.requireWebUrl(input.url),
      folder: this.optionalFolder(input.folder),
      createdAt: this.timestamp(),
    };

    return this.mutate((draft) => {
      if (draft.bookmarks.length >= MAX_BOOKMARKS) {
        throw new RangeError(`Bookmarks are limited to ${MAX_BOOKMARKS}.`);
      }
      draft.bookmarks.unshift(bookmark);
      return { result: structuredClone(bookmark), changed: true };
    });
  }

  async importBookmarks(inputs: BookmarkInput[]): Promise<number> {
    const bookmarks = inputs.slice(0, MAX_BOOKMARKS).map((input) => ({
      id: this.newId(),
      title: this.requireTitle(input.title),
      url: this.requireWebUrl(input.url),
      folder: this.optionalFolder(input.folder),
      createdAt: this.timestamp(),
    }));
    return this.mutate((draft) => {
      const capacity = Math.max(0, MAX_BOOKMARKS - draft.bookmarks.length);
      const accepted = bookmarks.slice(0, capacity);
      draft.bookmarks.unshift(...accepted);
      return { result: accepted.length, changed: accepted.length > 0 };
    });
  }

  async removeBookmark(id: string): Promise<boolean> {
    return this.removeById("bookmarks", id);
  }

  listHistory(): HistoryEntry[] {
    return structuredClone(this.data.history);
  }

  searchHistory(query: string): HistoryEntry[] {
    const needle = query.trim().toLocaleLowerCase();
    return structuredClone(
      needle.length === 0
        ? this.data.history
        : this.data.history.filter((entry) =>
            [entry.title, entry.url].some((part) =>
              part.toLocaleLowerCase().includes(needle),
            ),
          ),
    );
  }

  async recordHistory(input: HistoryEntryInput): Promise<HistoryEntry> {
    const entry: HistoryEntry = {
      id: this.newId(),
      title: this.requireTitle(input.title),
      url: this.requireWebUrl(input.url),
      visitedAt: this.timestamp(input.visitedAt),
      typed: input.typed === true,
    };

    return this.mutate((draft) => {
      draft.history.unshift(entry);
      draft.history.length = Math.min(
        draft.history.length,
        this.maxHistoryEntries,
      );
      return { result: structuredClone(entry), changed: true };
    });
  }

  async deleteHistoryEntry(id: string): Promise<boolean> {
    return this.removeById("history", id);
  }

  async clearHistory(options: HistoryClearOptions = {}): Promise<number> {
    const from = this.optionalDateBoundary(options.from, "from");
    const to = this.optionalDateBoundary(options.to, "to");
    if (from !== null && to !== null && from > to) {
      throw new RangeError("History range 'from' must not be after 'to'.");
    }

    return this.mutate((draft) => {
      const originalLength = draft.history.length;
      draft.history = draft.history.filter((entry) => {
        const timestamp = entry.visitedAt;
        const inRange =
          (from === null || timestamp >= from) &&
          (to === null || timestamp <= to);
        return !inRange;
      });
      const removed = originalLength - draft.history.length;
      return { result: removed, changed: removed > 0 };
    });
  }

  async saveSession(
    tabs: SessionTabInput[],
    activeTabId: string | null,
  ): Promise<BrowserSessionSnapshot> {
    if (tabs.length > MAX_SESSION_TABS) {
      throw new RangeError(`Sessions are limited to ${MAX_SESSION_TABS} tabs.`);
    }

    const seenIds = new Set<string>();
    const cleanedTabs = tabs.map((tab): SessionTab => {
      const id = this.requireId(tab.id);
      if (seenIds.has(id)) {
        throw new TypeError(`Session tab id '${id}' is duplicated.`);
      }
      seenIds.add(id);

      const url =
        tab.isNewTab && tab.url.trim() === ""
          ? ""
          : (cleanGalleryUrl(tab.url) ?? this.requireWebUrl(tab.url));
      return {
        id,
        title: this.requireTitle(tab.title),
        url,
        isNewTab: tab.isNewTab,
        pinned: tab.pinned === true,
      };
    });
    const cleanedActiveId =
      activeTabId !== null && seenIds.has(activeTabId)
        ? activeTabId
        : (cleanedTabs[0]?.id ?? null);
    const session: BrowserSessionSnapshot = {
      tabs: cleanedTabs,
      activeTabId: cleanedActiveId,
      savedAt: this.timestamp(),
    };

    return this.mutate((draft) => {
      draft.session = session;
      return { result: structuredClone(session), changed: true };
    });
  }

  loadSession(): BrowserSessionSnapshot | null {
    return this.data.session ? structuredClone(this.data.session) : null;
  }

  async clearSession(): Promise<boolean> {
    return this.mutate((draft) => {
      const changed = draft.session !== null;
      draft.session = null;
      return { result: changed, changed };
    });
  }

  listRecentlyClosedTabs(): ClosedTabEntry[] {
    return structuredClone(this.data.recentlyClosed);
  }

  async addRecentlyClosedTab(
    input: RecentlyClosedTabInput,
  ): Promise<ClosedTabEntry> {
    const entry: ClosedTabEntry = {
      id: this.newId(),
      title: this.requireTitle(input.title),
      url: this.requireWebUrl(input.url),
      closedAt: this.timestamp(input.closedAt),
    };

    return this.mutate((draft) => {
      draft.recentlyClosed.unshift(entry);
      draft.recentlyClosed.length = Math.min(
        draft.recentlyClosed.length,
        this.maxRecentlyClosedTabs,
      );
      return { result: structuredClone(entry), changed: true };
    });
  }

  async takeRecentlyClosedTab(id?: string): Promise<ClosedTabEntry | null> {
    return this.mutate((draft) => {
      const index = id
        ? draft.recentlyClosed.findIndex((tab) => tab.id === id)
        : 0;
      if (index < 0 || draft.recentlyClosed.length === 0) {
        return { result: null, changed: false };
      }
      const [entry] = draft.recentlyClosed.splice(index, 1);
      return {
        result: entry ? structuredClone(entry) : null,
        changed: entry !== undefined,
      };
    });
  }

  async clearRecentlyClosedTabs(): Promise<number> {
    return this.mutate((draft) => {
      const removed = draft.recentlyClosed.length;
      draft.recentlyClosed = [];
      return { result: removed, changed: removed > 0 };
    });
  }

  listQuickLinks(): QuickLinkEntry[] {
    return structuredClone(this.data.quickLinks);
  }

  async addQuickLink(input: QuickLinkInput): Promise<QuickLinkEntry> {
    const title = this.requireTitle(input.title);
    const url = this.requireWebUrl(input.url);

    return this.mutate((draft) => {
      const existing = draft.quickLinks.find(
        (shortcut) => shortcut.url === url,
      );
      if (existing) {
        const changed = existing.title !== title;
        existing.title = title;
        return { result: structuredClone(existing), changed };
      }
      if (draft.quickLinks.length >= this.maxPinnedShortcuts) {
        throw new RangeError(
          `Pinned shortcuts are limited to ${this.maxPinnedShortcuts}.`,
        );
      }

      const shortcut: QuickLinkEntry = {
        id: this.newId(),
        title,
        url,
        createdAt: this.timestamp(),
      };
      draft.quickLinks.push(shortcut);
      return { result: structuredClone(shortcut), changed: true };
    });
  }

  async removeQuickLink(id: string): Promise<boolean> {
    return this.removeById("quickLinks", id);
  }

  listPinnedShortcuts(): QuickLinkEntry[] {
    return this.listQuickLinks();
  }

  async pinShortcut(input: QuickLinkInput): Promise<QuickLinkEntry> {
    return this.addQuickLink(input);
  }

  async unpinShortcut(id: string): Promise<boolean> {
    return this.removeQuickLink(id);
  }

  private validateDocument(value: unknown): PersistedBrowserData {
    if (!isRecord(value) || value.version !== DATA_VERSION) {
      return emptyData();
    }

    const bookmarks = Array.isArray(value.bookmarks)
      ? filterUniqueById(
          value.bookmarks
            .slice(0, MAX_BOOKMARKS)
            .map(validateBookmark)
            .filter((entry): entry is BookmarkEntry => entry !== null),
        )
      : [];
    const history = Array.isArray(value.history)
      ? filterUniqueById(
          value.history
            .slice(0, this.maxHistoryEntries)
            .map(validateHistoryEntry)
            .filter((entry): entry is HistoryEntry => entry !== null),
        )
      : [];
    const recentlyClosed = Array.isArray(value.recentlyClosed)
      ? filterUniqueById(
          value.recentlyClosed
            .slice(0, this.maxRecentlyClosedTabs)
            .map(validateRecentlyClosedTab)
            .filter((entry): entry is ClosedTabEntry => entry !== null),
        )
      : [];
    const quickLinks = Array.isArray(value.quickLinks)
      ? filterUniqueById(
          value.quickLinks
            .slice(0, this.maxPinnedShortcuts)
            .map(validateQuickLink)
            .filter((entry): entry is QuickLinkEntry => entry !== null),
        )
      : [];

    return {
      version: DATA_VERSION,
      bookmarks,
      history,
      session: validateSession(value.session),
      recentlyClosed,
      quickLinks,
    };
  }

  private async mutate<T>(
    mutation: (draft: PersistedBrowserData) => MutationResult<T>,
  ): Promise<T> {
    let result!: T;
    await this.enqueue(async () => {
      const draft = cloneData(this.data);
      const outcome = mutation(draft);
      result = outcome.result;
      if (!outcome.changed) {
        return;
      }
      await this.writeAtomically(draft);
      this.data = draft;
    });
    return result;
  }

  private async removeById(
    collection: "bookmarks" | "history" | "quickLinks",
    id: string,
  ): Promise<boolean> {
    const clean = this.requireId(id);
    return this.mutate((draft) => {
      const index = draft[collection].findIndex((entry) => entry.id === clean);
      if (index < 0) {
        return { result: false, changed: false };
      }
      draft[collection].splice(index, 1);
      return { result: true, changed: true };
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.catch(() => undefined);
    return next;
  }

  private async writeAtomically(data: PersistedBrowserData): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${++this.temporaryFileCounter}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private newId(): string {
    return this.requireId(this.generateId());
  }

  private requireId(value: unknown): string {
    const clean = cleanId(value);
    if (!clean) {
      throw new TypeError("A valid non-empty id is required.");
    }
    return clean;
  }

  private requireTitle(value: unknown): string {
    const clean = cleanTitle(value);
    if (!clean) {
      throw new TypeError("A valid non-empty title is required.");
    }
    return clean;
  }

  private requireWebUrl(value: unknown): string {
    const clean = cleanWebUrl(value);
    if (!clean) {
      throw new TypeError("A valid HTTP or HTTPS URL is required.");
    }
    return clean;
  }

  private optionalFolder(value: unknown): string {
    if (value === undefined || value === null || value === "") {
      return "";
    }
    const clean = cleanString(value, MAX_FOLDER_LENGTH);
    if (!clean) {
      throw new TypeError("Bookmark folder is invalid.");
    }
    return clean;
  }

  private timestamp(value: Date = this.now()): number {
    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) {
      throw new TypeError("A valid date is required.");
    }
    return timestamp;
  }

  private optionalDateBoundary(
    value: Date | undefined,
    name: string,
  ): number | null {
    if (value === undefined) {
      return null;
    }
    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) {
      throw new TypeError(`History boundary '${name}' must be a valid date.`);
    }
    return timestamp;
  }
}
