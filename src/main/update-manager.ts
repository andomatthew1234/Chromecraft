import type {
  InstalledVersionSnapshot,
  UpdateSnapshot,
} from "../shared/updates";

export type UpdateAdapterEvent =
  | { type: "checking" }
  | { type: "available"; version?: string }
  | { type: "not-available" }
  | { type: "downloaded"; version: string }
  | { type: "error"; error: unknown };

export interface UpdateAdapter {
  readonly unavailableReason: string | null;
  checkForUpdates(): Promise<void>;
  restartAndInstall(): void;
  subscribe(listener: (event: UpdateAdapterEvent) => void): () => void;
}

export interface UpdateManagerOptions {
  adapter: UpdateAdapter;
  installedVersions: InstalledVersionSnapshot[];
  emit(snapshot: UpdateSnapshot): void;
  prepareForRestart(): Promise<void>;
  now?: () => number;
}

const genericUpdateError =
  "ChromeCraft couldn't check for updates. Check your connection and try again.";

/**
 * Owns the complete user-triggered update lifecycle behind three operations:
 * read state, check, and restart. Package selection and installation stay in
 * the platform adapter so the renderer never receives file or feed access.
 */
export class UpdateManager {
  private value: UpdateSnapshot;
  private checkPromise: Promise<UpdateSnapshot> | null = null;
  private restartPromise: Promise<void> | null = null;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;

  constructor(private readonly options: UpdateManagerOptions) {
    this.now = options.now ?? Date.now;
    this.value = {
      status: "idle",
      installedVersions: structuredClone(options.installedVersions),
      readyUpdates: [],
      checkedAt: null,
      message: null,
      canCheck: true,
      canRestart: false,
    };
    this.unsubscribe = options.adapter.subscribe((event) =>
      this.handleAdapterEvent(event),
    );
  }

  get snapshot(): UpdateSnapshot {
    return structuredClone(this.value);
  }

  check(): Promise<UpdateSnapshot> {
    if (this.checkPromise) return this.checkPromise;
    if (this.value.status === "downloading" || this.value.status === "ready") {
      return Promise.resolve(this.snapshot);
    }

    this.checkPromise = this.runCheck().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  restart(): Promise<void> {
    if (!this.value.canRestart || this.value.status !== "ready") {
      return Promise.reject(
        new Error("An update must finish downloading before restart."),
      );
    }
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = this.options
      .prepareForRestart()
      .then(() => this.options.adapter.restartAndInstall())
      .finally(() => {
        this.restartPromise = null;
      });
    return this.restartPromise;
  }

  dispose(): void {
    this.unsubscribe();
  }

  private async runCheck(): Promise<UpdateSnapshot> {
    if (this.options.adapter.unavailableReason) {
      this.set({
        status: "unavailable",
        checkedAt: this.now(),
        message: this.options.adapter.unavailableReason,
        canCheck: true,
        canRestart: false,
        readyUpdates: [],
      });
      return this.snapshot;
    }

    this.set({
      status: "checking",
      message: "Checking the complete ChromeCraft release…",
      canCheck: false,
      canRestart: false,
      readyUpdates: [],
    });
    try {
      await this.options.adapter.checkForUpdates();
    } catch (error) {
      this.handleAdapterEvent({ type: "error", error });
    }
    return this.snapshot;
  }

  private handleAdapterEvent(event: UpdateAdapterEvent): void {
    switch (event.type) {
      case "checking":
        this.set({
          status: "checking",
          message: "Checking the complete ChromeCraft release…",
          canCheck: false,
          canRestart: false,
          readyUpdates: [],
        });
        break;
      case "available":
        this.set({
          status: "downloading",
          message: event.version
            ? `Downloading ChromeCraft ${cleanVersion(event.version)}…`
            : "Downloading the latest verified ChromeCraft release…",
          canCheck: false,
          canRestart: false,
          readyUpdates: [],
        });
        break;
      case "not-available":
        this.set({
          status: "up-to-date",
          checkedAt: this.now(),
          message: "ChromeCraft and its bundled engine are up to date.",
          canCheck: true,
          canRestart: false,
          readyUpdates: [],
        });
        break;
      case "downloaded": {
        const currentVersion =
          this.value.installedVersions.find((item) => item.id === "chromecraft")
            ?.version ?? "unknown";
        const nextVersion = cleanVersion(event.version);
        this.set({
          status: "ready",
          checkedAt: this.now(),
          message: "All update files are downloaded and verified.",
          canCheck: false,
          canRestart: true,
          readyUpdates: [
            {
              id: "chromecraft-release",
              label: "ChromeCraft runtime and bundled dependencies",
              fromVersion: currentVersion,
              toVersion: nextVersion,
              includes: [
                "Electron engine",
                "Chromium engine",
                "Node.js runtime",
                "Application dependencies",
              ],
            },
          ],
        });
        break;
      }
      case "error":
        console.warn("ChromeCraft update check failed.", event.error);
        this.set({
          status: "error",
          checkedAt: this.now(),
          message: genericUpdateError,
          canCheck: true,
          canRestart: false,
          readyUpdates: [],
        });
        break;
    }
  }

  private set(patch: Partial<UpdateSnapshot>): void {
    this.value = { ...this.value, ...patch };
    this.options.emit(this.snapshot);
  }
}

function cleanVersion(value: string): string {
  const clean = value.trim().replace(/^v(?=\d)/iu, "");
  return clean.length > 0 && clean.length <= 80 ? clean : "new release";
}
