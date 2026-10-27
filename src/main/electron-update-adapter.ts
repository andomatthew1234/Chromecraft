import { existsSync } from "node:fs";
import path from "node:path";

import { autoUpdater, type Event } from "electron";

import type { ApplicationChangeCategory } from "../shared/updates";
import type {
  ApplicationUpdateProgress,
  ApplicationUpdateRelease,
  ApplicationUpdateResult,
  UpdateAdapter,
} from "./update-manager";

export interface ElectronUpdateAdapterOptions {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  executablePath: string;
  feedUrl: string;
  releaseApiUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface GitHubReleaseMetadata {
  version: string;
  category: ApplicationChangeCategory;
  releaseNotes: string | null;
  publishedAt: string | null;
  downloadSizeBytes: number | null;
}

/** Bridges Electron's aggregate, signed whole-app updater into UpdateManager. */
export class ElectronUpdateAdapter implements UpdateAdapter {
  private readonly unavailableReason: string | null;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ElectronUpdateAdapterOptions) {
    this.unavailableReason = configureUpdater(options);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Math.max(10_000, options.timeoutMs ?? 120_000);
  }

  checkForUpdates(
    report: (progress: ApplicationUpdateProgress) => void,
  ): Promise<ApplicationUpdateResult> {
    if (this.unavailableReason) {
      return Promise.resolve({
        state: "unavailable",
        detail: this.unavailableReason,
      });
    }

    const metadataPromise = this.readReleaseMetadata().catch((error) => {
      console.warn("Could not read Chromecraft release metadata.", error);
      return null;
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new Error("The application update channel did not respond."));
      }, this.timeoutMs);
      timeout.unref?.();
      const cleanup = () => {
        clearTimeout(timeout);
        autoUpdater.removeListener("checking-for-update", checking);
        autoUpdater.removeListener("update-available", available);
        autoUpdater.removeListener("update-not-available", notAvailable);
        autoUpdater.removeListener("update-downloaded", downloaded);
        autoUpdater.removeListener("error", error);
      };
      const finish = (result: ApplicationUpdateResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (value: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(value);
      };
      const checking = () =>
        report({
          stage: "checking",
          label: "Checking the Chromecraft application",
        });
      const available = () =>
        report({
          stage: "downloading",
          label: "Downloading the verified Chromecraft application",
        });
      const notAvailable = () => finish({ state: "up-to-date" });
      const downloaded = async (
        _event: Event,
        releaseNotes: string,
        releaseName: string,
        releaseDate: Date,
      ) => {
        const metadata = await metadataPromise;
        finish({
          state: "ready",
          release: releaseSnapshot(
            releaseName,
            releaseNotes,
            releaseDate,
            metadata,
          ),
        });
      };
      const error = (value: Error) => fail(value);

      autoUpdater.on("checking-for-update", checking);
      autoUpdater.on("update-available", available);
      autoUpdater.on("update-not-available", notAvailable);
      autoUpdater.on("update-downloaded", downloaded);
      autoUpdater.on("error", error);
      checking();
      try {
        autoUpdater.checkForUpdates();
      } catch (value) {
        fail(
          value instanceof Error ? value : new Error("Update check failed."),
        );
      }
    });
  }

  restartAndInstall(): void {
    autoUpdater.quitAndInstall();
  }

  private async readReleaseMetadata(): Promise<GitHubReleaseMetadata | null> {
    if (!this.options.releaseApiUrl) return null;
    const url = new URL(this.options.releaseApiUrl);
    if (url.protocol !== "https:" || url.hostname !== "api.github.com") {
      throw new Error("Release metadata must come from the GitHub HTTPS API.");
    }
    const response = await this.fetch(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(
        `Release metadata request failed with HTTP ${response.status}.`,
      );
    }
    const value = (await response.json()) as Record<string, unknown>;
    if (value.draft === true || value.prerelease === true) return null;
    const tag = boundedString(value.tag_name, 80);
    if (!tag) return null;
    const body = boundedString(value.body, 100_000);
    const assets = Array.isArray(value.assets) ? value.assets : [];
    const updateAssetBytes = assets.reduce((total, asset) => {
      if (!asset || typeof asset !== "object") return total;
      const entry = asset as Record<string, unknown>;
      const name = boundedString(entry.name, 200);
      const size = entry.size;
      return name?.endsWith("-full.nupkg") &&
        typeof size === "number" &&
        Number.isFinite(size) &&
        size > 0
        ? total + size
        : total;
    }, 0);
    return {
      version: cleanVersion(tag),
      category: parseReleaseCategory(body),
      releaseNotes: stripMetadataComment(body),
      publishedAt: boundedString(value.published_at, 100),
      downloadSizeBytes: updateAssetBytes > 0 ? updateAssetBytes : null,
    };
  }
}

export function releaseSnapshot(
  releaseName: string,
  releaseNotes: string,
  releaseDate: Date,
  metadata: GitHubReleaseMetadata | null,
): ApplicationUpdateRelease {
  const notes = boundedString(releaseNotes, 100_000);
  const downloadedVersion = cleanVersion(releaseName);
  const matchingMetadata =
    metadata?.version === downloadedVersion ? metadata : null;
  return {
    version: downloadedVersion,
    category: matchingMetadata?.category ?? parseReleaseCategory(notes),
    releaseNotes: matchingMetadata?.releaseNotes ?? stripMetadataComment(notes),
    publishedAt:
      matchingMetadata?.publishedAt ??
      (releaseDate instanceof Date && Number.isFinite(releaseDate.getTime())
        ? releaseDate.toISOString()
        : null),
    downloadSizeBytes: matchingMetadata?.downloadSizeBytes ?? null,
  };
}

export function parseReleaseCategory(
  releaseNotes: string | null,
): ApplicationChangeCategory {
  if (!releaseNotes) return "both";
  const match = releaseNotes.match(
    /<!--\s*chromecraft-update:\s*(\{[^<>]{1,2000}\})\s*-->/iu,
  );
  if (!match) return "both";
  try {
    const value = JSON.parse(match[1]) as { category?: unknown };
    return value.category === "chromecraft" ||
      value.category === "dependencies" ||
      value.category === "both"
      ? value.category
      : "both";
  } catch {
    return "both";
  }
}

function stripMetadataComment(value: string | null): string | null {
  const clean = value
    ?.replace(/<!--\s*chromecraft-update:\s*\{[^<>]{1,2000}\}\s*-->/giu, "")
    .trim();
  return clean ? clean.slice(0, 100_000) : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function cleanVersion(value: string): string {
  const clean = value.trim().replace(/^v(?=\d)/iu, "");
  return clean.length > 0 && clean.length <= 80 ? clean : "new release";
}

function configureUpdater(
  options: ElectronUpdateAdapterOptions,
): string | null {
  if (!options.isPackaged) {
    return "Application updates require an installed Chromecraft build.";
  }
  if (options.platform === "linux") {
    return "Chromecraft application updates on Linux are installed through your system package manager.";
  }
  if (options.platform !== "win32") {
    return "This platform does not have a Chromecraft application update channel yet.";
  }

  const updateExecutable = path.resolve(
    path.dirname(options.executablePath),
    "..",
    "Update.exe",
  );
  if (!existsSync(updateExecutable)) {
    return "This portable build cannot replace its application runtime. Install ChromecraftSetup.exe to enable application updates.";
  }

  let feed: URL;
  try {
    feed = new URL(options.feedUrl);
  } catch {
    return "This installation does not have an application update channel configured.";
  }
  if (feed.protocol !== "https:") {
    return "The configured application update channel is not secure, so Chromecraft will not use it.";
  }

  try {
    autoUpdater.setFeedURL({ url: feed.href });
  } catch (error) {
    console.warn("Could not configure the Chromecraft update channel.", error);
    return "Chromecraft could not configure its application update channel.";
  }
  return null;
}
