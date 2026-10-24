export type SmartReaderAvailability =
  | "checking"
  | "available"
  | "unavailable"
  | "error";

export interface SmartReaderTabSnapshot {
  availability: SmartReaderAvailability;
  active: boolean;
  revision: number;
  saved?: boolean;
  navigationOpen?: boolean;
  narrationOpen?: boolean;
}

export interface SmartReaderSection {
  id: string;
  text: string;
  level: 1 | 2 | 3 | 4;
}

export interface SmartReaderArticle {
  title: string;
  byline: string | null;
  publishedTime: string | null;
  siteName: string | null;
  excerpt: string | null;
  content: string;
  textContent: string;
  textContentTruncated?: boolean;
  headings: string[];
  sections?: SmartReaderSection[];
  textLength: number;
  sourceUrl: string;
}

export type SmartReaderCommand =
  | {
      type: "set-progress-visible";
      visible: boolean;
      resumeProgress: number | null;
    }
  | { type: "toggle-navigation" }
  | { type: "toggle-narration" }
  | { type: "pause-narration" }
  | { type: "stop-narration" };

export interface SmartReaderNarrationCapabilities {
  gemini: {
    available: boolean;
    model: string;
    voices: string[];
    reason: string | null;
  };
  local: {
    available: false;
    reason: string;
    setupHint: string;
  };
}

export interface SmartReaderGeminiSession {
  id: string;
  segmentCount: number;
  model: string;
  voice: string;
}

export interface SmartReaderGeminiSegment {
  sessionId: string;
  index: number;
  segmentCount: number;
  mimeType: string;
  audioBase64: string;
}

export type SmartReaderSummaryStage = "idle" | "loading" | "ready" | "error";

export interface SmartReaderSummaryProvider {
  connection: "unknown" | "connected" | "unavailable";
  models: Array<{
    name: string;
    displayName?: string | null;
    size: number | null;
    family: string | null;
    parameterSize: string | null;
    recommended?: boolean;
  }>;
  selectedModel: string | null;
  error: string | null;
  apiKeyConfigured?: boolean;
  cloudConsentGranted?: boolean;
}

export interface SmartReaderSummaryResult {
  points: string[];
  coverage: "full" | "partial";
  provider: "ollama" | "gemini";
  model: string;
  generatedAt: number;
}

export interface SmartReaderSummarySnapshot {
  tabId: string;
  revision: number;
  sourceUrl: string;
  stage: SmartReaderSummaryStage;
  requestId: string | null;
  provider: "ollama" | "gemini";
  model: string | null;
  providers: {
    ollama: SmartReaderSummaryProvider;
    gemini: SmartReaderSummaryProvider;
  };
  result: SmartReaderSummaryResult | null;
  error: string | null;
}

export interface SmartReaderSummaryGenerateRequest {
  provider: "ollama" | "gemini";
  model: string | null;
  cloudConsent: boolean;
}

export interface SmartReaderViewSnapshot extends SmartReaderTabSnapshot {
  tabId: string;
  article: SmartReaderArticle | null;
  error: string | null;
}

export type SmartReaderTheme = "system" | "light" | "warm" | "dark";
export type SmartReaderFont = "serif" | "sans";

export interface SmartReaderAppearance {
  theme: SmartReaderTheme;
  font: SmartReaderFont;
  textScale: number;
}

export const defaultSmartReaderAppearance: SmartReaderAppearance = {
  theme: "system",
  font: "serif",
  textScale: 1,
};

export function normalizeSmartReaderAppearance(
  value: unknown,
): SmartReaderAppearance {
  if (!value || typeof value !== "object") return defaultSmartReaderAppearance;
  const source = value as Partial<SmartReaderAppearance>;
  const theme = ["system", "light", "warm", "dark"].includes(source.theme ?? "")
    ? (source.theme as SmartReaderTheme)
    : defaultSmartReaderAppearance.theme;
  const font = source.font === "sans" ? "sans" : "serif";
  const scale = Number(source.textScale);
  return {
    theme,
    font,
    textScale: Number.isFinite(scale)
      ? Math.min(1.35, Math.max(0.8, Math.round(scale * 20) / 20))
      : 1,
  };
}

export interface SmartReaderExtractionRequest {
  requestId: string;
  expectedUrl: string;
  revision: number;
  force: boolean;
}

export interface SmartReaderExtractionResult {
  requestId: string;
  sourceUrl: string;
  revision: number;
  available: boolean;
  article: SmartReaderArticle | null;
  error: string | null;
}
