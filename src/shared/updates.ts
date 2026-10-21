export type UpdateStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "unavailable"
  | "error";

export interface InstalledVersionSnapshot {
  id: "chromecraft" | "electron" | "chromium" | "node";
  label: string;
  version: string;
}

export interface ReadyUpdateSnapshot {
  id: "chromecraft-release";
  label: string;
  fromVersion: string;
  toVersion: string;
  includes: string[];
}

export interface UpdateSnapshot {
  status: UpdateStatus;
  installedVersions: InstalledVersionSnapshot[];
  readyUpdates: ReadyUpdateSnapshot[];
  checkedAt: number | null;
  message: string | null;
  canCheck: boolean;
  canRestart: boolean;
}
