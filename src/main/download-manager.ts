import { existsSync, promises as fs, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  app,
  shell,
  type DownloadItem,
  type Event as ElectronEvent,
  type Session,
} from "electron";

export type DownloadState =
  | "progressing"
  | "paused"
  | "completed"
  | "cancelled"
  | "interrupted";

export interface DownloadSnapshot {
  id: string;
  filename: string;
  savePath: string;
  url: string;
  initiatorOrigin: string;
  mimeType: string;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  percentComplete: number;
  state: DownloadState;
  canResume: boolean;
  potentiallyDangerous: boolean;
  startedAt: number;
  endedAt: number | null;
}

export type OpenDownloadResult =
  | { status: "opened" }
  | { status: "confirmation-required" }
  | { status: "not-found" }
  | { status: "not-complete" }
  | { status: "unsafe-path" }
  | { status: "failed"; message: string };

export interface DownloadManagerOptions {
  /** Defaults to Electron's ordinary operating-system Downloads directory. */
  downloadsDirectory?: string;
  /** Defaults to downloads.json inside Electron's userData directory. */
  historyFilePath?: string;
  /** Maximum number of retained records. Active downloads are never discarded. */
  maxHistory?: number;
  onChange?: (downloads: readonly DownloadSnapshot[]) => void;
  /** Called before a website-initiated download is accepted. */
  shouldAllowDownload?: (initiatorOrigin: string, url: string) => boolean;
}

interface PersistedDownloadHistory {
  version: 1;
  downloads: DownloadSnapshot[];
}

interface ActiveDownload {
  item: DownloadItem;
  onUpdated: (
    event: ElectronEvent,
    state: "progressing" | "interrupted",
  ) => void;
  onDone: (
    event: ElectronEvent,
    state: "completed" | "cancelled" | "interrupted",
  ) => void;
}

const DEFAULT_HISTORY_LIMIT = 200;
const CHANGE_COALESCE_MS = 100;
const PERSIST_COALESCE_MS = 250;

const DANGEROUS_EXTENSIONS = new Set([
  ".appimage",
  ".appref-ms",
  ".application",
  ".bat",
  ".cmd",
  ".com",
  ".cpl",
  ".desktop",
  ".exe",
  ".gadget",
  ".hta",
  ".img",
  ".iso",
  ".jar",
  ".js",
  ".jse",
  ".lnk",
  ".msi",
  ".msp",
  ".ps1",
  ".psm1",
  ".reg",
  ".scr",
  ".sh",
  ".url",
  ".vbe",
  ".vbs",
  ".wsf",
  ".wsh",
]);

const DANGEROUS_MIME_TYPES = new Set([
  "application/java-archive",
  "application/x-bat",
  "application/x-executable",
  "application/x-ms-application",
  "application/x-msdos-program",
  "application/x-msdownload",
  "application/x-sh",
  "application/x-shellscript",
]);

/**
 * Owns the browser session's download lifecycle. The manager never opens a file
 * automatically; potentially executable files require a second, explicit opt-in
 * when `open` is called.
 */
export class DownloadManager {
  private readonly downloadsDirectory: string;
  private readonly historyFilePath: string;
  private readonly maxHistory: number;
  private readonly onChange?: DownloadManagerOptions["onChange"];
  private readonly shouldAllowDownload?: DownloadManagerOptions["shouldAllowDownload"];
  private readonly active = new Map<string, ActiveDownload>();
  private readonly claimedPaths = new Set<string>();

  private records: DownloadSnapshot[] = [];
  private initializePromise: Promise<void> | null = null;
  private attached = false;
  private disposed = false;
  private changeTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly browserSession: Session,
    options: DownloadManagerOptions = {},
  ) {
    const requestedLimit = options.maxHistory ?? DEFAULT_HISTORY_LIMIT;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new RangeError("maxHistory must be a positive integer.");
    }

    this.downloadsDirectory = path.resolve(
      options.downloadsDirectory ?? app.getPath("downloads"),
    );
    this.historyFilePath = path.resolve(
      options.historyFilePath ??
        path.join(app.getPath("userData"), "downloads.json"),
    );
    this.maxHistory = requestedLimit;
    this.onChange = options.onChange;
    this.shouldAllowDownload = options.shouldAllowDownload;
  }

  get snapshot(): readonly DownloadSnapshot[] {
    return this.records.map((record) => ({ ...record }));
  }

  /** Loads history and begins observing downloads. Safe to call more than once. */
  initialize(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("DownloadManager has been disposed."));
    }
    this.initializePromise ??= this.initializeOnce();
    return this.initializePromise;
  }

  cancel(id: string): boolean {
    const active = this.active.get(id);
    if (!active) return false;
    active.item.cancel();
    return true;
  }

  pause(id: string): boolean {
    const active = this.active.get(id);
    if (!active || active.item.isPaused()) return false;
    active.item.pause();
    this.updateFromItem(id, active.item, "paused");
    return true;
  }

  resume(id: string): boolean {
    const active = this.active.get(id);
    if (!active || (!active.item.isPaused() && !active.item.canResume())) {
      return false;
    }
    active.item.resume();
    this.updateFromItem(id, active.item, "progressing");
    return true;
  }

  retry(id: string): boolean {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record || !["cancelled", "interrupted"].includes(record.state)) {
      return false;
    }
    try {
      const url = new URL(record.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      this.browserSession.downloadURL(url.href);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Opens a completed file only after an explicit caller action. Executable-like
   * files additionally require `confirmDangerous` to prevent accidental launch.
   */
  async open(
    id: string,
    confirmDangerous = false,
  ): Promise<OpenDownloadResult> {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) return { status: "not-found" };
    if (record.state !== "completed") return { status: "not-complete" };
    if (record.potentiallyDangerous && !confirmDangerous) {
      return { status: "confirmation-required" };
    }

    const safePath = await this.resolveSafeExistingPath(record.savePath);
    if (!safePath) return { status: "unsafe-path" };

    const errorMessage = await shell.openPath(safePath);
    return errorMessage
      ? { status: "failed", message: errorMessage }
      : { status: "opened" };
  }

  showInFolder(id: string): boolean {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record || !this.isInsideDownloadsDirectory(record.savePath)) {
      return false;
    }
    shell.showItemInFolder(path.resolve(record.savePath));
    return true;
  }

  removeRecord(id: string): boolean {
    if (this.active.has(id)) return false;
    const previousLength = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length === previousLength) return false;
    this.emitChange(true);
    this.schedulePersist(0);
    return true;
  }

  clearFinished(): number {
    const previousLength = this.records.length;
    this.records = this.records.filter((record) => this.active.has(record.id));
    const removed = previousLength - this.records.length;
    if (removed > 0) {
      this.emitChange(true);
      this.schedulePersist(0);
    }
    return removed;
  }

  /** Adds a completed file produced by a browser-owned external downloader. */
  recordCompletedExternalDownload(input: {
    url: string;
    savePath: string;
    mimeType: string;
    startedAt: number;
    endedAt?: number;
  }): string {
    const savePath = path.resolve(input.savePath);
    if (!this.isInsideDownloadsDirectory(savePath) || !existsSync(savePath)) {
      throw new Error("External download output is outside Downloads.");
    }
    const id = randomUUID();
    const size = statSync(savePath).size;
    const record: DownloadSnapshot = {
      id,
      filename: path.basename(savePath),
      savePath,
      url: input.url,
      initiatorOrigin: new URL(input.url).origin,
      mimeType: input.mimeType,
      receivedBytes: size,
      totalBytes: size,
      bytesPerSecond: 0,
      percentComplete: 100,
      state: "completed",
      canResume: false,
      potentiallyDangerous: false,
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? Date.now(),
    };
    this.records.unshift(record);
    this.pruneHistory();
    this.emitChange(true);
    this.schedulePersist(0);
    return id;
  }

  /** Flushes pending history updates and detaches without cancelling downloads. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.attached) {
      this.browserSession.off("will-download", this.handleWillDownload);
      this.attached = false;
    }
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    for (const { item, onUpdated, onDone } of this.active.values()) {
      item.off("updated", onUpdated);
      item.off("done", onDone);
    }
    this.active.clear();
    this.claimedPaths.clear();
    await this.initializePromise;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.enqueuePersist();
    }
    await this.persistChain;
  }

  private async initializeOnce(): Promise<void> {
    await this.loadHistory();
    if (this.disposed) return;
    this.browserSession.on("will-download", this.handleWillDownload);
    this.attached = true;
    this.emitChange(true);
  }

  private readonly handleWillDownload = (
    event: ElectronEvent,
    item: DownloadItem,
  ): void => {
    const initiatorOrigin = item.getInitiatorOrigin();
    if (
      initiatorOrigin &&
      this.shouldAllowDownload &&
      !this.shouldAllowDownload(initiatorOrigin, item.getURL())
    ) {
      event.preventDefault();
      return;
    }
    const id = randomUUID();
    const filename = sanitizeFilename(item.getFilename());
    const savePath = this.nextAvailablePath(filename);
    this.claimedPaths.add(normalizePathKey(savePath));
    item.setSavePath(savePath);

    const record: DownloadSnapshot = {
      id,
      filename: path.basename(savePath),
      savePath,
      url: item.getURL(),
      initiatorOrigin: item.getInitiatorOrigin(),
      mimeType: item.getMimeType(),
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      bytesPerSecond: item.getCurrentBytesPerSecond(),
      percentComplete: normalizedPercent(item.getPercentComplete()),
      state: item.isPaused() ? "paused" : "progressing",
      canResume: item.canResume(),
      potentiallyDangerous: isPotentiallyDangerous(
        path.basename(savePath),
        item.getMimeType(),
      ),
      startedAt: secondsToTimestamp(item.getStartTime()) ?? Date.now(),
      endedAt: null,
    };

    this.records.unshift(record);
    this.pruneHistory();

    const onUpdated: ActiveDownload["onUpdated"] = (_updatedEvent, state) => {
      const nextState: DownloadState =
        state === "interrupted"
          ? "interrupted"
          : item.isPaused()
            ? "paused"
            : "progressing";
      this.updateFromItem(id, item, nextState);
    };
    const onDone: ActiveDownload["onDone"] = (_doneEvent, state) => {
      item.off("updated", onUpdated);
      this.active.delete(id);
      this.claimedPaths.delete(normalizePathKey(savePath));
      this.updateFromItem(id, item, state, true);
      this.pruneHistory();
      this.emitChange(true);
      this.schedulePersist(0);
    };

    this.active.set(id, { item, onUpdated, onDone });
    item.on("updated", onUpdated);
    item.once("done", onDone);
    this.emitChange(true);
    this.schedulePersist(0);
  };

  private updateFromItem(
    id: string,
    item: DownloadItem,
    state: DownloadState,
    terminal = false,
  ): void {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) return;
    const current = this.records[index];
    this.records[index] = {
      ...current,
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      bytesPerSecond: terminal ? 0 : item.getCurrentBytesPerSecond(),
      percentComplete:
        state === "completed"
          ? 100
          : normalizedPercent(item.getPercentComplete()),
      state,
      canResume: !terminal && item.canResume(),
      endedAt: terminal
        ? (secondsToTimestamp(item.getEndTime()) ?? Date.now())
        : null,
    };
    this.emitChange(terminal);
    this.schedulePersist(terminal ? 0 : PERSIST_COALESCE_MS);
  }

  private async loadHistory(): Promise<void> {
    let needsRewrite = false;
    try {
      const raw = await fs.readFile(this.historyFilePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isPersistedHistory(parsed)) {
        throw new TypeError("Download history has an unsupported format.");
      }

      this.records = parsed.downloads
        .filter(isDownloadSnapshot)
        .filter((record) => this.isInsideDownloadsDirectory(record.savePath))
        .map((record) => {
          const wasActive =
            record.state === "progressing" || record.state === "paused";
          if (wasActive) needsRewrite = true;
          return {
            ...record,
            state: wasActive ? "interrupted" : record.state,
            canResume: false,
            bytesPerSecond: 0,
            potentiallyDangerous: isPotentiallyDangerous(
              record.filename,
              record.mimeType,
            ),
            endedAt: wasActive
              ? (record.endedAt ?? Date.now())
              : record.endedAt,
          };
        });
      this.pruneHistory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Could not read download history; starting fresh.", error);
      }
      this.records = [];
    }

    if (needsRewrite) this.schedulePersist(0);
  }

  private pruneHistory(): void {
    if (this.records.length <= this.maxHistory) return;
    const retained: DownloadSnapshot[] = [];
    for (const record of this.records) {
      if (retained.length < this.maxHistory || this.active.has(record.id)) {
        retained.push(record);
      }
    }
    this.records = retained;
  }

  private nextAvailablePath(filename: string): string {
    const extension = path.extname(filename);
    const stem = extension ? filename.slice(0, -extension.length) : filename;
    for (let suffix = 0; suffix < 10_000; suffix += 1) {
      const candidateName =
        suffix === 0 ? filename : `${stem} (${suffix})${extension}`;
      const candidate = path.join(this.downloadsDirectory, candidateName);
      const key = normalizePathKey(candidate);
      if (!this.claimedPaths.has(key) && !existsSync(candidate))
        return candidate;
    }
    return path.join(
      this.downloadsDirectory,
      `${stem}-${randomUUID()}${extension}`,
    );
  }

  private isInsideDownloadsDirectory(candidate: string): boolean {
    const relative = path.relative(
      this.downloadsDirectory,
      path.resolve(candidate),
    );
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }

  private async resolveSafeExistingPath(
    candidate: string,
  ): Promise<string | null> {
    if (!this.isInsideDownloadsDirectory(candidate)) return null;
    try {
      const [realDirectory, realCandidate, stats] = await Promise.all([
        fs.realpath(this.downloadsDirectory),
        fs.realpath(candidate),
        fs.stat(candidate),
      ]);
      if (!stats.isFile()) return null;
      const relative = path.relative(realDirectory, realCandidate);
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return null;
      }
      return realCandidate;
    } catch {
      return null;
    }
  }

  private emitChange(immediate: boolean): void {
    if (!this.onChange) return;
    const notify = (): void => {
      this.changeTimer = null;
      try {
        this.onChange?.(this.snapshot);
      } catch (error) {
        console.error("Download change listener failed.", error);
      }
    };

    if (immediate) {
      if (this.changeTimer) clearTimeout(this.changeTimer);
      notify();
    } else if (!this.changeTimer) {
      this.changeTimer = setTimeout(notify, CHANGE_COALESCE_MS);
    }
  }

  private schedulePersist(delay: number): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.enqueuePersist();
    }, delay);
  }

  private enqueuePersist(): void {
    this.persistChain = this.persistChain
      .then(() => this.writeHistory())
      .catch((error: unknown) => {
        console.warn("Could not persist download history.", error);
      });
  }

  private async writeHistory(): Promise<void> {
    const payload: PersistedDownloadHistory = {
      version: 1,
      downloads: this.records,
    };
    await fs.mkdir(path.dirname(this.historyFilePath), { recursive: true });
    const temporaryPath = `${this.historyFilePath}.${process.pid}.${randomUUID()}.next`;
    try {
      await fs.writeFile(
        temporaryPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf8",
      );
      await fs.rename(temporaryPath, this.historyFilePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function sanitizeFilename(input: string): string {
  let filename = path.posix.basename(input.replaceAll("\\", "/"));
  filename = filename
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!filename || filename === "." || filename === "..") filename = "download";

  const extension = path.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/i.test(stem)) {
    filename = `_${filename}`;
  }

  if (filename.length > 180) {
    const safeExtension = extension.slice(0, 32);
    filename = `${filename.slice(0, 180 - safeExtension.length)}${safeExtension}`;
  }
  return filename;
}

function isPotentiallyDangerous(filename: string, mimeType: string): boolean {
  return (
    DANGEROUS_EXTENSIONS.has(path.extname(filename).toLowerCase()) ||
    DANGEROUS_MIME_TYPES.has(mimeType.toLowerCase())
  );
}

function normalizePathKey(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizedPercent(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(100, Math.round(value));
}

function secondsToTimestamp(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null;
}

function isPersistedHistory(value: unknown): value is PersistedDownloadHistory {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedDownloadHistory>;
  return candidate.version === 1 && Array.isArray(candidate.downloads);
}

function isDownloadSnapshot(value: unknown): value is DownloadSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DownloadSnapshot>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.filename === "string" &&
    typeof candidate.savePath === "string" &&
    path.isAbsolute(candidate.savePath) &&
    typeof candidate.url === "string" &&
    typeof candidate.initiatorOrigin === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.receivedBytes === "number" &&
    Number.isFinite(candidate.receivedBytes) &&
    typeof candidate.totalBytes === "number" &&
    Number.isFinite(candidate.totalBytes) &&
    typeof candidate.bytesPerSecond === "number" &&
    Number.isFinite(candidate.bytesPerSecond) &&
    typeof candidate.percentComplete === "number" &&
    Number.isFinite(candidate.percentComplete) &&
    isDownloadState(candidate.state) &&
    typeof candidate.canResume === "boolean" &&
    typeof candidate.potentiallyDangerous === "boolean" &&
    typeof candidate.startedAt === "number" &&
    Number.isFinite(candidate.startedAt) &&
    (candidate.endedAt === null ||
      (typeof candidate.endedAt === "number" &&
        Number.isFinite(candidate.endedAt)))
  );
}

function isDownloadState(value: unknown): value is DownloadState {
  return (
    value === "progressing" ||
    value === "paused" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}
