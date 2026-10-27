export interface OnboardingViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type GeminiClipboardDetectionState =
  | "idle"
  | "listening"
  | "detected"
  | "expired";

export interface GeminiClipboardDetectionSnapshot {
  state: GeminiClipboardDetectionState;
  stageId: string | null;
  maskedKey: string | null;
}

export interface CommitOnboardingGeminiKeyRequest {
  stageId: string;
  persist: boolean;
}
