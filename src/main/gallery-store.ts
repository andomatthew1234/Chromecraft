import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { GalleryEntrySnapshot, GallerySnapshot } from "../shared/browser";

const GALLERY_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_DIRECTORY_ENTRIES = 5_000;
const MAX_IMPORTS_PER_SCAN = 1_000;
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 240;
const MAX_SOURCE_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 8_192;

const MEDIA_EXTENSIONS = new Set([
  ".avi",
  ".flv",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".webm",
  ".wmv",
]);
const THUMBNAIL_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

export interface GalleryCompletedInput {
  filePath: string;
  title?: string | null;
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  downloadedAt?: number;
  sourceName?: string | null;
  sourceUrl?: string | null;
  thumbnailPath?: string | null;
  managedBy?: "manual" | "smart";
  smartChannelId?: string | null;
}

export interface GalleryStoreOptions {
  filePath: string;
  downloadsDirectory: string;
  thumbnailDirectory?: string;
  maxEntries?: number;
  now?: () => number;
  generateId?: () => string;
  onChange?: (snapshot: GallerySnapshot) => void;
}

interface PersistedGallery {
  version: typeof GALLERY_VERSION;
  items: GalleryEntrySnapshot[];
}

function emptyGallery(): PersistedGallery {
  return { version: GALLERY_VERSION, items: [] };
}

/**
 * Owns the local Gallery index. Filesystem operations are addressed by opaque
 * entry IDs, and every indexed file is confined to the configured Downloads
 * directory before it can be returned to a caller.
 */
export class GalleryStore {
  private readonly filePath: string;
  private readonly downloadsDirectory: string;
  private readonly thumbnailDirectory: string | null;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly onChange?: GalleryStoreOptions["onChange"];
  private data = emptyGallery();
  private operationQueue: Promise<void> = Promise.resolve();
  private temporaryFileCounter = 0;
  private initialized = false;

  constructor(options: GalleryStoreOptions) {
    if (!Number.isInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES)) {
      throw new RangeError("Gallery maxEntries must be an integer.");
    }
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (this.maxEntries < 1 || this.maxEntries > DEFAULT_MAX_ENTRIES) {
      throw new RangeError(
        `Gallery maxEntries must be between 1 and ${DEFAULT_MAX_ENTRIES}.`,
      );
    }
    this.filePath = path.resolve(options.filePath);
    this.downloadsDirectory = path.resolve(options.downloadsDirectory);
    this.thumbnailDirectory = options.thumbnailDirectory
      ? path.resolve(options.thumbnailDirectory)
      : null;
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? randomUUID;
    this.onChange = options.onChange;
  }

  get snapshot(): GallerySnapshot {
    return structuredClone({ items: this.data.items });
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      if (this.initialized) return;
      this.data = await this.loadDocument();
      const changed = await this.reconcileDraft(this.data);
      this.initialized = true;
      if (changed) await this.writeAtomically(this.data);
      this.emit();
    });
  }

  async reconcile(): Promise<number> {
    return this.mutate(async (draft) => {
      const changed = await this.reconcileDraft(draft);
      return { result: changed, changed: changed > 0 };
    });
  }

  async addCompleted(
    input: GalleryCompletedInput,
  ): Promise<GalleryEntrySnapshot> {
    const inspected = await this.inspectMediaFile(input.filePath);
    if (!inspected) {
      throw new Error("The completed Gallery file is unavailable or unsafe.");
    }
    const title =
      cleanTitle(input.title) ?? titleFromFilename(inspected.filename);
    const downloadedAt = cleanTimestamp(input.downloadedAt ?? this.now());
    if (downloadedAt === null) throw new TypeError("downloadedAt is invalid.");
    const sourceName = cleanOptionalString(
      input.sourceName,
      MAX_SOURCE_NAME_LENGTH,
    );
    const sourceUrl = cleanOptionalWebUrl(input.sourceUrl);
    const durationSeconds = cleanDuration(input.durationSeconds);
    const width = cleanDimension(input.width);
    const height = cleanDimension(input.height);
    const thumbnailPath = await this.inspectThumbnailFile(input.thumbnailPath);
    const managedBy = input.managedBy === "smart" ? "smart" : "manual";
    const smartChannelId =
      managedBy === "smart"
        ? cleanOptionalString(input.smartChannelId, 256)
        : null;

    return this.mutate((draft) => {
      const pathKey = normalizePathKey(inspected.filePath);
      const existing = draft.items.find(
        (item) => normalizePathKey(item.filePath) === pathKey,
      );
      if (existing) {
        Object.assign(existing, {
          title,
          filename: inspected.filename,
          filePath: inspected.filePath,
          durationSeconds,
          width,
          height,
          fileSize: inspected.fileSize,
          downloadedAt,
          sourceName,
          sourceUrl,
          available: true,
          thumbnailPath,
          thumbnailUrl: thumbnailPath ? thumbnailUrl(existing.id) : null,
          managedBy,
          smartChannelId,
          keepForever: existing.keepForever ?? false,
          watchedAt: existing.watchedAt ?? null,
        });
        return { result: structuredClone(existing), changed: true };
      }

      // A repeated download can receive a collision suffix even though it is
      // the same source video. Keep one Gallery card rather than silently
      // duplicating it; the additional file remains available in Downloads.
      const sourceDuplicate = sourceUrl
        ? draft.items.find((item) => item.sourceUrl === sourceUrl)
        : undefined;
      if (sourceDuplicate) {
        return {
          result: structuredClone(sourceDuplicate),
          changed: false,
        };
      }

      const id = cleanId(this.generateId());
      if (!id) throw new TypeError("The generated Gallery id is invalid.");
      const entry: GalleryEntrySnapshot = {
        id,
        title,
        filename: inspected.filename,
        filePath: inspected.filePath,
        mediaUrl: mediaUrl(id),
        thumbnailPath,
        thumbnailUrl: thumbnailPath ? thumbnailUrl(id) : null,
        durationSeconds,
        width,
        height,
        fileSize: inspected.fileSize,
        downloadedAt,
        sourceName,
        sourceUrl,
        available: true,
        managedBy,
        smartChannelId,
        keepForever: false,
        watchedAt: null,
      };
      draft.items.unshift(entry);
      draft.items.length = Math.min(draft.items.length, this.maxEntries);
      return { result: structuredClone(entry), changed: true };
    });
  }

  /**
   * Explicitly imports supported media directly inside Downloads. The scan is
   * non-recursive and bounded so a user-controlled directory cannot monopolize
   * the main process.
   */
  async importDownloads(): Promise<number> {
    let directoryEntries;
    try {
      directoryEntries = await fs.readdir(this.downloadsDirectory, {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }

    const candidates = directoryEntries
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .filter(
        (entry) =>
          entry.isFile() &&
          MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
          /\[[a-zA-Z0-9_-]{11}\](?: \(\d+\))?\.[^.]+$/u.test(entry.name),
      )
      .slice(0, MAX_IMPORTS_PER_SCAN);
    return this.mutate(async (draft) => {
      let imported = 0;
      for (const candidate of candidates) {
        const inspected = await this.inspectMediaFile(
          path.join(this.downloadsDirectory, candidate.name),
        );
        if (!inspected) continue;
        const pathKey = normalizePathKey(inspected.filePath);
        if (
          draft.items.some(
            (item) => normalizePathKey(item.filePath) === pathKey,
          )
        )
          continue;
        const videoId =
          /\[([a-zA-Z0-9_-]{11})\](?: \(\d+\))?\.[^.]+$/u.exec(
            candidate.name,
          )?.[1] ?? null;
        const sourceUrl = videoId
          ? `https://www.youtube.com/watch?v=${videoId}`
          : null;
        if (
          sourceUrl &&
          draft.items.some((item) => item.sourceUrl === sourceUrl)
        )
          continue;
        const id = cleanId(this.generateId());
        if (!id) throw new TypeError("The generated Gallery id is invalid.");
        draft.items.unshift({
          id,
          title: titleFromFilename(inspected.filename),
          filename: inspected.filename,
          filePath: inspected.filePath,
          mediaUrl: mediaUrl(id),
          durationSeconds: null,
          width: null,
          height: null,
          fileSize: inspected.fileSize,
          downloadedAt: this.now(),
          sourceName: "YouTube",
          sourceUrl,
          available: true,
        });
        imported += 1;
      }
      draft.items.length = Math.min(draft.items.length, this.maxEntries);
      return { result: imported, changed: imported > 0 };
    });
  }

  /** Returns an existing, root-confined media path for an opaque Gallery ID. */
  async resolveFile(id: string): Promise<string | null> {
    const clean = requireId(id);
    const item = this.data.items.find((entry) => entry.id === clean);
    if (!item) return null;
    const inspected = await this.inspectMediaFile(item.filePath);
    if (!inspected) {
      if (item.available) {
        await this.setAvailability(clean, false);
      }
      return null;
    }
    if (!item.available || item.fileSize !== inspected.fileSize) {
      await this.mutate((draft) => {
        const entry = draft.items.find((candidate) => candidate.id === clean);
        if (!entry) return { result: undefined, changed: false };
        entry.available = true;
        entry.fileSize = inspected.fileSize;
        return { result: undefined, changed: true };
      });
    }
    return inspected.filePath;
  }

  async resolveThumbnail(id: string): Promise<string | null> {
    this.requireInitialized();
    const clean = cleanId(id);
    if (!clean || !this.thumbnailDirectory) return null;
    const entry = this.data.items.find((item) => item.id === clean);
    if (!entry?.thumbnailPath) return null;
    return this.resolveOwnedFile(
      entry.thumbnailPath,
      this.thumbnailDirectory,
      THUMBNAIL_EXTENSIONS,
    );
  }

  async rename(
    id: string,
    requestedTitle: string,
  ): Promise<GalleryEntrySnapshot> {
    const clean = requireId(id);
    const title = requireSafeRenameTitle(requestedTitle);
    this.requireInitialized();
    let result!: GalleryEntrySnapshot;
    await this.enqueue(async () => {
      const draft = structuredClone(this.data);
      const entry = draft.items.find((candidate) => candidate.id === clean);
      if (!entry) throw new Error("Unknown Gallery item.");
      const inspected = await this.inspectMediaFile(entry.filePath);
      if (!inspected) throw new Error("The Gallery file is unavailable.");
      const source = inspected.filePath;
      const extension = path.extname(source);
      const destination = path.join(
        path.dirname(source),
        `${title}${extension}`,
      );
      if (!isDirectChild(this.downloadsDirectory, destination)) {
        throw new Error("The renamed file would leave Downloads.");
      }
      const moved = normalizePathKey(source) !== normalizePathKey(destination);
      if (moved) {
        try {
          await fs.link(source, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error("A file with that name already exists.");
          }
          throw new Error("This filesystem could not safely rename the file.", {
            cause: error,
          });
        }
        try {
          await fs.unlink(source);
        } catch (error) {
          await fs.unlink(destination).catch(() => undefined);
          throw error;
        }
      }
      entry.title = title;
      entry.filename = path.basename(destination);
      entry.filePath = destination;
      entry.available = true;
      try {
        await this.writeAtomically(draft);
      } catch (error) {
        if (moved) {
          await fs.link(destination, source).catch(() => undefined);
          await fs.unlink(destination).catch(() => undefined);
        }
        throw error;
      }
      this.data = draft;
      result = structuredClone(entry);
      this.emit();
    });
    return result;
  }

  async remove(id: string): Promise<boolean> {
    const clean = requireId(id);
    return this.mutate((draft) => {
      const index = draft.items.findIndex((entry) => entry.id === clean);
      if (index < 0) return { result: false, changed: false };
      draft.items.splice(index, 1);
      return { result: true, changed: true };
    });
  }

  async removeMany(ids: readonly string[]): Promise<number> {
    const cleanIds = new Set(ids.map(requireId));
    if (cleanIds.size === 0) return 0;
    return this.mutate((draft) => {
      const previousLength = draft.items.length;
      draft.items = draft.items.filter((entry) => !cleanIds.has(entry.id));
      const removed = previousLength - draft.items.length;
      return { result: removed, changed: removed > 0 };
    });
  }

  async updateMediaMetadata(
    id: string,
    durationSeconds: number | null,
    width: number | null,
    height: number | null,
  ): Promise<boolean> {
    const clean = requireId(id);
    const duration = cleanDuration(durationSeconds);
    const cleanWidth = cleanDimension(width);
    const cleanHeight = cleanDimension(height);
    return this.mutate((draft) => {
      const entry = draft.items.find((candidate) => candidate.id === clean);
      if (!entry) return { result: false, changed: false };
      const changed =
        entry.durationSeconds !== duration ||
        entry.width !== cleanWidth ||
        entry.height !== cleanHeight;
      entry.durationSeconds = duration;
      entry.width = cleanWidth;
      entry.height = cleanHeight;
      return { result: changed, changed };
    });
  }

  async setKeepForever(id: string, keepForever: boolean): Promise<void> {
    const clean = requireId(id);
    await this.mutate((draft) => {
      const entry = draft.items.find((candidate) => candidate.id === clean);
      if (!entry) throw new Error("Unknown Gallery item.");
      const changed = entry.keepForever !== keepForever;
      entry.keepForever = keepForever;
      return { result: undefined, changed };
    });
  }

  async markWatched(id: string, watchedAt = this.now()): Promise<void> {
    const clean = requireId(id);
    const timestamp = cleanTimestamp(watchedAt);
    if (timestamp === null) throw new TypeError("watchedAt is invalid.");
    await this.mutate((draft) => {
      const entry = draft.items.find((candidate) => candidate.id === clean);
      if (!entry) throw new Error("Unknown Gallery item.");
      entry.watchedAt = timestamp;
      return { result: undefined, changed: true };
    });
  }

  private async setAvailability(id: string, available: boolean): Promise<void> {
    await this.mutate((draft) => {
      const entry = draft.items.find((candidate) => candidate.id === id);
      if (!entry || entry.available === available) {
        return { result: undefined, changed: false };
      }
      entry.available = available;
      return { result: undefined, changed: true };
    });
  }

  private async loadDocument(): Promise<PersistedGallery> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return validateDocument(
        JSON.parse(raw) as unknown,
        this.downloadsDirectory,
        this.thumbnailDirectory,
        this.maxEntries,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "Could not read the Gallery index; starting empty.",
          error,
        );
      }
      return emptyGallery();
    }
  }

  private async reconcileDraft(draft: PersistedGallery): Promise<number> {
    let changed = 0;
    for (const entry of draft.items) {
      const inspected = await this.inspectMediaFile(entry.filePath);
      const available = inspected !== null;
      const fileSize = inspected?.fileSize ?? entry.fileSize;
      if (entry.available !== available || entry.fileSize !== fileSize) {
        entry.available = available;
        entry.fileSize = fileSize;
        changed += 1;
      }
    }
    return changed;
  }

  private async inspectMediaFile(candidate: string): Promise<{
    filePath: string;
    filename: string;
    fileSize: number;
  } | null> {
    const resolved = path.resolve(candidate);
    if (!isDirectChild(this.downloadsDirectory, resolved)) return null;
    if (!MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase()))
      return null;
    try {
      const [realRoot, realFile, stat] = await Promise.all([
        fs.realpath(this.downloadsDirectory),
        fs.realpath(resolved),
        fs.stat(resolved),
      ]);
      if (!stat.isFile() || !isDirectChild(realRoot, realFile)) return null;
      return {
        filePath: realFile,
        filename: path.basename(realFile),
        fileSize: stat.size,
      };
    } catch {
      return null;
    }
  }

  private async inspectThumbnailFile(
    candidate: string | null | undefined,
  ): Promise<string | null> {
    if (!candidate || !this.thumbnailDirectory) return null;
    return this.resolveOwnedFile(
      candidate,
      this.thumbnailDirectory,
      THUMBNAIL_EXTENSIONS,
    );
  }

  private async resolveOwnedFile(
    candidate: string,
    root: string,
    allowedExtensions: ReadonlySet<string>,
  ): Promise<string | null> {
    const resolved = path.resolve(candidate);
    if (!isDirectChild(root, resolved)) return null;
    if (!allowedExtensions.has(path.extname(resolved).toLowerCase()))
      return null;
    try {
      const [realRoot, realFile, stat] = await Promise.all([
        fs.realpath(root),
        fs.realpath(resolved),
        fs.stat(resolved),
      ]);
      return stat.isFile() && isDirectChild(realRoot, realFile)
        ? realFile
        : null;
    } catch {
      return null;
    }
  }

  private async mutate<T>(
    operation: (
      draft: PersistedGallery,
    ) =>
      | { result: T; changed: boolean }
      | Promise<{ result: T; changed: boolean }>,
  ): Promise<T> {
    this.requireInitialized();
    let result!: T;
    await this.enqueue(async () => {
      const draft = structuredClone(this.data);
      const outcome = await operation(draft);
      result = outcome.result;
      if (!outcome.changed) return;
      await this.writeAtomically(draft);
      this.data = draft;
      this.emit();
    });
    return result;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.catch(() => undefined);
    return next;
  }

  private async writeAtomically(data: PersistedGallery): Promise<void> {
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

  private emit(): void {
    try {
      this.onChange?.(this.snapshot);
    } catch (error) {
      console.error("Gallery change listener failed.", error);
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("GalleryStore must be initialized before use.");
    }
  }
}

function mediaUrl(id: string): string {
  return `chromecraft-media://video/${encodeURIComponent(id)}`;
}

function thumbnailUrl(id: string): string {
  return `chromecraft-media://thumbnail/${encodeURIComponent(id)}`;
}

function normalizePathKey(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isDirectChild(directory: string, candidate: string): boolean {
  const relative = path.relative(
    path.resolve(directory),
    path.resolve(candidate),
  );
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    /^[a-zA-Z0-9_-]+$/.test(value)
    ? value
    : null;
}

function requireId(value: unknown): string {
  const clean = cleanId(value);
  if (!clean) throw new TypeError("A valid Gallery id is required.");
  return clean;
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/\s+/gu, " ");
  return clean.length > 0 && clean.length <= MAX_TITLE_LENGTH ? clean : null;
}

function cleanOptionalString(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new TypeError("Metadata is invalid.");
  const clean = value.trim().replace(/\s+/gu, " ");
  if (!clean || clean.length > maximum)
    throw new TypeError("Metadata is invalid.");
  return clean;
}

function cleanOptionalWebUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    throw new TypeError("The source URL is invalid.");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error();
    return url.href;
  } catch {
    throw new TypeError("The source URL is invalid.");
  }
}

function cleanTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function cleanNonNegativeNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("Media metadata is invalid.");
  }
  return value;
}

function cleanDuration(value: unknown): number | null {
  return cleanNonNegativeNumber(value);
}

function cleanDimension(value: unknown): number | null {
  const clean = cleanNonNegativeNumber(value);
  if (clean === null) return null;
  if (!Number.isInteger(clean) || clean > 65_535) {
    throw new TypeError("Media dimensions are invalid.");
  }
  return clean;
}

function titleFromFilename(filename: string): string {
  const extension = path.extname(filename);
  return cleanTitle(filename.slice(0, -extension.length)) ?? "Video";
}

function requireSafeRenameTitle(value: unknown): string {
  const title = cleanTitle(value);
  if (
    !title ||
    title === "." ||
    title === ".." ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(title) ||
    /[. ]$/u.test(title) ||
    /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/iu.test(title)
  ) {
    throw new TypeError("The new Gallery title is not a safe filename.");
  }
  return title;
}

function validateDocument(
  value: unknown,
  downloadsDirectory: string,
  thumbnailDirectory: string | null,
  maximum: number,
): PersistedGallery {
  if (
    !isRecord(value) ||
    value.version !== GALLERY_VERSION ||
    !Array.isArray(value.items)
  ) {
    return emptyGallery();
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  const items: GalleryEntrySnapshot[] = [];
  for (const raw of value.items.slice(0, maximum)) {
    const entry = validateEntry(raw, downloadsDirectory, thumbnailDirectory);
    if (!entry) continue;
    const pathKey = normalizePathKey(entry.filePath);
    if (ids.has(entry.id) || paths.has(pathKey)) continue;
    ids.add(entry.id);
    paths.add(pathKey);
    items.push(entry);
  }
  return { version: GALLERY_VERSION, items };
}

function validateEntry(
  value: unknown,
  downloadsDirectory: string,
  thumbnailDirectory: string | null,
): GalleryEntrySnapshot | null {
  if (!isRecord(value)) return null;
  const id = cleanId(value.id);
  const title = cleanTitle(value.title);
  const filename = typeof value.filename === "string" ? value.filename : null;
  const filePath =
    typeof value.filePath === "string" ? path.resolve(value.filePath) : null;
  const fileSize = cleanTimestamp(value.fileSize);
  const downloadedAt = cleanTimestamp(value.downloadedAt);
  let durationSeconds: number | null;
  let width: number | null;
  let height: number | null;
  let sourceName: string | null;
  let sourceUrl: string | null;
  let smartChannelId: string | null;
  try {
    durationSeconds = cleanDuration(value.durationSeconds);
    width = cleanDimension(value.width);
    height = cleanDimension(value.height);
    sourceName = cleanOptionalString(value.sourceName, MAX_SOURCE_NAME_LENGTH);
    sourceUrl = cleanOptionalWebUrl(value.sourceUrl);
    smartChannelId = cleanOptionalString(value.smartChannelId, 256);
  } catch {
    return null;
  }
  if (
    !id ||
    !title ||
    !filename ||
    filename !== path.basename(filename) ||
    !filePath ||
    path.basename(filePath) !== filename ||
    !isDirectChild(downloadsDirectory, filePath) ||
    !MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ||
    fileSize === null ||
    downloadedAt === null ||
    typeof value.available !== "boolean"
  ) {
    return null;
  }
  return {
    id,
    title,
    filename,
    filePath,
    mediaUrl: mediaUrl(id),
    thumbnailPath:
      typeof value.thumbnailPath === "string" &&
      thumbnailDirectory &&
      isDirectChild(thumbnailDirectory, value.thumbnailPath) &&
      THUMBNAIL_EXTENSIONS.has(path.extname(value.thumbnailPath).toLowerCase())
        ? path.resolve(value.thumbnailPath)
        : null,
    thumbnailUrl:
      typeof value.thumbnailPath === "string" &&
      thumbnailDirectory &&
      isDirectChild(thumbnailDirectory, value.thumbnailPath)
        ? thumbnailUrl(id)
        : null,
    durationSeconds,
    width,
    height,
    fileSize,
    downloadedAt,
    sourceName,
    sourceUrl,
    available: value.available,
    managedBy: value.managedBy === "smart" ? "smart" : "manual",
    smartChannelId: value.managedBy === "smart" ? smartChannelId : null,
    keepForever: value.keepForever === true,
    watchedAt: cleanTimestamp(value.watchedAt),
  };
}
