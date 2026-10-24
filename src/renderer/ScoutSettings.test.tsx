import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AiToolsSnapshot } from "../shared/ai-tools";
import { ScoutSettings } from "./ScoutSettings";

const snapshot: AiToolsSnapshot = {
  provider: "ollama",
  organiserProvider: "gemini",
  organiserModels: {
    ollama: "qwen3:1.7b",
    gemini: "gemini-flash-lite-latest",
  },
  preferredGroupingMode: "smart",
  eligibleTabCount: 4,
  cloudDataPreview: [],
  ollama: {
    endpoint: "http://127.0.0.1:11434",
    connection: "connected",
    selectedModel: "qwen3:4b",
    error: null,
    models: [
      {
        name: "qwen3:1.7b",
        displayName: "Qwen 3 1.7B",
        size: 1_100_000_000,
        modifiedAt: null,
        family: "qwen3",
        parameterSize: "1.7B",
        recommended: true,
      },
      {
        name: "qwen3:4b",
        displayName: "Qwen 3 4B",
        size: 2_600_000_000,
        modifiedAt: null,
        family: "qwen3",
        parameterSize: "4B",
      },
    ],
  },
  gemini: {
    connection: "connected",
    selectedModel: "gemini-flash-lite-latest",
    error: null,
    apiKeyConfigured: true,
    secureStorageAvailable: true,
    sessionOnly: false,
    cloudConsentGranted: false,
    models: [
      {
        name: "gemini-flash-lite-latest",
        displayName: "Flash-Lite",
        size: null,
        modifiedAt: null,
        family: "Gemini",
        parameterSize: null,
        recommended: true,
      },
    ],
  },
  run: {
    operationId: null,
    toolId: null,
    stage: "idle",
    label: "Ready",
    error: null,
    proposalId: null,
    undoAvailable: false,
  },
  endpoint: "http://127.0.0.1:11434",
  connection: "connected",
  models: [],
  selectedModel: "qwen3:4b",
  error: null,
};

describe("ScoutSettings", () => {
  it("renders a compact three-destination homepage", () => {
    const html = renderToStaticMarkup(
      <ScoutSettings aiTools={snapshot} highlightedSettingId={null} />,
    );

    expect(html).toContain("AI providers");
    expect(html).toContain("Models &amp; performance");
    expect(html).toContain("Privacy &amp; context");
    expect(html).not.toContain("Paste your API key");
  });

  it("deep-links search and sidebar requests to the Gemini provider page", () => {
    const html = renderToStaticMarkup(
      <ScoutSettings
        aiTools={snapshot}
        highlightedSettingId="gemini-api-key"
      />,
    );

    expect(html).toContain("Google Gemini");
    expect(html).toContain("Connected");
    expect(html).toContain("Replace key");
    expect(html).toContain("Remove key");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("secret");
  });

  it("shows independent Scout and organiser model controls", () => {
    const html = renderToStaticMarkup(
      <ScoutSettings
        aiTools={snapshot}
        highlightedSettingId="tab-organiser-model"
      />,
    );

    expect(html).toContain("Scout conversation model");
    expect(html).toContain("Ollama organiser model");
    expect(html).toContain("Gemini organiser model");
    expect(html).toContain(
      "does not change Scout&#x27;s active conversation model",
    );
    expect(html).not.toContain("<select");
  });
});
