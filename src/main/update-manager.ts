import type {
  ApplicationChangeCategory,
  ApplicationReleaseSnapshot,
  ExtensionUpdateItemSnapshot,
  InstalledVersionSnapshot,
  UpdateCategoryId,
  UpdateCategorySnapshot,
  UpdateHistoryEntry,
  UpdatePreferences,
  UpdateProgressSnapshot,
  UpdateResultSnapshot,
  UpdateSnapshot,
} from "../shared/updates";
import type {
  PersistentExtensionUpdateStatus,
  PersistentUpdateState,
} from "./update-state-store";

export interface ApplicationUpdateProgress {
  stage: "checking" | "downloading";
  label: string;
}

export interface ApplicationUpdateRelease {
  version: string;
  category: ApplicationChangeCategory;
  releaseNotes?: string | null;
  publishedAt?: string | null;
  downloadSizeBytes?: number | null;
}

export type ApplicationUpdateResult =
  | { state: "ready"; release: ApplicationUpdateRelease }
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

export interface InstalledExtensionForUpdates {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  sourceUrl: string;
  iconDataUrl: string | null;
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
    extensionIds?: readonly string[],
  ): Promise<ExtensionUpdateResult[]>;
}

export interface UpdateManagerOptions {
  adapter: UpdateAdapter;
  extensions?: ExtensionUpdateProvider;
  installedVersions: InstalledVersionSnapshot[];
  installedExtensions?: InstalledExtensionForUpdates[];
  persistentState: PersistentUpdateState;
  automaticEligible: boolean;
  emit(snapshot: UpdateSnapshot): void;
  persist(state: PersistentUpdateState): Promise<void>;
  prepareForRestart(): Promise<void>;
  notifyUpdateReady?(release: ApplicationReleaseSnapshot): void;
  now?: () => number;
  startupDelayMs?: number;
  intervalMs?: number;
}

interface CheckScope {
  application: boolean;
  extensionIds: readonly string[] | null | false;
  automatic: boolean;
}

const defaultAutomaticIntervalMs = 6 * 60 * 60 * 1_000;
const defaultStartupDelayMs = 45_000;
const maximumHistoryEntries = 100;
const extensionIdPattern = /^[a-p]{32}$/;

const genericUpdateError =
  "Chromecraft couldn't check the application update channel. Check your connection and try again.";

export class UpdateManager {
  private value: UpdateSnapshot;
  private checkPromise: Promise<UpdateSnapshot> | null = null;
  private activeCheckScope: CheckScope | null = null;
  private restartPromise: Promise<void> | null = null;
  private automaticTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private lastAutomaticCheckAt: number | null;
  private durableExtensionStatuses: PersistentExtensionUpdateStatus[];
  private disposed = false;

  constructor(private readonly options: UpdateManagerOptions) {
    this.now = options.now ?? Date.now;
    this.lastAutomaticCheckAt = options.persistentState.lastAutomaticCheckAt;
    const persistedExtensions = new Map(
      options.persistentState.extensionStatuses.map((item) => [item.id, item]),
    );
    this.value = {
      status: "idle",
      installedVersions: structuredClone(options.installedVersions),
      results: [],
      extensions: (options.installedExtensions ?? []).map((extension) =>
        restoreExtensionItem(extension, persistedExtensions.get(extension.id)),
      ),
      categories: emptyCategories(options.installedVersions),
      history: structuredClone(options.persistentState.history),
      preferences: structuredClone(options.persistentState.preferences),
      applicationRelease: null,
      progress: null,
      checkedAt: null,
      message: null,
      canCheck: true,
      canRestart: false,
    };
    this.durableExtensionStatuses = extensionStatusesFor(
      this.value.extensions,
      [],
    );
    this.refreshCategories();
  }

  get snapshot(): UpdateSnapshot {
    return structuredClone(this.value);
  }

  check(): Promise<UpdateSnapshot> {
    return this.runScopedCheck({
      application: true,
      extensionIds: null,
      automatic: false,
    });
  }

  checkApplication(): Promise<UpdateSnapshot> {
    return this.runScopedCheck({
      application: true,
      extensionIds: false,
      automatic: false,
    });
  }

  updateExtension(extensionId: string): Promise<UpdateSnapshot> {
    if (!extensionIdPattern.test(extensionId)) {
      return Promise.reject(new Error("Invalid extension identifier."));
    }
    if (!this.value.extensions.some((item) => item.id === extensionId)) {
      return Promise.reject(new Error("That extension is not installed."));
    }
    return this.runScopedCheck({
      application: false,
      extensionIds: [extensionId],
      automatic: false,
    });
  }

  updateExtensions(): Promise<UpdateSnapshot> {
    return this.runScopedCheck({
      application: false,
      extensionIds: null,
      automatic: false,
    });
  }

  setInstalledExtensions(extensions: InstalledExtensionForUpdates[]): void {
    const previous = new Map(
      this.value.extensions.map((item) => [item.id, item]),
    );
    this.set({
      extensions: extensions.map((extension) => {
        const existing = previous.get(extension.id);
        const next = extensionItem(extension);
        if (!existing || existing.provider !== next.provider) return next;
        if (
          existing.state === "approval-required" &&
          existing.availableVersion &&
          extensionVersionAtLeast(extension.version, existing.availableVersion)
        ) {
          return {
            ...next,
            state: "installed",
            detail: null,
            lastCheckedAt: existing.lastCheckedAt,
          };
        }
        return {
          ...next,
          availableVersion: existing.availableVersion,
          state: existing.state,
          detail: existing.detail,
          lastCheckedAt: existing.lastCheckedAt,
        };
      }),
    });
  }

  async setPreferences(
    patch: Partial<UpdatePreferences>,
  ): Promise<UpdateSnapshot> {
    const previous = this.value.preferences;
    const next: UpdatePreferences = {
      automaticChecksEnabled:
        typeof patch.automaticChecksEnabled === "boolean"
          ? patch.automaticChecksEnabled
          : this.value.preferences.automaticChecksEnabled,
      automaticExtensionUpdatesEnabled:
        typeof patch.automaticExtensionUpdatesEnabled === "boolean"
          ? patch.automaticExtensionUpdatesEnabled
          : this.value.preferences.automaticExtensionUpdatesEnabled,
      notifyWhenReady:
        typeof patch.notifyWhenReady === "boolean"
          ? patch.notifyWhenReady
          : this.value.preferences.notifyWhenReady,
    };
    this.set({ preferences: next });
    try {
      await this.persist();
    } catch (error) {
      this.set({ preferences: previous });
      throw error;
    }
    this.scheduleAutomaticCheck();
    return this.snapshot;
  }

  startAutomaticChecks(): void {
    this.scheduleAutomaticCheck(true);
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
    this.disposed = true;
    if (this.automaticTimer) clearTimeout(this.automaticTimer);
    this.automaticTimer = null;
  }

  private runScopedCheck(scope: CheckScope): Promise<UpdateSnapshot> {
    if (this.checkPromise) {
      return this.activeCheckScope &&
        checkScopesEqual(this.activeCheckScope, scope)
        ? this.checkPromise
        : Promise.reject(
            new Error(
              "Another update operation is already in progress. Try again when it finishes.",
            ),
          );
    }
    const effectiveScope =
      scope.application && this.value.status === "ready"
        ? { ...scope, application: false }
        : scope;
    if (!effectiveScope.application && effectiveScope.extensionIds === false) {
      return Promise.resolve(this.snapshot);
    }
    this.activeCheckScope = cloneCheckScope(scope);
    this.checkPromise = this.runCheck(effectiveScope).finally(() => {
      this.checkPromise = null;
      this.activeCheckScope = null;
      this.scheduleAutomaticCheck();
    });
    return this.checkPromise;
  }

  private async runCheck(scope: CheckScope): Promise<UpdateSnapshot> {
    const results: UpdateResultSnapshot[] = [];
    const preservedApplicationResults = scope.application
      ? []
      : this.value.results.filter((result) => result.kind === "application");
    let extensionSourceFailed = false;
    let extensionSourceChecked = false;
    let appSourceFailed = false;

    this.set({
      status: "checking",
      message: scope.automatic
        ? "Checking for updates in the background…"
        : "Checking Chromecraft, its engine and installed extensions…",
      canCheck: false,
      canRestart: false,
      results: [],
      progress: progressSnapshot("Starting update check"),
    });

    if (scope.extensionIds !== false && this.options.extensions) {
      const selectedIds = scope.extensionIds || null;
      this.markExtensionsChecking(selectedIds);
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
          }, selectedIds ?? undefined);
        extensionSourceChecked = true;
        const checkedAt = this.now();
        const snapshots = extensionResults.map(extensionResultSnapshot);
        results.push(...snapshots);
        this.applyExtensionResults(extensionResults, checkedAt);
      } catch (error) {
        extensionSourceFailed = true;
        console.warn("Chromecraft extension update check failed.", error);
        const checkedAt = this.now();
        results.push(...this.extensionFailureResults(selectedIds));
        this.markExtensionsFailed(selectedIds, checkedAt);
      }
    }

    if (scope.application) {
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
        console.warn("Chromecraft application update check failed.", error);
        results.push({
          id: "chromecraft-release",
          kind: "application",
          label: "Chromecraft application",
          fromVersion: this.currentAppVersion,
          toVersion: null,
          state: "failed",
          requiresRestart: false,
          includes: applicationIncludes("both"),
          detail: genericUpdateError,
          applicationCategory: "both",
        });
      }
    }

    const combinedResults = [...preservedApplicationResults, ...results];
    const hasReadyApplication = combinedResults.some(
      (result) => result.kind === "application" && result.state === "ready",
    );
    const installedCount = results.filter(
      (result) => result.state === "installed",
    ).length;
    const hasLimit =
      extensionSourceFailed ||
      appSourceFailed ||
      combinedResults.some((result) =>
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
            combinedResults.some((result) => result.state === "up-to-date")
            ? "partial"
            : appSourceFailed || extensionSourceFailed
              ? "error"
              : "unavailable"
          : "up-to-date";
    const checkedAt = this.now();
    const applicationResult = combinedResults.find(
      (result) => result.kind === "application" && result.state === "ready",
    );
    const applicationRelease = applicationResult?.toVersion
      ? {
          version: applicationResult.toVersion,
          category: applicationResult.applicationCategory ?? "both",
          releaseNotes: applicationResult.releaseNotes ?? null,
          publishedAt: applicationResult.publishedAt ?? null,
          downloadSizeBytes: applicationResult.downloadSizeBytes ?? null,
        }
      : this.value.applicationRelease;

    this.set({
      status,
      results: combinedResults,
      applicationRelease,
      progress: null,
      checkedAt,
      message: finalMessage(status, installedCount, extensionSourceFailed),
      canCheck: !hasReadyApplication || Boolean(this.options.extensions),
      canRestart: hasReadyApplication,
    });
    this.recordHistory(results, checkedAt);
    if (scope.application && !appSourceFailed) {
      this.lastAutomaticCheckAt = checkedAt;
    }
    await this.persist();
    const newlyReadyApplication = results.find(
      (result) => result.kind === "application" && result.state === "ready",
    );
    if (
      newlyReadyApplication?.toVersion === applicationRelease?.version &&
      applicationRelease &&
      this.value.preferences.notifyWhenReady
    ) {
      this.options.notifyUpdateReady?.(applicationRelease);
    }
    return this.snapshot;
  }

  private markExtensionsChecking(ids: readonly string[] | null): void {
    const selected = ids ? new Set(ids) : null;
    this.set({
      extensions: this.value.extensions.map((item) =>
        !selected || selected.has(item.id)
          ? { ...item, state: "checking", detail: null }
          : item,
      ),
    });
  }

  private extensionFailureResults(
    ids: readonly string[] | null,
  ): UpdateResultSnapshot[] {
    const selected = ids ? new Set(ids) : null;
    return this.value.extensions
      .filter((item) => !selected || selected.has(item.id))
      .map((item) => ({
        id: `extension:${item.id}`,
        kind: "extension" as const,
        label: item.name,
        fromVersion: item.installedVersion,
        toVersion: item.availableVersion,
        state: "failed" as const,
        requiresRestart: false,
        includes: ["Browser extension"],
        detail: "The extension update provider could not be reached.",
      }));
  }

  private markExtensionsFailed(
    ids: readonly string[] | null,
    checkedAt: number,
  ): void {
    const selected = ids ? new Set(ids) : null;
    this.set({
      extensions: this.value.extensions.map((item) =>
        !selected || selected.has(item.id)
          ? {
              ...item,
              state: "failed",
              detail: "The extension update provider could not be reached.",
              lastCheckedAt: checkedAt,
            }
          : item,
      ),
    });
  }

  private applyExtensionResults(
    results: ExtensionUpdateResult[],
    checkedAt: number,
  ): void {
    const byId = new Map(results.map((result) => [result.id, result]));
    this.set({
      extensions: this.value.extensions.map((item) => {
        const result = byId.get(item.id);
        if (!result) return item;
        return {
          ...item,
          installedVersion:
            result.state === "installed" && result.toVersion
              ? result.toVersion
              : item.installedVersion,
          availableVersion:
            result.state === "installed" || result.state === "up-to-date"
              ? null
              : result.toVersion,
          state:
            result.state === "unavailable" ? "manual-required" : result.state,
          detail: result.detail ?? null,
          lastCheckedAt: checkedAt,
        };
      }),
    });
  }

  private recordHistory(
    results: UpdateResultSnapshot[],
    timestamp: number,
  ): void {
    const additions: UpdateHistoryEntry[] = [];
    for (const result of results) {
      if (
        !["installed", "ready", "failed", "approval-required"].includes(
          result.state,
        )
      ) {
        continue;
      }
      const categories: UpdateCategoryId[] =
        result.kind === "extension"
          ? ["extensions"]
          : result.applicationCategory === "chromecraft"
            ? ["chromecraft"]
            : result.applicationCategory === "dependencies"
              ? ["dependencies"]
              : ["chromecraft", "dependencies"];
      for (const category of categories) {
        additions.push({
          id: `${timestamp}:${category}:${result.id}`,
          category,
          label: result.label,
          fromVersion: result.fromVersion,
          toVersion: result.toVersion,
          result: result.state as UpdateHistoryEntry["result"],
          timestamp,
          detail: result.detail,
        });
      }
    }
    if (additions.length > 0) {
      this.set({
        history: [...additions, ...this.value.history].slice(
          0,
          maximumHistoryEntries,
        ),
      });
    }
  }

  private scheduleAutomaticCheck(initial = false): void {
    if (this.automaticTimer) clearTimeout(this.automaticTimer);
    this.automaticTimer = null;
    if (
      this.disposed ||
      !this.options.automaticEligible ||
      !this.value.preferences.automaticChecksEnabled ||
      this.value.status === "ready"
    ) {
      return;
    }
    const interval = this.options.intervalMs ?? defaultAutomaticIntervalMs;
    const sinceLast = this.lastAutomaticCheckAt
      ? this.now() - this.lastAutomaticCheckAt
      : Number.POSITIVE_INFINITY;
    const delay = initial
      ? Math.max(
          this.options.startupDelayMs ?? defaultStartupDelayMs,
          interval - sinceLast,
        )
      : Math.max(1_000, interval - sinceLast);
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = null;
      void this.runScopedCheck({
        application: true,
        extensionIds: this.value.preferences.automaticExtensionUpdatesEnabled
          ? null
          : false,
        automatic: true,
      }).catch((error) => {
        console.warn("Automatic update check failed.", error);
      });
    }, delay);
    this.automaticTimer.unref?.();
  }

  private async persist(): Promise<void> {
    this.durableExtensionStatuses = extensionStatusesFor(
      this.value.extensions,
      this.durableExtensionStatuses,
    );
    await this.options.persist({
      preferences: this.value.preferences,
      history: this.value.history,
      lastAutomaticCheckAt: this.lastAutomaticCheckAt,
      extensionStatuses: this.durableExtensionStatuses,
    });
  }

  private get currentAppVersion(): string {
    return (
      this.value.installedVersions.find((item) => item.id === "chromecraft")
        ?.version ?? "unknown"
    );
  }

  private set(patch: Partial<UpdateSnapshot>): void {
    this.value = { ...this.value, ...patch };
    this.refreshCategories();
    this.options.emit(this.snapshot);
  }

  private refreshCategories(): void {
    this.value.categories = categorySnapshots(this.value);
  }
}

function applicationIncludes(category: ApplicationChangeCategory): string[] {
  const dependencies = [
    "Electron engine",
    "Chromium engine",
    "Node.js runtime",
    "Application and media-tool dependencies",
  ];
  const chromecraft = [
    "Chromecraft browser UI and features",
    "Scout, Hyperdrive and built-in tools",
  ];
  return category === "dependencies"
    ? dependencies
    : category === "chromecraft"
      ? chromecraft
      : [...chromecraft, ...dependencies];
}

function applicationResultSnapshot(
  result: ApplicationUpdateResult,
  currentVersion: string,
): UpdateResultSnapshot {
  const category = result.state === "ready" ? result.release.category : "both";
  return {
    id: "chromecraft-release",
    kind: "application",
    label: "Chromecraft application",
    fromVersion: currentVersion,
    toVersion:
      result.state === "ready" ? cleanVersion(result.release.version) : null,
    state: result.state,
    requiresRestart: result.state === "ready",
    includes: applicationIncludes(category),
    detail: result.state === "unavailable" ? result.detail : null,
    applicationCategory: category,
    releaseNotes:
      result.state === "ready" ? (result.release.releaseNotes ?? null) : null,
    publishedAt:
      result.state === "ready" ? (result.release.publishedAt ?? null) : null,
    downloadSizeBytes:
      result.state === "ready"
        ? (result.release.downloadSizeBytes ?? null)
        : null,
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

function extensionItem(
  extension: InstalledExtensionForUpdates,
): ExtensionUpdateItemSnapshot {
  const unpacked = extension.sourceUrl.startsWith("unpacked:");
  return {
    id: extension.id,
    name: extension.name,
    iconDataUrl: extension.iconDataUrl,
    installedVersion: extension.version,
    availableVersion: null,
    enabled: extension.enabled,
    provider: unpacked ? "unpacked" : "chrome-web-store",
    sourceUrl: unpacked ? null : extension.sourceUrl,
    state: unpacked ? "manual-required" : "unknown",
    detail: unpacked ? "Manual update required for unpacked extensions." : null,
    lastCheckedAt: null,
  };
}

function restoreExtensionItem(
  extension: InstalledExtensionForUpdates,
  persisted: PersistentExtensionUpdateStatus | undefined,
): ExtensionUpdateItemSnapshot {
  const current = extensionItem(extension);
  if (!persisted || persisted.provider !== current.provider) return current;
  if (
    persisted.availableVersion &&
    extensionVersionAtLeast(extension.version, persisted.availableVersion)
  ) {
    return {
      ...current,
      state: "installed",
      lastCheckedAt: persisted.lastCheckedAt,
    };
  }
  if (persisted.installedVersion !== extension.version) return current;
  return {
    ...current,
    availableVersion: persisted.availableVersion,
    state: persisted.state,
    detail: persisted.detail,
    lastCheckedAt: persisted.lastCheckedAt,
  };
}

function extensionStatusesFor(
  extensions: ExtensionUpdateItemSnapshot[],
  previous: PersistentExtensionUpdateStatus[],
): PersistentExtensionUpdateStatus[] {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  return extensions.map((item) => {
    if (item.state === "checking") {
      return (
        previousById.get(item.id) ?? {
          id: item.id,
          installedVersion: item.installedVersion,
          availableVersion: null,
          provider: item.provider,
          state: "unknown",
          detail: null,
          lastCheckedAt: null,
        }
      );
    }
    return {
      id: item.id,
      installedVersion: item.installedVersion,
      availableVersion: item.availableVersion,
      provider: item.provider,
      state: item.state,
      detail: item.detail?.slice(0, 500) ?? null,
      lastCheckedAt: item.lastCheckedAt,
    };
  });
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
        ? `Installed ${installedCount} extension update${installedCount === 1 ? "" : "s"}. An application update is ready to restart.`
        : "A verified Chromecraft update is downloaded and ready to restart.";
    case "complete":
      return `Installed ${installedCount} extension update${installedCount === 1 ? "" : "s"}. Chromecraft is otherwise up to date.`;
    case "partial":
      return installedCount > 0
        ? `Installed ${installedCount} extension update${installedCount === 1 ? "" : "s"}. Some items still need attention.`
        : "The available update sources were checked, but some items need attention.";
    case "up-to-date":
      return "Chromecraft, its browser engine and supported extensions are up to date.";
    case "unavailable":
      return "This build cannot replace the Chromecraft application. Extension updates were still checked.";
    case "error":
      return extensionSourceFailed
        ? "Chromecraft could not finish checking the available update sources."
        : genericUpdateError;
    default:
      return "Update check finished.";
  }
}

function cleanVersion(value: string): string {
  const clean = value.trim().replace(/^v(?=\d)/iu, "");
  return clean.length > 0 && clean.length <= 80 ? clean : "new release";
}

function cloneCheckScope(scope: CheckScope): CheckScope {
  return {
    ...scope,
    extensionIds: Array.isArray(scope.extensionIds)
      ? [...scope.extensionIds]
      : scope.extensionIds,
  };
}

function checkScopesEqual(left: CheckScope, right: CheckScope): boolean {
  const leftExtensionIds = left.extensionIds;
  const rightExtensionIds = right.extensionIds;
  if (
    left.application !== right.application ||
    left.automatic !== right.automatic ||
    !Array.isArray(leftExtensionIds) ||
    !Array.isArray(rightExtensionIds)
  ) {
    return (
      left.application === right.application &&
      left.automatic === right.automatic &&
      leftExtensionIds === rightExtensionIds
    );
  }
  return (
    leftExtensionIds.length === rightExtensionIds.length &&
    leftExtensionIds.every((id, index) => id === rightExtensionIds[index])
  );
}

function extensionVersionAtLeast(
  installed: string,
  available: string,
): boolean {
  const versionPattern = /^\d+(?:\.\d+){0,3}$/u;
  if (!versionPattern.test(installed) || !versionPattern.test(available)) {
    return installed === available;
  }
  const installedParts = installed.split(".").map(BigInt);
  const availableParts = available.split(".").map(BigInt);
  for (let index = 0; index < 4; index += 1) {
    const difference =
      (installedParts[index] ?? 0n) - (availableParts[index] ?? 0n);
    if (difference !== 0n) return difference > 0n;
  }
  return true;
}

function emptyCategories(
  versions: InstalledVersionSnapshot[],
): Record<UpdateCategoryId, UpdateCategorySnapshot> {
  const appVersion =
    versions.find((version) => version.id === "chromecraft")?.version ?? null;
  return {
    extensions: {
      id: "extensions",
      status: "idle",
      installedVersion: "0 installed",
      availableVersion: null,
      updateCount: 0,
      lastCheckedAt: null,
      restartRequired: false,
      detail: null,
    },
    dependencies: {
      id: "dependencies",
      status: "idle",
      installedVersion: appVersion,
      availableVersion: null,
      updateCount: 0,
      lastCheckedAt: null,
      restartRequired: false,
      detail: null,
    },
    chromecraft: {
      id: "chromecraft",
      status: "idle",
      installedVersion: appVersion,
      availableVersion: null,
      updateCount: 0,
      lastCheckedAt: null,
      restartRequired: false,
      detail: null,
    },
  };
}

function categorySnapshots(
  snapshot: UpdateSnapshot,
): Record<UpdateCategoryId, UpdateCategorySnapshot> {
  const base = emptyCategories(snapshot.installedVersions);
  const extensionResults = snapshot.results.filter(
    (result) => result.kind === "extension",
  );
  const extensionAttention = snapshot.extensions.filter((item) =>
    ["approval-required", "failed", "manual-required"].includes(item.state),
  ).length;
  const extensionCheckedAt = Math.max(
    0,
    ...snapshot.extensions.map((item) => item.lastCheckedAt ?? 0),
  );
  base.extensions = {
    ...base.extensions,
    status:
      snapshot.status === "checking" &&
      snapshot.progress?.label.toLowerCase().includes("extension")
        ? "checking"
        : extensionResults.some((result) => result.state === "installed")
          ? extensionAttention > 0
            ? "partial"
            : "complete"
          : extensionAttention > 0
            ? "partial"
            : extensionCheckedAt > 0
              ? "up-to-date"
              : "idle",
    installedVersion: `${snapshot.extensions.length} installed`,
    availableVersion: null,
    updateCount: extensionAttention,
    lastCheckedAt: extensionCheckedAt || null,
    detail:
      extensionAttention > 0
        ? `${extensionAttention} extension${extensionAttention === 1 ? " needs" : "s need"} attention.`
        : null,
  };

  const application = snapshot.results.find(
    (result) => result.kind === "application",
  );
  for (const category of ["dependencies", "chromecraft"] as const) {
    const included =
      application?.applicationCategory === "both" ||
      application?.applicationCategory === category;
    base[category] = {
      ...base[category],
      status: !application
        ? "idle"
        : application.state === "ready" && included
          ? "ready"
          : application.state === "up-to-date" ||
              (application.state === "ready" && !included)
            ? "up-to-date"
            : application.state === "failed"
              ? "error"
              : application.state === "unavailable"
                ? "unavailable"
                : snapshot.status,
      availableVersion:
        application?.state === "ready" && included
          ? application.toVersion
          : null,
      updateCount: application?.state === "ready" && included ? 1 : 0,
      lastCheckedAt: snapshot.checkedAt,
      restartRequired: application?.state === "ready" && included,
      detail: application?.detail ?? null,
    };
  }
  return base;
}
