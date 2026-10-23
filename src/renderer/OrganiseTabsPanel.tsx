import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import type {
  AiGroupingMode,
  AiProviderId,
  AiToolsSnapshot,
  OrganiseTabsProposal,
  OrganiseTabsRequest,
} from "../shared/ai-tools";
import type { TabGroupColor } from "../shared/browser";
import "./ai-tools.css";

const GROUP_COLORS: TabGroupColor[] = [
  "blue",
  "purple",
  "green",
  "orange",
  "cyan",
  "pink",
  "red",
  "yellow",
  "grey",
];

function MaterialIcon({ name }: { name: string }) {
  return (
    <span className="material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

function StaticAssistantAvatar() {
  return (
    <svg className="organiser-avatar" viewBox="0 0 64 56" aria-hidden="true">
      <path
        d="M13 7.5C7.5 10.8 5 17.1 5 27.7c0 10.9 2.7 17.2 8.7 20.4 4.7 2.6 31.9 2.6 36.6 0 6-3.2 8.7-9.5 8.7-20.4 0-10.6-2.5-16.9-8-20.2C46.2 4.6 17.8 4.6 13 7.5Z"
        fill="#252937"
      />
      <ellipse cx="21" cy="28" rx="8" ry="11" fill="#f7fbff" />
      <ellipse cx="43" cy="28" rx="8" ry="11" fill="#f7fbff" />
      <ellipse cx="21" cy="28" rx="3.5" ry="5.5" fill="#68ded6" />
      <ellipse cx="43" cy="28" rx="3.5" ry="5.5" fill="#68ded6" />
    </svg>
  );
}

function formatModel(model: AiToolsSnapshot["models"][number]) {
  const metadata = [model.parameterSize, model.family]
    .filter(Boolean)
    .join(" · ");
  return `${model.recommended ? "Recommended · " : ""}${model.displayName ?? model.name}${metadata ? ` — ${metadata}` : ""}`;
}

function providerStatus(snapshot: AiToolsSnapshot, provider: AiProviderId) {
  const state = provider === "ollama" ? snapshot.ollama : snapshot.gemini;
  if (provider === "gemini" && !snapshot.gemini.apiKeyConfigured)
    return "API key required";
  if (state.connection === "connected")
    return `${state.models.length} ${state.models.length === 1 ? "model" : "models"} available`;
  if (state.connection === "unavailable") return "Needs attention";
  return "Not checked";
}

export function OrganiseTabsPanel({
  snapshot,
  proposal,
  close,
  organise,
  refreshModels,
  installRecommendedModel,
  selectProvider,
  selectGroupingMode,
  selectModel,
  apply,
  cancel,
  undo,
  openAiSettings,
}: {
  snapshot: AiToolsSnapshot;
  proposal: OrganiseTabsProposal | null;
  close: () => void;
  organise: (request: OrganiseTabsRequest) => void;
  refreshModels: (provider: AiProviderId) => void;
  installRecommendedModel: () => void;
  selectProvider: (provider: AiProviderId) => void;
  selectGroupingMode: (mode: AiGroupingMode) => void;
  selectModel: (provider: AiProviderId, model: string) => void;
  apply: (proposal: OrganiseTabsProposal) => void;
  cancel: () => void;
  undo: () => void;
  openAiSettings: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [customInstructions, setCustomInstructions] = useState("");
  const [cloudConsent, setCloudConsent] = useState(false);
  const [installConfirm, setInstallConfirm] = useState(false);
  const [edited, setEdited] = useState<OrganiseTabsProposal | null>(proposal);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const busy = [
    "checking",
    "preparing",
    "connecting",
    "loading",
    "thinking",
    "validating",
    "applying",
  ].includes(snapshot.run.stage);
  const ready = snapshot.run.stage === "ready" && edited;
  const complete = snapshot.run.stage === "complete";
  const providerState =
    snapshot.provider === "ollama" ? snapshot.ollama : snapshot.gemini;
  const selectedModel = providerState.selectedModel ?? "";
  const requiresCloudConsent =
    snapshot.provider === "gemini" &&
    snapshot.preferredGroupingMode === "smart" &&
    !snapshot.gemini.cloudConsentGranted;
  const canOrganise =
    snapshot.eligibleTabCount >= 2 &&
    (snapshot.preferredGroupingMode === "website" ||
      (Boolean(selectedModel) &&
        (snapshot.provider !== "gemini" || snapshot.gemini.apiKeyConfigured) &&
        (!requiresCloudConsent || cloudConsent)));

  useEffect(() => setEdited(proposal), [proposal]);

  useEffect(() => {
    const overlay = overlayRef.current;
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
    dialogRef.current?.focus();
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
      busy ? cancel() : close();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = controls[0];
    const last = controls.at(-1) ?? first;
    if (!first) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const request = useMemo<OrganiseTabsRequest>(
    () => ({
      provider: snapshot.provider,
      model: selectedModel,
      groupingMode: snapshot.preferredGroupingMode,
      customInstructions: customInstructions.trim() || undefined,
      cloudConsent: snapshot.gemini.cloudConsentGranted || cloudConsent,
    }),
    [
      cloudConsent,
      customInstructions,
      selectedModel,
      snapshot.gemini.cloudConsentGranted,
      snapshot.preferredGroupingMode,
      snapshot.provider,
    ],
  );

  const updateGroup = (
    index: number,
    update: Partial<OrganiseTabsProposal["groups"][number]>,
  ) => {
    setEdited((current) =>
      current
        ? {
            ...current,
            groups: current.groups.map((group, groupIndex) =>
              groupIndex === index ? { ...group, ...update } : group,
            ),
          }
        : current,
    );
  };

  const moveTab = (
    tabId: string,
    fromIndex: number | null,
    destination: string,
  ) => {
    setEdited((current) => {
      if (!current) return current;
      if (fromIndex !== null && destination === String(fromIndex))
        return current;
      const source =
        fromIndex === null ? null : (current.groups[fromIndex] ?? null);
      const sourceTabIndex = source
        ? source.tabIds.indexOf(tabId)
        : current.ungroupedTabIds.indexOf(tabId);
      if (sourceTabIndex < 0) return current;
      const title = source
        ? source.tabTitles[sourceTabIndex]
        : current.ungroupedTabTitles[sourceTabIndex];
      const favicon = source
        ? (source.tabFavicons[sourceTabIndex] ?? null)
        : (current.ungroupedTabFavicons[sourceTabIndex] ?? null);
      let groups = current.groups.map((group, index) =>
        index === fromIndex
          ? {
              ...group,
              tabIds: group.tabIds.filter((id) => id !== tabId),
              tabTitles: group.tabTitles.filter(
                (_, itemIndex) => itemIndex !== sourceTabIndex,
              ),
              tabFavicons: group.tabFavicons.filter(
                (_, itemIndex) => itemIndex !== sourceTabIndex,
              ),
            }
          : group,
      );
      let ungroupedTabIds = current.ungroupedTabIds.filter(
        (id) => id !== tabId,
      );
      let ungroupedTabTitles = current.ungroupedTabTitles.filter(
        (_, itemIndex) => fromIndex !== null || itemIndex !== sourceTabIndex,
      );
      let ungroupedTabFavicons = current.ungroupedTabFavicons.filter(
        (_, itemIndex) => fromIndex !== null || itemIndex !== sourceTabIndex,
      );
      if (destination === "ungrouped") {
        ungroupedTabIds.push(tabId);
        ungroupedTabTitles.push(title);
        ungroupedTabFavicons.push(favicon);
      } else {
        const destinationIndex = Number(destination);
        groups = groups.map((group, index) =>
          index === destinationIndex
            ? {
                ...group,
                tabIds: [...group.tabIds, tabId],
                tabTitles: [...group.tabTitles, title],
                tabFavicons: [...group.tabFavicons, favicon],
              }
            : group,
        );
      }
      const validGroups = [] as typeof groups;
      for (const group of groups) {
        if (group.tabIds.length === 1) {
          ungroupedTabIds.push(group.tabIds[0]);
          ungroupedTabTitles.push(group.tabTitles[0]);
          ungroupedTabFavicons.push(group.tabFavicons[0] ?? null);
        } else if (group.tabIds.length > 1) {
          validGroups.push(group);
        }
      }
      return {
        ...current,
        groups: validGroups,
        ungroupedTabIds,
        ungroupedTabTitles,
        ungroupedTabFavicons,
      };
    });
  };

  return (
    <div
      ref={overlayRef}
      className="ai-tools-overlay"
      role="presentation"
      onClick={() => !busy && close()}
    >
      <section
        ref={dialogRef}
        className={`ai-tools-panel ${ready ? "ai-tools-panel-review" : ""}`}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="organise-tabs-title"
        aria-busy={busy}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={keepFocusInside}
      >
        <header className="ai-tools-header">
          <StaticAssistantAvatar />
          <div>
            <span className="ai-tools-eyebrow">Chromecraft AI</span>
            <h1 id="organise-tabs-title">Organise your tabs</h1>
            <p>
              Group related tabs together and make your browser easier to
              navigate.
            </p>
          </div>
          <span className="ai-open-tab-count">
            {snapshot.eligibleTabCount} open{" "}
            {snapshot.eligibleTabCount === 1 ? "tab" : "tabs"}
          </span>
          <button
            type="button"
            className="ai-tools-close"
            aria-label="Close Organise tabs"
            onClick={close}
          >
            <MaterialIcon name="close" />
          </button>
        </header>

        {!ready && !complete && !busy && (
          <div className="ai-tools-setup">
            <section aria-labelledby="provider-title">
              <div className="ai-section-heading">
                <div>
                  <span>1</span>
                  <h2 id="provider-title">Choose where it runs</h2>
                </div>
                <button
                  type="button"
                  onClick={() => refreshModels(snapshot.provider)}
                >
                  <MaterialIcon name="refresh" /> Refresh models
                </button>
              </div>
              <div className="ai-provider-grid">
                {(["ollama", "gemini"] as AiProviderId[]).map((provider) => (
                  <button
                    type="button"
                    key={provider}
                    className={`ai-provider-card ${snapshot.provider === provider ? "selected" : ""}`}
                    aria-pressed={snapshot.provider === provider}
                    onClick={() => selectProvider(provider)}
                  >
                    <span className="ai-provider-icon">
                      <MaterialIcon
                        name={provider === "ollama" ? "memory" : "cloud"}
                      />
                    </span>
                    <span>
                      <strong>
                        {provider === "ollama" ? "Ollama" : "Google Gemini"}
                      </strong>
                      <small>
                        {provider === "ollama"
                          ? "On your computer"
                          : "Fast cloud AI"}
                      </small>
                    </span>
                    <i>{providerStatus(snapshot, provider)}</i>
                    <MaterialIcon
                      name={
                        snapshot.provider === provider
                          ? "radio_button_checked"
                          : "radio_button_unchecked"
                      }
                    />
                    <p>
                      {provider === "ollama"
                        ? "Use a small local AI model. No tab data is sent to Google."
                        : "Use Google’s lightweight Gemini model for quick, intelligent grouping."}
                    </p>
                  </button>
                ))}
              </div>
            </section>

            <section aria-labelledby="model-title" className="ai-setup-section">
              <div className="ai-section-heading">
                <div>
                  <span>2</span>
                  <h2 id="model-title">Choose a model</h2>
                </div>
              </div>
              {snapshot.provider === "gemini" &&
              !snapshot.gemini.apiKeyConfigured ? (
                <div className="ai-provider-resolution">
                  <MaterialIcon name="key" />
                  <span>
                    <strong>Add your Gemini API key</strong>
                    <small>
                      Chromecraft never exposes the key to websites.
                    </small>
                  </span>
                  <button type="button" onClick={openAiSettings}>
                    Configure Gemini
                  </button>
                </div>
              ) : providerState.models.length ? (
                <label className="ai-model-field">
                  <span>
                    {snapshot.provider === "ollama"
                      ? "Local model"
                      : "Gemini model"}
                  </span>
                  <select
                    value={selectedModel}
                    onChange={(event) =>
                      selectModel(snapshot.provider, event.target.value)
                    }
                  >
                    {!selectedModel && (
                      <option value="">Choose an installed model</option>
                    )}
                    {providerState.models.map((model) => (
                      <option value={model.name} key={model.name}>
                        {formatModel(model)}
                      </option>
                    ))}
                  </select>
                  <MaterialIcon name="expand_more" />
                </label>
              ) : (
                <div className="ai-provider-resolution">
                  <MaterialIcon
                    name={
                      snapshot.provider === "ollama" ? "download" : "refresh"
                    }
                  />
                  <span>
                    <strong>
                      {snapshot.provider === "ollama"
                        ? "No small local model found"
                        : "Check available Gemini models"}
                    </strong>
                    <small>
                      {providerState.error ??
                        (snapshot.provider === "ollama"
                          ? "Recommended: qwen3:1.7b"
                          : "Configure and test your API key first.")}
                    </small>
                  </span>
                  <button
                    type="button"
                    onClick={() => refreshModels(snapshot.provider)}
                  >
                    Check models
                  </button>
                </div>
              )}
              {snapshot.provider === "ollama" &&
                snapshot.ollama.connection === "connected" &&
                !snapshot.ollama.selectedModel &&
                (!installConfirm ? (
                  <button
                    type="button"
                    className="ai-install-model"
                    onClick={() => setInstallConfirm(true)}
                  >
                    <MaterialIcon name="download" /> Install recommended
                    qwen3:1.7b
                  </button>
                ) : (
                  <div
                    className="ai-install-confirm"
                    role="group"
                    aria-label="Confirm model download"
                  >
                    <span>
                      <strong>Download qwen3:1.7b with Ollama?</strong>
                      <small>
                        This downloads model files to your computer. You can
                        cancel while it is downloading.
                      </small>
                    </span>
                    <button
                      type="button"
                      onClick={() => setInstallConfirm(false)}
                    >
                      Not now
                    </button>
                    <button
                      type="button"
                      className="ai-primary"
                      onClick={() => {
                        setInstallConfirm(false);
                        installRecommendedModel();
                      }}
                    >
                      Confirm download
                    </button>
                  </div>
                ))}
            </section>

            <section
              aria-labelledby="grouping-title"
              className="ai-setup-section"
            >
              <div className="ai-section-heading">
                <div>
                  <span>3</span>
                  <h2 id="grouping-title">How should tabs be grouped?</h2>
                </div>
              </div>
              <div className="ai-grouping-options">
                <label
                  className={
                    snapshot.preferredGroupingMode === "smart" ? "selected" : ""
                  }
                >
                  <input
                    type="radio"
                    name="grouping-mode"
                    checked={snapshot.preferredGroupingMode === "smart"}
                    onChange={() => selectGroupingMode("smart")}
                  />
                  <span>
                    <strong>
                      Smart topics <em>Recommended</em>
                    </strong>
                    <small>
                      Groups related subjects, projects and activities.
                    </small>
                  </span>
                </label>
                <label
                  className={
                    snapshot.preferredGroupingMode === "website"
                      ? "selected"
                      : ""
                  }
                >
                  <input
                    type="radio"
                    name="grouping-mode"
                    checked={snapshot.preferredGroupingMode === "website"}
                    onChange={() => selectGroupingMode("website")}
                  />
                  <span>
                    <strong>By website</strong>
                    <small>Instant grouping by domain. No AI required.</small>
                  </span>
                </label>
              </div>
              <label className="ai-custom-instructions">
                <span>
                  Custom instructions <small>Optional</small>
                </span>
                <textarea
                  rows={2}
                  maxLength={1_000}
                  value={customInstructions}
                  onChange={(event) =>
                    setCustomInstructions(event.target.value)
                  }
                  placeholder="Keep my coding tabs separate from gaming tabs."
                />
              </label>
            </section>

            {requiresCloudConsent && (
              <label className="ai-cloud-consent">
                <input
                  type="checkbox"
                  checked={cloudConsent}
                  onChange={(event) => setCloudConsent(event.target.checked)}
                />
                <span>
                  <strong>Use Google Gemini for this organisation</strong>
                  <small>
                    Chromecraft sends the titles and website domains of the tabs
                    being organised to Google’s Gemini API. Page contents,
                    cookies, passwords and browsing history are not included.
                  </small>
                  <details>
                    <summary>
                      Preview {snapshot.cloudDataPreview.length} entries
                    </summary>
                    <ul>
                      {snapshot.cloudDataPreview
                        .slice(0, 20)
                        .map((item, index) => (
                          <li key={`${item.hostname}-${index}`}>
                            <b>{item.hostname}</b> · {item.title}
                          </li>
                        ))}
                    </ul>
                  </details>
                </span>
              </label>
            )}

            {snapshot.run.stage === "failed" && (
              <div className="ai-inline-error" role="alert">
                <MaterialIcon name="error" />
                <span>
                  <strong>{snapshot.run.label}</strong>
                  <small>{snapshot.run.error}</small>
                </span>
                <button
                  type="button"
                  onClick={() => selectGroupingMode("website")}
                >
                  Use simple website grouping
                </button>
              </div>
            )}
          </div>
        )}

        {busy && (
          <div className="ai-tools-working" aria-live="polite">
            <span className="ai-linear-progress" aria-hidden="true">
              <i />
            </span>
            <StaticAssistantAvatar />
            <div>
              <strong>{snapshot.run.label}</strong>
              <p>
                {snapshot.run.stage === "checking"
                  ? "Checking the selected provider and its models."
                  : snapshot.run.stage === "applying"
                    ? "Applying only the groups you approved."
                    : "Preparing a compact, validated grouping proposal."}
              </p>
            </div>
          </div>
        )}

        {ready && edited && (
          <div className="ai-tools-proposal">
            <div className="ai-tools-proposal-heading">
              <div>
                <span>Ready for review</span>
                <h2>{edited.summary}</h2>
                <p>Rename, recolour or move tabs before applying anything.</p>
              </div>
              <span className="ai-model-chip">
                {edited.provider === "website"
                  ? "By website"
                  : `${edited.provider} · ${edited.model}`}
              </span>
            </div>
            <div className="ai-group-grid">
              {edited.groups.map((group, groupIndex) => (
                <article
                  className={`ai-group-card ai-group-${group.color}`}
                  key={`${groupIndex}-${group.tabIds.join("-")}`}
                >
                  <header>
                    <select
                      className="ai-colour-select"
                      aria-label={`Colour for ${group.name}`}
                      value={group.color}
                      onChange={(event) =>
                        updateGroup(groupIndex, {
                          color: event.target.value as TabGroupColor,
                        })
                      }
                    >
                      {GROUP_COLORS.map((color) => (
                        <option value={color} key={color}>
                          {color}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label="Group name"
                      maxLength={48}
                      value={group.name}
                      onChange={(event) =>
                        updateGroup(groupIndex, { name: event.target.value })
                      }
                    />
                    <small>{group.tabIds.length}</small>
                    <button
                      type="button"
                      aria-label={`${expanded.has(groupIndex) ? "Collapse" : "Expand"} ${group.name}`}
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          next.has(groupIndex)
                            ? next.delete(groupIndex)
                            : next.add(groupIndex);
                          return next;
                        })
                      }
                    >
                      <MaterialIcon
                        name={
                          expanded.has(groupIndex)
                            ? "expand_less"
                            : "expand_more"
                        }
                      />
                    </button>
                  </header>
                  <ul className={expanded.has(groupIndex) ? "expanded" : ""}>
                    {group.tabTitles.map((title, tabIndex) => (
                      <li key={group.tabIds[tabIndex]}>
                        <span className="ai-tab-favicon">
                          <MaterialIcon name="language" />
                        </span>
                        <span title={title}>{title}</span>
                        <select
                          aria-label={`Move ${title}`}
                          value={String(groupIndex)}
                          onChange={(event) =>
                            moveTab(
                              group.tabIds[tabIndex],
                              groupIndex,
                              event.target.value,
                            )
                          }
                        >
                          {edited.groups.map((target, targetIndex) => (
                            <option
                              value={targetIndex}
                              key={`${target.name}-${targetIndex}`}
                            >
                              {target.name}
                            </option>
                          ))}
                          <option value="ungrouped">Leave ungrouped</option>
                        </select>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
            {edited.ungroupedTabIds.length > 0 && (
              <article className="ai-ungrouped-card">
                <header>
                  <MaterialIcon name="tab" />
                  <strong>Ungrouped</strong>
                  <small>{edited.ungroupedTabIds.length}</small>
                </header>
                <ul>
                  {edited.ungroupedTabTitles.map((title, tabIndex) => (
                    <li key={edited.ungroupedTabIds[tabIndex]}>
                      <span className="ai-tab-favicon">
                        <MaterialIcon name="language" />
                      </span>
                      <span title={title}>{title}</span>
                      <select
                        aria-label={`Move ${title}`}
                        value="ungrouped"
                        onChange={(event) =>
                          moveTab(
                            edited.ungroupedTabIds[tabIndex],
                            null,
                            event.target.value,
                          )
                        }
                      >
                        <option value="ungrouped">Leave ungrouped</option>
                        {edited.groups.map((target, targetIndex) => (
                          <option
                            value={targetIndex}
                            key={`${target.name}-${targetIndex}`}
                          >
                            {target.name}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              </article>
            )}
            {edited.warnings.map((warning) => (
              <p className="ai-tools-warning" key={warning}>
                <MaterialIcon name="shield" /> {warning}
              </p>
            ))}
          </div>
        )}

        {complete && (
          <div className="ai-tools-success">
            <MaterialIcon name="check_circle" />
            <div>
              <h2>{snapshot.run.label}</h2>
              <p>
                The approved layout is active. You can undo it while this
                session remains open.
              </p>
            </div>
          </div>
        )}

        <footer className="ai-tools-footer">
          <p>
            {snapshot.preferredGroupingMode === "website"
              ? "Website grouping runs instantly without AI."
              : snapshot.provider === "ollama"
                ? "Titles and domains stay with your configured Ollama instance."
                : "Gemini may have quotas or billing depending on your Google account."}
          </p>
          <div>
            {busy && snapshot.run.stage !== "applying" && (
              <button type="button" onClick={cancel}>
                Cancel
              </button>
            )}
            {!ready && !complete && !busy && (
              <button
                type="button"
                className="ai-primary"
                disabled={!canOrganise}
                onClick={() => organise(request)}
              >
                <MaterialIcon name="tab_group" /> Organise tabs
                {snapshot.preferredGroupingMode === "smart"
                  ? ` with ${snapshot.provider === "ollama" ? "Ollama" : "Gemini"}`
                  : ""}
              </button>
            )}
            {ready && (
              <>
                <button type="button" onClick={() => setEdited(null)}>
                  Change setup
                </button>
                <button type="button" onClick={() => organise(request)}>
                  Regenerate
                </button>
                <button
                  type="button"
                  className="ai-primary"
                  onClick={() => apply(edited)}
                >
                  <MaterialIcon name="done_all" /> Apply groups
                </button>
              </>
            )}
            {complete && snapshot.run.undoAvailable && (
              <button type="button" onClick={undo}>
                <MaterialIcon name="undo" /> Undo
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
