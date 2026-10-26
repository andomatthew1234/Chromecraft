import { describe, expect, it } from "vitest";

import type { StructuredGenerationRequest } from "./structured-provider";
import { StructuredAgentModelAdapter } from "./agent-model-adapter";

describe("StructuredAgentModelAdapter", () => {
  it("binds each tool ID to that tool's actual input schema", async () => {
    let request: StructuredGenerationRequest | null = null;
    const adapter = new StructuredAgentModelAdapter(
      {
        listModels: async () => [],
        chatStructured: async (value) => {
          request = value;
          return { reply: "Done", toolCalls: [] };
        },
      },
      "test-model",
      false,
    );

    await adapter.turn({
      objective: "Compare two pages",
      initialContext: "",
      tools: [
        {
          id: "list_tabs",
          description: "List tabs",
          capability: "browser.tabs.observe",
          effect: "observe",
          inputSchema: { type: "object", additionalProperties: false },
        },
        {
          id: "read_page_excerpt",
          description: "Read a page",
          capability: "browser.tabs.observe",
          effect: "observe",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { tabRef: { type: "string" } },
            required: ["tabRef"],
          },
        },
      ],
      transcript: [],
      queuedMessages: [],
      images: [],
      sources: [],
      signal: new AbortController().signal,
    });

    const properties = request!.schema.properties as Record<string, unknown>;
    const toolCalls = properties.toolCalls as Record<string, unknown>;
    const items = toolCalls.items as Record<string, unknown>;
    const branches = items.anyOf as Array<Record<string, unknown>>;
    const readBranch = branches.find((branch) => {
      const branchProperties = branch.properties as Record<string, unknown>;
      const id = branchProperties.id as { enum: string[] };
      return id.enum[0] === "read_page_excerpt";
    });
    const readProperties = readBranch!.properties as Record<string, unknown>;
    const input = readProperties.input as Record<string, unknown>;
    const inputProperties = input.properties as Record<string, unknown>;

    expect(branches).toHaveLength(2);
    expect(inputProperties.tabRef).toEqual({ type: "string" });
    expect(input.required).toContain("tabRef");
    expect(input.additionalProperties).toBe(false);
    expect(request!.system).toContain(
      "Use browser research tools only when the objective requires browser evidence",
    );
    expect(request!.system).toContain(
      "answer directly with an empty toolCalls array",
    );
  });
});
