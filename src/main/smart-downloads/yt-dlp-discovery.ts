import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  ResolvedSmartDownloadChannel,
  ResolvedSmartDownloadVideo,
  SmartDownloadChannelDiscovery,
} from "./controller";
import type { FollowedChannel } from "./model";

const MAX_OUTPUT_BYTES = 6 * 1024 * 1024;
const EXTRACTION_TIMEOUT_MS = 75_000;

export interface YtDlpChannelDiscoveryOptions {
  executable: string;
  denoPath: string;
  spawnProcess?: (
    executable: string,
    args: readonly string[],
    options: Parameters<typeof spawn>[2],
  ) => ChildProcessWithoutNullStreams;
}

/** Bounded yt-dlp metadata extraction; no shell and no media is downloaded. */
export class YtDlpChannelDiscovery implements SmartDownloadChannelDiscovery {
  private readonly spawnProcess: NonNullable<
    YtDlpChannelDiscoveryOptions["spawnProcess"]
  >;

  constructor(private readonly options: YtDlpChannelDiscoveryOptions) {
    this.spawnProcess =
      options.spawnProcess ??
      ((executable, args, spawnOptions) =>
        spawn(
          executable,
          [...args],
          spawnOptions,
        ) as ChildProcessWithoutNullStreams);
  }

  async resolveChannel(
    input: string,
    recentLimit: number,
  ): Promise<ResolvedSmartDownloadChannel> {
    const url = normalizeChannelInput(input);
    const metadata = await this.extract(channelVideosUrl(url), recentLimit);
    return channelFromMetadata(metadata);
  }

  async discoverRecent(
    channel: FollowedChannel,
    recentLimit: number,
  ): Promise<ResolvedSmartDownloadVideo[]> {
    const metadata = await this.extract(
      `https://www.youtube.com/channel/${channel.id}/videos`,
      recentLimit,
    );
    return recentVideos(metadata);
  }

  async resolveVideoChannel(videoId: string): Promise<{
    channelId: string;
    title: string;
    handle: string | null;
    avatarUrl: string | null;
  }> {
    if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
      throw new TypeError("A canonical YouTube video ID is required.");
    }
    const metadata = await this.extract(
      `https://www.youtube.com/watch?v=${videoId}`,
      1,
    );
    const channelId = text(metadata.channel_id);
    if (!channelId || !/^UC[A-Za-z0-9_-]{22}$/u.test(channelId)) {
      throw new Error("The video's channel could not be resolved.");
    }
    return {
      channelId,
      title:
        text(metadata.channel)?.slice(0, 240) ??
        text(metadata.uploader)?.slice(0, 240) ??
        "YouTube channel",
      handle: normalizeHandle(text(metadata.uploader_id)),
      avatarUrl: bestThumbnail(metadata),
    };
  }

  private extract(url: string, requestedLimit: number): Promise<JsonRecord> {
    const limit = Math.max(1, Math.min(50, Math.floor(requestedLimit)));
    const args = [
      "--ignore-config",
      "--no-update",
      "--no-color",
      "--no-warnings",
      "--skip-download",
      "--flat-playlist",
      "--playlist-end",
      String(limit),
      "--encoding",
      "utf-8",
      "--js-runtimes",
      `deno:${this.options.denoPath}`,
      "--dump-single-json",
      url,
    ];
    return new Promise<JsonRecord>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(this.options.executable, args, {
          shell: false,
          windowsHide: true,
          env: { ...process.env, DENO_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
        });
      } catch (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as unknown;
          if (!isRecord(parsed))
            throw new Error("yt-dlp returned invalid metadata.");
          resolve(parsed);
        } catch (parseError) {
          reject(
            parseError instanceof Error
              ? parseError
              : new Error("yt-dlp returned invalid metadata."),
          );
        }
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("YouTube channel lookup timed out."));
      }, EXTRACTION_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
          child.kill();
          finish(
            new Error("YouTube channel metadata exceeded the safe limit."),
          );
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-4_096);
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (code === 0) finish();
        else
          finish(
            new Error(
              friendlyExtractionError(stderr) ||
                `YouTube channel lookup failed with exit code ${code ?? "unknown"}.`,
            ),
          );
      });
    });
  }
}

type JsonRecord = Record<string, unknown>;

export function normalizeChannelInput(input: string): string {
  const clean = input.trim();
  if (!clean || clean.length > 2_048)
    throw new TypeError("Enter a YouTube channel URL or @handle.");
  const candidate = clean.startsWith("@")
    ? `https://www.youtube.com/${clean}`
    : /^youtube\.com\//iu.test(clean) || /^www\.youtube\.com\//iu.test(clean)
      ? `https://${clean}`
      : clean;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError("Enter a valid YouTube channel URL or @handle.");
  }
  if (
    url.protocol !== "https:" ||
    !/^(www\.)?youtube\.com$/iu.test(url.hostname) ||
    !/^\/(?:@[A-Za-z0-9._-]+|channel\/UC[A-Za-z0-9_-]{22}|c\/[A-Za-z0-9._-]+)\/?$/u.test(
      url.pathname,
    )
  ) {
    throw new TypeError(
      "Only YouTube channel URLs and @handles are supported.",
    );
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/u, "");
}

function channelVideosUrl(url: string): string {
  return `${url.replace(/\/$/u, "")}/videos`;
}

function channelFromMetadata(value: JsonRecord): ResolvedSmartDownloadChannel {
  const firstEntry = entries(value)[0];
  const channelId = text(value.channel_id) ?? text(firstEntry?.channel_id);
  if (!channelId || !/^UC[A-Za-z0-9_-]{22}$/u.test(channelId)) {
    throw new Error(
      "The channel could not be resolved to a canonical YouTube ID.",
    );
  }
  const title =
    text(value.channel) ??
    text(value.uploader) ??
    text(value.title)?.replace(/\s+-\s+Videos$/iu, "") ??
    "YouTube channel";
  const handle = normalizeHandle(
    text(value.uploader_id) ?? text(firstEntry?.uploader_id),
  );
  return {
    channelId,
    title: title.slice(0, 240),
    handle,
    canonicalUrl:
      text(value.channel_url) ??
      text(value.uploader_url) ??
      `https://www.youtube.com/channel/${channelId}`,
    avatarUrl: bestThumbnail(value),
    recentVideos: recentVideos(value),
  };
}

function recentVideos(value: JsonRecord): ResolvedSmartDownloadVideo[] {
  return entries(value).flatMap((entry) => {
    const id = text(entry.id);
    if (!id || !/^[A-Za-z0-9_-]{11}$/u.test(id)) return [];
    const url = text(entry.url) ?? text(entry.webpage_url) ?? "";
    const liveStatus = text(entry.live_status);
    const kind =
      liveStatus === "is_live"
        ? "live"
        : liveStatus === "is_upcoming"
          ? "premiere"
          : liveStatus === "was_live"
            ? "livestream-replay"
            : url.includes("/shorts/")
              ? "short"
              : "video";
    return [
      {
        videoId: id,
        title: text(entry.title)?.slice(0, 240) ?? "YouTube video",
        publishedAt: timestamp(entry),
        sourceUrl: `https://www.youtube.com/watch?v=${id}`,
        thumbnailUrl: bestThumbnail(entry),
        kind,
      } satisfies ResolvedSmartDownloadVideo,
    ];
  });
}

function entries(value: JsonRecord): JsonRecord[] {
  return Array.isArray(value.entries)
    ? value.entries.filter(isRecord).slice(0, 50)
    : [];
}

function bestThumbnail(value: JsonRecord): string | null {
  if (!Array.isArray(value.thumbnails)) return null;
  for (const thumbnail of [...value.thumbnails].reverse()) {
    if (!isRecord(thumbnail)) continue;
    const url = text(thumbnail.url);
    if (url && /^https:\/\//iu.test(url) && url.length <= 8_192) return url;
  }
  return null;
}

function timestamp(value: JsonRecord): number | null {
  if (typeof value.timestamp === "number" && Number.isFinite(value.timestamp)) {
    return Math.max(0, Math.floor(value.timestamp * 1_000));
  }
  const uploadDate = text(value.upload_date);
  if (uploadDate && /^\d{8}$/u.test(uploadDate)) {
    const parsed = Date.parse(
      `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00Z`,
    );
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeHandle(value: string | null): string | null {
  if (!value) return null;
  const clean = value.startsWith("@") ? value : `@${value}`;
  return /^@[A-Za-z0-9._-]{1,64}$/u.test(clean) ? clean : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 8_192)
    : null;
}

function friendlyExtractionError(stderr: string): string | null {
  const lower = stderr.toLowerCase();
  if (lower.includes("unsupported url") || lower.includes("not a valid url"))
    return "This YouTube channel URL is not supported.";
  if (lower.includes("unavailable") || lower.includes("does not exist"))
    return "This YouTube channel is unavailable.";
  if (lower.includes("sign in") || lower.includes("login"))
    return "This channel requires authentication and cannot be followed automatically.";
  return null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
