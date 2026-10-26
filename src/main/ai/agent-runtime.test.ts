import { describe, expect, it, vi } from "vitest";
import type { AgentRunSnapshot } from "../../shared/agent";

import { ScriptedAgentModelAdapter } from "./agent-model-adapter";
import { MemoryAgentRunStore } from "./agent-run-store";
import {
  AgentRuntime,
  AskModeApprovalPolicy,
  type AgentModelAdapter,
  type AgentRunInput,
  type AgentTool,
} from "./agent-runtime";

function input(): AgentRunInput {
  return {
    conversationId: "conversation-1",
    messageId: "message-1",
    objective: "Compare my open pages",
    createdAt: Date.now(),
    provider: "ollama",
    model: "test-model",
    context: [],
    history: [],
    cloudConsent: false,
    initialContext: "",
    initialImages: [],
  };
}

async function until(
  runtime: AgentRuntime,
  predicate: (status: string) => boolean,
): Promise<AgentRunSnapshot> {
  for (let index = 0; index < 100; index += 1) {
    const run = runtime.snapshot.runs[0];
    if (run && predicate(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for run: ${runtime.snapshot.runs[0]?.status}`,
  );
}

function observedTool(
  effect: "observe" | "local-change" = "observe",
): AgentTool {
  return {
    description: {
      id: "read_test",
      description: "Read a deterministic test source.",
      inputSchema: { type: "object" },
      capability: "test.observe",
      effect,
    },
    prepare: async (value) => ({
      input: value,
      action: "Read test source",
      target: "example.test",
      expectedEffect: "Read-only test observation",
      risk: "None",
      stateRevision: "1",
    }),
    execute: async () => ({
      modelResult: { untrustedPageText: "alpha" },
      eventLabel: "Read Example",
      eventType: "tab-inspected",
      source: {
        id: "source-1",
        title: "Example",
        url: "https://example.test/",
        hostname: "example.test",
        faviconDataUrl: null,
        capturedAt: Date.now(),
        complete: true,
        observationTypes: ["page-excerpt"],
      },
    }),
  };
}

function runtime(
  model: AgentModelAdapter,
  tools = [observedTool()],
): AgentRuntime {
  return new AgentRuntime({
    models: { resolve: async () => model },
    tools,
    policy: new AskModeApprovalPolicy(),
    store: new MemoryAgentRunStore(),
  });
}

describe("AgentRuntime", () => {
  it("answers directly without tools and preserves ordinary bracketed text", async () => {
    const model = new ScriptedAgentModelAdapter([
      { reply: "Use option [1] from your own list.", toolCalls: [] },
    ]);
    const subject = runtime(model);
    await subject.initialize();
    await subject.start(input());

    const run = await until(subject, (status) => status === "completed");
    expect(run.finalText).toBe("Use option [1] from your own list.");
    expect(run.sources).toEqual([]);
    expect(run.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool-proposed" }),
      ]),
    );
    expect(model.inputs).toHaveLength(1);
  });

  it("continues after a real tool observation and grounds final citations", async () => {
    const model = new ScriptedAgentModelAdapter([
      { reply: null, toolCalls: [{ id: "read_test", input: {} }] },
      { reply: "Example says alpha [1]. Bad citation [99].", toolCalls: [] },
    ]);
    const subject = runtime(model);
    await subject.initialize();
    await subject.start(input());

    const run = await until(subject, (status) => status === "completed");
    expect(run.sources).toHaveLength(1);
    expect(run.finalText).toContain("Example says alpha [1]");
    expect(run.finalText).toContain("[source reference unavailable]");
    expect(model.inputs).toHaveLength(2);
    expect(model.inputs[1]?.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool-result", sourceId: "source-1" }),
      ]),
    );
    expect(run.events.map((event) => event.sequence)).toEqual(
      [...run.events.map((event) => event.sequence)].sort((a, b) => a - b),
    );
  });

  it("records unknown tools and lets the model recover", async () => {
    const model = new ScriptedAgentModelAdapter([
      { reply: null, toolCalls: [{ id: "unknown", input: {} }] },
      { reply: "I could not use that unavailable tool.", toolCalls: [] },
    ]);
    const subject = runtime(model);
    await subject.initialize();
    await subject.start(input());

    const run = await until(subject, (status) => status === "completed");
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool-failed" }),
      ]),
    );
  });

  it("binds mutation approval to the exact prepared action", async () => {
    const model = new ScriptedAgentModelAdapter([
      { reply: null, toolCalls: [{ id: "read_test", input: {} }] },
      { reply: "The action was denied.", toolCalls: [] },
    ]);
    const subject = runtime(model, [observedTool("local-change")]);
    await subject.initialize();
    const started = await subject.start(input());
    const waiting = await until(
      subject,
      (status) => status === "awaiting-approval",
    );

    await expect(
      subject.respondToApproval({
        runId: started.id,
        approvalId: waiting.pendingApproval!.id,
        preparedActionHash: "stale-hash",
        approved: true,
      }),
    ).rejects.toThrow(/stale/u);
    await subject.respondToApproval({
      runId: started.id,
      approvalId: waiting.pendingApproval!.id,
      preparedActionHash: waiting.pendingApproval!.preparedActionHash,
      approved: false,
    });
    const completed = await until(subject, (status) => status === "completed");
    expect(completed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval-resolved",
          status: "warning",
        }),
      ]),
    );
  });

  it("cancels an in-flight model request", async () => {
    const turn = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    const subject = runtime({ supportsImages: false, turn });
    await subject.initialize();
    const started = await subject.start(input());
    await until(subject, (status) => status === "thinking");
    await subject.cancel(started.id);
    const cancelled = await until(subject, (status) => status === "cancelled");
    expect(cancelled.finalText).toMatch(/stopped/u);
  });

  it("cancels promptly when an adapter ignores its abort signal", async () => {
    const subject = runtime({
      supportsImages: false,
      turn: () => new Promise<never>(() => undefined),
    });
    await subject.initialize();
    const started = await subject.start(input());
    await until(subject, (status) => status === "thinking");

    await expect(
      Promise.race([
        subject.cancel(started.id).then(() => "cancelled"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("timed-out"), 250),
        ),
      ]),
    ).resolves.toBe("cancelled");
    expect(subject.snapshot.runs[0]?.status).toBe("cancelled");
  });

  it("enforces the run deadline against a hung adapter", async () => {
    const subject = new AgentRuntime({
      models: {
        resolve: async () => ({
          supportsImages: false,
          turn: () => new Promise<never>(() => undefined),
        }),
      },
      tools: [observedTool()],
      policy: new AskModeApprovalPolicy(),
      store: new MemoryAgentRunStore(),
      limits: { maximumRunDurationMs: 20 },
    });
    await subject.initialize();
    await subject.start(input());

    const failed = await until(subject, (status) => status === "failed");
    expect(failed.error).toMatch(/time limit/u);
  });

  it("takes another model turn when guidance arrives during a final response", async () => {
    let finishFirstTurn:
      | ((value: { reply: string; toolCalls: [] }) => void)
      | null = null;
    const inputs: Array<{ queuedMessages: string[] }> = [];
    const subject = runtime({
      supportsImages: false,
      turn: async (turnInput) => {
        inputs.push({ queuedMessages: [...turnInput.queuedMessages] });
        if (inputs.length === 1) {
          return await new Promise((resolve) => {
            finishFirstTurn = resolve;
          });
        }
        return { reply: "Answer updated with guidance.", toolCalls: [] };
      },
    });
    await subject.initialize();
    const started = await subject.start(input());
    await until(subject, (status) => status === "thinking");
    await subject.enqueue(started.id, {
      id: "queued-1",
      text: "Also consider the warranty.",
      createdAt: Date.now(),
    });
    finishFirstTurn!({ reply: "Premature answer.", toolCalls: [] });

    const completed = await until(subject, (status) => status === "completed");
    expect(completed.finalText).toBe("Answer updated with guidance.");
    expect(inputs[1]?.queuedMessages).toEqual(["Also consider the warranty."]);
  });

  it("clears an active conversation only after cancellation is durably archived", async () => {
    const subject = runtime({
      supportsImages: false,
      turn: ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        }),
    });
    await subject.initialize();
    await subject.start(input());
    await until(subject, (status) => status === "thinking");
    await subject.clearConversation("conversation-1");
    expect(subject.snapshot.runs).toEqual([]);
  });

  it("pauses at an abortable tool boundary and resumes safely", async () => {
    let executions = 0;
    const tool = observedTool();
    tool.execute = async (_prepared, context) => {
      executions += 1;
      if (executions === 1) {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Paused", "AbortError")),
            { once: true },
          );
        });
      }
      return {
        modelResult: { ok: true },
        eventLabel: "Read after resume",
      };
    };
    const model = new ScriptedAgentModelAdapter([
      { reply: null, toolCalls: [{ id: "read_test", input: {} }] },
      { reply: "Finished after resume.", toolCalls: [] },
    ]);
    const subject = runtime(model, [tool]);
    await subject.initialize();
    const started = await subject.start(input());
    await until(subject, (status) => status === "executing-tool");
    await subject.pause(started.id);
    await until(subject, (status) => status === "paused");
    await subject.resume(started.id);
    await until(subject, (status) => status === "completed");
    expect(executions).toBe(2);
  });

  it("keeps an approval denial safe while the run is paused", async () => {
    const model = new ScriptedAgentModelAdapter([
      { reply: null, toolCalls: [{ id: "read_test", input: {} }] },
      { reply: "The paused action was denied.", toolCalls: [] },
    ]);
    const subject = runtime(model, [observedTool("local-change")]);
    await subject.initialize();
    const started = await subject.start(input());
    const waiting = await until(
      subject,
      (status) => status === "awaiting-approval",
    );
    await subject.pause(started.id);
    await until(subject, (status) => status === "paused");
    await subject.respondToApproval({
      runId: started.id,
      approvalId: waiting.pendingApproval!.id,
      preparedActionHash: waiting.pendingApproval!.preparedActionHash,
      approved: false,
    });
    await subject.resume(started.id);

    const completed = await until(subject, (status) => status === "completed");
    expect(completed.finalText).toMatch(/denied/u);
  });

  it("stops repeated identical tool calls at the configured limit", async () => {
    const repeated = {
      reply: null,
      toolCalls: [{ id: "read_test", input: {} }],
    };
    const model = new ScriptedAgentModelAdapter([repeated, repeated, repeated]);
    const subject = runtime(model);
    await subject.initialize();
    await subject.start(input());
    const failed = await until(subject, (status) => status === "failed");
    expect(failed.error).toMatch(/repeated/u);
  });
});
