import { existsSync } from "node:fs";
import path from "node:path";

import { autoUpdater, type Event } from "electron";

import type {
  ApplicationUpdateProgress,
  ApplicationUpdateResult,
  UpdateAdapter,
} from "./update-manager";

export interface ElectronUpdateAdapterOptions {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  executablePath: string;
  feedUrl: string;
}

/** Bridges Electron's aggregate, signed whole-app updater into UpdateManager. */
export class ElectronUpdateAdapter implements UpdateAdapter {
  private readonly unavailableReason: string | null;

  constructor(options: ElectronUpdateAdapterOptions) {
    this.unavailableReason = configureUpdater(options);
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

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        autoUpdater.removeListener("checking-for-update", checking);
        autoUpdater.removeListener("update-available", available);
        autoUpdater.removeListener("update-not-available", notAvailable);
        autoUpdater.removeListener("update-downloaded", downloaded);
        autoUpdater.removeListener("error", error);
      };
      const finish = (result: ApplicationUpdateResult) => {
        cleanup();
        resolve(result);
      };
      const checking = () =>
        report({
          stage: "checking",
          label: "Checking the ChromeCraft application",
        });
      const available = () =>
        report({
          stage: "downloading",
          label: "Downloading the verified ChromeCraft application",
        });
      const notAvailable = () => finish({ state: "up-to-date" });
      const downloaded = (
        _event: Event,
        _releaseNotes: string,
        releaseName: string,
      ) => finish({ state: "ready", version: releaseName });
      const error = (value: Error) => {
        cleanup();
        reject(value);
      };

      autoUpdater.on("checking-for-update", checking);
      autoUpdater.on("update-available", available);
      autoUpdater.on("update-not-available", notAvailable);
      autoUpdater.on("update-downloaded", downloaded);
      autoUpdater.on("error", error);
      checking();
      try {
        autoUpdater.checkForUpdates();
      } catch (value) {
        error(
          value instanceof Error ? value : new Error("Update check failed."),
        );
      }
    });
  }

  restartAndInstall(): void {
    autoUpdater.quitAndInstall();
  }
}

function configureUpdater(
  options: ElectronUpdateAdapterOptions,
): string | null {
  if (!options.isPackaged) {
    return "Application updates require an installed ChromeCraft build.";
  }
  if (options.platform === "linux") {
    return "ChromeCraft application updates on Linux are installed through your system package manager.";
  }
  if (options.platform !== "win32") {
    return "This platform does not have a ChromeCraft application update channel yet.";
  }

  const updateExecutable = path.resolve(
    path.dirname(options.executablePath),
    "..",
    "Update.exe",
  );
  if (!existsSync(updateExecutable)) {
    return "This portable build cannot replace its application runtime. Install ChromeCraft with ChromecraftSetup.exe to enable application updates.";
  }

  let feed: URL;
  try {
    feed = new URL(options.feedUrl);
  } catch {
    return "This installation does not have an application update channel configured.";
  }
  if (feed.protocol !== "https:") {
    return "The configured application update channel is not secure, so ChromeCraft will not use it.";
  }

  try {
    autoUpdater.setFeedURL({ url: feed.href });
  } catch (error) {
    console.warn("Could not configure the ChromeCraft update channel.", error);
    return "ChromeCraft could not configure its application update channel.";
  }
  return null;
}
