import type { AgentRunCommand, AgentRunSnapshot } from "../shared/agent";
import { ScoutAgentTimeline } from "./ScoutAgentTimeline";
import { ScoutMarkdown } from "./ScoutMarkdown";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

export interface ScoutResponseMessage {
  text: string;
  createdAt: number;
  role: "user" | "assistant";
  status: "complete" | "thinking" | "error";
  model?: string;
}

export function resolveScoutResponse(
  message: ScoutResponseMessage,
  run: AgentRunSnapshot | null,
): ScoutResponseMessage {
  if (!run) return message;
  if (!TERMINAL_STATES.has(run.status)) {
    return { ...message, text: "", status: "thinking" };
  }
  return {
    ...message,
    text:
      run.finalText ??
      run.error ??
      "Scout could not complete this research run.",
    createdAt: run.completedAt ?? run.updatedAt,
    status: run.status === "failed" ? "error" : "complete",
    model: run.model,
  };
}

function ThinkingIndicator() {
  return (
    <div className="ai-thinking-indicator" role="status">
      <span />
      <span />
      <span />
      <span className="sr-only">Scout is thinking</span>
    </div>
  );
}

export function ScoutResponseContent({
  message,
  run,
  command,
  onError,
}: {
  message: ScoutResponseMessage;
  run: AgentRunSnapshot | null;
  command: (command: AgentRunCommand) => Promise<void>;
  onError: (message: string) => void;
}) {
  const resolved = resolveScoutResponse(message, run);
  const researchActive = Boolean(run && !TERMINAL_STATES.has(run.status));

  return (
    <>
      {run && (
        <ScoutAgentTimeline run={run} command={command} onError={onError} />
      )}
      {!researchActive &&
        (resolved.status === "thinking" ? (
          <ThinkingIndicator />
        ) : resolved.role === "assistant" ? (
          <ScoutMarkdown text={resolved.text} />
        ) : (
          <p>{resolved.text}</p>
        ))}
    </>
  );
}
