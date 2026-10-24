import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  OrganiseTabsProposal,
  OrganiseTabsRequest,
} from "../../shared/ai-tools";
import type { AssistantMessageRequest } from "../../shared/ai-assistant";
import type { SmartReaderArticle } from "../../shared/smart-reader";
import { AiToolsController } from "./controller";
import type { GeminiCredentialStore } from "./gemini-credential-store";
import type { OllamaClient } from "./ollama-client";
import type {
  InternalOrganiseTabsProposal,
  OrganiseTabsTool,
} from "./organise-tabs-tool";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function statePath() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chromecraft-ai-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "ai-tools.json");
}

function proposal(
  provider: "ollama" | "gemini" | "website" = "ollama",
): OrganiseTabsProposal {
  return {
    id: "proposal-1",
    toolId: "organise-tabs",
    provider,
    model: provider === "website" ? "By website" : "qwen3:1.7b",
    createdAt: 1,
    groups: [],
    ungroupedTabIds: ["a", "b"],
    ungroupedTabTitles: ["A", "B"],
    ungroupedTabFavicons: [null, null],
    preservedTabCount: 0,
    summary: "Leave two tabs ungrouped.",
    warnings: [],
  };
}

function credentials(apiKey: string | null = null) {
  let current = apiKey;
  return {
    secureStorageAvailable: true,
    get: vi.fn(async () => current),
    set: vi.fn(async (key: string) => {
      current = key;
    }),
    remove: vi.fn(async () => {
      current = null;
    }),
  } as unknown as GeminiCredentialStore;
}

function organiser() {
  const prepared: InternalOrganiseTabsProposal = {
    publicProposal: proposal(),
    revision: "revision-1",
    context: {
      revision: "revision-1",
      candidates: [],
      preservedTabIds: [],
    },
    replacesAppliedLayout: false,
  };
  return {
    eligibleTabCount: 2,
    cloudDataPreview: [
      { title: "A", hostname: "a.example" },
      { title: "B", hostname: "b.example" },
    ],
    preview: vi.fn(async (request: OrganiseTabsRequest) => ({
      ...prepared,
      publicProposal: proposal(
        request.groupingMode === "website" ? "website" : request.provider,
      ),
    })),
    apply: vi.fn(async () => ({
      toolId: "organise-tabs" as const,
      summary: "Organised tabs.",
      organisedTabCount: 2,
      groupCount: 0,
      undoAvailable: true,
    })),
    undo: vi.fn(async () => ({
      toolId: "organise-tabs" as const,
      summary: "Restored tabs.",
      organisedTabCount: 2,
      groupCount: 0,
      undoAvailable: false,
    })),
    isUndoRetryable: vi.fn(() => true),
  } as unknown as OrganiseTabsTool;
}

function request(
  overrides: Partial<OrganiseTabsRequest> = {},
): OrganiseTabsRequest {
  return {
    provider: "ollama",
    model: "qwen3:1.7b",
    groupingMode: "smart",
    customInstructions: "",
    rememberCustomInstructions: false,
    cloudConsent: false,
    ...overrides,
  };
}

function assistantRequest(
  overrides: Partial<AssistantMessageRequest> = {},
): AssistantMessageRequest {
  return {
    conversationId: "conversation-1",
    messageId: "message-1",
    prompt: "Explain this page",
    createdAt: 1,
    provider: "ollama",
    model: "qwen3:1.7b",
    context: [
      {
        id: "title-1",
        kind: "title",
        label: "Page title",
        detail: "Example",
        createdAt: 1,
        data: { title: "Example" },
      },
    ],
    history: [{ role: "user", text: "Earlier question" }],
    ...overrides,
  };
}

function readerArticle(): SmartReaderArticle {
  return {
    title: "Verified launch report",
    byline: "Ada Reporter",
    publishedTime: "2026-10-24",
    siteName: "Example News",
    excerpt: null,
    content: "<p>The launch reached 42 participants.</p>",
    textContent: "The launch reached 42 participants.",
    headings: ["Launch results"],
    textLength: 35,
    sourceUrl: "https://example.com/launch",
  };
}

describe("AiToolsController", () => {
  it("restores the last provider and independent model choices", async () => {
    const file = await statePath();
    await writeFile(
      file,
      JSON.stringify({
        provider: "gemini",
        preferredGroupingMode: "smart",
        ollamaModel: "qwen3:1.7b",
        geminiModel: "gemini-flash-lite-latest",
        cloudConsentGranted: true,
      }),
    );
    const controller = new AiToolsController({
      stateFilePath: file,
      ollama: { listModels: vi.fn() } as unknown as OllamaClient,
      credentials: credentials("secret"),
      organiseTabs: organiser(),
    });

    await controller.initialize();

    expect(controller.snapshot).toMatchObject({
      provider: "gemini",
      organiserProvider: "gemini",
      organiserModels: {
        ollama: "qwen3:1.7b",
        gemini: "gemini-flash-lite-latest",
      },
      preferredGroupingMode: "smart",
      ollama: { selectedModel: "qwen3:1.7b" },
      gemini: {
        selectedModel: "gemini-flash-lite-latest",
        cloudConsentGranted: true,
      },
    });
  });

  it("persists organiser models independently from Scout conversation models", async () => {
    const file = await statePath();
    const controller = new AiToolsController({
      stateFilePath: file,
      ollama: {
        listModels: vi.fn().mockResolvedValue([
          {
            name: "qwen3:1.7b",
            size: 1_000,
            modifiedAt: null,
            family: "qwen3",
            parameterSize: "1.7B",
          },
          {
            name: "qwen3:4b",
            size: 2_000,
            modifiedAt: null,
            family: "qwen3",
            parameterSize: "4B",
          },
        ]),
      } as unknown as OllamaClient,
      credentials: credentials(),
      organiseTabs: organiser(),
    });

    await controller.refreshModels("ollama");
    await controller.setModel("ollama", "qwen3:4b");
    await controller.setOrganiserModel("ollama", "qwen3:1.7b");
    await controller.setOrganiserProvider("ollama");

    expect(controller.snapshot.ollama.selectedModel).toBe("qwen3:4b");
    expect(controller.snapshot.organiserModels.ollama).toBe("qwen3:1.7b");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      provider: "ollama",
      organiserProvider: "ollama",
      ollamaModel: "qwen3:4b",
      organiserOllamaModel: "qwen3:1.7b",
    });

    const restarted = new AiToolsController({
      stateFilePath: file,
      ollama: { listModels: vi.fn() } as unknown as OllamaClient,
      credentials: credentials(),
      organiseTabs: organiser(),
    });
    await restarted.initialize();
    expect(restarted.snapshot).toMatchObject({
      provider: "ollama",
      organiserProvider: "ollama",
      ollama: { selectedModel: "qwen3:4b" },
      organiserModels: { ollama: "qwen3:1.7b" },
    });
  });

  it("does no inference on initialise and recommends a small Ollama model", async () => {
    const file = await statePath();
    const ollama = {
      listModels: vi.fn().mockResolvedValue([
        {
          name: "gemma4:26b",
          size: 18_600_000_000,
          modifiedAt: null,
          family: "gemma",
          parameterSize: "26B",
        },
        {
          name: "qwen3:1.7b",
          size: 1_100_000_000,
          modifiedAt: null,
          family: "qwen3",
          parameterSize: "1.7B",
        },
      ]),
      chatStructured: vi.fn(),
    } as unknown as OllamaClient;
    const tabs = organiser();
    const controller = new AiToolsController({
      stateFilePath: file,
      ollama,
      credentials: credentials(),
      organiseTabs: tabs,
    });

    await controller.initialize();
    expect(ollama.listModels).not.toHaveBeenCalled();
    expect(
      (ollama as unknown as { chatStructured: ReturnType<typeof vi.fn> })
        .chatStructured,
    ).not.toHaveBeenCalled();

    await controller.refreshModels("ollama");
    expect(controller.snapshot.ollama.selectedModel).toBe("qwen3:1.7b");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      provider: "ollama",
      ollamaModel: "qwen3:1.7b",
    });
  });

  it("runs website grouping without a model or Gemini credential", async () => {
    const tabs = organiser();
    const controller = new AiToolsController({
      stateFilePath: await statePath(),
      ollama: { listModels: vi.fn() } as unknown as OllamaClient,
      credentials: credentials(),
      organiseTabs: tabs,
    });

    const result = await controller.preview(
      request({ provider: "gemini", groupingMode: "website", model: "" }),
    );

    expect(result.provider).toBe("website");
    expect(controller.snapshot.run.stage).toBe("ready");
    expect(
      (tabs as unknown as { preview: ReturnType<typeof vi.fn> }).preview,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ groupingMode: "website" }),
      null,
      expect.any(AbortSignal),
    );
  });

  it("applies only a prepared proposal and keeps undo available", async () => {
    const tabs = organiser();
    const controller = new AiToolsController({
      stateFilePath: await statePath(),
      ollama: {
        listModels: vi.fn().mockResolvedValue([
          {
            name: "qwen3:1.7b",
            size: 1,
            modifiedAt: null,
            family: "qwen3",
            parameterSize: "1.7B",
          },
        ]),
        chatStructured: vi.fn(),
      } as unknown as OllamaClient,
      credentials: credentials(),
      organiseTabs: tabs,
    });
    await controller.refreshModels("ollama");
    const prepared = await controller.preview(request());

    await expect(
      controller.apply({ ...prepared, summary: "Edited plan" }),
    ).resolves.toMatchObject({
      undoAvailable: true,
    });
    expect(controller.snapshot.run).toMatchObject({
      stage: "complete",
      undoAvailable: true,
    });
    await expect(controller.undo()).resolves.toMatchObject({
      undoAvailable: false,
    });
    expect(controller.snapshot.run.undoAvailable).toBe(false);
  });

  it("sanitises an unreachable Ollama error for the renderer", async () => {
    const controller = new AiToolsController({
      stateFilePath: await statePath(),
      ollama: {
        listModels: vi
          .fn()
          .mockRejectedValue(new Error("connect ECONNREFUSED secret")),
      } as unknown as OllamaClient,
      credentials: credentials(),
      organiseTabs: organiser(),
    });

    const snapshot = await controller.refreshModels("ollama");
    expect(snapshot.ollama.connection).toBe("unavailable");
    expect(snapshot.ollama.error).toContain("Start Ollama");
    expect(snapshot.ollama.error).not.toContain("secret");
  });

  it("uses the exact Scout model and returns a real assistant response", async () => {
    const chatStructured = vi.fn().mockResolvedValue({
      reply: "This page is an example.",
    });
    const controller = new AiToolsController({
      stateFilePath: await statePath(),
      ollama: {
        listModels: vi.fn().mockResolvedValue([
          {
            name: "qwen3:1.7b",
            size: 1_000,
            modifiedAt: null,
            family: "qwen3",
            parameterSize: "1.7B",
          },
        ]),
        chatStructured,
      } as unknown as OllamaClient,
      credentials: credentials(),
      organiseTabs: organiser(),
    });
    await controller.refreshModels("ollama");

    await expect(
      controller.sendAssistantMessage(assistantRequest()),
    ).resolves.toMatchObject({
      messageId: "message-1",
      provider: "ollama",
      model: "qwen3:1.7b",
      text: "This page is an example.",
    });
    expect(chatStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "qwen3:1.7b",
        prompt: expect.stringContaining("Page title: Example"),
        schema: expect.objectContaining({ type: "object" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(chatStructured.mock.calls[0]?.[0].prompt).toContain(
      "Earlier question",
    );
    expect(controller.snapshot.run.stage).toBe("idle");
  });

  it("cancels only the matching Scout message", async () => {
    const chatStructured = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    const controller = new AiToolsController({
      stateFilePath: await statePath(),
      ollama: {
        listModels: vi.fn().mockResolvedValue([
          {
            name: "qwen3:1.7b",
            size: 1_000,
            modifiedAt: null,
            family: "qwen3",
            parameterSize: "1.7B",
          },
        ]),
        chatStructured,
      } as unknown as OllamaClient,
      credentials: credentials(),
      organiseTabs: organiser(),
    });
    await controller.refreshModels("ollama");

    const response = controller.sendAssistantMessage(assistantRequest());
    await vi.waitFor(() => expect(chatStructured).toHaveBeenCalledOnce());
    controller.cancelAssistantMessage("another-message");
    expect(chatStructured.mock.calls[0]?.[0].signal.aborted).toBe(false);
    controller.cancelAssistantMessage("message-1");

    await expect(response).rejects.toThrow("stopped this response");
  });

  it("preserves an organiser undo across Scout model changes and chat", async () => {
    const tabs = organiser();
    const controller = new AiToolsController({
      stateFilePath: await statePath(),
      ollama: {
        listModels: vi.fn().mockResolvedValue([
          {
            name: "qwen3:1.7b",
            size: 1_000,
            modifiedAt: null,
            family: "qwen3",
            parameterSize: "1.7B",
          },
        ]),
        chatStructured: vi.fn().mockResolvedValue({ reply: "Done." }),
      } as unknown as OllamaClient,
      credentials: credentials(),
      organiseTabs: tabs,
    });
    await controller.refreshModels("ollama");
    const prepared = await controller.preview(request());
    await controller.apply(prepared);

    await controller.setProvider("ollama");
    await controller.setModel("ollama", "qwen3:1.7b");
    await controller.refreshModels("ollama");
    await controller.sendAssistantMessage(assistantRequest());

    expect(controller.snapshot.run).toMatchObject({
      stage: "complete",
      undoAvailable: true,
    });
    await expect(controller.undo()).resolves.toMatchObject({
      undoAvailable: false,
    });
  });

  it("does not leak raw provider failures through Scout errors", async () => {
    const controller = new AiToolsController({
      stateFilePath: await statePath(),
      ollama: {
        listModels: vi.fn().mockResolvedValue([
          {
            name: "qwen3:1.7b",
            size: 1_000,
            modifiedAt: null,
            family: "qwen3",
            parameterSize: "1.7B",
          },
        ]),
        chatStructured: vi
          .fn()
          .mockRejectedValue(new Error("ECONNREFUSED secret-token")),
      } as unknown as OllamaClient,
      credentials: credentials(),
      organiseTabs: organiser(),
    });
    await controller.refreshModels("ollama");

    await expect(
      controller.sendAssistantMessage(assistantRequest()),
    ).rejects.toThrow("Scout could not reach Ollama");
    expect(JSON.stringify(controller.snapshot)).not.toContain("secret-token");
  });

  it("summarises Reader content with the exact selected local model", async () => {
    const file = await statePath();
    const chatStructured = vi.fn().mockResolvedValue({
      points: [
        "The launch reached 42 participants.",
        "Ada Reporter documented the result.",
        "The report was published by Example News.",
      ],
    });
    const controller = new AiToolsController({
      stateFilePath: file,
      ollama: {
        listModels: vi.fn().mockResolvedValue([
          {
            name: "qwen3:4b",
            size: 2_000,
            modifiedAt: null,
            family: "qwen3",
            parameterSize: "4B",
          },
        ]),
        chatStructured,
      } as unknown as OllamaClient,
      credentials: credentials(),
      organiseTabs: organiser(),
    });
    await controller.refreshModels("ollama");
    await controller.setSmartReaderSummaryPreference("ollama", "qwen3:4b");

    await expect(
      controller.summarizeSmartReaderArticle(
        "summary-1",
        readerArticle(),
        "ollama",
        "qwen3:4b",
        false,
      ),
    ).resolves.toMatchObject({
      provider: "ollama",
      model: "qwen3:4b",
      coverage: "full",
    });
    expect(chatStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "qwen3:4b",
        prompt: expect.stringContaining("42 participants"),
      }),
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      summaryProvider: "ollama",
      summaryOllamaModel: "qwen3:4b",
    });
  });

  it("requires separate article consent before Gemini summarisation", async () => {
    const file = await statePath();
    await writeFile(
      file,
      JSON.stringify({
        provider: "gemini",
        geminiModel: "gemini-flash-latest",
        summaryProvider: "gemini",
        summaryGeminiModel: "gemini-flash-latest",
        cloudConsentGranted: true,
      }),
    );
    const controller = new AiToolsController({
      stateFilePath: file,
      ollama: { listModels: vi.fn() } as unknown as OllamaClient,
      credentials: credentials("secret"),
      organiseTabs: organiser(),
    });
    await controller.initialize();
    expect(
      controller.getSmartReaderSummaryConfiguration().providers.gemini
        .cloudConsentGranted,
    ).toBe(false);
  });

  it("summarises with configured Gemini only after explicit article consent", async () => {
    const file = await statePath();
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("pageSize=1")) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      points: ["Gemini point one", "Point two", "Point three"],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", request);
    const controller = new AiToolsController({
      stateFilePath: file,
      ollama: { listModels: vi.fn() } as unknown as OllamaClient,
      credentials: credentials("secret"),
      organiseTabs: organiser(),
    });
    await controller.initialize();
    await controller.refreshModels("gemini");

    await expect(
      controller.summarizeSmartReaderArticle(
        "summary-gemini",
        readerArticle(),
        "gemini",
        "gemini-flash-latest",
        true,
      ),
    ).resolves.toMatchObject({
      provider: "gemini",
      model: "gemini-flash-latest",
      points: ["Gemini point one", "Point two", "Point three"],
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      summaryCloudConsentGranted: true,
      summaryProvider: "gemini",
      summaryGeminiModel: "gemini-flash-latest",
    });
  });
});
