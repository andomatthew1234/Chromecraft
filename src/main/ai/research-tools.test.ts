import { describe, expect, it, vi } from "vitest";

import type {
  BrowserPageObservation,
  BrowserReaderObservation,
  BrowserResearchAdapter,
  BrowserResearchTab,
  BrowserScreenshotObservation,
} from "./browser-research";
import type { AgentToolContext } from "./agent-runtime";
import { ResearchToolSet } from "./research-tools";

function tab(index: number): BrowserResearchTab {
  return {
    tabId: `private-tab-${index}`,
    windowId: "private-window",
    title: `Article ${index}`,
    url: `https://example${index}.test/article?token=secret#private`,
    hostname: `example${index}.test`,
    active: index === 0,
    readerAvailable: true,
    faviconDataUrl: null,
    documentRevision: `revision-${index}`,
    observationRevision: `observation-${index}`,
  };
}

function browser(tabs = [tab(0), tab(1)]): BrowserResearchAdapter {
  return {
    listTabs: vi.fn(async () => structuredClone(tabs)),
    inspectMetadata: vi.fn(async (tabId) =>
      structuredClone(tabs.find((item) => item.tabId === tabId)!),
    ),
    readPageExcerpt: vi.fn(async (tabId) => {
      const selected = tabs.find((item) => item.tabId === tabId)!;
      return {
        tab: structuredClone(selected),
        text: `Evidence from ${selected.title}`,
        headings: [selected.title],
        complete: true,
      } satisfies BrowserPageObservation;
    }),
    readReaderArticle: vi.fn(async (tabId, _revision, offset) => {
      const selected = tabs.find((item) => item.tabId === tabId)!;
      return {
        tab: structuredClone(selected),
        text: `Reader evidence from ${selected.title}`,
        headings: [selected.title],
        complete: true,
        author: "Author",
        siteName: selected.hostname,
        publishedTime: null,
        offset,
        nextOffset: null,
      } satisfies BrowserReaderObservation;
    }),
    captureScreenshot: vi.fn(async (tabId) => {
      const selected = tabs.find((item) => item.tabId === tabId)!;
      return {
        tab: structuredClone(selected),
        mimeType: "image/png",
        data: "cG5n",
      } satisfies BrowserScreenshotObservation;
    }),
    currentDocumentRevision: vi.fn(
      (tabId) =>
        tabs.find((item) => item.tabId === tabId)?.documentRevision ?? null,
    ),
    currentRevision: vi.fn(
      (tabId) =>
        tabs.find((item) => item.tabId === tabId)?.observationRevision ?? null,
    ),
    openTab: vi.fn(async () => undefined),
  };
}

function context(runId = "run-1"): AgentToolContext {
  return {
    runId,
    conversationId: "conversation-1",
    signal: new AbortController().signal,
    now: Date.now,
  };
}

describe("ResearchToolSet", () => {
  it("returns opaque references for 20+ tabs and never exposes internal IDs", async () => {
    const adapter = browser(
      Array.from({ length: 24 }, (_, index) => tab(index)),
    );
    const tools = new ResearchToolSet(adapter);
    const list = tools.tools.find(
      (tool) => tool.description.id === "list_tabs",
    )!;
    const prepared = await list.prepare({}, context());
    const result = await list.execute(prepared, context());
    const encoded = JSON.stringify(result.modelResult);

    expect((result.modelResult as { count: number }).count).toBe(24);
    expect(encoded).toContain("tab-");
    expect(encoded).not.toContain("private-tab-");
    expect(encoded).not.toContain("private-window");
    expect(encoded).not.toContain("secret");
  });

  it("reads a bounded page and emits sanitized provenance", async () => {
    const adapter = browser();
    const tools = new ResearchToolSet(adapter);
    const list = tools.tools.find(
      (tool) => tool.description.id === "list_tabs",
    )!;
    const listed = await list.execute(
      await list.prepare({}, context()),
      context(),
    );
    const tabRef = (listed.modelResult as { tabs: Array<{ tabRef: string }> })
      .tabs[0]!.tabRef;
    const read = tools.tools.find(
      (tool) => tool.description.id === "read_page_excerpt",
    )!;
    const value = { tabRef, maximumCharacters: 4_000 };
    const result = await read.execute(
      await read.prepare(value, context()),
      context(),
    );

    expect(result.source).toMatchObject({
      title: "Article 0",
      url: "https://example0.test/article",
      hostname: "example0.test",
      complete: true,
    });
    expect(JSON.stringify(result.source)).not.toContain("private-tab");
    expect(result.modelResult).toEqual(
      expect.objectContaining({ untrustedPageText: "Evidence from Article 0" }),
    );
  });

  it("allows a fresh read across content mutations while keeping document identity stable", async () => {
    const tabs = [tab(0)];
    const adapter = browser(tabs);
    const tools = new ResearchToolSet(adapter);
    const list = tools.tools.find(
      (tool) => tool.description.id === "list_tabs",
    )!;
    const listed = await list.execute(
      await list.prepare({}, context()),
      context(),
    );
    const tabRef = (listed.modelResult as { tabs: Array<{ tabRef: string }> })
      .tabs[0]!.tabRef;
    const read = tools.tools.find(
      (tool) => tool.description.id === "read_page_excerpt",
    )!;
    const value = { tabRef, maximumCharacters: 4_000 };
    const prepared = await read.prepare(value, context());
    tabs[0]!.observationRevision = "dynamic-content-2";

    const result = await read.execute(prepared, context());
    expect(result.source?.title).toBe("Article 0");
    await tools.openSource("run-1", result.source!.id);
    expect(adapter.openTab).toHaveBeenCalledWith(
      "private-tab-0",
      expect.any(String),
    );
  });

  it("keeps screenshots out of tool results and passes pixels separately", async () => {
    const adapter = browser();
    const tools = new ResearchToolSet(adapter);
    const list = tools.tools.find(
      (tool) => tool.description.id === "list_tabs",
    )!;
    const listed = await list.execute(
      await list.prepare({}, context()),
      context(),
    );
    const tabRef = (listed.modelResult as { tabs: Array<{ tabRef: string }> })
      .tabs[0]!.tabRef;
    const capture = tools.tools.find(
      (tool) => tool.description.id === "capture_tab_screenshot",
    )!;
    const result = await capture.execute(
      await capture.prepare({ tabRef }, context()),
      context(),
    );

    expect(JSON.stringify(result.modelResult)).not.toContain("cG5n");
    expect(result.images).toEqual([{ mimeType: "image/png", data: "cG5n" }]);
  });

  it("detects navigation staleness before resume", async () => {
    const tabs = [tab(0)];
    const adapter = browser(tabs);
    const tools = new ResearchToolSet(adapter);
    const list = tools.tools.find(
      (tool) => tool.description.id === "list_tabs",
    )!;
    const listed = await list.execute(
      await list.prepare({}, context()),
      context(),
    );
    const tabRef = (listed.modelResult as { tabs: Array<{ tabRef: string }> })
      .tabs[0]!.tabRef;
    const inspect = tools.tools.find(
      (tool) => tool.description.id === "inspect_tab_metadata",
    )!;
    const observation = await inspect.execute(
      await inspect.prepare({ tabRef }, context()),
      context(),
    );
    tabs[0]!.observationRevision = "navigated";

    const stale = await tools.validate(
      [observation.source!],
      new AbortController().signal,
    );
    expect(stale).toEqual(new Set([observation.source!.id]));
  });

  it("rejects malformed or unexpected tool arguments", async () => {
    const tools = new ResearchToolSet(browser());
    const list = tools.tools.find(
      (tool) => tool.description.id === "list_tabs",
    )!;
    await expect(list.prepare({ grantAdmin: true }, context())).rejects.toThrow(
      /unsupported/u,
    );
    const search = tools.tools.find(
      (tool) => tool.description.id === "search_open_tabs",
    )!;
    await expect(
      search.prepare({ query: "x", hidden: "secret" }, context()),
    ).rejects.toThrow(/unsupported/u);
  });
});
