import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  BrowserSnapshot,
  BrowserTabSnapshot,
  TabGroupSnapshot,
} from "../shared/browser";
import {
  CommandCentre,
  commandCentreSafeUrl,
  rankCommandCentreTabs,
} from "./CommandCentre";

function tab(
  id: string,
  title: string,
  url: string,
  groupId: string | null = null,
): BrowserTabSnapshot {
  return {
    id,
    title,
    url,
    groupId,
    faviconDataUrl: id === "docs" ? "data:image/png;base64,ZmF2aWNvbg==" : null,
    isNewTab: false,
  } as BrowserTabSnapshot;
}

const groups: TabGroupSnapshot[] = [
  {
    id: "work",
    name: "Research",
    color: "purple",
    collapsed: false,
    saved: false,
    createdAt: 1,
  },
];

const snapshot = {
  tabs: [
    tab(
      "docs",
      "Chromecraft documentation",
      "https://docs.example.com/guide?token=private#section",
      "work",
    ),
    tab("music", "Music", "https://music.example.com/playing"),
  ],
  tabGroups: groups,
  activeTabId: "docs",
} as BrowserSnapshot;

describe("CommandCentre", () => {
  it("removes query parameters and fragments from displayed tab URLs", () => {
    expect(
      commandCentreSafeUrl(
        "https://example.com/account/profile?token=secret#private",
      ),
    ).toBe("example.com/account/profile");
  });

  it("ranks fuzzy title, hostname and group matches without destabilising ties", () => {
    expect(
      rankCommandCentreTabs(snapshot.tabs, groups, "doc").map(
        (item) => item.tab.id,
      ),
    ).toEqual(["docs"]);
    expect(
      rankCommandCentreTabs(snapshot.tabs, groups, "research").map(
        (item) => item.tab.id,
      ),
    ).toEqual(["docs"]);
    expect(
      rankCommandCentreTabs(snapshot.tabs, groups, "example").map(
        (item) => item.tab.id,
      ),
    ).toEqual(["docs", "music"]);
  });

  it("keeps a 100+ tab inventory stable without duplicating input surfaces", () => {
    const manyTabs = Array.from({ length: 101 }, (_, index) =>
      tab(
        `tab-${index}`,
        `Workspace ${index}`,
        `https://example.com/articles/${index}`,
      ),
    );
    const manySnapshot = {
      ...snapshot,
      tabs: manyTabs,
      activeTabId: manyTabs[0].id,
    } as BrowserSnapshot;
    const markup = renderToStaticMarkup(
      <CommandCentre
        snapshot={manySnapshot}
        close={vi.fn()}
        askScout={vi.fn()}
        searchWeb={vi.fn()}
        activateTab={vi.fn()}
      />,
    );

    expect(rankCommandCentreTabs(manyTabs, [], "workspace")).toHaveLength(101);
    expect(markup.match(/data-command-centre-kind="tab"/g)).toHaveLength(101);
    expect(markup.match(/data-command-centre-active-input/g)).toHaveLength(1);
  });

  it("opens on Scout and renders cached favicons, tab metadata and keyboard help", () => {
    const markup = renderToStaticMarkup(
      <CommandCentre
        snapshot={snapshot}
        close={vi.fn()}
        askScout={vi.fn()}
        searchWeb={vi.fn()}
        activateTab={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Command Centre"');
    expect(markup).toContain('placeholder="Ask Scout..."');
    expect(markup).toContain('id="command-centre-scout"');
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain('data-command-centre-active-input="true"');
    expect(markup.match(/data-command-centre-active-input/g)).toHaveLength(1);
    expect(markup).not.toContain("command-centre-input-shell");
    expect(markup.indexOf('id="command-centre-scout"')).toBeLessThan(
      markup.indexOf('data-command-centre-active-input="true"'),
    );
    expect(
      markup.indexOf('data-command-centre-active-input="true"'),
    ).toBeLessThan(markup.indexOf('id="command-centre-search"'));
    expect(markup).toContain('class="ai-static-avatar"');
    expect(markup).toContain("Start a new conversation with Scout.");
    expect(markup).toContain("Search using your default search engine.");
    expect(markup).toContain('class="command-centre-section-heading"');
    expect(markup).toContain("Open tabs");
    expect(markup).not.toContain('id="command-centre-tabs"');
    expect(markup).not.toContain('aria-label="Open tabs" data-selected');
    expect(markup).toContain("data:image/png;base64,ZmF2aWNvbg==");
    expect(markup).toContain("Research");
    expect(markup).toContain("Active");
    expect(markup).not.toContain("token=private");
  });
});
