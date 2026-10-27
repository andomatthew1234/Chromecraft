import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import bitwardenLogoUrl from "../../docs/assets/extensions/bitwarden.svg";
import trustpilotLogoUrl from "../../docs/assets/extensions/trustpilot.svg";
import ublockLogoUrl from "../../docs/assets/extensions/ublock-origin.svg";
import type {
  BrowserSnapshot,
  ExtensionInstallPreviewSnapshot,
  ExtensionsSnapshot,
} from "../shared/browser";
import type { AiToolsSnapshot } from "../shared/ai-tools";
import {
  ONBOARDING_OLLAMA_MODELS,
  REQUIRED_ONBOARDING_OLLAMA_MODEL,
  type GeminiClipboardDetectionSnapshot,
  type OnboardingLocalAiSnapshot,
  type OnboardingOllamaModel,
  type OnboardingRecommendedSettings,
} from "../shared/onboarding";
import type { UpdateSnapshot } from "../shared/updates";
import chromecraftLogoUrl from "./assets/chromecraft-logo.png";
import { GeminiLogo, OllamaLogo } from "./ScoutProviderLogo";

type OnboardingPage =
  | "features"
  | "essentials"
  | "ai"
  | "gemini"
  | "local-ai"
  | "settings"
  | "updates";
type GeminiPhase = "intro" | "guide" | "confirm" | "manual" | "ready";
export type AiSetupChoice = "gemini" | "ollama" | "skip";

interface RecommendedExtension {
  id: string;
  name: string;
  description: string;
  itemUrl: string | null;
  logoUrl: string | null;
  icon: string;
  included?: boolean;
  teamNote?: string;
}

export const recommendedExtensions: readonly RecommendedExtension[] = [
  {
    id: "ublock-origin",
    name: "uBlock Origin",
    description:
      "Included out of the box for stronger privacy, security, and ad blocking.",
    itemUrl: null,
    logoUrl: ublockLogoUrl,
    icon: "shield",
    included: true,
  },
  {
    id: "nngceckbapebfimnlniiiahkandclblb",
    name: "Bitwarden",
    description: "Store and remember your passwords with passkey support.",
    itemUrl:
      "https://chromewebstore.google.com/detail/nngceckbapebfimnlniiiahkandclblb",
    logoUrl: bitwardenLogoUrl,
    icon: "password",
  },
  {
    id: "dimkjjladgaekdlfebknbaooicmfalke",
    name: "Trustpilot",
    description: "See your fellow business reviews out the box.",
    itemUrl:
      "https://chromewebstore.google.com/detail/dimkjjladgaekdlfebknbaooicmfalke",
    logoUrl: trustpilotLogoUrl,
    icon: "star",
  },
  {
    id: "pcfcokpgaghaahjkfjpnonbgfppkbhmn",
    name: "Momentum Swift",
    description: "A new tab page that actually works with you.",
    itemUrl:
      "https://chromewebstore.google.com/detail/pcfcokpgaghaahjkfjpnonbgfppkbhmn",
    logoUrl: null,
    icon: "dashboard_customize",
    teamNote: "Created by the Chromecraft/SKCORP team",
  },
  {
    id: "hlkiamolkbbnaleecldindlfddhlfhgj",
    name: "Send to Webhook",
    description:
      "Send selected page text to a webhook, including a Discord server.",
    itemUrl:
      "https://chromewebstore.google.com/detail/hlkiamolkbbnaleecldindlfddhlfhgj",
    logoUrl: null,
    icon: "webhook",
    teamNote: "Created by the Chromecraft/SKCORP team",
  },
] as const;

export function updateAiSetupChoices(
  choices: ReadonlySet<AiSetupChoice>,
  choice: AiSetupChoice,
): Set<AiSetupChoice> {
  if (choice === "skip") {
    return choices.has("skip") ? new Set() : new Set(["skip"]);
  }
  const next = new Set(choices);
  next.delete("skip");
  if (next.has(choice)) next.delete(choice);
  else next.add(choice);
  return next;
}

function MaterialIcon({ name }: { name: string }) {
  return (
    <span className="material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

function StepHeader({ page }: { page: OnboardingPage }) {
  const current =
    page === "features"
      ? 1
      : page === "essentials"
        ? 2
        : page === "ai" || page === "gemini" || page === "local-ai"
          ? 3
          : page === "settings"
            ? 4
            : 5;
  return (
    <header className="onboarding-topbar">
      <span className="onboarding-wordmark">
        <span className="onboarding-wordmark-mark" aria-hidden="true">
          <img src={chromecraftLogoUrl} alt="" draggable={false} />
        </span>
        Chromecraft
      </span>
      <span className="onboarding-progress" aria-label={`Step ${current} of 5`}>
        {[1, 2, 3, 4, 5].map((step) => (
          <span
            key={step}
            className={step <= current ? "is-complete" : undefined}
          />
        ))}
      </span>
      <span className="onboarding-step-label">
        {page === "gemini" || page === "local-ai"
          ? "AI setup"
          : `Step ${current} of 5`}
      </span>
    </header>
  );
}

function FooterActions({
  back,
  next,
  nextLabel = "Continue",
  nextDisabled = false,
  helper,
}: {
  back?: () => void;
  next?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  helper?: string;
}) {
  return (
    <footer className="onboarding-footer">
      <span className="onboarding-footer-helper">{helper}</span>
      <div className="onboarding-footer-actions">
        {back && (
          <button
            type="button"
            className="onboarding-button text"
            onClick={back}
          >
            <MaterialIcon name="arrow_back" /> Back
          </button>
        )}
        {next && (
          <button
            type="button"
            className="onboarding-button filled"
            disabled={nextDisabled}
            onClick={next}
          >
            {nextLabel} <MaterialIcon name="arrow_forward" />
          </button>
        )}
      </div>
    </footer>
  );
}

function FeaturesPage({ next }: { next: () => void }) {
  return (
    <div className="onboarding-page onboarding-page-features">
      <section className="onboarding-heading-block">
        <span className="onboarding-eyebrow">Welcome to Chromecraft</span>
        <h1>Get to know us.</h1>
        <p>
          Take a quick look at the best features of the world&apos;s best
          browser.
        </p>
      </section>
      <div className="onboarding-feature-grid">
        <article className="onboarding-feature-card feature-speed">
          <span
            className="onboarding-custom-icon icon-speed"
            aria-hidden="true"
          >
            <MaterialIcon name="speed" />
          </span>
          <span className="onboarding-card-index">01</span>
          <h2>A browser that gets you.</h2>
          <p>
            Design that just works. Hyperdrive-accelerated performance. Speed
            that matters.
          </p>
        </article>
        <article className="onboarding-feature-card feature-ai">
          <span className="onboarding-custom-icon icon-ai" aria-hidden="true">
            <MaterialIcon name="auto_awesome" />
          </span>
          <span className="onboarding-card-index">02</span>
          <h2>AI powered. Or not.</h2>
          <p>
            AI features that power through your day. Choose on-device models,
            Gemini in the cloud, or none at all.
          </p>
        </article>
        <article className="onboarding-feature-card feature-privacy">
          <span
            className="onboarding-custom-icon icon-privacy"
            aria-hidden="true"
          >
            <MaterialIcon name="shield_lock" />
          </span>
          <span className="onboarding-card-index">03</span>
          <h2>Privacy, security, and ease of mind out the box.</h2>
          <p>
            Enjoy no ads, no tracking, and no website telemetry out of the box,
            powered by uBlock Origin.
          </p>
        </article>
      </div>
      <FooterActions next={next} nextLabel="Meet your browser" />
    </div>
  );
}

function ExtensionLogo({ item }: { item: RecommendedExtension }) {
  const [failed, setFailed] = useState(false);

  if (!item.logoUrl || failed) {
    return <MaterialIcon name={item.icon} />;
  }

  return (
    <img
      src={item.logoUrl}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function EssentialsPage({
  extensions,
  back,
  next,
}: {
  extensions: ExtensionsSnapshot;
  back: () => void;
  next: () => void;
}) {
  const [preview, setPreview] =
    useState<ExtensionInstallPreviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const installedIds = useMemo(
    () => new Set(extensions.items.map((item) => item.id)),
    [extensions.items],
  );
  const busy = extensions.operation !== "idle";

  const prepare = async (item: RecommendedExtension) => {
    if (!item.itemUrl || busy) return;
    setError(null);
    try {
      setPreview(
        await window.chromecraft.prepareExtensionFromWebStore(item.itemUrl),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Chromecraft could not prepare that extension.",
      );
    }
  };

  const cancelPreview = async () => {
    if (!preview) return;
    const token = preview.token;
    setPreview(null);
    await window.chromecraft
      .cancelPreparedExtension(token)
      .catch(() => undefined);
  };

  const installPreview = async () => {
    if (!preview) return;
    setError(null);
    try {
      await window.chromecraft.commitPreparedExtension(preview.token);
      setPreview(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Chromecraft could not install that extension.",
      );
    }
  };

  useEffect(
    () => () => {
      if (preview) {
        void window.chromecraft.cancelPreparedExtension(preview.token);
      }
    },
    [preview],
  );

  return (
    <div className="onboarding-page onboarding-page-essentials">
      <section className="onboarding-heading-block compact">
        <span className="onboarding-eyebrow">Make it yours</span>
        <h1>Choose some essentials.</h1>
        <p>What would you like to go with your browser?</p>
      </section>
      <div className="onboarding-extension-grid">
        {recommendedExtensions.map((item) => {
          const installed = item.included || installedIds.has(item.id);
          const active = extensions.operationExtensionId === item.id;
          return (
            <article className="onboarding-extension-card" key={item.id}>
              <span className="onboarding-extension-logo">
                <ExtensionLogo item={item} />
              </span>
              <span className="onboarding-extension-copy">
                <strong>{item.name}</strong>
                <span>{item.description}</span>
                {item.teamNote && <small>{item.teamNote}</small>}
              </span>
              {installed ? (
                <span className="onboarding-extension-status included">
                  <MaterialIcon name="check_circle" /> Included
                </span>
              ) : (
                <button
                  type="button"
                  className="onboarding-add-button"
                  disabled={busy}
                  onClick={() => void prepare(item)}
                >
                  {active ? "Working..." : "Add"}
                </button>
              )}
            </article>
          );
        })}
      </div>
      {(error || extensions.error) && (
        <p className="onboarding-inline-error" role="alert">
          <MaterialIcon name="error" /> {error ?? extensions.error}
        </p>
      )}
      <FooterActions back={back} next={next} />
      {preview && (
        <div className="onboarding-review-layer" role="presentation">
          <section
            className="onboarding-review-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-extension-review-title"
          >
            <span className="onboarding-review-icon">
              <MaterialIcon name="extension" />
            </span>
            <div>
              <span className="onboarding-eyebrow">Review before adding</span>
              <h2 id="onboarding-extension-review-title">
                Add {preview.name}?
              </h2>
              <p>{preview.description || `Version ${preview.version}`}</p>
            </div>
            <div className="onboarding-permission-summary">
              <strong>Requested access</strong>
              {preview.permissions.length === 0 &&
              preview.hostPermissions.length === 0 ? (
                <span>No broad permissions declared.</span>
              ) : (
                <ul>
                  {[...preview.permissions, ...preview.hostPermissions]
                    .slice(0, 6)
                    .map((permission) => (
                      <li key={permission}>{permission}</li>
                    ))}
                </ul>
              )}
              {preview.warnings.map((warning) => (
                <p className="onboarding-review-warning" key={warning}>
                  <MaterialIcon name="info" /> {warning}
                </p>
              ))}
            </div>
            <div className="onboarding-review-actions">
              <button
                type="button"
                className="onboarding-button text"
                onClick={() => void cancelPreview()}
              >
                Cancel
              </button>
              <button
                type="button"
                className="onboarding-button filled"
                onClick={() => void installPreview()}
              >
                Add extension
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ChoiceMark({ selected }: { selected: boolean }) {
  return (
    <span className="onboarding-choice-mark" aria-hidden="true">
      <MaterialIcon name={selected ? "check" : "add"} />
    </span>
  );
}

function AiChoicePage({
  choices,
  choose,
  back,
  next,
}: {
  choices: ReadonlySet<AiSetupChoice>;
  choose: (choice: AiSetupChoice) => void;
  back: () => void;
  next: () => void;
}) {
  const hasAny = choices.size > 0;
  return (
    <div className="onboarding-page onboarding-page-ai">
      <section className="onboarding-heading-block compact">
        <span className="onboarding-eyebrow">Scout power</span>
        <h1>Let&apos;s work out AI.</h1>
        <p>
          Select one, select both, or leave AI out. You stay in control of what
          Chromecraft sets up.
        </p>
      </section>
      <div
        className="onboarding-choice-grid"
        role="group"
        aria-label="AI setup choices"
      >
        <button
          type="button"
          className="onboarding-choice-card choice-gemini"
          aria-pressed={choices.has("gemini")}
          onClick={() => choose("gemini")}
        >
          <span className="onboarding-provider-logo">
            <GeminiLogo />
          </span>
          <ChoiceMark selected={choices.has("gemini")} />
          <span className="onboarding-choice-copy">
            <strong>Set up Gemini in your browser.</strong>
            <span>
              Use cloud models powered by Gemini intelligence with a Gemini API
              key.
            </span>
          </span>
        </button>
        <button
          type="button"
          className="onboarding-choice-card choice-ollama"
          aria-pressed={choices.has("ollama")}
          onClick={() => choose("ollama")}
        >
          <span className="onboarding-provider-logo">
            <OllamaLogo />
          </span>
          <ChoiceMark selected={choices.has("ollama")} />
          <span className="onboarding-choice-copy">
            <strong>Set up local AI in your browser.</strong>
            <span>
              Run local AI powered by Ollama on your PC with no usage limits.
            </span>
          </span>
        </button>
        <button
          type="button"
          className="onboarding-choice-card choice-skip"
          aria-pressed={choices.has("skip")}
          onClick={() => choose("skip")}
        >
          <span className="onboarding-provider-logo skip-logo">
            <MaterialIcon name="smart_toy" />
            <span />
          </span>
          <ChoiceMark selected={choices.has("skip")} />
          <span className="onboarding-choice-copy">
            <strong>Skip setting up AI for now.</strong>
            <span>
              You can set up Gemini or download local models later in Settings.
            </span>
          </span>
        </button>
      </div>
      <FooterActions
        back={back}
        next={next}
        nextLabel={choices.has("skip") ? "Continue without AI" : "Start setup"}
        nextDisabled={!hasAny}
        helper="You can change providers and models later in Settings."
      />
    </div>
  );
}

function GeminiSteps({ active }: { active: number }) {
  const steps = [
    ["Log into Google", "Log in or sign up to your Google account."],
    [
      "Create your key",
      'Select "Create API key". Give it a name, or leave the default, then create it.',
    ],
    ["Copy the API key", "Copy your new API key to the clipboard."],
  ] as const;
  return (
    <ol className="onboarding-gemini-steps">
      {steps.map(([title, description], index) => (
        <li
          className={index + 1 <= active ? "is-active" : undefined}
          key={title}
        >
          <span>{index + 1}</span>
          <div>
            <strong>{title}</strong>
            <p>{description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function GeminiSetupPage({
  aiTools,
  back,
  next,
}: {
  aiTools: AiToolsSnapshot;
  back: () => void;
  next: () => void;
}) {
  const [phase, setPhase] = useState<GeminiPhase>("intro");
  const [clipboard, setClipboard] = useState<GeminiClipboardDetectionSnapshot>({
    state: "idle",
    stageId: null,
    maskedKey: null,
  });
  const [manualKey, setManualKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const persist = aiTools.gemini.secureStorageAvailable;

  useEffect(
    () =>
      window.chromecraft.onOnboardingGeminiClipboard((next) => {
        setClipboard(next);
        if (next.state === "detected") {
          setAgreed(false);
          setError(null);
          setPhase("confirm");
        }
      }),
    [],
  );

  useLayoutEffect(() => {
    if (phase !== "guide" || !frame.current) return;
    const update = () => {
      const bounds = frame.current?.getBoundingClientRect();
      if (!bounds || bounds.width < 320 || bounds.height < 240) return;
      void window.chromecraft.setOnboardingGeminiViewBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame.current);
    addEventListener("resize", update);
    return () => {
      observer.disconnect();
      removeEventListener("resize", update);
    };
  }, [phase]);

  useEffect(
    () => () => {
      void window.chromecraft.stopOnboardingGeminiSetup();
    },
    [],
  );

  const startGuide = async () => {
    setError(null);
    setAgreed(false);
    setPhase("guide");
    try {
      setClipboard(await window.chromecraft.startOnboardingGeminiSetup());
    } catch (caught) {
      setPhase("intro");
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not open Google AI Studio.",
      );
    }
  };

  const openManual = async () => {
    setError(null);
    try {
      await window.chromecraft.openOnboardingGeminiSetupExternal();
      setPhase("manual");
      setAgreed(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not open your default browser.",
      );
    }
  };

  const restartGuide = async () => {
    await window.chromecraft.stopOnboardingGeminiSetup();
    setClipboard({ state: "idle", stageId: null, maskedKey: null });
    await startGuide();
  };

  const finish = async (operation: () => Promise<AiToolsSnapshot>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await window.chromecraft.setAiProvider("gemini");
      await window.chromecraft.stopOnboardingGeminiSetup();
      setPhase("ready");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Chromecraft could not verify that Gemini API key.",
      );
    } finally {
      setBusy(false);
    }
  };

  const commitDetected = () => {
    if (!clipboard.stageId || !agreed) return;
    void finish(() =>
      window.chromecraft.commitOnboardingGeminiClipboardKey({
        stageId: clipboard.stageId!,
        persist,
      }),
    );
  };

  const commitManual = () => {
    if (!manualKey.trim() || !agreed) return;
    void finish(() =>
      window.chromecraft.setGeminiApiKey({
        apiKey: manualKey.trim(),
        persist,
      }),
    );
  };

  const handleManualKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && agreed && manualKey.trim() && !busy) {
      event.preventDefault();
      commitManual();
    }
  };

  if (phase === "intro") {
    return (
      <div className="onboarding-page onboarding-gemini-intro">
        <div className="onboarding-gemini-hero">
          <span className="onboarding-gemini-logo">
            <GeminiLogo />
          </span>
          <span className="onboarding-eyebrow">Gemini intelligence</span>
          <h1>Let&apos;s setup Gemini powered intelligence.</h1>
          <p>Use Gemini in your browser AI features.</p>
          <button
            type="button"
            className="onboarding-button filled large"
            data-gemini-setup="in-app"
            onClick={() => void startGuide()}
          >
            Let&apos;s go <MaterialIcon name="arrow_forward" />
          </button>
          {error && (
            <p className="onboarding-inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <FooterActions back={back} />
      </div>
    );
  }

  if (phase === "ready") {
    return (
      <div className="onboarding-page onboarding-gemini-ready">
        <div className="onboarding-ready-mark">
          <MaterialIcon name="check" />
        </div>
        <span className="onboarding-eyebrow">Connection verified</span>
        <h1>Gemini is ready.</h1>
        <p>
          Your API key passed Chromecraft&apos;s connection test and is stored
          {persist ? " with operating-system encryption" : " for this session"}.
        </p>
        <button
          type="button"
          className="onboarding-button filled large"
          onClick={next}
        >
          Continue <MaterialIcon name="arrow_forward" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`onboarding-page onboarding-gemini-workspace phase-${phase}`}
    >
      <aside className="onboarding-gemini-instructions">
        <button
          type="button"
          className="onboarding-icon-button"
          aria-label="Back to AI choices"
          onClick={() => {
            void window.chromecraft.stopOnboardingGeminiSetup();
            back();
          }}
        >
          <MaterialIcon name="arrow_back" />
        </button>
        <span className="onboarding-gemini-mini-logo">
          <GeminiLogo />
        </span>
        <span className="onboarding-eyebrow">Gemini API key</span>
        <h1>Three quick steps.</h1>
        <p>
          Chromecraft watches only for a newly copied Gemini key during this
          setup.
        </p>
        <GeminiSteps active={phase === "guide" ? 2 : 3} />
        <p className="onboarding-clipboard-note">
          <MaterialIcon name="content_paste" />
          {clipboard.state === "expired"
            ? "Clipboard detection timed out. Go back and start again."
            : clipboard.state === "listening"
              ? "Waiting for a Gemini API key to be copied"
              : "Nothing else from your clipboard is retained"}
        </p>
      </aside>
      <section className="onboarding-gemini-stage">
        {phase === "guide" && (
          <>
            <div className="onboarding-native-frame" ref={frame}>
              <span>
                <MaterialIcon name="language" /> Opening Google AI Studio...
              </span>
            </div>
            <button
              type="button"
              className="onboarding-external-setup"
              onClick={() => void openManual()}
            >
              <MaterialIcon name="open_in_new" />
              <span>
                <strong>I know what I&apos;m doing, setup in browser</strong>
                <small>
                  Open Google AI Studio in your default browser and enter the
                  key manually.
                </small>
              </span>
            </button>
          </>
        )}
        {phase === "confirm" && (
          <div className="onboarding-confirm-card">
            <span className="onboarding-confirm-icon">
              <MaterialIcon name="key" />
            </span>
            <span className="onboarding-eyebrow">Key detected</span>
            <h2>Everything look right?</h2>
            <p>
              Ready to unleash Gemini? Chromecraft will test this key before
              saving it.
            </p>
            <span className="onboarding-masked-key">{clipboard.maskedKey}</span>
            <Agreement checked={agreed} setChecked={setAgreed} />
            {error && (
              <p className="onboarding-inline-error" role="alert">
                <MaterialIcon name="error" /> {error}
              </p>
            )}
            <div className="onboarding-confirm-actions">
              <button
                type="button"
                className="onboarding-button text"
                disabled={busy}
                onClick={() => void restartGuide()}
              >
                Go back
              </button>
              <button
                type="button"
                className="onboarding-button filled"
                disabled={!agreed || busy}
                onClick={commitDetected}
              >
                {busy ? "Testing..." : "Continue"}
              </button>
            </div>
          </div>
        )}
        {phase === "manual" && (
          <div className="onboarding-confirm-card manual">
            <span className="onboarding-confirm-icon">
              <MaterialIcon name="password" />
            </span>
            <span className="onboarding-eyebrow">Manual setup</span>
            <h2>Copy or paste your Gemini API key.</h2>
            <p>
              Chromecraft will detect a copied key automatically, or you can
              paste it below. It is tested before being stored.
            </p>
            <label className="onboarding-key-field">
              <span>Gemini API key</span>
              <span>
                <input
                  autoFocus
                  type={showKey ? "text" : "password"}
                  value={manualKey}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your API key"
                  onChange={(event) => setManualKey(event.target.value)}
                  onKeyDown={handleManualKey}
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
            <Agreement checked={agreed} setChecked={setAgreed} />
            {!persist && (
              <p className="onboarding-storage-note">
                Secure storage is unavailable, so this key will be kept for this
                session only.
              </p>
            )}
            {error && (
              <p className="onboarding-inline-error" role="alert">
                <MaterialIcon name="error" /> {error}
              </p>
            )}
            <div className="onboarding-confirm-actions">
              <button
                type="button"
                className="onboarding-button text"
                disabled={busy}
                onClick={() => void restartGuide()}
              >
                Go back
              </button>
              <button
                type="button"
                className="onboarding-button filled"
                disabled={!agreed || !manualKey.trim() || busy}
                onClick={commitManual}
              >
                {busy ? "Testing..." : "Continue"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Agreement({
  checked,
  setChecked,
}: {
  checked: boolean;
  setChecked: (checked: boolean) => void;
}) {
  return (
    <label className="onboarding-agreement">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => setChecked(event.target.checked)}
      />
      <span className="onboarding-material-checkbox">
        <MaterialIcon name="check" />
      </span>
      <span>
        <strong>I&apos;m ready to continue</strong>
        <small>By continuing, you agree to the Google AI EULA.</small>
      </span>
    </label>
  );
}

function formatBytes(value: number | null): string {
  if (value === null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function modelInstalled(models: readonly string[], model: string): boolean {
  return models.some(
    (installed) =>
      installed === model ||
      (!model.includes(":") && installed === `${model}:latest`),
  );
}

function LocalAiSetupPage({
  back,
  next,
}: {
  back: () => void;
  next: () => void;
}) {
  const [snapshot, setSnapshot] = useState<OnboardingLocalAiSnapshot>({
    service: "checking",
    installedModels: [],
    operation: null,
    error: null,
  });
  const [expanded, setExpanded] = useState<
    "service" | "models" | "default" | null
  >(null);
  const [useByDefault, setUseByDefault] = useState(true);

  useEffect(() => window.chromecraft.onOnboardingLocalAi(setSnapshot), []);
  useEffect(() => {
    void window.chromecraft
      .startOnboardingLocalAi()
      .then(setSnapshot)
      .catch((error) => {
        setSnapshot((current) => ({
          ...current,
          service: "failed",
          error:
            error instanceof Error ? error.message : "Could not check Ollama.",
        }));
      });
  }, []);

  const requiredReady = modelInstalled(
    snapshot.installedModels,
    REQUIRED_ONBOARDING_OLLAMA_MODEL,
  );
  const serviceReady = snapshot.service === "ready";
  const busy = Boolean(snapshot.operation);

  const installService = () => {
    setExpanded("service");
    void window.chromecraft.installOnboardingOllama().catch(() => undefined);
  };
  const installModel = (model: OnboardingOllamaModel) => {
    setExpanded("models");
    void window.chromecraft
      .installOnboardingOllamaModel(model)
      .catch(() => undefined);
  };
  const continueWithLocalAi = async () => {
    if (!requiredReady) return;
    if (useByDefault) {
      await window.chromecraft.refreshAiModels("ollama");
      await window.chromecraft.setAiModel(
        "ollama",
        REQUIRED_ONBOARDING_OLLAMA_MODEL,
      );
      await window.chromecraft.setAiOrganiserModel(
        "ollama",
        REQUIRED_ONBOARDING_OLLAMA_MODEL,
      );
      await window.chromecraft.setAiProvider("ollama");
      await window.chromecraft.setAiOrganiserProvider("ollama");
    }
    next();
  };

  return (
    <div className="onboarding-page onboarding-local-ai-page">
      <section className="onboarding-heading-block compact local-ai-heading">
        <span className="onboarding-provider-logo local-ai-logo">
          <OllamaLogo />
        </span>
        <div>
          <span className="onboarding-eyebrow">
            Private, on-device intelligence
          </span>
          <h1>Let&apos;s setup Local AI powered by Ollama on your device.</h1>
          <p>
            Install the local service, choose a model, and keep every prompt on
            this computer.
          </p>
        </div>
      </section>

      {snapshot.service === "checking" ? (
        <div className="onboarding-local-check" role="status">
          <span className="onboarding-spinner" />
          <div>
            <strong>Checking what you have installed...</strong>
            <span>Looking for Ollama and local models.</span>
          </div>
        </div>
      ) : (
        <div className="onboarding-local-grid">
          <article
            className={`onboarding-setup-tile ${serviceReady ? "is-complete" : ""} ${expanded === "service" ? "is-expanded" : ""}`}
          >
            <button
              type="button"
              className="onboarding-setup-tile-heading"
              onClick={() =>
                setExpanded(expanded === "service" ? null : "service")
              }
            >
              <span className="setup-tile-icon">
                <MaterialIcon name={serviceReady ? "check" : "download"} />
              </span>
              <span>
                <strong>
                  {serviceReady
                    ? "Congrats, Ollama is installed!"
                    : "Download Ollama"}
                </strong>
                <small>
                  {serviceReady
                    ? "Ollama was detected as installed on your system."
                    : "Install the local AI service."}
                </small>
              </span>
              <MaterialIcon
                name={expanded === "service" ? "expand_less" : "expand_more"}
              />
            </button>
            {expanded === "service" && (
              <div className="onboarding-setup-tile-body">
                <h2>Install the Ollama service to get started with AI.</h2>
                <p>
                  Chromecraft uses Ollama&apos;s official installer for this
                  operating system.
                </p>
                {!serviceReady && (
                  <button
                    type="button"
                    className="onboarding-button filled"
                    disabled={busy}
                    onClick={installService}
                  >
                    {snapshot.operation?.kind === "service"
                      ? "Installing..."
                      : "Download now"}
                  </button>
                )}
              </div>
            )}
          </article>

          <article
            className={`onboarding-setup-tile ${requiredReady ? "is-complete" : ""} ${expanded === "models" ? "is-expanded wide" : ""}`}
          >
            <button
              type="button"
              className="onboarding-setup-tile-heading"
              disabled={!serviceReady}
              onClick={() =>
                setExpanded(expanded === "models" ? null : "models")
              }
            >
              <span className="setup-tile-icon">
                <MaterialIcon
                  name={requiredReady ? "check" : "deployed_code"}
                />
              </span>
              <span>
                <strong>
                  {requiredReady
                    ? "Congrats, you've got some local AI models!"
                    : "Download local AI models"}
                </strong>
                <small>
                  {snapshot.installedModels.length
                    ? `${snapshot.installedModels.length} installed`
                    : "One lightweight model is required."}
                </small>
              </span>
              <MaterialIcon
                name={expanded === "models" ? "expand_less" : "expand_more"}
              />
            </button>
            {expanded === "models" && (
              <div className="onboarding-setup-tile-body model-body">
                <div className="onboarding-model-list">
                  {ONBOARDING_OLLAMA_MODELS.map((model) => {
                    const installed = modelInstalled(
                      snapshot.installedModels,
                      model,
                    );
                    const active =
                      snapshot.operation?.kind === "model" &&
                      snapshot.operation.model === model;
                    return (
                      <div className="onboarding-model-row" key={model}>
                        <span>
                          <strong>{model}</strong>
                          <small>
                            {model === REQUIRED_ONBOARDING_OLLAMA_MODEL
                              ? "Required starter model"
                              : "Optional model"}
                          </small>
                        </span>
                        <button
                          type="button"
                          className={
                            installed
                              ? "model-installed"
                              : "onboarding-button tonal"
                          }
                          disabled={busy || installed}
                          onClick={() => installModel(model)}
                        >
                          <MaterialIcon
                            name={installed ? "check" : "download"}
                          />{" "}
                          {installed
                            ? "Installed"
                            : active
                              ? "Downloading"
                              : "Download"}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="onboarding-button text"
                  disabled={!requiredReady}
                  onClick={() => setExpanded(null)}
                >
                  Finished
                </button>
              </div>
            )}
          </article>

          <article
            className={`onboarding-setup-tile ${useByDefault ? "is-selected" : ""} ${expanded === "default" ? "is-expanded" : ""}`}
          >
            <button
              type="button"
              className="onboarding-setup-tile-heading"
              onClick={() =>
                setExpanded(expanded === "default" ? null : "default")
              }
            >
              <span className="setup-tile-icon">
                <MaterialIcon name="offline_bolt" />
              </span>
              <span>
                <strong>Make local AI the default</strong>
                <small>Scout stays private and works without internet.</small>
              </span>
              <MaterialIcon
                name={expanded === "default" ? "expand_less" : "expand_more"}
              />
            </button>
            {expanded === "default" && (
              <div className="onboarding-setup-tile-body">
                <SwitchRow
                  label="Use Ollama by default"
                  description="You can still switch providers for each task."
                  checked={useByDefault}
                  setChecked={setUseByDefault}
                />
              </div>
            )}
          </article>
        </div>
      )}

      {snapshot.operation && (
        <div className="onboarding-live-progress" role="status">
          <span>
            <strong>{snapshot.operation.label}</strong>
            <small>
              {snapshot.operation.totalBytes === null
                ? "Live status"
                : `${formatBytes(snapshot.operation.completedBytes)} of ${formatBytes(snapshot.operation.totalBytes)}`}
            </small>
          </span>
          <progress value={snapshot.operation.percent ?? undefined} max={100} />
        </div>
      )}
      {snapshot.error && (
        <p className="onboarding-inline-error" role="alert">
          <MaterialIcon name="error" /> {snapshot.error}
        </p>
      )}
      <FooterActions
        back={back}
        next={() => void continueWithLocalAi()}
        nextDisabled={!requiredReady || busy}
        helper={
          requiredReady
            ? "Local AI is ready."
            : "qwen3.5:0.8b is required to continue with Local AI."
        }
      />
    </div>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  setChecked,
}: {
  label: string;
  description: string;
  checked: boolean;
  setChecked: (checked: boolean) => void;
}) {
  return (
    <label className="onboarding-setting-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => setChecked(event.target.checked)}
      />
      <span className="onboarding-switch" aria-hidden="true">
        <span />
      </span>
    </label>
  );
}

function RecommendedSettingsPage({
  settings,
  setSettings,
  back,
  next,
  busy,
  error,
}: {
  settings: OnboardingRecommendedSettings;
  setSettings: (settings: OnboardingRecommendedSettings) => void;
  back: () => void;
  next: () => void;
  busy: boolean;
  error: string | null;
}) {
  const update = (key: keyof OnboardingRecommendedSettings, value: boolean) =>
    setSettings({ ...settings, [key]: value });
  return (
    <div className="onboarding-page onboarding-settings-page">
      <section className="onboarding-heading-block compact">
        <span className="onboarding-eyebrow">A thoughtful starting point</span>
        <h1>Use recommended settings or change them.</h1>
        <p>
          Everything here can be changed later. Reporting choices are saved
          locally and do not send anything in this version.
        </p>
      </section>
      <div className="onboarding-settings-grid">
        <section className="onboarding-settings-group hero-setting">
          <span className="settings-group-icon">
            <MaterialIcon name="bolt" />
          </span>
          <div>
            <h2>Hyperdrive</h2>
            <p>
              Balanced performance, with cross-site and search preparation
              enabled.
            </p>
          </div>
          <SwitchRow
            label="Hyperdrive · Balanced"
            description="Preload likely destinations while keeping resource use measured."
            checked={settings.hyperdriveEnabled}
            setChecked={(value) => update("hyperdriveEnabled", value)}
          />
        </section>
        <section className="onboarding-settings-group">
          <SwitchRow
            label="uBlock Origin"
            description="Block ads, trackers, and unwanted page requests."
            checked={settings.ublockEnabled}
            setChecked={(value) => update("ublockEnabled", value)}
          />
          <SwitchRow
            label="Live search suggestions"
            description="Show suggestions while you type in the address bar."
            checked={settings.liveSearchSuggestionsEnabled}
            setChecked={(value) =>
              update("liveSearchSuggestionsEnabled", value)
            }
          />
        </section>
        <section className="onboarding-settings-group privacy-setting">
          <SwitchRow
            label="Help make Chromecraft better"
            description="Share anonymous reports with us. Always optional."
            checked={settings.anonymousReportsEnabled}
            setChecked={(value) => update("anonymousReportsEnabled", value)}
          />
          <SwitchRow
            label="Help make Chromecraft EVEN better"
            description="Share a little more data. Never used for tracking, personalization, or ads."
            checked={settings.enhancedAnonymousReportsEnabled}
            setChecked={(value) =>
              update("enhancedAnonymousReportsEnabled", value)
            }
          />
        </section>
      </div>
      {error && (
        <p className="onboarding-inline-error" role="alert">
          <MaterialIcon name="error" /> {error}
        </p>
      )}
      <FooterActions
        back={back}
        next={next}
        nextLabel={busy ? "Saving..." : "Use these settings"}
        nextDisabled={busy}
      />
    </div>
  );
}

export function hasDownloadedOnboardingUpdate(
  updates: UpdateSnapshot,
): boolean {
  return (
    updates.canRestart &&
    updates.results.some(
      (result) =>
        result.kind === "application" &&
        result.state === "ready" &&
        result.requiresRestart,
    )
  );
}

function OnboardingUpdatePage({
  updates,
  skip,
  restart,
  busy,
  error,
}: {
  updates: UpdateSnapshot;
  skip: () => void;
  restart: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <div className="onboarding-page onboarding-update-page">
      <div className="onboarding-update-card">
        <span className="onboarding-update-icon">
          <MaterialIcon name="system_update_alt" />
        </span>
        <span className="onboarding-eyebrow">Ready to restart</span>
        <h1>Get Chromecraft up to date.</h1>
        <p>
          Some dependencies and Chromecraft features were out of date, and
          we&apos;ve downloaded the latest version for you. Simply restart your
          browser to apply them.
        </p>
        {updates.applicationRelease && (
          <span className="onboarding-update-version">
            Version {updates.applicationRelease.version} is ready
          </span>
        )}
        {error && (
          <p className="onboarding-inline-error" role="alert">
            <MaterialIcon name="error" /> {error}
          </p>
        )}
        <div className="onboarding-update-actions">
          <button
            type="button"
            className="onboarding-button text"
            disabled={busy}
            onClick={skip}
          >
            Skip, I&apos;ll update later
          </button>
          <button
            type="button"
            className="onboarding-button filled large"
            disabled={busy}
            onClick={restart}
          >
            <MaterialIcon name="restart_alt" />{" "}
            {busy ? "Preparing..." : "Restart browser"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function OnboardingExperience({
  snapshot,
  extensions,
  aiTools,
  updates,
}: {
  snapshot: BrowserSnapshot;
  extensions: ExtensionsSnapshot;
  aiTools: AiToolsSnapshot;
  updates: UpdateSnapshot;
}) {
  const [page, setPage] = useState<OnboardingPage>("features");
  const [choices, setChoices] = useState<Set<AiSetupChoice>>(new Set());
  const [settings, setSettings] = useState<OnboardingRecommendedSettings>({
    hyperdriveEnabled: true,
    ublockEnabled: true,
    liveSearchSuggestionsEnabled: true,
    anonymousReportsEnabled: true,
    enhancedAnonymousReportsEnabled: false,
  });
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const afterAiSetup = () => setPage("settings");
  const complete = async (restart: boolean) => {
    setFinishing(true);
    setFinishError(null);
    try {
      await window.chromecraft.completeOnboarding(settings);
      if (restart) await window.chromecraft.restartToUpdate();
    } catch (error) {
      setFinishError(
        error instanceof Error ? error.message : "Could not finish setup.",
      );
      setFinishing(false);
    }
  };

  return (
    <main className={`onboarding-shell onboarding-page-${page}`}>
      <StepHeader page={page} />
      {page === "features" && (
        <FeaturesPage next={() => setPage("essentials")} />
      )}
      {page === "essentials" && (
        <EssentialsPage
          extensions={extensions}
          back={() => setPage("features")}
          next={() => setPage("ai")}
        />
      )}
      {page === "ai" && (
        <AiChoicePage
          choices={choices}
          choose={(choice) =>
            setChoices((current) => updateAiSetupChoices(current, choice))
          }
          back={() => setPage("essentials")}
          next={() =>
            setPage(
              choices.has("skip")
                ? "settings"
                : choices.has("gemini")
                  ? "gemini"
                  : "local-ai",
            )
          }
        />
      )}
      {page === "gemini" && (
        <GeminiSetupPage
          aiTools={aiTools}
          back={() => setPage("ai")}
          next={() => setPage(choices.has("ollama") ? "local-ai" : "settings")}
        />
      )}
      {page === "local-ai" && (
        <LocalAiSetupPage
          back={() => setPage(choices.has("gemini") ? "gemini" : "ai")}
          next={afterAiSetup}
        />
      )}
      {page === "settings" && (
        <RecommendedSettingsPage
          settings={settings}
          setSettings={setSettings}
          back={() =>
            setPage(
              choices.has("ollama")
                ? "local-ai"
                : choices.has("gemini")
                  ? "gemini"
                  : "ai",
            )
          }
          next={() =>
            hasDownloadedOnboardingUpdate(updates)
              ? setPage("updates")
              : void complete(false)
          }
          busy={finishing}
          error={finishError}
        />
      )}
      {page === "updates" && (
        <OnboardingUpdatePage
          updates={updates}
          skip={() => void complete(false)}
          restart={() => void complete(true)}
          busy={finishing}
          error={finishError}
        />
      )}
      <span className="onboarding-a11y-status" aria-live="polite">
        {extensions.operation === "idle"
          ? ""
          : (extensions.progress?.label ?? "Working on extension")}
      </span>
      <span hidden>
        {snapshot.ublock.ready ? "uBlock ready" : "uBlock loading"}
      </span>
    </main>
  );
}
