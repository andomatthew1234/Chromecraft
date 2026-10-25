import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptedAgentModelAdapter } from "./agent-model-adapter";
import type { BrowserResearchAdapter } from "./browser-research";
import { ScoutAgentController } from "./scout-agent-controller";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function browser(): BrowserResearchAdapter {
  return {
    listTabs: async () => [],
    inspectMetadata: async () => {
      throw new Error("No tabs");
    },
    readPageExcerpt: async () => {
      throw new Error("No tabs");
    },
    readReaderArticle: async () => {
      throw new Error("No tabs");
    },
    captureScreenshot: async () => {
      throw new Error("No tabs");
    },
    currentDocumentRevision: () => null,
    currentRevision: () => null,
    openTab: async () => undefined,
  };
}

describe("ScoutAgentController", () => {
  it("keeps Chat as the authoritative default and leaves unavailable modes unchanged", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "scout-controller-"),
    );
    temporaryDirectories.push(directory);
    const subject = new ScoutAgentController({
      settingsFilePath: path.join(directory, "settings.json"),
      runStorePath: path.join(directory, "runs.json"),
      models: {
        resolve: async () =>
          new ScriptedAgentModelAdapter([{ reply: "Done", toolCalls: [] }]),
      },
      browser: browser(),
    });
    await subject.initialize();
    expect(subject.snapshot.permissionMode).toBe("chat");
    await expect(
      subject.start({
        conversationId: "conversation",
        messageId: "message",
        objective: "Research",
        createdAt: Date.now(),
        provider: "ollama",
        model: "qwen",
        context: [],
        history: [],
        cloudConsent: false,
      }),
    ).rejects.toThrow(/Ask mode/u);

    await subject.command({ type: "set-mode", mode: "ask" });
    await expect(
      subject.command({ type: "set-mode", mode: "automated" }),
    ).rejects.toThrow(/coming soon/u);
    expect(subject.snapshot.permissionMode).toBe("ask");
    await subject.dispose();
  });

  it("requires and persists research-specific Gemini consent", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "scout-controller-"),
    );
    temporaryDirectories.push(directory);
    const options = {
      settingsFilePath: path.join(directory, "settings.json"),
      runStorePath: path.join(directory, "runs.json"),
      models: {
        resolve: async () =>
          new ScriptedAgentModelAdapter([
            { reply: "Grounded answer", toolCalls: [] },
          ]),
      },
      browser: browser(),
    };
    const subject = new ScoutAgentController(options);
    await subject.initialize();
    await subject.command({ type: "set-mode", mode: "ask" });
    const request = {
      conversationId: "conversation",
      messageId: "message",
      objective: "Research",
      createdAt: Date.now(),
      provider: "gemini" as const,
      model: "gemini-flash-latest",
      context: [],
      history: [],
      cloudConsent: false,
    };
    await expect(subject.start(request)).rejects.toThrow(/sent to Google/u);
    await subject.start({ ...request, cloudConsent: true });
    expect(subject.snapshot.researchCloudConsentGranted).toBe(true);
    await subject.dispose();

    const restored = new ScoutAgentController(options);
    await restored.initialize();
    expect(restored.snapshot.permissionMode).toBe("ask");
    expect(restored.snapshot.researchCloudConsentGranted).toBe(true);
    await restored.dispose();
  });
});
