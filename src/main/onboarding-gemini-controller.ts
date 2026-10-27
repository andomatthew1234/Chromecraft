import { randomUUID } from "node:crypto";

import type { AiToolsSnapshot } from "../shared/ai-tools";
import type {
  CommitOnboardingGeminiKeyRequest,
  GeminiClipboardDetectionSnapshot,
  OnboardingViewBounds,
} from "../shared/onboarding";

export const GEMINI_API_KEY_SETUP_URL = "https://aistudio.google.com/apikey";

const CLIPBOARD_POLL_MS = 650;
const SETUP_TIMEOUT_MS = 10 * 60 * 1_000;

export interface OnboardingGeminiControllerOptions {
  readClipboardText: () => Promise<string>;
  openInApp: (url: string) => Promise<void> | void;
  closeInApp: () => void;
  setInAppBounds: (bounds: OnboardingViewBounds) => void;
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

export class OnboardingGeminiController {
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

  constructor(private readonly options: OnboardingGeminiControllerOptions) {}

  async start(): Promise<GeminiClipboardDetectionSnapshot> {
    if (this.disposed) throw new Error("Gemini onboarding is unavailable.");
    return this.openInApp();
  }

  setBounds(bounds: OnboardingViewBounds): void {
    this.requestedBounds = { ...bounds };
    if (this.state.state === "listening") this.options.setInAppBounds(bounds);
  }

  async openExternal(): Promise<void> {
    if (this.disposed) throw new Error("Gemini onboarding is unavailable.");
    if (this.state.state !== "listening") this.beginClipboardDetection();
    this.options.closeInApp();
    await this.options.openExternal(GEMINI_API_KEY_SETUP_URL);
  }

  private async openInApp(): Promise<GeminiClipboardDetectionSnapshot> {
    const startedHere = this.state.state !== "listening";
    if (startedHere) this.beginClipboardDetection();
    try {
      await this.options.openInApp(GEMINI_API_KEY_SETUP_URL);
      if (this.requestedBounds) {
        this.options.setInAppBounds(this.requestedBounds);
      }
      return this.snapshot;
    } catch (error) {
      if (startedHere) this.stop();
      throw error;
    }
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
    this.options.closeInApp();
    this.stagedKey = null;
    this.state = { state: "idle", stageId: null, maskedKey: null };
    this.options.emit(this.snapshot);
    return result;
  }

  stop(): void {
    this.clearClipboardTimer();
    this.options.closeInApp();
    this.stagedKey = null;
    this.state = { state: "idle", stageId: null, maskedKey: null };
    this.options.emit(this.snapshot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }

  private get snapshot(): GeminiClipboardDetectionSnapshot {
    return { ...this.state };
  }

  private beginClipboardDetection(): void {
    this.clearClipboardTimer();
    this.stagedKey = null;
    this.startedAt = Date.now();
    this.state = { state: "listening", stageId: null, maskedKey: null };
    this.options.emit(this.snapshot);
    this.interval = setInterval(
      () => void this.inspectClipboard(),
      CLIPBOARD_POLL_MS,
    );
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
    this.options.closeInApp();
    this.options.emit(this.snapshot);
  }

  private clearClipboardTimer(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }
}
