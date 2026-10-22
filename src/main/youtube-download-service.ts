import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import type {
  YouTubeDownloadItemSnapshot,
  YouTubeDownloadsSnapshot,
} from "../shared/browser";
import type { YouTubeWatchTarget } from "../shared/youtube-watch";

export const YT_DLP_VERSION = "2026.10.21";
const PROGRESS_PREFIX = "CHROMECRAFT_PROGRESS:";
const FILE_PREFIX = "CHROMECRAFT_FILE:";
const MAX_DIAGNOSTIC_LENGTH = 16_384;

export interface MediaToolPaths {
  ytDlp: string;
  deno: string;
  integrity: string;
}

export interface YouTubeDownloadServiceOptions {
  downloadsDirectory: string;
  toolsDirectory: string;
  onChange?: (snapshot: YouTubeDownloadsSnapshot) => void;
  onCompleted?: (item: YouTubeDownloadItemSnapshot, savePath: string) => void;
  spawnProcess?: (
    executable: string,
    args: readonly string[],
    options: Parameters<typeof spawn>[2],
  ) => ChildProcessWithoutNullStreams;
}

interface DownloadJob {
  snapshot: YouTubeDownloadItemSnapshot;
  process: ChildProcessWithoutNullStreams;
  stagingDirectory: string;
  reportedPath: string | null;
  stdoutBuffer: string;
  diagnostics: string;
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
): string[] {
  const canonicalUrl = `https://www.youtube.com/watch?v=${target.videoId}`;
  return [
    "--ignore-config",
    "--no-update",
    "--no-playlist",
    "--no-color",
    "--newline",
    "--progress",
    "--encoding",
    "utf-8",
    "--js-runtimes",
    `deno:${denoPath}`,
    "--format",
    "best[ext=mp4]/best",
    "--output",
    path.join(stagingDirectory, "%(title).160s [%(id)s].%(ext)s"),
    "--progress-template",
    `download:${PROGRESS_PREFIX}%(progress)j`,
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
      percent: Number.isFinite(rawPercent)
        ? Math.min(100, Math.max(0, rawPercent))
        : null,
      filename:
        typeof value.filename === "string" && value.filename.trim()
          ? path.basename(value.filename)
          : null,
    };
  } catch {
    return null;
  }
}

export class YouTubeDownloadService {
  private readonly jobs = new Map<string, DownloadJob>();
  private readonly spawnProcess: NonNullable<
    YouTubeDownloadServiceOptions["spawnProcess"]
  >;
  private verified = false;
  private disposed = false;

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

  async initialize(): Promise<void> {
    await verifyMediaTools(mediaToolPaths(this.options.toolsDirectory));
    this.verified = true;
    this.emit();
  }

  async start(target: YouTubeWatchTarget): Promise<string> {
    if (this.disposed) throw new Error("YouTube downloads are shutting down.");
    if (!this.verified)
      throw new Error("The bundled YouTube downloader is unavailable.");
    const existing = [...this.jobs.values()].find(
      (job) =>
        job.snapshot.videoId === target.videoId &&
        ["downloading", "finishing"].includes(job.snapshot.stage),
    );
    if (existing) return existing.snapshot.id;
    const activeJobs = [...this.jobs.values()].filter((job) =>
      ["downloading", "finishing"].includes(job.snapshot.stage),
    ).length;
    if (activeJobs >= 2) {
      throw new Error("Two YouTube videos are already downloading.");
    }
    const finished = [...this.jobs.values()]
      .filter(
        (job) => !["downloading", "finishing"].includes(job.snapshot.stage),
      )
      .sort((a, b) => b.snapshot.startedAt - a.snapshot.startedAt);
    for (const oldJob of finished.slice(20))
      this.jobs.delete(oldJob.snapshot.id);

    const id = randomUUID();
    const stagingDirectory = path.join(
      this.options.downloadsDirectory,
      ".chromecraft-media",
      id,
    );
    await fs.mkdir(stagingDirectory, { recursive: true });
    const tools = mediaToolPaths(this.options.toolsDirectory);
    const child = this.spawnProcess(
      tools.ytDlp,
      buildYtDlpArguments(target, stagingDirectory, tools.deno),
      {
        cwd: stagingDirectory,
        shell: false,
        windowsHide: true,
        env: { ...process.env, DENO_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
        detached: process.platform !== "win32",
      },
    );
    const job: DownloadJob = {
      process: child,
      stagingDirectory,
      reportedPath: null,
      stdoutBuffer: "",
      diagnostics: "",
      snapshot: {
        id,
        videoId: target.videoId,
        sourceUrl: `https://www.youtube.com/watch?v=${target.videoId}`,
        filename: null,
        stage: "downloading",
        percent: null,
        receivedBytes: 0,
        totalBytes: 0,
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
      },
    };
    this.jobs.set(id, job);
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
    this.emit();
    return id;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(
      [...this.jobs.values()]
        .filter((job) =>
          ["downloading", "finishing"].includes(job.snapshot.stage),
        )
        .map(async (job) => {
          await terminateProcessTree(job.process);
          job.snapshot.stage = "cancelled";
          job.snapshot.finishedAt = Date.now();
          await this.cleanStaging(job);
        }),
    );
    this.emit();
  }

  private consumeStdout(job: DownloadJob, chunk: string): void {
    job.stdoutBuffer += chunk;
    const lines = job.stdoutBuffer.split(/\r?\n/u);
    job.stdoutBuffer = lines.pop()?.slice(-65_536) ?? "";
    for (const line of lines) {
      const progress = parseYtDlpProgressLine(line.trim());
      if (progress) {
        Object.assign(job.snapshot, progress);
        this.emit();
      } else {
        const reportedPath = parseYtDlpFileLine(line.trim());
        if (!reportedPath) continue;
        job.reportedPath = reportedPath;
        job.snapshot.stage = "finishing";
        job.snapshot.percent = 100;
        this.emit();
      }
    }
  }

  private async finish(
    job: DownloadJob,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (!["downloading", "finishing"].includes(job.snapshot.stage)) return;
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
        this.options.downloadsDirectory,
      );
      job.snapshot.stage = "completed";
      job.snapshot.percent = 100;
      job.snapshot.filename = path.basename(destination);
      job.snapshot.finishedAt = Date.now();
      job.snapshot.error = null;
      this.options.onCompleted?.(structuredClone(job.snapshot), destination);
      await this.cleanStaging(job);
      this.emit();
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
    await this.cleanStaging(job);
    this.emit();
  }

  private async cleanStaging(job: DownloadJob): Promise<void> {
    await fs.rm(job.stagingDirectory, { recursive: true, force: true });
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot);
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
