const explicitScheme = /^[a-z][a-z\d+.-]*:/i;
const hostLike =
  /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z\d-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#]|$)/i;

export const DEFAULT_SEARCH_TEMPLATE = "https://duckduckgo.com/?q={query}";

export function isNavigationInputAddress(input: string): boolean {
  const value = input.trim();
  if (hostLike.test(value)) return true;
  if (!explicitScheme.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveNavigationInput(
  input: string,
  searchTemplate = DEFAULT_SEARCH_TEMPLATE,
): string | null {
  const value = input.trim();
  if (!value) return null;

  if (hostLike.test(value)) {
    const local =
      /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i.test(value);
    try {
      return new URL(`${local ? "http" : "https"}://${value}`).toString();
    } catch {
      return null;
    }
  }

  if (explicitScheme.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.toString()
        : null;
    } catch {
      return null;
    }
  }

  return searchTemplate.replace("{query}", encodeURIComponent(value));
}

export function isAllowedWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
