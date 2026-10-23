import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  OfflinePageEntrySnapshot,
  OfflinePagesSnapshot,
} from "../shared/offline-pages";
import {
  emptyOfflinePageSave,
  offlinePageArchiveUrl,
  offlinePageThumbnailUrl,
} from "../shared/offline-pages";

const DOCUMENT_VERSION = 1;
const ENTRY_ID_PATTERN = /^[a-z0-9_-]{1,128}$/u;
const MAX_TITLE_LENGTH = 240;
const MAX_URL_LENGTH = 8_192;
const DEFAULT_MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_DEPTH = 32;
const MAX_HTML_BYTES = 64 * 1024 ** 2;
const MIN_FREE_SPACE_RESERVE = 256 * 1024 ** 2;

interface PersistedOfflinePages {
  version: typeof DOCUMENT_VERSION;
  items: OfflinePageEntrySnapshot[];
}

export interface OfflinePageCaptureSource {
  tabId: string;
  title: string;
  sourceUrl: string;
  saveCompletePage(destinationHtml: string): Promise<void>;
  capturePreview(): Promise<Buffer | null>;
  assertUnchanged(): void;
}

export interface OfflinePageStoreOptions {
  directory: string;
  now?: () => number;
  generateId?: () => string;
  maxArchiveBytes?: number;
  maxFiles?: number;
  maxDepth?: number;
  onChange?: (snapshot: OfflinePagesSnapshot) => void;
}

interface ArchiveInspection {
  bytes: number;
  files: number;
}

function emptyDocument(): PersistedOfflinePages {
  return { version: DOCUMENT_VERSION, items: [] };
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function cleanTitle(value: string): string {
  const title = value
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
  return title || "Saved page";
}

function cleanSourceUrl(value: string): string {
  if (value.length > MAX_URL_LENGTH)
    throw new TypeError("The page URL is too long.");
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Only web pages can be saved for offline use.");
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

function cleanEntry(value: unknown): OfflinePageEntrySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<OfflinePageEntrySnapshot>;
  if (
    typeof item.id !== "string" ||
    !ENTRY_ID_PATTERN.test(item.id) ||
    typeof item.title !== "string" ||
    typeof item.sourceUrl !== "string" ||
    typeof item.savedAt !== "number" ||
    !Number.isFinite(item.savedAt) ||
    typeof item.fileSize !== "number" ||
    !Number.isSafeInteger(item.fileSize) ||
    item.fileSize < 0
  ) {
    return null;
  }
  let sourceUrl: string;
  try {
    sourceUrl = cleanSourceUrl(item.sourceUrl);
  } catch {
    return null;
  }
  return {
    id: item.id,
    title: cleanTitle(item.title),
    sourceUrl,
    archiveUrl: offlinePageArchiveUrl(item.id),
    savedAt: item.savedAt,
    fileSize: item.fileSize,
    thumbnailUrl:
      item.thumbnailUrl === null || typeof item.thumbnailUrl === "string"
        ? item.thumbnailUrl
          ? offlinePageThumbnailUrl(item.id)
          : null
        : null,
    available: item.available === true,
  };
}

/**
 * Owns complete-page captures, their metadata and all filesystem confinement.
 * Renderers address archives exclusively by opaque entry IDs.
 */
export class OfflinePageStore {
  private readonly directory: string;
  private readonly archivesDirectory: string;
  private readonly indexPath: string;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly maxArchiveBytes: number;
  private readonly maxFiles: number;
  private readonly maxDepth: number;
  private readonly onChange?: OfflinePageStoreOptions["onChange"];
  private data = emptyDocument();
  private save = emptyOfflinePageSave();
  private initialized = false;
  private saving = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  private temporaryFileCounter = 0;

  constructor(options: OfflinePageStoreOptions) {
    this.directory = path.resolve(options.directory);
    this.archivesDirectory = path.join(this.directory, "archives");
    this.indexPath = path.join(this.directory, "index.json");
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? randomUUID;
    this.maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.onChange = options.onChange;
    if (
      !Number.isSafeInteger(this.maxArchiveBytes) ||
      this.maxArchiveBytes < 1 ||
      !Number.isSafeInteger(this.maxFiles) ||
      this.maxFiles < 1 ||
      !Number.isSafeInteger(this.maxDepth) ||
      this.maxDepth < 1
    ) {
      throw new RangeError("Offline page storage limits are invalid.");
    }
  }

  get snapshot(): OfflinePagesSnapshot {
    return structuredClone({ items: this.data.items, save: this.save });
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      if (this.initialized) return;
      await fs.mkdir(this.archivesDirectory, { recursive: true });
      this.data = await this.loadDocument();
      await this.recoverInterruptedDeletions();
      await this.removeStalePartialDirectories();
      const changed = await this.reconcileDraft();
      this.initialized = true;
      if (changed) await this.writeAtomically();
      this.emit();
    });
  }

  async savePage(
    source: OfflinePageCaptureSource,
  ): Promise<OfflinePageEntrySnapshot> {
    this.assertInitialized();
    if (this.saving) throw new Error("Another page is already being saved.");
    const sourceUrl = cleanSourceUrl(source.sourceUrl);
    const title = cleanTitle(source.title);
    const id = this.cleanGeneratedId(this.generateId());
    const partialDirectory = path.join(
      this.archivesDirectory,
      `.partial-${id}`,
    );
    const archiveDirectory = path.join(this.archivesDirectory, id);
    const htmlPath = path.join(partialDirectory, "index.html");
    let archiveCommitted = false;
    this.saving = true;
    this.save = {
      stage: "saving",
      tabId: source.tabId,
      title,
      sourceUrl,
      entryId: null,
      error: null,
    };
    this.emit();

    try {
      await fs.mkdir(partialDirectory, { recursive: false });
      await this.assertStorageCapacity();
      source.assertUnchanged();
      await source.saveCompletePage(htmlPath);
      source.assertUnchanged();
      await this.sanitizeDocument(htmlPath);
      const preview = await source.capturePreview().catch(() => null);
      source.assertUnchanged();
      if (preview?.length) {
        await fs.writeFile(
          path.join(partialDirectory, "thumbnail.png"),
          preview,
          {
            flag: "wx",
          },
        );
      }
      const inspected = await this.inspectArchive(partialDirectory);
      const html = await fs.stat(htmlPath).catch(() => null);
      if (!html?.isFile())
        throw new Error("The saved page did not contain an HTML document.");
      await fs.rename(partialDirectory, archiveDirectory);
      archiveCommitted = true;

      const entry: OfflinePageEntrySnapshot = {
        id,
        title,
        sourceUrl,
        archiveUrl: offlinePageArchiveUrl(id),
        savedAt: this.now(),
        fileSize: inspected.bytes,
        thumbnailUrl: preview?.length ? offlinePageThumbnailUrl(id) : null,
        available: true,
      };
      await this.enqueue(async () => {
        this.data.items.unshift(entry);
        try {
          await this.writeAtomically();
        } catch (error) {
          this.data.items = this.data.items.filter((item) => item.id !== id);
          throw error;
        }
      });
      this.save = {
        stage: "complete",
        tabId: source.tabId,
        title,
        sourceUrl,
        entryId: id,
        error: null,
      };
      this.emit();
      return structuredClone(entry);
    } catch (error) {
      await this.removeOwnedDirectory(partialDirectory).catch(() => undefined);
      if (archiveCommitted) {
        await this.removeOwnedDirectory(archiveDirectory).catch(
          () => undefined,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      this.save = {
        stage: "failed",
        tabId: source.tabId,
        title,
        sourceUrl,
        entryId: null,
        error: message,
      };
      this.emit();
      throw error;
    } finally {
      this.saving = false;
    }
  }

  async remove(id: string): Promise<void> {
    this.assertInitialized();
    const cleanId = this.cleanId(id);
    const archiveDirectory = path.join(this.archivesDirectory, cleanId);
    await this.enqueue(async () => {
      const next = this.data.items.filter((item) => item.id !== cleanId);
      if (next.length === this.data.items.length)
        throw new Error("Unknown offline page.");
      const quarantineDirectory = path.join(
        this.archivesDirectory,
        `.deleting-${cleanId}-${process.pid}-${this.temporaryFileCounter++}`,
      );
      let quarantined = false;
      try {
        await fs.rename(archiveDirectory, quarantineDirectory);
        quarantined = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const previousItems = this.data.items;
      const previousSave = this.save;
      this.data.items = next;
      if (this.save.entryId === cleanId) this.save = emptyOfflinePageSave();
      try {
        await this.writeAtomically();
      } catch (error) {
        this.data.items = previousItems;
        this.save = previousSave;
        if (quarantined) {
          try {
            await fs.rename(quarantineDirectory, archiveDirectory);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Could not update the offline page index or restore its archive.",
            );
          }
        }
        throw error;
      }
      this.emit();
      if (quarantined) {
        await this.removeOwnedDirectory(quarantineDirectory).catch((error) =>
          console.warn(
            "Could not finish removing an offline page archive.",
            error,
          ),
        );
      }
    });
  }

  async resolveResource(
    id: string,
    relativePath: string,
  ): Promise<string | null> {
    if (!this.initialized || !this.data.items.some((item) => item.id === id))
      return null;
    const cleanId = this.cleanId(id);
    if (
      !relativePath ||
      relativePath.includes("\0") ||
      relativePath.includes("\\") ||
      path.isAbsolute(relativePath)
    ) {
      return null;
    }
    const archiveDirectory = path.join(this.archivesDirectory, cleanId);
    const candidate = path.resolve(archiveDirectory, relativePath);
    if (!isInside(archiveDirectory, candidate)) return null;
    try {
      const [realArchive, realCandidate] = await Promise.all([
        fs.realpath(archiveDirectory),
        fs.realpath(candidate),
      ]);
      if (!isInside(realArchive, realCandidate)) return null;
      const stats = await fs.stat(realCandidate);
      return stats.isFile() ? realCandidate : null;
    } catch {
      return null;
    }
  }

  private async loadDocument(): Promise<PersistedOfflinePages> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexPath, "utf8")) as {
        version?: unknown;
        items?: unknown;
      };
      if (parsed.version !== DOCUMENT_VERSION || !Array.isArray(parsed.items)) {
        return emptyDocument();
      }
      const items = parsed.items
        .map(cleanEntry)
        .filter((item): item is OfflinePageEntrySnapshot => item !== null)
        .filter(
          (item, index, all) =>
            all.findIndex((other) => other.id === item.id) === index,
        )
        .sort((left, right) => right.savedAt - left.savedAt);
      return { version: DOCUMENT_VERSION, items };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "Could not read the offline pages index; starting empty.",
          error,
        );
      }
      return emptyDocument();
    }
  }

  private async reconcileDraft(): Promise<boolean> {
    let changed = false;
    for (const item of this.data.items) {
      const htmlPath = path.join(this.archivesDirectory, item.id, "index.html");
      const available = await fs
        .stat(htmlPath)
        .then((stats) => stats.isFile())
        .catch(() => false);
      if (item.available !== available) {
        item.available = available;
        changed = true;
      }
      const thumbnailPath = path.join(
        this.archivesDirectory,
        item.id,
        "thumbnail.png",
      );
      const hasThumbnail = await fs
        .stat(thumbnailPath)
        .then((stats) => stats.isFile())
        .catch(() => false);
      const thumbnailUrl = hasThumbnail
        ? offlinePageThumbnailUrl(item.id)
        : null;
      if (item.thumbnailUrl !== thumbnailUrl) {
        item.thumbnailUrl = thumbnailUrl;
        changed = true;
      }
    }
    return changed;
  }

  private async inspectArchive(root: string): Promise<ArchiveInspection> {
    const inspection = { bytes: 0, files: 0 };
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > this.maxDepth)
        throw new Error("The page archive is nested too deeply.");
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink())
          throw new Error("Page archives cannot contain symbolic links.");
        if (entry.isDirectory()) {
          await visit(entryPath, depth + 1);
          continue;
        }
        if (!entry.isFile())
          throw new Error(
            "The page archive contains an unsupported file type.",
          );
        inspection.files += 1;
        if (inspection.files > this.maxFiles)
          throw new Error("The page archive contains too many files.");
        const stats = await fs.stat(entryPath);
        inspection.bytes += stats.size;
        if (inspection.bytes > this.maxArchiveBytes)
          throw new Error("The page archive is too large.");
      }
    };
    await visit(root, 0);
    return inspection;
  }

  private async assertStorageCapacity(): Promise<void> {
    let availableBytes: number;
    try {
      const stats = await fs.statfs(this.archivesDirectory);
      availableBytes = stats.bavail * stats.bsize;
    } catch {
      return;
    }
    const requiredBytes = this.maxArchiveBytes + MIN_FREE_SPACE_RESERVE;
    if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
      throw new Error(
        "There is not enough free disk space to safely save this page.",
      );
    }
  }

  private async sanitizeDocument(htmlPath: string): Promise<void> {
    const stats = await fs.stat(htmlPath);
    if (!stats.isFile() || stats.size > MAX_HTML_BYTES) {
      throw new Error("The saved page document is too large.");
    }
    const original = await fs.readFile(htmlPath, "utf8");
    const sanitized = original
      .replace(
        /<meta\b[^>]*\bhttp-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy)[^>]*>/giu,
        "",
      )
      .replace(
        /<meta\b[^>]*\bhttp-equiv\s*=\s*(?:"refresh"|'refresh'|refresh)[^>]*>/giu,
        "",
      )
      .replace(/<base\b[^>]*>/giu, "");
    if (sanitized !== original) await fs.writeFile(htmlPath, sanitized, "utf8");
  }

  private async removeStalePartialDirectories(): Promise<void> {
    const entries = await fs.readdir(this.archivesDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries.slice(0, 100)) {
      if (entry.isDirectory() && entry.name.startsWith(".partial-")) {
        await this.removeOwnedDirectory(
          path.join(this.archivesDirectory, entry.name),
        );
      }
    }
  }

  private async recoverInterruptedDeletions(): Promise<void> {
    const entries = await fs.readdir(this.archivesDirectory, {
      withFileTypes: true,
    });
    const indexedIds = [...this.data.items]
      .map((item) => item.id)
      .sort((left, right) => right.length - left.length);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".deleting-"))
        continue;
      const quarantineDirectory = path.join(this.archivesDirectory, entry.name);
      const indexedId = indexedIds.find((id) =>
        entry.name.startsWith(`.deleting-${id}-`),
      );
      if (!indexedId) {
        await this.removeOwnedDirectory(quarantineDirectory);
        continue;
      }
      const archiveDirectory = path.join(this.archivesDirectory, indexedId);
      const archiveExists = await fs
        .stat(archiveDirectory)
        .then(() => true)
        .catch(() => false);
      if (archiveExists) {
        await this.removeOwnedDirectory(quarantineDirectory);
      } else {
        await fs.rename(quarantineDirectory, archiveDirectory);
      }
    }
  }

  private async removeOwnedDirectory(directory: string): Promise<void> {
    const resolved = path.resolve(directory);
    if (
      resolved === this.archivesDirectory ||
      !isInside(this.archivesDirectory, resolved)
    ) {
      throw new Error(
        "Refusing to remove a path outside offline page storage.",
      );
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }

  private async writeAtomically(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const temporaryPath = `${this.indexPath}.${process.pid}.${this.temporaryFileCounter++}.tmp`;
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(this.data, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    try {
      await fs.rename(temporaryPath, this.indexPath);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await fs.rm(this.indexPath, { force: true });
      await fs.rename(temporaryPath, this.indexPath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private cleanGeneratedId(value: string): string {
    const id = this.cleanId(value);
    if (this.data.items.some((item) => item.id === id)) {
      throw new Error("The generated offline page id already exists.");
    }
    return id;
  }

  private cleanId(value: string): string {
    if (!ENTRY_ID_PATTERN.test(value))
      throw new TypeError("Invalid offline page id.");
    return value;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Offline pages are not ready.");
  }

  private emit(): void {
    this.onChange?.(this.snapshot);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }
}
