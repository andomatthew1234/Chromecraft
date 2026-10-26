import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentRunSnapshot } from "../shared/agent";
import { ScoutAgentTimeline } from "./ScoutAgentTimeline";

function run(status: AgentRunSnapshot["status"]): AgentRunSnapshot {
  return {
    id: "opaque-run",
    conversationId: "conversation",
    messageId: "message",
    objective: "Compare these articles",
    permissionMode: "ask",
    provider: "ollama",
    model: "qwen",
    status,
    statusLabel: status === "paused" ? "Research paused" : "Scout is thinking",
    createdAt: 1,
    updatedAt: 2,
    completedAt: status === "completed" ? 2 : null,
    events: [
      {
        id: "event-0",
        runId: "opaque-run",
        sequence: 1,
        timestamp: 1,
        type: "tool-proposed",
        label: "Read page",
        detail: "Preparing a bounded page excerpt",
        toolId: "read_page_excerpt",
        status: "working",
        metadata: {},
      },
      {
        id: "event-1",
        runId: "opaque-run",
        sequence: 2,
        timestamp: 1,
        type: "tab-inspected",
        label: "Read Example article",
        detail: "Partial page excerpt",
        toolId: "read_page_excerpt",
        status: "success",
        metadata: {},
      },
    ],
    sources: [
      {
        id: "opaque-source",
        title: "Example article",
        url: "https://example.test/article",
        hostname: "example.test",
        faviconDataUrl: null,
        capturedAt: 1,
        complete: false,
        observationTypes: ["page-excerpt"],
      },
    ],
    pendingApproval: null,
    queuedMessages: [],
    finalText: null,
    error: null,
  };
}

describe("ScoutAgentTimeline", () => {
  it("renders operational events and real run controls without private IDs", () => {
    const markup = renderToStaticMarkup(
      <ScoutAgentTimeline
        run={run("thinking")}
        command={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(markup).toContain("Scout is researching");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('class="scout-run-details" data-expanded="true"');
    expect(markup).toContain('aria-hidden="false"');
    expect(markup).toContain("Read Example article");
    expect(markup).toContain("check_circle");
    expect(markup).toContain('data-step-state="active"');
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain("progress_activity");
    expect(markup).toContain("Pause");
    expect(markup).toContain("Stop");
    expect(markup).not.toContain("tabId");
    expect(markup).not.toContain("windowId");
  });

  it("offers Resume only while the run is paused", () => {
    const markup = renderToStaticMarkup(
      <ScoutAgentTimeline
        run={run("paused")}
        command={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(markup).toContain("Resume");
    expect(markup).not.toContain(">Pause<");
  });

  it("shows green completion markers without an active spinner after completion", () => {
    const markup = renderToStaticMarkup(
      <ScoutAgentTimeline
        run={run("completed")}
        command={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(markup).toContain("check_circle");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('class="scout-run-details" data-expanded="false"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("Read Example article");
    expect(markup).not.toContain('data-step-state="active"');
    expect(markup).not.toContain("progress_activity");
  });
});
