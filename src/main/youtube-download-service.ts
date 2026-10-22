import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import type {
  YouTubeDownloadItemSnapshot,
  YouTubeDownloadsSnapshot,
} from "../shared/browser";
import type { YouTubeWatchTarget } from "../shared/youtube-watch";

export type YouTubeDownloadQuality =
  | "best"
  | "1080p"
  | "720p"
  | "480p"
  | "audio";

export interface YouTubeDownloadRequestOptions {
  origin?: "manual" | "smart";
  quality?: YouTubeDownloadQuality;
  smartChannelId?: string | null;
}

export interface YouTubeDownloadCompletionContext {
  origin: "manual" | "smart";
  smartChannelId: string | null;
  thumbnailPath: string | null;
}

export const YT_DLP_VERSION = "2026.10.21";
const PROGRESS_PREFIX = "CHROMECRAFT_PROGRESS:";
const POSTPROCESS_PREFIX = "CHROMECRAFT_POSTPROCESS:";
const FILE_PREFIX = "CHROMECRAFT_FILE:";
const MAX_DIAGNOSTIC_LENGTH = 16_384;
const PROGRESS_EMIT_INTERVAL_MS = 100;

export interface MediaToolPaths {
  ytDlp: string;
  deno: string;
  integrity: string;
}

export interface YouTubeDownloadServiceOptions {
  downloadsDirectory: string;
  smartDownloadsDirectory?: string;
  thumbnailDirectory?: string;
  toolsDirectory: string;
  onChange?: (snapshot: YouTubeDownloadsSnapshot) => void;
  onCompleted?: (
    item: YouTubeDownloadItemSnapshot,
    savePath: string,
    context: YouTubeDownloadCompletionContext,
  ) => boolean | Promise<boolean>;
  spawnProcess?: (
    executable: string,
    args: readonly string[],
    options: Parameters<typeof spawn>[2],
  ) => ChildProcessWithoutNullStreams;
}

interface DownloadJob {
  snapshot: YouTubeDownloadItemSnapshot;
  process: ChildProcessWithoutNullStreams | null;
  finalPath: string | null;
  stagingDirectory: string;
  reportedPath: string | null;
  stdoutBuffer: string;
  diagnostics: string;
  destinationDirectory: string;
  quality: YouTubeDownloadQuality;
}

export function mediaToolPaths(toolsDirectory: string): MediaToolPaths {
  const key = `${process.platform}-${process.arch}`;
  const directory = path.join(toolsDirectory, "bin", key);
  return {
    ytDlp: path.join(
      directory,
      process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
    ),
    deno: path.join(
      directory,
      process.platform === "win32" ? "deno.exe" : "deno",
    ),
    integrity: path.join(directory, "integrity.json"),
  };
}

export function buildYtDlpArguments(
  target: YouTubeWatchTarget,
  stagingDirectory: string,
  denoPath: string,
  quality: YouTubeDownloadQuality = "best",
): string[] {
  const canonicalUrl = `https://www.youtube.com/watch?v=${target.videoId}`;
  const format =
    quality === "audio"
      ? "bestaudio/best"
      : quality === "best"
        ? "best[ext=mp4]/best"
        : `best[height<=${quality.slice(0, -1)}][ext=mp4]/best[height<=${quality.slice(0, -1)}]/best`;
  return [
    "--ignore-config",
    "--no-update",
    "--no-playlist",
    "--no-color",
    "--newline",
    "--progress",
    "--progress-delta",
    "0.1",
    "--encoding",
    "utf-8",
    "--js-runtimes",
    `deno:${denoPath}`,
    "--format",
    format,
    "--write-thumbnail",
    "--output",
    path.join(stagingDirectory, "%(title).160s [%(id)s].%(ext)s"),
    "--progress-template",
    `download:${PROGRESS_PREFIX}%(progress)j`,
    "--progress-template",
    `postprocess:${POSTPROCESS_PREFIX}%(progress)j`,
    "--print",
    `after_move:${FILE_PREFIX}%(filepath)j`,
    canonicalUrl,
  ];
}

export function parseYtDlpFileLine(line: string): string | null {
  if (!line.startsWith(FILE_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(FILE_PREFIX.length)) as unknown;
    return typeof value === "string" && value.trim() && value.length <= 32_768
      ? value
      : null;
  } catch {
    return null;
  }
}

export function parseYtDlpProgressLine(
  line: string,
): Partial<YouTubeDownloadItemSnapshot> | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as Record<
      string,
      unknown
    >;
    const receivedBytes = finitePositive(value.downloaded_bytes);
    const totalBytes =
      finitePositive(value.total_bytes) ||
      finitePositive(value.total_bytes_estimate);
    const rawPercent =
      typeof value._percent_str === "string"
        ? Number.parseFloat(value._percent_str.replace("%", "").trim())
        : totalBytes > 0
          ? (receivedBytes / totalBytes) * 100
          : Number.NaN;
    return {
      receivedBytes,
      totalBytes,
      // A progress hook can reach 100% for an individual format before yt-dlp
      // downloads another stream or runs its post-processors. Completion is
      // only truthful after the after_move hook and a clean process exit.
      percent: Number.isFinite(rawPercent)
        ? Math.min(99, Math.max(0, rawPercent))
        : null,
      bytesPerSecond: finiteOptional(value.speed),
      etaSeconds: finiteOptional(value.eta),
      filename:
        typeof value.filename === "string" && value.filename.trim()
          ? path.basename(value.filename)
          : null,
    };
  } catch {
    return null;
  }
}

export function isYtDlpPostprocessLine(line: string): boolean {
  if (!line.startsWith(POSTPROCESS_PREFIX)) return false;
  try {
    JSON.parse(line.slice(POSTPROCESS_PREFIX.length));
    return true;
  } catch {
    return false;
  }
}

function isActiveStage(stage: YouTubeDownloadItemSnapshot["stage"]): boolean {
  return (
    stage === "pending" || stage === "downloading" || stage === "finishing"
  );
}

export class YouTubeDownloadService {
  private readonly jobs = new Map<string, DownloadJob>();
  private readonly spawnProcess: NonNullable<
    YouTubeDownloadServiceOptions["spawnProcess"]
  >;
  private verified = false;
  private disposed = false;
  private emitTimer: NodeJS.Timeout | null = null;
  private lastEmitAt = 0;

  constructor(private readonly options: YouTubeDownloadServiceOptions) {
    this.spawnProcess =
      options.spawnProcess ??
      ((executable, args, spawnOptions) =>
        spawn(
          executable,
          [...args],
          spawnOptions,
        ) as ChildProcessWithoutNullStreams);
  }

  get snapshot(): YouTubeDownloadsSnapshot {
    return {
      available: this.verified,
      ytDlpVersion: YT_DLP_VERSION,
      items: [...this.jobs.values()]
        .map((job) => structuredClone(job.snapshot))
        .sort((a, b) => b.startedAt - a.startedAt),
    };
  }

  canStartAutomaticDownload(): boolean {
    const active = [...this.jobs.values()].filter((job) =>
      isActiveStage(job.snapshot.stage),
    );
    return (
      this.verified &&
      !this.disposed &&
      active.length < 2 &&
      !active.some((job) => (job.snapshot.origin ?? "manual") === "manual")
    );
  }

  async initialize(): Promise<void> {
    await verifyMediaTools(mediaToolPaths(this.options.toolsDirectory));
    await this.recoverInterruptedJobs();
    this.verified = true;
    this.emit(true);
  }

  async start(target: YouTubeWatchTarget): Promise<string> {
    return this.startWithOptions(target);
  }

  async startWithOptions(
    target: YouTubeWatchTarget,
    request: YouTubeDownloadRequestOptions = {},
  ): Promise<string> {
    if (this.disposed) throw new Error("YouTube downloads are shutting down.");
    if (!this.verified)
      throw new Error("The bundled YouTube downloader is unavailable.");
    const existing = [...this.jobs.values()].find(
      (job) =>
        job.snapshot.videoId === target.videoId &&
        isActiveStage(job.snapshot.stage),
    );
    if (existing) return existing.snapshot.id;
    const activeJobs = [...this.jobs.values()].filter((job) =>
      isActiveStage(job.snapshot.stage),
    ).length;
    if (activeJobs >= 2) {
      throw new Error("Two YouTube videos are already downloading.");
    }
    const finished = [...this.jobs.values()]
      .filter((job) => !isActiveStage(job.snapshot.stage))
      .sort((a, b) => b.snapshot.startedAt - a.snapshot.startedAt);
    for (const oldJob of finished.slice(20))
      this.jobs.delete(oldJob.snapshot.id);

    const id = randomUUID();
    const origin = request.origin ?? "manual";
    const destinationDirectory =
      origin === "smart"
        ? (this.options.smartDownloadsDirectory ??
          path.join(
            this.options.downloadsDirectory,
            ".chromecraft-smart-downloads",
          ))
        : this.options.downloadsDirectory;
    const stagingDirectory = path.join(
      this.options.downloadsDirectory,
      ".chromecraft-media",
      id,
    );
    await fs.mkdir(stagingDirectory, { recursive: true });
    const job: DownloadJob = {
      process: null,
      finalPath: null,
      stagingDirectory,
      reportedPath: null,
      stdoutBuffer: "",
      diagnostics: "",
      destinationDirectory,
      quality: request.quality ?? "best",
      snapshot: {
        id,
        videoId: target.videoId,
        sourceUrl: `https://www.youtube.com/watch?v=${target.videoId}`,
        filename: null,
        stage: "pending",
        percent: null,
        receivedBytes: 0,
        totalBytes: 0,
        bytesPerSecond: null,
        etaSeconds: null,
        error: null,
        savedToGallery: false,
        origin,
        smartChannelId:
          origin === "smart" ? (request.smartChannelId ?? null) : null,
        startedAt: Date.now(),
        finishedAt: null,
      },
    };
    this.jobs.set(id, job);
    await this.writeRecoveryManifest(job);
    const tools = mediaToolPaths(this.options.toolsDirectory);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(
        tools.ytDlp,
        buildYtDlpArguments(target, stagingDirectory, tools.deno, job.quality),
        {
          cwd: stagingDirectory,
          shell: false,
          windowsHide: true,
          env: { ...process.env, DENO_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
          detached: process.platform !== "win32",
        },
      );
      job.process = child;
    } catch (error) {
      await this.fail(job, error);
      throw error;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(job, chunk));
    child.stderr.on("data", (chunk: string) => {
      job.diagnostics = `${job.diagnostics}${chunk}`.slice(
        -MAX_DIAGNOSTIC_LENGTH,
      );
    });
    child.once("error", (error) => void this.fail(job, error));
    child.once("close", (code, signal) => void this.finish(job, code, signal));
    this.emit(true);
    return id;
  }

  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || !isActiveStage(job.snapshot.stage)) return false;
    job.snapshot.stage = "cancelled";
    job.snapshot.finishedAt = Date.now();
    job.snapshot.bytesPerSecond = null;
    job.snapshot.etaSeconds = null;
    if (job.process) await terminateProcessTree(job.process);
    await this.cleanStaging(job);
    this.emit(true);
    return true;
  }

  async retry(id: string): Promise<string> {
    const job = this.jobs.get(id);
    if (
      !job ||
      !["failed", "cancelled", "interrupted"].includes(job.snapshot.stage)
    ) {
      throw new Error(
        "Only failed, cancelled, or interrupted YouTube downloads can be retried.",
      );
    }
    return this.startWithOptions(
      {
        videoId: job.snapshot.videoId,
        url: job.snapshot.sourceUrl,
      },
      {
        origin: job.snapshot.origin ?? "manual",
        smartChannelId: job.snapshot.smartChannelId ?? null,
        quality: job.quality,
      },
    );
  }

  async resolveCompletedPath(id: string): Promise<string | null> {
    const job = this.jobs.get(id);
    if (job?.snapshot.stage !== "completed" || !job.finalPath) return null;
    try {
      const resolved = await fs.realpath(job.finalPath);
      const root = await fs.realpath(this.options.downloadsDirectory);
      const relative = path.relative(root, resolved);
      if (
        !relative ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        return null;
      if (!(await fs.stat(resolved)).isFile()) return null;
      return resolved;
    } catch {
      return null;
    }
  }

  dismiss(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || isActiveStage(job.snapshot.stage)) return false;
    const deleted = this.jobs.delete(id);
    if (deleted) this.emit(true);
    return deleted;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(
      [...this.jobs.values()]
        .filter((job) => isActiveStage(job.snapshot.stage))
        .map(async (job) => {
          if (job.process) await terminateProcessTree(job.process);
          job.snapshot.stage = "interrupted";
          job.snapshot.finishedAt = Date.now();
          job.snapshot.error =
            "Download interrupted because Chromecraft closed.";
          job.snapshot.bytesPerSecond = null;
          job.snapshot.etaSeconds = null;
        }),
    );
    this.emit(true);
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
  }

  private consumeStdout(job: DownloadJob, chunk: string): void {
    job.stdoutBuffer += chunk;
    const lines = job.stdoutBuffer.split(/\r?\n/u);
    job.stdoutBuffer = lines.pop()?.slice(-65_536) ?? "";
    for (const line of lines) {
      const progress = parseYtDlpProgressLine(line.trim());
      if (progress) {
        job.snapshot.stage = "downloading";
        Object.assign(job.snapshot, progress);
        this.emit();
      } else if (isYtDlpPostprocessLine(line.trim())) {
        job.snapshot.stage = "finishing";
        job.snapshot.percent = null;
        job.snapshot.bytesPerSecond = null;
        job.snapshot.etaSeconds = null;
        this.emit(true);
      } else {
        const reportedPath = parseYtDlpFileLine(line.trim());
        if (!reportedPath) continue;
        job.reportedPath = reportedPath;
        job.snapshot.stage = "finishing";
        job.snapshot.percent = null;
        job.snapshot.bytesPerSecond = null;
        job.snapshot.etaSeconds = null;
        this.emit(true);
      }
    }
  }

  private async writeRecoveryManifest(job: DownloadJob): Promise<void> {
    const manifest = path.join(job.stagingDirectory, "job.json");
    const temporary = `${manifest}.tmp`;
    await fs.writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        id: job.snapshot.id,
        videoId: job.snapshot.videoId,
        sourceUrl: job.snapshot.sourceUrl,
        startedAt: job.snapshot.startedAt,
        origin: job.snapshot.origin ?? "manual",
        smartChannelId: job.snapshot.smartChannelId ?? null,
        quality: job.quality,
      }),
      "utf8",
    );
    await fs.rename(temporary, manifest);
  }

  private async recoverInterruptedJobs(): Promise<void> {
    const root = path.join(
      this.options.downloadsDirectory,
      ".chromecraft-media",
    );
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stagingDirectory = path.join(root, entry.name);
      try {
        const raw = JSON.parse(
          await fs.readFile(path.join(stagingDirectory, "job.json"), "utf8"),
        ) as Record<string, unknown>;
        if (
          raw.version !== 1 ||
          typeof raw.id !== "string" ||
          raw.id !== entry.name ||
          typeof raw.videoId !== "string" ||
          !/^[a-zA-Z0-9_-]{11}$/u.test(raw.videoId) ||
          typeof raw.sourceUrl !== "string" ||
          raw.sourceUrl !== `https://www.youtube.com/watch?v=${raw.videoId}` ||
          typeof raw.startedAt !== "number" ||
          !Number.isFinite(raw.startedAt) ||
          !["manual", "smart"].includes(String(raw.origin ?? "manual")) ||
          !["best", "1080p", "720p", "480p", "audio"].includes(
            String(raw.quality ?? "best"),
          )
        ) {
          throw new Error("Invalid recovery manifest.");
        }
        this.jobs.set(raw.id, {
          process: null,
          finalPath: null,
          stagingDirectory,
          reportedPath: null,
          stdoutBuffer: "",
          diagnostics: "",
          destinationDirectory:
            raw.origin === "smart"
              ? (this.options.smartDownloadsDirectory ??
                path.join(
                  this.options.downloadsDirectory,
                  ".chromecraft-smart-downloads",
                ))
              : this.options.downloadsDirectory,
          quality: (raw.quality ?? "best") as YouTubeDownloadQuality,
          snapshot: {
            id: raw.id,
            videoId: raw.videoId,
            sourceUrl: raw.sourceUrl,
            filename: null,
            stage: "interrupted",
            percent: null,
            receivedBytes: 0,
            totalBytes: 0,
            bytesPerSecond: null,
            etaSeconds: null,
            error: "Download interrupted when Chromecraft closed.",
            savedToGallery: false,
            origin: raw.origin === "smart" ? "smart" : "manual",
            smartChannelId:
              raw.origin === "smart" && typeof raw.smartChannelId === "string"
                ? raw.smartChannelId.slice(0, 256)
                : null,
            startedAt: raw.startedAt,
            finishedAt: Date.now(),
          },
        });
      } catch {
        // Unknown files are never trusted as download state; the bounded staging
        // directory is still safe to remove because Chromecraft created it.
      }
      await fs.rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  private async finish(
    job: DownloadJob,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (!isActiveStage(job.snapshot.stage)) return;
    if (job.stdoutBuffer.trim()) {
      this.consumeStdout(job, "\n");
    }
    if (code !== 0 || signal || !job.reportedPath) {
      await this.fail(
        job,
        new Error(`yt-dlp exited with ${code ?? signal ?? "an unknown error"}`),
      );
      return;
    }
    try {
      const source = await assertFileInside(
        job.reportedPath,
        job.stagingDirectory,
      );
      const destination = await moveWithoutOverwrite(
        source,
        job.destinationDirectory,
      );
      const thumbnailPath = await this.commitThumbnail(job);
      job.snapshot.filename = path.basename(destination);
      job.finalPath = destination;
      job.snapshot.finishedAt = Date.now();
      job.snapshot.error = null;
      job.snapshot.bytesPerSecond = null;
      job.snapshot.etaSeconds = null;
      try {
        job.snapshot.savedToGallery =
          (await this.options.onCompleted?.(
            structuredClone(job.snapshot),
            destination,
            {
              origin: job.snapshot.origin ?? "manual",
              smartChannelId: job.snapshot.smartChannelId ?? null,
              thumbnailPath,
            },
          )) ?? false;
      } catch (error) {
        job.snapshot.savedToGallery = false;
        console.warn(
          "Could not finish registering the downloaded video.",
          error,
        );
      }
      job.snapshot.stage = "completed";
      job.snapshot.percent = 100;
      await this.cleanStaging(job);
      this.emit(true);
    } catch (error) {
      await this.fail(job, error);
    }
  }

  private async fail(job: DownloadJob, error: unknown): Promise<void> {
    if (["completed", "failed", "cancelled"].includes(job.snapshot.stage))
      return;
    job.snapshot.stage = "failed";
    job.snapshot.finishedAt = Date.now();
    job.snapshot.error = friendlyDownloadError(error, job.diagnostics);
    job.snapshot.bytesPerSecond = null;
    job.snapshot.etaSeconds = null;
    await this.cleanStaging(job);
    this.emit(true);
  }

  private async cleanStaging(job: DownloadJob): Promise<void> {
    await fs.rm(job.stagingDirectory, { recursive: true, force: true });
  }

  private async commitThumbnail(job: DownloadJob): Promise<string | null> {
    if (!this.options.thumbnailDirectory) return null;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(job.stagingDirectory, { withFileTypes: true });
    } catch {
      return null;
    }
    const allowed = new Set([
      ".avif",
      ".gif",
      ".jpeg",
      ".jpg",
      ".png",
      ".webp",
    ]);
    const thumbnail = entries.find(
      (entry) =>
        entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase()),
    );
    if (!thumbnail) return null;
    const source = await assertFileInside(
      path.join(job.stagingDirectory, thumbnail.name),
      job.stagingDirectory,
    );
    await fs.mkdir(this.options.thumbnailDirectory, { recursive: true });
    const extension = path.extname(thumbnail.name).toLowerCase();
    const destination = path.join(
      this.options.thumbnailDirectory,
      `${job.snapshot.videoId}${extension}`,
    );
    await fs.copyFile(source, destination);
    return destination;
  }

  private emit(immediate = false): void {
    if (!this.options.onChange) return;
    const notify = (): void => {
      this.emitTimer = null;
      this.lastEmitAt = Date.now();
      this.options.onChange?.(this.snapshot);
    };
    if (immediate) {
      if (this.emitTimer) {
        clearTimeout(this.emitTimer);
        this.emitTimer = null;
      }
      notify();
      return;
    }
    if (this.emitTimer) return;
    const delay = Math.max(
      0,
      PROGRESS_EMIT_INTERVAL_MS - (Date.now() - this.lastEmitAt),
    );
    if (delay === 0) notify();
    else this.emitTimer = setTimeout(notify, delay);
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(file));
  return hash.digest("hex");
}

async function verifyMediaTools(tools: MediaToolPaths): Promise<void> {
  const integrity = JSON.parse(await fs.readFile(tools.integrity, "utf8")) as {
    ytDlp?: { sha256?: unknown };
    deno?: { sha256?: unknown };
  };
  for (const [label, file, expected] of [
    ["yt-dlp", tools.ytDlp, integrity.ytDlp?.sha256],
    ["Deno", tools.deno, integrity.deno?.sha256],
  ] as const) {
    if (typeof expected !== "string" || (await sha256(file)) !== expected) {
      throw new Error(`${label} failed its bundled integrity check.`);
    }
    if (process.platform !== "win32") await fs.access(file, fsConstants.X_OK);
  }
}

async function assertFileInside(
  candidate: string,
  directory: string,
): Promise<string> {
  const [realDirectory, realCandidate] = await Promise.all([
    fs.realpath(directory),
    fs.realpath(path.resolve(candidate)),
  ]);
  const relative = path.relative(realDirectory, realCandidate);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("yt-dlp reported an unsafe output path.");
  }
  const stat = await fs.stat(realCandidate);
  if (!stat.isFile()) throw new Error("yt-dlp did not produce a video file.");
  return realCandidate;
}

async function moveWithoutOverwrite(
  source: string,
  directory: string,
): Promise<string> {
  const extension = path.extname(source);
  const stem = path.basename(source, extension);
  await fs.mkdir(directory, { recursive: true });
  for (let index = 0; index < 10_000; index += 1) {
    const filename =
      index === 0 ? `${stem}${extension}` : `${stem} (${index})${extension}`;
    const destination = path.join(directory, filename);
    try {
      await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      await fs.rm(source, { force: true });
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not choose a unique filename for the video.");
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          shell: false,
          windowsHide: true,
        },
      );
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function finitePositive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function finiteOptional(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function friendlyDownloadError(error: unknown, diagnostics: string): string {
  const detail =
    `${error instanceof Error ? error.message : String(error)}\n${diagnostics}`.toLowerCase();
  if (detail.includes("video unavailable")) return "This video is unavailable.";
  if (detail.includes("sign in") || detail.includes("private video"))
    return "This video requires a signed-in YouTube session, which Chromecraft does not share with yt-dlp yet.";
  if (detail.includes("copyright"))
    return "YouTube did not allow this video to be downloaded.";
  return "The video could not be downloaded. Check the connection and try again.";
}
