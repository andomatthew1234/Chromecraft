import { describe, expect, it, vi } from "vitest";

import {
  AiTabOrganizationUndoUnavailableError,
  type TabManager,
} from "../tab-manager";
import type { OllamaClient } from "./ollama-client";
import { OrganiseTabsTool } from "./organise-tabs-tool";

function setup(response: unknown) {
  const applyAiTabOrganization = vi.fn().mockResolvedValue({
    undoToken: "undo-1",
    organisedTabCount: 3,
    groupCount: 1,
  });
  const undoAiTabOrganization = vi.fn().mockResolvedValue({
    undoToken: "",
    organisedTabCount: 3,
    groupCount: 1,
  });
  const tabs = {
    getAiTabOrganizationContext: () => ({
      revision: "revision-1",
      candidates: [
        {
          id: "alpha",
          title: "Alpha docs",
          hostname: "alpha.example",
          pathHint: "/docs",
        },
        {
          id: "beta",
          title: "Beta docs",
          hostname: "beta.example",
          pathHint: "/guide",
        },
        {
          id: "mail",
          title: "Mail",
          hostname: "mail.example",
          pathHint: "/inbox",
        },
      ],
      preservedTabIds: ["pinned"],
    }),
    applyAiTabOrganization,
    undoAiTabOrganization,
  } as unknown as TabManager;
  const chatStructured = vi.fn().mockResolvedValue(response);
  const ollama = { chatStructured } as unknown as OllamaClient;
  return {
    tool: new OrganiseTabsTool(tabs),
    ollama,
    chatStructured,
    applyAiTabOrganization,
    undoAiTabOrganization,
  };
}

describe("OrganiseTabsTool", () => {
  it("maps opaque aliases into a reviewable plan and applies only that plan", async () => {
    const harness = setup({
      groups: [{ name: "Research", color: "purple", tabKeys: ["t1", "t2"] }],
      ungroupedTabKeys: ["t3"],
    });

    const prepared = await harness.tool.preview(
      "qwen3:4b",
      harness.ollama,
      new AbortController().signal,
    );

    expect(prepared.publicProposal.groups[0]).toMatchObject({
      name: "Research",
      color: "purple",
      tabIds: ["alpha", "beta"],
      tabTitles: ["Alpha docs", "Beta docs"],
    });
    expect(prepared.publicProposal.ungroupedTabIds).toEqual(["mail"]);
    expect(prepared.publicProposal.warnings[0]).toContain("protected");
    const call = harness.chatStructured.mock.calls[0][0];
    expect(call.prompt).not.toContain('"id":"alpha"');
    expect(call.prompt).toContain('"key":"t1"');
    expect(call.prompt).not.toContain("currentGroup");

    const result = await harness.tool.apply(prepared);
    expect(result.undoAvailable).toBe(true);
    expect(harness.applyAiTabOrganization).toHaveBeenCalledWith({
      revision: "revision-1",
      groups: [
        { name: "Research", color: "purple", tabIds: ["alpha", "beta"] },
      ],
      ungroupedTabIds: ["mail"],
    });
  });

  it("rejects duplicate or invented model tab references", async () => {
    const harness = setup({
      groups: [{ name: "Bad", color: "blue", tabKeys: ["t1", "t1"] }],
      ungroupedTabKeys: ["t2", "t3"],
    });

    await expect(
      harness.tool.preview(
        "qwen3:4b",
        harness.ollama,
        new AbortController().signal,
      ),
    ).rejects.toThrow("duplicated or invented");
    expect(harness.applyAiTabOrganization).not.toHaveBeenCalled();
  });

  it("keeps a one-shot undo token inside the tool", async () => {
    const harness = setup({
      groups: [{ name: "Research", color: "green", tabKeys: ["t1", "t2"] }],
      ungroupedTabKeys: ["t3"],
    });
    const prepared = await harness.tool.preview(
      "qwen3:4b",
      harness.ollama,
      new AbortController().signal,
    );
    await harness.tool.apply(prepared);

    await expect(harness.tool.undo()).resolves.toMatchObject({
      undoAvailable: false,
    });
    expect(harness.undoAiTabOrganization).toHaveBeenCalledWith("undo-1");
    await expect(harness.tool.undo()).rejects.toThrow("no AI tab organisation");
  });

  it("only retries undo failures that can still succeed", () => {
    const harness = setup({ groups: [], ungroupedTabKeys: [] });

    expect(
      harness.tool.isUndoRetryable(new Error("temporary disk error")),
    ).toBe(true);
    expect(
      harness.tool.isUndoRetryable(
        new AiTabOrganizationUndoUnavailableError("tabs changed"),
      ),
    ).toBe(false);
  });
});
