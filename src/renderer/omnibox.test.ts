import { describe, expect, it } from "vitest";

import type { BrowserDataSnapshot, HistoryEntry } from "../shared/browser";
import {
  buildLocalOmniboxSuggestions,
  buildOmniboxSuggestions,
  createLocalOmniboxIndex,
  getInlineCompletion,
  getOmniboxKeyAction,
  highlightSuggestionText,
} from "./omnibox-model";

const now = new Date("2026-10-15T12:00:00Z").getTime();

function history(
  id: string,
  title: string,
  url: string,
  ageMinutes: number,
  typed = false,
): HistoryEntry {
  return {
    id,
    title,
    url,
    visitedAt: now - ageMinutes * 60_000,
    typed,
  };
}

const data: BrowserDataSnapshot = {
  bookmarks: [
    {
      id: "youtube-bookmark",
      title: "YouTube",
      url: "https://www.youtube.com/",
      folder: "Media",
      createdAt: now - 10_000,
    },
    {
      id: "material",
      title: "Material Design",
      url: "https://m3.material.io/",
      folder: "Design",
      createdAt: now - 20_000,
    },
  ],
  history: [
    history("youtube-1", "YouTube", "https://www.youtube.com/", 1, true),
    history("youtube-2", "YouTube", "https://www.youtube.com/", 5, true),
    history(
      "youtube-watch",
      "A useful video",
      "https://www.youtube.com/watch?v=abc",
      10,
    ),
    history(
      "title-only",
      "You should read this",
      "https://example.com/article",
      0,
    ),
  ],
  recentlyClosed: [],
  quickLinks: [],
  savedTabGroups: [],
  recentlyClosedWindows: [],
};

describe("local Omnibox ranking", () => {
  it("aggregates visits and prioritises a strong hostname prefix", () => {
    const suggestions = buildLocalOmniboxSuggestions(
      "you",
      createLocalOmniboxIndex(data),
      now,
    );

    expect(suggestions[0]).toMatchObject({
      label: "YouTube",
      value: "https://www.youtube.com/",
      icon: "bookmark",
    });
    expect(
      suggestions.findIndex((item) => item.value.includes("example")),
    ).toBeGreaterThan(0);
  });

  it("uses typed frequency ahead of otherwise comparable ordinary visits", () => {
    const rankingData: BrowserDataSnapshot = {
      bookmarks: [],
      history: [
        history("typed-1", "Alpha typed", "https://alpha-one.test/", 30, true),
        history("typed-2", "Alpha typed", "https://alpha-one.test/", 40, true),
        history("visit-1", "Alpha visited", "https://alpha-two.test/", 1),
        history("visit-2", "Alpha visited", "https://alpha-two.test/", 2),
        history("visit-3", "Alpha visited", "https://alpha-two.test/", 3),
      ],
      recentlyClosed: [],
      quickLinks: [],
      savedTabGroups: [],
      recentlyClosedWindows: [],
    };

    expect(
      buildLocalOmniboxSuggestions(
        "alpha",
        createLocalOmniboxIndex(rankingData),
        now,
      )[0]?.value,
    ).toBe("https://alpha-one.test/");
  });

  it("deduplicates a bookmarked URL from its history visits", () => {
    const suggestions = buildLocalOmniboxSuggestions(
      "youtube",
      createLocalOmniboxIndex(data),
      now,
    );
    expect(
      suggestions.filter((item) => item.value === "https://www.youtube.com/"),
    ).toHaveLength(1);
  });

  it("returns useful local recommendations for empty input", () => {
    const suggestions = buildOmniboxSuggestions(
      "",
      createLocalOmniboxIndex(data),
      ["must never appear"],
      now,
    );
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((item) => item.kind === "url")).toBe(true);
  });
});

describe("inline completion and combined suggestions", () => {
  it("completes a familiar host and selects only its suffix", () => {
    expect(
      getInlineCompletion("you", createLocalOmniboxIndex(data), now),
    ).toEqual({
      value: "youtube.com",
      url: "https://www.youtube.com/",
      suffixStart: 3,
    });
  });

  it("does not complete ordinary multi-word search text", () => {
    expect(
      getInlineCompletion("you should", createLocalOmniboxIndex(data), now),
    ).toBeNull();
  });

  it("keeps local URL results above real provider suggestions", () => {
    const suggestions = buildOmniboxSuggestions(
      "you",
      createLocalOmniboxIndex(data),
      ["youtube music", "youtube shorts"],
      now,
    );
    expect(suggestions[0]?.kind).toBe("url");
    expect(suggestions.findIndex((item) => item.kind === "remote-search")).toBe(
      4,
    );
  });

  it("highlights matching text without HTML injection", () => {
    expect(highlightSuggestionText("YouTube Music", "tube")).toEqual([
      { text: "You", match: false },
      { text: "Tube", match: true },
      { text: " Music", match: false },
    ]);
  });
});

describe("Omnibox keyboard decisions", () => {
  const state = {
    activeIndex: 0,
    suggestionCount: 3,
    expanded: true,
    hasInlineCompletion: true,
  };

  it("cycles through suggestions with arrow keys", () => {
    expect(getOmniboxKeyAction("ArrowDown", state)).toEqual({
      type: "move",
      index: 1,
    });
    expect(getOmniboxKeyAction("ArrowUp", state)).toEqual({
      type: "move",
      index: 2,
    });
  });

  it("accepts inline completion with Tab or Right Arrow", () => {
    expect(getOmniboxKeyAction("Tab", state).type).toBe("accept-inline");
    expect(getOmniboxKeyAction("ArrowRight", state).type).toBe("accept-inline");
  });

  it("commits with Enter and closes with Escape", () => {
    expect(getOmniboxKeyAction("Enter", state).type).toBe("commit");
    expect(getOmniboxKeyAction("Escape", state).type).toBe("close");
  });
});
