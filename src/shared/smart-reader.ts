export type SmartReaderAvailability =
  | "checking"
  | "available"
  | "unavailable"
  | "error";

export interface SmartReaderTabSnapshot {
  availability: SmartReaderAvailability;
  active: boolean;
  revision: number;
}

export interface SmartReaderArticle {
  title: string;
  byline: string | null;
  publishedTime: string | null;
  siteName: string | null;
  excerpt: string | null;
  content: string;
  textLength: number;
  sourceUrl: string;
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
