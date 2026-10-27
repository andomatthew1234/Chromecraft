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
import type { GeminiClipboardDetectionSnapshot } from "../shared/onboarding";
import { GeminiLogo, OllamaLogo } from "./ScoutProviderLogo";

type OnboardingPage = "features" | "essentials" | "ai" | "gemini";
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
  const current = page === "features" ? 1 : page === "essentials" ? 2 : 3;
  return (
    <header className="onboarding-topbar">
      <span className="onboarding-wordmark">
        <span className="onboarding-wordmark-mark">C</span>
        Chromecraft
      </span>
      <span className="onboarding-progress" aria-label={`Step ${current} of 3`}>
        {[1, 2, 3].map((step) => (
          <span
            key={step}
            className={step <= current ? "is-complete" : undefined}
          />
        ))}
      </span>
      <span className="onboarding-step-label">
        {page === "gemini" ? "AI setup" : `Step ${current} of 3`}
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
            <MaterialIcon name="web_traffic" />
            <span className="speed-line speed-line-one" />
            <span className="speed-line speed-line-two" />
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
            <span className="ai-orbit" />
            <MaterialIcon name="auto_awesome" />
            <span className="ai-off-stroke" />
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
            <MaterialIcon name="verified_user" />
            <span className="privacy-pulse" />
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
  return item.logoUrl ? (
    <img src={item.logoUrl} alt="" draggable={false} />
  ) : (
    <MaterialIcon name={item.icon} />
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
  continueToGemini,
}: {
  choices: ReadonlySet<AiSetupChoice>;
  choose: (choice: AiSetupChoice) => void;
  back: () => void;
  continueToGemini: () => void;
}) {
  const hasGemini = choices.has("gemini");
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
        next={continueToGemini}
        nextLabel={hasGemini ? "Set up Gemini" : "More setup coming soon"}
        nextDisabled={!hasGemini}
        helper={
          hasGemini
            ? choices.has("ollama")
              ? "Gemini is first. Local AI setup will follow in the next update."
              : "Your Gemini key stays outside website content."
            : hasAny
              ? "The next selected setup page has not been added yet."
              : "Choose at least one option to continue."
        }
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
}: {
  aiTools: AiToolsSnapshot;
  back: () => void;
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

  useEffect(
    () => () => {
      void window.chromecraft.stopOnboardingGeminiSetup();
    },
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

  const startGuide = async () => {
    setError(null);
    setAgreed(false);
    setPhase("guide");
    try {
      setClipboard(await window.chromecraft.startOnboardingGeminiSetup());
    } catch (caught) {
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
        <div className="onboarding-terminal-note">
          <MaterialIcon name="construction" />
          <span>
            <strong>That&apos;s as far as this build goes.</strong> More
            onboarding pages are ready to be added next.
          </span>
        </div>
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
            <h2>Paste your Gemini API key.</h2>
            <p>It will be tested before Chromecraft stores it.</p>
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

export function OnboardingExperience({
  snapshot,
  extensions,
  aiTools,
}: {
  snapshot: BrowserSnapshot;
  extensions: ExtensionsSnapshot;
  aiTools: AiToolsSnapshot;
}) {
  const [page, setPage] = useState<OnboardingPage>("features");
  const [choices, setChoices] = useState<Set<AiSetupChoice>>(new Set());

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
          continueToGemini={() => setPage("gemini")}
        />
      )}
      {page === "gemini" && (
        <GeminiSetupPage aiTools={aiTools} back={() => setPage("ai")} />
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
