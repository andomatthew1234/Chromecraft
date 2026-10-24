import {
  memo,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
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
  GalleryEntrySnapshot,
  GallerySnapshot,
  HyperdriveDestinationSnapshot,
  HyperdriveMode,
  HyperdriveOmniboxSignal,
  HyperdrivePreparationState,
  HyperdriveSnapshot,
  NewTabTheme,
  SmartDownloadsSnapshot,
  UblockSnapshot,
  WebsiteControlSnapshot,
  WebsiteControlsSnapshot,
  YouTubeDownloadsSnapshot,
} from "../shared/browser";
import { resolveNavigationInput } from "../shared/navigation";
import {
  selectSidebarTool,
  sidebarMenuActionLabel,
  type SidebarTool,
} from "../shared/sidebar";
import { parseChromeWebStoreListingUrl } from "../shared/web-store-listing";
import type { UpdateSnapshot } from "../shared/updates";
import type { OfflinePagesSnapshot } from "../shared/offline-pages";
import type {
  AiToolsSnapshot,
  OrganiseTabsProposal,
  OrganiseTabsRequest,
} from "../shared/ai-tools";
import {
  ExtensionInstallBanner,
  type ExtensionInstallBannerState,
} from "./ExtensionInstallBanner";
import { ExpressiveLoadingIndicator } from "./ExpressiveLoadingIndicator";
import { YouTubeDownloadBanner } from "./YouTubeDownloadBanner";
import { YouTubeDownloadProgress } from "./YouTubeDownloadProgress";
import { GalleryPage } from "./GalleryPage";
import { OfflinePagesPage } from "./OfflinePagesPage";
import { PageActionsPanel } from "./PageActionsPanel";
import { AiAssistantPanel } from "./AiAssistantPanel";
import { StaticAssistantAvatar } from "./AssistantAvatar";
import { OrganiseTabsPanel } from "./OrganiseTabsPanel";
import { SmartDownloadsPage } from "./SmartDownloadsPage";
import { ScoutSettings } from "./ScoutSettings";
import { WebsitePermissionsDashboard } from "./SiteControlsPanel";
import {
  deriveDownloadIndicator,
  didAnyDownloadComplete,
} from "./download-indicator";
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
import {
  clampFloatingPosition,
  extensionActionSelected,
  isHyperdriveEnabled,
  tabHoverCardContent,
} from "./toolbar-model";

const emptyData: BrowserDataSnapshot = {
  bookmarks: [],
  history: [],
  recentlyClosed: [],
  quickLinks: [],
  savedTabGroups: [],
  recentlyClosedWindows: [],
};
const emptyDownloads: DownloadSnapshot = { items: [] };
const emptyWebsiteControls: WebsiteControlsSnapshot = {
  secureDns: { mode: "automatic", providerUrl: null },
  sites: [],
  limitations: {
    autoplay: "Autoplay controls apply on the next document load.",
    javascript: "JavaScript controls apply after reloading the website.",
  },
};
const emptyYouTubeDownloads: YouTubeDownloadsSnapshot = {
  available: false,
  ytDlpVersion: "",
  items: [],
};
const emptyGallery: GallerySnapshot = { items: [] };
const emptyOfflinePages: OfflinePagesSnapshot = {
  items: [],
  save: {
    stage: "idle",
    tabId: null,
    title: null,
    sourceUrl: null,
    entryId: null,
    error: null,
  },
};
const emptySmartDownloads: SmartDownloadsSnapshot = {
  config: {
    enabled: false,
    storageQuotaBytes: 10 * 1024 ** 3,
    quality: "720p",
    cleanupPolicy: "pause",
    checkIntervalMinutes: 60,
    includeShorts: false,
    includeLivestreamReplays: false,
    pauseDuringHeavyActivity: true,
    backgroundEnabled: false,
    startWithWindows: false,
    recommendationsEnabled: false,
  },
  storage: {
    quotaBytes: 10 * 1024 ** 3,
    usedBytes: 0,
    availableBytes: 10 * 1024 ** 3,
    reservedBytes: 0,
    diskAvailableBytes: null,
    maximumQuotaBytes: 10 * 1024 ** 3,
    managedDownloadCount: 0,
  },
  channels: [],
  queue: [],
  recommendations: [],
  cleanupPreview: [],
  queuePaused: false,
  checking: false,
  lastCheckAt: null,
  nextCheckAt: null,
  backgroundRunning: false,
  error: null,
  status: {
    configured: false,
    state: "not-configured",
    paused: false,
    enabledChannelCount: 0,
    error: null,
  },
  check: {
    state: "idle",
    trigger: null,
    reason: null,
    channelId: null,
    totalChannels: 0,
    checkedChannels: 0,
    newVideosFound: 0,
    queuedVideos: 0,
    failures: 0,
    startedAt: null,
    completedAt: null,
    error: null,
  },
};
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
const emptyAiTools: AiToolsSnapshot = {
  provider: "ollama",
  organiserProvider: "ollama",
  organiserModels: { ollama: null, gemini: null },
  preferredGroupingMode: "smart",
  eligibleTabCount: 0,
  cloudDataPreview: [],
  ollama: {
    endpoint: "http://127.0.0.1:11434",
    connection: "unknown",
    models: [],
    selectedModel: null,
    error: null,
  },
  gemini: {
    connection: "unknown",
    models: [],
    selectedModel: null,
    error: null,
    apiKeyConfigured: false,
    secureStorageAvailable: false,
    sessionOnly: false,
    cloudConsentGranted: false,
  },
  endpoint: "http://127.0.0.1:11434",
  connection: "unknown",
  models: [],
  selectedModel: null,
  error: null,
  run: {
    operationId: null,
    toolId: null,
    stage: "idle",
    label: "Ready",
    error: null,
    proposalId: null,
    undoAvailable: false,
  },
};

type IconName =
  | "add"
  | "autoAwesome"
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
  | "info"
  | "lock"
  | "memory"
  | "folder"
  | "group"
  | "more"
  | "open"
  | "pause"
  | "pin"
  | "play"
  | "reload"
  | "search"
  | "settings"
  | "shield"
  | "stop"
  | "tabSearch"
  | "tune"
  | "warning"
  | "volumeUp"
  | "volumeOff"
  | "videoLibrary"
  | "visibility"
  | "visibilityOff";

const iconSymbols: Record<IconName, string> = {
  add: "add",
  autoAwesome: "auto_awesome",
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
  info: "info",
  lock: "lock",
  memory: "memory",
  folder: "folder",
  group: "tab_group",
  more: "more_vert",
  open: "open_in_new",
  pause: "pause",
  pin: "push_pin",
  play: "play_arrow",
  reload: "refresh",
  search: "search",
  settings: "settings",
  shield: "shield",
  stop: "stop",
  tabSearch: "tab_search",
  tune: "tune",
  warning: "warning",
  volumeUp: "volume_up",
  volumeOff: "volume_off",
  videoLibrary: "video_library",
  visibility: "visibility",
  visibilityOff: "visibility_off",
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

type TabGroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

interface TabGroupSnapshotLike {
  id: string;
  name: string;
  color: TabGroupColor;
  collapsed: boolean;
  saved: boolean;
  createdAt: number;
}

type OrganisedTabSnapshot = BrowserTabSnapshot & {
  groupId?: string | null;
  isSelected?: boolean;
  isAudible?: boolean;
  memoryBytes?: number | null;
  thumbnailDataUrl?: string | null;
  pinned?: boolean;
};

type OrganisedBrowserSnapshot = BrowserSnapshot & {
  tabGroups?: TabGroupSnapshotLike[];
  selectedTabIds?: string[];
};

interface TabOrganizationApi {
  createTabGroup?: (
    tabIds: string[],
    name?: string,
    color?: TabGroupColor,
  ) => Promise<string>;
  updateTabGroup?: (
    groupId: string,
    patch: Partial<
      Pick<TabGroupSnapshotLike, "name" | "color" | "collapsed" | "saved">
    >,
  ) => Promise<void>;
  deleteTabGroup?: (groupId: string, closeTabs?: boolean) => Promise<void>;
  selectTabs?: (
    tabIds: string[],
    mode: "replace" | "add" | "toggle" | "range",
  ) => Promise<void>;
  moveTabs?: (
    tabIds: string[],
    targetIndex: number,
    groupId?: string | null,
  ) => Promise<void>;
  closeTabs?: (tabIds: string[]) => Promise<void>;
  setTabsPinned?: (tabIds: string[], pinned: boolean) => Promise<void>;
  reopenClosedTab: (id?: string) => Promise<string | null>;
  reopenClosedWindow?: (id?: string) => Promise<string[]>;
  restoreSavedTabGroup?: (id: string) => Promise<string[]>;
  removeSavedTabGroup?: (id: string) => Promise<void>;
}

interface RecentlyClosedWindowLike {
  id: string;
  title?: string;
  closedAt: number;
  tabs: Array<{ id: string; title: string; url: string }>;
}

function tabOrganizationApi(): TabOrganizationApi {
  return window.chromecraft as unknown as TabOrganizationApi;
}

export function getTabGroups(
  snapshot: BrowserSnapshot,
): TabGroupSnapshotLike[] {
  const groups = (snapshot as OrganisedBrowserSnapshot).tabGroups;
  return Array.isArray(groups) ? groups : [];
}

export function getSelectedTabIds(snapshot: BrowserSnapshot): string[] {
  const enhanced = snapshot as OrganisedBrowserSnapshot;
  if (Array.isArray(enhanced.selectedTabIds)) return enhanced.selectedTabIds;
  return snapshot.tabs
    .filter((tab) => (tab as OrganisedTabSnapshot).isSelected)
    .map((tab) => tab.id);
}

function getRecentlyClosedWindows(
  data: BrowserDataSnapshot,
): RecentlyClosedWindowLike[] {
  const windows = (
    data as BrowserDataSnapshot & {
      recentlyClosedWindows?: RecentlyClosedWindowLike[];
    }
  ).recentlyClosedWindows;
  return Array.isArray(windows) ? windows : [];
}

function formatTabMemory(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatRelativeTime(timestamp: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.round(hours / 24), "day");
}

const TAB_GROUP_COLORS: TabGroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

const TAB_DRAG_MIME = "application/x-chromecraft-tab-ids";

function tabDragIds(tabId: string, selectedIds: string[]): string[] {
  return selectedIds.includes(tabId) ? selectedIds : [tabId];
}

function writeTabDragPayload(dataTransfer: DataTransfer, tabIds: string[]) {
  const payload = JSON.stringify(tabIds);
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData(TAB_DRAG_MIME, payload);
  // The fallback keeps same-window drops working on platforms that strip
  // custom MIME types from native drag payloads.
  dataTransfer.setData("text/plain", `chromecraft-tabs:${payload}`);
}

function readTabDragPayload(dataTransfer: DataTransfer): string[] {
  const custom = dataTransfer.getData(TAB_DRAG_MIME);
  const fallback = dataTransfer.getData("text/plain");
  const serialized = custom || fallback.replace(/^chromecraft-tabs:/, "");
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export async function performTabGroupDrop({
  draggedTabIds,
  groupId,
  tabs,
  moveTabs,
}: {
  draggedTabIds: string[];
  groupId: string;
  tabs: BrowserTabSnapshot[];
  moveTabs: (
    tabIds: string[],
    targetIndex: number,
    groupId: string,
  ) => Promise<void>;
}): Promise<boolean> {
  const knownTabs = new Map(tabs.map((tab) => [tab.id, tab]));
  const moving = [...new Set(draggedTabIds)].filter((id) => {
    const tab = knownTabs.get(id) as OrganisedTabSnapshot | undefined;
    return tab && tab.groupId !== groupId;
  });
  if (moving.length === 0) return false;

  const movingIds = new Set(moving);
  const remaining = tabs.filter((tab) => !movingIds.has(tab.id));
  let targetIndex = remaining.length;
  for (let index = remaining.length - 1; index >= 0; index -= 1) {
    if ((remaining[index] as OrganisedTabSnapshot).groupId === groupId) {
      targetIndex = index + 1;
      break;
    }
  }
  await moveTabs(moving, targetIndex, groupId);
  return true;
}

const TabButton = memo(function TabButton({
  active,
  selected,
  tab,
  settings,
  dragging,
  onMenu,
  onDragStart,
  onDragEnd,
  onHoverChange,
}: {
  active: boolean;
  selected: boolean;
  tab: BrowserTabSnapshot;
  settings: boolean;
  dragging: boolean;
  onMenu: (event: MouseEvent, tab: BrowserTabSnapshot) => void;
  onDragStart: (
    event: ReactDragEvent<HTMLDivElement>,
    tab: BrowserTabSnapshot,
  ) => void;
  onDragEnd: () => void;
  onHoverChange: (tab: BrowserTabSnapshot | null, anchor?: DOMRect) => void;
}) {
  const label = settings ? "Settings" : tabLabel(tab);
  const activate = (event: MouseEvent<HTMLButtonElement>) => {
    const api = tabOrganizationApi();
    if ((event.ctrlKey || event.metaKey) && api.selectTabs) {
      void api.selectTabs([tab.id], "toggle");
      return;
    }
    if (event.shiftKey && api.selectTabs) {
      void api.selectTabs([tab.id], "range");
      return;
    }
    if (api.selectTabs) void api.selectTabs([tab.id], "replace");
    void window.chromecraft.activateTab(tab.id);
  };
  return (
    <div
      className={`tab ${active ? "active" : ""} ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${(tab as OrganisedTabSnapshot).pinned ? "pinned" : ""}`}
      data-tab-id={tab.id}
      draggable
      onDragStart={(event) => onDragStart(event, tab)}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => onMenu(event, tab)}
      onPointerEnter={(event) =>
        onHoverChange(tab, event.currentTarget.getBoundingClientRect())
      }
      onPointerLeave={() => onHoverChange(null)}
      role="presentation"
    >
      <button
        type="button"
        className="tab-target"
        role="tab"
        aria-selected={active}
        aria-label={`${label}${selected ? ", selected for tab actions" : ""}`}
        onClick={activate}
        tabIndex={active || selected ? 0 : -1}
        aria-busy={tab.isLoading}
      >
        {tab.isLoading ? (
          <ExpressiveLoadingIndicator compact />
        ) : settings ? (
          <span className="tab-favicon settings-favicon" aria-hidden="true">
            <Icon name="settings" />
          </span>
        ) : (
          <span
            className={`tab-favicon ${tab.isNewTab ? "brand-favicon" : ""}`}
            aria-hidden="true"
          >
            {tab.isNewTab ? "C" : hostLabel(tab.url).slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="tab-title">{label}</span>
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
        aria-label={`Close ${label}`}
      >
        <Icon name="close" />
      </button>
    </div>
  );
});

function TabGroupPill({
  group,
  tabCount,
  active,
  onMenu,
}: {
  group: TabGroupSnapshotLike;
  tabCount: number;
  active: boolean;
  onMenu: (group: TabGroupSnapshotLike, anchor: DOMRect) => void;
}) {
  return (
    <div
      className={`tab-group-pill group-${group.color} ${active ? "active" : ""}`}
      data-group-id={group.id}
    >
      <button
        type="button"
        className="tab-group-toggle"
        aria-expanded={!group.collapsed}
        aria-label={`${group.collapsed ? "Expand" : "Collapse"} ${group.name} group, ${tabCount} tabs`}
        onClick={(event) => {
          event.stopPropagation();
          void tabOrganizationApi().updateTabGroup?.(group.id, {
            collapsed: !group.collapsed,
          });
        }}
      >
        <span className="tab-group-dot" aria-hidden="true" />
        <span>{group.name || "Tab group"}</span>
        {group.collapsed && <small>{tabCount}</small>}
      </button>
      <button
        type="button"
        className="tab-group-more"
        aria-label={`Edit ${group.name || "tab group"}`}
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          onMenu(group, event.currentTarget.getBoundingClientRect());
        }}
      >
        <Icon name="more" />
      </button>
    </div>
  );
}

function TabGroupMenu({
  group,
  position,
  close,
}: {
  group: TabGroupSnapshotLike;
  position: { x: number; y: number };
  close: () => void;
}) {
  const [name, setName] = useState(group.name);
  const saveName = () => {
    const nextName = name.trim() || "Tab group";
    if (nextName !== group.name) {
      void tabOrganizationApi().updateTabGroup?.(group.id, { name: nextName });
    }
  };
  return (
    <section
      className="tab-group-menu"
      role="menu"
      aria-label={`Edit ${group.name || "tab group"}`}
      style={{ left: position.x, top: position.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <label className="tab-group-name-field">
        <span>Group name</span>
        <input
          autoFocus
          value={name}
          maxLength={48}
          onChange={(event) => setName(event.target.value)}
          onBlur={saveName}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              saveName();
              close();
            }
            if (event.key === "Escape") close();
          }}
        />
      </label>
      <div className="tab-group-colors" aria-label="Group colour">
        {TAB_GROUP_COLORS.map((color) => (
          <button
            type="button"
            className={`tab-group-color group-${color} ${group.color === color ? "selected" : ""}`}
            key={color}
            aria-label={`${color} group colour`}
            aria-pressed={group.color === color}
            onClick={() =>
              void tabOrganizationApi().updateTabGroup?.(group.id, { color })
            }
          >
            {group.color === color && <span aria-hidden="true">✓</span>}
          </button>
        ))}
      </div>
      <div className="tab-group-menu-divider" />
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={group.saved}
        onClick={() =>
          void tabOrganizationApi().updateTabGroup?.(group.id, {
            saved: !group.saved,
          })
        }
      >
        <Icon name="bookmark" />
        {group.saved ? "Remove from saved groups" : "Save group"}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          void tabOrganizationApi().deleteTabGroup?.(group.id, false);
          close();
        }}
      >
        <Icon name="group" />
        Ungroup tabs
      </button>
      <button
        type="button"
        role="menuitem"
        className="destructive"
        onClick={() => {
          void tabOrganizationApi().deleteTabGroup?.(group.id, true);
          close();
        }}
      >
        <Icon name="close" />
        Close group
      </button>
    </section>
  );
}

function TabSelectionBar({
  snapshot,
  selectedIds,
}: {
  snapshot: BrowserSnapshot;
  selectedIds: string[];
}) {
  const selectedTabs = snapshot.tabs.filter((tab) =>
    selectedIds.includes(tab.id),
  );
  const allPinned = selectedTabs.every(
    (tab) => (tab as OrganisedTabSnapshot).pinned,
  );
  const move = (delta: number) => {
    const api = tabOrganizationApi();
    if (!api.moveTabs || selectedTabs.length === 0) return;
    const indexes = selectedTabs.map((tab) =>
      snapshot.tabs.findIndex((item) => item.id === tab.id),
    );
    const edge = delta < 0 ? Math.min(...indexes) : Math.max(...indexes);
    const target = Math.max(
      0,
      Math.min(snapshot.tabs.length - selectedTabs.length, edge + delta),
    );
    void api.moveTabs(selectedIds, target);
  };
  const closeTabs = () => {
    const api = tabOrganizationApi();
    if (api.closeTabs) void api.closeTabs(selectedIds);
    else selectedIds.forEach((id) => void window.chromecraft.closeTab(id));
  };
  return (
    <div
      className="tab-selection-bar"
      role="toolbar"
      aria-label="Selected tabs"
    >
      <strong>{selectedIds.length} selected</strong>
      <button
        type="button"
        onClick={() =>
          void tabOrganizationApi().createTabGroup?.(
            selectedIds,
            `Group ${getTabGroups(snapshot).length + 1}`,
            "blue",
          )
        }
      >
        <Icon name="group" />
        <span>Group</span>
      </button>
      <button
        type="button"
        onClick={() =>
          void tabOrganizationApi().setTabsPinned?.(selectedIds, !allPinned)
        }
        aria-label={`${allPinned ? "Unpin" : "Pin"} selected tabs`}
      >
        <Icon name="pin" />
        <span>{allPinned ? "Unpin" : "Pin"}</span>
      </button>
      <button
        type="button"
        onClick={() => move(-1)}
        aria-label="Move selected tabs left"
      >
        <Icon name="chevronLeft" />
      </button>
      <button
        type="button"
        onClick={() => move(1)}
        aria-label="Move selected tabs right"
      >
        <Icon name="chevronRight" />
      </button>
      <button
        type="button"
        onClick={closeTabs}
        aria-label="Close selected tabs"
      >
        <Icon name="close" />
      </button>
      <button
        type="button"
        onClick={() => void tabOrganizationApi().selectTabs?.([], "replace")}
        aria-label="Clear tab selection"
      >
        Done
      </button>
    </div>
  );
}

export function TabOverview({
  snapshot,
  data,
  close,
}: {
  snapshot: BrowserSnapshot;
  data: BrowserDataSnapshot;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLocaleLowerCase();
  const groups = getTabGroups(snapshot);
  const openTabs = snapshot.tabs.filter((tab) =>
    `${tabLabel(tab)} ${tab.url}`.toLocaleLowerCase().includes(needle),
  );
  const closedTabs = data.recentlyClosed
    .filter((tab) =>
      `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(needle),
    )
    .slice(0, needle ? 30 : 8);
  const closedWindows = getRecentlyClosedWindows(data).filter((item) =>
    `${item.title ?? ""} ${item.tabs.map((tab) => `${tab.title} ${tab.url}`).join(" ")}`
      .toLocaleLowerCase()
      .includes(needle),
  );
  const savedGroups = data.savedTabGroups.filter((group) =>
    `${group.name} ${group.tabs.map((tab) => `${tab.title} ${tab.url}`).join(" ")}`
      .toLocaleLowerCase()
      .includes(needle),
  );
  const resultCount =
    openTabs.length +
    closedTabs.length +
    closedWindows.length +
    savedGroups.length;
  useEffect(() => {
    resultsRef.current
      ?.querySelector(`[data-overview-index="${focusedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex]);
  const runAtIndex = (index: number) => {
    const actions: Array<() => void> = [
      ...openTabs.map((tab) => () => {
        void window.chromecraft.activateTab(tab.id);
        close();
      }),
      ...savedGroups.map((group) => () => {
        const openGroup = groups.find((item) => item.id === group.id);
        if (openGroup) {
          void tabOrganizationApi().updateTabGroup?.(group.id, {
            collapsed: false,
          });
          const tab = snapshot.tabs.find(
            (item) => (item as OrganisedTabSnapshot).groupId === group.id,
          );
          if (tab) void window.chromecraft.activateTab(tab.id);
        } else {
          void tabOrganizationApi().restoreSavedTabGroup?.(group.id);
        }
        close();
      }),
      ...closedTabs.map((tab) => () => {
        void tabOrganizationApi().reopenClosedTab(tab.id);
        close();
      }),
      ...closedWindows.map((item) => () => {
        void tabOrganizationApi().reopenClosedWindow?.(item.id);
        close();
      }),
    ];
    actions[index]?.();
  };
  let rowIndex = -1;
  const nextRowIndex = () => ++rowIndex;
  return (
    <section
      className="tab-overview"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tab-overview-title"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <header className="tab-overview-header">
        <div>
          <span className="tab-overview-icon">
            <Icon name="tabSearch" />
          </span>
          <span>
            <strong id="tab-overview-title">Tabs</strong>
            <small>Find, restore and organise</small>
          </span>
        </div>
        <button type="button" onClick={close} aria-label="Close tab search">
          <Icon name="close" />
        </button>
      </header>
      <label className="tab-overview-search">
        <Icon name="search" />
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setFocusedIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setFocusedIndex((value) => Math.min(resultCount - 1, value + 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setFocusedIndex((value) => Math.max(0, value - 1));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              runAtIndex(focusedIndex);
            }
          }}
          placeholder="Search open and recently closed tabs"
          aria-label="Search tabs"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="tab-overview-results"
          aria-activedescendant={
            resultCount > 0 ? `tab-overview-result-${focusedIndex}` : undefined
          }
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear tab search"
          >
            <Icon name="close" />
          </button>
        )}
      </label>
      <div
        id="tab-overview-results"
        ref={resultsRef}
        className="tab-overview-results"
        role="listbox"
        aria-label="Tab search results"
      >
        {openTabs.length > 0 && (
          <section className="tab-overview-section">
            <h3>
              Open tabs <span>{openTabs.length}</span>
            </h3>
            {openTabs.map((tab) => {
              const enhanced = tab as OrganisedTabSnapshot;
              const group = groups.find((item) => item.id === enhanced.groupId);
              const index = nextRowIndex();
              return (
                <button
                  type="button"
                  role="option"
                  id={`tab-overview-result-${index}`}
                  data-overview-index={index}
                  aria-selected={focusedIndex === index}
                  className={focusedIndex === index ? "keyboard-focused" : ""}
                  key={tab.id}
                  onMouseEnter={() => setFocusedIndex(index)}
                  onClick={() => runAtIndex(index)}
                >
                  <span className="tab-overview-favicon">
                    {hostLabel(tab.url).slice(0, 1).toUpperCase() || "C"}
                  </span>
                  <span className="tab-overview-copy">
                    <strong>{tabLabel(tab)}</strong>
                    <small>
                      {group ? `${group.name} · ` : ""}
                      {hostLabel(tab.url)}
                    </small>
                  </span>
                  {enhanced.isAudible && (
                    <span className="tab-overview-status">
                      <Icon name="volumeUp" />
                    </span>
                  )}
                  {formatTabMemory(enhanced.memoryBytes) && (
                    <span className="tab-overview-memory">
                      {formatTabMemory(enhanced.memoryBytes)}
                    </span>
                  )}
                </button>
              );
            })}
          </section>
        )}
        {savedGroups.length > 0 && (
          <section className="tab-overview-section saved-groups-section">
            <h3>
              Saved groups <span>{savedGroups.length}</span>
            </h3>
            {savedGroups.map((group) => {
              const index = nextRowIndex();
              const count = group.tabs.length;
              return (
                <button
                  type="button"
                  role="option"
                  id={`tab-overview-result-${index}`}
                  data-overview-index={index}
                  aria-selected={focusedIndex === index}
                  className={focusedIndex === index ? "keyboard-focused" : ""}
                  key={group.id}
                  onMouseEnter={() => setFocusedIndex(index)}
                  onClick={() => runAtIndex(index)}
                >
                  <span
                    className={`tab-overview-group-icon group-${group.color}`}
                  >
                    <Icon name="group" />
                  </span>
                  <span className="tab-overview-copy">
                    <strong>{group.name}</strong>
                    <small>
                      {count} open {count === 1 ? "tab" : "tabs"}
                    </small>
                  </span>
                  <Icon name="chevronRight" />
                </button>
              );
            })}
          </section>
        )}
        {closedTabs.length > 0 && (
          <section className="tab-overview-section">
            <h3>
              Recently closed <span>{closedTabs.length}</span>
            </h3>
            {closedTabs.map((tab) => {
              const index = nextRowIndex();
              return (
                <button
                  type="button"
                  role="option"
                  id={`tab-overview-result-${index}`}
                  data-overview-index={index}
                  aria-selected={focusedIndex === index}
                  className={focusedIndex === index ? "keyboard-focused" : ""}
                  key={tab.id}
                  onMouseEnter={() => setFocusedIndex(index)}
                  onClick={() => runAtIndex(index)}
                >
                  <span className="tab-overview-favicon muted">
                    {hostLabel(tab.url).slice(0, 1).toUpperCase() || "C"}
                  </span>
                  <span className="tab-overview-copy">
                    <strong>{tab.title || hostLabel(tab.url)}</strong>
                    <small>
                      {tab.groupName ? `${tab.groupName} · ` : ""}
                      {hostLabel(tab.url)}
                    </small>
                  </span>
                  <span className="tab-overview-time">
                    {formatRelativeTime(tab.closedAt)}
                  </span>
                </button>
              );
            })}
          </section>
        )}
        {closedWindows.length > 0 && (
          <section className="tab-overview-section">
            <h3>
              Closed windows <span>{closedWindows.length}</span>
            </h3>
            {closedWindows.map((item) => {
              const index = nextRowIndex();
              return (
                <button
                  type="button"
                  role="option"
                  id={`tab-overview-result-${index}`}
                  data-overview-index={index}
                  aria-selected={focusedIndex === index}
                  className={focusedIndex === index ? "keyboard-focused" : ""}
                  key={item.id}
                  onMouseEnter={() => setFocusedIndex(index)}
                  onClick={() => runAtIndex(index)}
                >
                  <span className="tab-overview-group-icon">
                    <Icon name="open" />
                  </span>
                  <span className="tab-overview-copy">
                    <strong>{item.title || "Closed window"}</strong>
                    <small>
                      {item.tabs.length}{" "}
                      {item.tabs.length === 1 ? "tab" : "tabs"}
                    </small>
                  </span>
                  <span className="tab-overview-restore">Restore</span>
                </button>
              );
            })}
          </section>
        )}
        {resultCount === 0 && (
          <div className="tab-overview-empty">
            <span>
              <Icon name="search" />
            </span>
            <strong>No matching tabs</strong>
            <small>Try another title or website address.</small>
          </div>
        )}
      </div>
      <footer className="tab-overview-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move
        </span>
        <span>
          <kbd>Enter</kbd> to open
        </span>
        <span>
          <kbd>Esc</kbd> to close
        </span>
      </footer>
    </section>
  );
}

export function TabStrip({
  snapshot,
  data,
  settingsTabId,
  onMenu,
  brandMenuOpen,
  onToggleBrandMenu,
  onSetSidebarAttached,
  onOpenUpdates,
  aiTools,
  onOpenOrganiseTabs,
  onHoverCardOpenChange,
}: {
  snapshot: BrowserSnapshot;
  data: BrowserDataSnapshot;
  settingsTabId: string | null;
  onMenu: (event: MouseEvent, tab: BrowserTabSnapshot) => void;
  brandMenuOpen: boolean;
  onToggleBrandMenu: () => void;
  onSetSidebarAttached: (attached: boolean) => void;
  onOpenUpdates: () => void;
  aiTools: AiToolsSnapshot;
  onOpenOrganiseTabs: () => void;
  onHoverCardOpenChange: (open: boolean) => void;
}) {
  const sidebarAttached = snapshot.preferences.sidebarAttached;
  const sidebarAction = sidebarMenuActionLabel(sidebarAttached);
  const groups = getTabGroups(snapshot);
  const selectedIds = getSelectedTabIds(snapshot);
  const [hoverPreview, setHoverPreview] = useState<{
    tab: BrowserTabSnapshot;
    x: number;
    y: number;
  } | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [groupMenu, setGroupMenu] = useState<{
    group: TabGroupSnapshotLike;
    position: { x: number; y: number };
  } | null>(null);
  const [draggedTabIds, setDraggedTabIds] = useState<string[]>([]);
  const draggedTabIdsRef = useRef<string[]>([]);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateHoverPreview = (
    tab: BrowserTabSnapshot | null,
    anchor?: DOMRect,
  ) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (!tab || !anchor) {
      setHoverPreview(null);
      return;
    }
    hoverTimer.current = setTimeout(() => {
      const width = 280;
      setHoverPreview({
        tab,
        x: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        y: anchor.bottom + 8,
      });
    }, 320);
  };
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );
  useEffect(() => {
    onHoverCardOpenChange(
      Boolean(hoverPreview || overviewOpen || groupMenu || selectedIds.length),
    );
  }, [
    groupMenu,
    hoverPreview,
    onHoverCardOpenChange,
    overviewOpen,
    selectedIds.length,
  ]);
  useEffect(() => {
    if (!overviewOpen && !groupMenu) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          ".tab-overview, .tab-search-button, .tab-group-menu, .tab-group-pill",
        )
      ) {
        return;
      }
      setOverviewOpen(false);
      setGroupMenu(null);
    };
    addEventListener("pointerdown", dismiss, { capture: true });
    return () => removeEventListener("pointerdown", dismiss, { capture: true });
  }, [groupMenu, overviewOpen]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "a"
      ) {
        event.preventDefault();
        setOverviewOpen((open) => !open);
      }
    };
    addEventListener("keydown", shortcut);
    return () => removeEventListener("keydown", shortcut);
  }, []);
  const renderedGroups = new Set<string>();
  const tabNodes: ReactNode[] = [];
  const visibleGroupMenu = groupMenu
    ? {
        ...groupMenu,
        group:
          groups.find((group) => group.id === groupMenu.group.id) ??
          groupMenu.group,
      }
    : null;
  const startTabDrag = (
    event: ReactDragEvent<HTMLDivElement>,
    tab: BrowserTabSnapshot,
  ) => {
    const ids = tabDragIds(tab.id, selectedIds);
    draggedTabIdsRef.current = ids;
    setDraggedTabIds(ids);
    setHoverPreview(null);
    writeTabDragPayload(event.dataTransfer, ids);
  };
  const finishTabDrag = () => {
    draggedTabIdsRef.current = [];
    setDraggedTabIds([]);
    setDragOverGroupId(null);
  };
  for (const tab of snapshot.tabs) {
    const organisedTab = tab as OrganisedTabSnapshot;
    const group = groups.find((item) => item.id === organisedTab.groupId);
    if (!group) {
      tabNodes.push(
        <TabButton
          active={tab.id === snapshot.activeTabId}
          selected={selectedIds.includes(tab.id)}
          key={tab.id}
          tab={tab}
          settings={tab.id === settingsTabId}
          dragging={draggedTabIds.includes(tab.id)}
          onMenu={onMenu}
          onDragStart={startTabDrag}
          onDragEnd={finishTabDrag}
          onHoverChange={updateHoverPreview}
        />,
      );
      continue;
    }
    if (renderedGroups.has(group.id)) continue;
    renderedGroups.add(group.id);
    const groupTabs = snapshot.tabs.filter(
      (item) => (item as OrganisedTabSnapshot).groupId === group.id,
    );
    tabNodes.push(
      <div
        className={`tab-group group-${group.color} ${group.collapsed ? "collapsed" : ""} ${dragOverGroupId === group.id ? "drop-target" : ""}`}
        role="group"
        aria-label={`${group.name}, ${groupTabs.length} tabs`}
        data-drop-label={`Drop tabs into ${group.name || "Tab group"}`}
        key={`group-${group.id}`}
        onDragEnter={(event) => {
          if (draggedTabIdsRef.current.length === 0) return;
          event.preventDefault();
          setDragOverGroupId(group.id);
        }}
        onDragOver={(event) => {
          if (draggedTabIdsRef.current.length === 0) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          if (dragOverGroupId !== group.id) setDragOverGroupId(group.id);
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (
            nextTarget instanceof Node &&
            event.currentTarget.contains(nextTarget)
          ) {
            return;
          }
          if (dragOverGroupId === group.id) setDragOverGroupId(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const ids =
            draggedTabIdsRef.current.length > 0
              ? draggedTabIdsRef.current
              : readTabDragPayload(event.dataTransfer);
          finishTabDrag();
          const moveTabs = tabOrganizationApi().moveTabs;
          if (!moveTabs || ids.length === 0) return;
          void performTabGroupDrop({
            draggedTabIds: ids,
            groupId: group.id,
            tabs: snapshot.tabs,
            moveTabs,
          });
        }}
      >
        <TabGroupPill
          group={group}
          tabCount={groupTabs.length}
          active={groupTabs.some((item) => item.id === snapshot.activeTabId)}
          onMenu={(nextGroup, anchor) => {
            setOverviewOpen(false);
            setGroupMenu({
              group: nextGroup,
              position: {
                x: Math.max(8, Math.min(anchor.left, innerWidth - 304)),
                y: anchor.bottom + 6,
              },
            });
          }}
        />
        {!group.collapsed &&
          groupTabs.map((item) => (
            <TabButton
              active={item.id === snapshot.activeTabId}
              selected={selectedIds.includes(item.id)}
              key={item.id}
              tab={item}
              settings={item.id === settingsTabId}
              dragging={draggedTabIds.includes(item.id)}
              onMenu={onMenu}
              onDragStart={startTabDrag}
              onDragEnd={finishTabDrag}
              onHoverChange={updateHoverPreview}
            />
          ))}
      </div>,
    );
  }
  return (
    <div
      className="tab-strip"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        const target = event.target;
        if (!(target instanceof Element) || !target.closest(".tab-target"))
          return;
        const tabs = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ".tab-target",
          ),
        );
        const current = tabs.indexOf(
          target.closest(".tab-target") as HTMLButtonElement,
        );
        if (current < 0) return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : (current +
                  (event.key === "ArrowRight" ? 1 : -1) +
                  tabs.length) %
                tabs.length;
        tabs[next]?.focus();
      }}
    >
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
            <button
              type="button"
              className="brand-menu-item"
              role="menuitem"
              onClick={onOpenUpdates}
            >
              <span className="brand-menu-item-icon" aria-hidden="true">
                <Icon name="reload" />
              </span>
              <span className="brand-menu-item-copy">
                <strong>Updates and versions</strong>
                <small>Update ChromeCraft, Electron, and dependencies</small>
              </span>
              <Icon name="chevronRight" />
            </button>
            <div className="brand-menu-section-label">AI tools</div>
            <button
              type="button"
              className="brand-menu-item"
              role="menuitem"
              onClick={onOpenOrganiseTabs}
            >
              <span
                className="brand-menu-item-icon brand-menu-ai-icon"
                aria-hidden="true"
              >
                <Icon name="autoAwesome" />
              </span>
              <span className="brand-menu-item-copy">
                <strong>Organise tabs</strong>
                <small>
                  {["checking", "thinking", "applying"].includes(
                    aiTools.run.stage,
                  )
                    ? aiTools.run.label
                    : "Sort open tabs into useful groups with Ollama"}
                </small>
              </span>
              <Icon name="chevronRight" />
            </button>
          </section>
        )}
      </div>
      <div className="tab-scroller" role="tablist" aria-label="Open tabs">
        {tabNodes}
        <button
          type="button"
          className="new-tab-button"
          onClick={() => void window.chromecraft.createTab()}
          aria-label="New tab"
          title="New tab (Ctrl+T)"
        >
          <Icon name="add" />
        </button>
      </div>
      <button
        type="button"
        className={`tab-search-button ${overviewOpen ? "selected" : ""}`}
        aria-label="Search tabs"
        aria-haspopup="dialog"
        aria-expanded={overviewOpen}
        title="Search tabs (Ctrl+Shift+A)"
        onClick={(event) => {
          event.stopPropagation();
          setGroupMenu(null);
          setOverviewOpen((open) => !open);
        }}
      >
        <Icon name="tabSearch" />
      </button>
      {selectedIds.length > 0 && (
        <TabSelectionBar snapshot={snapshot} selectedIds={selectedIds} />
      )}
      <span className="window-drag-region" aria-hidden="true" />
      {hoverPreview && (
        <aside
          className="tab-hover-card"
          role="tooltip"
          style={{ left: hoverPreview.x, top: hoverPreview.y }}
        >
          {(hoverPreview.tab as OrganisedTabSnapshot).thumbnailDataUrl ? (
            <img
              className="tab-hover-card-thumbnail"
              src={
                (hoverPreview.tab as OrganisedTabSnapshot).thumbnailDataUrl ??
                ""
              }
              alt=""
            />
          ) : (
            <span className="tab-hover-card-preview" aria-hidden="true">
              {hostLabel(hoverPreview.tab.url).slice(0, 1).toUpperCase() || "C"}
            </span>
          )}
          <span className="tab-hover-card-copy">
            <strong>{tabHoverCardContent(hoverPreview.tab).title}</strong>
            <small>{tabHoverCardContent(hoverPreview.tab).host}</small>
            <span className="tab-hover-card-meta">
              {(hoverPreview.tab as OrganisedTabSnapshot).isAudible && (
                <span>
                  <Icon name="volumeUp" /> Playing audio
                </span>
              )}
              {(hoverPreview.tab as OrganisedTabSnapshot).isMuted && (
                <span>
                  <Icon name="volumeOff" /> Muted
                </span>
              )}
              {formatTabMemory(
                (hoverPreview.tab as OrganisedTabSnapshot).memoryBytes,
              ) && (
                <span>
                  <Icon name="memory" />{" "}
                  {formatTabMemory(
                    (hoverPreview.tab as OrganisedTabSnapshot).memoryBytes,
                  )}
                </span>
              )}
            </span>
          </span>
        </aside>
      )}
      {overviewOpen && (
        <TabOverview
          snapshot={snapshot}
          data={data}
          close={() => setOverviewOpen(false)}
        />
      )}
      {visibleGroupMenu && (
        <TabGroupMenu
          group={visibleGroupMenu.group}
          position={visibleGroupMenu.position}
          close={() => setGroupMenu(null)}
        />
      )}
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
  siteControl,
  siteControlsOpen,
  onToggleSiteControls,
  onManageSiteSettings,
  onExpandedChange,
}: {
  tab: BrowserTabSnapshot;
  data: BrowserDataSnapshot;
  remoteSuggestionsEnabled: boolean;
  hyperdriveMode: HyperdriveMode;
  siteControl: WebsiteControlSnapshot | null;
  siteControlsOpen: boolean;
  onToggleSiteControls: () => void;
  onManageSiteSettings: () => void;
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
      {siteControl ? (
        <button
          type="button"
          className="omnibox-site-button"
          data-open={siteControlsOpen}
          aria-label={`Open page actions for ${siteControl.hostname}`}
          aria-haspopup="dialog"
          aria-expanded={siteControlsOpen}
          title="Page information and actions"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            setDismissed(true);
            onToggleSiteControls();
          }}
        >
          <Icon name="info" />
        </button>
      ) : (
        <span className="omnibox-leading">
          <Icon name="search" />
        </span>
      )}
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
      {siteControlsOpen && siteControl && (
        <PageActionsPanel
          tabId={tab.id}
          pageTitle={tab.title}
          pageUrl={tab.url}
          site={siteControl}
          close={onToggleSiteControls}
          manageSecurity={onManageSiteSettings}
        />
      )}
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
  extensionsMenuOpen,
  onToggleExtensionsMenu,
  onManageExtensions,
  onToggleExtensionPopup,
  siteControl,
  siteControlsOpen,
  onToggleSiteControls,
  onManageSiteSettings,
  onOmniboxExpandedChange,
}: {
  tab: BrowserTabSnapshot;
  snapshot: BrowserSnapshot;
  hyperdrive: HyperdriveSnapshot;
  data: BrowserDataSnapshot;
  bookmarked: boolean;
  onFind: () => void;
  extensions: ExtensionsSnapshot;
  extensionsMenuOpen: boolean;
  onToggleExtensionsMenu: () => void;
  onManageExtensions: () => void;
  onToggleExtensionPopup: (
    extension: BrowserExtensionSnapshot,
    anchor: DOMRect,
  ) => void;
  siteControl: WebsiteControlSnapshot | null;
  siteControlsOpen: boolean;
  onToggleSiteControls: () => void;
  onManageSiteSettings: () => void;
  onOmniboxExpandedChange: (expanded: boolean) => void;
}) {
  const canBookmark = /^https?:\/\//.test(tab.url);
  const actionExtensions = extensions.items.filter(
    (extension) =>
      extension.enabled && extension.ready && extension.action !== null,
  );
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
        siteControl={siteControl}
        siteControlsOpen={siteControlsOpen}
        onToggleSiteControls={onToggleSiteControls}
        onManageSiteSettings={onManageSiteSettings}
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
            className={`tool-button extension-action-button ${extensionActionSelected(extensions.popupExtensionId, extension.id) ? "selected" : ""}`}
            data-extension-action={extension.id}
            key={extension.id}
            disabled={!extension.action?.visible || !extension.action.enabled}
            onClick={(event) =>
              onToggleExtensionPopup(
                extension,
                event.currentTarget.getBoundingClientRect(),
              )
            }
            aria-label={`${extensionActionSelected(extensions.popupExtensionId, extension.id) ? "Close" : "Open"} ${extension.action?.title || extension.name}`}
            aria-expanded={extensionActionSelected(
              extensions.popupExtensionId,
              extension.id,
            )}
            title={extension.action?.title || extension.name}
          >
            {extension.action?.iconUrl || extension.iconDataUrl ? (
              <img
                className="extension-action-icon"
                src={extension.action?.iconUrl ?? extension.iconDataUrl ?? ""}
                alt=""
              />
            ) : (
              <span aria-hidden="true">
                {extension.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            {extension.action?.badgeText && (
              <span
                className="extension-action-badge"
                data-extension-action-badge
                style={{
                  backgroundColor: `rgba(${extension.action.badgeBackgroundColor.slice(0, 3).join(",")},${extension.action.badgeBackgroundColor[3] / 255})`,
                  color: `rgba(${extension.action.badgeTextColor.slice(0, 3).join(",")},${extension.action.badgeTextColor[3] / 255})`,
                }}
              >
                {extension.action.badgeText}
              </span>
            )}
          </button>
        ))}
        <div className="extensions-menu-anchor">
          <button
            type="button"
            className={`tool-button extensions-button ${extensionsMenuOpen ? "selected" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleExtensionsMenu();
            }}
            aria-label={`Extensions. ${extensions.items.length} installed`}
            aria-haspopup="menu"
            aria-expanded={extensionsMenuOpen}
            title="Extensions"
          >
            <Icon name="extension" />
            {extensions.items.length > 0 && (
              <span className="extensions-count" aria-hidden="true">
                {Math.min(99, extensions.items.length)}
              </span>
            )}
          </button>
          {extensionsMenuOpen && (
            <section
              className="extensions-menu"
              role="menu"
              aria-label="Extensions"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="extensions-menu-header">
                <span className="extensions-menu-mark" aria-hidden="true">
                  <Icon name="extension" />
                </span>
                <span>
                  <strong>Extensions</strong>
                  <small>
                    {extensions.items.length
                      ? `${extensions.items.length} installed`
                      : "No extensions installed"}
                  </small>
                </span>
              </header>
              <div className="extensions-menu-list">
                {extensions.items.map((extension) => {
                  const selected = extensionActionSelected(
                    extensions.popupExtensionId,
                    extension.id,
                  );
                  const actionable = Boolean(
                    extension.enabled &&
                    extension.ready &&
                    extension.action?.visible &&
                    extension.action.enabled,
                  );
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      className={`extensions-menu-item ${selected ? "selected" : ""}`}
                      key={extension.id}
                      disabled={!actionable}
                      onClick={(event) =>
                        actionable &&
                        onToggleExtensionPopup(
                          extension,
                          event.currentTarget.getBoundingClientRect(),
                        )
                      }
                    >
                      <span className="extensions-menu-icon" aria-hidden="true">
                        {extension.action?.iconUrl || extension.iconDataUrl ? (
                          <img
                            src={
                              extension.action?.iconUrl ??
                              extension.iconDataUrl ??
                              ""
                            }
                            alt=""
                          />
                        ) : (
                          extension.name.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <span className="extensions-menu-copy">
                        <strong>{extension.name}</strong>
                        <small>
                          {selected
                            ? "Open"
                            : extension.enabled
                              ? extension.ready
                                ? "Ready"
                                : "Loading"
                              : "Off"}
                        </small>
                      </span>
                      <span
                        className={`extensions-menu-state ${selected ? "open" : ""}`}
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="extensions-menu-manage"
                role="menuitem"
                onClick={onManageExtensions}
              >
                <Icon name="settings" />
                Manage extensions
              </button>
            </section>
          )}
        </div>
        <button
          type="button"
          className={`tool-button hyperdrive-button ${snapshot.preferences.hyperdriveMonitorOpen ? "selected" : ""}`}
          data-enabled={isHyperdriveEnabled(
            snapshot.preferences.hyperdriveMode,
          )}
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
          <span className="toolbar-status-dot" aria-hidden="true" />
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
          <span className="toolbar-status-dot" aria-hidden="true" />
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
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const ref = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
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
  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!formRef.current) return;
    event.preventDefault();
    const rect = formRef.current.getBoundingClientRect();
    const offset = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const move = (moveEvent: PointerEvent) => {
      setPosition(
        clampFloatingPosition(
          { x: moveEvent.clientX - offset.x, y: moveEvent.clientY - offset.y },
          { width: rect.width, height: rect.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    const finish = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", finish);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", finish, { once: true });
  };
  return (
    <form
      ref={formRef}
      className="find-bar"
      aria-label="Find in page"
      style={
        position ? { left: position.x, top: position.y, right: "auto" } : {}
      }
      onSubmit={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="find-drag-handle"
        aria-label="Drag Find in page"
        title="Drag Find in page"
        onPointerDown={beginDrag}
      >
        <Icon name="find" />
        <span>Find</span>
      </button>
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

function hyperdriveRamMaximum(
  totalMemoryMb: number,
  configuredBudgetMb: number,
): number {
  const sensibleMaximum = Math.max(
    256,
    Math.min(4_096, Math.floor(totalMemoryMb / 4 / 64) * 64),
  );
  return Math.max(sensibleMaximum, configuredBudgetMb);
}

function formatHyperdriveMemory(megabytes: number): string {
  return megabytes >= 1_024
    ? `${Number((megabytes / 1_024).toFixed(2))} GB`
    : `${megabytes} MB`;
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

export type FullSettingsCategoryId =
  | "general"
  | "privacy"
  | "appearance"
  | "downloads"
  | "ai"
  | "hyperdrive"
  | "extensions"
  | "advanced";

type FullSettingsCategory = {
  id: FullSettingsCategoryId;
  label: string;
  description: string;
  icon: IconName;
};

export type FullSettingsSearchItem = {
  id: string;
  category: FullSettingsCategoryId;
  title: string;
  description: string;
  keywords: string;
};

export const fullSettingsCategories: FullSettingsCategory[] = [
  {
    id: "general",
    label: "General",
    description: "Startup, bookmarks and browser layout",
    icon: "settings",
  },
  {
    id: "privacy",
    label: "Privacy & security",
    description: "Protection and search privacy",
    icon: "shield",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Choose how new tabs feel",
    icon: "tune",
  },
  {
    id: "downloads",
    label: "Utilities & tweaks",
    description: "YouTube downloads, My Gallery and useful extras",
    icon: "download",
  },
  {
    id: "ai",
    label: "Scout",
    description: "Providers, models and private context",
    icon: "autoAwesome",
  },
  {
    id: "hyperdrive",
    label: "Hyperdrive",
    description: "Prediction, preloading and memory",
    icon: "bolt",
  },
  {
    id: "extensions",
    label: "Extensions",
    description: "Manage tools from the Chrome Web Store",
    icon: "extension",
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "Exceptions, diagnostics and developer tools",
    icon: "memory",
  },
];

export const fullSettingsSearchItems: FullSettingsSearchItem[] = [
  {
    id: "restore-session",
    category: "general",
    title: "Restore tabs on launch",
    description: "Reopen locally stored tabs when Chromecraft starts.",
    keywords: "startup session launch reopen tabs",
  },
  {
    id: "bookmarks-bar",
    category: "general",
    title: "Show bookmarks bar",
    description: "Keep saved sites below the address bar.",
    keywords: "bookmarks favorites saved sites bar",
  },
  {
    id: "browser-sidebar",
    category: "general",
    title: "Show browser sidebar",
    description: "Keep browser tools available in the navigation rail.",
    keywords: "sidebar rail layout tools attached",
  },
  {
    id: "ublock-origin",
    category: "privacy",
    title: "uBlock Origin",
    description: "Use Chromecraft's preinstalled content blocker.",
    keywords: "ad blocker ads privacy tracking content protection",
  },
  {
    id: "live-search-suggestions",
    category: "privacy",
    title: "Live search suggestions",
    description: "Share typed search text with DuckDuckGo for suggestions.",
    keywords: "duckduckgo remote suggestions autocomplete privacy search",
  },
  {
    id: "secure-dns",
    category: "privacy",
    title: "Secure DNS",
    description: "Choose the DNS resolver Chromecraft uses for websites.",
    keywords: "dns doh resolver cloudflare google quad9 network privacy",
  },
  {
    id: "website-permissions",
    category: "privacy",
    title: "Website permissions",
    description: "Review camera, microphone, network and content exceptions.",
    keywords:
      "sites permissions camera microphone location notifications popups clipboard autoplay downloads network javascript exceptions",
  },
  {
    id: "new-tab-theme",
    category: "appearance",
    title: "New tab theme",
    description: "Choose the colour mood for new tabs.",
    keywords: "theme color colour style appearance new tab",
  },
  {
    id: "download-progress",
    category: "downloads",
    title: "Show download progress in toolbar",
    description: "Display real-time yt-dlp progress beneath the toolbar.",
    keywords: "youtube download progress toolbar speed eta",
  },
  {
    id: "download-notifications",
    category: "downloads",
    title: "Download completion notification",
    description: "Notify when a video has been fully saved.",
    keywords: "youtube download notification complete saved",
  },
  {
    id: "gallery-auto-add",
    category: "downloads",
    title: "Automatically add videos to My Gallery",
    description: "Index completed yt-dlp videos in the local gallery.",
    keywords: "gallery youtube video automatic local library",
  },
  {
    id: "smart-downloads",
    category: "downloads",
    title: "Smart Downloads",
    description: "Automatically download new videos from followed channels.",
    keywords:
      "youtube channels automatic offline storage quality background recommendations",
  },
  {
    id: "hyperdrive-enabled",
    category: "hyperdrive",
    title: "Hyperdrive",
    description: "Predict and prepare likely destinations before navigation.",
    keywords: "enable preload prefetch performance speed",
  },
  {
    id: "scout-providers",
    category: "ai",
    title: "Scout AI providers",
    description: "Configure Gemini and local Ollama connections.",
    keywords: "scout assistant ai provider ollama gemini connection credential",
  },
  {
    id: "gemini-api-key",
    category: "ai",
    title: "Google Gemini API",
    description: "Configure a private API key for fast cloud tab grouping.",
    keywords: "ai gemini api key google cloud model provider",
  },
  {
    id: "tab-organiser-model",
    category: "ai",
    title: "Tab organiser models",
    description: "Choose independent Ollama and Gemini organiser models.",
    keywords: "ollama qwen gemini model tabs organise local cloud",
  },
  {
    id: "scout-model",
    category: "ai",
    title: "Scout conversation model",
    description: "Choose the provider and model used by Scout Power.",
    keywords: "scout power conversation chat provider model performance",
  },
  {
    id: "scout-context",
    category: "ai",
    title: "Scout privacy and context",
    description: "Choose which webpage details Scout may use by default.",
    keywords:
      "scout privacy context url title description selected text screenshot element history",
  },
  {
    id: "hyperdrive-mode",
    category: "hyperdrive",
    title: "Performance mode",
    description: "Choose how aggressively Hyperdrive prepares destinations.",
    keywords: "balanced aggressive maximum performance mode",
  },
  {
    id: "hyperdrive-ram",
    category: "hyperdrive",
    title: "Maximum RAM to reserve",
    description: "Set Hyperdrive's memory safety ceiling.",
    keywords: "ram memory budget reserve limit ceiling",
  },
  {
    id: "hyperdrive-cross-site",
    category: "hyperdrive",
    title: "Allow cross-site preparation",
    description: "Permit preparation of a different site before a click.",
    keywords: "cross site privacy connection preload preparation",
  },
  {
    id: "hyperdrive-search",
    category: "hyperdrive",
    title: "Prepare search destinations",
    description: "Prepare eligible destinations selected from search.",
    keywords: "search destination suggestion speculative prefetch",
  },
  {
    id: "extension-management",
    category: "extensions",
    title: "Manage extensions",
    description: "Review installed extensions and add new ones.",
    keywords: "chrome web store installed add remove options manage",
  },
  {
    id: "ublock-settings",
    category: "extensions",
    title: "Open uBlock settings",
    description: "Open uBlock Origin's complete dashboard.",
    keywords: "ublock dashboard filters allowlist content blocker",
  },
  {
    id: "extension-developer-mode",
    category: "extensions",
    title: "Extension developer mode",
    description: "Show loading errors and compatibility warnings.",
    keywords: "extension developer dev unpacked warnings errors",
  },
  {
    id: "hyperdrive-exclusions",
    category: "advanced",
    title: "Websites excluded from Hyperdrive",
    description: "Keep listed websites out of Hyperdrive preparation.",
    keywords: "exceptions exclusions never hosts domains websites",
  },
  {
    id: "hyperdrive-monitor",
    category: "advanced",
    title: "Hyperdrive Monitor",
    description: "Show live prediction and preloading activity.",
    keywords: "monitor live predictions preloads developer panel",
  },
  {
    id: "clear-speculative-work",
    category: "advanced",
    title: "Clear speculative work",
    description: "Cancel and remove current Hyperdrive preparation.",
    keywords: "clear reset troubleshoot cancel cache speculative",
  },
];

export function searchFullSettings(query: string): FullSettingsSearchItem[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return fullSettingsSearchItems;
  return fullSettingsSearchItems.filter((item) => {
    const category = fullSettingsCategories.find(
      (candidate) => candidate.id === item.category,
    );
    const haystack =
      `${item.title} ${item.description} ${item.keywords} ${category?.label ?? ""}`.toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function settingTargetClass(
  id: string,
  highlightedSettingId: string | null,
  className = "setting-row",
): string {
  return `${className} ${highlightedSettingId === id ? "setting-search-target" : ""}`;
}

function HyperdriveSettings({
  snapshot,
  hyperdrive,
  highlightedSettingId,
}: {
  snapshot: BrowserSnapshot;
  hyperdrive: HyperdriveSnapshot;
  highlightedSettingId: string | null;
}) {
  const preferences = snapshot.preferences;
  const modeEnabled = preferences.hyperdriveMode !== "off";
  const sliderMaximum = hyperdriveRamMaximum(
    hyperdrive.totalMemoryMb,
    preferences.hyperdriveRamBudgetMb,
  );
  const estimatedUsageMb =
    hyperdrive.metrics.estimatedSpeculativeMemoryBytes / 1_048_576;
  const usagePercent = Math.min(
    100,
    (estimatedUsageMb / Math.max(1, preferences.hyperdriveRamBudgetMb)) * 100,
  );

  return (
    <>
      <section
        className="settings-card"
        aria-labelledby="hyperdrive-main-title"
      >
        <header className="settings-card-header">
          <span className="settings-card-icon">
            <Icon name="bolt" />
          </span>
          <span>
            <h3 id="hyperdrive-main-title">Main control</h3>
            <p>Turn Chromecraft's predictive loading on or off.</p>
          </span>
        </header>
        <label
          id="setting-hyperdrive-enabled"
          data-setting-id="hyperdrive-enabled"
          className={settingTargetClass(
            "hyperdrive-enabled",
            highlightedSettingId,
          )}
        >
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
      </section>

      <section
        className="settings-card"
        aria-labelledby="hyperdrive-performance-title"
      >
        <header className="settings-card-header">
          <span className="settings-card-icon">
            <Icon name="memory" />
          </span>
          <span>
            <h3 id="hyperdrive-performance-title">Performance</h3>
            <p>Balance loading strength with memory use.</p>
          </span>
        </header>
        <label
          id="setting-hyperdrive-mode"
          data-setting-id="hyperdrive-mode"
          className={settingTargetClass(
            "hyperdrive-mode",
            highlightedSettingId,
            "setting-row setting-row-stacked",
          )}
        >
          <span className="setting-copy">
            <span className="setting-title">Performance mode</span>
            <small className="setting-description">
              Balanced warms connections. Stronger modes may prefetch eligible
              documents within your privacy rules.
            </small>
          </span>
          <select
            className="settings-select"
            value={preferences.hyperdriveMode}
            disabled={!modeEnabled}
            aria-label="Hyperdrive performance mode"
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
        <label
          id="setting-hyperdrive-ram"
          data-setting-id="hyperdrive-ram"
          className={settingTargetClass(
            "hyperdrive-ram",
            highlightedSettingId,
            "setting-row setting-row-stacked hyperdrive-ram-setting",
          )}
        >
          <span className="setting-copy">
            <span className="setting-title">Maximum RAM to reserve</span>
            <small className="setting-description">
              A safety ceiling, not a target. Current estimated use is{" "}
              {estimatedUsageMb.toFixed(1)} MB.
            </small>
          </span>
          <span className="hyperdrive-ram-value">
            {formatHyperdriveMemory(preferences.hyperdriveRamBudgetMb)}
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
            aria-valuetext={formatHyperdriveMemory(
              preferences.hyperdriveRamBudgetMb,
            )}
            onChange={(event) =>
              void window.chromecraft.setHyperdriveRamBudgetMb(
                Number(event.target.value),
              )
            }
          />
          <span className="hyperdrive-ram-scale" aria-hidden="true">
            <span>64 MB</span>
            <span>{formatHyperdriveMemory(sliderMaximum)}</span>
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
      </section>

      <section
        className="settings-card"
        aria-labelledby="hyperdrive-prediction-title"
      >
        <header className="settings-card-header">
          <span className="settings-card-icon">
            <Icon name="search" />
          </span>
          <span>
            <h3 id="hyperdrive-prediction-title">
              Prediction &amp; preloading
            </h3>
            <p>Control when Hyperdrive may prepare a destination.</p>
          </span>
        </header>
        <label
          id="setting-hyperdrive-cross-site"
          data-setting-id="hyperdrive-cross-site"
          className={settingTargetClass(
            "hyperdrive-cross-site",
            highlightedSettingId,
          )}
        >
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
            aria-label="Allow cross-site preparation"
            checked={preferences.hyperdriveCrossSitePreloadingEnabled}
            disabled={!modeEnabled}
            onChange={(event) =>
              void window.chromecraft.setHyperdriveCrossSitePreloadingEnabled(
                event.target.checked,
              )
            }
          />
        </label>
        <label
          id="setting-hyperdrive-search"
          data-setting-id="hyperdrive-search"
          className={settingTargetClass(
            "hyperdrive-search",
            highlightedSettingId,
          )}
        >
          <span className="setting-copy">
            <span className="setting-title">Prepare search destinations</span>
            <small className="setting-description">
              Allows a selected search suggestion to make a speculative request.
              Unfinished queries remain local when this is off.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            aria-label="Prepare search destinations"
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
      </section>
    </>
  );
}

function HyperdriveAdvancedSettings({
  snapshot,
  highlightedSettingId,
}: {
  snapshot: BrowserSnapshot;
  highlightedSettingId: string | null;
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

  return (
    <>
      <section
        className="settings-card"
        aria-labelledby="advanced-exceptions-title"
      >
        <header className="settings-card-header">
          <span className="settings-card-icon">
            <Icon name="shield" />
          </span>
          <span>
            <h3 id="advanced-exceptions-title">Exceptions</h3>
            <p>Keep sensitive or incompatible sites out of Hyperdrive.</p>
          </span>
        </header>
        <div
          id="setting-hyperdrive-exclusions"
          data-setting-id="hyperdrive-exclusions"
          className={settingTargetClass(
            "hyperdrive-exclusions",
            highlightedSettingId,
            "setting-row setting-row-stacked",
          )}
        >
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
      </section>

      <section
        className="settings-card"
        aria-labelledby="advanced-developer-title"
      >
        <header className="settings-card-header">
          <span className="settings-card-icon">
            <Icon name="memory" />
          </span>
          <span>
            <h3 id="advanced-developer-title">
              Developer &amp; troubleshooting
            </h3>
            <p>Inspect live preparation or clear current speculative work.</p>
          </span>
        </header>
        <label
          id="setting-hyperdrive-monitor"
          data-setting-id="hyperdrive-monitor"
          className={settingTargetClass(
            "hyperdrive-monitor",
            highlightedSettingId,
          )}
        >
          <span className="setting-copy">
            <span className="setting-title">Hyperdrive Monitor</span>
            <small className="setting-description">
              Keep the live prediction and preloading panel open.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            aria-label="Hyperdrive Monitor"
            checked={preferences.hyperdriveMonitorOpen}
            onChange={(event) =>
              void window.chromecraft.setHyperdriveMonitorOpen(
                event.target.checked,
              )
            }
          />
        </label>
        <div
          id="setting-clear-speculative-work"
          data-setting-id="clear-speculative-work"
          className={settingTargetClass(
            "clear-speculative-work",
            highlightedSettingId,
            "settings-action-row",
          )}
        >
          <span className="setting-copy">
            <span className="setting-title">Clear speculative work</span>
            <small className="setting-description">
              Cancel prepared destinations and release their reserved resources.
            </small>
          </span>
          <button
            type="button"
            className="tonal-button"
            disabled={!modeEnabled}
            onClick={() => void window.chromecraft.clearHyperdriveSpeculation()}
          >
            Clear now
          </button>
        </div>
      </section>
    </>
  );
}

export function QuickSettingsPanel({
  snapshot,
  openFullSettings,
}: {
  snapshot: BrowserSnapshot;
  openFullSettings: () => void;
}) {
  const hyperdriveEnabled = snapshot.preferences.hyperdriveMode !== "off";
  const ublockStatus = snapshot.ublock.initializing
    ? "Starting protection"
    : snapshot.ublock.enabled
      ? "Blocking enabled"
      : "Blocking paused";

  return (
    <div
      className="quick-settings-sidebar"
      aria-label="Common browser controls"
    >
      <p className="quick-settings-subtitle">Common browser controls</p>
      <div className="quick-settings-grid">
        <label
          className={`quick-setting-tile quick-setting-hero ${hyperdriveEnabled ? "active" : ""}`}
        >
          <span className="quick-setting-icon">
            <Icon name="bolt" />
          </span>
          <span className="quick-setting-copy">
            <strong>Hyperdrive</strong>
            <small>
              {hyperdriveEnabled
                ? `${humaniseHyperdriveValue(snapshot.preferences.hyperdriveMode)} mode`
                : "Preload likely destinations"}
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            aria-label="Hyperdrive"
            checked={hyperdriveEnabled}
            onChange={(event) =>
              void window.chromecraft.setHyperdriveMode(
                event.target.checked ? "balanced" : "off",
              )
            }
          />
        </label>

        <label
          className={`quick-setting-tile ${snapshot.preferences.bookmarkBarVisible ? "active" : ""}`}
        >
          <span className="quick-setting-icon">
            <Icon name="bookmark" />
          </span>
          <span className="quick-setting-copy">
            <strong>Bookmarks bar</strong>
            <small>
              {snapshot.preferences.bookmarkBarVisible ? "Visible" : "Hidden"}
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            aria-label="Show bookmarks bar"
            checked={snapshot.preferences.bookmarkBarVisible}
            onChange={(event) =>
              void window.chromecraft.setBookmarkBarVisible(
                event.target.checked,
              )
            }
          />
        </label>

        <label
          className={`quick-setting-tile ${snapshot.ublock.enabled ? "active" : ""}`}
        >
          <span className="quick-setting-icon quick-setting-shield">
            <Icon name="shield" />
          </span>
          <span className="quick-setting-copy">
            <strong>uBlock Origin</strong>
            <small aria-live="polite">{ublockStatus}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            aria-label="uBlock Origin"
            checked={snapshot.ublock.enabled}
            disabled={snapshot.ublock.initializing}
            onChange={(event) =>
              void window.chromecraft.setUblockEnabled(event.target.checked)
            }
          />
        </label>

        <label className="quick-setting-tile quick-setting-theme">
          <span className="quick-setting-icon quick-setting-theme-icon">
            <Icon name="tune" />
          </span>
          <span className="quick-setting-copy">
            <strong>Theme</strong>
            <small>New tab appearance</small>
          </span>
          <span className="quick-theme-select-wrap">
            <select
              value={snapshot.preferences.newTabTheme}
              aria-label="Theme"
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
            <Icon name="chevronDown" />
          </span>
        </label>

        <button
          type="button"
          className="quick-setting-tile quick-setting-open-all"
          onClick={openFullSettings}
        >
          <span className="quick-setting-icon">
            <Icon name="settings" />
          </span>
          <span className="quick-setting-copy">
            <strong>Open full settings</strong>
            <small>All browser controls</small>
          </span>
          <Icon name="open" />
        </button>
      </div>
    </div>
  );
}

export function FullSettingsPage({
  snapshot,
  hyperdrive,
  aiTools = emptyAiTools,
  websiteControls = emptyWebsiteControls,
  smartDownloads = emptySmartDownloads,
  openSmartDownloadsRequest = 0,
  openSitePermissionsRequest = 0,
  openAiSettingsRequest = 0,
  openExtensionsPage,
}: {
  snapshot: BrowserSnapshot;
  hyperdrive: HyperdriveSnapshot;
  aiTools?: AiToolsSnapshot;
  websiteControls?: WebsiteControlsSnapshot;
  smartDownloads?: SmartDownloadsSnapshot;
  openSmartDownloadsRequest?: number;
  openSitePermissionsRequest?: number;
  openAiSettingsRequest?: number;
  openExtensionsPage: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const searchResultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [selectedCategory, setSelectedCategory] =
    useState<FullSettingsCategoryId>("general");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [smartDownloadsOpen, setSmartDownloadsOpen] = useState(false);
  const [highlightedSettingId, setHighlightedSettingId] = useState<
    string | null
  >(null);
  const searchResults = useMemo(
    () => (searchQuery.trim() ? searchFullSettings(searchQuery) : []),
    [searchQuery],
  );
  const category =
    fullSettingsCategories.find((item) => item.id === selectedCategory) ??
    fullSettingsCategories[0];
  useEffect(() => heading.current?.focus(), []);
  useLayoutEffect(() => {
    const revealActiveCategory = () => {
      document
        .querySelector<HTMLElement>(
          `[data-settings-category="${selectedCategory}"]`,
        )
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    revealActiveCategory();
    addEventListener("resize", revealActiveCategory);
    return () => removeEventListener("resize", revealActiveCategory);
  }, [selectedCategory]);
  useEffect(() => {
    if (openSmartDownloadsRequest <= 0) return;
    setSelectedCategory("downloads");
    setSmartDownloadsOpen(true);
  }, [openSmartDownloadsRequest]);
  useEffect(() => {
    if (openSitePermissionsRequest <= 0) return;
    setSelectedCategory("privacy");
    setSmartDownloadsOpen(false);
    setHighlightedSettingId("website-permissions");
  }, [openSitePermissionsRequest]);
  useEffect(() => {
    if (openAiSettingsRequest <= 0) return;
    setSelectedCategory("ai");
    setSmartDownloadsOpen(false);
    setHighlightedSettingId("gemini-api-key");
  }, [openAiSettingsRequest]);
  useLayoutEffect(() => {
    if (!highlightedSettingId) return;
    const target = document.getElementById(`setting-${highlightedSettingId}`);
    if (!target) return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    target.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "center",
    });
    const focusTarget = target.querySelector<HTMLElement>(
      "input:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex='-1'])",
    );
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
    } else {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    const timer = window.setTimeout(() => setHighlightedSettingId(null), 1_800);
    return () => clearTimeout(timer);
  }, [highlightedSettingId, selectedCategory]);

  const chooseCategory = (nextCategory: FullSettingsCategoryId) => {
    setSelectedCategory(nextCategory);
    setSmartDownloadsOpen(false);
    setHighlightedSettingId(null);
    setSearchOpen(false);
  };
  const chooseSearchResult = (item: FullSettingsSearchItem) => {
    setSelectedCategory(item.category);
    setSmartDownloadsOpen(item.id === "smart-downloads");
    setHighlightedSettingId(item.id);
    setSearchOpen(false);
  };
  const moveCategoryFocus = (
    currentCategory: FullSettingsCategoryId,
    direction: -1 | 1,
  ) => {
    const currentIndex = fullSettingsCategories.findIndex(
      (item) => item.id === currentCategory,
    );
    const nextIndex =
      (currentIndex + direction + fullSettingsCategories.length) %
      fullSettingsCategories.length;
    const nextCategory = fullSettingsCategories[nextIndex];
    chooseCategory(nextCategory.id);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-settings-category="${nextCategory.id}"]`,
        )
        ?.focus();
    });
  };

  let categoryContent;
  if (selectedCategory === "general") {
    categoryContent = (
      <section className="settings-card" aria-labelledby="general-layout-title">
        <header className="settings-card-header">
          <span className="settings-card-icon">
            <Icon name="settings" />
          </span>
          <span>
            <h3 id="general-layout-title">Startup &amp; layout</h3>
            <p>Choose what Chromecraft restores and keeps within reach.</p>
          </span>
        </header>
        <label
          id="setting-restore-session"
          data-setting-id="restore-session"
          className={settingTargetClass(
            "restore-session",
            highlightedSettingId,
          )}
        >
          <span className="setting-copy">
            <span className="setting-title">Restore tabs on launch</span>
            <small className="setting-description">
              Stored locally on this device.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            aria-label="Restore tabs on launch"
            checked={snapshot.preferences.restoreSession}
            onChange={(event) =>
              void window.chromecraft.setRestoreSession(event.target.checked)
            }
          />
        </label>
        <label
          id="setting-bookmarks-bar"
          data-setting-id="bookmarks-bar"
          className={settingTargetClass("bookmarks-bar", highlightedSettingId)}
        >
          <span className="setting-copy">
            <span className="setting-title">Show bookmarks bar</span>
            <small className="setting-description">
              Keep saved sites below the address bar.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            aria-label="Show bookmarks bar"
            checked={snapshot.preferences.bookmarkBarVisible}
            onChange={(event) =>
              void window.chromecraft.setBookmarkBarVisible(
                event.target.checked,
              )
            }
          />
        </label>
        <label
          id="setting-browser-sidebar"
          data-setting-id="browser-sidebar"
          className={settingTargetClass(
            "browser-sidebar",
            highlightedSettingId,
          )}
        >
          <span className="setting-copy">
            <span className="setting-title">Show browser sidebar</span>
            <small className="setting-description">
              Keep bookmarks, history, downloads and quick settings available.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            aria-label="Show browser sidebar"
            checked={snapshot.preferences.sidebarAttached}
            onChange={(event) =>
              void window.chromecraft.setSidebarAttached(event.target.checked)
            }
          />
        </label>
      </section>
    );
  } else if (selectedCategory === "privacy") {
    categoryContent = (
      <>
        <section
          className="settings-card"
          aria-labelledby="privacy-controls-title"
        >
          <header className="settings-card-header">
            <span className="settings-card-icon">
              <Icon name="shield" />
            </span>
            <span>
              <h3 id="privacy-controls-title">Protection &amp; suggestions</h3>
              <p>
                Control content blocking and when typed text leaves this device.
              </p>
            </span>
          </header>
          <label
            id="setting-ublock-origin"
            data-setting-id="ublock-origin"
            className={settingTargetClass(
              "ublock-origin",
              highlightedSettingId,
            )}
          >
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
              aria-label="uBlock Origin"
              checked={snapshot.ublock.enabled}
              disabled={snapshot.ublock.initializing}
              onChange={(event) =>
                void window.chromecraft.setUblockEnabled(event.target.checked)
              }
            />
          </label>
          <label
            id="setting-live-search-suggestions"
            data-setting-id="live-search-suggestions"
            className={settingTargetClass(
              "live-search-suggestions",
              highlightedSettingId,
            )}
          >
            <span className="setting-copy">
              <span className="setting-title">Live search suggestions</span>
              <small className="setting-description">
                Share typed search text with DuckDuckGo for live suggestions.
                Local history and bookmark autocomplete stays available.
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch-input"
              aria-label="Live search suggestions"
              checked={snapshot.preferences.remoteSearchSuggestionsEnabled}
              onChange={(event) =>
                void window.chromecraft.setRemoteSearchSuggestionsEnabled(
                  event.target.checked,
                )
              }
            />
          </label>
        </section>
        <div
          id="setting-secure-dns"
          data-setting-id="secure-dns"
          className={settingTargetClass(
            "secure-dns",
            highlightedSettingId,
            "website-permissions-dashboard-wrap",
          )}
        >
          <div
            id="setting-website-permissions"
            data-setting-id="website-permissions"
            className={settingTargetClass(
              "website-permissions",
              highlightedSettingId,
              "website-permissions-dashboard-wrap",
            )}
          >
            <WebsitePermissionsDashboard snapshot={websiteControls} />
          </div>
        </div>
      </>
    );
  } else if (selectedCategory === "appearance") {
    categoryContent = (
      <section
        className="settings-card"
        aria-labelledby="appearance-theme-title"
      >
        <header className="settings-card-header">
          <span className="settings-card-icon settings-card-icon-tertiary">
            <Icon name="tune" />
          </span>
          <span>
            <h3 id="appearance-theme-title">New tab appearance</h3>
            <p>Choose a restrained colour mood for every new tab.</p>
          </span>
        </header>
        <label
          id="setting-new-tab-theme"
          data-setting-id="new-tab-theme"
          className={settingTargetClass(
            "new-tab-theme",
            highlightedSettingId,
            "setting-row setting-row-stacked",
          )}
        >
          <span className="setting-copy">
            <span className="setting-title">New tab theme</span>
            <small className="setting-description">
              Applies to Chromecraft's built-in new tab page.
            </small>
          </span>
          <select
            className="settings-select"
            value={snapshot.preferences.newTabTheme}
            aria-label="New tab theme"
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
      </section>
    );
  } else if (selectedCategory === "downloads") {
    categoryContent = smartDownloadsOpen ? (
      <SmartDownloadsPage
        snapshot={smartDownloads}
        onBack={() => setSmartDownloadsOpen(false)}
      />
    ) : (
      <section
        className="settings-card"
        aria-labelledby="download-gallery-title"
      >
        <header className="settings-card-header">
          <span className="settings-card-icon">
            <Icon name="download" />
          </span>
          <span>
            <h3 id="download-gallery-title">YouTube downloads + Gallery</h3>
            <p>
              Videos stay in your system Downloads folder and remain local to
              this device.
            </p>
          </span>
        </header>
        <div className="settings-action-row">
          <span className="setting-copy">
            <span className="setting-title">Default download location</span>
            <small className="setting-description">
              Your operating system Downloads folder. Existing file paths are
              preserved.
            </small>
          </span>
          <button
            type="button"
            className="tonal-button settings-action-button"
            onClick={() => void window.chromecraft.openGallery()}
          >
            <Icon name="videoLibrary" />
            Open My Gallery
          </button>
        </div>
        <div
          id="setting-smart-downloads"
          data-setting-id="smart-downloads"
          className="settings-action-row settings-smart-downloads-link"
        >
          <span className="setting-copy">
            <span className="setting-title">Smart Downloads</span>
            <small className="setting-description">
              Follow channels, set a private storage allocation and keep new
              videos ready offline.{" "}
              {smartDownloads.config.enabled ? "On" : "Off"} ·{" "}
              {smartDownloads.channels.length} channel(s)
            </small>
          </span>
          <button
            type="button"
            className="tonal-button settings-action-button"
            onClick={() => setSmartDownloadsOpen(true)}
          >
            <Icon name="chevronRight" />
            Manage
          </button>
        </div>
        <label
          id="setting-download-progress"
          data-setting-id="download-progress"
          className={settingTargetClass(
            "download-progress",
            highlightedSettingId,
          )}
        >
          <span className="setting-copy">
            <span className="setting-title">Show progress in toolbar</span>
            <small className="setting-description">
              See real percentage, transfer speed, ETA and final processing.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            checked={snapshot.preferences.showDownloadProgressInToolbar}
            onChange={(event) =>
              void window.chromecraft.setShowDownloadProgressInToolbar(
                event.target.checked,
              )
            }
          />
        </label>
        <label
          id="setting-download-notifications"
          data-setting-id="download-notifications"
          className={settingTargetClass(
            "download-notifications",
            highlightedSettingId,
          )}
        >
          <span className="setting-copy">
            <span className="setting-title">Show completion notification</span>
            <small className="setting-description">
              Notify only after the final file has been saved successfully.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            checked={snapshot.preferences.showDownloadCompletionNotification}
            onChange={(event) =>
              void window.chromecraft.setShowDownloadCompletionNotification(
                event.target.checked,
              )
            }
          />
        </label>
        <label
          id="setting-gallery-auto-add"
          data-setting-id="gallery-auto-add"
          className={settingTargetClass(
            "gallery-auto-add",
            highlightedSettingId,
          )}
        >
          <span className="setting-copy">
            <span className="setting-title">
              Automatically add videos to My Gallery
            </span>
            <small className="setting-description">
              Index the completed file in place without making a second copy.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            checked={snapshot.preferences.addVideosToGallery}
            onChange={(event) =>
              void window.chromecraft.setAddVideosToGallery(
                event.target.checked,
              )
            }
          />
        </label>
      </section>
    );
  } else if (selectedCategory === "ai") {
    categoryContent = (
      <ScoutSettings
        aiTools={aiTools}
        highlightedSettingId={highlightedSettingId}
      />
    );
  } else if (selectedCategory === "hyperdrive") {
    categoryContent = (
      <HyperdriveSettings
        snapshot={snapshot}
        hyperdrive={hyperdrive}
        highlightedSettingId={highlightedSettingId}
      />
    );
  } else if (selectedCategory === "extensions") {
    categoryContent = (
      <>
        <section
          className="settings-card"
          aria-labelledby="extension-management-title"
        >
          <header className="settings-card-header">
            <span className="settings-card-icon">
              <Icon name="extension" />
            </span>
            <span>
              <h3 id="extension-management-title">Extension management</h3>
              <p>Review installed tools and add compatible extensions.</p>
            </span>
          </header>
          <div
            id="setting-extension-management"
            data-setting-id="extension-management"
            className={settingTargetClass(
              "extension-management",
              highlightedSettingId,
              "settings-action-row",
            )}
          >
            <span className="setting-copy">
              <span className="setting-title">Manage extensions</span>
              <small className="setting-description">
                Enable, disable, remove or install Chrome Web Store extensions.
              </small>
            </span>
            <button
              type="button"
              className="tonal-button settings-action-button"
              onClick={openExtensionsPage}
            >
              <Icon name="extension" />
              Open manager
            </button>
          </div>
          <div
            id="setting-ublock-settings"
            data-setting-id="ublock-settings"
            className={settingTargetClass(
              "ublock-settings",
              highlightedSettingId,
              "settings-action-row",
            )}
          >
            <span className="setting-copy">
              <span className="setting-title">uBlock Origin settings</span>
              <small className="setting-description">
                Manage filter lists, trusted sites and advanced blocking rules.
              </small>
            </span>
            <button
              type="button"
              className="tonal-button settings-action-button"
              onClick={() => void window.chromecraft.openUblockDashboard()}
            >
              <Icon name="open" />
              Open uBlock
            </button>
          </div>
        </section>
        <section
          className="settings-card"
          aria-labelledby="extension-developer-title"
        >
          <header className="settings-card-header">
            <span className="settings-card-icon settings-card-icon-tertiary">
              <Icon name="tune" />
            </span>
            <span>
              <h3 id="extension-developer-title">Developer tools</h3>
              <p>Expose compatibility details for unpacked extensions.</p>
            </span>
          </header>
          <label
            id="setting-extension-developer-mode"
            data-setting-id="extension-developer-mode"
            className={settingTargetClass(
              "extension-developer-mode",
              highlightedSettingId,
            )}
          >
            <span className="setting-copy">
              <span className="setting-title">Extension developer mode</span>
              <small className="setting-description">
                Show extension warnings, loading errors and unpacked tools.
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch-input"
              aria-label="Extension developer mode"
              checked={snapshot.preferences.extensionDeveloperMode}
              onChange={(event) =>
                void window.chromecraft.setExtensionDeveloperMode(
                  event.target.checked,
                )
              }
            />
          </label>
        </section>
      </>
    );
  } else {
    categoryContent = (
      <HyperdriveAdvancedSettings
        snapshot={snapshot}
        highlightedSettingId={highlightedSettingId}
      />
    );
  }

  return (
    <main className="full-settings-page" aria-labelledby="full-settings-title">
      <div className="full-settings-content">
        <header className="full-settings-header">
          <span className="full-settings-heading">
            <span className="full-settings-mark">
              <Icon name="settings" />
            </span>
            <span>
              <h1 ref={heading} id="full-settings-title" tabIndex={-1}>
                Settings
              </h1>
              <p>Shape Chromecraft around the way you browse.</p>
            </span>
          </span>
          <div
            className="settings-search"
            data-open={searchOpen && Boolean(searchQuery.trim())}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setSearchOpen(false);
              }
            }}
          >
            <div className="settings-search-field">
              <Icon name="search" />
              <input
                type="search"
                value={searchQuery}
                placeholder="Search settings"
                aria-label="Search settings"
                role="combobox"
                aria-autocomplete="list"
                aria-controls="settings-search-results"
                aria-expanded={searchOpen && Boolean(searchQuery.trim())}
                onFocus={() => setSearchOpen(Boolean(searchQuery.trim()))}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setSearchOpen(Boolean(event.target.value.trim()));
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" && searchResults.length > 0) {
                    event.preventDefault();
                    searchResultRefs.current[0]?.focus();
                  } else if (event.key === "Enter" && searchResults[0]) {
                    event.preventDefault();
                    chooseSearchResult(searchResults[0]);
                  } else if (event.key === "Escape") {
                    event.stopPropagation();
                    setSearchQuery("");
                    setSearchOpen(false);
                  }
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="settings-search-clear"
                  aria-label="Clear settings search"
                  title="Clear settings search"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchOpen(false);
                  }}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
            <span className="visually-hidden" role="status" aria-live="polite">
              {searchQuery.trim()
                ? `${searchResults.length} settings found`
                : ""}
            </span>
            {searchOpen && searchQuery.trim() && (
              <div
                className="settings-search-results"
                id="settings-search-results"
                role="listbox"
                aria-label="Settings search results"
              >
                {searchResults.map((item, index) => {
                  const itemCategory = fullSettingsCategories.find(
                    (candidate) => candidate.id === item.category,
                  );
                  return (
                    <button
                      type="button"
                      key={item.id}
                      ref={(element) => {
                        searchResultRefs.current[index] = element;
                      }}
                      role="option"
                      aria-selected="false"
                      onClick={() => chooseSearchResult(item)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          searchResultRefs.current[
                            (index + 1) % searchResults.length
                          ]?.focus();
                        } else if (event.key === "ArrowUp") {
                          event.preventDefault();
                          searchResultRefs.current[
                            (index - 1 + searchResults.length) %
                              searchResults.length
                          ]?.focus();
                        } else if (event.key === "Escape") {
                          event.stopPropagation();
                          setSearchOpen(false);
                          document
                            .querySelector<HTMLInputElement>(
                              '.settings-search input[type="search"]',
                            )
                            ?.focus();
                        }
                      }}
                    >
                      <span className="settings-search-result-icon">
                        <Icon name={itemCategory?.icon ?? "settings"} />
                      </span>
                      <span>
                        <strong>{item.title}</strong>
                        <small>{itemCategory?.label}</small>
                      </span>
                      <Icon name="chevronRight" />
                    </button>
                  );
                })}
                {searchResults.length === 0 && (
                  <div className="settings-search-empty">
                    <Icon name="search" />
                    <span>
                      <strong>No settings found</strong>
                      <small>Try another word or phrase.</small>
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>
        <div className="full-settings-layout">
          <nav
            className="settings-category-nav"
            aria-label="Settings categories"
          >
            <span className="settings-category-label">Categories</span>
            {fullSettingsCategories.map((item) => (
              <button
                type="button"
                key={item.id}
                data-settings-category={item.id}
                className={selectedCategory === item.id ? "active" : ""}
                aria-current={selectedCategory === item.id ? "page" : undefined}
                onClick={() => chooseCategory(item.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                    event.preventDefault();
                    moveCategoryFocus(item.id, 1);
                  } else if (
                    event.key === "ArrowUp" ||
                    event.key === "ArrowLeft"
                  ) {
                    event.preventDefault();
                    moveCategoryFocus(item.id, -1);
                  }
                }}
              >
                <span className="settings-category-icon">
                  <Icon name={item.icon} />
                </span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <section
            className="full-settings-detail"
            data-settings-detail={selectedCategory}
            aria-labelledby={`settings-category-${selectedCategory}`}
          >
            <header className="settings-category-header">
              <span className="settings-category-header-icon">
                <Icon name={category.icon} />
              </span>
              <span>
                <small>Chromecraft settings</small>
                <h2 id={`settings-category-${selectedCategory}`}>
                  {category.label}
                </h2>
                <p>{category.description}</p>
              </span>
            </header>
            <div className="settings-category-content">{categoryContent}</div>
          </section>
        </div>
      </div>
    </main>
  );
}

function ExtensionIdentityIcon({
  extension,
  className,
}: {
  extension: BrowserExtensionSnapshot;
  className: string;
}) {
  const iconUrl = extension.iconDataUrl ?? extension.action?.iconUrl;
  return (
    <span className={className} aria-hidden="true">
      {iconUrl ? (
        <img src={iconUrl} alt="" />
      ) : (
        extension.name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

export function ExtensionsSidebarPanel({
  snapshot,
  openPage,
}: {
  snapshot: ExtensionsSnapshot;
  openPage: () => void;
}) {
  return (
    <div className="extensions-sidebar-panel extensions-sidebar-summary">
      <div className="extensions-sidebar-list" role="list">
        {snapshot.items.map((extension) => (
          <article
            className="extensions-sidebar-item"
            key={extension.id}
            role="listitem"
            data-extension-id={extension.id}
          >
            <ExtensionIdentityIcon
              extension={extension}
              className="extensions-sidebar-icon"
            />
            <span className="extensions-sidebar-copy">
              <strong>{extension.name}</strong>
              <small>
                {extension.description ||
                  (extension.enabled ? "Ready to use" : "Turned off")}
              </small>
            </span>
            <span
              className="extensions-sidebar-state"
              data-status={extension.status}
              aria-label={extension.enabled ? "Enabled" : "Disabled"}
            />
          </article>
        ))}
        {snapshot.initialized && snapshot.items.length === 0 && (
          <EmptyState
            icon="extension"
            title="No user extensions"
            description="Add extensions from the Chrome Web Store to see them here."
          />
        )}
        {!snapshot.initialized && (
          <div className="extension-loading">
            <ExpressiveLoadingIndicator label="Loading extensions" />
            <span>Loading extensions…</span>
          </div>
        )}
      </div>
      <div className="extensions-sidebar-footer">
        <button
          type="button"
          className="tonal-button"
          onClick={openPage}
          aria-label="Open extensions page"
        >
          <Icon name="open" />
          Open extensions page
        </button>
      </div>
    </div>
  );
}

export function ExtensionsPage({
  snapshot,
  developerMode,
  close,
  requestInstall,
  requestRemove,
}: {
  snapshot: ExtensionsSnapshot;
  developerMode: boolean;
  close: () => void;
  requestInstall: (itemUrl: string) => void;
  requestRemove: (id: string, name: string) => void;
}) {
  const [manualInstallOpen, setManualInstallOpen] = useState(false);
  const [itemUrl, setItemUrl] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const installing =
    snapshot.operation === "installing" || snapshot.operation === "reviewing";
  const storeUrl = "https://chromewebstore.google.com/category/extensions";
  const importUnpacked = async () => {
    setActionError(null);
    try {
      await window.chromecraft.importUnpackedExtension();
    } catch {
      setActionError("Chromecraft could not import that extension folder.");
    }
  };

  return (
    <main className="extensions-page" aria-labelledby="extensions-page-title">
      <div className="extensions-page-content">
        <header className="extensions-page-header">
          <button
            type="button"
            className="extensions-page-back"
            onClick={close}
            aria-label="Back to browsing"
            title="Back to browsing"
          >
            <Icon name="back" />
          </button>
          <span>
            <small>Chromecraft</small>
            <h1 id="extensions-page-title">Extensions</h1>
          </span>
        </header>

        <div className="extensions-page-layout">
          <section
            className="extensions-library"
            aria-labelledby="installed-extensions-title"
          >
            <div className="extensions-section-heading">
              <span>
                <small>On this browser</small>
                <h2 id="installed-extensions-title">Installed extensions</h2>
              </span>
              <span className="extension-total">
                {snapshot.items.length} installed
              </span>
            </div>
            {snapshot.error && (
              <div className="extension-error" role="alert">
                <Icon name="warning" />
                <span>{snapshot.error}</span>
              </div>
            )}
            <div className="extensions-page-list" role="list">
              {snapshot.items.map((extension) => (
                <article
                  className="extension-page-item"
                  key={extension.id}
                  role="listitem"
                  data-extension-id={extension.id}
                >
                  <div className="extension-page-item-heading">
                    <ExtensionIdentityIcon
                      extension={extension}
                      className="extension-page-icon"
                    />
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
                  <span
                    className="extension-status"
                    data-status={extension.status}
                  >
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
                  {developerMode && extension.error && (
                    <small className="extension-item-error">
                      {extension.error}
                    </small>
                  )}
                  {developerMode && extension.warnings.length > 0 && (
                    <details>
                      <summary>
                        {extension.warnings.length} extension warning(s)
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
                          const rect =
                            event.currentTarget.getBoundingClientRect();
                          void window.chromecraft.toggleExtensionPopup(
                            extension.id,
                            {
                              x: rect.x,
                              y: rect.y,
                              width: rect.width,
                              height: rect.height,
                            },
                          );
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
                      onClick={() =>
                        requestRemove(extension.id, extension.name)
                      }
                    >
                      Remove
                    </button>
                  </div>
                </article>
              ))}
              {snapshot.initialized && snapshot.items.length === 0 && (
                <EmptyState
                  icon="extension"
                  title="No extensions installed"
                  description="Visit the Chrome Web Store or add an extension manually."
                />
              )}
              {!snapshot.initialized && (
                <div className="extension-loading">
                  <ExpressiveLoadingIndicator label="Loading extensions" />
                  <span>Loading extensions…</span>
                </div>
              )}
            </div>
          </section>

          <aside
            className="extension-management-tiles"
            aria-label="Extension tools"
          >
            <section
              className="extension-management-tile extension-add-tile"
              data-extension-tile="add"
            >
              <span className="extension-tile-icon" aria-hidden="true">
                <Icon name="add" />
              </span>
              <div>
                <small>Add extension</small>
                <h2>Find something useful</h2>
                <p>
                  Browse extensions made for Chrome, or paste a listing link to
                  review it before installation.
                </p>
              </div>
              <button
                type="button"
                className="filled-button extension-store-button"
                aria-label="Open Chrome Web Store"
                onClick={() => {
                  close();
                  void window.chromecraft.createTab(storeUrl);
                }}
              >
                <span className="extension-store-logo" aria-hidden="true">
                  <span />
                </span>
                Open Chrome Web Store
              </button>
              <button
                type="button"
                className="extension-manual-toggle"
                aria-expanded={manualInstallOpen}
                aria-controls="manual-extension-install"
                onClick={() => setManualInstallOpen((open) => !open)}
              >
                Add extension manually
                <Icon name={manualInstallOpen ? "chevronUp" : "chevronDown"} />
              </button>
              {manualInstallOpen && (
                <form
                  className="extension-manual-form"
                  id="manual-extension-install"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const trimmed = itemUrl.trim();
                    if (parseChromeWebStoreListingUrl(trimmed)) {
                      requestInstall(trimmed);
                    }
                  }}
                >
                  <label htmlFor="manual-extension-url">
                    Chrome Web Store listing URL
                  </label>
                  <input
                    id="manual-extension-url"
                    type="url"
                    value={itemUrl}
                    onChange={(event) => setItemUrl(event.target.value)}
                    placeholder="https://chromewebstore.google.com/detail/…"
                    aria-label="Chrome Web Store extension URL"
                    disabled={installing}
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="tonal-button"
                    disabled={
                      !parseChromeWebStoreListingUrl(itemUrl.trim()) ||
                      installing
                    }
                  >
                    {installing ? "Verifying…" : "Review extension"}
                  </button>
                </form>
              )}
            </section>

            <section
              className="extension-management-tile extension-updates-tile"
              data-extension-tile="updates"
            >
              <span className="extension-tile-icon" aria-hidden="true">
                <Icon name="reload" />
              </span>
              <div>
                <small>Extension updates</small>
                <h2>Updated with Chromecraft</h2>
                <p>
                  Extension updates are verified and bundled with browser
                  updates, keeping the browser and its extensions in step.
                </p>
              </div>
              <span className="extension-update-badge">
                <Icon name="shield" />
                Managed by browser updates
              </span>
            </section>

            <section
              className="extension-management-tile extension-dev-tile"
              data-extension-tile="developer"
            >
              <span className="extension-tile-icon" aria-hidden="true">
                <Icon name="tune" />
              </span>
              <div>
                <small>Developer tools</small>
                <h2>Dev mode</h2>
                <p>
                  Import an unpacked extension and show its compatibility
                  warnings and loading errors.
                </p>
              </div>
              <label className="extension-dev-toggle">
                <span>
                  <strong>Dev mode</strong>
                  <small>{developerMode ? "Enabled" : "Disabled"}</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="switch-input"
                  aria-label="Extension developer mode"
                  checked={developerMode}
                  onChange={(event) =>
                    void window.chromecraft.setExtensionDeveloperMode(
                      event.target.checked,
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="tonal-button extension-load-unpacked"
                aria-label="Load unpacked extension"
                disabled={!developerMode || snapshot.operation !== "idle"}
                onClick={() => void importUnpacked()}
              >
                <Icon name="folder" />
                Load unpacked
              </button>
              {actionError && (
                <p className="extension-dev-error" role="alert">
                  {actionError}
                </p>
              )}
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

function GallerySidebarPreview({ item }: { item: GalleryEntrySnapshot }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
    setVideoFailed(false);
  }, [item.id, item.thumbnailUrl, item.mediaUrl]);

  const showImage = Boolean(item.thumbnailUrl) && !imageFailed;
  const showVideo = item.available && !videoFailed && !showImage;
  return (
    <span className="gallery-sidebar-thumb">
      {showImage && (
        <img
          src={item.thumbnailUrl!}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      )}
      {showVideo && (
        <video
          src={item.mediaUrl}
          muted
          preload="metadata"
          playsInline
          onError={() => setVideoFailed(true)}
          onLoadedMetadata={(event) => {
            const preview = event.currentTarget;
            if (preview.duration > 2) {
              preview.currentTime = Math.min(3, preview.duration * 0.08);
            }
          }}
          aria-hidden="true"
        />
      )}
      {!showImage && !showVideo && (
        <span
          className="gallery-sidebar-fallback material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          {item.available ? "movie" : "broken_image"}
        </span>
      )}
      {item.available && <Icon name="play" />}
      {!item.available && <Icon name="warning" />}
    </span>
  );
}

function Sidebar({
  snapshot,
  data,
  downloads,
  youtubeDownloads,
  extensions,
  gallery,
  tool,
  setTool,
  openExtensionsPage,
  openFullSettings,
  requestClearHistory,
  activeTab,
  aiTools,
  openOrganiseTabs,
  openScoutSettings,
}: {
  snapshot: BrowserSnapshot;
  data: BrowserDataSnapshot;
  downloads: DownloadSnapshot;
  youtubeDownloads: YouTubeDownloadsSnapshot;
  extensions: ExtensionsSnapshot;
  gallery: GallerySnapshot;
  tool: SidebarTool | null;
  setTool: (tool: SidebarTool | null) => void;
  openExtensionsPage: () => void;
  openFullSettings: () => void;
  requestClearHistory: (range: "hour" | "day" | "all") => void;
  activeTab: BrowserTabSnapshot;
  aiTools: AiToolsSnapshot;
  openOrganiseTabs: () => void;
  openScoutSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [downloadJustCompleted, setDownloadJustCompleted] = useState(false);
  const priorDownloadStates = useRef<Map<
    string,
    DownloadSnapshot["items"][number]["state"]
  > | null>(null);
  const downloadCompletionTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const open = snapshot.preferences.sidebarOpen;
  const panelOpen = open && Boolean(tool);
  const navigate = (url: string) => void window.chromecraft.createTab(url);
  const openGalleryFromSidebar = async (entryId?: string) => {
    setTool(null);
    try {
      await window.chromecraft.setSidebarOpen(false);
    } finally {
      await window.chromecraft.openGallery(entryId, true);
    }
  };
  const needle = query.toLowerCase();
  const bookmarks = data.bookmarks.filter((item) =>
    `${item.title} ${item.url} ${item.folder}`.toLowerCase().includes(needle),
  );
  const history = data.history.filter((item) =>
    `${item.title} ${item.url}`.toLowerCase().includes(needle),
  );
  const tools = [
    ["assistant", "autoAwesome", "Scout"],
    ["bookmarks", "bookmark", "Bookmarks"],
    ["history", "history", "History"],
    ["downloads", "download", "Downloads"],
    ["gallery", "videoLibrary", "YouTube & My Gallery"],
    ["extensions", "extension", "Extensions"],
    ["settings", "settings", "Settings"],
  ] as const;
  const downloadIndicator = useMemo(
    () => deriveDownloadIndicator(downloads.items),
    [downloads.items],
  );
  const activeYouTubeDownloads = youtubeDownloads.items.filter((item) =>
    ["pending", "downloading", "finishing"].includes(item.stage),
  );
  const youtubePercents = activeYouTubeDownloads
    .map((item) => item.percent)
    .filter((value): value is number => value !== null);
  const combinedDownloadPercent =
    downloadIndicator.unfinishedCount > 0
      ? downloadIndicator.percent
      : youtubePercents.length === activeYouTubeDownloads.length &&
          youtubePercents.length > 0
        ? youtubePercents.reduce((sum, value) => sum + value, 0) /
          youtubePercents.length
        : null;
  useEffect(() => {
    const nextStates = new Map(
      downloads.items.map((item) => [item.id, item.state]),
    );
    const previous = priorDownloadStates.current;
    priorDownloadStates.current = nextStates;
    if (!previous) return;
    const completed = didAnyDownloadComplete(previous, downloads.items);
    if (!completed) return;
    setDownloadJustCompleted(true);
    if (downloadCompletionTimer.current) {
      clearTimeout(downloadCompletionTimer.current);
    }
    downloadCompletionTimer.current = setTimeout(() => {
      setDownloadJustCompleted(false);
      downloadCompletionTimer.current = null;
    }, 2_000);
  }, [downloads.items]);
  useEffect(
    () => () => {
      if (downloadCompletionTimer.current) {
        clearTimeout(downloadCompletionTimer.current);
      }
    },
    [],
  );
  if (!snapshot.preferences.sidebarAttached) return null;

  return (
    <aside
      className={`sidebar ${panelOpen ? "panel-open" : "rail-only"}`}
      aria-label="Browser sidebar"
    >
      <nav className="sidebar-rail">
        {tools.map(([id, icon, label]) => {
          const isDownloads = id === "downloads";
          const activeDownloadCount =
            downloadIndicator.unfinishedCount + activeYouTubeDownloads.length;
          const dynamicLabel =
            isDownloads && activeDownloadCount > 0
              ? `${label}, ${activeDownloadCount} active`
              : label;
          return (
            <button
              type="button"
              key={id}
              className={tool === id ? "active" : ""}
              onClick={() => {
                const nextTool = selectSidebarTool(tool, id);
                setTool(nextTool);
                void window.chromecraft.setSidebarOpen(Boolean(nextTool));
              }}
              title={dynamicLabel}
              aria-label={dynamicLabel}
              aria-current={tool === id ? "page" : undefined}
              aria-expanded={tool === id}
              aria-controls="sidebar-panel"
            >
              <span
                className={`rail-selection-indicator ${isDownloads ? "download-rail-indicator" : ""}`}
                data-downloading={
                  isDownloads && activeDownloadCount > 0 ? "true" : undefined
                }
                data-progressing={
                  isDownloads && activeDownloadCount > 0 ? "true" : undefined
                }
                data-indeterminate={
                  isDownloads &&
                  activeDownloadCount > 0 &&
                  downloadIndicator.percent === null
                    ? "true"
                    : undefined
                }
                data-complete={
                  isDownloads && downloadJustCompleted ? "true" : undefined
                }
              >
                {isDownloads && activeDownloadCount > 0 && (
                  <svg
                    className="download-progress-ring"
                    viewBox="0 0 40 40"
                    aria-hidden="true"
                  >
                    <circle
                      className="download-ring-track"
                      cx="20"
                      cy="20"
                      r="17"
                    />
                    <circle
                      className="download-ring-value"
                      cx="20"
                      cy="20"
                      r="17"
                      pathLength="100"
                      strokeDasharray="100"
                      strokeDashoffset={
                        combinedDownloadPercent === null
                          ? 72
                          : 100 - combinedDownloadPercent
                      }
                    />
                  </svg>
                )}
                {id === "assistant" ? (
                  <StaticAssistantAvatar className="ai-rail-avatar" size={24} />
                ) : (
                  <Icon name={icon} />
                )}
                {isDownloads && activeDownloadCount > 1 && (
                  <span className="download-count-badge" aria-hidden="true">
                    {activeDownloadCount > 99 ? "99+" : activeDownloadCount}
                  </span>
                )}
              </span>
            </button>
          );
        })}
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
      {panelOpen && tool && (
        <section
          className="sidebar-panel"
          id="sidebar-panel"
          aria-labelledby="sidebar-panel-title"
        >
          {tool !== "assistant" && (
            <header className="panel-header">
              <h2 id="sidebar-panel-title">
                {tool === "settings"
                  ? "Quick settings"
                  : tool[0].toUpperCase() + tool.slice(1)}
              </h2>
            </header>
          )}
          {tool === "assistant" && (
            <AiAssistantPanel
              activeTab={activeTab}
              aiTools={aiTools}
              close={() => {
                setTool(null);
                void window.chromecraft.setSidebarOpen(false);
              }}
              onOrganiseTabs={openOrganiseTabs}
              onOpenSettings={openScoutSettings}
            />
          )}
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
                {youtubeDownloads.items
                  .filter((item) => item.stage !== "completed")
                  .map((item) => (
                    <article
                      className="download list-item"
                      key={item.id}
                      role="listitem"
                    >
                      <div className="entry-main">
                        <strong>
                          {item.filename || `YouTube video ${item.videoId}`}
                        </strong>
                        <small className="entry-supporting-text">
                          {item.stage === "finishing"
                            ? "Finalising video"
                            : item.stage}{" "}
                          ·{" "}
                          {item.percent === null
                            ? "Calculating…"
                            : `${Math.round(item.percent)}%`}
                        </small>
                        <progress
                          max={100}
                          value={item.percent ?? undefined}
                          aria-label={`YouTube download progress for ${item.filename || item.videoId}`}
                        />
                      </div>
                      <div className="download-actions">
                        {["pending", "downloading", "finishing"].includes(
                          item.stage,
                        ) && (
                          <button
                            onClick={() =>
                              void window.chromecraft.cancelYouTubeDownload(
                                item.id,
                              )
                            }
                            aria-label={`Cancel ${item.filename || item.videoId}`}
                          >
                            <Icon name="close" />
                          </button>
                        )}
                        {(
                          ["failed", "cancelled", "interrupted"] as const
                        ).includes(
                          item.stage as "failed" | "cancelled" | "interrupted",
                        ) && (
                          <button
                            onClick={() =>
                              void window.chromecraft.retryYouTubeDownload(
                                item.id,
                              )
                            }
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
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
                {downloads.items.length === 0 &&
                  youtubeDownloads.items.length === 0 && (
                    <EmptyState
                      icon="download"
                      title="No downloads"
                      description="Files you download will appear here."
                    />
                  )}
              </div>
            </>
          )}
          {tool === "gallery" && (
            <div className="gallery-sidebar-panel">
              <button
                type="button"
                className="gallery-sidebar-open"
                onClick={() => void openGalleryFromSidebar()}
              >
                <span
                  className="material-icon material-symbols-rounded"
                  aria-hidden="true"
                >
                  video_library
                </span>
                <span>
                  <strong>Open gallery</strong>
                </span>
                <Icon name="chevronRight" />
              </button>
              <header className="gallery-sidebar-heading">
                <span>
                  <strong>Recent videos</strong>
                  <small>
                    {gallery.items.length}{" "}
                    {gallery.items.length === 1 ? "video" : "videos"} on this
                    device
                  </small>
                </span>
              </header>
              <div className="gallery-sidebar-recents">
                {gallery.items.slice(0, 5).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    disabled={!item.available}
                    onClick={() => void openGalleryFromSidebar(item.id)}
                  >
                    <GallerySidebarPreview item={item} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {new Date(item.downloadedAt).toLocaleDateString(
                          undefined,
                          {
                            day: "numeric",
                            month: "short",
                          },
                        )}{" "}
                        · {item.sourceName ?? "Local video"}
                      </small>
                    </span>
                  </button>
                ))}
                {gallery.items.length === 0 && (
                  <EmptyState
                    icon="videoLibrary"
                    title="No videos yet"
                    description="Your YouTube downloads will appear here."
                  />
                )}
              </div>
            </div>
          )}
          {tool === "extensions" && (
            <ExtensionsSidebarPanel
              snapshot={extensions}
              openPage={openExtensionsPage}
            />
          )}
          {tool === "settings" && (
            <QuickSettingsPanel
              snapshot={snapshot}
              openFullSettings={openFullSettings}
            />
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

export const HyperdriveMonitor = memo(function HyperdriveMonitor({
  snapshot,
  developerMode,
}: {
  snapshot: HyperdriveSnapshot;
  developerMode: boolean;
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
  const sliderMaximum = hyperdriveRamMaximum(
    snapshot.totalMemoryMb,
    snapshot.ramBudgetMb,
  );
  const enabled = snapshot.mode !== "off";
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
          <h2>Hyperdrive</h2>
          <small id="hyperdrive-monitor-privacy">
            {developerMode
              ? "Developer diagnostics · not persisted"
              : "A simple view of your browsing boost"}
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
          <label className="hyperdrive-primary-control">
            <span>
              <strong>Hyperdrive</strong>
              <small>{enabled ? "On" : "Off"}</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch-input"
              aria-label="Hyperdrive enabled"
              checked={enabled}
              onChange={(event) =>
                void window.chromecraft.setHyperdriveMode(
                  event.target.checked ? "balanced" : "off",
                )
              }
            />
          </label>
          <label className="hyperdrive-sidebar-ram-control">
            <span>
              <strong>RAM limit</strong>
              <output>{formatHyperdriveMemory(snapshot.ramBudgetMb)}</output>
            </span>
            <input
              className="hyperdrive-ram-slider"
              type="range"
              min={64}
              max={sliderMaximum}
              step={64}
              value={snapshot.ramBudgetMb}
              disabled={!enabled}
              aria-label="Hyperdrive RAM limit"
              aria-valuetext={formatHyperdriveMemory(snapshot.ramBudgetMb)}
              onChange={(event) =>
                void window.chromecraft.setHyperdriveRamBudgetMb(
                  Number(event.target.value),
                )
              }
            />
            <span className="hyperdrive-ram-scale" aria-hidden="true">
              <span>64 MB</span>
              <span>{formatHyperdriveMemory(sliderMaximum)}</span>
            </span>
          </label>
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
            {developerMode && (
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
                    snapshot.paused
                      ? "Resume live logging"
                      : "Pause live logging"
                  }
                  aria-pressed={snapshot.paused}
                  title={
                    snapshot.paused
                      ? "Resume live logging"
                      : "Pause live logging"
                  }
                >
                  <Icon name={snapshot.paused ? "play" : "pause"} />
                </button>
                <button
                  type="button"
                  className="monitor-icon-button"
                  onClick={() =>
                    void window.chromecraft.clearHyperdriveEvents()
                  }
                  aria-label="Clear Hyperdrive event history"
                  title="Clear event history"
                >
                  <Icon name="delete" />
                </button>
              </span>
            )}
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

        {!developerMode && (
          <>
            <section className="hyperdrive-monitor-section">
              <div className="hyperdrive-section-heading">
                <h3>This session</h3>
                <span>Easy-to-read results</span>
              </div>
              <div className="hyperdrive-insights-grid">
                <div className="hyperdrive-insight">
                  <strong>{snapshot.metrics.successfulPredictions}</strong>
                  <span>Correct predictions</span>
                  <small>Guesses that matched your next page</small>
                </div>
                <div className="hyperdrive-insight">
                  <strong>{snapshot.metrics.cacheReuseSuccesses}</strong>
                  <span>Cache wins</span>
                  <small>Navigations that reused prepared data</small>
                </div>
                <div className="hyperdrive-insight">
                  <strong>{snapshot.metrics.preparedDestinations}</strong>
                  <span>Ready right now</span>
                  <small>Likely destinations already prepared</small>
                </div>
                <div className="hyperdrive-insight">
                  <strong>
                    {snapshot.metrics.navigationTimeSavedMs === null
                      ? "Learning"
                      : formatDuration(snapshot.metrics.navigationTimeSavedMs)}
                  </strong>
                  <span>Proven time saved</span>
                  <small>Only counted when Chromecraft can measure it</small>
                </div>
              </div>
            </section>

            <section className="hyperdrive-monitor-section hyperdrive-simple-summary">
              <div className="hyperdrive-section-heading">
                <h3>What Hyperdrive is doing</h3>
              </div>
              <ul>
                <li>
                  <Icon name="bolt" />
                  <span>
                    <strong>
                      {snapshot.status === "off"
                        ? "Waiting for you to turn it on"
                        : snapshot.status === "memory-pressure"
                          ? "Pausing to protect system memory"
                          : snapshot.metrics.activePreloads > 0
                            ? `Preparing ${snapshot.metrics.activePreloads} likely ${snapshot.metrics.activePreloads === 1 ? "page" : "pages"}`
                            : "Ready for your next click"}
                    </strong>
                    <small>It works quietly while you browse.</small>
                  </span>
                </li>
                <li>
                  <Icon name="shield" />
                  <span>
                    <strong>Learning stays on this device</strong>
                    <small>Your prediction history is not sent away.</small>
                  </span>
                </li>
                <li>
                  <Icon name="memory" />
                  <span>
                    <strong>
                      Using about {estimatedUsageMb.toFixed(1)} MB of your{" "}
                      {formatHyperdriveMemory(snapshot.ramBudgetMb)} limit
                    </strong>
                    <small>Low-value work is cleared before the limit.</small>
                  </span>
                </li>
              </ul>
              <p>
                Want the technical feed? Turn on Hyperdrive Dev mode in
                Settings.
              </p>
            </section>
          </>
        )}

        {developerMode && (
          <>
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
                  <dd>
                    {formatBytes(snapshot.metrics.processPrivateMemoryBytes)}
                  </dd>
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
                  <span className="visually-hidden">
                    Filter preparation state
                  </span>
                  <select
                    value={filter}
                    onChange={(event) =>
                      setFilter(
                        event.target.value as
                          | "all"
                          | HyperdrivePreparationState,
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
                  {snapshot.paused
                    ? "Paused"
                    : `${snapshot.events.length} events`}
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
              onClick={() =>
                void window.chromecraft.clearHyperdriveSpeculation()
              }
              disabled={snapshot.mode === "off"}
            >
              Clear speculative work
            </button>
          </>
        )}
      </div>
    </aside>
  );
});

function UpdatesPage({
  snapshot,
  close,
}: {
  snapshot: UpdateSnapshot;
  close: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [versionInfoOpen, setVersionInfoOpen] = useState(false);
  const busy =
    snapshot.status === "checking" || snapshot.status === "downloading";
  const visibleResults = snapshot.results.filter(
    (result) => result.state !== "up-to-date",
  );
  const statusTitle: Record<UpdateSnapshot["status"], string> = {
    idle: "Ready to check",
    checking: "Checking every shipped part",
    downloading: "Downloading the verified release",
    ready: "Update ready",
    complete: "Updates installed",
    partial: "Available updates checked",
    "up-to-date": "Everything is up to date",
    unavailable: "Updates unavailable here",
    error: "Update check failed",
  };
  const check = async () => {
    setActionError(null);
    try {
      await window.chromecraft.checkForUpdates();
    } catch {
      setActionError("ChromeCraft could not start the update check.");
    }
  };
  const restart = async () => {
    setActionError(null);
    try {
      await window.chromecraft.restartToUpdate();
    } catch {
      setActionError("ChromeCraft could not restart to apply the update.");
    }
  };

  return (
    <main className="updates-page" aria-labelledby="updates-title">
      <div className="updates-page-content">
        <header className="updates-page-header">
          <button
            type="button"
            className="updates-back-button"
            onClick={close}
            aria-label="Back to browsing"
            title="Back to browsing"
          >
            <Icon name="back" />
          </button>
          <span>
            <small>ChromeCraft system</small>
            <h1 id="updates-title">Updates and versions</h1>
          </span>
        </header>

        <section
          className="update-status-card"
          data-status={snapshot.status}
          aria-live="polite"
          aria-busy={busy}
        >
          <span className="update-status-icon" aria-hidden="true">
            <Icon
              name={
                snapshot.status === "error" || snapshot.status === "unavailable"
                  ? "warning"
                  : snapshot.status === "ready" ||
                      snapshot.status === "complete" ||
                      snapshot.status === "up-to-date"
                    ? "shield"
                    : "reload"
              }
            />
          </span>
          <span className="update-status-copy">
            <strong>{statusTitle[snapshot.status]}</strong>
            <small>
              {snapshot.message ??
                "Check the complete packaged browser, including its engine and dependencies."}
            </small>
          </span>
          {busy && snapshot.progress && (
            <span className="update-progress-wrap">
              <progress
                className="update-progress-track"
                max={100}
                {...(snapshot.progress.percent === null
                  ? {}
                  : { value: snapshot.progress.percent })}
                aria-label={snapshot.progress.label}
              />
              <small>
                {snapshot.progress.percent === null
                  ? snapshot.progress.label
                  : `${snapshot.progress.label} · ${Math.round(snapshot.progress.percent)}%`}
              </small>
            </span>
          )}
        </section>

        {visibleResults.length > 0 && (
          <section
            className="ready-updates"
            aria-labelledby="ready-updates-title"
          >
            <div className="updates-section-heading">
              <span>
                <small>Check results</small>
                <h2 id="ready-updates-title">Updates</h2>
              </span>
            </div>
            {visibleResults.map((update) => (
              <article className="ready-update-card" key={update.id}>
                <div className="ready-update-title">
                  <span className="update-package-icon" aria-hidden="true">
                    C
                  </span>
                  <span>
                    <strong>{update.label}</strong>
                    <small>
                      {update.fromVersion}
                      {update.toVersion ? ` → ${update.toVersion}` : ""}
                    </small>
                  </span>
                </div>
                <div className="update-result-detail">
                  <span
                    className="update-result-badge"
                    data-result={update.state}
                  >
                    {
                      {
                        installed: "Installed",
                        ready: "Ready to restart",
                        "up-to-date": "Up to date",
                        unavailable: "Not available",
                        "approval-required": "Needs review",
                        failed: "Couldn't update",
                      }[update.state]
                    }
                  </span>
                  {update.detail ? (
                    <small>{update.detail}</small>
                  ) : (
                    <ul>
                      {update.includes.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            ))}
          </section>
        )}

        <section className="installed-versions">
          <button
            type="button"
            className="tonal-button version-info-toggle"
            aria-expanded={versionInfoOpen}
            aria-controls="version-info"
            onClick={() => setVersionInfoOpen((open) => !open)}
          >
            Version info
            <Icon name={versionInfoOpen ? "chevronUp" : "chevronDown"} />
          </button>
          {versionInfoOpen && (
            <div
              className="version-grid"
              id="version-info"
              aria-label="Currently installed versions"
            >
              {snapshot.installedVersions.map((item) => (
                <article className="version-card" key={item.id}>
                  <span>{item.label}</span>
                  <strong>{item.version}</strong>
                </article>
              ))}
            </div>
          )}
        </section>

        {actionError && (
          <p className="update-action-error" role="alert">
            {actionError}
          </p>
        )}
        <footer className="updates-actions">
          <button
            type="button"
            className="tonal-button"
            onClick={() => void check()}
            disabled={!snapshot.canCheck}
          >
            {snapshot.status === "checking"
              ? "Checking…"
              : snapshot.status === "downloading"
                ? "Downloading…"
                : "Check for updates"}
          </button>
          {snapshot.canRestart && (
            <button
              type="button"
              className="filled-button restart-update-button"
              onClick={() => void restart()}
            >
              Restart ChromeCraft
            </button>
          )}
        </footer>
        <p className="updates-footnote">
          Extension updates are verified and installed in your local profile.
          Application updates replace the complete signed runtime when this
          build supports it. Your tabs, history, bookmarks, settings, and
          extensions stay in place.
          {snapshot.checkedAt
            ? ` Last checked ${new Date(snapshot.checkedAt).toLocaleString()}.`
            : ""}
        </p>
      </div>
    </main>
  );
}

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
      <button
        type="button"
        className="new-tab-offline-pages"
        onClick={() => void window.chromecraft.openOfflinePages()}
      >
        <Icon name="download" />
        Offline Pages
      </button>
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
  const [youtubeDownloads, setYouTubeDownloads] = useState(
    emptyYouTubeDownloads,
  );
  const [gallery, setGallery] = useState(emptyGallery);
  const [offlinePages, setOfflinePages] = useState(emptyOfflinePages);
  const [smartDownloads, setSmartDownloads] = useState(emptySmartDownloads);
  const [websiteControls, setWebsiteControls] = useState(emptyWebsiteControls);
  const [activeSiteControl, setActiveSiteControl] =
    useState<WebsiteControlSnapshot | null>(null);
  const [siteControlsOpen, setSiteControlsOpen] = useState(false);
  const [openSmartDownloadsRequest, setOpenSmartDownloadsRequest] = useState(0);
  const [openSitePermissionsRequest, setOpenSitePermissionsRequest] =
    useState(0);
  const [openAiSettingsRequest, setOpenAiSettingsRequest] = useState(0);
  const [extensions, setExtensions] = useState(emptyExtensions);
  const [updates, setUpdates] = useState<UpdateSnapshot | null>(null);
  const [aiTools, setAiTools] = useState<AiToolsSnapshot>(emptyAiTools);
  const [aiContextStatus, setAiContextStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiProposal, setAiProposal] = useState<OrganiseTabsProposal | null>(
    null,
  );
  const [tool, setTool] = useState<SidebarTool | null>(null);
  const [fullSettingsTabId, setFullSettingsTabId] = useState<string | null>(
    null,
  );
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [extensionsPageOpen, setExtensionsPageOpen] = useState(false);
  const [extensionsMenuOpen, setExtensionsMenuOpen] = useState(false);
  const [tabHoverCardOpen, setTabHoverCardOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [omniboxExpanded, setOmniboxExpanded] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [youtubeProgressExpanded, setYouTubeProgressExpanded] = useState(false);
  const [dialog, setDialog] = useState<BrowserDialogState | null>(null);
  const receivedDownloadEvent = useRef(false);
  const latestSnapshot = useRef<BrowserSnapshot | null>(null);
  const latestFullSettingsTabId = useRef<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    tab: BrowserTabSnapshot;
  } | null>(null);
  useEffect(() => {
    const openScout = () => {
      setTool("assistant");
      void window.chromecraft.setSidebarOpen(true);
    };
    addEventListener("chromecraft-open-scout", openScout);
    return () => removeEventListener("chromecraft-open-scout", openScout);
  }, []);
  useEffect(() => {
    let mounted = true;
    void window.chromecraft
      .getWebsiteControls()
      .then((controls) => {
        if (mounted) setWebsiteControls(controls);
      })
      .catch(() => undefined);
    void Promise.all([
      window.chromecraft.getSnapshot(),
      window.chromecraft.getBrowserData(),
      window.chromecraft.getDownloads(),
      window.chromecraft.getHyperdriveSnapshot(),
      window.chromecraft.getExtensions(),
      window.chromecraft.getUpdateSnapshot(),
      window.chromecraft.getYouTubeDownloads(),
      window.chromecraft.getGallery(),
      window.chromecraft.getOfflinePages(),
      window.chromecraft.getSmartDownloads(),
      window.chromecraft.getAiTools(),
    ]).then(
      ([
        nextSnapshot,
        nextData,
        nextDownloads,
        nextHyperdrive,
        nextExtensions,
        nextUpdates,
        nextYouTubeDownloads,
        nextGallery,
        nextOfflinePages,
        nextSmartDownloads,
        nextAiTools,
      ]) => {
        if (mounted) {
          latestSnapshot.current = nextSnapshot;
          setSnapshot(nextSnapshot);
          setTool(nextSnapshot.preferences.sidebarOpen ? "bookmarks" : null);
          setData(nextData);
          if (!receivedDownloadEvent.current) setDownloads(nextDownloads);
          setHyperdrive(nextHyperdrive);
          setExtensions(nextExtensions);
          setUpdates(nextUpdates);
          setYouTubeDownloads(nextYouTubeDownloads);
          setGallery(nextGallery);
          setOfflinePages(nextOfflinePages);
          setSmartDownloads(nextSmartDownloads);
          setAiTools(nextAiTools);
        }
      },
    );
    const cleanups = [
      window.chromecraft.onSnapshot((nextSnapshot) => {
        latestSnapshot.current = nextSnapshot;
        setSnapshot(nextSnapshot);
      }),
      window.chromecraft.onBrowserData(setData),
      window.chromecraft.onDownloads((nextDownloads) => {
        receivedDownloadEvent.current = true;
        setDownloads(nextDownloads);
      }),
      window.chromecraft.onHyperdriveSnapshot(setHyperdrive),
      window.chromecraft.onExtensions(setExtensions),
      window.chromecraft.onUpdateSnapshot(setUpdates),
      window.chromecraft.onYouTubeDownloads(setYouTubeDownloads),
      window.chromecraft.onGallery(setGallery),
      window.chromecraft.onOfflinePages(setOfflinePages),
      window.chromecraft.onSmartDownloads(setSmartDownloads),
      window.chromecraft.onWebsiteControls(setWebsiteControls),
      window.chromecraft.onAiTools(setAiTools),
      window.chromecraft.onShowSmartDownloadsSettings(() => {
        void (async () => {
          const currentSettingsId = latestFullSettingsTabId.current;
          const existingTab = currentSettingsId
            ? latestSnapshot.current?.tabs.find(
                (tab) => tab.id === currentSettingsId,
              )
            : null;
          if (existingTab) await window.chromecraft.activateTab(existingTab.id);
          else {
            const created = await window.chromecraft.createTab();
            latestFullSettingsTabId.current = created;
            setFullSettingsTabId(created);
          }
          setOpenSmartDownloadsRequest((value) => value + 1);
          setTool(null);
          await window.chromecraft.setSidebarOpen(false);
        })();
      }),
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
  useEffect(() => {
    setSiteControlsOpen(false);
  }, [activeTab?.id, activeTab?.url]);
  useEffect(() => {
    let current = true;
    if (!activeTab || !/^https?:\/\//u.test(activeTab.url)) {
      setActiveSiteControl(null);
      return () => {
        current = false;
      };
    }
    void window.chromecraft
      .getWebsiteControl(activeTab.url)
      .then((site) => {
        if (current) setActiveSiteControl(site);
      })
      .catch(() => {
        if (current) setActiveSiteControl(null);
      });
    return () => {
      current = false;
    };
  }, [activeTab?.id, activeTab?.url, websiteControls]);
  useEffect(() => {
    latestSnapshot.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    latestFullSettingsTabId.current = fullSettingsTabId;
  }, [fullSettingsTabId]);
  useEffect(() => {
    if (
      fullSettingsTabId &&
      snapshot &&
      !snapshot.tabs.some((tab) => tab.id === fullSettingsTabId)
    ) {
      setFullSettingsTabId(null);
    }
  }, [fullSettingsTabId, snapshot]);
  useEffect(() => setFindOpen(false), [activeTab?.id]);
  useEffect(() => {
    const open = Boolean(
      omniboxExpanded ||
      findOpen ||
      paletteOpen ||
      youtubeProgressExpanded ||
      brandMenuOpen ||
      updatesOpen ||
      aiPanelOpen ||
      extensionsPageOpen ||
      extensionsMenuOpen ||
      tabHoverCardOpen ||
      siteControlsOpen ||
      tabMenu ||
      dialog,
    );
    void window.chromecraft.setChromeOverlayOpen(open);
    return () => {
      if (open) void window.chromecraft.setChromeOverlayOpen(false);
    };
  }, [
    brandMenuOpen,
    aiPanelOpen,
    dialog,
    extensionsPageOpen,
    extensionsMenuOpen,
    findOpen,
    omniboxExpanded,
    paletteOpen,
    youtubeProgressExpanded,
    tabHoverCardOpen,
    siteControlsOpen,
    tabMenu,
    tool,
    updatesOpen,
  ]);
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
        setExtensionsPageOpen(false);
        setExtensionsMenuOpen(false);
        setUpdatesOpen(false);
        setAiPanelOpen(false);
        setPaletteOpen(false);
        setSiteControlsOpen(false);
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
  if (!snapshot || !activeTab || !hyperdrive || !updates)
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
  const youtubeWatch = snapshot.youtubeWatch;
  const youtubeDownload = youtubeWatch
    ? (youtubeDownloads.items.find(
        (item) => item.videoId === youtubeWatch.videoId,
      ) ?? null)
    : null;
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
  const openFullSettings = () => {
    void (async () => {
      const existingTab = fullSettingsTabId
        ? snapshot.tabs.find((tab) => tab.id === fullSettingsTabId)
        : null;
      if (existingTab) {
        await window.chromecraft.activateTab(existingTab.id);
      } else {
        const created = await window.chromecraft.createTab();
        latestFullSettingsTabId.current = created;
        setFullSettingsTabId(created);
      }
      setTool(null);
      await window.chromecraft.setSidebarOpen(false);
    })();
  };
  const openSmartDownloadsSettings = () => {
    void (async () => {
      const existingTab = fullSettingsTabId
        ? snapshot.tabs.find((tab) => tab.id === fullSettingsTabId)
        : null;
      if (existingTab) {
        await window.chromecraft.activateTab(existingTab.id);
      } else {
        const created = await window.chromecraft.createTab();
        latestFullSettingsTabId.current = created;
        setFullSettingsTabId(created);
      }
      setOpenSmartDownloadsRequest((value) => value + 1);
      setTool(null);
      await window.chromecraft.setSidebarOpen(false);
    })();
  };
  const openWebsitePermissions = () => {
    setSiteControlsOpen(false);
    void (async () => {
      const existingTab = fullSettingsTabId
        ? snapshot.tabs.find((tab) => tab.id === fullSettingsTabId)
        : null;
      if (existingTab) {
        await window.chromecraft.activateTab(existingTab.id);
      } else {
        const created = await window.chromecraft.createTab();
        latestFullSettingsTabId.current = created;
        setFullSettingsTabId(created);
      }
      setOpenSitePermissionsRequest((value) => value + 1);
      setTool(null);
      await window.chromecraft.setSidebarOpen(false);
    })();
  };
  const openAiSettings = () => {
    setAiPanelOpen(false);
    void (async () => {
      const existingTab = fullSettingsTabId
        ? snapshot.tabs.find((tab) => tab.id === fullSettingsTabId)
        : null;
      if (existingTab) {
        await window.chromecraft.activateTab(existingTab.id);
      } else {
        const created = await window.chromecraft.createTab();
        latestFullSettingsTabId.current = created;
        setFullSettingsTabId(created);
      }
      setOpenAiSettingsRequest((value) => value + 1);
      setTool(null);
      await window.chromecraft.setSidebarOpen(false);
    })();
  };
  const refreshOrganiserContext = () => {
    setAiContextStatus("loading");
    void window.chromecraft
      .getAiTools()
      .then((nextAiTools) => {
        setAiTools(nextAiTools);
        setAiContextStatus("ready");
        const providerState =
          nextAiTools.provider === "ollama"
            ? nextAiTools.ollama
            : nextAiTools.gemini;
        const canRefreshProvider =
          nextAiTools.provider === "ollama" ||
          nextAiTools.gemini.apiKeyConfigured;
        if (
          canRefreshProvider &&
          (providerState.connection === "unknown" ||
            providerState.models.length === 0)
        ) {
          void window.chromecraft
            .refreshAiModels(nextAiTools.provider)
            .then(setAiTools)
            .catch(() => undefined);
        }
      })
      .catch(() => setAiContextStatus("error"));
  };
  const openOrganiseTabs = () => {
    setUpdatesOpen(false);
    setExtensionsPageOpen(false);
    setAiPanelOpen(true);
    setBrandMenuOpen(false);
    setAiProposal(null);
    refreshOrganiserContext();
  };
  const requestAiTabPlan = async (request: OrganiseTabsRequest) => {
    setAiProposal(null);
    try {
      const proposal = await window.chromecraft.previewAiTool(request);
      setAiProposal(proposal);
    } catch {
      // The controller publishes a specific failure state for the panel.
    }
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
        setExtensionsMenuOpen(false);
        setSiteControlsOpen(false);
        setTabMenu(null);
      }}
    >
      <header className="browser-chrome">
        <TabStrip
          snapshot={snapshot}
          data={data}
          settingsTabId={fullSettingsTabId}
          aiTools={aiTools}
          brandMenuOpen={brandMenuOpen}
          onToggleBrandMenu={() => {
            setExtensionsMenuOpen(false);
            setBrandMenuOpen((open) => !open);
          }}
          onHoverCardOpenChange={setTabHoverCardOpen}
          onSetSidebarAttached={(attached) => {
            void window.chromecraft.setSidebarAttached(attached);
            setBrandMenuOpen(false);
          }}
          onOpenUpdates={() => {
            setAiPanelOpen(false);
            setExtensionsPageOpen(false);
            setUpdatesOpen(true);
            setBrandMenuOpen(false);
          }}
          onOpenOrganiseTabs={openOrganiseTabs}
          onMenu={(event, tab) => {
            event.preventDefault();
            event.stopPropagation();
            setTabMenu({
              x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
              y: Math.max(
                48,
                Math.min(event.clientY, window.innerHeight - 360),
              ),
              tab,
            });
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
          extensionsMenuOpen={extensionsMenuOpen}
          onToggleExtensionsMenu={() => {
            setBrandMenuOpen(false);
            setExtensionsMenuOpen((open) => !open);
          }}
          onManageExtensions={() => {
            setExtensionsMenuOpen(false);
            setUpdatesOpen(false);
            setExtensionsPageOpen(true);
          }}
          onToggleExtensionPopup={(extension, rect) => {
            setExtensionsMenuOpen(false);
            void window.chromecraft.toggleExtensionPopup(extension.id, {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            });
          }}
          siteControl={activeSiteControl}
          siteControlsOpen={siteControlsOpen}
          onToggleSiteControls={() => setSiteControlsOpen((open) => !open)}
          onManageSiteSettings={openWebsitePermissions}
          onOmniboxExpandedChange={setOmniboxExpanded}
        />
        {snapshot.preferences.showDownloadProgressInToolbar && (
          <YouTubeDownloadProgress
            snapshot={youtubeDownloads}
            onCancel={(id) => void window.chromecraft.cancelYouTubeDownload(id)}
            onRetry={(id) => void window.chromecraft.retryYouTubeDownload(id)}
            onOpenGallery={() => void window.chromecraft.openGallery()}
            onOpenFile={(id) => void window.chromecraft.openYouTubeDownload(id)}
            onDismiss={(id) =>
              void window.chromecraft.dismissYouTubeDownload(id)
            }
            onExpandedChange={setYouTubeProgressExpanded}
          />
        )}
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
                      setUpdatesOpen(false);
                      setExtensionsPageOpen(true);
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
        {youtubeWatch && (
          <YouTubeDownloadBanner
            available={youtubeDownloads.available}
            download={youtubeDownload}
            onDownload={() => {
              void window.chromecraft.downloadActiveYouTubeVideo(activeTab.id);
            }}
            onDismiss={() => {
              void window.chromecraft.dismissYouTubeDownloadBanner(
                activeTab.id,
                youtubeWatch.videoId,
              );
            }}
          />
        )}
        {findOpen && <FindBar tabId={activeTab.id} onClose={closeFind} />}
      </header>
      <Sidebar
        snapshot={snapshot}
        data={data}
        downloads={downloads}
        youtubeDownloads={youtubeDownloads}
        extensions={extensions}
        gallery={gallery}
        tool={tool}
        setTool={setTool}
        openExtensionsPage={() => {
          setUpdatesOpen(false);
          setExtensionsPageOpen(true);
        }}
        openFullSettings={openFullSettings}
        activeTab={activeTab}
        aiTools={aiTools}
        openOrganiseTabs={openOrganiseTabs}
        openScoutSettings={openAiSettings}
        requestClearHistory={(range) => {
          if (range === "all") {
            setDialog({ kind: "clear-history" });
          } else {
            void window.chromecraft.clearHistory(range);
          }
        }}
      />
      {activeTab.url.startsWith("chromecraft://offline-pages/") ? (
        <OfflinePagesPage
          snapshot={offlinePages}
          selectedId={new URL(activeTab.url).searchParams.get("page")}
        />
      ) : activeTab.url.startsWith("chromecraft://gallery/") ? (
        <GalleryPage
          snapshot={gallery}
          selectedId={new URL(activeTab.url).searchParams.get("video")}
          onOpenSmartDownloads={openSmartDownloadsSettings}
          smartDownloads={smartDownloads}
        />
      ) : activeTab.id === fullSettingsTabId ? (
        <FullSettingsPage
          snapshot={snapshot}
          hyperdrive={hyperdrive}
          aiTools={aiTools}
          websiteControls={websiteControls}
          smartDownloads={smartDownloads}
          openSmartDownloadsRequest={openSmartDownloadsRequest}
          openSitePermissionsRequest={openSitePermissionsRequest}
          openAiSettingsRequest={openAiSettingsRequest}
          openExtensionsPage={() => {
            setUpdatesOpen(false);
            setExtensionsPageOpen(true);
          }}
        />
      ) : (
        <NewTabSurface tab={activeTab} snapshot={snapshot} data={data} />
      )}
      {updatesOpen && (
        <UpdatesPage snapshot={updates} close={() => setUpdatesOpen(false)} />
      )}
      {aiPanelOpen && (
        <OrganiseTabsPanel
          snapshot={aiTools}
          proposal={aiProposal}
          contextStatus={aiContextStatus}
          refreshContext={refreshOrganiserContext}
          close={() => setAiPanelOpen(false)}
          organise={(request) => void requestAiTabPlan(request)}
          refreshModels={(provider) => {
            void window.chromecraft
              .refreshAiModels(provider)
              .then(setAiTools)
              .catch(() => undefined);
          }}
          installRecommendedModel={() => {
            void window.chromecraft
              .installRecommendedOllamaModel()
              .then(setAiTools)
              .catch(() => undefined);
          }}
          selectProvider={(provider) => {
            void window.chromecraft
              .setAiOrganiserProvider(provider)
              .then((nextAiTools) => {
                setAiTools(nextAiTools);
                const providerState =
                  provider === "ollama"
                    ? nextAiTools.ollama
                    : nextAiTools.gemini;
                const canRefreshProvider =
                  provider === "ollama" || nextAiTools.gemini.apiKeyConfigured;
                if (
                  canRefreshProvider &&
                  (providerState.connection === "unknown" ||
                    providerState.models.length === 0)
                ) {
                  void window.chromecraft
                    .refreshAiModels(provider)
                    .then(setAiTools)
                    .catch(() => undefined);
                }
              })
              .catch(() => undefined);
          }}
          selectGroupingMode={(mode) => {
            void window.chromecraft
              .setAiGroupingMode(mode)
              .then(setAiTools)
              .catch(() => undefined);
          }}
          selectModel={(provider, model) => {
            void window.chromecraft
              .setAiOrganiserModel(provider, model)
              .then(setAiTools)
              .catch(() => undefined);
          }}
          apply={(proposal) => {
            void window.chromecraft
              .applyAiTool(proposal)
              .catch(() => undefined);
          }}
          cancel={() => window.chromecraft.cancelAiTool()}
          undo={() => {
            void window.chromecraft.undoAiTool().catch(() => undefined);
          }}
          openAiSettings={openAiSettings}
        />
      )}
      {extensionsPageOpen && (
        <ExtensionsPage
          snapshot={extensions}
          developerMode={snapshot.preferences.extensionDeveloperMode}
          close={() => setExtensionsPageOpen(false)}
          requestInstall={(itemUrl) => void reviewExtensionInstall(itemUrl)}
          requestRemove={(id, name) =>
            setDialog({ kind: "remove-extension", id, name })
          }
        />
      )}
      {snapshot.preferences.hyperdriveMonitorOpen && (
        <HyperdriveMonitor
          snapshot={hyperdrive}
          developerMode={snapshot.preferences.hyperdriveDeveloperMode}
        />
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
            onClick={() => {
              const selected = getSelectedTabIds(snapshot).includes(
                tabMenu.tab.id,
              );
              void tabOrganizationApi().selectTabs?.(
                [tabMenu.tab.id],
                selected ? "toggle" : "add",
              );
              setTabMenu(null);
            }}
          >
            {getSelectedTabIds(snapshot).includes(tabMenu.tab.id)
              ? "Remove from selection"
              : "Select tab"}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const selected = getSelectedTabIds(snapshot);
              const tabIds = selected.includes(tabMenu.tab.id)
                ? selected
                : [tabMenu.tab.id];
              void tabOrganizationApi().createTabGroup?.(
                tabIds,
                `Group ${getTabGroups(snapshot).length + 1}`,
                "blue",
              );
              setTabMenu(null);
            }}
          >
            {getSelectedTabIds(snapshot).length > 1 &&
            getSelectedTabIds(snapshot).includes(tabMenu.tab.id)
              ? "Group selected tabs"
              : "Add tab to new group"}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const selected = getSelectedTabIds(snapshot);
              const tabIds = selected.includes(tabMenu.tab.id)
                ? selected
                : [tabMenu.tab.id];
              const pinned =
                (tabMenu.tab as OrganisedTabSnapshot).pinned === true;
              void tabOrganizationApi().setTabsPinned?.(tabIds, !pinned);
              setTabMenu(null);
            }}
          >
            {(tabMenu.tab as OrganisedTabSnapshot).pinned ? "Unpin" : "Pin"}
            {getSelectedTabIds(snapshot).length > 1 &&
            getSelectedTabIds(snapshot).includes(tabMenu.tab.id)
              ? " selected tabs"
              : " tab"}
          </button>
          <div className="tab-menu-divider" role="separator" />
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
