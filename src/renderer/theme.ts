import type { NewTabTheme } from "../shared/browser";

/**
 * Keeps the persisted new-tab colour choice attached to the whole Browser
 * Shell. CSS consumes this class to replace the Material 3 tonal tokens.
 */
export function browserThemeClass(theme: NewTabTheme): string {
  return `color-theme-${theme}`;
}
