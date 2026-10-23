import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AiToolsSnapshot, OrganiseTabsProposal } from "../shared/ai-tools";
import { OrganiseTabsPanel } from "./OrganiseTabsPanel";

function snapshot(overrides: Partial<AiToolsSnapshot> = {}): AiToolsSnapshot {
  return {
    provider: "ollama",
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
  close: vi.fn(),
  retry: vi.fn(),
  refreshModels: vi.fn(),
  selectModel: vi.fn(),
  apply: vi.fn(),
  cancel: vi.fn(),
  undo: vi.fn(),
};

describe("OrganiseTabsPanel", () => {
  it("renders a reviewable tab-group plan and local-data disclosure", () => {
    const proposal: OrganiseTabsProposal = {
      id: "proposal-1",
      toolId: "organise-tabs",
      model: "qwen3:4b",
      createdAt: 1,
      groups: [
        {
          name: "Research",
          color: "purple",
          tabIds: ["a", "b"],
          tabTitles: ["A docs", "B docs"],
        },
      ],
      ungroupedTabIds: [],
      ungroupedTabTitles: [],
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

    expect(markup).toContain("Plan ready");
    expect(markup).toContain("Research");
    expect(markup).toContain("Apply plan");
    expect(markup).toContain("Page contents are never read");
    expect(markup).toContain("cloud-backed Ollama models");
  });

  it("gives useful recovery guidance when Ollama is unavailable", () => {
    const current = snapshot({
      connection: "unavailable",
      models: [],
      selectedModel: null,
      error: "Start Ollama, then try again.",
      run: { ...snapshot().run, stage: "failed" },
    });

    const markup = renderToStaticMarkup(
      <OrganiseTabsPanel snapshot={current} proposal={null} {...callbacks} />,
    );

    expect(markup).toContain("Ollama isn’t available yet");
    expect(markup).toContain("ollama serve");
    expect(markup).toContain("Retry");
  });
});
