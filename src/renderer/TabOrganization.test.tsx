import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type {
  BrowserDataSnapshot,
  BrowserSnapshot,
  BrowserTabSnapshot,
} from "../shared/browser";
import type { AiToolsSnapshot } from "../shared/ai-tools";
import {
  getSelectedTabIds,
  getTabGroups,
  groupBoundaryDropIndex,
  isSplitViewEligibleTab,
  performTabGroupDrop,
  tabDropIndex,
  TabOverview,
  TabStrip,
} from "./App";

const groupColourClasses = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;

function resolvedGroupColour(
  stylesheet: string,
  colour: string,
): string | null {
  const elementClasses = new Set(["tab-group-color", `group-${colour}`]);
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let winner: { specificity: number; order: number; value: string } | null =
    null;
  let order = 0;

  for (const match of stylesheet.matchAll(rulePattern)) {
    for (const selector of match[1].split(",")) {
      const classNames = [...selector.matchAll(/\.([\w-]+)/g)].map(
        (classMatch) => classMatch[1],
      );
      const isSimpleClassSelector =
        classNames.length > 0 &&
        !/[#:[\]>+~]/.test(selector) &&
        classNames.every((className) => elementClasses.has(className));
      if (!isSimpleClassSelector) continue;

      const declaration = match[2].match(
        /--tab-group-color\s*:\s*([^;]+)\s*;?/,
      );
      if (!declaration) continue;

      const candidate = {
        specificity: classNames.length,
        order,
        value: declaration[1].trim(),
      };
      if (
        !winner ||
        candidate.specificity > winner.specificity ||
        (candidate.specificity === winner.specificity &&
          candidate.order > winner.order)
      ) {
        winner = candidate;
      }
    }
    order += 1;
  }

  return winner?.value ?? null;
}

function tab(
  id: string,
  title: string,
  url: string,
  overrides: Partial<BrowserTabSnapshot> = {},
): BrowserTabSnapshot {
  return {
    id,
    title,
    url,
    faviconDataUrl: null,
    isNewTab: false,
    isLoading: false,
    canGoBack: true,
    canGoForward: false,
    crashed: false,
    error: null,
    isMuted: false,
    pinned: false,
    zoomFactor: 1,
    groupId: null,
    isSelected: false,
    isAudible: false,
    memoryBytes: null,
    thumbnailDataUrl: null,
    reader: { availability: "unavailable", active: false, revision: 0 },
    ...overrides,
  };
}

function snapshot(): BrowserSnapshot {
  return {
    tabs: [
      tab("docs", "Material Design", "https://m3.material.io/", {
        groupId: "research",
        isSelected: true,
        isAudible: true,
        memoryBytes: 128 * 1024 ** 2,
      }),
      tab("repo", "Chromecraft", "https://github.com/example/chromecraft", {
        groupId: "research",
        isSelected: true,
      }),
    ],
    tabGroups: [
      {
        id: "research",
        name: "Research",
        color: "purple",
        collapsed: false,
        saved: true,
        createdAt: 1,
      },
    ],
    selectedTabIds: ["docs", "repo"],
    activeTabId: "docs",
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
      version: "1",
      error: null,
    },
    preferences: {
      sidebarAttached: true,
    } as BrowserSnapshot["preferences"],
  };
}

const data: BrowserDataSnapshot = {
  bookmarks: [],
  history: [],
  quickLinks: [],
  recentlyClosed: [
    {
      id: "closed-1",
      title: "Release notes",
      url: "https://example.com/releases",
      closedAt: Date.now() - 60_000,
      pinned: false,
      groupId: null,
      groupName: null,
      groupColor: null,
    },
  ],
  savedTabGroups: [
    {
      id: "research",
      name: "Research",
      color: "purple",
      createdAt: 1,
      updatedAt: 2,
      tabs: [
        { title: "Material Design", url: "https://m3.material.io/" },
        { title: "Chromecraft", url: "https://github.com/example/chromecraft" },
      ],
    },
  ],
  recentlyClosedWindows: [
    {
      id: "window-1",
      tabs: [
        {
          id: "old-tab",
          title: "Example",
          url: "https://example.com/",
          isNewTab: false,
          pinned: false,
          groupId: null,
        },
      ],
      tabGroups: [],
      activeTabId: "old-tab",
      closedAt: Date.now() - 120_000,
    },
  ],
};

const aiTools: AiToolsSnapshot = {
  provider: "ollama",
  organiserProvider: "ollama",
  organiserModels: { ollama: null, gemini: null },
  preferredGroupingMode: "smart",
  eligibleTabCount: 0,
  cloudDataPreview: [],
  ollama: {
    endpoint: "http://127.0.0.1:11434",
    connection: "unknown",
    models: [],
    selectedModel: null,
    error: null,
  },
  gemini: {
    connection: "unknown",
    models: [],
    selectedModel: null,
    error: null,
    apiKeyConfigured: false,
    secureStorageAvailable: false,
    sessionOnly: false,
    cloudConsentGranted: false,
  },
  endpoint: "http://127.0.0.1:11434",
  connection: "unknown",
  models: [],
  selectedModel: null,
  error: null,
  run: {
    operationId: null,
    toolId: null,
    stage: "idle",
    label: "Ready",
    error: null,
    proposalId: null,
    undoAvailable: false,
  },
};

function renderTabStrip(current: BrowserSnapshot): string {
  return renderToStaticMarkup(
    <TabStrip
      snapshot={current}
      data={data}
      settingsTabId={null}
      onMenu={vi.fn()}
      brandMenuOpen={false}
      onToggleBrandMenu={vi.fn()}
      onSetSidebarAttached={vi.fn()}
      onOpenUpdates={vi.fn()}
      onOpenPerformanceCentre={vi.fn()}
      onOpenToolbarManager={vi.fn()}
      aiTools={aiTools}
      onOpenOrganiseTabs={vi.fn()}
      onHoverCardOpenChange={vi.fn()}
      onSplitDragChange={vi.fn()}
    />,
  );
}

describe("tab organisation renderer", () => {
  it("only offers native website tabs to Split View", () => {
    expect(
      isSplitViewEligibleTab(tab("web", "Example", "https://example.com/")),
    ).toBe(true);
    expect(
      isSplitViewEligibleTab(
        tab("extension", "Extension", "chrome-extension://abc/page.html"),
      ),
    ).toBe(true);
    expect(
      isSplitViewEligibleTab(
        tab("gallery", "Gallery", "chromecraft://gallery/"),
      ),
    ).toBe(false);
    expect(
      isSplitViewEligibleTab(tab("new", "New Tab", "", { isNewTab: true })),
    ).toBe(false);
  });

  it("marks both paired tabs without applying active geometry to both", () => {
    const current = snapshot();
    current.splitView = {
      activePairId: "pair-1",
      pairs: [
        {
          id: "pair-1",
          leftTabId: "docs",
          rightTabId: "repo",
          focusedTabId: "docs",
          ratio: 0.5,
        },
      ],
    };
    const markup = renderTabStrip(current);
    expect(markup.match(/split-linked/g)).toHaveLength(2);
    expect(markup.match(/tab-split-marker/g)).toHaveLength(2);
    expect(markup.match(/tab active/g)).toHaveLength(1);
  });

  it.each(["docs", "repo", "loose"])(
    "renders only %s as active while several group members are selected for actions",
    (activeTabId) => {
      const current = snapshot();
      current.tabs.push(tab("loose", "Loose tab", "https://example.com/"));
      current.activeTabId = activeTabId;

      const markup = renderTabStrip(current);
      const tabRoots = [
        ...markup.matchAll(/<div class="([^"]*)" data-tab-id="([^"]*)"[^>]*>/g),
      ];
      const activeRoots = tabRoots.filter((match) =>
        match[1].split(/\s+/).includes("active"),
      );
      const selectedRoots = tabRoots.filter((match) =>
        match[1].split(/\s+/).includes("selected"),
      );

      expect(tabRoots).toHaveLength(3);
      expect(activeRoots.map((match) => match[2])).toEqual([activeTabId]);
      expect(selectedRoots.map((match) => match[2])).toEqual(["docs", "repo"]);
      expect(markup.match(/role="tab" aria-selected="true"/g)).toHaveLength(1);
      expect(markup.match(/role="tab" aria-selected="false"/g)).toHaveLength(2);
      for (const root of selectedRoots.filter(
        (match) => match[2] !== activeTabId,
      )) {
        expect(root[1].split(/\s+/)).not.toContain("active");
      }
    },
  );

  it("keeps collapsed group members inert without concealing the active ungrouped tab", () => {
    const current = snapshot();
    current.tabs.push(tab("loose", "Loose tab", "https://example.com/"));
    current.activeTabId = "loose";
    current.tabGroups[0].collapsed = true;

    const markup = renderTabStrip(current);
    const renderedTabs = [
      ...markup.matchAll(
        /<div class="([^"]*)" data-tab-id="([^"]*)"([^>]*)>([\s\S]*?)<\/div>/g,
      ),
    ];

    expect(renderedTabs).toHaveLength(3);
    for (const rendered of renderedTabs) {
      const concealed = rendered[2] !== "loose";
      expect(rendered[1].split(/\s+/).includes("concealed")).toBe(concealed);
      if (concealed) {
        expect(rendered[3]).toContain('draggable="false"');
        expect(rendered[3]).toContain('aria-hidden="true"');
        expect(rendered[3]).toContain('inert=""');
        expect(rendered[4].match(/tabindex="-1"/g)).toHaveLength(2);
        expect(rendered[4]).toContain('aria-selected="false"');
      } else {
        expect(rendered[1].split(/\s+/)).toContain("active");
        expect(rendered[3]).not.toContain("inert=");
        expect(rendered[4]).toContain('aria-selected="true"');
      }
    }
  });

  it("calculates stable exact insertion slots while moving tabs", () => {
    const tabs = [
      tab("a", "A", "https://a.example/"),
      tab("b", "B", "https://b.example/"),
      tab("c", "C", "https://c.example/"),
      tab("d", "D", "https://d.example/"),
    ];

    expect(tabDropIndex(tabs, ["b"], "d", "before")).toBe(2);
    expect(tabDropIndex(tabs, ["b"], "d", "after")).toBe(3);
    expect(tabDropIndex(tabs, ["b", "c"], "a", "after")).toBe(1);
    expect(tabDropIndex(tabs, ["a"], "a", "before")).toBe(0);
  });

  it("keeps whole-group drops outside the target group boundary", () => {
    const tabs = [
      tab("a1", "A1", "https://a.example/1", { groupId: "a" }),
      tab("a2", "A2", "https://a.example/2", { groupId: "a" }),
      tab("b1", "B1", "https://b.example/1", { groupId: "b" }),
      tab("b2", "B2", "https://b.example/2", { groupId: "b" }),
    ];

    expect(groupBoundaryDropIndex(tabs, ["a1", "a2"], "b", "before")).toBe(0);
    expect(groupBoundaryDropIndex(tabs, ["a1", "a2"], "b", "after")).toBe(2);
  });

  it("renders discovered website favicons and Material icons for internal pages", () => {
    const current = snapshot();
    current.tabs = [
      tab("web", "Example", "https://example.com/", {
        faviconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      }),
      tab("gallery", "Gallery", "chromecraft://gallery/"),
      tab("offline", "Offline Pages", "chromecraft://offline-pages/"),
    ];

    const markup = renderToStaticMarkup(
      <TabStrip
        snapshot={current}
        data={data}
        settingsTabId={null}
        onMenu={vi.fn()}
        brandMenuOpen={false}
        onToggleBrandMenu={vi.fn()}
        onSetSidebarAttached={vi.fn()}
        onOpenUpdates={vi.fn()}
        onOpenPerformanceCentre={vi.fn()}
        onOpenToolbarManager={vi.fn()}
        aiTools={aiTools}
        onOpenOrganiseTabs={vi.fn()}
        onHoverCardOpenChange={vi.fn()}
        onSplitDragChange={vi.fn()}
      />,
    );

    expect(markup).toContain('class="tab-favicon-image"');
    expect(markup).toContain("video_library");
    expect(markup).toContain("offline_pin");
  });

  it("moves an ungrouped tab into a group when it is dropped on the group", async () => {
    const current = snapshot();
    current.tabs.push(tab("loose", "Loose tab", "https://example.com/loose"));
    const moveTabs = vi.fn().mockResolvedValue(undefined);

    await performTabGroupDrop({
      draggedTabIds: ["loose"],
      groupId: "research",
      tabs: current.tabs,
      moveTabs,
    });

    expect(moveTabs).toHaveBeenCalledOnce();
    expect(moveTabs).toHaveBeenCalledWith(["loose"], 2, "research");

    const markup = renderToStaticMarkup(
      <TabStrip
        snapshot={current}
        data={data}
        settingsTabId={null}
        onMenu={vi.fn()}
        brandMenuOpen={false}
        onToggleBrandMenu={vi.fn()}
        onSetSidebarAttached={vi.fn()}
        onOpenUpdates={vi.fn()}
        onOpenPerformanceCentre={vi.fn()}
        onOpenToolbarManager={vi.fn()}
        aiTools={aiTools}
        onOpenOrganiseTabs={vi.fn()}
        onHoverCardOpenChange={vi.fn()}
        onSplitDragChange={vi.fn()}
      />,
    );
    expect(markup).toContain('draggable="true"');
    expect(markup).toContain('data-drop-label="Drop tabs into Research"');
  });

  it("renders every group colour choice with a distinct palette colour", () => {
    const stylesheet = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    const resolvedColours = groupColourClasses.map((colour) =>
      resolvedGroupColour(stylesheet, colour),
    );

    expect(new Set(resolvedColours).size).toBe(groupColourClasses.length);
    expect(resolvedColours).not.toContain("var(--md-outline)");
  });

  it("renders integrated groups, selection actions and tab-search affordance", () => {
    const markup = renderToStaticMarkup(
      <TabStrip
        snapshot={snapshot()}
        data={data}
        settingsTabId={null}
        onMenu={vi.fn()}
        brandMenuOpen={true}
        onToggleBrandMenu={vi.fn()}
        onSetSidebarAttached={vi.fn()}
        onOpenUpdates={vi.fn()}
        onOpenPerformanceCentre={vi.fn()}
        onOpenToolbarManager={vi.fn()}
        aiTools={aiTools}
        onOpenOrganiseTabs={vi.fn()}
        onHoverCardOpenChange={vi.fn()}
        onSplitDragChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Research");
    expect(markup).toContain("2 selected");
    expect(markup).toContain('aria-label="Search tabs"');
    expect(markup).toContain("group-purple");
    expect(markup).toContain('aria-label="Move selected tabs left"');
    expect(markup).toContain('aria-label="Pin selected tabs"');
    expect(markup).toContain("AI tools");
    expect(markup).toContain("Organise tabs");
    expect(markup).toContain("Manage toolbar");
    expect(markup.indexOf('class="window-drag-region"')).toBeLessThan(
      markup.indexOf('aria-label="Search tabs"'),
    );

    const stylesheet = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    expect(stylesheet).toMatch(
      /\.tab\.active\s*\{[\s\S]*?border-radius:\s*12px 12px 0 0;/,
    );
    expect(stylesheet).toMatch(
      /\.brand\.menu-open\s*\{[\s\S]*?border-radius:\s*var\(--shape-md\);[\s\S]*?box-shadow:\s*inset/,
    );
    expect(stylesheet).toMatch(
      /\.brand\s*\{[\s\S]*?position:\s*relative;[\s\S]*?top:\s*-4px;[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;/,
    );
    expect(stylesheet).toMatch(
      /\.extensions-menu-pin\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;[\s\S]*?justify-self:\s*end;/,
    );
    expect(stylesheet).toMatch(
      /\.extensions-menu-pin\.pinned\s*\{[\s\S]*?background:\s*var\(--md-primary-container\);[\s\S]*?box-shadow:/,
    );
    expect(stylesheet).toMatch(
      /\.toolbar-context-menu\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*50;/,
    );
    expect(stylesheet).toMatch(
      /\.quick-settings-grid:has\(\.quick-theme-select-wrap \.material-select\.open\)\s*\{[\s\S]*?overflow:\s*visible;/,
    );
  });

  it("shows open tabs, saved groups, recently closed tabs and closed windows", () => {
    const markup = renderToStaticMarkup(
      <TabOverview snapshot={snapshot()} data={data} close={vi.fn()} />,
    );

    expect(markup).toContain("Open tabs");
    expect(markup).toContain("Saved groups");
    expect(markup).toContain("Recently closed");
    expect(markup).toContain("Closed windows");
    expect(markup).toContain("128 MB");
    expect(markup).toContain("volume_up");
    expect(markup).toContain("Release notes");
  });

  it("degrades safely when older snapshots omit organisation fields", () => {
    const legacy = {
      ...snapshot(),
      tabGroups: undefined,
      selectedTabIds: undefined,
      tabs: [
        {
          ...tab("legacy", "Legacy", "https://example.com/"),
          isSelected: true,
        },
      ],
    } as unknown as BrowserSnapshot;

    expect(getTabGroups(legacy)).toEqual([]);
    expect(getSelectedTabIds(legacy)).toEqual(["legacy"]);
  });
});
