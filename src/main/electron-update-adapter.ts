import { existsSync } from "node:fs";
import path from "node:path";

import { autoUpdater, type Event } from "electron";

import type { UpdateAdapter, UpdateAdapterEvent } from "./update-manager";

export interface ElectronUpdateAdapterOptions {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  executablePath: string;
  feedUrl: string;
}

/** Bridges Electron's aggregate, signed whole-app updater into UpdateManager. */
export class ElectronUpdateAdapter implements UpdateAdapter {
  readonly unavailableReason: string | null;

  constructor(options: ElectronUpdateAdapterOptions) {
    this.unavailableReason = configureUpdater(options);
  }

  async checkForUpdates(): Promise<void> {
    await autoUpdater.checkForUpdates();
  }

  restartAndInstall(): void {
    autoUpdater.quitAndInstall();
  }

  subscribe(listener: (event: UpdateAdapterEvent) => void): () => void {
    const checking = () => listener({ type: "checking" });
    const available = () => listener({ type: "available" });
    const notAvailable = () => listener({ type: "not-available" });
    const downloaded = (
      _event: Event,
      _releaseNotes: string,
      releaseName: string,
    ) => listener({ type: "downloaded", version: releaseName });
    const error = (value: Error) => listener({ type: "error", error: value });

    autoUpdater.on("checking-for-update", checking);
    autoUpdater.on("update-available", available);
    autoUpdater.on("update-not-available", notAvailable);
    autoUpdater.on("update-downloaded", downloaded);
    autoUpdater.on("error", error);
    return () => {
      autoUpdater.removeListener("checking-for-update", checking);
      autoUpdater.removeListener("update-available", available);
      autoUpdater.removeListener("update-not-available", notAvailable);
      autoUpdater.removeListener("update-downloaded", downloaded);
      autoUpdater.removeListener("error", error);
    };
  }
}

function configureUpdater(
  options: ElectronUpdateAdapterOptions,
): string | null {
  if (!options.isPackaged) {
    return "Update checks are available in an installed ChromeCraft build.";
  }
  if (options.platform === "linux") {
    return "ChromeCraft updates on Linux are installed through your system package manager.";
  }
  if (options.platform !== "win32") {
    return "This platform does not have a ChromeCraft update channel yet.";
  }

  const updateExecutable = path.resolve(
    path.dirname(options.executablePath),
    "..",
    "Update.exe",
  );
  if (!existsSync(updateExecutable)) {
    return "This portable build cannot update itself. Install ChromeCraft with ChromecraftSetup.exe to enable updates.";
  }

  let feed: URL;
  try {
    feed = new URL(options.feedUrl);
  } catch {
    return "This installation does not have an update channel configured.";
  }
  if (feed.protocol !== "https:") {
    return "The configured update channel is not secure, so ChromeCraft will not use it.";
  }

  try {
    autoUpdater.setFeedURL({ url: feed.href });
  } catch (error) {
    console.warn("Could not configure the ChromeCraft update channel.", error);
    return "ChromeCraft could not configure its update channel.";
  }
  return null;
}
