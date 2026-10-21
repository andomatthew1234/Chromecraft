import { describe, expect, it } from "vitest";

import {
  adaptLinkCandidate,
  findSiteAdapter,
  HYPERDRIVE_SITE_ADAPTERS,
  resolveSiteCandidateUrl,
} from "./adapters";

describe("Hyperdrive site adapters", () => {
  it("provides independently addressable adapters and scoped selectors", () => {
    expect(HYPERDRIVE_SITE_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      "google",
      "youtube",
      "chatgpt",
      "github",
      "wikipedia",
    ]);
    expect(
      HYPERDRIVE_SITE_ADAPTERS.every((adapter) => adapter.selectors.length > 0),
    ).toBe(true);
  });

  it.each([
    ["https://www.google.com/search?q=test", "google"],
    ["https://www.youtube.com/", "youtube"],
    ["https://chatgpt.com/", "chatgpt"],
    ["https://github.com/openai/", "github"],
    ["https://en.wikipedia.org/wiki/Test", "wikipedia"],
  ] as const)("recognises %s as %s", (url, expected) => {
    expect(findSiteAdapter(url)?.id).toBe(expected);
  });

  it("prioritises Google result destinations and suppresses redirect wrappers", () => {
    expect(
      adaptLinkCandidate("https://www.google.com/search?q=test", {
        id: "result",
        url: "https://example.com/article",
      }),
    ).toMatchObject({
      adapterId: "google",
      category: "search-result",
      priority: 0.22,
    });
    expect(
      adaptLinkCandidate("https://www.google.com/search?q=test", {
        id: "redirect",
        url: "/url?q=https://example.com",
      }).suppressSpeculation,
    ).toBe(true);
  });

  it("safely resolves a Google result wrapper to its public destination", () => {
    expect(
      resolveSiteCandidateUrl(
        "https://www.google.com/search?q=hello",
        "/url?sa=t&url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FHello%23History",
      ),
    ).toBe("https://en.wikipedia.org/wiki/Hello");
    expect(
      resolveSiteCandidateUrl(
        "https://www.google.com/search?q=hello",
        "/url?q=javascript%3Aalert(1)",
      ),
    ).toBe("https://www.google.com/url?q=javascript%3Aalert(1)");
  });

  it.each([
    ["https://www.youtube.com/watch?v=abc", "video", 0.25],
    ["https://www.youtube.com/shorts/abc", "short", 0.2],
    ["https://www.youtube.com/@creator", "channel", 0.1],
  ] as const)("classifies YouTube %s", (url, category, priority) => {
    expect(
      adaptLinkCandidate("https://www.youtube.com/", { id: url, url }),
    ).toMatchObject({ adapterId: "youtube", category, priority });
  });

  it("refuses to speculate private ChatGPT content", () => {
    expect(
      adaptLinkCandidate("https://chatgpt.com/", {
        id: "conversation",
        url: "https://chatgpt.com/c/private",
      }),
    ).toMatchObject({
      adapterId: "chatgpt",
      category: "private-conversation",
      sensitive: true,
      suppressSpeculation: true,
    });
  });

  it("recognises GitHub repositories and Wikipedia articles", () => {
    expect(
      adaptLinkCandidate("https://github.com/dashboard", {
        id: "repo",
        url: "https://github.com/openai/codex",
      }).category,
    ).toBe("repository");
    expect(
      adaptLinkCandidate("https://en.wikipedia.org/wiki/Browser", {
        id: "article",
        url: "/wiki/Electron_(software)",
      }).category,
    ).toBe("article");
  });

  it("suppresses duplicate work when the site already speculated a link", () => {
    expect(
      adaptLinkCandidate("https://github.com/", {
        id: "prepared",
        url: "https://github.com/openai/codex",
        alreadySpeculated: true,
      }).suppressSpeculation,
    ).toBe(true);
  });

  it("falls back cleanly on unsupported and malformed pages", () => {
    expect(
      adaptLinkCandidate("https://example.com/", {
        id: "generic",
        url: "/next",
      }).adapterId,
    ).toBe("generic");
    expect(findSiteAdapter("not a url")).toBeUndefined();
    expect(findSiteAdapter("https://google.evil.com/search")).toBeUndefined();
  });
});
