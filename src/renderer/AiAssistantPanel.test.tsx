import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AiToolsSnapshot } from "../shared/ai-tools";
import type { AssistantPageContext } from "../shared/ai-assistant";
import type { BrowserTabSnapshot } from "../shared/browser";
import { AiAssistantPanel, contextAttachments } from "./AiAssistantPanel";

const activeTab = {
  id: "tab-1",
  title: "Private search",
  url: "https://example.com/search?token=secret#section",
} as BrowserTabSnapshot;

const aiTools: AiToolsSnapshot = {
  provider: "ollama",
  organiserProvider: "ollama",
  organiserModels: { ollama: "qwen3:1.7b", gemini: null },
  preferredGroupingMode: "smart",
  eligibleTabCount: 0,
  cloudDataPreview: [],
  ollama: {
    endpoint: "http://127.0.0.1:11434",
    connection: "unavailable",
    models: [],
    selectedModel: null,
    error: null,
  },
  gemini: {
    connection: "unknown",
    models: [],
    selectedModel: null,
    error: null,
    apiKeyConfigured: false,
    secureStorageAvailable: false,
    sessionOnly: true,
    cloudConsentGranted: false,
  },
  endpoint: "http://127.0.0.1:11434",
  connection: "unavailable",
  models: [],
  selectedModel: null,
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
};

const context: AssistantPageContext = {
  tabId: "tab-1",
  url: activeTab.url,
  displayUrl: "example.com/search",
  title: "Private search",
  description: "A private page description",
  selectedText: null,
  contentType: "text/html",
};

describe("AiAssistantPanel", () => {
  it("sanitises contextual URLs before a request snapshot is created", () => {
    const attachments = contextAttachments(
      context,
      {
        page: true,
        url: true,
        title: true,
        description: true,
        "selected-text": false,
        screenshot: false,
        element: false,
      },
      [],
    );

    expect(attachments.find((item) => item.kind === "url")?.data.url).toBe(
      "https://example.com/search",
    );
    expect(JSON.stringify(attachments)).not.toContain("token=secret");
  });

  it("renders context controls and an honest unavailable welcome state", () => {
    const markup = renderToStaticMarkup(
      <AiAssistantPanel
        activeTab={activeTab}
        aiTools={aiTools}
        close={vi.fn()}
        onOrganiseTabs={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(markup).toContain("Scout");
    expect(markup).toContain("Local AI unavailable");
    expect(markup).toContain("Ask Scout...");
    expect(markup).toContain('aria-label="Scout Power"');
    expect(markup).not.toContain("Chromecraft AI");
    expect(markup).toContain("Organise my tabs");
    expect(markup).toContain('id="sidebar-panel-title"');
    expect(markup).toContain('class="ai-composer-toolbar"');
    expect(markup).not.toContain("Allow this message");
    expect(markup.match(/class="ai-character /g)).toHaveLength(1);
    expect(markup.match(/class="ai-static-avatar/g)).toHaveLength(1);
    expect(markup).not.toContain("Ready for tab tools");
  });

  it("discloses Gemini data sharing without a per-message consent checkbox", () => {
    const markup = renderToStaticMarkup(
      <AiAssistantPanel
        activeTab={activeTab}
        aiTools={{
          ...aiTools,
          provider: "gemini",
          gemini: {
            ...aiTools.gemini,
            connection: "connected",
            apiKeyConfigured: true,
            models: [
              {
                name: "gemini-flash-lite-latest",
                displayName: "Flash-Lite",
                size: null,
                modifiedAt: null,
                family: "gemini",
                parameterSize: null,
              },
            ],
            selectedModel: "gemini-flash-lite-latest",
          },
        }}
        close={vi.fn()}
        onOrganiseTabs={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(markup).toContain("Ready · Gemini");
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).not.toContain("Allow this message");
  });
});
