import { describe, expect, it, vi } from "vitest";

import type { OrganiseTabsRequest } from "../../shared/ai-tools";
import {
  AiTabOrganizationUndoUnavailableError,
  type TabManager,
} from "../tab-manager";
import type { StructuredModelProvider } from "./structured-provider";
import {
  normaliseWebsiteHostname,
  OrganiseTabsTool,
} from "./organise-tabs-tool";

const smartRequest: OrganiseTabsRequest = {
  provider: "ollama",
  model: "qwen3:1.7b",
  groupingMode: "smart",
  customInstructions: "Keep research together",
  rememberCustomInstructions: false,
  cloudConsent: false,
};

function setup(responses: unknown[]) {
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
          hostname: "docs.example",
          pathHint: "/docs",
        },
        {
          id: "beta",
          title: "Beta docs",
          hostname: "docs.example",
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
  const chatStructured = vi.fn();
  for (const response of responses)
    chatStructured.mockResolvedValueOnce(response);
  const provider = { chatStructured } as unknown as StructuredModelProvider;
  return {
    tool: new OrganiseTabsTool(tabs),
    provider,
    chatStructured,
    applyAiTabOrganization,
    undoAiTabOrganization,
  };
}

describe("OrganiseTabsTool", () => {
  it.each([2, 6, 20, 50])(
    "validates a complete model plan for %i tabs",
    async (count) => {
      const candidates = Array.from({ length: count }, (_, index) => ({
        id: `tab-${index + 1}`,
        title: `Tab ${index + 1}`,
        hostname: `${index % 5}.example`,
        pathHint: "/",
      }));
      const tabs = {
        getAiTabOrganizationContext: () => ({
          revision: "scale-test",
          candidates,
          preservedTabIds: [],
        }),
      } as unknown as TabManager;
      const groupedCount = count - (count % 2);
      const response = {
        groups: Array.from({ length: groupedCount / 2 }, (_, groupIndex) => ({
          name: `Group ${groupIndex + 1}`,
          tabIds: [`t${groupIndex * 2 + 1}`, `t${groupIndex * 2 + 2}`],
        })),
        ungroupedTabIds: count % 2 ? [`t${count}`] : [],
      };
      const provider = {
        chatStructured: vi.fn().mockResolvedValue(response),
      } as unknown as StructuredModelProvider;

      const prepared = await new OrganiseTabsTool(tabs).preview(
        smartRequest,
        provider,
        new AbortController().signal,
      );

      const included =
        prepared.publicProposal.groups.reduce(
          (total, group) => total + group.tabIds.length,
          0,
        ) + prepared.publicProposal.ungroupedTabIds.length;
      expect(included).toBe(count);
      const schema = (
        provider as unknown as { chatStructured: ReturnType<typeof vi.fn> }
      ).chatStructured.mock.calls[0][0].schema;
      expect(JSON.stringify(schema)).not.toMatch(
        /minItems|maxItems|minLength|maxLength/u,
      );
    },
  );

  it("sends only temporary IDs, titles and hostnames and applies the approved plan", async () => {
    const harness = setup([
      {
        groups: [{ name: "Research", tabIds: ["t1", "t2"] }],
        ungroupedTabIds: ["t3"],
      },
    ]);

    const prepared = await harness.tool.preview(
      smartRequest,
      harness.provider,
      new AbortController().signal,
    );

    expect(prepared.publicProposal.groups[0]).toMatchObject({
      name: "Research",
      color: "blue",
      tabIds: ["alpha", "beta"],
      tabTitles: ["Alpha docs", "Beta docs"],
    });
    expect(prepared.publicProposal.ungroupedTabIds).toEqual(["mail"]);
    const call = harness.chatStructured.mock.calls[0][0];
    expect(call.prompt).not.toContain('"id":"alpha"');
    expect(call.prompt).not.toContain("/docs");
    expect(call.prompt).toContain('"id":"t1"');
    expect(call.prompt).toContain('"hostname":"docs.example"');

    const result = await harness.tool.apply(prepared, prepared.publicProposal);
    expect(result.undoAvailable).toBe(true);
    expect(harness.applyAiTabOrganization).toHaveBeenCalledWith({
      revision: "revision-1",
      groups: [{ name: "Research", color: "blue", tabIds: ["alpha", "beta"] }],
      ungroupedTabIds: ["mail"],
    });
  });

  it("retries one invalid model plan and accepts a repaired response", async () => {
    const harness = setup([
      {
        groups: [{ name: "Bad", tabIds: ["t1", "t1"] }],
        ungroupedTabIds: ["t2", "t3"],
      },
      {
        groups: [{ name: "Research", tabIds: ["t1", "t2"] }],
        ungroupedTabIds: ["t3"],
      },
    ]);

    await expect(
      harness.tool.preview(
        smartRequest,
        harness.provider,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      publicProposal: { groups: [{ name: "Research" }] },
    });
    expect(harness.chatStructured).toHaveBeenCalledTimes(2);
  });

  it("rejects a second invalid response and never mutates tabs", async () => {
    const invalid = {
      groups: [{ name: "Bad", tabIds: ["t1", "t1"] }],
      ungroupedTabIds: ["t2", "t3"],
    };
    const harness = setup([invalid, invalid]);

    await expect(
      harness.tool.preview(
        smartRequest,
        harness.provider,
        new AbortController().signal,
      ),
    ).rejects.toThrow("duplicated or invented");
    expect(harness.applyAiTabOrganization).not.toHaveBeenCalled();
  });

  it("groups matching hostnames locally without invoking a provider", async () => {
    const harness = setup([]);
    const prepared = await harness.tool.preview(
      { ...smartRequest, groupingMode: "website", model: "" },
      null,
      new AbortController().signal,
    );

    expect(prepared.publicProposal.provider).toBe("website");
    expect(prepared.publicProposal.groups[0].tabIds).toEqual(["alpha", "beta"]);
    expect(prepared.publicProposal.ungroupedTabIds).toEqual(["mail"]);
    expect(harness.chatStructured).not.toHaveBeenCalled();
  });

  it("normalises common mobile and www website hostnames", () => {
    expect(normaliseWebsiteHostname("WWW.Example.com.")).toBe("example.com");
    expect(normaliseWebsiteHostname("m.example.com")).toBe("example.com");
    expect(normaliseWebsiteHostname("mobile.example.com")).toBe("example.com");
  });

  it("regenerates from the original snapshot and preserves the original undo", async () => {
    const harness = setup([
      {
        groups: [{ name: "Research", tabIds: ["t1", "t2"] }],
        ungroupedTabIds: ["t3"],
      },
      {
        groups: [{ name: "Inbox", tabIds: ["t2", "t3"] }],
        ungroupedTabIds: ["t1"],
      },
    ]);
    const first = await harness.tool.preview(
      smartRequest,
      harness.provider,
      new AbortController().signal,
    );
    await harness.tool.apply(first, first.publicProposal);

    const replacement = await harness.tool.preview(
      { ...smartRequest, reuseOriginalSnapshot: true },
      harness.provider,
      new AbortController().signal,
    );
    await harness.tool.apply(replacement, replacement.publicProposal);

    expect(replacement.publicProposal.groups[0].tabIds).toEqual([
      "beta",
      "mail",
    ]);
    expect(harness.applyAiTabOrganization).toHaveBeenLastCalledWith(
      expect.objectContaining({
        groups: [{ name: "Inbox", color: "blue", tabIds: ["beta", "mail"] }],
      }),
      "undo-1",
    );
  });

  it("keeps a one-shot undo token and classifies topology failures", async () => {
    const harness = setup([
      {
        groups: [{ name: "Research", tabIds: ["t1", "t2"] }],
        ungroupedTabIds: ["t3"],
      },
    ]);
    const prepared = await harness.tool.preview(
      smartRequest,
      harness.provider,
      new AbortController().signal,
    );
    await harness.tool.apply(prepared, prepared.publicProposal);

    await expect(harness.tool.undo()).resolves.toMatchObject({
      undoAvailable: false,
    });
    expect(harness.undoAiTabOrganization).toHaveBeenCalledWith("undo-1");
    await expect(harness.tool.undo()).rejects.toThrow("no AI tab organisation");
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
