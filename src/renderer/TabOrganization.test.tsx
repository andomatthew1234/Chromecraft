import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type {
  BrowserDataSnapshot,
  BrowserSnapshot,
  BrowserTabSnapshot,
} from "../shared/browser";
import {
  getSelectedTabIds,
  getTabGroups,
  performTabGroupDrop,
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

describe("tab organisation renderer", () => {
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
        onHoverCardOpenChange={vi.fn()}
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
        brandMenuOpen={false}
        onToggleBrandMenu={vi.fn()}
        onSetSidebarAttached={vi.fn()}
        onOpenUpdates={vi.fn()}
        onHoverCardOpenChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Research");
    expect(markup).toContain("2 selected");
    expect(markup).toContain('aria-label="Search tabs"');
    expect(markup).toContain("group-purple");
    expect(markup).toContain('aria-label="Move selected tabs left"');
    expect(markup).toContain('aria-label="Pin selected tabs"');
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
