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

export interface InstalledVersionSnapshot {
  id: "chromecraft" | "electron" | "chromium" | "node";
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
}

export interface UpdateProgressSnapshot {
  label: string;
  receivedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
}

export interface UpdateSnapshot {
  status: UpdateStatus;
  installedVersions: InstalledVersionSnapshot[];
  results: UpdateResultSnapshot[];
  progress: UpdateProgressSnapshot | null;
  checkedAt: number | null;
  message: string | null;
  canCheck: boolean;
  canRestart: boolean;
}
