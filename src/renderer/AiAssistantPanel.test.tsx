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
      />,
    );

    expect(markup).toContain("Chromecraft AI");
    expect(markup).toContain("AI unavailable");
    expect(markup).toContain("Ask Chromecraft AI...");
    expect(markup).toContain("Organise my tabs");
  });
});
