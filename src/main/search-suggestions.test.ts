import { describe, expect, it, vi } from "vitest";

import {
  parseDuckDuckGoSuggestions,
  SearchSuggestionService,
  type SuggestionFetch,
} from "./search-suggestions";

function preferences(enabled: boolean) {
  return {
    snapshot: {
      searchEngine: "duckduckgo" as const,
      remoteSearchSuggestionsEnabled: enabled,
    },
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseDuckDuckGoSuggestions", () => {
  it("sanitises, deduplicates and caps OpenSearch results", () => {
    expect(
      parseDuckDuckGoSuggestions(
        [
          "how to build",
          [
            " how to build a website ",
            "how to build a website",
            "how to build",
            "how to build a pc",
            "how to build an app",
            "how to build a browser",
            "how to build a deck",
            "how to build a house",
            "how to build a resume",
            "how to build a table",
            "ignored ninth result",
            "unsafe\u0000control",
          ],
        ],
        "how to build",
      ),
    ).toEqual([
      "how to build a website",
      "how to build a pc",
      "how to build an app",
      "how to build a browser",
      "how to build a deck",
      "how to build a house",
      "how to build a resume",
      "how to build a table",
    ]);
  });

  it("rejects malformed payloads", () => {
    expect(parseDuckDuckGoSuggestions({ suggestions: [] }, "query")).toEqual(
      [],
    );
    expect(parseDuckDuckGoSuggestions(["query", "wrong"], "query")).toEqual([]);
  });
});

describe("SearchSuggestionService", () => {
  it("does not connect while the privacy setting is disabled", async () => {
    const fetchProvider = vi.fn<SuggestionFetch>();
    const service = new SearchSuggestionService(
      preferences(false),
      fetchProvider,
    );

    await expect(
      service.getSuggestions("private query"),
    ).resolves.toMatchObject({
      suggestions: [],
    });
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  it("does not connect for empty or one-character input", async () => {
    const fetchProvider = vi.fn<SuggestionFetch>();
    const service = new SearchSuggestionService(
      preferences(true),
      fetchProvider,
    );

    await service.getSuggestions("");
    await service.getSuggestions("a");
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  it("requests and parses real provider-shaped results", async () => {
    const fetchProvider = vi
      .fn<SuggestionFetch>()
      .mockResolvedValue(
        response(["browser", ["browser test", "browser engine"]]),
      );
    const service = new SearchSuggestionService(
      preferences(true),
      fetchProvider,
    );

    await expect(service.getSuggestions("browser")).resolves.toEqual({
      query: "browser",
      provider: "duckduckgo",
      suggestions: ["browser test", "browser engine"],
    });
    const [url, init] = fetchProvider.mock.calls[0]!;
    expect(url).toContain("https://duckduckgo.com/ac/");
    expect(url).toContain("q=browser");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
  });

  it("aborts older work and never returns a stale result", async () => {
    const pending: Array<{
      signal: AbortSignal;
      resolve: (value: Response) => void;
    }> = [];
    const fetchProvider: SuggestionFetch = (_url, init) =>
      new Promise((resolve) => {
        pending.push({ signal: init.signal as AbortSignal, resolve });
      });
    const service = new SearchSuggestionService(
      preferences(true),
      fetchProvider,
    );

    const oldRequest = service.getSuggestions("old query");
    const newRequest = service.getSuggestions("new query");
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[1]!.resolve(response(["new query", ["new query result"]]));
    await expect(newRequest).resolves.toMatchObject({
      suggestions: ["new query result"],
    });
    pending[0]!.resolve(response(["old query", ["stale result"]]));
    await expect(oldRequest).resolves.toMatchObject({ suggestions: [] });
  });

  it("suppresses an in-flight result after cancellation", async () => {
    let resolveRequest!: (value: Response) => void;
    const fetchProvider: SuggestionFetch = () =>
      new Promise((resolve) => {
        resolveRequest = resolve;
      });
    const service = new SearchSuggestionService(
      preferences(true),
      fetchProvider,
    );

    const request = service.getSuggestions("private later");
    service.cancel();
    resolveRequest(response(["private later", ["must not surface"]]));
    await expect(request).resolves.toMatchObject({ suggestions: [] });
  });

  it("fails closed for provider errors and oversized bodies", async () => {
    const failed = new SearchSuggestionService(
      preferences(true),
      vi.fn<SuggestionFetch>().mockResolvedValue(response([], 503)),
    );
    await expect(failed.getSuggestions("query")).resolves.toMatchObject({
      suggestions: [],
    });

    const oversized = new SearchSuggestionService(
      preferences(true),
      vi
        .fn<SuggestionFetch>()
        .mockResolvedValue(new Response("x".repeat(70_000))),
    );
    await expect(oversized.getSuggestions("query")).resolves.toMatchObject({
      suggestions: [],
    });
  });
});
