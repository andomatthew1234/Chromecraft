import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { AiToolsSnapshot, OrganiseTabsProposal } from "../shared/ai-tools";
import { OrganiseTabsPanel } from "./OrganiseTabsPanel";

function snapshot(overrides: Partial<AiToolsSnapshot> = {}): AiToolsSnapshot {
  return {
    provider: "ollama",
    preferredGroupingMode: "smart",
    eligibleTabCount: 3,
    cloudDataPreview: [],
    ollama: {
      endpoint: "http://127.0.0.1:11434",
      connection: "connected",
      models: [
        {
          name: "qwen3:4b",
          size: 1,
          modifiedAt: null,
          family: "qwen3",
          parameterSize: "4B",
        },
      ],
      selectedModel: "qwen3:4b",
      error: null,
    },
    gemini: {
      connection: "unknown",
      models: [],
      selectedModel: null,
      error: null,
      apiKeyConfigured: false,
      secureStorageAvailable: true,
      sessionOnly: false,
      cloudConsentGranted: false,
    },
    endpoint: "http://127.0.0.1:11434",
    connection: "connected",
    models: [
      {
        name: "qwen3:4b",
        size: 1,
        modifiedAt: null,
        family: "qwen3",
        parameterSize: "4B",
      },
    ],
    selectedModel: "qwen3:4b",
    error: null,
    run: {
      operationId: null,
      toolId: "organise-tabs",
      stage: "idle",
      label: "Ready",
      error: null,
      proposalId: null,
      undoAvailable: false,
    },
    ...overrides,
  };
}

const callbacks = {
  contextStatus: "ready" as const,
  refreshContext: vi.fn(),
  close: vi.fn(),
  organise: vi.fn(),
  refreshModels: vi.fn(),
  installRecommendedModel: vi.fn(),
  selectProvider: vi.fn(),
  selectGroupingMode: vi.fn(),
  selectModel: vi.fn(),
  apply: vi.fn(),
  cancel: vi.fn(),
  undo: vi.fn(),
  openAiSettings: vi.fn(),
};

describe("OrganiseTabsPanel", () => {
  it("renders one compact setup with a persistent primary action", () => {
    const markup = renderToStaticMarkup(
      <OrganiseTabsPanel
        snapshot={snapshot()}
        proposal={null}
        {...callbacks}
      />,
    );
    const stylesheet = readFileSync(
      new URL("./ai-tools.css", import.meta.url),
      "utf8",
    );

    expect(markup).toContain('aria-label="AI provider"');
    expect(markup).toContain("More options");
    expect(markup).toContain("Organise tabs");
    expect(markup).not.toContain("Choose where it runs");
    expect(markup).not.toContain("How should tabs be grouped?");
    expect(markup).not.toContain("expand_more");
    expect(stylesheet).toContain(
      "grid-template-rows: auto minmax(0, 1fr) auto",
    );
    expect(stylesheet).toContain(".ai-tools-content");
    expect(stylesheet).toContain("min-height: 0");
  });

  it("does not present a stale zero while tab collection is loading or failed", () => {
    const loading = renderToStaticMarkup(
      <OrganiseTabsPanel
        snapshot={snapshot({ eligibleTabCount: 0 })}
        proposal={null}
        {...callbacks}
        contextStatus="loading"
      />,
    );
    const failed = renderToStaticMarkup(
      <OrganiseTabsPanel
        snapshot={snapshot({ eligibleTabCount: 0 })}
        proposal={null}
        {...callbacks}
        contextStatus="error"
      />,
    );

    expect(loading).toContain("Checking tabs…");
    expect(loading).not.toContain("0 eligible tabs");
    expect(failed).toContain("Couldn’t read the open tabs");
    expect(failed).toContain("Try again");
  });

  it("explains genuine zero eligible-tab states", () => {
    const markup = renderToStaticMarkup(
      <OrganiseTabsPanel
        snapshot={snapshot({ eligibleTabCount: 0 })}
        proposal={null}
        {...callbacks}
      />,
    );

    expect(markup).toContain("0 eligible tabs");
    expect(markup).toContain("Open at least two regular website tabs");
    expect(markup).toContain("New Tab, Settings, pinned tabs");
    expect(markup).toContain('disabled=""');
  });

  it("renders a reviewable tab-group plan and local-data disclosure", () => {
    const proposal: OrganiseTabsProposal = {
      id: "proposal-1",
      toolId: "organise-tabs",
      provider: "ollama",
      model: "qwen3:4b",
      createdAt: 1,
      groups: [
        {
          name: "Research",
          color: "purple",
          tabIds: ["a", "b"],
          tabTitles: ["A docs", "B docs"],
          tabFavicons: [null, null],
        },
      ],
      ungroupedTabIds: [],
      ungroupedTabTitles: [],
      ungroupedTabFavicons: [],
      preservedTabCount: 1,
      summary: "Organise 2 tabs into 1 group.",
      warnings: ["1 pinned tab was protected and left unchanged."],
    };
    const current = snapshot({
      run: {
        ...snapshot().run,
        stage: "ready",
        proposalId: proposal.id,
      },
    });

    const markup = renderToStaticMarkup(
      <OrganiseTabsPanel
        snapshot={current}
        proposal={proposal}
        {...callbacks}
      />,
    );

    expect(markup).toContain("Ready for review");
    expect(markup).toContain("Research");
    expect(markup).toContain("Apply groups");
    expect(markup).toContain("Titles and domains stay");
  });

  it("gives useful recovery guidance when Ollama is unavailable", () => {
    const current = snapshot({
      connection: "unavailable",
      models: [],
      selectedModel: null,
      error: "Start Ollama, then try again.",
      ollama: {
        ...snapshot().ollama,
        connection: "unavailable",
        models: [],
        selectedModel: null,
        error: "Start Ollama, then try again.",
      },
      run: {
        ...snapshot().run,
        stage: "failed",
        label: "Ollama unavailable",
        error: "Start Ollama, then try again.",
      },
    });

    const markup = renderToStaticMarkup(
      <OrganiseTabsPanel snapshot={current} proposal={null} {...callbacks} />,
    );

    expect(markup).toContain("Ollama unavailable");
    expect(markup).toContain("Start Ollama");
    expect(markup).toContain("Use simple website grouping");
  });
});
