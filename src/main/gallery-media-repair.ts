import { randomUUID } from "node:crypto";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import type {
  GalleryEntrySnapshot,
  GalleryMediaRepairRequest,
  GalleryMediaRepairResult,
} from "../shared/browser";
import { parseYouTubeWatchUrl } from "../shared/youtube-watch";
import {
  hasSupportedThumbnailSignature,
  type GalleryStore,
} from "./gallery-store";
import {
  parseYtDlpInfoJson,
  type YouTubeDownloadedMediaMetadata,
} from "./youtube-download-service";

const IMAGE_EXTENSIONS = [".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"];
const MAX_REPAIR_ITEMS = 2_000;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 90_000;

export interface GalleryMediaToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GalleryMediaRepairOptions {
  gallery: GalleryStore;
  downloadsDirectory: string;
  thumbnailDirectory: string;
  ytDlpPath: string;
  denoPath: string;
  ffprobePath?: string;
  ffmpegPath?: string;
  /** Remote repair is allowed only after the bundled downloader passed integrity checks. */
  canFetchOriginals?: () => boolean;
  runTool?: (
    executable: string,
    args: readonly string[],
  ) => Promise<GalleryMediaToolResult>;
}

/**
 * Repairs durable Gallery media assets. Renderer callers receive only counts;
 * local paths stay in the main process and every copied asset is re-homed into
 * Chromecraft's owned thumbnail cache before it is exposed by opaque ID.
 */
export class GalleryMediaRepairService {
  private readonly downloadsDirectory: string;
  private readonly thumbnailDirectory: string;
  private readonly runTool: NonNullable<GalleryMediaRepairOptions["runTool"]>;
  private readonly ffprobePath: Promise<string | null>;
  private readonly ffmpegPath: Promise<string | null>;
  private inFlight: Promise<GalleryMediaRepairResult> | null = null;

  constructor(private readonly options: GalleryMediaRepairOptions) {
    this.downloadsDirectory = path.resolve(options.downloadsDirectory);
    this.thumbnailDirectory = path.resolve(options.thumbnailDirectory);
    this.runTool = options.runTool ?? runTool;
    this.ffprobePath = resolveOptionalExecutable(
      options.ffprobePath,
      "ffprobe",
    );
    this.ffmpegPath = resolveOptionalExecutable(options.ffmpegPath, "ffmpeg");
  }

  repair(
    request: GalleryMediaRepairRequest,
  ): Promise<GalleryMediaRepairResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runRepair(request).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runRepair(
    request: GalleryMediaRepairRequest,
  ): Promise<GalleryMediaRepairResult> {
    await fs.mkdir(this.thumbnailDirectory, { recursive: true });
    const result: GalleryMediaRepairResult = {
      scanned: 0,
      thumbnailsRepaired: 0,
      originalThumbnailsFetched: 0,
      localFallbacksGenerated: 0,
      metadataRecovered: 0,
      missingThumbnails: 0,
      metadataUnavailable: 0,
      errors: [],
    };

    for (const entry of this.options.gallery.snapshot.items.slice(
      0,
      MAX_REPAIR_ITEMS,
    )) {
      result.scanned += 1;
      try {
        await this.repairEntry(entry, request, result);
      } catch (error) {
        result.errors.push({
          id: entry.id,
          message: friendlyRepairError(error),
        });
      }
    }
    return result;
  }

  private async repairEntry(
    entry: GalleryEntrySnapshot,
    request: GalleryMediaRepairRequest,
    result: GalleryMediaRepairResult,
  ): Promise<void> {
    const mediaPath = await this.options.gallery.resolveFile(entry.id);
    if (!mediaPath) return;

    let fetchedMetadata: YouTubeDownloadedMediaMetadata | null = null;
    if (!(await this.options.gallery.resolveThumbnail(entry.id))) {
      let repaired = await this.findExistingThumbnail(entry, mediaPath);
      if (!repaired && request.fetchOriginalThumbnails) {
        const fetched = await this.fetchOriginalThumbnail(entry);
        repaired = fetched.thumbnailPath;
        fetchedMetadata = fetched.metadata;
        if (repaired) result.originalThumbnailsFetched += 1;
      }
      if (!repaired && request.generateLocalFallbacks) {
        repaired = await this.generateLocalFallback(entry, mediaPath);
        if (repaired) result.localFallbacksGenerated += 1;
      }
      if (repaired) {
        await this.options.gallery.setThumbnail(entry.id, repaired);
        if (await this.options.gallery.resolveThumbnail(entry.id)) {
          result.thumbnailsRepaired += 1;
        } else {
          result.missingThumbnails += 1;
        }
      } else {
        result.missingThumbnails += 1;
      }
    }

    const metadata =
      fetchedMetadata ??
      (await this.readAdjacentInfo(mediaPath)) ??
      (await this.probeMedia(mediaPath));
    const recovered = {
      title: metadata?.title ?? entry.sourceTitle ?? null,
      durationSeconds: metadata?.durationSeconds ?? entry.durationSeconds,
      width: metadata?.width ?? entry.width,
      height: metadata?.height ?? entry.height,
      videoFormat:
        metadata?.videoFormat ??
        entry.videoFormat ??
        (path.extname(mediaPath).slice(1).toUpperCase() || null),
    };
    const filledMissingField =
      (entry.durationSeconds === null && recovered.durationSeconds !== null) ||
      (entry.width === null && recovered.width !== null) ||
      (entry.height === null && recovered.height !== null) ||
      (!entry.videoFormat && !!recovered.videoFormat) ||
      (!entry.sourceTitle && !!recovered.title);
    await this.options.gallery.updateTechnicalMetadata(entry.id, {
      durationSeconds: recovered.durationSeconds,
      width: recovered.width,
      height: recovered.height,
      videoFormat: recovered.videoFormat,
      sourceTitle: recovered.title,
    });
    if (filledMissingField) result.metadataRecovered += 1;
    if (
      recovered.durationSeconds === null ||
      recovered.width === null ||
      recovered.height === null
    ) {
      result.metadataUnavailable += 1;
    }
  }

  private async findExistingThumbnail(
    entry: GalleryEntrySnapshot,
    mediaPath: string,
  ): Promise<string | null> {
    const videoId = youtubeVideoId(entry.sourceUrl);
    const cacheStems = [videoId, entry.id].filter(Boolean) as string[];
    for (const stem of cacheStems) {
      for (const extension of IMAGE_EXTENSIONS) {
        const candidate = await resolveOwnedFile(
          path.join(this.thumbnailDirectory, `${stem}${extension}`),
          this.thumbnailDirectory,
        );
        if (candidate && (await hasSupportedThumbnailSignature(candidate))) {
          return candidate;
        }
      }
    }

    const mediaStem = mediaPath.slice(0, -path.extname(mediaPath).length);
    for (const extension of IMAGE_EXTENSIONS) {
      const sidecar = await resolveOwnedFile(
        `${mediaStem}${extension}`,
        this.downloadsDirectory,
      );
      if (sidecar && (await hasSupportedThumbnailSignature(sidecar))) {
        return this.copyIntoThumbnailCache(entry, sidecar);
      }
    }
    return null;
  }

  private async fetchOriginalThumbnail(entry: GalleryEntrySnapshot): Promise<{
    thumbnailPath: string | null;
    metadata: YouTubeDownloadedMediaMetadata | null;
  }> {
    if (this.options.canFetchOriginals && !this.options.canFetchOriginals()) {
      return { thumbnailPath: null, metadata: null };
    }
    const target = entry.sourceUrl
      ? parseYouTubeWatchUrl(entry.sourceUrl)
      : null;
    if (!target || target.videoId.length !== 11) {
      return { thumbnailPath: null, metadata: null };
    }
    const temporaryDirectory = path.join(
      this.thumbnailDirectory,
      `.repair-${entry.id}-${randomUUID()}`,
    );
    await fs.mkdir(temporaryDirectory, { recursive: false });
    try {
      const output = path.join(temporaryDirectory, `${entry.id}.%(ext)s`);
      const execution = await this.runTool(this.options.ytDlpPath, [
        "--ignore-config",
        "--no-update",
        "--no-playlist",
        "--no-color",
        "--encoding",
        "utf-8",
        "--js-runtimes",
        `deno:${this.options.denoPath}`,
        "--skip-download",
        "--write-thumbnail",
        "--write-info-json",
        "--output",
        output,
        `https://www.youtube.com/watch?v=${target.videoId}`,
      ]);
      if (execution.code !== 0) {
        throw new Error("Original artwork could not be downloaded.");
      }
      const entries = await fs.readdir(temporaryDirectory, {
        withFileTypes: true,
      });
      const thumbnail = entries.find(
        (candidate) =>
          candidate.isFile() &&
          IMAGE_EXTENSIONS.includes(path.extname(candidate.name).toLowerCase()),
      );
      const info = entries.find(
        (candidate) =>
          candidate.isFile() && candidate.name.endsWith(".info.json"),
      );
      return {
        thumbnailPath: thumbnail
          ? await this.copyIntoThumbnailCache(
              entry,
              path.join(temporaryDirectory, thumbnail.name),
            )
          : null,
        metadata: info
          ? await readInfoFile(
              path.join(temporaryDirectory, info.name),
              temporaryDirectory,
            )
          : null,
      };
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async generateLocalFallback(
    entry: GalleryEntrySnapshot,
    mediaPath: string,
  ): Promise<string | null> {
    const ffmpeg = await this.ffmpegPath;
    if (!ffmpeg) return null;
    const temporary = path.join(
      this.thumbnailDirectory,
      `.${entry.id}-${randomUUID()}.jpg`,
    );
    try {
      const execution = await this.runTool(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        "00:00:01",
        "-i",
        mediaPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=1280:-2",
        "-y",
        temporary,
      ]);
      if (execution.code !== 0) return null;
      return await this.copyIntoThumbnailCache(entry, temporary);
    } catch {
      return null;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async readAdjacentInfo(
    mediaPath: string,
  ): Promise<YouTubeDownloadedMediaMetadata | null> {
    const stem = mediaPath.slice(0, -path.extname(mediaPath).length);
    const infoPath = await resolveOwnedFile(
      `${stem}.info.json`,
      this.downloadsDirectory,
    );
    return infoPath ? readInfoFile(infoPath, this.downloadsDirectory) : null;
  }

  private async probeMedia(
    mediaPath: string,
  ): Promise<YouTubeDownloadedMediaMetadata | null> {
    const ffprobe = await this.ffprobePath;
    if (!ffprobe) return null;
    try {
      const execution = await this.runTool(ffprobe, [
        "-v",
        "error",
        "-show_entries",
        "format=duration,format_name:stream=codec_type,width,height",
        "-of",
        "json",
        mediaPath,
      ]);
      return execution.code === 0 ? parseFfprobeJson(execution.stdout) : null;
    } catch {
      return null;
    }
  }

  private async copyIntoThumbnailCache(
    entry: GalleryEntrySnapshot,
    candidate: string,
  ): Promise<string | null> {
    const extension = path.extname(candidate).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(extension)) return null;
    const source =
      (await resolveOwnedFile(candidate, this.thumbnailDirectory)) ??
      (await resolveOwnedFile(candidate, this.downloadsDirectory));
    if (!source) return null;
    if (!(await hasSupportedThumbnailSignature(source))) return null;
    const stem = youtubeVideoId(entry.sourceUrl) ?? entry.id;
    const destination = path.join(
      this.thumbnailDirectory,
      `${stem}${extension}`,
    );
    if (path.resolve(source) === path.resolve(destination)) return source;
    const existing = await resolveOwnedFile(
      destination,
      this.thumbnailDirectory,
    );
    if (existing && (await hasSupportedThumbnailSignature(existing))) {
      return existing;
    }
    const temporary = path.join(
      this.thumbnailDirectory,
      `.${stem}-${randomUUID()}${extension}`,
    );
    try {
      await fs.copyFile(source, temporary);
      // This exact destination is an owned cache key. Replacing an invalid
      // file or symlink is safe and prevents a stale entry from blocking repair.
      await fs.rm(destination, { force: true });
      await fs.rename(temporary, destination);
      return resolveOwnedFile(destination, this.thumbnailDirectory);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function parseFfprobeJson(
  value: string,
): YouTubeDownloadedMediaMetadata | null {
  try {
    const parsed = JSON.parse(value) as {
      format?: { duration?: unknown; format_name?: unknown };
      streams?: Array<{
        codec_type?: unknown;
        width?: unknown;
        height?: unknown;
      }>;
    };
    const video = parsed.streams?.find(
      (stream) => stream.codec_type === "video",
    );
    const finite = (input: unknown): number | null => {
      if (input === null || input === undefined || input === "") return null;
      const number =
        typeof input === "string" ? Number.parseFloat(input) : Number(input);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const dimension = (input: unknown): number | null => {
      const number = finite(input);
      return number !== null && Number.isInteger(number) && number <= 65_535
        ? number
        : null;
    };
    const format =
      typeof parsed.format?.format_name === "string"
        ? parsed.format.format_name.split(",")[0]?.trim().toUpperCase() || null
        : null;
    const metadata = {
      title: null,
      durationSeconds: finite(parsed.format?.duration),
      width: dimension(video?.width),
      height: dimension(video?.height),
      videoFormat: format,
    };
    return metadata.durationSeconds !== null ||
      metadata.width !== null ||
      format
      ? metadata
      : null;
  } catch {
    return null;
  }
}

async function readInfoFile(
  candidate: string,
  root: string,
): Promise<YouTubeDownloadedMediaMetadata | null> {
  const safePath = await resolveOwnedFile(candidate, root);
  if (!safePath) return null;
  const stat = await fs.stat(safePath);
  if (stat.size < 2 || stat.size > MAX_TOOL_OUTPUT_BYTES) return null;
  try {
    return parseYtDlpInfoJson(JSON.parse(await fs.readFile(safePath, "utf8")));
  } catch {
    return null;
  }
}

async function resolveOwnedFile(
  candidate: string,
  root: string,
): Promise<string | null> {
  try {
    const [realRoot, realCandidate, stat] = await Promise.all([
      fs.realpath(root),
      fs.realpath(candidate),
      fs.stat(candidate),
    ]);
    const relative = path.relative(realRoot, realCandidate);
    return stat.isFile() &&
      relative.length > 0 &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
      ? realCandidate
      : null;
  } catch {
    return null;
  }
}

function youtubeVideoId(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  const target = parseYouTubeWatchUrl(sourceUrl);
  return target?.videoId.length === 11 ? target.videoId : null;
}

function friendlyRepairError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/iu.test(message)) return "Media inspection timed out.";
  if (/artwork/iu.test(message))
    return "Original artwork could not be retrieved.";
  return "This item could not be repaired.";
}

async function resolveOptionalExecutable(
  configured: string | undefined,
  name: "ffmpeg" | "ffprobe",
): Promise<string | null> {
  const candidates: string[] = [];
  if (configured) {
    if (!path.isAbsolute(configured)) return null;
    candidates.push(configured);
  } else {
    const executableName = process.platform === "win32" ? `${name}.exe` : name;
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      // Empty and relative PATH entries mean the current directory; never run
      // optional media tools from the browser/app working directory.
      if (!directory || !path.isAbsolute(directory)) continue;
      candidates.push(path.join(directory, executableName));
    }
  }
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      if (process.platform !== "win32") {
        await fs.access(candidate, fsConstants.X_OK);
      }
      return await fs.realpath(candidate);
    } catch {
      // Try the next explicit PATH entry.
    }
  }
  return null;
}

async function runTool(
  executable: string,
  args: readonly string[],
): Promise<GalleryMediaToolResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: "pipe",
      } satisfies SpawnOptions) as ChildProcessWithoutNullStreams;
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Media tool timed out."));
    }, TOOL_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (exceeded) return;
      if (
        Buffer.byteLength(stdout) + Buffer.byteLength(chunk) >
        MAX_TOOL_OUTPUT_BYTES
      ) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (exceeded) return;
      if (
        Buffer.byteLength(stderr) + Buffer.byteLength(chunk) >
        MAX_TOOL_OUTPUT_BYTES
      ) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceeded) {
        reject(new Error("Media tool output exceeded the safe limit."));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
