import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrganiseTabsProposal } from "../../shared/ai-tools";
import { AiToolsController, type AiToolDefinition } from "./controller";
import type { OllamaClient } from "./ollama-client";

const temporaryDirectories: string[] = [];

afterEach(async () => {
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

function proposal(): OrganiseTabsProposal {
  return {
    id: "proposal-1",
    toolId: "organise-tabs",
    model: "qwen3:4b",
    createdAt: 1,
    groups: [],
    ungroupedTabIds: ["a", "b"],
    ungroupedTabTitles: ["A", "B"],
    preservedTabCount: 0,
    summary: "Leave two tabs ungrouped.",
    warnings: [],
  };
}

describe("AiToolsController", () => {
  it("discovers models, persists selection, and runs preview/apply/undo", async () => {
    const file = await statePath();
    const ollama = {
      listModels: vi.fn().mockResolvedValue([
        {
          name: "qwen3:4b",
          size: 1,
          modifiedAt: null,
          family: "qwen3",
          parameterSize: "4B",
        },
      ]),
    } as unknown as OllamaClient;
    const apply = vi.fn().mockResolvedValue({
      toolId: "organise-tabs",
      summary: "Organised tabs.",
      organisedTabCount: 2,
      groupCount: 0,
      undoAvailable: true,
    });
    const tool: AiToolDefinition = {
      id: "organise-tabs",
      preview: vi.fn().mockResolvedValue({ proposal: proposal(), apply }),
      undo: vi.fn().mockResolvedValue({
        toolId: "organise-tabs",
        summary: "Restored tabs.",
        organisedTabCount: 2,
        groupCount: 0,
        undoAvailable: false,
      }),
    };
    const controller = new AiToolsController({
      stateFilePath: file,
      ollama,
      tools: [tool],
    });

    await controller.initialize();
    await controller.refreshModels();
    expect(controller.snapshot).toMatchObject({
      connection: "connected",
      selectedModel: "qwen3:4b",
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      selectedModel: "qwen3:4b",
    });

    await expect(controller.preview("organise-tabs")).resolves.toMatchObject({
      id: "proposal-1",
    });
    expect(controller.snapshot.run.stage).toBe("ready");
    await controller.apply("proposal-1");
    expect(apply).toHaveBeenCalledOnce();
    expect(controller.snapshot.run).toMatchObject({
      stage: "complete",
      undoAvailable: true,
    });
    await controller.undo();
    expect(tool.undo).toHaveBeenCalledOnce();
    expect(controller.snapshot.run.undoAvailable).toBe(false);
  });

  it("reports an unreachable local Ollama instance without leaking the error", async () => {
    const controller = new AiToolsController({
      stateFilePath: await statePath(),
      ollama: {
        listModels: vi
          .fn()
          .mockRejectedValue(new Error("connect ECONNREFUSED")),
      } as unknown as OllamaClient,
      tools: [],
    });

    const snapshot = await controller.refreshModels();

    expect(snapshot.connection).toBe("unavailable");
    expect(snapshot.error).toContain("127.0.0.1:11434");
    expect(snapshot.error).not.toContain("ECONNREFUSED");
  });

  it("keeps Undo retryable after a transient persistence failure", async () => {
    const undo = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary disk error"))
      .mockResolvedValueOnce({
        toolId: "organise-tabs",
        summary: "Restored tabs.",
        organisedTabCount: 2,
        groupCount: 0,
        undoAvailable: false,
      });
    const tool: AiToolDefinition = {
      id: "organise-tabs",
      preview: vi.fn().mockResolvedValue({
        proposal: proposal(),
        apply: vi.fn().mockResolvedValue({
          toolId: "organise-tabs",
          summary: "Organised tabs.",
          organisedTabCount: 2,
          groupCount: 0,
          undoAvailable: true,
        }),
      }),
      undo,
    };
    const controller = new AiToolsController({
      stateFilePath: await statePath(),
      ollama: {
        listModels: vi.fn().mockResolvedValue([
          {
            name: "qwen3:4b",
            size: null,
            modifiedAt: null,
            family: null,
            parameterSize: null,
          },
        ]),
      } as unknown as OllamaClient,
      tools: [tool],
    });
    await controller.refreshModels();
    await controller.preview("organise-tabs");
    await controller.apply("proposal-1");

    await expect(controller.undo()).rejects.toThrow("temporary disk error");
    expect(controller.snapshot.run).toMatchObject({
      stage: "failed",
      undoAvailable: true,
    });
    await expect(controller.undo()).resolves.toMatchObject({
      summary: "Restored tabs.",
    });
    expect(undo).toHaveBeenCalledTimes(2);
  });

  it("removes Undo after a non-retryable topology failure", async () => {
    const undoError = new Error("tabs changed");
    const tool: AiToolDefinition = {
      id: "organise-tabs",
      preview: vi.fn().mockResolvedValue({
        proposal: proposal(),
        apply: vi.fn().mockResolvedValue({
          toolId: "organise-tabs",
          summary: "Organised tabs.",
          organisedTabCount: 2,
          groupCount: 0,
          undoAvailable: true,
        }),
      }),
      undo: vi.fn().mockRejectedValue(undoError),
      isUndoRetryable: (error) => error !== undoError,
    };
    const controller = new AiToolsController({
      stateFilePath: await statePath(),
      ollama: {
        listModels: vi.fn().mockResolvedValue([
          {
            name: "qwen3:4b",
            size: null,
            modifiedAt: null,
            family: null,
            parameterSize: null,
          },
        ]),
      } as unknown as OllamaClient,
      tools: [tool],
    });
    await controller.refreshModels();
    await controller.preview("organise-tabs");
    await controller.apply("proposal-1");

    await expect(controller.undo()).rejects.toThrow("tabs changed");
    expect(controller.snapshot.run).toMatchObject({
      stage: "failed",
      undoAvailable: false,
    });
    await expect(controller.undo()).rejects.toThrow("no AI action to undo");
  });
});
