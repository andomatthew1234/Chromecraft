import type { AiToolsSnapshot, OrganiseTabsProposal } from "../shared/ai-tools";
import { useEffect, useRef, type KeyboardEvent } from "react";
import "./ai-tools.css";

function MaterialIcon({ name }: { name: string }) {
  return (
    <span className="material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

function formatModel(model: AiToolsSnapshot["models"][number]) {
  const details = [model.parameterSize, model.family]
    .filter(Boolean)
    .join(" · ");
  return details ? `${model.name} — ${details}` : model.name;
}

export function OrganiseTabsPanel({
  snapshot,
  proposal,
  close,
  retry,
  refreshModels,
  selectModel,
  apply,
  cancel,
  undo,
}: {
  snapshot: AiToolsSnapshot;
  proposal: OrganiseTabsProposal | null;
  close: () => void;
  retry: () => void;
  refreshModels: () => void;
  selectModel: (model: string) => void;
  apply: (proposalId: string) => void;
  cancel: () => void;
  undo: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const busy = ["checking", "thinking", "applying"].includes(
    snapshot.run.stage,
  );
  const selectedInstalled = snapshot.models.some(
    (model) => model.name === snapshot.selectedModel,
  );
  const unavailable = snapshot.connection === "unavailable";
  const noModels =
    snapshot.connection === "connected" && snapshot.models.length === 0;
  const ready = snapshot.run.stage === "ready" && proposal;
  const complete = snapshot.run.stage === "complete";

  useEffect(() => {
    const overlay = overlayRef.current;
    const dialog = dialogRef.current;
    const siblings = overlay?.parentElement
      ? [...overlay.parentElement.children].filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element !== overlay,
        )
      : [];
    const previous = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of siblings) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    dialog?.focus();
    return () => {
      for (const item of previous) {
        item.element.inert = item.inert;
        if (item.ariaHidden === null)
          item.element.removeAttribute("aria-hidden");
        else item.element.setAttribute("aria-hidden", item.ariaHidden);
      }
      document.querySelector<HTMLButtonElement>(".brand")?.focus();
    };
  }, []);

  const keepFocusInside = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => !element.inert);
    if (controls.length === 0) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const first = controls[0];
    const last = controls.at(-1) ?? first;
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === event.currentTarget)
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        document.activeElement === event.currentTarget)
    ) {
      event.preventDefault();
      first.focus();
    } else if (!event.currentTarget.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={overlayRef}
      className="ai-tools-overlay"
      role="presentation"
      onClick={close}
    >
      <section
        ref={dialogRef}
        className="ai-tools-panel"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="organise-tabs-title"
        aria-busy={busy}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={keepFocusInside}
      >
        <header className="ai-tools-header">
          <div className="ai-tools-title-mark" aria-hidden="true">
            <MaterialIcon name="auto_awesome" />
          </div>
          <div>
            <span className="ai-tools-eyebrow">Chromecraft AI · Ollama</span>
            <h1 id="organise-tabs-title">Organise tabs</h1>
            <p>Turn open tabs into clear, useful groups.</p>
          </div>
          <button
            type="button"
            className="ai-tools-close"
            aria-label="Close Organise tabs"
            onClick={close}
          >
            <MaterialIcon name="close" />
          </button>
        </header>

        <div className="ai-tools-model-row">
          <label htmlFor="ai-model">Ollama model</label>
          <select
            id="ai-model"
            value={selectedInstalled ? (snapshot.selectedModel ?? "") : ""}
            disabled={
              busy ||
              snapshot.models.length === 0 ||
              (complete && snapshot.run.undoAvailable)
            }
            onChange={(event) => selectModel(event.target.value)}
          >
            {!selectedInstalled && <option value="">Choose a model</option>}
            {snapshot.models.map((model) => (
              <option value={model.name} key={model.name}>
                {formatModel(model)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ai-model-refresh"
            aria-label="Refresh installed Ollama models"
            title="Refresh installed models"
            disabled={busy || (complete && snapshot.run.undoAvailable)}
            onClick={refreshModels}
          >
            <MaterialIcon name="refresh" />
          </button>
        </div>

        <div className="ai-tools-status" aria-live="polite">
          {busy && (
            <div className="ai-tools-working">
              <div className="ai-orbit" aria-hidden="true">
                <span />
                <MaterialIcon name="auto_awesome" />
              </div>
              <div>
                <strong>{snapshot.run.label}</strong>
                <p>
                  {snapshot.run.stage === "checking"
                    ? "Looking for models installed on this computer."
                    : snapshot.run.stage === "applying"
                      ? "Installing the validated layout as one safe change."
                      : "Only tab titles and addresses without queries or fragments are being analysed."}
                </p>
              </div>
            </div>
          )}

          {unavailable && !busy && (
            <div className="ai-tools-empty">
              <MaterialIcon name="memory" />
              <h2>Ollama isn’t available yet</h2>
              <p>{snapshot.error}</p>
              <code>ollama serve</code>
              <button type="button" className="ai-primary" onClick={retry}>
                <MaterialIcon name="refresh" /> Retry
              </button>
            </div>
          )}

          {noModels && !busy && (
            <div className="ai-tools-empty">
              <MaterialIcon name="deployed_code" />
              <h2>Install an Ollama model</h2>
              <p>
                Chromecraft found Ollama, but it needs a local model before it
                can organise tabs.
              </p>
              <code>ollama pull qwen3:4b</code>
              <button type="button" className="ai-primary" onClick={retry}>
                Check again
              </button>
            </div>
          )}

          {snapshot.run.stage === "failed" && !unavailable && !noModels && (
            <div className="ai-tools-empty ai-tools-error">
              <MaterialIcon name="error" />
              <h2>{snapshot.run.label}</h2>
              <p>{snapshot.run.error ?? snapshot.error}</p>
              <button type="button" className="ai-primary" onClick={retry}>
                Try again
              </button>
            </div>
          )}

          {ready && (
            <div className="ai-tools-proposal">
              <div className="ai-tools-proposal-heading">
                <div>
                  <span>Plan ready</span>
                  <h2>{proposal.summary}</h2>
                </div>
                <span className="ai-model-chip">{proposal.model}</span>
              </div>
              <div className="ai-group-grid">
                {proposal.groups.map((group) => (
                  <article
                    className={`ai-group-card ai-group-${group.color}`}
                    key={`${group.name}-${group.tabIds.join("-")}`}
                  >
                    <header>
                      <span className="ai-group-dot" aria-hidden="true" />
                      <strong>{group.name}</strong>
                      <small>{group.tabIds.length}</small>
                    </header>
                    <ul>
                      {group.tabTitles.slice(0, 4).map((title, index) => (
                        <li key={`${group.tabIds[index]}-${title}`}>{title}</li>
                      ))}
                      {group.tabTitles.length > 4 && (
                        <li>+{group.tabTitles.length - 4} more</li>
                      )}
                    </ul>
                  </article>
                ))}
              </div>
              {proposal.ungroupedTabIds.length > 0 && (
                <p className="ai-tools-muted">
                  {proposal.ungroupedTabIds.length} tabs will stay ungrouped.
                </p>
              )}
              {proposal.warnings.map((warning) => (
                <p className="ai-tools-warning" key={warning}>
                  <MaterialIcon name="shield" /> {warning}
                </p>
              ))}
            </div>
          )}

          {complete && (
            <div className="ai-tools-empty ai-tools-success">
              <MaterialIcon name="check_circle" />
              <h2>{snapshot.run.label}</h2>
              <p>
                Your active tab stayed open and protected tabs were unchanged.
              </p>
            </div>
          )}

          {!busy &&
            !unavailable &&
            !noModels &&
            !ready &&
            !complete &&
            snapshot.run.stage !== "failed" && (
              <div className="ai-tools-empty">
                <MaterialIcon name="tab_group" />
                <h2>Ready to organise</h2>
                <p>Chromecraft will prepare a plan for you to review first.</p>
                <button type="button" className="ai-primary" onClick={retry}>
                  Organise my tabs
                </button>
              </div>
            )}
        </div>

        <footer className="ai-tools-footer">
          <p>
            Page contents are never read. Data goes to the Ollama instance on
            this computer; cloud-backed Ollama models may process it remotely.
          </p>
          <div>
            {snapshot.run.stage === "thinking" && (
              <button type="button" onClick={cancel}>
                Cancel
              </button>
            )}
            {ready && (
              <>
                <button type="button" onClick={retry}>
                  Reanalyse
                </button>
                <button
                  type="button"
                  className="ai-primary"
                  onClick={() => apply(proposal.id)}
                >
                  <MaterialIcon name="auto_fix_high" /> Apply plan
                </button>
              </>
            )}
            {complete && snapshot.run.undoAvailable && (
              <button type="button" onClick={undo}>
                <MaterialIcon name="undo" /> Undo
              </button>
            )}
            {snapshot.run.stage === "failed" && snapshot.run.undoAvailable && (
              <button type="button" onClick={undo}>
                <MaterialIcon name="undo" /> Retry undo
              </button>
            )}
            {complete && (
              <button type="button" onClick={retry}>
                Organise again
              </button>
            )}
            {complete && (
              <button type="button" className="ai-primary" onClick={close}>
                Done
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
