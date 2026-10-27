import { randomUUID } from "node:crypto";

import { BaseWindow, type Session, WebContentsView } from "electron";

import type { AiToolsSnapshot } from "../shared/ai-tools";
import type {
  CommitOnboardingGeminiKeyRequest,
  GeminiClipboardDetectionSnapshot,
  OnboardingViewBounds,
} from "../shared/onboarding";

export const GEMINI_API_KEY_SETUP_URL = "https://aistudio.google.com/apikey";

const CLIPBOARD_POLL_MS = 650;
const SETUP_TIMEOUT_MS = 10 * 60 * 1_000;
const MINIMUM_VIEW_WIDTH = 320;
const MINIMUM_VIEW_HEIGHT = 240;
const VIEW_MARGIN = 12;

const allowedSetupHosts = new Set([
  "aistudio.google.com",
  "accounts.google.com",
  "myaccount.google.com",
  "support.google.com",
]);

export interface OnboardingGeminiControllerOptions {
  readClipboardText: () => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  commitKey: (apiKey: string, persist: boolean) => Promise<AiToolsSnapshot>;
  emit: (snapshot: GeminiClipboardDetectionSnapshot) => void;
}

export function isGeminiApiKeyCandidate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    /^AIza[0-9A-Za-z_-]{20,100}$/u.test(value)
  );
}

export function isAllowedGeminiSetupUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowedSetupHosts.has(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeOnboardingViewBounds(
  requested: OnboardingViewBounds,
  content: Electron.Rectangle,
): Electron.Rectangle {
  const values = [requested.x, requested.y, requested.width, requested.height];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    requested.x < 0 ||
    requested.y < 0 ||
    requested.width < MINIMUM_VIEW_WIDTH ||
    requested.height < MINIMUM_VIEW_HEIGHT ||
    values.some((value) => value > 16_384)
  ) {
    throw new TypeError("The onboarding browser frame is invalid.");
  }
  const maximumWidth = Math.max(1, content.width - VIEW_MARGIN * 2);
  const maximumHeight = Math.max(1, content.height - VIEW_MARGIN * 2);
  const width = Math.min(Math.round(requested.width), maximumWidth);
  const height = Math.min(Math.round(requested.height), maximumHeight);
  return {
    x: Math.min(
      Math.max(VIEW_MARGIN, Math.round(requested.x)),
      Math.max(VIEW_MARGIN, content.width - width - VIEW_MARGIN),
    ),
    y: Math.min(
      Math.max(VIEW_MARGIN, Math.round(requested.y)),
      Math.max(VIEW_MARGIN, content.height - height - VIEW_MARGIN),
    ),
    width,
    height,
  };
}

export class OnboardingGeminiController {
  private view: WebContentsView | null = null;
  private requestedBounds: OnboardingViewBounds | null = null;
  private interval: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private stagedKey: { id: string; value: string } | null = null;
  private state: GeminiClipboardDetectionSnapshot = {
    state: "idle",
    stageId: null,
    maskedKey: null,
  };
  private disposed = false;
  private inspectingClipboard = false;

  private readonly reposition = (): void => {
    if (!this.requestedBounds || !this.view) return;
    if (this.parent.isDestroyed() || this.view.webContents.isDestroyed())
      return;
    this.view.setBounds(
      normalizeOnboardingViewBounds(
        this.requestedBounds,
        this.parent.getContentBounds(),
      ),
    );
  };

  private readonly stopWhenHidden = (): void => {
    this.stop();
  };

  constructor(
    private readonly parent: BaseWindow,
    private readonly browserSession: Session,
    private readonly options: OnboardingGeminiControllerOptions,
  ) {
    parent.on("resize", this.reposition);
    parent.on("maximize", this.reposition);
    parent.on("unmaximize", this.reposition);
    parent.on("hide", this.stopWhenHidden);
  }

  start(): GeminiClipboardDetectionSnapshot {
    if (this.disposed) throw new Error("Gemini onboarding is unavailable.");
    this.clearClipboardTimer();
    this.stagedKey = null;
    this.startedAt = Date.now();
    this.state = { state: "listening", stageId: null, maskedKey: null };
    this.options.emit(this.snapshot);
    this.interval = setInterval(
      () => void this.inspectClipboard(),
      CLIPBOARD_POLL_MS,
    );
    void this.openView();
    return this.snapshot;
  }

  setBounds(bounds: OnboardingViewBounds): void {
    normalizeOnboardingViewBounds(bounds, this.parent.getContentBounds());
    this.requestedBounds = { ...bounds };
    this.reposition();
  }

  async openExternal(): Promise<void> {
    if (this.disposed) throw new Error("Gemini onboarding is unavailable.");
    this.closeView();
    await this.options.openExternal(GEMINI_API_KEY_SETUP_URL);
  }

  async commit(
    request: CommitOnboardingGeminiKeyRequest,
  ): Promise<AiToolsSnapshot> {
    if (
      !this.stagedKey ||
      !request.stageId ||
      request.stageId !== this.stagedKey.id
    ) {
      throw new Error("That copied API key is no longer available.");
    }
    const result = await this.options.commitKey(
      this.stagedKey.value,
      request.persist,
    );
    this.clearClipboardTimer();
    this.stagedKey = null;
    this.state = { state: "idle", stageId: null, maskedKey: null };
    this.options.emit(this.snapshot);
    return result;
  }

  stop(): void {
    this.clearClipboardTimer();
    this.stagedKey = null;
    this.state = { state: "idle", stageId: null, maskedKey: null };
    this.closeView();
    this.options.emit(this.snapshot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.parent.removeListener("resize", this.reposition);
    this.parent.removeListener("maximize", this.reposition);
    this.parent.removeListener("unmaximize", this.reposition);
    this.parent.removeListener("hide", this.stopWhenHidden);
  }

  private get snapshot(): GeminiClipboardDetectionSnapshot {
    return { ...this.state };
  }

  private async inspectClipboard(): Promise<void> {
    if (this.inspectingClipboard || this.state.state !== "listening") return;
    if (Date.now() - this.startedAt >= SETUP_TIMEOUT_MS) {
      this.clearClipboardTimer();
      this.state = { state: "expired", stageId: null, maskedKey: null };
      this.options.emit(this.snapshot);
      return;
    }
    this.inspectingClipboard = true;
    let candidate: string;
    try {
      candidate = (await this.options.readClipboardText()).trim();
    } catch {
      return;
    } finally {
      this.inspectingClipboard = false;
    }
    if (this.state.state !== "listening" || this.disposed) return;
    if (!isGeminiApiKeyCandidate(candidate)) return;
    const stageId = randomUUID();
    this.stagedKey = { id: stageId, value: candidate };
    this.state = {
      state: "detected",
      stageId,
      maskedKey: `AIza••••••${candidate.slice(-4)}`,
    };
    this.clearClipboardTimer();
    this.closeView();
    this.options.emit(this.snapshot);
  }

  private async openView(): Promise<void> {
    this.closeView();
    const view = new WebContentsView({
      webPreferences: {
        session: this.browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
        spellcheck: false,
      },
    });
    this.view = view;
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    this.parent.contentView.addChildView(view);
    this.reposition();

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedGeminiSetupUrl(url)) {
        queueMicrotask(() => {
          if (this.view === view && !view.webContents.isDestroyed()) {
            void view.webContents.loadURL(url).catch(() => undefined);
          }
        });
      }
      return { action: "deny" };
    });
    const confineNavigation = (event: Electron.Event, url: string): void => {
      if (!isAllowedGeminiSetupUrl(url)) event.preventDefault();
    };
    view.webContents.on("will-navigate", confineNavigation);
    view.webContents.on("will-redirect", confineNavigation);
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        this.stop();
      }
    });
    view.webContents.on("render-process-gone", this.closeView);
    view.webContents.once("destroyed", () => {
      if (this.view === view) this.view = null;
    });

    try {
      await view.webContents.loadURL(GEMINI_API_KEY_SETUP_URL);
      if (this.view !== view || view.webContents.isDestroyed()) return;
      this.reposition();
      view.setVisible(true);
      view.webContents.focus();
    } catch {
      if (this.view === view) this.closeView();
    }
  }

  private readonly closeView = (): void => {
    const view = this.view;
    this.view = null;
    if (!view) return;
    try {
      this.parent.contentView.removeChildView(view);
    } catch {
      // The native window may already be closing.
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };

  private clearClipboardTimer(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }
}
