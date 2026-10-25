import { useState } from "react";

import type { AgentRunCommand, AgentRunSnapshot } from "../shared/agent";

function icon(name: string) {
  return (
    <span className="material-icon material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

const terminal = new Set(["completed", "failed", "cancelled"]);

export function ScoutAgentTimeline({
  run,
  command,
  onError,
}: {
  run: AgentRunSnapshot;
  command: (command: AgentRunCommand) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const events = run.events
    .filter((event) => event.type !== "status-changed")
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-8);
  const active = !terminal.has(run.status);

  const dispatch = async (value: AgentRunCommand) => {
    if (busy) return;
    setBusy(true);
    try {
      await command(value);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Scout could not update this run.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="scout-run-card" data-status={run.status}>
      <header>
        <span className="scout-run-state-icon">
          {icon(
            run.status === "completed"
              ? "check_circle"
              : run.status === "failed"
                ? "error"
                : run.status === "cancelled"
                  ? "stop_circle"
                  : run.status === "paused"
                    ? "pause_circle"
                    : "travel_explore",
          )}
        </span>
        <span>
          <strong>{active ? "Scout is researching" : run.statusLabel}</strong>
          <small>{run.objective}</small>
        </span>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={
            expanded ? "Collapse research details" : "Expand research details"
          }
        >
          {icon(expanded ? "expand_less" : "expand_more")}
        </button>
      </header>

      {expanded && (
        <>
          <div className="scout-run-current" role="status">
            <span aria-hidden="true" />
            <strong>{run.statusLabel}</strong>
          </div>
          {events.length > 0 && (
            <ol className="scout-run-events">
              {events.map((event) => (
                <li key={event.id} data-status={event.status}>
                  {icon(event.status === "success" ? "check" : "arrow_right")}
                  <span>
                    <b>{event.label}</b>
                    {event.detail && <small>{event.detail}</small>}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {run.pendingApproval && (
            <section
              className="scout-approval-card"
              aria-label="Scout approval request"
            >
              <header>
                {icon("verified_user")}
                <strong>Scout needs your approval</strong>
              </header>
              <dl>
                <div>
                  <dt>Action</dt>
                  <dd>{run.pendingApproval.action}</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>{run.pendingApproval.target}</dd>
                </div>
                <div>
                  <dt>Effect</dt>
                  <dd>{run.pendingApproval.expectedEffect}</dd>
                </div>
                <div>
                  <dt>Risk</dt>
                  <dd>{run.pendingApproval.risk}</dd>
                </div>
              </dl>
              <footer>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void dispatch({
                      type: "approval",
                      decision: {
                        runId: run.id,
                        approvalId: run.pendingApproval!.id,
                        preparedActionHash:
                          run.pendingApproval!.preparedActionHash,
                        approved: false,
                      },
                    })
                  }
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="scout-approval-primary"
                  disabled={busy}
                  onClick={() =>
                    void dispatch({
                      type: "approval",
                      decision: {
                        runId: run.id,
                        approvalId: run.pendingApproval!.id,
                        preparedActionHash:
                          run.pendingApproval!.preparedActionHash,
                        approved: true,
                      },
                    })
                  }
                >
                  Approve
                </button>
              </footer>
            </section>
          )}
          {run.sources.length > 0 && (
            <div className="scout-source-section">
              <button
                type="button"
                onClick={() => setSourcesOpen((value) => !value)}
                aria-expanded={sourcesOpen}
              >
                {icon("library_books")}
                <span>
                  {run.sources.length}{" "}
                  {run.sources.length === 1 ? "source" : "sources"}
                </span>
                {icon(sourcesOpen ? "expand_less" : "expand_more")}
              </button>
              {sourcesOpen && (
                <ul>
                  {run.sources.map((source, index) => (
                    <li key={source.id}>
                      <button
                        type="button"
                        onClick={() =>
                          void dispatch({
                            type: "open-source",
                            runId: run.id,
                            sourceId: source.id,
                          })
                        }
                      >
                        {source.faviconDataUrl ? (
                          <img src={source.faviconDataUrl} alt="" />
                        ) : (
                          <span className="scout-source-fallback">
                            {source.hostname.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <span>
                          <b>
                            [{index + 1}] {source.title}
                          </b>
                          <small>
                            {source.hostname} ·{" "}
                            {source.complete ? "Fully read" : "Partially read"}
                          </small>
                        </span>
                        {icon("open_in_new")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {active && (
            <footer className="scout-run-controls">
              {run.status === "paused" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void dispatch({ type: "resume", runId: run.id })
                  }
                >
                  {icon("play_arrow")} Resume
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || run.status === "pausing"}
                  onClick={() =>
                    void dispatch({ type: "pause", runId: run.id })
                  }
                >
                  {icon("pause")} Pause
                </button>
              )}
              <button
                type="button"
                className="scout-stop-run"
                disabled={busy}
                onClick={() => void dispatch({ type: "cancel", runId: run.id })}
              >
                {icon("stop")} Stop
              </button>
            </footer>
          )}
        </>
      )}
    </section>
  );
}
