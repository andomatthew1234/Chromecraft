import type {
  InstalledVersionSnapshot,
  UpdateProgressSnapshot,
  UpdateResultSnapshot,
  UpdateSnapshot,
} from "../shared/updates";

export interface ApplicationUpdateProgress {
  stage: "checking" | "downloading";
  label: string;
}

export type ApplicationUpdateResult =
  | { state: "ready"; version: string }
  | { state: "up-to-date" }
  | { state: "unavailable"; detail: string };

export interface ExtensionUpdateProgress {
  label: string;
  receivedBytes?: number;
  totalBytes?: number;
}

export interface ExtensionUpdateResult {
  id: string;
  name: string;
  fromVersion: string;
  toVersion: string | null;
  state:
    | "installed"
    | "up-to-date"
    | "unavailable"
    | "approval-required"
    | "failed";
  detail?: string;
}

export interface UpdateAdapter {
  checkForUpdates(
    report: (progress: ApplicationUpdateProgress) => void,
  ): Promise<ApplicationUpdateResult>;
  restartAndInstall(): void;
}

export interface ExtensionUpdateProvider {
  checkAndInstallUpdates(
    report: (progress: ExtensionUpdateProgress) => void,
  ): Promise<ExtensionUpdateResult[]>;
}

export interface UpdateManagerOptions {
  adapter: UpdateAdapter;
  extensions?: ExtensionUpdateProvider;
  installedVersions: InstalledVersionSnapshot[];
  emit(snapshot: UpdateSnapshot): void;
  prepareForRestart(): Promise<void>;
  now?: () => number;
}

const genericUpdateError =
  "ChromeCraft couldn't check the application update channel. Check your connection and try again.";

export class UpdateManager {
  private value: UpdateSnapshot;
  private checkPromise: Promise<UpdateSnapshot> | null = null;
  private restartPromise: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: UpdateManagerOptions) {
    this.now = options.now ?? Date.now;
    this.value = {
      status: "idle",
      installedVersions: structuredClone(options.installedVersions),
      results: [],
      progress: null,
      checkedAt: null,
      message: null,
      canCheck: true,
      canRestart: false,
    };
  }

  get snapshot(): UpdateSnapshot {
    return structuredClone(this.value);
  }

  check(): Promise<UpdateSnapshot> {
    if (this.checkPromise) return this.checkPromise;
    if (this.value.status === "ready") return Promise.resolve(this.snapshot);

    this.checkPromise = this.runCheck().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  restart(): Promise<void> {
    if (!this.value.canRestart || this.value.status !== "ready") {
      return Promise.reject(
        new Error(
          "An application update must finish downloading before restart.",
        ),
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
    // Reserved for future update providers that own disposable resources.
  }

  private async runCheck(): Promise<UpdateSnapshot> {
    const results: UpdateResultSnapshot[] = [];
    let extensionSourceFailed = false;
    let extensionSourceChecked = false;
    let appSourceFailed = false;

    this.set({
      status: "checking",
      message: "Checking ChromeCraft and installed extensions…",
      canCheck: false,
      canRestart: false,
      results: [],
      progress: progressSnapshot("Checking installed extensions"),
    });

    if (this.options.extensions) {
      try {
        const extensionResults =
          await this.options.extensions.checkAndInstallUpdates((progress) => {
            this.set({
              status:
                progress.receivedBytes !== undefined
                  ? "downloading"
                  : "checking",
              message: `${progress.label}…`,
              progress: progressSnapshot(
                progress.label,
                progress.receivedBytes,
                progress.totalBytes,
              ),
            });
          });
        extensionSourceChecked = true;
        results.push(...extensionResults.map(extensionResultSnapshot));
      } catch (error) {
        extensionSourceFailed = true;
        console.warn("ChromeCraft extension update check failed.", error);
      }
    }

    try {
      const application = await this.options.adapter.checkForUpdates(
        (progress) => {
          this.set({
            status:
              progress.stage === "downloading" ? "downloading" : "checking",
            message: `${progress.label}…`,
            progress: progressSnapshot(progress.label),
          });
        },
      );
      results.push(
        applicationResultSnapshot(application, this.currentAppVersion),
      );
    } catch (error) {
      appSourceFailed = true;
      console.warn("ChromeCraft application update check failed.", error);
      results.push({
        id: "chromecraft-release",
        kind: "application",
        label: "ChromeCraft application",
        fromVersion: this.currentAppVersion,
        toVersion: null,
        state: "failed",
        requiresRestart: false,
        includes: applicationIncludes,
        detail: genericUpdateError,
      });
    }

    const hasReadyApplication = results.some(
      (result) => result.kind === "application" && result.state === "ready",
    );
    const installedCount = results.filter(
      (result) => result.state === "installed",
    ).length;
    const hasLimit =
      extensionSourceFailed ||
      appSourceFailed ||
      results.some((result) =>
        ["unavailable", "approval-required", "failed"].includes(result.state),
      );
    const status: UpdateSnapshot["status"] = hasReadyApplication
      ? "ready"
      : installedCount > 0
        ? hasLimit
          ? "partial"
          : "complete"
        : hasLimit
          ? extensionSourceChecked ||
            results.some((result) => result.state === "up-to-date")
            ? "partial"
            : appSourceFailed || extensionSourceFailed
              ? "error"
              : "unavailable"
          : "up-to-date";

    this.set({
      status,
      results,
      progress: null,
      checkedAt: this.now(),
      message: finalMessage(status, installedCount, extensionSourceFailed),
      canCheck: !hasReadyApplication,
      canRestart: hasReadyApplication,
    });
    return this.snapshot;
  }

  private get currentAppVersion(): string {
    return (
      this.value.installedVersions.find((item) => item.id === "chromecraft")
        ?.version ?? "unknown"
    );
  }

  private set(patch: Partial<UpdateSnapshot>): void {
    this.value = { ...this.value, ...patch };
    this.options.emit(this.snapshot);
  }
}

const applicationIncludes = [
  "Electron engine",
  "Chromium engine",
  "yt-dlp and its Deno runtime",
  "Node.js runtime",
  "Application dependencies",
];

function applicationResultSnapshot(
  result: ApplicationUpdateResult,
  currentVersion: string,
): UpdateResultSnapshot {
  return {
    id: "chromecraft-release",
    kind: "application",
    label: "ChromeCraft runtime and bundled dependencies",
    fromVersion: currentVersion,
    toVersion: result.state === "ready" ? cleanVersion(result.version) : null,
    state: result.state,
    requiresRestart: result.state === "ready",
    includes: applicationIncludes,
    detail: result.state === "unavailable" ? result.detail : null,
  };
}

function extensionResultSnapshot(
  result: ExtensionUpdateResult,
): UpdateResultSnapshot {
  return {
    id: `extension:${result.id}`,
    kind: "extension",
    label: result.name,
    fromVersion: result.fromVersion,
    toVersion: result.toVersion,
    state: result.state,
    requiresRestart: false,
    includes: ["Browser extension"],
    detail: result.detail ?? null,
  };
}

function progressSnapshot(
  label: string,
  receivedBytes?: number,
  totalBytes?: number,
): UpdateProgressSnapshot {
  const received = finiteNonNegative(receivedBytes);
  const total = finitePositive(totalBytes);
  return {
    label,
    receivedBytes: received,
    totalBytes: total,
    percent:
      received !== null && total !== null
        ? Math.min(100, Math.max(0, (received / total) * 100))
        : null,
  };
}

function finiteNonNegative(value?: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function finitePositive(value?: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function finalMessage(
  status: UpdateSnapshot["status"],
  installedCount: number,
  extensionSourceFailed: boolean,
): string {
  switch (status) {
    case "ready":
      return installedCount > 0
        ? `Installed ${installedCount} extension update${installedCount === 1 ? "" : "s"}. A ChromeCraft update is downloaded and ready to restart.`
        : "A verified ChromeCraft update is downloaded and ready to restart.";
    case "complete":
      return `Installed ${installedCount} extension update${installedCount === 1 ? "" : "s"}. ChromeCraft is otherwise up to date.`;
    case "partial":
      return installedCount > 0
        ? `Installed ${installedCount} extension update${installedCount === 1 ? "" : "s"}. Some updates could not be applied automatically.`
        : "The available update sources were checked, but some items need attention or cannot update in this build.";
    case "up-to-date":
      return "ChromeCraft and installed extensions are up to date.";
    case "unavailable":
      return "This build cannot update the ChromeCraft application. Installed extensions were still checked.";
    case "error":
      return extensionSourceFailed
        ? "ChromeCraft could not finish checking the available update sources."
        : genericUpdateError;
    default:
      return "Update check finished.";
  }
}

function cleanVersion(value: string): string {
  const clean = value.trim().replace(/^v(?=\d)/iu, "");
  return clean.length > 0 && clean.length <= 80 ? clean : "new release";
}
