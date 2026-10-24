import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  DEFAULT_ASSISTANT_CONTEXT,
  SCOUT_CONTEXT_DEFAULTS_STORAGE_KEY,
  SCOUT_REDUCED_MOTION_STORAGE_KEY,
  type AssistantContextPreferences,
} from "../shared/ai-assistant";
import type {
  AiModelSnapshot,
  AiProviderId,
  AiToolsSnapshot,
} from "../shared/ai-tools";
import { StaticAssistantAvatar } from "./AssistantAvatar";
import { GeminiLogo, OllamaLogo } from "./ScoutProviderLogo";
import {
  ScoutModelPicker,
  type ScoutModelCategory,
  type ScoutModelChoice,
} from "./ScoutModelPicker";
import "./scout-settings.css";

export type ScoutSettingsPage =
  | "home"
  | "providers"
  | "gemini"
  | "ollama"
  | "models"
  | "privacy";

const HISTORY_STORAGE_KEY = "chromecraft-ai-assistant-history-v1";
const HISTORY_CLEARED_EVENT = "scout-history-cleared";

function MaterialIcon({ name }: { name: string }) {
  return (
    <span className="material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

function readContextDefaults(): AssistantContextPreferences {
  if (typeof localStorage === "undefined")
    return { ...DEFAULT_ASSISTANT_CONTEXT };
  try {
    return {
      ...DEFAULT_ASSISTANT_CONTEXT,
      ...(JSON.parse(
        localStorage.getItem(SCOUT_CONTEXT_DEFAULTS_STORAGE_KEY) ?? "{}",
      ) as Partial<AssistantContextPreferences>),
    };
  } catch {
    return { ...DEFAULT_ASSISTANT_CONTEXT };
  }
}

function pageForTarget(target: string | null): ScoutSettingsPage | null {
  if (!target) return null;
  if (target === "gemini-api-key" || target === "gemini-model") return "gemini";
  if (target === "ollama-provider") return "ollama";
  if (target === "scout-providers") return "providers";
  if (target === "tab-organiser-model" || target === "scout-model") {
    return "models";
  }
  if (target === "scout-preferences" || target === "scout-context") {
    return "privacy";
  }
  return null;
}

function statusLabel(provider: AiProviderId, snapshot: AiToolsSnapshot) {
  const state = provider === "gemini" ? snapshot.gemini : snapshot.ollama;
  if (provider === "gemini" && !snapshot.gemini.apiKeyConfigured) {
    return { tone: "neutral", label: "Not configured" } as const;
  }
  if (state.connection === "connected") {
    return { tone: "success", label: "Connected" } as const;
  }
  if (state.connection === "unavailable") {
    return { tone: "error", label: "Needs attention" } as const;
  }
  return { tone: "neutral", label: "Not tested" } as const;
}

function geminiActionError(error: unknown): string {
  const detail = error instanceof Error ? error.message.toLowerCase() : "";
  if (/quota|rate/u.test(detail)) {
    return "Gemini usage is temporarily limited. Check quota or try again later.";
  }
  if (/key|401|403|auth/u.test(detail)) {
    return "Gemini could not authenticate. Check the API key and try again.";
  }
  if (/time|respond|conn|fetch|network/u.test(detail)) {
    return "Scout could not reach Gemini. Check the connection and try again.";
  }
  return "Gemini could not complete that request. Check the key and try again.";
}

function modelCategory(model: AiModelSnapshot): ScoutModelCategory {
  if (model.recommended || /(?:lite|mini|small|1b|2b)/iu.test(model.name)) {
    return "fast";
  }
  if (/(?:pro|large|advanced|20b|30b|70b)/iu.test(model.name)) {
    return "advanced";
  }
  return "balanced";
}

function modelChoices(
  snapshot: AiToolsSnapshot,
  provider: AiProviderId | "all" = "all",
): ScoutModelChoice[] {
  const providers: AiProviderId[] =
    provider === "all" ? ["ollama", "gemini"] : [provider];
  return providers.flatMap((id) => {
    const state = id === "ollama" ? snapshot.ollama : snapshot.gemini;
    return state.models.map((model) => ({
      provider: id,
      model,
      category: modelCategory(model),
      availability:
        state.connection === "connected" ? "available" : "unavailable",
      description:
        id === "gemini"
          ? model.recommended
            ? "A fast, efficient choice for everyday Scout tasks"
            : "Verified Gemini text-generation model"
          : model.recommended
            ? "Recommended lightweight local model"
            : "Installed on this device",
    }));
  });
}

function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function StatusChip({ status }: { status: ReturnType<typeof statusLabel> }) {
  return (
    <span className="scout-status-chip" data-tone={status.tone}>
      <span aria-hidden="true" />
      {status.label}
    </span>
  );
}

function SubpageHeader({
  title,
  subtitle,
  back,
  logo,
  status,
}: {
  title: string;
  subtitle: string;
  back: () => void;
  logo?: ReactNode;
  status?: ReturnType<typeof statusLabel>;
}) {
  return (
    <header className="scout-subpage-header">
      <button type="button" className="scout-back-button" onClick={back}>
        <MaterialIcon name="arrow_back" />
        <span>Back</span>
      </button>
      <div className="scout-subpage-heading">
        {logo && <span className="scout-provider-logo-frame">{logo}</span>}
        <span>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </span>
        {status && <StatusChip status={status} />}
      </div>
    </header>
  );
}

function NavigationCard({
  icon,
  title,
  description,
  meta,
  onClick,
}: {
  icon: string;
  title: string;
  description: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="scout-navigation-card" onClick={onClick}>
      <span className="scout-navigation-card__icon">
        <MaterialIcon name={icon} />
      </span>
      <span className="scout-navigation-card__copy">
        <strong>{title}</strong>
        <span>{description}</span>
        <small>{meta}</small>
      </span>
      <MaterialIcon name="arrow_forward" />
    </button>
  );
}

function HomePage({
  navigate,
}: {
  navigate: (page: ScoutSettingsPage) => void;
}) {
  return (
    <div className="scout-settings-page scout-settings-home">
      <div className="scout-home-intro">
        <StaticAssistantAvatar size={54} />
        <span>
          <h3>Scout settings</h3>
          <p>Choose how Scout thinks, what it can see and where it runs.</p>
        </span>
      </div>
      <div className="scout-navigation-grid">
        <NavigationCard
          icon="hub"
          title="AI providers"
          description="Connect Gemini or use Ollama locally."
          meta="Connections and credentials"
          onClick={() => navigate("providers")}
        />
        <NavigationCard
          icon="speed"
          title="Models & performance"
          description="Choose separate models for chat and tab organisation."
          meta="Scout Power and task defaults"
          onClick={() => navigate("models")}
        />
        <NavigationCard
          icon="verified_user"
          title="Privacy & context"
          description="Control the page details Scout can use."
          meta="Context, captures and local history"
          onClick={() => navigate("privacy")}
        />
      </div>
    </div>
  );
}

function ProvidersPage({
  snapshot,
  navigate,
}: {
  snapshot: AiToolsSnapshot;
  navigate: (page: ScoutSettingsPage) => void;
}) {
  return (
    <div className="scout-settings-page">
      <SubpageHeader
        title="AI providers"
        subtitle="Scout shares one secure connection inventory across every AI task."
        back={() => navigate("home")}
      />
      <div id="setting-scout-providers" className="scout-provider-grid">
        <button
          type="button"
          className="scout-provider-card"
          onClick={() => navigate("gemini")}
        >
          <span className="scout-provider-card__logo">
            <GeminiLogo />
          </span>
          <span className="scout-provider-card__copy">
            <strong>Google Gemini</strong>
            <span>Fast cloud models using your own API key.</span>
          </span>
          <StatusChip status={statusLabel("gemini", snapshot)} />
          <MaterialIcon name="arrow_forward" />
        </button>
        <button
          type="button"
          className="scout-provider-card"
          onClick={() => navigate("ollama")}
        >
          <span className="scout-provider-card__logo">
            <OllamaLogo />
          </span>
          <span className="scout-provider-card__copy">
            <strong>Local Ollama</strong>
            <span>Private models running entirely on this device.</span>
          </span>
          <StatusChip status={statusLabel("ollama", snapshot)} />
          <MaterialIcon name="arrow_forward" />
        </button>
      </div>
    </div>
  );
}

function GeminiPage({
  snapshot,
  navigate,
}: {
  snapshot: AiToolsSnapshot;
  navigate: (page: ScoutSettingsPage) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [replaceMode, setReplaceMode] = useState(false);
  const [persist, setPersist] = useState(
    snapshot.gemini.secureStorageAvailable,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = useMemo(() => modelChoices(snapshot, "gemini"), [snapshot]);
  const selected = snapshot.gemini.selectedModel;
  const selectedChoice = choices.find(
    (choice) => choice.model.name === selected,
  );
  const showCredentialField = !snapshot.gemini.apiKeyConfigured || replaceMode;
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (caught) {
      setError(geminiActionError(caught));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      await window.chromecraft.setGeminiApiKey({
        apiKey: apiKey.trim(),
        persist,
      });
      setApiKey("");
      setReplaceMode(false);
    });

  return (
    <div className="scout-settings-page">
      <SubpageHeader
        title="Google Gemini"
        subtitle="Use Google's Gemini models with your own API key."
        logo={<GeminiLogo />}
        status={statusLabel("gemini", snapshot)}
        back={() => navigate("providers")}
      />
      <section className="scout-section" id="setting-gemini-api-key">
        <div className="scout-section-heading">
          <span>
            <h4>API key</h4>
            <p>Stored outside websites and never exposed to page content.</p>
          </span>
          <a
            href="https://aistudio.google.com/apikey"
            onClick={(event) => {
              event.preventDefault();
              void window.chromecraft.createTab(
                "https://aistudio.google.com/apikey",
              );
            }}
          >
            Google AI Studio <MaterialIcon name="open_in_new" />
          </a>
        </div>
        {showCredentialField ? (
          <div className="scout-credential-editor">
            <label className="scout-credential-field">
              <span>Gemini API key</span>
              <span className="scout-credential-input">
                <input
                  autoFocus={replaceMode}
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your API key"
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <button
                  type="button"
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  onClick={() => setShowKey((value) => !value)}
                >
                  <MaterialIcon
                    name={showKey ? "visibility_off" : "visibility"}
                  />
                </button>
              </span>
            </label>
            <div className="scout-action-row">
              <button
                type="button"
                className="scout-filled-button"
                disabled={busy || !apiKey.trim()}
                onClick={() => void save()}
              >
                {busy
                  ? "Testing…"
                  : snapshot.gemini.apiKeyConfigured
                    ? "Replace and test"
                    : "Save and test"}
              </button>
              {replaceMode && (
                <button
                  type="button"
                  className="scout-text-button"
                  onClick={() => setReplaceMode(false)}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="scout-configured-credential">
            <span className="scout-masked-key">
              <MaterialIcon name="key" /> ••••••••••••••••
            </span>
            <div className="scout-action-row">
              <button
                type="button"
                className="scout-tonal-button"
                onClick={() => setReplaceMode(true)}
              >
                Replace key
              </button>
              <button
                type="button"
                className="scout-text-button"
                disabled={busy}
                onClick={() =>
                  void run(() => window.chromecraft.refreshAiModels("gemini"))
                }
              >
                Test connection
              </button>
              <button
                type="button"
                className="scout-text-button scout-danger-button"
                disabled={busy}
                onClick={() =>
                  void run(() => window.chromecraft.removeGeminiApiKey())
                }
              >
                Remove key
              </button>
            </div>
          </div>
        )}
        {(error || snapshot.gemini.error) && (
          <p className="scout-inline-message" data-tone="error" role="alert">
            <MaterialIcon name="error" /> {error ?? snapshot.gemini.error}
          </p>
        )}
        <details className="scout-advanced-disclosure">
          <summary>Advanced credential storage</summary>
          <label className="scout-compact-switch">
            <span>
              <strong>Remember securely on this device</strong>
              <small>
                {snapshot.gemini.secureStorageAvailable
                  ? "Uses operating-system credential encryption."
                  : "Secure storage is unavailable; keys remain in memory for this session."}
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch-input"
              checked={persist}
              disabled={!snapshot.gemini.secureStorageAvailable}
              onChange={(event) => setPersist(event.target.checked)}
            />
          </label>
        </details>
      </section>
      <section className="scout-section" id="setting-gemini-model">
        <div className="scout-section-heading">
          <span>
            <h4>Available models</h4>
            <p>Only verified text-generation models appear here.</p>
          </span>
          <button
            type="button"
            className="scout-icon-button"
            aria-label="Refresh Gemini models"
            disabled={!snapshot.gemini.apiKeyConfigured || busy}
            onClick={() =>
              void run(() => window.chromecraft.refreshAiModels("gemini"))
            }
          >
            <MaterialIcon name="refresh" />
          </button>
        </div>
        <div className="scout-recommended-model">
          <span className="scout-recommended-model__icon">
            <MaterialIcon name="bolt" />
          </span>
          <span>
            <small>
              {selectedChoice?.model.recommended
                ? "RECOMMENDED · FAST"
                : "CURRENT MODEL"}
            </small>
            <strong>
              {selectedChoice?.model.displayName ??
                selected ??
                "Choose a compatible model"}
            </strong>
            <p>
              {selectedChoice?.description ??
                "Select a verified model for Scout conversations."}
            </p>
          </span>
          <ScoutModelPicker
            choices={choices}
            value={selected ? { provider: "gemini", model: selected } : null}
            provider="gemini"
            label="Choose model"
            helperText="Search fast, balanced and advanced compatible models."
            disabled={!choices.length}
            onSelect={(choice) =>
              void window.chromecraft.setAiModel("gemini", choice.model.name)
            }
          />
        </div>
      </section>
    </div>
  );
}

function OllamaPage({
  snapshot,
  navigate,
}: {
  snapshot: AiToolsSnapshot;
  navigate: (page: ScoutSettingsPage) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scout-settings-page">
      <SubpageHeader
        title="Local Ollama"
        subtitle="Run Scout privately with models installed on this device."
        logo={<OllamaLogo />}
        status={statusLabel("ollama", snapshot)}
        back={() => navigate("providers")}
      />
      <section className="scout-section" id="setting-ollama-provider">
        <div className="scout-info-row">
          <span>
            <small>LOCAL ENDPOINT</small>
            <strong>{snapshot.ollama.endpoint}</strong>
          </span>
          <button
            type="button"
            className="scout-tonal-button"
            disabled={busy}
            onClick={() =>
              void run(() => window.chromecraft.refreshAiModels("ollama"))
            }
          >
            <MaterialIcon name="refresh" />{" "}
            {busy ? "Checking…" : "Refresh models"}
          </button>
        </div>
        {snapshot.ollama.error && (
          <p className="scout-inline-message" data-tone="error">
            <MaterialIcon name="error" />
            {snapshot.ollama.error}
          </p>
        )}
      </section>
      <section className="scout-section">
        <div className="scout-section-heading">
          <span>
            <h4>Installed models</h4>
            <p>{snapshot.ollama.models.length} available to Chromecraft.</p>
          </span>
          <button
            type="button"
            className="scout-text-button"
            onClick={() =>
              void window.chromecraft.createTab("https://ollama.com/library")
            }
          >
            Browse Ollama library <MaterialIcon name="open_in_new" />
          </button>
        </div>
        <div className="scout-model-list">
          {snapshot.ollama.models.map((model) => (
            <div className="scout-model-row" key={model.name}>
              <span className="scout-model-row__mark">
                <OllamaLogo />
              </span>
              <span>
                <strong>{model.displayName ?? model.name}</strong>
                <small>
                  {[model.family, model.parameterSize, formatBytes(model.size)]
                    .filter(Boolean)
                    .join(" · ") || "Installed locally"}
                </small>
              </span>
              {model.name === snapshot.organiserModels.ollama && (
                <span className="scout-task-chip">Organiser</span>
              )}
              {model.name === snapshot.ollama.selectedModel && (
                <span className="scout-task-chip">Scout</span>
              )}
            </div>
          ))}
          {snapshot.ollama.models.length === 0 && (
            <div className="scout-empty-state">
              <MaterialIcon name="deployed_code" />
              <strong>No models found</strong>
              <p>
                Start Ollama, then refresh or install Chromecraft's lightweight
                recommendation.
              </p>
              <button
                type="button"
                className="scout-filled-button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    window.chromecraft.installRecommendedOllamaModel(),
                  )
                }
              >
                Install qwen3:1.7b
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ModelsPage({
  snapshot,
  navigate,
}: {
  snapshot: AiToolsSnapshot;
  navigate: (page: ScoutSettingsPage) => void;
}) {
  const allChoices = useMemo(() => modelChoices(snapshot), [snapshot]);
  const ollamaChoices = useMemo(
    () => modelChoices(snapshot, "ollama"),
    [snapshot],
  );
  const geminiChoices = useMemo(
    () => modelChoices(snapshot, "gemini"),
    [snapshot],
  );
  const selectConversation = async (choice: ScoutModelChoice) => {
    if (choice.provider !== snapshot.provider) {
      await window.chromecraft.setAiProvider(choice.provider);
    }
    await window.chromecraft.setAiModel(choice.provider, choice.model.name);
  };
  const selectOrganisationMethod = async (method: "website" | AiProviderId) => {
    if (method === "website") {
      await window.chromecraft.setAiGroupingMode("website");
      return;
    }
    await window.chromecraft.setAiGroupingMode("smart");
    await window.chromecraft.setAiOrganiserProvider(method);
  };
  const method =
    snapshot.preferredGroupingMode === "website"
      ? "website"
      : snapshot.organiserProvider;
  return (
    <div className="scout-settings-page">
      <SubpageHeader
        title="Models & performance"
        subtitle="Give each Scout task the right model without changing the others."
        back={() => navigate("home")}
      />
      <section className="scout-section" id="setting-scout-model">
        <div className="scout-section-heading">
          <span>
            <h4>Scout conversation model</h4>
            <p>This is the model selected by Scout Power in the sidebar.</p>
          </span>
          <button
            type="button"
            className="scout-text-button"
            onClick={() => dispatchEvent(new Event("chromecraft-open-scout"))}
          >
            Open Scout Power <MaterialIcon name="tune" />
          </button>
        </div>
        <ScoutModelPicker
          choices={allChoices}
          value={
            snapshot.selectedModel
              ? { provider: snapshot.provider, model: snapshot.selectedModel }
              : null
          }
          label="Conversation model"
          helperText="Available installed and connected text models."
          disabled={!allChoices.length}
          onSelect={(choice) => void selectConversation(choice)}
        />
      </section>
      <section className="scout-section" id="setting-tab-organiser-model">
        <div className="scout-section-heading">
          <span>
            <h4>Tab organiser</h4>
            <p>Lightweight defaults used only when organising tabs.</p>
          </span>
        </div>
        <div
          className="scout-segmented-control"
          role="radiogroup"
          aria-label="Default tab organisation method"
        >
          {(["gemini", "ollama", "website"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={method === value}
              onClick={() => void selectOrganisationMethod(value)}
            >
              <MaterialIcon
                name={
                  value === "website"
                    ? "language"
                    : value === "ollama"
                      ? "memory"
                      : "auto_awesome"
                }
              />
              {value === "website"
                ? "Sort by website"
                : value === "ollama"
                  ? "Ollama"
                  : "Gemini"}
            </button>
          ))}
        </div>
        <div className="scout-task-model-grid">
          <ScoutModelPicker
            choices={ollamaChoices}
            provider="ollama"
            value={
              snapshot.organiserModels.ollama
                ? { provider: "ollama", model: snapshot.organiserModels.ollama }
                : null
            }
            label="Ollama organiser model"
            helperText="Prefer a small model for quick local grouping."
            disabled={!ollamaChoices.length}
            onSelect={(choice) =>
              void window.chromecraft.setAiOrganiserModel(
                "ollama",
                choice.model.name,
              )
            }
          />
          <ScoutModelPicker
            choices={geminiChoices}
            provider="gemini"
            value={
              snapshot.organiserModels.gemini
                ? { provider: "gemini", model: snapshot.organiserModels.gemini }
                : null
            }
            label="Gemini organiser model"
            helperText="A separate compatible cloud model for grouping."
            disabled={!geminiChoices.length}
            onSelect={(choice) =>
              void window.chromecraft.setAiOrganiserModel(
                "gemini",
                choice.model.name,
              )
            }
          />
        </div>
        <p className="scout-supporting-note">
          <MaterialIcon name="info" /> Changing either organiser model does not
          change Scout's active conversation model.
        </p>
      </section>
    </div>
  );
}

function PrivacyPage({
  navigate,
}: {
  navigate: (page: ScoutSettingsPage) => void;
}) {
  const [defaults, setDefaults] = useState(readContextDefaults);
  const [reduceMotion, setReduceMotion] = useState(
    () =>
      typeof localStorage !== "undefined" &&
      localStorage.getItem(SCOUT_REDUCED_MOTION_STORAGE_KEY) === "true",
  );
  const update = (
    kind: keyof AssistantContextPreferences,
    enabled: boolean,
  ) => {
    const next = { ...defaults, [kind]: enabled };
    setDefaults(next);
    localStorage.setItem(
      SCOUT_CONTEXT_DEFAULTS_STORAGE_KEY,
      JSON.stringify(next),
    );
    dispatchEvent(new Event("scout-context-defaults-changed"));
  };
  const items: Array<
    [keyof AssistantContextPreferences, string, string, string]
  > = [
    ["url", "Page URL", "The address of the page you are viewing.", "link"],
    ["title", "Page title", "The title shown in the current tab.", "title"],
    [
      "description",
      "Page description",
      "The description supplied by the website.",
      "subject",
    ],
    [
      "selected-text",
      "Selected text",
      "Include highlighted text when it is available.",
      "select",
    ],
    [
      "screenshot",
      "Screenshot capture",
      "Allow explicit screenshot capture from Scout's plus menu.",
      "screenshot",
    ],
    [
      "element",
      "Element selection",
      "Allow explicit point-and-select page inspection.",
      "ads_click",
    ],
  ];
  return (
    <div className="scout-settings-page">
      <SubpageHeader
        title="Privacy & context"
        subtitle="Decide what Scout can add to a prompt and what remains stored locally."
        back={() => navigate("home")}
      />
      <div className="scout-privacy-notice">
        <MaterialIcon name="privacy_tip" />
        <span>
          <strong>Local by default</strong>
          <p>
            Ollama context stays on this device. When Gemini is selected, only
            context attached to the prompt is sent to Google after consent.
          </p>
        </span>
      </div>
      <section className="scout-section" id="setting-scout-context">
        <div className="scout-section-heading">
          <span>
            <h4>Default webpage context</h4>
            <p>
              These choices preselect compact controls in Scout's plus menu.
            </p>
          </span>
        </div>
        <div className="scout-context-list">
          {items.map(([kind, title, description, icon]) => (
            <label className="scout-context-row" key={kind}>
              <span className="scout-context-row__icon">
                <MaterialIcon name={icon} />
              </span>
              <span>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch-input"
                checked={defaults[kind]}
                onChange={(event) => update(kind, event.target.checked)}
              />
            </label>
          ))}
        </div>
      </section>
      <section className="scout-section" id="setting-scout-preferences">
        <div className="scout-section-heading">
          <span>
            <h4>Local data & motion</h4>
            <p>Conversation history belongs to this Chromecraft profile.</p>
          </span>
        </div>
        <label className="scout-context-row">
          <span className="scout-context-row__icon">
            <MaterialIcon name="motion_mode" />
          </span>
          <span>
            <strong>Reduce Scout animations</strong>
            <small>
              Stops character and interface motion independently of system
              settings.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            checked={reduceMotion}
            onChange={(event) => {
              const enabled = event.target.checked;
              setReduceMotion(enabled);
              localStorage.setItem(
                SCOUT_REDUCED_MOTION_STORAGE_KEY,
                String(enabled),
              );
              document.documentElement.dataset.scoutReducedMotion =
                String(enabled);
            }}
          />
        </label>
        <div className="scout-data-action">
          <span>
            <strong>Conversation history</strong>
            <small>
              Messages are stored locally. Captured page contents and
              screenshots are not persisted.
            </small>
          </span>
          <button
            type="button"
            className="scout-tonal-button"
            onClick={() => {
              localStorage.removeItem(HISTORY_STORAGE_KEY);
              dispatchEvent(new Event(HISTORY_CLEARED_EVENT));
            }}
          >
            Clear history
          </button>
        </div>
      </section>
    </div>
  );
}

export function ScoutSettings({
  aiTools,
  highlightedSettingId,
}: {
  aiTools: AiToolsSnapshot;
  highlightedSettingId: string | null;
}) {
  const [page, setPage] = useState<ScoutSettingsPage>(
    () => pageForTarget(highlightedSettingId) ?? "home",
  );
  const targetPage = pageForTarget(highlightedSettingId);
  const activePage = targetPage ?? page;

  useEffect(() => {
    if (targetPage) setPage(targetPage);
  }, [targetPage]);

  return (
    <div className="scout-settings-shell" data-page={activePage}>
      {activePage === "home" && <HomePage navigate={setPage} />}
      {activePage === "providers" && (
        <ProvidersPage snapshot={aiTools} navigate={setPage} />
      )}
      {activePage === "gemini" && (
        <GeminiPage snapshot={aiTools} navigate={setPage} />
      )}
      {activePage === "ollama" && (
        <OllamaPage snapshot={aiTools} navigate={setPage} />
      )}
      {activePage === "models" && (
        <ModelsPage snapshot={aiTools} navigate={setPage} />
      )}
      {activePage === "privacy" && <PrivacyPage navigate={setPage} />}
    </div>
  );
}
