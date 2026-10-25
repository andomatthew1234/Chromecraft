import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentRunSnapshot } from "../shared/agent";
import {
  resolveScoutResponse,
  ScoutResponseContent,
  type ScoutResponseMessage,
} from "./ScoutResponseContent";

const placeholder: ScoutResponseMessage = {
  text: "",
  createdAt: 1,
  role: "assistant",
  status: "thinking",
  model: "gemini-flash-lite-latest",
};

function run(status: AgentRunSnapshot["status"]): AgentRunSnapshot {
  return {
    id: "run",
    conversationId: "conversation",
    messageId: "message",
    objective: "Compare these AIOs",
    permissionMode: "ask",
    provider: "gemini",
    model: "gemini-flash-lite-latest",
    status,
    statusLabel: status === "completed" ? "Research complete" : "Comparing",
    createdAt: 1,
    updatedAt: 2,
    completedAt: status === "completed" ? 2 : null,
    events: [],
    sources: [],
    pendingApproval: null,
    queuedMessages: [],
    finalText:
      status === "completed"
        ? "## Recommendation\n\nChoose the **280**."
        : null,
    error: null,
  };
}

describe("ScoutResponseContent", () => {
  it("shows the expanded research tile without generic chat dots while running", () => {
    const markup = renderToStaticMarkup(
      <ScoutResponseContent
        message={placeholder}
        run={run("thinking")}
        command={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(markup).toContain("scout-run-card");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).not.toContain("ai-thinking-indicator");
  });

  it("puts the collapsed completed tile before the Markdown answer", () => {
    const completedRun = run("completed");
    const markup = renderToStaticMarkup(
      <ScoutResponseContent
        message={placeholder}
        run={completedRun}
        command={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("<h2>Recommendation</h2>");
    expect(markup.indexOf("scout-run-card")).toBeLessThan(
      markup.indexOf("<h2>Recommendation</h2>"),
    );
    expect(markup).not.toContain("ai-thinking-indicator");
    expect(resolveScoutResponse(placeholder, completedRun).text).toContain(
      "Choose the **280**",
    );
  });
});
