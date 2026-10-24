import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  HyperdriveMode,
  NewTabTheme,
  SearchEngine,
  ToolbarAction,
} from "../shared/browser";

export interface BrowserPreferences {
  ublockEnabled: boolean;
  restoreSession: boolean;
  sidebarAttached: boolean;
  sidebarOpen: boolean;
  bookmarkBarVisible: boolean;
  newTabTheme: NewTabTheme;
  searchEngine: SearchEngine;
  remoteSearchSuggestionsEnabled: boolean;
  hyperdriveMode: HyperdriveMode;
  hyperdriveRamBudgetMb: number;
  hyperdriveCrossSitePreloadingEnabled: boolean;
  hyperdriveSearchPreloadingEnabled: boolean;
  hyperdriveExcludedHosts: string[];
  hyperdriveMonitorOpen: boolean;
  hyperdriveDeveloperMode: boolean;
  extensionDeveloperMode: boolean;
  hiddenToolbarExtensionIds: string[];
  hiddenToolbarActions: ToolbarAction[];
  showDownloadProgressInToolbar: boolean;
  showDownloadCompletionNotification: boolean;
  addVideosToGallery: boolean;
  smartReaderProgressVisible: boolean;
}

const defaults: BrowserPreferences = {
  ublockEnabled: true,
  restoreSession: true,
  sidebarAttached: true,
  sidebarOpen: true,
  bookmarkBarVisible: false,
  newTabTheme: "overworld",
  searchEngine: "duckduckgo",
  remoteSearchSuggestionsEnabled: false,
  hyperdriveMode: "off",
  hyperdriveRamBudgetMb: 256,
  hyperdriveCrossSitePreloadingEnabled: false,
  hyperdriveSearchPreloadingEnabled: false,
  hyperdriveExcludedHosts: [],
  hyperdriveMonitorOpen: false,
  hyperdriveDeveloperMode: false,
  extensionDeveloperMode: false,
  hiddenToolbarExtensionIds: [],
  hiddenToolbarActions: [],
  showDownloadProgressInToolbar: true,
  showDownloadCompletionNotification: true,
  addVideosToGallery: true,
  smartReaderProgressVisible: false,
};

const themes = new Set<NewTabTheme>(["overworld", "nether", "end", "minimal"]);
const hyperdriveModes = new Set<HyperdriveMode>([
  "off",
  "balanced",
  "aggressive",
  "maximum",
]);
const toolbarActions = new Set<ToolbarAction>([
  "bookmark",
  "find",
  "hyperdrive",
  "ublock",
]);
const extensionIdPattern = /^[a-p]{32}$/;

function cleanHiddenToolbarExtensionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (id): id is string =>
          typeof id === "string" && extensionIdPattern.test(id),
      ),
    ),
  ].slice(0, 200);
}

function cleanHiddenToolbarActions(value: unknown): ToolbarAction[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (action): action is ToolbarAction =>
          typeof action === "string" &&
          toolbarActions.has(action as ToolbarAction),
      ),
    ),
  ];
}

function cleanExcludedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((host): host is string => typeof host === "string")
        .map((host) =>
          host
            .trim()
            .toLowerCase()
            .replace(/^www\./, ""),
        )
        .filter(
          (host) =>
            host.length > 0 &&
            host.length <= 253 &&
            /^[a-z0-9.-]+$/.test(host) &&
            !host.startsWith(".") &&
            !host.endsWith("."),
        ),
    ),
  ].slice(0, 200);
}

function cleanRamBudget(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 64 &&
    value <= 4096
    ? value
    : defaults.hyperdriveRamBudgetMb;
}

export class PreferencesStore {
  private value: BrowserPreferences = defaults;
  private writeQueue: Promise<void> = Promise.resolve();
  private temporaryFileCounter = 0;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<BrowserPreferences>;
      this.value = {
        ublockEnabled:
          typeof parsed.ublockEnabled === "boolean"
            ? parsed.ublockEnabled
            : defaults.ublockEnabled,
        restoreSession:
          typeof parsed.restoreSession === "boolean"
            ? parsed.restoreSession
            : defaults.restoreSession,
        sidebarAttached:
          typeof parsed.sidebarAttached === "boolean"
            ? parsed.sidebarAttached
            : defaults.sidebarAttached,
        sidebarOpen:
          typeof parsed.sidebarOpen === "boolean"
            ? parsed.sidebarOpen
            : defaults.sidebarOpen,
        bookmarkBarVisible:
          typeof parsed.bookmarkBarVisible === "boolean"
            ? parsed.bookmarkBarVisible
            : defaults.bookmarkBarVisible,
        newTabTheme:
          typeof parsed.newTabTheme === "string" &&
          themes.has(parsed.newTabTheme as NewTabTheme)
            ? (parsed.newTabTheme as NewTabTheme)
            : defaults.newTabTheme,
        searchEngine: "duckduckgo",
        remoteSearchSuggestionsEnabled:
          typeof parsed.remoteSearchSuggestionsEnabled === "boolean"
            ? parsed.remoteSearchSuggestionsEnabled
            : defaults.remoteSearchSuggestionsEnabled,
        hyperdriveMode:
          typeof parsed.hyperdriveMode === "string" &&
          hyperdriveModes.has(parsed.hyperdriveMode as HyperdriveMode)
            ? (parsed.hyperdriveMode as HyperdriveMode)
            : defaults.hyperdriveMode,
        hyperdriveRamBudgetMb: cleanRamBudget(parsed.hyperdriveRamBudgetMb),
        hyperdriveCrossSitePreloadingEnabled:
          typeof parsed.hyperdriveCrossSitePreloadingEnabled === "boolean"
            ? parsed.hyperdriveCrossSitePreloadingEnabled
            : defaults.hyperdriveCrossSitePreloadingEnabled,
        hyperdriveSearchPreloadingEnabled:
          typeof parsed.hyperdriveSearchPreloadingEnabled === "boolean"
            ? parsed.hyperdriveSearchPreloadingEnabled
            : defaults.hyperdriveSearchPreloadingEnabled,
        hyperdriveExcludedHosts: cleanExcludedHosts(
          parsed.hyperdriveExcludedHosts,
        ),
        hyperdriveMonitorOpen:
          typeof parsed.hyperdriveMonitorOpen === "boolean"
            ? parsed.hyperdriveMonitorOpen
            : defaults.hyperdriveMonitorOpen,
        hyperdriveDeveloperMode:
          typeof parsed.hyperdriveDeveloperMode === "boolean"
            ? parsed.hyperdriveDeveloperMode
            : defaults.hyperdriveDeveloperMode,
        extensionDeveloperMode:
          typeof parsed.extensionDeveloperMode === "boolean"
            ? parsed.extensionDeveloperMode
            : defaults.extensionDeveloperMode,
        hiddenToolbarExtensionIds: cleanHiddenToolbarExtensionIds(
          parsed.hiddenToolbarExtensionIds,
        ),
        hiddenToolbarActions: cleanHiddenToolbarActions(
          parsed.hiddenToolbarActions,
        ),
        showDownloadProgressInToolbar:
          typeof parsed.showDownloadProgressInToolbar === "boolean"
            ? parsed.showDownloadProgressInToolbar
            : defaults.showDownloadProgressInToolbar,
        showDownloadCompletionNotification:
          typeof parsed.showDownloadCompletionNotification === "boolean"
            ? parsed.showDownloadCompletionNotification
            : defaults.showDownloadCompletionNotification,
        addVideosToGallery:
          typeof parsed.addVideosToGallery === "boolean"
            ? parsed.addVideosToGallery
            : defaults.addVideosToGallery,
        smartReaderProgressVisible:
          typeof parsed.smartReaderProgressVisible === "boolean"
            ? parsed.smartReaderProgressVisible
            : defaults.smartReaderProgressVisible,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "Could not read browser preferences; defaults will be used.",
          error,
        );
      }
      this.value = { ...defaults };
    }
  }

  get snapshot(): Readonly<BrowserPreferences> {
    return this.value;
  }

  async setUblockEnabled(enabled: boolean): Promise<void> {
    await this.update({ ublockEnabled: enabled });
  }

  async setRestoreSession(enabled: boolean): Promise<void> {
    await this.update({ restoreSession: enabled });
  }

  async setSidebarOpen(open: boolean): Promise<void> {
    await this.update({ sidebarOpen: open });
  }

  async setSidebarAttached(attached: boolean): Promise<void> {
    await this.update({ sidebarAttached: attached });
  }

  async setBookmarkBarVisible(visible: boolean): Promise<void> {
    await this.update({ bookmarkBarVisible: visible });
  }

  async setNewTabTheme(theme: NewTabTheme): Promise<void> {
    if (!themes.has(theme)) {
      throw new Error("Unsupported new-tab theme.");
    }
    await this.update({ newTabTheme: theme });
  }

  async setRemoteSearchSuggestionsEnabled(enabled: boolean): Promise<void> {
    await this.update({ remoteSearchSuggestionsEnabled: enabled });
  }

  async setHyperdriveMode(mode: HyperdriveMode): Promise<void> {
    if (!hyperdriveModes.has(mode)) throw new Error("Unsupported mode.");
    await this.update({ hyperdriveMode: mode });
  }

  async setHyperdriveRamBudgetMb(megabytes: number): Promise<void> {
    if (!Number.isInteger(megabytes) || megabytes < 64 || megabytes > 4096)
      throw new RangeError("Hyperdrive RAM budget must be 64-4096 MB.");
    await this.update({ hyperdriveRamBudgetMb: megabytes });
  }

  async setHyperdriveCrossSitePreloadingEnabled(
    enabled: boolean,
  ): Promise<void> {
    await this.update({ hyperdriveCrossSitePreloadingEnabled: enabled });
  }

  async setHyperdriveSearchPreloadingEnabled(enabled: boolean): Promise<void> {
    await this.update({ hyperdriveSearchPreloadingEnabled: enabled });
  }

  async setHyperdriveExcludedHosts(hosts: string[]): Promise<void> {
    await this.update({ hyperdriveExcludedHosts: cleanExcludedHosts(hosts) });
  }

  async setHyperdriveMonitorOpen(open: boolean): Promise<void> {
    await this.update({ hyperdriveMonitorOpen: open });
  }

  async setHyperdriveDeveloperMode(enabled: boolean): Promise<void> {
    await this.update({ hyperdriveDeveloperMode: enabled });
  }

  async setExtensionDeveloperMode(enabled: boolean): Promise<void> {
    await this.update({ extensionDeveloperMode: enabled });
  }

  async setExtensionToolbarPinned(
    extensionId: string,
    pinned: boolean,
  ): Promise<void> {
    if (!extensionIdPattern.test(extensionId)) {
      throw new Error("Unsupported extension identifier.");
    }
    const hidden = new Set(this.value.hiddenToolbarExtensionIds);
    if (pinned) hidden.delete(extensionId);
    else hidden.add(extensionId);
    await this.update({ hiddenToolbarExtensionIds: [...hidden] });
  }

  async setToolbarActionPinned(
    action: ToolbarAction,
    pinned: boolean,
  ): Promise<void> {
    if (!toolbarActions.has(action)) {
      throw new Error("Unsupported toolbar action.");
    }
    const hidden = new Set(this.value.hiddenToolbarActions);
    if (pinned) hidden.delete(action);
    else hidden.add(action);
    await this.update({ hiddenToolbarActions: [...hidden] });
  }

  async setShowDownloadProgressInToolbar(enabled: boolean): Promise<void> {
    await this.update({ showDownloadProgressInToolbar: enabled });
  }

  async setShowDownloadCompletionNotification(enabled: boolean): Promise<void> {
    await this.update({ showDownloadCompletionNotification: enabled });
  }

  async setAddVideosToGallery(enabled: boolean): Promise<void> {
    await this.update({ addVideosToGallery: enabled });
  }

  async setSmartReaderProgressVisible(visible: boolean): Promise<void> {
    await this.update({ smartReaderProgressVisible: visible });
  }

  private async update(patch: Partial<BrowserPreferences>): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const previous = this.value;
      this.value = { ...this.value, ...patch };
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${++this.temporaryFileCounter}.tmp`;
      try {
        await fs.writeFile(
          temporaryPath,
          `${JSON.stringify(this.value, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        await fs.rename(temporaryPath, this.filePath);
      } catch (error) {
        this.value = previous;
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }
}
