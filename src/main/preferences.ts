import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  HyperdriveMode,
  NewTabTheme,
  SearchEngine,
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
  extensionDeveloperMode: boolean;
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
  extensionDeveloperMode: false,
};

const themes = new Set<NewTabTheme>(["overworld", "nether", "end", "minimal"]);
const hyperdriveModes = new Set<HyperdriveMode>([
  "off",
  "balanced",
  "aggressive",
  "maximum",
]);

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
        extensionDeveloperMode:
          typeof parsed.extensionDeveloperMode === "boolean"
            ? parsed.extensionDeveloperMode
            : defaults.extensionDeveloperMode,
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

  async setExtensionDeveloperMode(enabled: boolean): Promise<void> {
    await this.update({ extensionDeveloperMode: enabled });
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
