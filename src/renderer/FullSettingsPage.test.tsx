import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BrowserSnapshot, HyperdriveSnapshot } from "../shared/browser";
import type { UpdateSnapshot } from "../shared/updates";
import {
  AboutSettingsPage,
  CHROMECRAFT_BUILD_NAME,
  FullSettingsPage,
  fullSettingsCategories,
  fullSettingsSearchItems,
  searchFullSettings,
} from "./App";

const snapshot: BrowserSnapshot = {
  tabs: [],
  tabGroups: [],
  selectedTabIds: [],
  activeTabId: "tab-1",
  splitView: { pairs: [], activePairId: null },
  baseChromeHeight: 104,
  chromeHeight: 104,
  webStoreListing: null,
  youtubeWatch: null,
  ublock: {
    enabled: true,
    initializing: false,
    ready: true,
    name: "uBlock Origin",
    version: "1.0.0",
    error: null,
  },
  preferences: {
    onboardingComplete: true,
    restoreSession: true,
    sidebarAttached: true,
    sidebarOpen: false,
    bookmarkBarVisible: true,
    newTabTheme: "overworld",
    searchEngine: "duckduckgo",
    remoteSearchSuggestionsEnabled: false,
    hyperdriveMode: "balanced",
    hyperdriveRamBudgetMb: 512,
    hyperdriveCrossSitePreloadingEnabled: false,
    hyperdriveSearchPreloadingEnabled: false,
    hyperdriveExcludedHosts: [],
    hyperdriveMonitorOpen: false,
    hyperdriveDeveloperMode: false,
    extensionDeveloperMode: false,
    hiddenToolbarActions: [],
    showDownloadProgressInToolbar: true,
    showDownloadCompletionNotification: true,
    addVideosToGallery: true,
  } as BrowserSnapshot["preferences"],
};

const hyperdrive: HyperdriveSnapshot = {
  status: "idle",
  mode: "balanced",
  ramBudgetMb: 512,
  availableMemoryMb: 8_192,
  totalMemoryMb: 16_384,
  paused: false,
  monitorOpen: false,
  warning: null,
  metrics: {
    activePredictions: 0,
    activePreloads: 0,
    preparedDestinations: 0,
    cacheReuseSuccesses: 0,
    successfulPredictions: 0,
    missedPredictions: 0,
    cancelledPreloads: 0,
    wastedPreparations: 0,
    observedSpeculativeBytes: null,
    estimatedSpeculativeMemoryBytes: 0,
    processPrivateMemoryBytes: null,
    navigationTimeSavedMs: null,
    rankingTimeMs: 0,
    predictionsEvaluated: 0,
  },
  destinations: [],
  events: [],
};

const updates: UpdateSnapshot = {
  status: "idle",
  installedVersions: [
    { id: "chromecraft", label: "Chromecraft", version: "1.2.3" },
    { id: "electron", label: "Electron", version: "44.7.2" },
    { id: "chromium", label: "Chromium", version: "142.0.0" },
    { id: "node", label: "Node.js", version: "24.14.0" },
    { id: "yt-dlp", label: "yt-dlp", version: "2026.10.01" },
  ],
  results: [],
  extensions: [],
  categories: {
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
      installedVersion: "1.2.3",
      availableVersion: null,
      updateCount: 0,
      lastCheckedAt: null,
      restartRequired: false,
      detail: null,
    },
    chromecraft: {
      id: "chromecraft",
      status: "idle",
      installedVersion: "1.2.3",
      availableVersion: null,
      updateCount: 0,
      lastCheckedAt: null,
      restartRequired: false,
      detail: null,
    },
  },
  history: [],
  preferences: {
    automaticChecksEnabled: true,
    automaticExtensionUpdatesEnabled: true,
    notifyWhenReady: true,
  },
  applicationRelease: null,
  progress: null,
  checkedAt: null,
  message: null,
  canCheck: true,
  canRestart: false,
};

describe("full settings model", () => {
  it("defines each requested category and assigns every setting to one", () => {
    expect(fullSettingsCategories.map((category) => category.id)).toEqual([
      "general",
      "privacy",
      "appearance",
      "downloads",
      "ai",
      "hyperdrive",
      "extensions",
      "advanced",
    ]);
    expect(
      new Set(fullSettingsCategories.map((category) => category.id)).size,
    ).toBe(fullSettingsCategories.length);
    expect(new Set(fullSettingsSearchItems.map((item) => item.id)).size).toBe(
      fullSettingsSearchItems.length,
    );
    expect(
      fullSettingsSearchItems.every((item) =>
        fullSettingsCategories.some(
          (category) => category.id === item.category,
        ),
      ),
    ).toBe(true);
  });

  it("finds settings across categories using labels, descriptions and keywords", () => {
    expect(searchFullSettings("ad blocker").map((item) => item.id)).toContain(
      "ublock-origin",
    );
    expect(searchFullSettings("RAM reserve").map((item) => item.id)).toEqual([
      "hyperdrive-ram",
    ]);
    expect(
      searchFullSettings("developer monitor").map((item) => item.id),
    ).toContain("hyperdrive-monitor");
    expect(
      searchFullSettings("  New TAB theme ").map((item) => item.id),
    ).toEqual(["new-tab-theme"]);
    expect(searchFullSettings("not-a-real-setting")).toEqual([]);
  });

  it("renders a category navigation and only the selected category content", () => {
    const markup = renderToStaticMarkup(
      <FullSettingsPage
        snapshot={snapshot}
        hyperdrive={hyperdrive}
        updates={updates}
        openExtensionsPage={vi.fn()}
        openUpdatesPage={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Search settings"');
    expect(markup).toContain('aria-label="Settings categories"');
    expect(markup.match(/data-settings-category=/g)).toHaveLength(8);
    expect(markup).toContain('data-settings-detail="general"');
    expect(markup).toContain("Restore tabs on launch");
    expect(markup).toContain("Show bookmarks bar");
    expect(markup).toContain("Show browser sidebar");
    expect(markup).toContain("About Chromecraft");
    expect(markup).not.toContain("Live search suggestions");
    expect(markup).not.toContain("Maximum RAM to reserve");
    expect(markup).not.toContain("Extension developer mode");
  });

  it("renders an About page from authoritative version metadata", () => {
    const markup = renderToStaticMarkup(
      <AboutSettingsPage
        snapshot={updates}
        back={vi.fn()}
        openUpdates={vi.fn()}
      />,
    );

    expect(markup).toContain("Version");
    expect(markup).toContain("1.2.3");
    expect(markup).toContain("Build");
    expect(markup).toContain(CHROMECRAFT_BUILD_NAME);
    expect(markup).toContain("Chromium");
    expect(markup).toContain("Electron");
    expect(markup).toContain("Update Chromecraft");
    expect(markup).toContain('aria-label="Back to General settings"');
    expect(markup).toContain('class="chromecraft-logo"');
    expect(markup).toContain("chromecraft-logo.png");
  });
});
