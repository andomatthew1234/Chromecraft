import { randomUUID } from "node:crypto";

import type { AgentSourceReference } from "../../shared/agent";
import type {
  AgentSourceValidator,
  AgentTool,
  AgentToolContext,
  AgentToolExecutionResult,
  PreparedAgentToolCall,
} from "./agent-runtime";
import type {
  BrowserResearchAdapter,
  BrowserResearchTab,
} from "./browser-research";

interface RunTabReference {
  ref: string;
  tab: BrowserResearchTab;
}

interface SourceTarget {
  runId: string;
  sourceId: string;
  tabId: string;
  documentRevision: string;
  revision: string;
  fallbackUrl: string;
}

interface RunScope {
  byRef: Map<string, RunTabReference>;
  refByTab: Map<string, string>;
  sourceByTab: Map<string, string>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Scout received malformed research-tool arguments.");
  }
  return value as Record<string, unknown>;
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new TypeError("Scout received unsupported research-tool arguments.");
  }
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  maximum: number,
): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim() || field.length > maximum) {
    throw new TypeError(`Scout received an invalid ${key}.`);
  }
  return field.trim();
}

function integerField(
  value: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const field = value[key] ?? fallback;
  if (
    !Number.isInteger(field) ||
    Number(field) < minimum ||
    Number(field) > maximum
  ) {
    throw new TypeError(`Scout received an invalid ${key}.`);
  }
  return Number(field);
}

function safeSourceUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function prepared(
  input: unknown,
  action: string,
  target: string,
  revision: string | null = null,
): PreparedAgentToolCall {
  return {
    input,
    action,
    target,
    expectedEffect:
      "Read browser information without changing the page or tab.",
    risk: "Read-only browser observation within this research run.",
    stateRevision: revision,
  };
}

function metadataForModel(reference: RunTabReference): Record<string, unknown> {
  return {
    tabRef: reference.ref,
    title: reference.tab.title,
    hostname: reference.tab.hostname,
    active: reference.tab.active,
    readerAvailable: reference.tab.readerAvailable,
  };
}

export class ResearchToolSet implements AgentSourceValidator {
  readonly tools: AgentTool[];
  private readonly scopes = new Map<string, RunScope>();
  private readonly sources = new Map<string, SourceTarget>();

  constructor(private readonly browser: BrowserResearchAdapter) {
    this.tools = [
      this.listTabsTool(),
      this.searchTabsTool(),
      this.inspectMetadataTool(),
      this.readPageTool(),
      this.readReaderTool(),
      this.screenshotTool(),
    ];
  }

  async validate(
    sources: AgentSourceReference[],
    signal: AbortSignal,
  ): Promise<Set<string>> {
    const stale = new Set<string>();
    for (const source of sources) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const target = this.sources.get(source.id);
      if (
        !target ||
        this.browser.currentRevision(target.tabId) !== target.revision
      ) {
        stale.add(source.id);
      }
    }
    return stale;
  }

  async openSource(runId: string, sourceId: string): Promise<void> {
    const target = this.sources.get(sourceId);
    if (!target || target.runId !== runId) {
      throw new Error("This research source is no longer available.");
    }
    await this.browser.openTab(
      this.browser.currentDocumentRevision(target.tabId) ===
        target.documentRevision
        ? target.tabId
        : "",
      target.fallbackUrl,
    );
  }

  releaseRun(runId: string): void {
    this.scopes.delete(runId);
    for (const [sourceId, target] of this.sources) {
      if (target.runId === runId) this.sources.delete(sourceId);
    }
  }

  private scope(runId: string): RunScope {
    let scope = this.scopes.get(runId);
    if (!scope) {
      scope = {
        byRef: new Map(),
        refByTab: new Map(),
        sourceByTab: new Map(),
      };
      this.scopes.set(runId, scope);
    }
    return scope;
  }

  private registerTabs(
    runId: string,
    tabs: BrowserResearchTab[],
  ): RunTabReference[] {
    const scope = this.scope(runId);
    const liveIds = new Set(tabs.map((tab) => tab.tabId));
    for (const [tabId, ref] of scope.refByTab) {
      if (!liveIds.has(tabId)) {
        scope.refByTab.delete(tabId);
        scope.byRef.delete(ref);
      }
    }
    return tabs.map((tab) => {
      const ref = scope.refByTab.get(tab.tabId) ?? `tab-${randomUUID()}`;
      const registered = { ref, tab };
      scope.refByTab.set(tab.tabId, ref);
      scope.byRef.set(ref, registered);
      return registered;
    });
  }

  private requireReference(runId: string, input: unknown): RunTabReference {
    const tabRef = stringField(record(input), "tabRef", 80);
    const reference = this.scope(runId).byRef.get(tabRef);
    if (!reference) {
      throw new Error("That tab reference is stale. List the open tabs again.");
    }
    return reference;
  }

  private source(
    runId: string,
    tab: BrowserResearchTab,
    observationType: AgentSourceReference["observationTypes"][number],
    complete: boolean,
  ): AgentSourceReference {
    const scope = this.scope(runId);
    const sourceId =
      scope.sourceByTab.get(tab.tabId) ?? `source-${randomUUID()}`;
    scope.sourceByTab.set(tab.tabId, sourceId);
    this.sources.set(sourceId, {
      runId,
      sourceId,
      tabId: tab.tabId,
      documentRevision: tab.documentRevision,
      revision: tab.observationRevision,
      fallbackUrl: tab.url,
    });
    return {
      id: sourceId,
      title: tab.title,
      url: safeSourceUrl(tab.url),
      hostname: tab.hostname,
      faviconDataUrl: tab.faviconDataUrl,
      capturedAt: Date.now(),
      complete,
      observationTypes: [observationType],
    };
  }

  private listTabsTool(): AgentTool {
    return {
      description: {
        id: "list_tabs",
        description:
          "List eligible ordinary browser tabs and their safe metadata.",
        inputSchema: { type: "object", additionalProperties: false },
        capability: "browser.tabs.observe",
        effect: "observe",
      },
      prepare: async (input) => {
        requireAllowedKeys(record(input), []);
        return prepared(
          {},
          "List eligible browser tabs",
          "Current browser profile",
        );
      },
      execute: async (_prepared, context) => {
        const tabs = this.registerTabs(
          context.runId,
          await this.browser.listTabs(context.signal),
        );
        return {
          modelResult: { count: tabs.length, tabs: tabs.map(metadataForModel) },
          eventLabel: `Found ${tabs.length} open ${tabs.length === 1 ? "tab" : "tabs"}`,
          observationBytes: JSON.stringify(tabs.map(metadataForModel)).length,
        };
      },
    };
  }

  private searchTabsTool(): AgentTool {
    return {
      description: {
        id: "search_open_tabs",
        description: "Find relevant open tabs by title or hostname.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string", maxLength: 200 } },
          required: ["query"],
        },
        capability: "browser.tabs.observe",
        effect: "observe",
      },
      prepare: async (input) => {
        const inputRecord = record(input);
        requireAllowedKeys(inputRecord, ["query"]);
        const query = stringField(inputRecord, "query", 200);
        return prepared({ query }, "Search open tabs", query);
      },
      execute: async (value, context) => {
        const query = stringField(
          record(value.input),
          "query",
          200,
        ).toLowerCase();
        const tabs = this.registerTabs(
          context.runId,
          await this.browser.listTabs(context.signal),
        ).filter((item) =>
          `${item.tab.title} ${item.tab.hostname}`
            .toLowerCase()
            .includes(query),
        );
        return {
          modelResult: {
            query,
            count: tabs.length,
            tabs: tabs.map(metadataForModel),
          },
          eventLabel: `Matched ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`,
          eventDetail: query,
        };
      },
    };
  }

  private inspectMetadataTool(): AgentTool {
    return this.tabTool(
      "inspect_tab_metadata",
      "Read current metadata for one eligible tab.",
      async (reference, context) => {
        const tab = await this.browser.inspectMetadata(
          reference.tab.tabId,
          reference.tab.documentRevision,
          context.signal,
        );
        reference.tab = tab;
        return {
          modelResult: metadataForModel(reference),
          eventType: "tab-inspected",
          eventLabel: `Inspected ${tab.title}`,
          source: this.source(context.runId, tab, "metadata", false),
        };
      },
    );
  }

  private readPageTool(): AgentTool {
    return this.tabTool(
      "read_page_excerpt",
      "Read a bounded visible-text excerpt from one eligible webpage.",
      async (reference, context, input) => {
        const maximumCharacters = integerField(
          record(input),
          "maximumCharacters",
          12_000,
          1_000,
          24_000,
        );
        const observation = await this.browser.readPageExcerpt(
          reference.tab.tabId,
          reference.tab.documentRevision,
          maximumCharacters,
          context.signal,
        );
        reference.tab = observation.tab;
        const source = this.source(
          context.runId,
          observation.tab,
          "page-excerpt",
          observation.complete,
        );
        return {
          modelResult: {
            sourceId: source.id,
            title: observation.tab.title,
            hostname: observation.tab.hostname,
            headings: observation.headings,
            completeness: observation.complete
              ? "full-visible-text"
              : "partial",
            untrustedPageText: observation.text,
          },
          eventType: "tab-inspected",
          eventLabel: `Read ${observation.tab.title}`,
          eventDetail: observation.complete
            ? "Visible page text"
            : "Partial page excerpt",
          source,
          observationBytes: observation.text.length,
        };
      },
      {
        maximumCharacters: {
          type: "integer",
          minimum: 1_000,
          maximum: 24_000,
        },
      },
    );
  }

  private readReaderTool(): AgentTool {
    return this.tabTool(
      "read_reader_article",
      "Read a bounded Smart Reader article chunk with article metadata.",
      async (reference, context, input) => {
        const inputRecord = record(input);
        const offset = integerField(inputRecord, "offset", 0, 0, 10_000_000);
        const maximumCharacters = integerField(
          inputRecord,
          "maximumCharacters",
          16_000,
          1_000,
          24_000,
        );
        const observation = await this.browser.readReaderArticle(
          reference.tab.tabId,
          reference.tab.documentRevision,
          offset,
          maximumCharacters,
          context.signal,
        );
        reference.tab = observation.tab;
        const source = this.source(
          context.runId,
          observation.tab,
          "reader-article",
          observation.complete && observation.offset === 0,
        );
        return {
          modelResult: {
            sourceId: source.id,
            title: observation.tab.title,
            hostname: observation.tab.hostname,
            author: observation.author,
            siteName: observation.siteName,
            publishedTime: observation.publishedTime,
            headings: observation.headings,
            offset: observation.offset,
            nextOffset: observation.nextOffset,
            completeness:
              observation.complete && observation.offset === 0
                ? "full-article"
                : observation.nextOffset === null
                  ? "article-end-chunk"
                  : "partial",
            untrustedArticleText: observation.text,
          },
          eventType: "article-read",
          eventLabel: `Read ${observation.tab.title}`,
          eventDetail:
            observation.nextOffset === null
              ? "Reached the end of the Reader article"
              : "Reader article chunk",
          source,
          observationBytes: observation.text.length,
        };
      },
      {
        offset: { type: "integer", minimum: 0 },
        maximumCharacters: {
          type: "integer",
          minimum: 1_000,
          maximum: 24_000,
        },
      },
    );
  }

  private screenshotTool(): AgentTool {
    return this.tabTool(
      "capture_tab_screenshot",
      "Capture a bounded image of one eligible browser tab when visual evidence is necessary.",
      async (reference, context) => {
        const observation = await this.browser.captureScreenshot(
          reference.tab.tabId,
          reference.tab.documentRevision,
          context.signal,
        );
        reference.tab = observation.tab;
        const source = this.source(
          context.runId,
          observation.tab,
          "screenshot",
          false,
        );
        return {
          modelResult: {
            sourceId: source.id,
            title: observation.tab.title,
            hostname: observation.tab.hostname,
            screenshotAttachedToNextTurn: true,
          },
          eventType: "screenshot-captured",
          eventLabel: `Captured ${observation.tab.title}`,
          source,
          images: [{ mimeType: observation.mimeType, data: observation.data }],
          observationBytes: 0,
        };
      },
      undefined,
      true,
    );
  }

  private tabTool(
    id: string,
    description: string,
    execute: (
      reference: RunTabReference,
      context: AgentToolContext,
      input: unknown,
    ) => Promise<AgentToolExecutionResult>,
    extraProperties: Record<string, unknown> = {},
    requiresImages = false,
  ): AgentTool {
    return {
      description: {
        id,
        description,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            tabRef: { type: "string" },
            ...extraProperties,
          },
          required: ["tabRef"],
        },
        capability: "browser.tabs.observe",
        effect: "observe",
        requiresImages,
      },
      prepare: async (input, context) => {
        requireAllowedKeys(record(input), [
          "tabRef",
          ...Object.keys(extraProperties),
        ]);
        const reference = this.requireReference(context.runId, input);
        return prepared(
          input,
          description,
          `${reference.tab.title} (${reference.tab.hostname})`,
          reference.tab.documentRevision,
        );
      },
      execute: async (value, context) => {
        const reference = this.requireReference(context.runId, value.input);
        if (reference.tab.documentRevision !== value.stateRevision) {
          throw new Error(
            "This tab changed after Scout prepared the observation.",
          );
        }
        return execute(reference, context, value.input);
      },
    };
  }
}
