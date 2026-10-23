import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BrowserSnapshot } from "../shared/browser";
import { QuickSettingsPanel } from "./App";

const snapshot: BrowserSnapshot = {
  tabs: [],
  tabGroups: [],
  selectedTabIds: [],
  activeTabId: "tab-1",
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
    showDownloadProgressInToolbar: true,
    showDownloadCompletionNotification: true,
    addVideosToGallery: true,
  } as BrowserSnapshot["preferences"],
};

describe("QuickSettingsPanel", () => {
  it("renders the compact control-centre settings and no advanced controls", () => {
    const markup = renderToStaticMarkup(
      <QuickSettingsPanel snapshot={snapshot} openFullSettings={vi.fn()} />,
    );

    expect(markup).toContain("Common browser controls");
    expect(markup).toContain('class="quick-settings-sidebar"');
    expect(markup).toContain('aria-label="Hyperdrive"');
    expect(markup).toContain('aria-label="Show bookmarks bar"');
    expect(markup).toContain('aria-label="uBlock Origin"');
    expect(markup).toContain('aria-label="Theme"');
    expect(markup).toContain("Open full settings");
    expect(markup).toContain("Blocking enabled");
    expect(markup).not.toContain("Restore tabs on launch");
    expect(markup).not.toContain("Live search suggestions");
    expect(markup).not.toContain("Maximum RAM to reserve");
  });

  it("renders as sidebar content instead of a floating dialog", () => {
    const markup = renderToStaticMarkup(
      <QuickSettingsPanel snapshot={snapshot} openFullSettings={vi.fn()} />,
    );

    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("quick-settings-layer");
    expect(markup).not.toContain("Close quick settings");
  });
});
