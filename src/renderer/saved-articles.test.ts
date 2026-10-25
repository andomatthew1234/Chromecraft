import { describe, expect, it } from "vitest";

import type { SavedArticleEntry } from "../shared/browser";
import { filterAndSortSavedArticles } from "./saved-articles";

const entries: SavedArticleEntry[] = [
  {
    id: "new-read",
    canonicalUrl: "https://example.com/zulu",
    originalUrl: "https://example.com/zulu",
    title: "Zulu",
    siteName: "Example",
    faviconDataUrl: null,
    description: "A finished article",
    savedAt: 30,
    isRead: true,
  },
  {
    id: "middle-unread",
    canonicalUrl: "https://news.test/alpha",
    originalUrl: "https://news.test/alpha",
    title: "Alpha",
    siteName: "News Test",
    faviconDataUrl: null,
    description: "Still to read",
    savedAt: 20,
    isRead: false,
  },
  {
    id: "old-unread",
    canonicalUrl: "https://example.com/bravo",
    originalUrl: "https://example.com/bravo",
    title: "Bravo",
    siteName: "Example",
    faviconDataUrl: null,
    description: null,
    savedAt: 10,
    isRead: false,
  },
];

describe("filterAndSortSavedArticles", () => {
  it("supports all saved-library sort orders", () => {
    expect(
      filterAndSortSavedArticles(entries, "", "recent").map((e) => e.id),
    ).toEqual(["new-read", "middle-unread", "old-unread"]);
    expect(
      filterAndSortSavedArticles(entries, "", "oldest").map((e) => e.id),
    ).toEqual(["old-unread", "middle-unread", "new-read"]);
    expect(
      filterAndSortSavedArticles(entries, "", "title").map((e) => e.id),
    ).toEqual(["middle-unread", "old-unread", "new-read"]);
    expect(
      filterAndSortSavedArticles(entries, "", "unread").map((e) => e.id),
    ).toEqual(["middle-unread", "old-unread", "new-read"]);
  });

  it("searches titles, sites, descriptions and URLs", () => {
    expect(
      filterAndSortSavedArticles(entries, "news test", "recent").map(
        (e) => e.id,
      ),
    ).toEqual(["middle-unread"]);
    expect(
      filterAndSortSavedArticles(entries, "finished", "recent").map(
        (e) => e.id,
      ),
    ).toEqual(["new-read"]);
  });
});
