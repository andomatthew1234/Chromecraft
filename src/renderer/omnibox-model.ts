import type { BrowserDataSnapshot } from "../shared/browser";

export type OmniboxSuggestionKind = "url" | "search" | "remote-search";

export interface OmniboxSuggestion {
  id: string;
  label: string;
  detail: string;
  value: string;
  icon: "search" | "open" | "bookmark" | "history";
  kind: OmniboxSuggestionKind;
  section: "local" | "search";
}

interface LocalCandidate {
  id: string;
  title: string;
  url: string;
  host: string;
  displayUrl: string;
  bookmarked: boolean;
  bookmarkCreatedAt: number;
  visitCount: number;
  typedCount: number;
  lastVisitedAt: number;
}

interface DomainCandidate {
  host: string;
  url: string;
  bookmarked: boolean;
  visitCount: number;
  typedCount: number;
  lastVisitedAt: number;
}

export interface LocalOmniboxIndex {
  candidates: LocalCandidate[];
  domains: DomainCandidate[];
}

export interface InlineCompletion {
  value: string;
  url: string;
  suffixStart: number;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

function normaliseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function displayUrl(url: URL): string {
  const host = url.hostname.replace(/^www\./i, "");
  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${host}${port}${path}${url.search}`;
}

function getOrCreateCandidate(
  candidates: Map<string, LocalCandidate>,
  id: string,
  title: string,
  inputUrl: string,
): LocalCandidate | null {
  const url = normaliseUrl(inputUrl);
  if (!url) return null;
  const key = url.href;
  const existing = candidates.get(key);
  if (existing) {
    if (title.length > existing.title.length) existing.title = title;
    return existing;
  }
  const candidate: LocalCandidate = {
    id,
    title,
    url: key,
    host: url.hostname.replace(/^www\./i, ""),
    displayUrl: displayUrl(url),
    bookmarked: false,
    bookmarkCreatedAt: 0,
    visitCount: 0,
    typedCount: 0,
    lastVisitedAt: 0,
  };
  candidates.set(key, candidate);
  return candidate;
}

export function createLocalOmniboxIndex(
  data: BrowserDataSnapshot,
): LocalOmniboxIndex {
  const candidates = new Map<string, LocalCandidate>();

  for (const bookmark of data.bookmarks) {
    const candidate = getOrCreateCandidate(
      candidates,
      `bookmark-${bookmark.id}`,
      bookmark.title,
      bookmark.url,
    );
    if (!candidate) continue;
    candidate.bookmarked = true;
    candidate.bookmarkCreatedAt = Math.max(
      candidate.bookmarkCreatedAt,
      bookmark.createdAt,
    );
  }

  for (const history of data.history) {
    const candidate = getOrCreateCandidate(
      candidates,
      `history-${history.id}`,
      history.title,
      history.url,
    );
    if (!candidate) continue;
    candidate.visitCount += 1;
    if (history.typed) candidate.typedCount += 1;
    candidate.lastVisitedAt = Math.max(
      candidate.lastVisitedAt,
      history.visitedAt,
    );
  }

  const domains = new Map<string, DomainCandidate>();
  for (const candidate of candidates.values()) {
    const parsed = new URL(candidate.url);
    const existing = domains.get(candidate.host) ?? {
      host: candidate.host,
      url: `${parsed.protocol}//${parsed.host}/`,
      bookmarked: false,
      visitCount: 0,
      typedCount: 0,
      lastVisitedAt: 0,
    };
    existing.bookmarked ||= candidate.bookmarked;
    existing.visitCount += candidate.visitCount;
    existing.typedCount += candidate.typedCount;
    existing.lastVisitedAt = Math.max(
      existing.lastVisitedAt,
      candidate.lastVisitedAt,
    );
    domains.set(candidate.host, existing);
  }

  return {
    candidates: [...candidates.values()],
    domains: [...domains.values()],
  };
}

function recencyBonus(timestamp: number, now: number): number {
  if (!timestamp) return 0;
  const ageInDays = Math.max(0, now - timestamp) / 86_400_000;
  return 800_000 / (1 + ageInDays);
}

function signalBonus(
  candidate: Pick<
    LocalCandidate,
    "bookmarked" | "typedCount" | "visitCount" | "lastVisitedAt"
  >,
  now: number,
): number {
  return (
    (candidate.bookmarked ? 1_000_000 : 0) +
    Math.min(candidate.typedCount, 50) * 90_000 +
    Math.min(candidate.visitCount, 100) * 20_000 +
    recencyBonus(candidate.lastVisitedAt, now)
  );
}

function matchTier(candidate: LocalCandidate, needle: string): number {
  const title = candidate.title.toLocaleLowerCase();
  const host = candidate.host.toLocaleLowerCase();
  const display = candidate.displayUrl.toLocaleLowerCase();
  if (!needle) return 0;
  if (host === needle || display === needle) return 0;
  if (host.startsWith(needle)) return 1;
  if (display.startsWith(needle)) return 2;
  if (title.startsWith(needle)) return 3;
  if (title.split(/\s+/u).some((word) => word.startsWith(needle))) return 4;
  if (host.includes(needle) || display.includes(needle)) return 5;
  if (title.includes(needle)) return 6;
  return Number.POSITIVE_INFINITY;
}

export function buildLocalOmniboxSuggestions(
  input: string,
  index: LocalOmniboxIndex,
  now = Date.now(),
  limit = 5,
): OmniboxSuggestion[] {
  const needle = input.trim().toLocaleLowerCase();
  return index.candidates
    .map((candidate) => ({
      candidate,
      tier: matchTier(candidate, needle),
      bonus: signalBonus(candidate, now),
    }))
    .filter(({ tier }) => Number.isFinite(tier))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.bonus - a.bonus ||
        a.candidate.host.localeCompare(b.candidate.host),
    )
    .slice(0, limit)
    .map(({ candidate }) => ({
      id: candidate.id,
      label: candidate.title || candidate.displayUrl,
      detail: `${candidate.bookmarked ? "Bookmark" : `${candidate.visitCount} ${candidate.visitCount === 1 ? "visit" : "visits"}`} · ${candidate.displayUrl}`,
      value: candidate.url,
      icon: candidate.bookmarked ? "bookmark" : "history",
      kind: "url",
      section: "local",
    }));
}

export function looksLikeAddress(value: string): boolean {
  return /^(?:https?:\/\/|localhost(?::\d+)?(?:\/|$)|[^\s/]+\.[a-z]{2,}(?:\/|$))/iu.test(
    value.trim(),
  );
}

export function getInlineCompletion(
  input: string,
  index: LocalOmniboxIndex,
  now = Date.now(),
): InlineCompletion | null {
  if (
    input.length === 0 ||
    input !== input.trim() ||
    /\s/u.test(input) ||
    input.length > 200
  ) {
    return null;
  }
  const needle = input.toLocaleLowerCase();
  const hasScheme = /^https?:\/\//iu.test(input);
  const hasPath = !hasScheme && input.includes("/");

  if (!hasScheme && !hasPath) {
    const domain = index.domains
      .filter((candidate) =>
        candidate.host.toLocaleLowerCase().startsWith(needle),
      )
      .sort(
        (a, b) =>
          signalBonus(b, now) - signalBonus(a, now) ||
          a.host.localeCompare(b.host),
      )[0];
    if (domain && domain.host.length > input.length) {
      return { value: domain.host, url: domain.url, suffixStart: input.length };
    }
  }

  const candidate = index.candidates
    .map((item) => ({
      item,
      completion: hasScheme ? item.url : item.displayUrl,
      bonus: signalBonus(item, now),
    }))
    .filter(({ completion }) =>
      completion.toLocaleLowerCase().startsWith(needle),
    )
    .sort((a, b) => b.bonus - a.bonus)[0];
  return candidate && candidate.completion.length > input.length
    ? {
        value: candidate.completion,
        url: candidate.item.url,
        suffixStart: input.length,
      }
    : null;
}

export function buildOmniboxSuggestions(
  input: string,
  index: LocalOmniboxIndex,
  remoteSuggestions: readonly string[] = [],
  now = Date.now(),
): OmniboxSuggestion[] {
  const query = input.trim();
  const local = buildLocalOmniboxSuggestions(query, index, now);
  if (!query) return local.slice(0, 7);

  const addressLike = looksLikeAddress(query);
  const action: OmniboxSuggestion = {
    id: "input-action",
    label: addressLike ? `Go to ${query}` : `Search for “${query}”`,
    detail: addressLike ? "Open address" : "Search with DuckDuckGo",
    value: query,
    icon: addressLike ? "open" : "search",
    kind: "search",
    section: "search",
  };
  const combined = local.length > 0 ? [...local, action] : [action];
  if (!addressLike) {
    const seen = new Set([query.toLocaleLowerCase()]);
    for (const suggestion of remoteSuggestions) {
      const value = suggestion.trim();
      const key = value.toLocaleLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      combined.push({
        id: `remote-${key}`,
        label: value,
        detail: "DuckDuckGo suggestion",
        value,
        icon: "search",
        kind: "remote-search",
        section: "search",
      });
    }
  }
  return combined.slice(0, 8);
}

export function highlightSuggestionText(
  value: string,
  query: string,
): HighlightSegment[] {
  const needle = query.trim();
  if (!needle) return [{ text: value, match: false }];
  const start = value.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (start < 0) return [{ text: value, match: false }];
  const end = start + needle.length;
  return [
    ...(start > 0 ? [{ text: value.slice(0, start), match: false }] : []),
    { text: value.slice(start, end), match: true },
    ...(end < value.length ? [{ text: value.slice(end), match: false }] : []),
  ];
}

export type OmniboxKeyAction =
  | { type: "move"; index: number }
  | { type: "accept-inline" }
  | { type: "commit" }
  | { type: "close" }
  | { type: "none" };

export function getOmniboxKeyAction(
  key: string,
  state: {
    activeIndex: number;
    suggestionCount: number;
    expanded: boolean;
    hasInlineCompletion: boolean;
  },
): OmniboxKeyAction {
  if (key === "ArrowDown" && state.expanded) {
    return {
      type: "move",
      index: (state.activeIndex + 1) % state.suggestionCount,
    };
  }
  if (key === "ArrowUp" && state.expanded) {
    return {
      type: "move",
      index:
        (state.activeIndex - 1 + state.suggestionCount) % state.suggestionCount,
    };
  }
  if ((key === "Tab" || key === "ArrowRight") && state.hasInlineCompletion) {
    return { type: "accept-inline" };
  }
  if (key === "Enter") return { type: "commit" };
  if (key === "Escape" && state.expanded) return { type: "close" };
  return { type: "none" };
}
