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
    expect(markup).toContain('id="command-centre-tabs"');
    expect(markup).toContain("data:image/png;base64,ZmF2aWNvbg==");
    expect(markup).toContain("Research");
    expect(markup).toContain("Active");
    expect(markup).not.toContain("token=private");
  });
});
