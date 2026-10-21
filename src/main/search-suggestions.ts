import type {
  SearchEngine,
  SearchSuggestionsSnapshot,
} from "../shared/browser";

const MAX_QUERY_LENGTH = 200;
const MAX_RESPONSE_LENGTH = 64 * 1024;
const MAX_SUGGESTIONS = 8;
const MAX_SUGGESTION_LENGTH = 256;
const REQUEST_TIMEOUT_MS = 3_000;

type SuggestionPreferences = {
  readonly snapshot: Readonly<{
    searchEngine: SearchEngine;
    remoteSearchSuggestionsEnabled: boolean;
  }>;
};

export type SuggestionFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

function emptyResult(
  query: string,
  provider: SearchEngine,
): SearchSuggestionsSnapshot {
  return { query, provider, suggestions: [] };
}

export function parseDuckDuckGoSuggestions(
  raw: unknown,
  query: string,
): string[] {
  if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) {
    return [];
  }

  const seen = new Set([query.toLocaleLowerCase()]);
  const suggestions: string[] = [];
  for (const value of raw[1]) {
    if (typeof value !== "string") continue;
    const suggestion = value.normalize("NFC").trim();
    const key = suggestion.toLocaleLowerCase();
    if (
      suggestion.length === 0 ||
      suggestion.length > MAX_SUGGESTION_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(suggestion) ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    suggestions.push(suggestion);
    if (suggestions.length === MAX_SUGGESTIONS) break;
  }
  return suggestions;
}

export class SearchSuggestionService {
  private activeController: AbortController | null = null;
  private generation = 0;

  constructor(
    private readonly preferences: SuggestionPreferences,
    private readonly fetchProvider: SuggestionFetch,
    private readonly providerEndpoint = "https://duckduckgo.com/ac/",
  ) {}

  async getSuggestions(queryInput: string): Promise<SearchSuggestionsSnapshot> {
    const query = queryInput.trim();
    const provider = this.preferences.snapshot.searchEngine;
    const generation = ++this.generation;
    this.activeController?.abort();
    this.activeController = null;

    if (
      !this.preferences.snapshot.remoteSearchSuggestionsEnabled ||
      query.length < 2 ||
      query.length > MAX_QUERY_LENGTH
    ) {
      return emptyResult(query, provider);
    }

    const controller = new AbortController();
    this.activeController = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(this.providerEndpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("type", "list");
      const response = await this.fetchProvider(url.href, {
        method: "GET",
        headers: {
          Accept: "application/json, text/javascript;q=0.9",
        },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || generation !== this.generation) {
        return emptyResult(query, provider);
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_LENGTH || generation !== this.generation) {
        return emptyResult(query, provider);
      }
      return {
        query,
        provider,
        suggestions: parseDuckDuckGoSuggestions(JSON.parse(text), query),
      };
    } catch (error) {
      if (
        !controller.signal.aborted &&
        generation === this.generation &&
        !(error instanceof SyntaxError)
      ) {
        console.warn("The search suggestion provider request failed.");
      }
      return emptyResult(query, provider);
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) this.activeController = null;
    }
  }

  cancel(): void {
    this.generation += 1;
    this.activeController?.abort();
    this.activeController = null;
  }

  dispose(): void {
    this.cancel();
  }
}
