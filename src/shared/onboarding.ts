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

export const ONBOARDING_OLLAMA_MODELS = [
  "gemma4:26b",
  "devstral-small-2:24b",
  "qwen3.5:4b",
  "qwen3.5:0.8b",
] as const;

export type OnboardingOllamaModel = (typeof ONBOARDING_OLLAMA_MODELS)[number];

export const REQUIRED_ONBOARDING_OLLAMA_MODEL = "qwen3.5:0.8b" as const;

export interface OnboardingLocalAiProgress {
  kind: "service" | "model";
  model: OnboardingOllamaModel | null;
  label: string;
  percent: number | null;
  completedBytes: number | null;
  totalBytes: number | null;
}

export interface OnboardingLocalAiSnapshot {
  service: "checking" | "missing" | "installing" | "ready" | "failed";
  installedModels: string[];
  operation: OnboardingLocalAiProgress | null;
  error: string | null;
}

export interface OnboardingRecommendedSettings {
  hyperdriveEnabled: boolean;
  ublockEnabled: boolean;
  liveSearchSuggestionsEnabled: boolean;
  anonymousReportsEnabled: boolean;
  enhancedAnonymousReportsEnabled: boolean;
}
