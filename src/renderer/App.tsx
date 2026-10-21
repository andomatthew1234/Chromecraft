import {
  memo,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  BrowserDataSnapshot,
  BrowserExtensionSnapshot,
  BrowserSnapshot,
  BrowserTabSnapshot,
  DownloadSnapshot,
  ExtensionInstallPreviewSnapshot,
  ExtensionsSnapshot,
  HyperdriveDestinationSnapshot,
  HyperdriveMode,
  HyperdriveOmniboxSignal,
  HyperdrivePreparationState,
  HyperdriveSnapshot,
  NewTabTheme,
  UblockSnapshot,
} from "../shared/browser";
import { resolveNavigationInput } from "../shared/navigation";
import {
  selectSidebarTool,
  sidebarMenuActionLabel,
  type SidebarTool,
} from "../shared/sidebar";
import { parseChromeWebStoreListingUrl } from "../shared/web-store-listing";
import {
  ExtensionInstallBanner,
  type ExtensionInstallBannerState,
} from "./ExtensionInstallBanner";
import { ExpressiveLoadingIndicator } from "./ExpressiveLoadingIndicator";
import {
  buildOmniboxSuggestions,
  createLocalOmniboxIndex,
  getInlineCompletion,
  getOmniboxKeyAction,
  highlightSuggestionText,
  looksLikeAddress,
  type InlineCompletion,
  type OmniboxSuggestion,
} from "./omnibox-model";

const emptyData: BrowserDataSnapshot = {
  bookmarks: [],
  history: [],
  recentlyClosed: [],
  quickLinks: [],
};
const emptyDownloads: DownloadSnapshot = { items: [] };
const emptyExtensions: ExtensionsSnapshot = {
  initialized: false,
  operation: "idle",
  operationExtensionId: null,
  popupExtensionId: null,
  error: null,
  errorExtensionId: null,
  progress: null,
  items: [],
};

type IconName =
  | "add"
  | "back"
  | "bookmark"
  | "bookmarkFilled"
  | "bolt"
  | "chevronLeft"
  | "chevronRight"
  | "chevronUp"
  | "chevronDown"
  | "close"
  | "download"
  | "extension"
  | "delete"
  | "find"
  | "forward"
  | "history"
  | "memory"
  | "folder"
  | "open"
  | "pause"
  | "play"
  | "reload"
  | "search"
  | "settings"
  | "shield"
  | "stop"
  | "tune"
  | "warning"
  | "volumeOff";

const iconSymbols: Record<IconName, string> = {
  add: "add",
  back: "arrow_back",
  bookmark: "bookmark",
  bookmarkFilled: "bookmark",
  bolt: "bolt",
  chevronLeft: "chevron_left",
  chevronRight: "chevron_right",
  chevronUp: "keyboard_arrow_up",
  chevronDown: "keyboard_arrow_down",
  close: "close",
  download: "download",
  extension: "extension",
  delete: "delete_sweep",
  find: "find_in_page",
  forward: "arrow_forward",
  history: "history",
  memory: "memory",
  folder: "folder",
  open: "open_in_new",
  pause: "pause",
  play: "play_arrow",
  reload: "refresh",
  search: "search",
  settings: "settings",
  shield: "shield",
  stop: "stop",
  tune: "tune",
  warning: "warning",
  volumeOff: "volume_off",
};

function Icon({ name }: { name: IconName }) {
  return (
    <span
      className={`material-icon material-symbols-rounded ${name === "bookmarkFilled" ? "filled" : ""}`}
      aria-hidden="true"
    >
      {iconSymbols[name]}
    </span>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: IconName;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">
        <Icon name={icon} />
      </span>
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

type BrowserDialogState =
  | { kind: "bookmark-folder"; tab: BrowserTabSnapshot }
  | { kind: "clear-history" }
  | { kind: "install-extension"; preview: ExtensionInstallPreviewSnapshot }
  | { kind: "remove-extension"; id: string; name: string };

function MaterialDialog({
  state,
  close,
}: {
  state: BrowserDialogState;
  close: (cancelPrepared?: boolean) => void;
}) {
  const [folder, setFolder] = useState("");
  const bookmarkDialog = state.kind === "bookmark-folder";
  const installExtensionDialog = state.kind === "install-extension";
  const removeExtensionDialog = state.kind === "remove-extension";
  const confirm = () => {
    if (bookmarkDialog) {
      void window.chromecraft.addBookmark({
        title: tabLabel(state.tab),
        url: state.tab.url,
        folder: folder.trim() || undefined,
      });
    } else if (installExtensionDialog) {
      void window.chromecraft.commitPreparedExtension(state.preview.token);
    } else if (removeExtensionDialog) {
      void window.chromecraft.removeExtension(state.id);
    } else {
      void window.chromecraft.clearHistory("all");
    }
    close(false);
  };
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) =>
        event.currentTarget === event.target && close(true)
      }
    >
      <section
        className="material-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="browser-dialog-title"
        aria-describedby="browser-dialog-description"
        onKeyDown={(event) => event.key === "Escape" && close(true)}
      >
        <span className="dialog-icon" aria-hidden="true">
          <Icon
            name={
              bookmarkDialog
                ? "folder"
                : installExtensionDialog || removeExtensionDialog
                  ? "extension"
                  : "history"
            }
          />
        </span>
        <h2 id="browser-dialog-title">
          {bookmarkDialog
            ? "Choose a bookmark folder"
            : installExtensionDialog
              ? `Install ${state.preview.name}?`
              : removeExtensionDialog
                ? `Remove ${state.name}?`
                : "Clear all history?"}
        </h2>
        <p id="browser-dialog-description">
          {bookmarkDialog
            ? "Folders keep saved pages organised on this device."
            : installExtensionDialog
              ? `Chromecraft verified version ${state.preview.version}. Review the requested access below before installing it into this profile.`
              : removeExtensionDialog
                ? "The extension will be unloaded and its installed package removed from this Chromecraft profile."
                : "This removes every local browsing-history entry. Bookmarks and downloads stay in place."}
        </p>
        {installExtensionDialog && (
          <div
            className="extension-review"
            aria-label="Verified extension details"
          >
            {state.preview.description && <p>{state.preview.description}</p>}
            <dl>
              <div>
                <dt>Permissions</dt>
                <dd>
                  {state.preview.permissions.length > 0
                    ? state.preview.permissions.join(", ")
                    : "No named browser permissions"}
                </dd>
              </div>
              <div>
                <dt>Website access</dt>
                <dd>
                  {state.preview.hostPermissions.length > 0
                    ? state.preview.hostPermissions.join(", ")
                    : "No requested website access"}
                </dd>
              </div>
              {state.preview.warnings.length > 0 && (
                <div>
                  <dt>Compatibility</dt>
                  <dd>{state.preview.warnings.join(" ")}</dd>
                </div>
              )}
            </dl>
          </div>
        )}
        {bookmarkDialog && (
          <label className="dialog-field">
            <span>Folder name</span>
            <input
              autoFocus
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  confirm();
                }
              }}
              placeholder="Optional"
            />
          </label>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            onClick={() => close(true)}
            autoFocus={!bookmarkDialog}
          >
            Cancel
          </button>
          <button
            type="button"
            className={
              removeExtensionDialog || state.kind === "clear-history"
                ? "destructive-action"
                : "primary-action"
            }
            onClick={confirm}
          >
            {bookmarkDialog
              ? "Save bookmark"
              : installExtensionDialog
                ? "Install extension"
                : removeExtensionDialog
                  ? "Remove extension"
                  : "Clear history"}
          </button>
        </div>
      </section>
    </div>
  );
}

function tabLabel(tab: BrowserTabSnapshot): string {
  if (tab.title && tab.title !== "Loading…") return tab.title;
  if (!tab.url) return "New Tab";
  try {
    return new URL(tab.url).hostname;
  } catch {
    return tab.url;
  }
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const TabButton = memo(function TabButton({
  active,
  tab,
  onMenu,
}: {
  active: boolean;
  tab: BrowserTabSnapshot;
  onMenu: (event: MouseEvent, tab: BrowserTabSnapshot) => void;
}) {
  return (
    <div
      className={`tab ${active ? "active" : ""}`}
      onContextMenu={(event) => onMenu(event, tab)}
      role="presentation"
    >
      <button
        type="button"
        className="tab-target"
        role="tab"
        aria-selected={active}
        onClick={() => void window.chromecraft.activateTab(tab.id)}
        title={tab.title}
        tabIndex={active ? 0 : -1}
        aria-busy={tab.isLoading}
      >
        {tab.isLoading ? (
          <ExpressiveLoadingIndicator compact />
        ) : (
          <span
            className={`tab-favicon ${tab.isNewTab ? "brand-favicon" : ""}`}
            aria-hidden="true"
          >
            {tab.isNewTab ? "C" : hostLabel(tab.url).slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="tab-title">{tabLabel(tab)}</span>
        {tab.isMuted && (
          <span className="tab-muted" title="Muted">
            <Icon name="volumeOff" />
            <span className="visually-hidden">Muted</span>
          </span>
        )}
      </button>
      <button
        type="button"
        className="tab-close"
        onClick={(event) => {
          event.stopPropagation();
          void window.chromecraft.closeTab(tab.id);
        }}
        aria-label={`Close ${tabLabel(tab)}`}
      >
        <Icon name="close" />
      </button>
    </div>
  );
});

function TabStrip({
  snapshot,
  onMenu,
  brandMenuOpen,
  onToggleBrandMenu,
  onSetSidebarAttached,
}: {
  snapshot: BrowserSnapshot;
  onMenu: (event: MouseEvent, tab: BrowserTabSnapshot) => void;
  brandMenuOpen: boolean;
  onToggleBrandMenu: () => void;
  onSetSidebarAttached: (attached: boolean) => void;
}) {
  const sidebarAttached = snapshot.preferences.sidebarAttached;
  const sidebarAction = sidebarMenuActionLabel(sidebarAttached);
  return (
    <div className="tab-strip">
      <div className="brand-menu-anchor">
        <button
          type="button"
          className={`brand ${brandMenuOpen ? "menu-open" : ""}`}
          title="Chromecraft menu"
          aria-label="Chromecraft menu"
          aria-haspopup="menu"
          aria-expanded={brandMenuOpen}
          onClick={(event) => {
            event.stopPropagation();
            onToggleBrandMenu();
          }}
        >
          C
        </button>
        {brandMenuOpen && (
          <section
            className="brand-menu"
            role="menu"
            aria-label="Chromecraft menu"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="brand-menu-header">
              <span className="brand-menu-mark" aria-hidden="true">
                C
              </span>
              <span>
                <strong>Chromecraft</strong>
                <small>Your browser, your workspace</small>
              </span>
            </header>
            <div className="brand-menu-section-label">Window layout</div>
            <button
              type="button"
              className="brand-menu-item"
              role="menuitem"
              onClick={() => onSetSidebarAttached(!sidebarAttached)}
            >
              <span className="brand-menu-item-icon" aria-hidden="true">
                <Icon name={sidebarAttached ? "chevronLeft" : "chevronRight"} />
              </span>
              <span className="brand-menu-item-copy">
                <strong>{sidebarAction}</strong>
                <small>
                  {sidebarAttached
                    ? "Hide the sidebar and give the page the full window"
                    : "Bring back your tools and workspace"}
                </small>
              </span>
              <span
                className={`brand-menu-state ${sidebarAttached ? "on" : ""}`}
                aria-hidden="true"
              />
            </button>
            <footer className="brand-menu-footer">
              More Chromecraft controls will live here.
            </footer>
          </section>
        )}
      </div>
      <div className="tab-scroller" role="tablist" aria-label="Open tabs">
        {snapshot.tabs.map((tab) => (
          <TabButton
            active={tab.id === snapshot.activeTabId}
            key={tab.id}
            tab={tab}
            onMenu={onMenu}
          />
        ))}
      </div>
      <button
        type="button"
        className="new-tab-button"
        onClick={() => void window.chromecraft.createTab()}
        aria-label="New tab"
        title="New tab (Ctrl+T)"
      >
        <Icon name="add" />
      </button>
      <span className="window-drag-region" aria-hidden="true" />
    </div>
  );
}

function createOmniboxHyperdriveSignal(
  tabId: string,
  input: string,
  suggestion: OmniboxSuggestion | undefined,
  inlineCompletion: InlineCompletion | null,
  suggestionSelected: boolean,
): HyperdriveOmniboxSignal | null {
  const trimmedInput = input.trim();
  if (trimmedInput.length < 2 || trimmedInput.length > 2_048) return null;

  if (inlineCompletion && !suggestionSelected) {
    return {
      tabId,
      input: trimmedInput,
      destination: inlineCompletion.url,
      title: inlineCompletion.value,
      trigger: "omnibox-autocomplete",
      confidence: 0.93,
      search: false,
    };
  }

  const value = suggestion?.value ?? trimmedInput;
  const destination = resolveNavigationInput(value);
  if (!destination) return null;
  const search = suggestion
    ? suggestion.kind !== "url" && !looksLikeAddress(value)
    : !looksLikeAddress(value);
  const trigger: HyperdriveOmniboxSignal["trigger"] = suggestionSelected
    ? "omnibox-selection"
    : suggestion?.kind === "remote-search"
      ? "search-suggestion"
      : suggestion?.kind === "url"
        ? "omnibox-autocomplete"
        : "omnibox-typing";
  return {
    tabId,
    input: trimmedInput,
    destination,
    title: suggestion?.label ?? value,
    trigger,
    confidence: suggestionSelected
      ? 0.96
      : suggestion?.kind === "url"
        ? 0.86
        : suggestion?.kind === "remote-search"
          ? 0.72
          : search
            ? 0.56
            : 0.78,
    search,
  };
}

const Omnibox = memo(function Omnibox({
  tab,
  data,
  remoteSuggestionsEnabled,
  hyperdriveMode,
  onExpandedChange,
}: {
  tab: BrowserTabSnapshot;
  data: BrowserDataSnapshot;
  remoteSuggestionsEnabled: boolean;
  hyperdriveMode: HyperdriveMode;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const [value, setValue] = useState(tab.url);
  const [query, setQuery] = useState(tab.url);
  const [editing, setEditing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [inlineCompletion, setInlineCompletion] =
    useState<InlineCompletion | null>(null);
  const [remoteSuggestions, setRemoteSuggestions] = useState<string[]>([]);
  const [suggestionSelected, setSuggestionSelected] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const remoteGeneration = useRef(0);
  const localIndex = useMemo(() => createLocalOmniboxIndex(data), [data]);
  const suggestions = useMemo(
    () => buildOmniboxSuggestions(query, localIndex, remoteSuggestions),
    [localIndex, query, remoteSuggestions],
  );
  const expanded = editing && !dismissed && suggestions.length > 0;
  useEffect(() => {
    if (!editing) {
      setValue(tab.url);
      setQuery(tab.url);
      setInlineCompletion(null);
    }
  }, [editing, tab.id, tab.url]);
  useEffect(() => {
    setActiveIndex(0);
    setSuggestionSelected(false);
  }, [tab.id, query]);
  useEffect(() => onExpandedChange(expanded), [expanded, onExpandedChange]);
  useLayoutEffect(() => {
    if (!editing || !inlineCompletion || value !== inlineCompletion.value)
      return;
    inputRef.current?.setSelectionRange(
      inlineCompletion.suffixStart,
      inlineCompletion.value.length,
    );
  }, [editing, inlineCompletion, value]);
  useEffect(() => {
    const generation = ++remoteGeneration.current;
    setRemoteSuggestions([]);
    const requestedQuery = query.trim();
    if (
      !editing ||
      !remoteSuggestionsEnabled ||
      requestedQuery.length < 2 ||
      requestedQuery.length > 200 ||
      looksLikeAddress(requestedQuery)
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void window.chromecraft
        .getSearchSuggestions(requestedQuery)
        .then((result) => {
          if (
            generation === remoteGeneration.current &&
            result.query === requestedQuery
          ) {
            setRemoteSuggestions(result.suggestions);
          }
        })
        .catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [editing, query, remoteSuggestionsEnabled]);
  useEffect(() => {
    if (!editing || dismissed || hyperdriveMode === "off") return;
    const signal = createOmniboxHyperdriveSignal(
      tab.id,
      query,
      suggestions[activeIndex],
      inlineCompletion,
      suggestionSelected,
    );
    if (!signal) return;

    // Keyboard selection is a strong signal, while ordinary typing is
    // deliberately debounced so network scheduling never sits on the input
    // event's critical rendering path.
    const delay = suggestionSelected ? 16 : 140;
    const timer = window.setTimeout(
      () => window.chromecraft.updateHyperdriveOmnibox(signal),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [
    activeIndex,
    dismissed,
    editing,
    hyperdriveMode,
    inlineCompletion,
    query,
    suggestionSelected,
    suggestions,
    tab.id,
  ]);
  useEffect(
    () =>
      window.chromecraft.onFocusOmnibox(() => {
        setDismissed(false);
        inputRef.current?.focus();
        inputRef.current?.select();
      }),
    [],
  );
  const commit = (nextValue: string, typed = true) => {
    remoteGeneration.current += 1;
    setRemoteSuggestions([]);
    void window.chromecraft.navigate(tab.id, nextValue, typed);
    setEditing(false);
    setInlineCompletion(null);
    inputRef.current?.blur();
  };
  const commitSuggestion = (suggestion: OmniboxSuggestion) =>
    commit(suggestion.value, true);
  const acceptInlineCompletion = (visibleValue?: string) => {
    const acceptedValue = inlineCompletion?.value ?? visibleValue;
    if (!acceptedValue) return;
    setValue(acceptedValue);
    setQuery(acceptedValue);
    setInlineCompletion(null);
    inputRef.current?.setSelectionRange(
      acceptedValue.length,
      acceptedValue.length,
    );
  };
  return (
    <form
      className={`omnibox-form ${expanded ? "expanded" : ""}`}
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const suggestion = suggestions[activeIndex];
        if (suggestion) commitSuggestion(suggestion);
        else commit(value);
      }}
    >
      <span className="omnibox-leading">
        <Icon name="search" />
      </span>
      <input
        ref={inputRef}
        className="omnibox"
        value={value}
        onChange={(event) => {
          const rawValue = event.currentTarget.value;
          const nativeEvent = event.nativeEvent as InputEvent;
          const canComplete =
            nativeEvent.inputType === "insertText" &&
            event.currentTarget.selectionStart === rawValue.length &&
            event.currentTarget.selectionEnd === rawValue.length;
          setDismissed(false);
          setQuery(rawValue);
          if (canComplete) {
            const completion = getInlineCompletion(rawValue, localIndex);
            if (completion) {
              setValue(completion.value);
              setInlineCompletion(completion);
              return;
            }
          }
          setValue(rawValue);
          setInlineCompletion(null);
        }}
        onFocus={(event) => {
          setEditing(true);
          setDismissed(false);
          setQuery(event.currentTarget.value);
          event.currentTarget.select();
        }}
        onBlur={() => window.setTimeout(() => setEditing(false), 120)}
        onKeyDown={(event) => {
          const hasInlineSelection =
            event.currentTarget.selectionStart !== null &&
            event.currentTarget.selectionEnd !== null &&
            event.currentTarget.selectionStart <
              event.currentTarget.selectionEnd &&
            event.currentTarget.selectionEnd ===
              event.currentTarget.value.length;
          const action = getOmniboxKeyAction(event.key, {
            activeIndex,
            suggestionCount: suggestions.length,
            expanded,
            hasInlineCompletion:
              inlineCompletion !== null || hasInlineSelection,
          });
          if (action.type === "move") {
            event.preventDefault();
            setActiveIndex(action.index);
            setSuggestionSelected(true);
          } else if (action.type === "accept-inline") {
            event.preventDefault();
            acceptInlineCompletion(event.currentTarget.value);
          } else if (action.type === "commit") {
            event.preventDefault();
            const suggestion = suggestions[activeIndex];
            if (suggestion) commitSuggestion(suggestion);
            else commit(value);
          } else if (event.key === "Home" && expanded) {
            event.preventDefault();
            setActiveIndex(0);
            setSuggestionSelected(true);
          } else if (event.key === "End" && expanded) {
            event.preventDefault();
            setActiveIndex(suggestions.length - 1);
            setSuggestionSelected(true);
          } else if (action.type === "close") {
            event.preventDefault();
            setDismissed(true);
            setValue(query);
            setInlineCompletion(null);
          }
        }}
        aria-label="Address and search"
        role="combobox"
        aria-autocomplete="both"
        aria-expanded={expanded}
        aria-controls="omnibox-suggestions"
        aria-activedescendant={
          expanded ? `omnibox-option-${activeIndex}` : undefined
        }
        placeholder="Search or enter an address"
        spellCheck={false}
      />
      {expanded && (
        <div
          className="omnibox-suggestions"
          id="omnibox-suggestions"
          role="listbox"
          aria-label="Address and search suggestions"
        >
          {suggestions.map((suggestion, index) => {
            const previous = suggestions[index - 1];
            const startsSection = previous?.section !== suggestion.section;
            return (
              <div className="suggestion-row-group" key={suggestion.id}>
                {startsSection && (
                  <div className="suggestion-section-label" role="presentation">
                    {suggestion.section === "local"
                      ? "From this device"
                      : "Search"}
                  </div>
                )}
                <button
                  type="button"
                  id={`omnibox-option-${index}`}
                  data-kind={suggestion.kind}
                  className={index === activeIndex ? "active" : ""}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    setActiveIndex(index);
                    setSuggestionSelected(true);
                  }}
                  onClick={() => commitSuggestion(suggestion)}
                >
                  <span className="suggestion-icon">
                    <Icon name={suggestion.icon} />
                  </span>
                  <span className="suggestion-copy">
                    <strong>
                      {highlightSuggestionText(suggestion.label, query).map(
                        (segment, segmentIndex) =>
                          segment.match ? (
                            <mark key={segmentIndex}>{segment.text}</mark>
                          ) : (
                            <span key={segmentIndex}>{segment.text}</span>
                          ),
                      )}
                    </strong>
                    <small>{suggestion.detail}</small>
                  </span>
                </button>
              </div>
            );
          })}
          <div className="suggestion-privacy-note">
            {remoteSuggestionsEnabled
              ? "Live suggestions share typed search text with DuckDuckGo"
              : "Suggestions stay on this device"}
          </div>
        </div>
      )}
    </form>
  );
});

function ublockLabel(ublock: UblockSnapshot): string {
  if (ublock.initializing) return "uBlock starting";
  if (ublock.ready) return `uBlock ${ublock.enabled ? "on" : "off"}`;
  return ublock.error ? "uBlock error" : "uBlock off";
}

function Toolbar({
  tab,
  snapshot,
  hyperdrive,
  data,
  bookmarked,
  onFind,
  extensions,
  onOpenExtensions,
  onToggleExtensionPopup,
  onOmniboxExpandedChange,
}: {
  tab: BrowserTabSnapshot;
  snapshot: BrowserSnapshot;
  hyperdrive: HyperdriveSnapshot;
  data: BrowserDataSnapshot;
  bookmarked: boolean;
  onFind: () => void;
  extensions: ExtensionsSnapshot;
  onOpenExtensions: () => void;
  onToggleExtensionPopup: (
    extension: BrowserExtensionSnapshot,
    anchor: DOMRect,
  ) => void;
  onOmniboxExpandedChange: (expanded: boolean) => void;
}) {
  const canBookmark = /^https?:\/\//.test(tab.url);
  const actionExtensions = extensions.items
    .filter(
      (extension) => extension.enabled && extension.ready && extension.popupUrl,
    )
    .slice(0, 4);
  return (
    <div className="toolbar">
      <div className="toolbar-navigation">
        <button
          type="button"
          className="tool-button"
          disabled={!tab.canGoBack}
          onClick={() => void window.chromecraft.goBack(tab.id)}
          aria-label="Back"
        >
          <Icon name="back" />
        </button>
        <button
          type="button"
          className="tool-button"
          disabled={!tab.canGoForward}
          onClick={() => void window.chromecraft.goForward(tab.id)}
          aria-label="Forward"
        >
          <Icon name="forward" />
        </button>
        <button
          type="button"
          className="tool-button"
          onClick={() =>
            tab.isLoading
              ? void window.chromecraft.stop(tab.id)
              : void window.chromecraft.reload(tab.id)
          }
          aria-label={tab.isLoading ? "Stop" : "Reload"}
        >
          <Icon name={tab.isLoading ? "stop" : "reload"} />
        </button>
      </div>
      <Omnibox
        tab={tab}
        data={data}
        remoteSuggestionsEnabled={
          snapshot.preferences.remoteSearchSuggestionsEnabled
        }
        hyperdriveMode={snapshot.preferences.hyperdriveMode}
        onExpandedChange={onOmniboxExpandedChange}
      />
      <div className="toolbar-actions">
        <button
          type="button"
          className={`tool-button bookmark-button ${bookmarked ? "selected" : ""}`}
          disabled={!canBookmark || bookmarked}
          onClick={() =>
            void window.chromecraft.addBookmark({
              title: tabLabel(tab),
              url: tab.url,
            })
          }
          aria-label="Bookmark this page"
          aria-pressed={bookmarked}
          title={bookmarked ? "Bookmarked" : "Bookmark this page"}
        >
          <Icon name={bookmarked ? "bookmarkFilled" : "bookmark"} />
        </button>
        <button
          type="button"
          className="tool-button"
          onClick={onFind}
          aria-label="Find in page"
          title="Find (Ctrl+F)"
        >
          <Icon name="find" />
        </button>
        {actionExtensions.map((extension) => (
          <button
            type="button"
            className={`tool-button extension-action-button ${extensions.popupExtensionId === extension.id ? "selected" : ""}`}
            data-extension-action={extension.id}
            key={extension.id}
            onClick={(event) =>
              onToggleExtensionPopup(
                extension,
                event.currentTarget.getBoundingClientRect(),
              )
            }
            aria-label={`Open ${extension.name}`}
            aria-expanded={extensions.popupExtensionId === extension.id}
            title={extension.name}
          >
            <span aria-hidden="true">
              {extension.name.slice(0, 1).toUpperCase()}
            </span>
          </button>
        ))}
        <button
          type="button"
          className="tool-button extensions-button"
          onClick={onOpenExtensions}
          aria-label={`Manage extensions. ${extensions.items.filter((item) => item.enabled).length} enabled`}
          title="Extensions"
        >
          <Icon name="extension" />
          {extensions.items.length > 0 && (
            <span className="extensions-count" aria-hidden="true">
              {Math.min(99, extensions.items.length)}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`tool-button hyperdrive-button ${snapshot.preferences.hyperdriveMonitorOpen ? "selected" : ""}`}
          data-status={hyperdrive.status}
          onClick={() =>
            void window.chromecraft.setHyperdriveMonitorOpen(
              !snapshot.preferences.hyperdriveMonitorOpen,
            )
          }
          aria-label={`${snapshot.preferences.hyperdriveMonitorOpen ? "Close" : "Open"} Hyperdrive Monitor`}
          aria-pressed={snapshot.preferences.hyperdriveMonitorOpen}
          title={`Hyperdrive: ${hyperdrive.status.replace("-", " ")}`}
        >
          <Icon name="bolt" />
          <span className="hyperdrive-status-dot" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tool-button ublock-button"
          data-state={
            snapshot.ublock.initializing
              ? "starting"
              : snapshot.ublock.ready && snapshot.ublock.enabled
                ? "active"
                : snapshot.ublock.error
                  ? "error"
                  : "inactive"
          }
          onClick={() =>
            snapshot.ublock.ready &&
            void window.chromecraft.openUblockDashboard()
          }
          title={snapshot.ublock.error ?? "Open uBlock Origin dashboard"}
          aria-label={`${ublockLabel(snapshot.ublock)}. Open uBlock Origin dashboard`}
        >
          <Icon name="shield" />
        </button>
      </div>
    </div>
  );
}

function BookmarkBar({ data }: { data: BrowserDataSnapshot }) {
  return (
    <nav className="bookmark-bar" aria-label="Bookmarks bar">
      {data.bookmarks.slice(0, 12).map((bookmark) => (
        <button
          key={bookmark.id}
          onClick={() => void window.chromecraft.createTab(bookmark.url)}
          title={bookmark.url}
        >
          {bookmark.title}
        </button>
      ))}
      {data.bookmarks.length === 0 && (
        <span>Bookmark pages with ☆ to keep them here.</span>
      )}
    </nav>
  );
}

function FindBar({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState({ active: 0, matches: 0 });
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    return window.chromecraft.onFindResult((next) =>
      setResult({ active: next.activeMatchOrdinal, matches: next.matches }),
    );
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (value) void window.chromecraft.findInPage(tabId, value, true);
      else void window.chromecraft.stopFindInPage(tabId);
    }, 80);
    return () => clearTimeout(timer);
  }, [tabId, value]);
  const find = (forward: boolean) => {
    if (value) void window.chromecraft.findInPage(tabId, value, forward);
  };
  return (
    <form className="find-bar" onSubmit={(event) => event.preventDefault()}>
      <span className="find-leading" aria-hidden="true">
        <Icon name="find" />
      </span>
      <input
        ref={ref}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Enter") {
            event.preventDefault();
            find(!event.shiftKey);
          }
        }}
        placeholder="Find in page"
        aria-label="Find in page"
      />
      <span
        className={value && result.matches === 0 ? "no-match" : ""}
        aria-live="polite"
      >
        {!value
          ? "0 of 0"
          : result.matches
            ? `${result.active} of ${result.matches}`
            : "No matches"}
      </span>
      <button
        type="button"
        onClick={() => find(false)}
        aria-label="Previous match"
      >
        <Icon name="chevronUp" />
      </button>
      <button type="button" onClick={() => find(true)} aria-label="Next match">
        <Icon name="chevronDown" />
      </button>
      <button type="button" onClick={onClose} aria-label="Close find">
        <Icon name="close" />
      </button>
    </form>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "Not measurable";
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
}

function humaniseHyperdriveValue(value: string): string {
  return value
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function normaliseExcludedHosts(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/u)
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean)
        .map((host) => {
          try {
            return new URL(host.includes("://") ? host : `https://${host}`)
              .hostname;
          } catch {
            return host.replace(/^\.+|\.+$/gu, "");
          }
        })
        .filter((host) => host.length > 0),
    ),
  ].slice(0, 100);
}

function HyperdriveSettings({
  snapshot,
  hyperdrive,
}: {
  snapshot: BrowserSnapshot;
  hyperdrive: HyperdriveSnapshot;
}) {
  const preferences = snapshot.preferences;
  const [excludedHosts, setExcludedHosts] = useState(
    preferences.hyperdriveExcludedHosts.join(", "),
  );
  const editingExclusions = useRef(false);
  useEffect(() => {
    if (!editingExclusions.current) {
      setExcludedHosts(preferences.hyperdriveExcludedHosts.join(", "));
    }
  }, [preferences.hyperdriveExcludedHosts]);
  const saveExcludedHosts = () => {
    editingExclusions.current = false;
    const hosts = normaliseExcludedHosts(excludedHosts);
    setExcludedHosts(hosts.join(", "));
    void window.chromecraft.setHyperdriveExcludedHosts(hosts);
  };
  const modeEnabled = preferences.hyperdriveMode !== "off";
  const sensibleMaximum = Math.max(
    256,
    Math.min(4_096, Math.floor(hyperdrive.totalMemoryMb / 4 / 64) * 64),
  );
  const sliderMaximum = Math.max(
    sensibleMaximum,
    preferences.hyperdriveRamBudgetMb,
  );
  const formatMemory = (megabytes: number) =>
    megabytes >= 1_024
      ? `${Number((megabytes / 1_024).toFixed(2))} GB`
      : `${megabytes} MB`;
  const estimatedUsageMb =
    hyperdrive.metrics.estimatedSpeculativeMemoryBytes / 1_048_576;
  const usagePercent = Math.min(
    100,
    (estimatedUsageMb / Math.max(1, preferences.hyperdriveRamBudgetMb)) * 100,
  );

  return (
    <section
      className="settings-section hyperdrive-settings"
      aria-labelledby="settings-hyperdrive"
    >
      <div className="settings-section-heading">
        <span className="settings-section-icon">
          <Icon name="bolt" />
        </span>
        <span>
          <h3 className="settings-section-label" id="settings-hyperdrive">
            Performance · Hyperdrive
          </h3>
          <small>Predict and prepare likely navigations locally</small>
        </span>
      </div>
      <label className="setting-row">
        <span className="setting-copy">
          <span className="setting-title">Hyperdrive</span>
          <small className="setting-description">
            Predict and prepare likely destinations before you navigate.
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch-input"
          aria-label="Hyperdrive enabled"
          checked={modeEnabled}
          onChange={(event) =>
            void window.chromecraft.setHyperdriveMode(
              event.target.checked ? "balanced" : "off",
            )
          }
        />
      </label>
      <label className="setting-row setting-row-stacked">
        <span className="setting-copy">
          <span className="setting-title">Performance mode</span>
          <small className="setting-description">
            Hyperdrive is opt-in. Balanced warms connections; stronger modes may
            prefetch eligible documents within your privacy rules.
          </small>
        </span>
        <select
          className="settings-select"
          value={preferences.hyperdriveMode}
          disabled={!modeEnabled}
          onChange={(event) =>
            void window.chromecraft.setHyperdriveMode(
              event.target.value as HyperdriveMode,
            )
          }
        >
          <option value="off">Off</option>
          <option value="balanced">Balanced</option>
          <option value="aggressive">Aggressive</option>
          <option value="maximum">Maximum</option>
        </select>
      </label>
      <label className="setting-row setting-row-stacked hyperdrive-ram-setting">
        <span className="setting-copy">
          <span className="setting-title">Maximum RAM to reserve</span>
          <small className="setting-description">
            A safety ceiling, not a target. Hyperdrive currently estimates{" "}
            {estimatedUsageMb.toFixed(1)} MB.
          </small>
        </span>
        <input
          className="hyperdrive-ram-slider"
          type="range"
          min={64}
          max={sliderMaximum}
          step={64}
          value={preferences.hyperdriveRamBudgetMb}
          disabled={!modeEnabled}
          aria-label="Hyperdrive RAM reserve"
          aria-valuetext={formatMemory(preferences.hyperdriveRamBudgetMb)}
          onChange={(event) =>
            void window.chromecraft.setHyperdriveRamBudgetMb(
              Number(event.target.value),
            )
          }
        />
        <span className="hyperdrive-ram-scale" aria-hidden="true">
          <span>64 MB</span>
          <output>{formatMemory(preferences.hyperdriveRamBudgetMb)}</output>
          <span>{formatMemory(sliderMaximum)}</span>
        </span>
        <span
          className="hyperdrive-budget-meter"
          role="progressbar"
          aria-label="Estimated Hyperdrive memory usage"
          aria-valuemin={0}
          aria-valuemax={preferences.hyperdriveRamBudgetMb}
          aria-valuenow={Math.min(
            preferences.hyperdriveRamBudgetMb,
            Math.round(estimatedUsageMb),
          )}
        >
          <span style={{ width: `${usagePercent}%` }} />
        </span>
      </label>
      <label className="setting-row">
        <span className="setting-copy">
          <span className="setting-title">Allow cross-site preparation</span>
          <small className="setting-description">
            Off by default. May contact a different website before you click.
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch-input"
          checked={preferences.hyperdriveCrossSitePreloadingEnabled}
          disabled={!modeEnabled}
          onChange={(event) =>
            void window.chromecraft.setHyperdriveCrossSitePreloadingEnabled(
              event.target.checked,
            )
          }
        />
      </label>
      <label className="setting-row">
        <span className="setting-copy">
          <span className="setting-title">Prepare search destinations</span>
          <small className="setting-description">
            Allows selected search suggestions to make a speculative request.
            Unfinished queries remain local when this is off.
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch-input"
          checked={preferences.hyperdriveSearchPreloadingEnabled}
          disabled={
            !modeEnabled || !preferences.hyperdriveCrossSitePreloadingEnabled
          }
          onChange={(event) =>
            void window.chromecraft.setHyperdriveSearchPreloadingEnabled(
              event.target.checked,
            )
          }
        />
      </label>
      <div className="setting-row setting-row-stacked">
        <span className="setting-copy">
          <span className="setting-title">Never use Hyperdrive on</span>
          <small className="setting-description">
            Comma-separated website hostnames. Sensitive actions and private
            networks are excluded automatically.
          </small>
        </span>
        <input
          className="settings-text-field"
          value={excludedHosts}
          disabled={!modeEnabled}
          onFocus={() => {
            editingExclusions.current = true;
          }}
          onChange={(event) => setExcludedHosts(event.target.value)}
          onBlur={saveExcludedHosts}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          placeholder="example.com, work.example"
          aria-label="Websites excluded from Hyperdrive"
        />
      </div>
      <label className="setting-row">
        <span className="setting-copy">
          <span className="setting-title">Dev mode</span>
          <small className="setting-description">
            Show the live Hyperdrive Monitor with pages currently being
            predicted and preloaded.
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch-input"
          aria-label="Hyperdrive Dev mode"
          checked={preferences.hyperdriveMonitorOpen}
          onChange={(event) =>
            void window.chromecraft.setHyperdriveMonitorOpen(
              event.target.checked,
            )
          }
        />
      </label>
      <div className="settings-inline-actions">
        <button
          type="button"
          className="tonal-button"
          disabled={!modeEnabled}
          onClick={() => void window.chromecraft.clearHyperdriveSpeculation()}
        >
          Clear speculative work
        </button>
      </div>
    </section>
  );
}

function ExtensionsPanel({
  snapshot,
  requestInstall,
  requestRemove,
}: {
  snapshot: ExtensionsSnapshot;
  requestInstall: (itemUrl: string) => void;
  requestRemove: (id: string, name: string) => void;
}) {
  const [itemUrl, setItemUrl] = useState("");
  const installing =
    snapshot.operation === "installing" || snapshot.operation === "reviewing";
  return (
    <div className="extensions-panel">
      <section className="extension-install-card">
        <span className="extension-install-icon" aria-hidden="true">
          <Icon name="extension" />
        </span>
        <div>
          <h3>Install from Chrome Web Store</h3>
          <p>
            Paste an extension listing URL. Chromecraft verifies its signed CRX3
            package before loading it into this profile.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = itemUrl.trim();
            if (parseChromeWebStoreListingUrl(trimmed)) requestInstall(trimmed);
          }}
        >
          <input
            type="url"
            value={itemUrl}
            onChange={(event) => setItemUrl(event.target.value)}
            placeholder="https://chromewebstore.google.com/detail/…"
            aria-label="Chrome Web Store extension URL"
            disabled={installing}
          />
          <button
            type="submit"
            className="tonal-button"
            disabled={
              !parseChromeWebStoreListingUrl(itemUrl.trim()) || installing
            }
          >
            {installing ? "Verifying…" : "Review install"}
          </button>
        </form>
        <p className="extension-compatibility-note">
          Electron supports a subset of Chrome extension APIs. Chromecraft shows
          compatibility warnings and never labels a downloaded package as ready
          unless Electron actually loads it.
        </p>
      </section>
      {snapshot.error && (
        <div className="extension-error" role="alert">
          <Icon name="warning" />
          <span>{snapshot.error}</span>
        </div>
      )}
      <div className="extension-list" role="list">
        {snapshot.items.map((extension) => (
          <article
            className="extension-item"
            key={extension.id}
            role="listitem"
          >
            <div className="extension-item-heading">
              <span className="extension-avatar" aria-hidden="true">
                {extension.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{extension.name}</strong>
                <small>Version {extension.version}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch-input"
                checked={extension.enabled}
                disabled={snapshot.operation !== "idle"}
                onChange={(event) =>
                  void window.chromecraft.setExtensionEnabled(
                    extension.id,
                    event.target.checked,
                  )
                }
                aria-label={`${extension.enabled ? "Disable" : "Enable"} ${extension.name}`}
              />
            </div>
            <p>{extension.description || "No description provided."}</p>
            <span className="extension-status" data-status={extension.status}>
              {extension.status === "ready"
                ? "Ready"
                : extension.status === "disabled"
                  ? "Disabled"
                  : extension.status === "loading"
                    ? "Loading"
                    : extension.status === "incompatible"
                      ? "Compatibility issue"
                      : "Load failed"}
            </span>
            {extension.error && (
              <small className="extension-item-error">{extension.error}</small>
            )}
            {extension.warnings.length > 0 && (
              <details>
                <summary>
                  {extension.warnings.length} compatibility warning(s)
                </summary>
                <ul>
                  {extension.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="extension-actions">
              {extension.popupUrl && (
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    void window.chromecraft.toggleExtensionPopup(extension.id, {
                      x: rect.x,
                      y: rect.y,
                      width: rect.width,
                      height: rect.height,
                    });
                  }}
                >
                  Open popup
                </button>
              )}
              {extension.optionsUrl && (
                <button
                  type="button"
                  onClick={() =>
                    void window.chromecraft.openExtensionPage(
                      extension.id,
                      "options",
                    )
                  }
                >
                  Options
                </button>
              )}
              <button
                type="button"
                className="danger-text-button"
                disabled={snapshot.operation !== "idle"}
                onClick={() => requestRemove(extension.id, extension.name)}
              >
                Remove
              </button>
            </div>
          </article>
        ))}
        {snapshot.initialized && snapshot.items.length === 0 && (
          <EmptyState
            icon="extension"
            title="No user extensions"
            description="Open a Chrome Web Store listing or paste its URL above."
          />
        )}
        {!snapshot.initialized && (
          <div className="extension-loading">
            <ExpressiveLoadingIndicator label="Loading extensions" />
            <span>Loading extensions…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Sidebar({
  snapshot,
  hyperdrive,
  data,
  downloads,
  extensions,
  tool,
  setTool,
  requestClearHistory,
  requestExtensionInstall,
  requestExtensionRemove,
}: {
  snapshot: BrowserSnapshot;
  hyperdrive: HyperdriveSnapshot;
  data: BrowserDataSnapshot;
  downloads: DownloadSnapshot;
  extensions: ExtensionsSnapshot;
  tool: SidebarTool | null;
  setTool: (tool: SidebarTool | null) => void;
  requestClearHistory: (range: "hour" | "day" | "all") => void;
  requestExtensionInstall: (itemUrl: string) => void;
  requestExtensionRemove: (id: string, name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const open = snapshot.preferences.sidebarOpen;
  const navigate = (url: string) => void window.chromecraft.createTab(url);
  const needle = query.toLowerCase();
  const bookmarks = data.bookmarks.filter((item) =>
    `${item.title} ${item.url} ${item.folder}`.toLowerCase().includes(needle),
  );
  const history = data.history.filter((item) =>
    `${item.title} ${item.url}`.toLowerCase().includes(needle),
  );
  const tools = [
    ["bookmarks", "bookmark", "Bookmarks"],
    ["history", "history", "History"],
    ["downloads", "download", "Downloads"],
    ["extensions", "extension", "Extensions"],
    ["settings", "settings", "Settings"],
  ] as const;
  if (!snapshot.preferences.sidebarAttached) return null;

  return (
    <aside
      className={`sidebar ${open && tool ? "panel-open" : "rail-only"}`}
      aria-label="Browser sidebar"
    >
      <nav className="sidebar-rail">
        {tools.map(([id, icon, label]) => (
          <button
            type="button"
            key={id}
            className={tool === id ? "active" : ""}
            onClick={() => {
              const nextTool = selectSidebarTool(tool, id);
              setTool(nextTool);
              void window.chromecraft.setSidebarOpen(Boolean(nextTool));
            }}
            title={label}
            aria-label={label}
            aria-current={tool === id ? "page" : undefined}
            aria-controls="sidebar-panel"
          >
            <span className="rail-selection-indicator">
              <Icon name={icon} />
            </span>
          </button>
        ))}
        <button
          type="button"
          className="sidebar-collapse"
          onClick={() => void window.chromecraft.setSidebarAttached(false)}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          aria-expanded="true"
        >
          <Icon name="chevronLeft" />
        </button>
      </nav>
      {open && tool && (
        <section
          className="sidebar-panel"
          id="sidebar-panel"
          aria-labelledby="sidebar-panel-title"
        >
          <header className="panel-header">
            <h2 id="sidebar-panel-title">
              {tool[0].toUpperCase() + tool.slice(1)}
            </h2>
          </header>
          {(tool === "bookmarks" || tool === "history") && (
            <label className="panel-search-field">
              <Icon name="search" />
              <input
                className="panel-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${tool}`}
                aria-label={`Search ${tool}`}
              />
            </label>
          )}
          {tool === "bookmarks" && (
            <>
              <div className="panel-actions">
                <button
                  onClick={() => void window.chromecraft.importBookmarks()}
                >
                  Import
                </button>
                <button
                  onClick={() => void window.chromecraft.exportBookmarks()}
                >
                  Export
                </button>
              </div>
              <div className="panel-list" role="list">
                {bookmarks.map((item) => (
                  <article className="list-item" key={item.id} role="listitem">
                    <button
                      className="entry-main"
                      onClick={() => navigate(item.url)}
                    >
                      <strong>{item.title}</strong>
                      <small className="entry-supporting-text">
                        {item.folder || hostLabel(item.url)}
                      </small>
                    </button>
                    <button
                      className="entry-remove"
                      onClick={() =>
                        void window.chromecraft.removeBookmark(item.id)
                      }
                      aria-label="Remove bookmark"
                    >
                      <Icon name="close" />
                    </button>
                  </article>
                ))}
                {bookmarks.length === 0 && (
                  <EmptyState
                    icon="bookmark"
                    title="No bookmarks yet"
                    description="Save a page to keep it within easy reach."
                  />
                )}
              </div>
            </>
          )}
          {tool === "history" && (
            <>
              <div className="panel-actions">
                <button onClick={() => requestClearHistory("hour")}>
                  Last hour
                </button>
                <button onClick={() => requestClearHistory("day")}>
                  Today
                </button>
                <button onClick={() => requestClearHistory("all")}>All</button>
              </div>
              <div className="panel-list" role="list">
                {history.map((item) => (
                  <article className="list-item" key={item.id} role="listitem">
                    <button
                      className="entry-main"
                      onClick={() => navigate(item.url)}
                    >
                      <strong>{item.title}</strong>
                      <small className="entry-supporting-text">
                        {new Date(item.visitedAt).toLocaleString()}
                      </small>
                    </button>
                    <button
                      className="entry-remove"
                      onClick={() =>
                        void window.chromecraft.removeHistory(item.id)
                      }
                      aria-label={`Remove ${item.title} from history`}
                    >
                      <Icon name="close" />
                    </button>
                  </article>
                ))}
                {history.length === 0 && (
                  <EmptyState
                    icon="history"
                    title="No history yet"
                    description="Pages you visit will appear here locally."
                  />
                )}
              </div>
            </>
          )}
          {tool === "downloads" && (
            <>
              <div className="panel-actions">
                <button
                  onClick={() =>
                    void window.chromecraft.clearFinishedDownloads()
                  }
                >
                  Clear finished
                </button>
              </div>
              <div className="panel-list" role="list">
                {downloads.items.map((item) => (
                  <article
                    className="download list-item"
                    key={item.id}
                    role="listitem"
                  >
                    <div className="entry-main">
                      <strong>{item.filename}</strong>
                      <small
                        className="entry-supporting-text"
                        aria-live="polite"
                      >
                        {item.state} ·{" "}
                        {item.totalBytes > 0
                          ? Math.round(
                              (item.receivedBytes / item.totalBytes) * 100,
                            )
                          : 0}
                        %
                      </small>
                      <progress
                        max={Math.max(1, item.totalBytes)}
                        value={item.receivedBytes}
                        aria-label={`Download progress for ${item.filename}`}
                        aria-valuetext={`${item.state}, ${item.totalBytes > 0 ? Math.round((item.receivedBytes / item.totalBytes) * 100) : 0}%`}
                      />
                    </div>
                    <div className="download-actions">
                      {item.state === "progressing" && (
                        <button
                          onClick={() =>
                            void window.chromecraft.pauseDownload(item.id)
                          }
                          aria-label={`Pause ${item.filename}`}
                        >
                          <Icon name="pause" />
                        </button>
                      )}
                      {item.state === "paused" && (
                        <button
                          onClick={() =>
                            void window.chromecraft.resumeDownload(item.id)
                          }
                          aria-label={`Resume ${item.filename}`}
                        >
                          <Icon name="play" />
                        </button>
                      )}
                      {(item.state === "cancelled" ||
                        item.state === "interrupted") && (
                        <button
                          onClick={() =>
                            void window.chromecraft.retryDownload(item.id)
                          }
                          aria-label={`Retry ${item.filename}`}
                        >
                          Retry
                        </button>
                      )}
                      {item.state === "progressing" && (
                        <button
                          onClick={() =>
                            void window.chromecraft.cancelDownload(item.id)
                          }
                          aria-label={`Cancel ${item.filename}`}
                        >
                          <Icon name="close" />
                        </button>
                      )}
                      {item.state === "completed" && (
                        <>
                          <button
                            onClick={() =>
                              void window.chromecraft.openDownload(item.id)
                            }
                            aria-label={`Open ${item.filename}`}
                          >
                            <Icon name="open" />
                          </button>
                          <button
                            onClick={() =>
                              void window.chromecraft.showDownloadInFolder(
                                item.id,
                              )
                            }
                            aria-label={`Show ${item.filename} in folder`}
                          >
                            <Icon name="folder" />
                          </button>
                        </>
                      )}
                      <button
                        onClick={() =>
                          void window.chromecraft.removeDownload(item.id)
                        }
                        aria-label={`Remove ${item.filename} from downloads`}
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))}
                {downloads.items.length === 0 && (
                  <EmptyState
                    icon="download"
                    title="No downloads"
                    description="Files you download will appear here."
                  />
                )}
              </div>
            </>
          )}
          {tool === "extensions" && (
            <ExtensionsPanel
              snapshot={extensions}
              requestInstall={requestExtensionInstall}
              requestRemove={requestExtensionRemove}
            />
          )}
          {tool === "settings" && (
            <div className="settings-list">
              <section
                className="settings-section"
                aria-labelledby="settings-general"
              >
                <h3 className="settings-section-label" id="settings-general">
                  General
                </h3>
                <label className="setting-row">
                  <span className="setting-copy">
                    <span className="setting-title">
                      Restore tabs on launch
                    </span>
                    <small className="setting-description">
                      Stored locally on this device
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch-input"
                    checked={snapshot.preferences.restoreSession}
                    onChange={(event) =>
                      void window.chromecraft.setRestoreSession(
                        event.target.checked,
                      )
                    }
                  />
                </label>
                <label className="setting-row">
                  <span className="setting-copy">
                    <span className="setting-title">Show bookmarks bar</span>
                    <small className="setting-description">
                      Keep saved sites below the address bar
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch-input"
                    checked={snapshot.preferences.bookmarkBarVisible}
                    onChange={(event) =>
                      void window.chromecraft.setBookmarkBarVisible(
                        event.target.checked,
                      )
                    }
                  />
                </label>
              </section>
              <section
                className="settings-section"
                aria-labelledby="settings-privacy"
              >
                <h3 className="settings-section-label" id="settings-privacy">
                  Privacy & appearance
                </h3>
                <label className="setting-row">
                  <span className="setting-copy">
                    <span className="setting-title">uBlock Origin</span>
                    <small className="setting-description">
                      {ublockLabel(snapshot.ublock)}
                      {snapshot.ublock.version
                        ? ` · Version ${snapshot.ublock.version}`
                        : " · Preinstalled content blocking"}
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch-input"
                    checked={snapshot.ublock.enabled}
                    disabled={snapshot.ublock.initializing}
                    onChange={(event) =>
                      void window.chromecraft.setUblockEnabled(
                        event.target.checked,
                      )
                    }
                  />
                </label>
                <label className="setting-row">
                  <span className="setting-copy">
                    <span className="setting-title">
                      Live search suggestions
                    </span>
                    <small className="setting-description">
                      Share typed search text with DuckDuckGo for live
                      suggestions. Off by default; local history and bookmark
                      autocomplete always stays available.
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch-input"
                    checked={
                      snapshot.preferences.remoteSearchSuggestionsEnabled
                    }
                    onChange={(event) =>
                      void window.chromecraft.setRemoteSearchSuggestionsEnabled(
                        event.target.checked,
                      )
                    }
                  />
                </label>
                <label className="theme-setting setting-row">
                  <span className="setting-copy">
                    <span className="setting-title">New tab theme</span>
                    <small className="setting-description">
                      Choose a restrained colour mood
                    </small>
                  </span>
                  <select
                    value={snapshot.preferences.newTabTheme}
                    onChange={(event) =>
                      void window.chromecraft.setNewTabTheme(
                        event.target.value as NewTabTheme,
                      )
                    }
                  >
                    <option value="overworld">Chromecraft blue</option>
                    <option value="nether">Soft violet</option>
                    <option value="end">Blue grey</option>
                    <option value="minimal">Minimal</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="tonal-button"
                  onClick={() => void window.chromecraft.openUblockDashboard()}
                >
                  Open uBlock settings
                </button>
              </section>
              <HyperdriveSettings snapshot={snapshot} hyperdrive={hyperdrive} />
            </div>
          )}
        </section>
      )}
    </aside>
  );
}

const hyperdriveStates: HyperdrivePreparationState[] = [
  "predicted",
  "queued",
  "connecting",
  "prefetching",
  "prefetched",
  "blocked",
  "deduplicated",
  "cache-reused",
  "not-reused",
  "cancelled",
  "failed",
  "evicted",
];

function hyperdriveStateLabel(state: HyperdrivePreparationState): string {
  const labels: Record<HyperdrivePreparationState, string> = {
    predicted: "Predicted only",
    queued: "Queued",
    connecting: "Connection warm-up requested",
    prefetching: "Document prefetching",
    prefetched: "Document prefetched",
    "preparing-page": "Preparing page",
    ready: "Fully prepared",
    activated: "Fully prepared and activated",
    blocked: "Preparation blocked",
    deduplicated: "Site-owned prefetch",
    "cache-reused": "Cache reuse confirmed",
    "not-reused": "Preparation not reused",
    cancelled: "Cancelled",
    failed: "Failed",
    evicted: "Evicted",
  };
  return labels[state];
}

const HyperdriveDestination = memo(function HyperdriveDestination({
  destination,
}: {
  destination: HyperdriveDestinationSnapshot;
}) {
  const accessibleState = hyperdriveStateLabel(destination.state);
  return (
    <article className="hyperdrive-destination">
      <div className="hyperdrive-destination-heading">
        <span className="hyperdrive-site-mark" aria-hidden="true">
          {(destination.host[0] ?? "?").toUpperCase()}
        </span>
        <span className="hyperdrive-destination-copy">
          <strong title={destination.title}>{destination.title}</strong>
          <small title={destination.displayUrl}>{destination.displayUrl}</small>
        </span>
        <span
          className="hyperdrive-state-chip"
          data-state={destination.state}
          title={`Preparation state: ${accessibleState}`}
        >
          {accessibleState}
        </span>
      </div>
      <div className="hyperdrive-confidence-row">
        <span>{Math.round(destination.confidence * 100)}% confidence</span>
        <span>{humaniseHyperdriveValue(destination.trigger)}</span>
      </div>
      <span
        className="hyperdrive-confidence-meter"
        role="progressbar"
        aria-label={`Prediction confidence for ${destination.title}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(destination.confidence * 100)}
      >
        <span style={{ width: `${destination.confidence * 100}%` }} />
      </span>
      <div className="hyperdrive-destination-facts">
        <span>
          {destination.preparation === "none"
            ? "No network preparation"
            : humaniseHyperdriveValue(destination.preparation)}
        </span>
        <span>{formatDuration(destination.elapsedMs)}</span>
        {destination.estimatedBytes !== null && (
          <span>{formatBytes(destination.estimatedBytes)} estimated</span>
        )}
        {destination.reused && <span className="positive">Reused</span>}
        {destination.reuseEvidence === "navigation-transfer-size-zero" && (
          <span className="positive">Navigation transfer: 0 bytes</span>
        )}
      </div>
      <details className="hyperdrive-reason">
        <summary>Why this prediction?</summary>
        <p>{destination.reason}</p>
        {destination.adapter && <p>Adapter: {destination.adapter}</p>}
      </details>
    </article>
  );
});

const HyperdriveMonitor = memo(function HyperdriveMonitor({
  snapshot,
}: {
  snapshot: HyperdriveSnapshot;
}) {
  const [filter, setFilter] = useState<"all" | HyperdrivePreparationState>(
    "all",
  );
  const filteredDestinations = useMemo(
    () =>
      filter === "all"
        ? snapshot.destinations
        : snapshot.destinations.filter(
            (destination) => destination.state === filter,
          ),
    [filter, snapshot.destinations],
  );
  const omniboxPredictions = useMemo(
    () =>
      snapshot.destinations.filter(
        (destination) => destination.source === "omnibox",
      ),
    [snapshot.destinations],
  );
  const estimatedUsageMb =
    snapshot.metrics.estimatedSpeculativeMemoryBytes / 1_048_576;
  const budgetPercent = Math.min(
    100,
    (estimatedUsageMb / Math.max(1, snapshot.ramBudgetMb)) * 100,
  );
  const metrics = [
    ["Predictions", snapshot.metrics.activePredictions],
    ["Active preloads", snapshot.metrics.activePreloads],
    ["Prefetched", snapshot.metrics.preparedDestinations],
    ["Cache reuse", snapshot.metrics.cacheReuseSuccesses],
    ["Correct", snapshot.metrics.successfulPredictions],
    ["Missed", snapshot.metrics.missedPredictions],
    ["Cancelled", snapshot.metrics.cancelledPreloads],
    ["Wasted", snapshot.metrics.wastedPreparations],
  ] as const;

  return (
    <aside
      className="hyperdrive-monitor"
      aria-label="Hyperdrive Monitor"
      aria-describedby="hyperdrive-monitor-privacy"
    >
      <header className="hyperdrive-monitor-header">
        <span className="hyperdrive-monitor-brand">
          <Icon name="bolt" />
        </span>
        <span>
          <h2>Hyperdrive Monitor</h2>
          <small id="hyperdrive-monitor-privacy">
            Live diagnostics · not persisted
          </small>
        </span>
        <button
          type="button"
          className="monitor-icon-button"
          onClick={() =>
            void window.chromecraft.setHyperdriveMonitorOpen(false)
          }
          aria-label="Close Hyperdrive Monitor"
          title="Close monitor"
        >
          <Icon name="close" />
        </button>
      </header>

      <div className="hyperdrive-monitor-scroll">
        <section className="hyperdrive-status-card">
          <div className="hyperdrive-status-line">
            <span
              className="hyperdrive-live-indicator"
              data-status={snapshot.status}
              aria-hidden="true"
            />
            <span>
              <strong aria-live="polite">
                {humaniseHyperdriveValue(snapshot.status)}
              </strong>
              <small>{humaniseHyperdriveValue(snapshot.mode)} mode</small>
            </span>
            <span className="hyperdrive-status-actions">
              <button
                type="button"
                className="monitor-icon-button"
                onClick={() =>
                  void window.chromecraft.setHyperdriveMonitorPaused(
                    !snapshot.paused,
                  )
                }
                aria-label={
                  snapshot.paused ? "Resume live logging" : "Pause live logging"
                }
                aria-pressed={snapshot.paused}
                title={
                  snapshot.paused ? "Resume live logging" : "Pause live logging"
                }
              >
                <Icon name={snapshot.paused ? "play" : "pause"} />
              </button>
              <button
                type="button"
                className="monitor-icon-button"
                onClick={() => void window.chromecraft.clearHyperdriveEvents()}
                aria-label="Clear Hyperdrive event history"
                title="Clear event history"
              >
                <Icon name="delete" />
              </button>
            </span>
          </div>
          <div className="hyperdrive-memory-heading">
            <span>
              Estimated speculative memory
              <strong>
                {estimatedUsageMb.toFixed(1)} / {snapshot.ramBudgetMb} MB
              </strong>
            </span>
            <small>
              {snapshot.availableMemoryMb.toLocaleString()} MB system available
            </small>
          </div>
          <span className="hyperdrive-budget-meter" aria-hidden="true">
            <span style={{ width: `${budgetPercent}%` }} />
          </span>
        </section>

        {snapshot.warning && (
          <div className="hyperdrive-warning" role="status">
            <Icon name="warning" />
            <span>{snapshot.warning}</span>
          </div>
        )}

        <section className="hyperdrive-monitor-section">
          <div className="hyperdrive-section-heading">
            <h3>Live metrics</h3>
            <span>
              rank {snapshot.metrics.rankingTimeMs.toFixed(3)} ms ·{" "}
              {snapshot.metrics.predictionsEvaluated} candidates
            </span>
          </div>
          <div className="hyperdrive-metrics-grid">
            {metrics.map(([label, value]) => (
              <div className="hyperdrive-metric" key={label}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <dl className="hyperdrive-measurements">
            <div>
              <dt>Observed speculative transfer</dt>
              <dd>
                {snapshot.metrics.observedSpeculativeBytes !== null &&
                snapshot.metrics.observedSpeculativeBytes > 0
                  ? formatBytes(snapshot.metrics.observedSpeculativeBytes)
                  : "Not attributable"}
              </dd>
            </div>
            <div>
              <dt>Main process private memory</dt>
              <dd>{formatBytes(snapshot.metrics.processPrivateMemoryBytes)}</dd>
            </div>
            <div>
              <dt>Navigation time saved</dt>
              <dd>
                {snapshot.metrics.navigationTimeSavedMs === null
                  ? "Not proven"
                  : formatDuration(snapshot.metrics.navigationTimeSavedMs)}
              </dd>
            </div>
          </dl>
        </section>

        <section className="hyperdrive-monitor-section">
          <div className="hyperdrive-section-heading">
            <h3>Omnibox predictions</h3>
            <span>{omniboxPredictions.length} active</span>
          </div>
          {omniboxPredictions.length > 0 ? (
            <div className="hyperdrive-omnibox-list">
              {omniboxPredictions.slice(0, 3).map((destination) => (
                <div key={destination.id}>
                  <span className="hyperdrive-site-mark" aria-hidden="true">
                    {(destination.host[0] ?? "?").toUpperCase()}
                  </span>
                  <span>
                    <strong>{destination.title}</strong>
                    <small>
                      {humaniseHyperdriveValue(destination.trigger)} ·{" "}
                      {Math.round(destination.confidence * 100)}%
                    </small>
                  </span>
                  <span className="hyperdrive-omnibox-state">
                    {hyperdriveStateLabel(destination.state)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="hyperdrive-empty-copy">
              Start typing an address to see local predictions.
            </p>
          )}
        </section>

        <section className="hyperdrive-monitor-section">
          <div className="hyperdrive-section-heading hyperdrive-destination-toolbar">
            <h3>Destinations</h3>
            <label className="hyperdrive-filter">
              <Icon name="tune" />
              <span className="visually-hidden">Filter preparation state</span>
              <select
                value={filter}
                onChange={(event) =>
                  setFilter(
                    event.target.value as "all" | HyperdrivePreparationState,
                  )
                }
                aria-label="Filter destinations by preparation state"
              >
                <option value="all">All states</option>
                {hyperdriveStates.map((state) => (
                  <option key={state} value={state}>
                    {hyperdriveStateLabel(state)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="hyperdrive-destination-list">
            {filteredDestinations.map((destination) => (
              <HyperdriveDestination
                destination={destination}
                key={destination.id}
              />
            ))}
            {filteredDestinations.length === 0 && (
              <p className="hyperdrive-empty-copy">
                No destinations match this filter.
              </p>
            )}
          </div>
        </section>

        <section className="hyperdrive-monitor-section hyperdrive-events-section">
          <div className="hyperdrive-section-heading">
            <h3>Event history</h3>
            <span>
              {snapshot.paused ? "Paused" : `${snapshot.events.length} events`}
            </span>
          </div>
          <ol className="hyperdrive-event-list">
            {snapshot.events.map((event) => (
              <li className={event.warning ? "warning" : ""} key={event.id}>
                <span
                  className="hyperdrive-event-marker"
                  data-state={event.state}
                />
                <span>
                  <strong>{event.message}</strong>
                  <small>
                    {new Date(event.timestamp).toLocaleTimeString()} ·{" "}
                    {hyperdriveStateLabel(event.state)}
                    {event.host ? ` · ${event.host}` : ""}
                  </small>
                </span>
              </li>
            ))}
            {snapshot.events.length === 0 && (
              <li className="hyperdrive-empty-copy">No events recorded.</li>
            )}
          </ol>
        </section>

        <button
          type="button"
          className="tonal-button hyperdrive-clear-work"
          onClick={() => void window.chromecraft.clearHyperdriveSpeculation()}
          disabled={snapshot.mode === "off"}
        >
          Clear speculative work
        </button>
      </div>
    </aside>
  );
});

function NewTabSurface({
  tab,
  snapshot,
  data,
}: {
  tab: BrowserTabSnapshot;
  snapshot: BrowserSnapshot;
  data: BrowserDataSnapshot;
}) {
  const [value, setValue] = useState("");
  if (!tab.isNewTab) return null;
  const recent = data.history.filter(
    (item, index, all) =>
      all.findIndex((entry) => entry.url === item.url) === index,
  );
  const links =
    data.quickLinks.length > 0 ? data.quickLinks : recent.slice(0, 8);
  return (
    <main
      className={`new-tab-surface theme-${snapshot.preferences.newTabTheme}`}
    >
      <section className="start-panel" aria-labelledby="new-tab-title">
        <header className="start-identity">
          <div className="start-mark" aria-hidden="true">
            C
          </div>
          <h1 id="new-tab-title">Chromecraft</h1>
        </header>
        <form
          className="start-search"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void window.chromecraft.navigate(tab.id, value);
          }}
        >
          <span className="start-search-icon">
            <Icon name="search" />
          </span>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Search the web or enter an address"
            aria-label="New tab search"
            autoFocus
            spellCheck={false}
          />
        </form>
        <div className="quick-links" role="list">
          {links.map((link) => (
            <div className="quick-link" key={link.id} role="listitem">
              <button
                type="button"
                className="quick-link-tile"
                onClick={() =>
                  void window.chromecraft.navigate(tab.id, link.url)
                }
              >
                <span className="quick-link-icon">
                  {link.title.slice(0, 1).toUpperCase()}
                </span>
                <span className="quick-link-label">{link.title}</span>
              </button>
              {"createdAt" in link && (
                <button
                  type="button"
                  className="quick-remove"
                  onClick={() =>
                    void window.chromecraft.removeQuickLink(link.id)
                  }
                  aria-label={`Remove ${link.title} from new tab`}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function CommandPalette({
  snapshot,
  data,
  close,
}: {
  snapshot: BrowserSnapshot;
  data: BrowserDataSnapshot;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.toLowerCase();
  const items = [
    ...snapshot.tabs.map((tab) => ({
      id: `tab-${tab.id}`,
      label: tabLabel(tab),
      detail: "Open tab",
      run: () => window.chromecraft.activateTab(tab.id),
    })),
    ...data.bookmarks.map((item) => ({
      id: `bookmark-${item.id}`,
      label: item.title,
      detail: `Bookmark · ${hostLabel(item.url)}`,
      run: () => window.chromecraft.createTab(item.url),
    })),
    ...data.history.slice(0, 50).map((item) => ({
      id: `history-${item.id}`,
      label: item.title,
      detail: `History · ${hostLabel(item.url)}`,
      run: () => window.chromecraft.createTab(item.url),
    })),
    {
      id: "new",
      label: "New tab",
      detail: "Action",
      run: () => window.chromecraft.createTab(),
    },
    {
      id: "reopen",
      label: "Reopen closed tab",
      detail: "Action",
      run: () => window.chromecraft.reopenClosedTab(),
    },
  ]
    .filter((item) =>
      `${item.label} ${item.detail}`.toLowerCase().includes(needle),
    )
    .slice(0, 12);
  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
            if (event.key === "Enter" && items[0]) {
              void items[0].run();
              close();
            }
          }}
          placeholder="Search tabs, bookmarks, history and actions…"
        />
        <div className="palette-results">
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => {
                void item.run();
                close();
              }}
            >
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </button>
          ))}
          {items.length === 0 && (
            <div className="palette-empty">No matching commands</div>
          )}
        </div>
      </section>
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);
  const [hyperdrive, setHyperdrive] = useState<HyperdriveSnapshot | null>(null);
  const [data, setData] = useState(emptyData);
  const [downloads, setDownloads] = useState(emptyDownloads);
  const [extensions, setExtensions] = useState(emptyExtensions);
  const [tool, setTool] = useState<SidebarTool | null>(null);
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [omniboxExpanded, setOmniboxExpanded] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dialog, setDialog] = useState<BrowserDialogState | null>(null);
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    tab: BrowserTabSnapshot;
  } | null>(null);
  useEffect(() => {
    let mounted = true;
    void Promise.all([
      window.chromecraft.getSnapshot(),
      window.chromecraft.getBrowserData(),
      window.chromecraft.getDownloads(),
      window.chromecraft.getHyperdriveSnapshot(),
      window.chromecraft.getExtensions(),
    ]).then(
      ([
        nextSnapshot,
        nextData,
        nextDownloads,
        nextHyperdrive,
        nextExtensions,
      ]) => {
        if (mounted) {
          setSnapshot(nextSnapshot);
          setTool(nextSnapshot.preferences.sidebarOpen ? "bookmarks" : null);
          setData(nextData);
          setDownloads(nextDownloads);
          setHyperdrive(nextHyperdrive);
          setExtensions(nextExtensions);
        }
      },
    );
    const cleanups = [
      window.chromecraft.onSnapshot(setSnapshot),
      window.chromecraft.onBrowserData(setData),
      window.chromecraft.onDownloads(setDownloads),
      window.chromecraft.onHyperdriveSnapshot(setHyperdrive),
      window.chromecraft.onExtensions(setExtensions),
      window.chromecraft.onShowFind(() => setFindOpen(true)),
      window.chromecraft.onOpenCommandPalette(() => setPaletteOpen(true)),
    ];
    return () => {
      mounted = false;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);
  const activeTab = useMemo(
    () => snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? null,
    [snapshot],
  );
  useEffect(() => setFindOpen(false), [activeTab?.id]);
  useEffect(() => {
    const open = Boolean(
      omniboxExpanded ||
      findOpen ||
      paletteOpen ||
      brandMenuOpen ||
      tabMenu ||
      dialog,
    );
    void window.chromecraft.setChromeOverlayOpen(open);
    return () => {
      if (open) void window.chromecraft.setChromeOverlayOpen(false);
    };
  }, [brandMenuOpen, dialog, findOpen, omniboxExpanded, paletteOpen, tabMenu]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (event.key === "Escape") {
        void window.chromecraft.closeExtensionPopup();
        setBrandMenuOpen(false);
        setPaletteOpen(false);
        setTabMenu(null);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-extension-action]")
      ) {
        return;
      }
      void window.chromecraft.closeExtensionPopup();
    };
    addEventListener("pointerdown", pointer, { capture: true });
    return () => removeEventListener("pointerdown", pointer, { capture: true });
  }, []);
  if (!snapshot || !activeTab || !hyperdrive)
    return (
      <main className="boot">
        <ExpressiveLoadingIndicator label="Starting Chromecraft" />
        <p>Starting Chromecraft</p>
      </main>
    );
  const bookmarked = data.bookmarks.some((item) => item.url === activeTab.url);
  const closeFind = () => {
    setFindOpen(false);
    void window.chromecraft.stopFindInPage(activeTab.id);
  };
  const reviewExtensionInstall = async (itemUrl: string) => {
    try {
      const preview =
        await window.chromecraft.prepareExtensionFromWebStore(itemUrl);
      setDialog({ kind: "install-extension", preview });
    } catch {
      // The main-process snapshot carries the attributable error into the
      // banner, where the user can retry without a second error surface.
    }
  };
  const listing = snapshot.webStoreListing;
  const installedListingExtension = listing
    ? extensions.items.find((extension) => extension.id === listing.extensionId)
    : undefined;
  const preparedListingPreview =
    listing && dialog?.kind === "install-extension"
      ? dialog.preview.extensionId === listing.extensionId
        ? dialog.preview
        : null
      : null;
  const operationMatchesListing = Boolean(
    listing && extensions.operationExtensionId === listing.extensionId,
  );
  let installBannerState: ExtensionInstallBannerState = "available";
  if (listing && operationMatchesListing) {
    installBannerState =
      extensions.operation === "reviewing"
        ? "reviewing"
        : extensions.operation === "removing"
          ? "removing"
          : extensions.operation === "updating"
            ? "updating"
            : "installing";
  } else if (preparedListingPreview) {
    installBannerState = "awaiting-confirmation";
  } else if (
    listing &&
    extensions.error &&
    extensions.errorExtensionId === listing.extensionId
  ) {
    installBannerState = "error";
  } else if (installedListingExtension) {
    installBannerState = installedListingExtension.enabled
      ? "installed"
      : "installed-disabled";
  }
  const closeDialog = (cancelPrepared = false) => {
    if (cancelPrepared && dialog?.kind === "install-extension") {
      void window.chromecraft.cancelPreparedExtension(dialog.preview.token);
    }
    setDialog(null);
  };
  return (
    <div
      className={`app-shell ${!snapshot.preferences.sidebarAttached ? "sidebar-detached" : tool ? "sidebar-panel-open" : "sidebar-rail-only"} ${snapshot.preferences.hyperdriveMonitorOpen ? "hyperdrive-monitor-open" : ""}`}
      style={
        {
          "--base-chrome-height": `${snapshot.baseChromeHeight}px`,
          "--chrome-height": `${snapshot.chromeHeight}px`,
          "--hyperdrive-monitor-width": snapshot.preferences
            .hyperdriveMonitorOpen
            ? "372px"
            : "0px",
        } as CSSProperties
      }
      onClick={() => {
        setBrandMenuOpen(false);
        setTabMenu(null);
      }}
    >
      <header className="browser-chrome">
        <TabStrip
          snapshot={snapshot}
          brandMenuOpen={brandMenuOpen}
          onToggleBrandMenu={() => setBrandMenuOpen((open) => !open)}
          onSetSidebarAttached={(attached) => {
            void window.chromecraft.setSidebarAttached(attached);
            setBrandMenuOpen(false);
          }}
          onMenu={(event, tab) => {
            event.preventDefault();
            event.stopPropagation();
            setTabMenu({ x: 66, y: 116, tab });
          }}
        />
        <Toolbar
          tab={activeTab}
          snapshot={snapshot}
          hyperdrive={hyperdrive}
          data={data}
          bookmarked={bookmarked}
          onFind={() => setFindOpen(true)}
          extensions={extensions}
          onOpenExtensions={() => {
            setTool("extensions");
            void window.chromecraft.setSidebarOpen(true);
            void window.chromecraft.setSidebarAttached(true);
          }}
          onToggleExtensionPopup={(extension, rect) =>
            void window.chromecraft.toggleExtensionPopup(extension.id, {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            })
          }
          onOmniboxExpandedChange={setOmniboxExpanded}
        />
        {snapshot.preferences.bookmarkBarVisible && <BookmarkBar data={data} />}
        {listing && (
          <ExtensionInstallBanner
            metadata={{
              name:
                preparedListingPreview?.name ||
                installedListingExtension?.name ||
                listing.title,
              description:
                preparedListingPreview?.description ||
                installedListingExtension?.description ||
                listing.description,
              version:
                preparedListingPreview?.version ||
                installedListingExtension?.version ||
                null,
              extensionId: listing.extensionId,
              sourceLabel: "Chrome Web Store",
            }}
            state={installBannerState}
            status={
              operationMatchesListing
                ? extensions.progress?.label
                : installBannerState === "error"
                  ? extensions.error
                  : installBannerState === "awaiting-confirmation"
                    ? "Verified package ready for review"
                    : null
            }
            progress={
              operationMatchesListing ? extensions.progress?.percent : null
            }
            primaryAction={
              installBannerState === "available" ||
              installBannerState === "error"
                ? {
                    label:
                      installBannerState === "error"
                        ? "Retry"
                        : "Review & install",
                    onClick: () => void reviewExtensionInstall(listing.itemUrl),
                  }
                : installBannerState === "installed-disabled"
                  ? {
                      label: "Enable",
                      onClick: () =>
                        void window.chromecraft.setExtensionEnabled(
                          listing.extensionId,
                          true,
                        ),
                    }
                  : null
            }
            secondaryAction={
              installBannerState === "error"
                ? {
                    label: "View details",
                    onClick: () => {
                      setTool("extensions");
                      void window.chromecraft.setSidebarOpen(true);
                      void window.chromecraft.setSidebarAttached(true);
                    },
                  }
                : null
            }
            removeAction={
              installedListingExtension &&
              installBannerState !== "removing" &&
              installBannerState !== "updating"
                ? {
                    label: "Remove",
                    onClick: () =>
                      setDialog({
                        kind: "remove-extension",
                        id: installedListingExtension.id,
                        name: installedListingExtension.name,
                      }),
                  }
                : null
            }
            onDismiss={() => {
              if (
                installBannerState === "reviewing" ||
                installBannerState === "awaiting-confirmation"
              ) {
                void window.chromecraft.cancelPreparedExtension(
                  preparedListingPreview?.token ?? "",
                );
                if (preparedListingPreview) setDialog(null);
              }
              void window.chromecraft.dismissWebStoreInstallBanner(
                activeTab.id,
                listing.extensionId,
              );
            }}
          />
        )}
        {findOpen && <FindBar tabId={activeTab.id} onClose={closeFind} />}
      </header>
      <Sidebar
        snapshot={snapshot}
        hyperdrive={hyperdrive}
        data={data}
        downloads={downloads}
        extensions={extensions}
        tool={tool}
        setTool={setTool}
        requestClearHistory={(range) => {
          if (range === "all") {
            setDialog({ kind: "clear-history" });
          } else {
            void window.chromecraft.clearHistory(range);
          }
        }}
        requestExtensionInstall={(itemUrl) =>
          void reviewExtensionInstall(itemUrl)
        }
        requestExtensionRemove={(id, name) =>
          setDialog({ kind: "remove-extension", id, name })
        }
      />
      <NewTabSurface tab={activeTab} snapshot={snapshot} data={data} />
      {snapshot.preferences.hyperdriveMonitorOpen && (
        <HyperdriveMonitor snapshot={hyperdrive} />
      )}
      {paletteOpen && (
        <CommandPalette
          snapshot={snapshot}
          data={data}
          close={() => setPaletteOpen(false)}
        />
      )}
      {tabMenu && (
        <div
          className="tab-menu"
          role="menu"
          aria-label={`Actions for ${tabLabel(tabMenu.tab)}`}
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => void window.chromecraft.reload(tabMenu.tab.id)}
          >
            Reload
          </button>
          <button
            role="menuitem"
            onClick={() => void window.chromecraft.duplicateTab(tabMenu.tab.id)}
          >
            Duplicate
          </button>
          <button
            role="menuitem"
            onClick={() => void window.chromecraft.toggleMute(tabMenu.tab.id)}
          >
            {tabMenu.tab.isMuted ? "Unmute" : "Mute"}
          </button>
          {/^https?:\/\//.test(tabMenu.tab.url) && (
            <>
              <button
                role="menuitem"
                onClick={() =>
                  void window.chromecraft.addQuickLink({
                    title: tabLabel(tabMenu.tab),
                    url: tabMenu.tab.url,
                  })
                }
              >
                Pin to new tab
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setDialog({ kind: "bookmark-folder", tab: tabMenu.tab });
                  setTabMenu(null);
                }}
              >
                Bookmark in folder…
              </button>
            </>
          )}
          <button
            role="menuitem"
            onClick={() =>
              void window.chromecraft.setZoom(
                tabMenu.tab.id,
                Math.min(5, tabMenu.tab.zoomFactor + 0.1),
              )
            }
          >
            Zoom in
          </button>
          <button
            role="menuitem"
            onClick={() =>
              void window.chromecraft.setZoom(
                tabMenu.tab.id,
                Math.max(0.25, tabMenu.tab.zoomFactor - 0.1),
              )
            }
          >
            Zoom out
          </button>
          <button
            role="menuitem"
            onClick={() => void window.chromecraft.setZoom(tabMenu.tab.id, 1)}
          >
            Reset zoom ({Math.round(tabMenu.tab.zoomFactor * 100)}%)
          </button>
          <button
            role="menuitem"
            onClick={() => void window.chromecraft.reopenClosedTab()}
          >
            Reopen closed tab
          </button>
          <button
            role="menuitem"
            className="destructive"
            onClick={() => void window.chromecraft.closeTab(tabMenu.tab.id)}
          >
            Close
          </button>
        </div>
      )}
      {dialog && <MaterialDialog state={dialog} close={closeDialog} />}
    </div>
  );
}
