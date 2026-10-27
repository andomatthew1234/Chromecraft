export type UpdateStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "complete"
  | "partial"
  | "up-to-date"
  | "unavailable"
  | "error";

export type UpdateCategoryId = "extensions" | "dependencies" | "chromecraft";

export type ApplicationChangeCategory = "chromecraft" | "dependencies" | "both";

export interface InstalledVersionSnapshot {
  id: "chromecraft" | "electron" | "chromium" | "node" | "yt-dlp" | "deno";
  label: string;
  version: string;
}

export type UpdateResultState =
  | "installed"
  | "ready"
  | "up-to-date"
  | "unavailable"
  | "approval-required"
  | "failed";

export interface UpdateResultSnapshot {
  id: string;
  kind: "application" | "extension";
  label: string;
  fromVersion: string;
  toVersion: string | null;
  state: UpdateResultState;
  requiresRestart: boolean;
  includes: string[];
  detail: string | null;
  applicationCategory?: ApplicationChangeCategory;
  releaseNotes?: string | null;
  publishedAt?: string | null;
  downloadSizeBytes?: number | null;
}

export type ExtensionUpdateState =
  | "unknown"
  | "checking"
  | "up-to-date"
  | "installed"
  | "manual-required"
  | "approval-required"
  | "failed";

export interface ExtensionUpdateItemSnapshot {
  id: string;
  name: string;
  iconDataUrl: string | null;
  installedVersion: string;
  availableVersion: string | null;
  enabled: boolean;
  provider: "chrome-web-store" | "unpacked";
  sourceUrl: string | null;
  state: ExtensionUpdateState;
  detail: string | null;
  lastCheckedAt: number | null;
}

export interface UpdateProgressSnapshot {
  label: string;
  receivedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
}

export interface UpdateCategorySnapshot {
  id: UpdateCategoryId;
  status: UpdateStatus;
  installedVersion: string | null;
  availableVersion: string | null;
  updateCount: number;
  lastCheckedAt: number | null;
  restartRequired: boolean;
  detail: string | null;
}

export interface UpdateHistoryEntry {
  id: string;
  category: UpdateCategoryId;
  label: string;
  fromVersion: string;
  toVersion: string | null;
  result: "installed" | "ready" | "failed" | "approval-required";
  timestamp: number;
  detail: string | null;
}

export interface UpdatePreferences {
  automaticChecksEnabled: boolean;
  automaticExtensionUpdatesEnabled: boolean;
  notifyWhenReady: boolean;
}

export interface ApplicationReleaseSnapshot {
  version: string;
  category: ApplicationChangeCategory;
  releaseNotes: string | null;
  publishedAt: string | null;
  downloadSizeBytes: number | null;
}

export interface UpdateSnapshot {
  status: UpdateStatus;
  installedVersions: InstalledVersionSnapshot[];
  results: UpdateResultSnapshot[];
  extensions: ExtensionUpdateItemSnapshot[];
  categories: Record<UpdateCategoryId, UpdateCategorySnapshot>;
  history: UpdateHistoryEntry[];
  preferences: UpdatePreferences;
  applicationRelease: ApplicationReleaseSnapshot | null;
  progress: UpdateProgressSnapshot | null;
  checkedAt: number | null;
  message: string | null;
  canCheck: boolean;
  canRestart: boolean;
}

export const defaultUpdatePreferences: UpdatePreferences = {
  automaticChecksEnabled: true,
  automaticExtensionUpdatesEnabled: true,
  notifyWhenReady: true,
};
