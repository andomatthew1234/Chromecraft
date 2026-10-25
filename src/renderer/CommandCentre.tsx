import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  BrowserSnapshot,
  BrowserTabSnapshot,
  TabGroupSnapshot,
} from "../shared/browser";
import { StaticAssistantAvatar } from "./AssistantAvatar";

type CommandCentreSelection =
  | "scout"
  | "search"
  | "tabs-empty"
  | `tab:${string}`;

export interface RankedCommandCentreTab {
  tab: BrowserTabSnapshot;
  group: TabGroupSnapshot | null;
  hostname: string;
  displayUrl: string;
  score: number;
  order: number;
}

export interface CommandCentreProps {
  snapshot: BrowserSnapshot;
  close: () => void;
  askScout: (prompt: string) => void;
  searchWeb: (query: string) => void;
  activateTab: (tabId: string) => void;
}

function materialIcon(name: string) {
  return (
    <span className="material-icon material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

function tabHostname(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "chromecraft:") return "Chromecraft";
    return parsed.hostname.replace(/^www\./u, "") || "New tab";
  } catch {
    return "New tab";
  }
}

/** A query-free display/search URL so tokens and private query values never leak. */
export function commandCentreSafeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "chromecraft:") {
      return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
    }
    return `${parsed.hostname.replace(/^www\./u, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "";
  }
}

function fuzzyScore(candidate: string, query: string): number | null {
  if (!query) return 0;
  const normalized = candidate.toLocaleLowerCase();
  if (normalized === query) return 120;
  if (normalized.startsWith(query)) return 100;
  const wordIndex = normalized.search(
    new RegExp(`(?:^|[\\s./_-])${escapeRegExp(query)}`, "u"),
  );
  if (wordIndex >= 0) return 82 - Math.min(wordIndex, 20);
  const directIndex = normalized.indexOf(query);
  if (directIndex >= 0) return 64 - Math.min(directIndex, 30);

  let cursor = 0;
  let spread = 0;
  for (const character of query) {
    const found = normalized.indexOf(character, cursor);
    if (found < 0) return null;
    spread += found - cursor;
    cursor = found + 1;
  }
  return 34 - Math.min(spread, 24);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function rankCommandCentreTabs(
  tabs: readonly BrowserTabSnapshot[],
  groups: readonly TabGroupSnapshot[],
  query: string,
): RankedCommandCentreTab[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groupById = new Map(groups.map((group) => [group.id, group]));
  return tabs
    .map((tab, order): RankedCommandCentreTab | null => {
      const group = tab.groupId ? (groupById.get(tab.groupId) ?? null) : null;
      const hostname = tabHostname(tab.url);
      const displayUrl = commandCentreSafeUrl(tab.url);
      const fields = [tab.title, hostname, displayUrl, group?.name ?? ""];
      const scores = fields
        .map((field) => fuzzyScore(field, normalizedQuery))
        .filter((score): score is number => score !== null);
      if (normalizedQuery && scores.length === 0) return null;
      return {
        tab,
        group,
        hostname,
        displayUrl,
        score: scores.length > 0 ? Math.max(...scores) : 0,
        order,
      };
    })
    .filter((item): item is RankedCommandCentreTab => item !== null)
    .sort(
      (left, right) => right.score - left.score || left.order - right.order,
    );
}

function tabSelection(tabId: string): `tab:${string}` {
  return `tab:${tabId}`;
}

function selectedTabId(selection: CommandCentreSelection): string | null {
  return selection.startsWith("tab:") ? selection.slice(4) : null;
}

export function CommandCentre({
  snapshot,
  close,
  askScout,
  searchWeb,
  activateTab,
}: CommandCentreProps) {
  const [selection, setSelection] = useState<CommandCentreSelection>("scout");
  const [scoutDraft, setScoutDraft] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [tabQuery, setTabQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const rankedTabs = useMemo(
    () => rankCommandCentreTabs(snapshot.tabs, snapshot.tabGroups, tabQuery),
    [snapshot.tabGroups, snapshot.tabs, tabQuery],
  );
  const currentTabId = selectedTabId(selection);
  const tabMode = currentTabId !== null || selection === "tabs-empty";
  const inputValue =
    selection === "scout"
      ? scoutDraft
      : selection === "search"
        ? searchDraft
        : tabQuery;
  const placeholder =
    selection === "scout"
      ? "Ask Scout..."
      : selection === "search"
        ? "Search the web..."
        : "Filter open tabs...";
  const navigation: CommandCentreSelection[] = [
    "scout",
    "search",
    ...rankedTabs.map((item) => tabSelection(item.tab.id)),
  ];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!tabMode) return;
    if (rankedTabs.length === 0) {
      if (selection !== "tabs-empty") setSelection("tabs-empty");
      return;
    }
    if (
      !currentTabId ||
      !rankedTabs.some((item) => item.tab.id === currentTabId)
    ) {
      setSelection(tabSelection(rankedTabs[0].tab.id));
    }
  }, [currentTabId, rankedTabs, selection, tabMode]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selection]);

  const updateDraft = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    if (selection === "scout") setScoutDraft(value);
    else if (selection === "search") setSearchDraft(value);
    else setTabQuery(value);
  };

  const runSelection = () => {
    if (selection === "scout") {
      const prompt = scoutDraft.trim();
      if (!prompt) return;
      close();
      askScout(prompt);
      return;
    }
    if (selection === "search") {
      const query = searchDraft.trim();
      if (!query) return;
      close();
      searchWeb(query);
      return;
    }
    if (
      !currentTabId ||
      !snapshot.tabs.some((tab) => tab.id === currentTabId)
    ) {
      return;
    }
    close();
    activateTab(currentTabId);
  };

  const moveSelection = (direction: 1 | -1) => {
    const currentIndex = navigation.indexOf(selection);
    const start = currentIndex >= 0 ? currentIndex : direction > 0 ? 1 : 0;
    const next =
      navigation[(start + direction + navigation.length) % navigation.length];
    if (next) setSelection(next);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runSelection();
    }
  };

  return (
    <div className="command-centre-backdrop" onPointerDown={close}>
      <section
        className="command-centre"
        role="dialog"
        aria-modal="true"
        aria-label="Command Centre"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <label className="command-centre-input-shell">
          {materialIcon(
            selection === "scout"
              ? "auto_awesome"
              : selection === "search"
                ? "travel_explore"
                : "tab_search",
          )}
          <input
            ref={inputRef}
            value={inputValue}
            onChange={updateDraft}
            onKeyDown={onInputKeyDown}
            placeholder={placeholder}
            aria-label="Command Centre input"
            aria-controls="command-centre-results"
            aria-activedescendant={
              selection === "tabs-empty"
                ? undefined
                : `command-centre-${selection.replace(":", "-")}`
            }
            autoComplete="off"
            spellCheck={selection === "scout"}
          />
          <kbd>Ctrl K</kbd>
        </label>

        <div
          className="command-centre-results"
          id="command-centre-results"
          role="listbox"
          aria-label="Commands and open tabs"
        >
          <button
            id="command-centre-scout"
            ref={selection === "scout" ? selectedRef : undefined}
            type="button"
            role="option"
            aria-selected={selection === "scout"}
            className="command-centre-row command-centre-action"
            onPointerMove={() => setSelection("scout")}
            onClick={() => {
              if (selection === "scout") runSelection();
              else setSelection("scout");
            }}
          >
            <span className="command-centre-avatar">
              <StaticAssistantAvatar size={26} />
            </span>
            <span className="command-centre-copy">
              <strong>Ask Scout</strong>
              <small>Start a new conversation with Scout.</small>
            </span>
            {selection === "scout" && materialIcon("keyboard_return")}
          </button>
          <button
            id="command-centre-search"
            ref={selection === "search" ? selectedRef : undefined}
            type="button"
            role="option"
            aria-selected={selection === "search"}
            className="command-centre-row command-centre-action"
            onPointerMove={() => setSelection("search")}
            onClick={() => {
              if (selection === "search") runSelection();
              else setSelection("search");
            }}
          >
            <span className="command-centre-leading">
              {materialIcon("travel_explore")}
            </span>
            <span className="command-centre-copy">
              <strong>Search the web</strong>
              <small>Search using your default search engine.</small>
            </span>
            {selection === "search" && materialIcon("keyboard_return")}
          </button>

          <div className="command-centre-section-label" aria-hidden="true">
            <span>Open tabs</span>
            <span>{rankedTabs.length}</span>
          </div>
          <div className="command-centre-tab-list">
            {rankedTabs.map(({ tab, group, hostname, displayUrl }) => {
              const key = tabSelection(tab.id);
              const selected = selection === key;
              return (
                <button
                  id={`command-centre-tab-${tab.id}`}
                  ref={selected ? selectedRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="command-centre-row command-centre-tab"
                  data-command-centre-kind="tab"
                  key={tab.id}
                  onPointerMove={() => setSelection(key)}
                  onClick={() => {
                    close();
                    activateTab(tab.id);
                  }}
                >
                  <span className="command-centre-favicon" aria-hidden="true">
                    {tab.faviconDataUrl ? (
                      <img src={tab.faviconDataUrl} alt="" draggable={false} />
                    ) : tab.isNewTab ? (
                      "C"
                    ) : (
                      hostname.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <span className="command-centre-copy">
                    <strong>{tab.title || hostname}</strong>
                    <small title={displayUrl}>{hostname}</small>
                  </span>
                  {group && (
                    <span
                      className={`command-centre-group group-${group.color}`}
                      title={`Tab group: ${group.name || "Tab group"}`}
                    >
                      {group.name || "Tab group"}
                    </span>
                  )}
                  {tab.id === snapshot.activeTabId && (
                    <span className="command-centre-active-tab">
                      <span aria-hidden="true" /> Active
                    </span>
                  )}
                </button>
              );
            })}
            {rankedTabs.length === 0 && (
              <div className="command-centre-empty" role="status">
                {materialIcon("tab_search")}
                <strong>No open tabs match “{tabQuery}”</strong>
                <small>Try a page title, website, or tab-group name.</small>
              </div>
            )}
          </div>
        </div>

        <footer className="command-centre-footer" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>Enter</kbd> Select
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </footer>
      </section>
    </div>
  );
}
