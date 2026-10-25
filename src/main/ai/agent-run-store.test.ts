import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentRunSnapshot } from "../../shared/agent";
import { JsonAgentRunStore } from "./agent-run-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function run(): AgentRunSnapshot {
  return {
    id: "run",
    conversationId: "conversation",
    messageId: "message",
    objective: "Research",
    permissionMode: "ask",
    provider: "ollama",
    model: "qwen",
    status: "paused",
    statusLabel: "Research paused",
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    events: [],
    sources: [
      {
        id: "source",
        title: "Example",
        url: "https://example.test/",
        hostname: "example.test",
        faviconDataUrl: `data:image/png;base64,${"a".repeat(40_000)}`,
        capturedAt: 1,
        complete: false,
        observationTypes: ["metadata"],
      },
    ],
    pendingApproval: null,
    queuedMessages: [{ id: "queued", text: "Focus on price", createdAt: 2 }],
    finalText: null,
    error: null,
  };
}

describe("JsonAgentRunStore", () => {
  it("persists queued guidance while bounding favicon data", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "chromecraft-agent-"),
    );
    temporaryDirectories.push(directory);
    const store = new JsonAgentRunStore(path.join(directory, "runs.json"));
    await store.save([run()]);

    const loaded = await store.load();
    expect(loaded[0]?.queuedMessages).toEqual([
      { id: "queued", text: "Focus on price", createdAt: 2 },
    ]);
    expect(loaded[0]?.sources[0]?.faviconDataUrl).toBeNull();
    expect(
      (await fs.stat(path.join(directory, "runs.json"))).size,
    ).toBeLessThan(2 * 1024 * 1024);
  });
});
