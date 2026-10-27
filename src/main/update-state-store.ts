import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  defaultUpdatePreferences,
  type ExtensionUpdateState,
  type UpdateHistoryEntry,
  type UpdatePreferences,
} from "../shared/updates";

const maximumHistoryEntries = 100;
const maximumExtensionStatuses = 500;
const maximumStateBytes = 1_048_576;
const extensionIdPattern = /^[a-p]{32}$/;

export interface PersistentExtensionUpdateStatus {
  id: string;
  installedVersion: string;
  availableVersion: string | null;
  provider: "chrome-web-store" | "unpacked";
  state: Exclude<ExtensionUpdateState, "checking">;
  detail: string | null;
  lastCheckedAt: number | null;
}

export interface PersistentUpdateState {
  preferences: UpdatePreferences;
  history: UpdateHistoryEntry[];
  lastAutomaticCheckAt: number | null;
  extensionStatuses: PersistentExtensionUpdateStatus[];
}

interface StoredUpdateState extends PersistentUpdateState {
  version: 1;
}

export class UpdateStateStore {
  private value: PersistentUpdateState = emptyState();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistentUpdateState> {
    try {
      const metadata = await fs.stat(this.filePath);
      if (metadata.size > maximumStateBytes) {
        throw new Error("The update state file exceeds the supported size.");
      }
      const parsed = JSON.parse(
        await fs.readFile(this.filePath, "utf8"),
      ) as Partial<StoredUpdateState>;
      if (parsed.version !== 1) {
        throw new Error("The update state file uses an unsupported schema.");
      }
      this.value = normalizeState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "Could not read the update state; defaults will be used.",
          error,
        );
      }
      this.value = emptyState();
    }
    return this.snapshot;
  }

  get snapshot(): PersistentUpdateState {
    return structuredClone(this.value);
  }

  async save(next: PersistentUpdateState): Promise<void> {
    const normalized = normalizeState({ version: 1, ...next });
    const operation = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      const stored: StoredUpdateState = { version: 1, ...normalized };
      try {
        await fs.writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await fs.rename(temporary, this.filePath);
        this.value = normalized;
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }
}

function emptyState(): PersistentUpdateState {
  return {
    preferences: { ...defaultUpdatePreferences },
    history: [],
    lastAutomaticCheckAt: null,
    extensionStatuses: [],
  };
}

function normalizeState(
  value: Partial<StoredUpdateState>,
): PersistentUpdateState {
  const preferences = value.preferences;
  return {
    preferences: {
      automaticChecksEnabled:
        typeof preferences?.automaticChecksEnabled === "boolean"
          ? preferences.automaticChecksEnabled
          : defaultUpdatePreferences.automaticChecksEnabled,
      automaticExtensionUpdatesEnabled:
        typeof preferences?.automaticExtensionUpdatesEnabled === "boolean"
          ? preferences.automaticExtensionUpdatesEnabled
          : defaultUpdatePreferences.automaticExtensionUpdatesEnabled,
      notifyWhenReady:
        typeof preferences?.notifyWhenReady === "boolean"
          ? preferences.notifyWhenReady
          : defaultUpdatePreferences.notifyWhenReady,
    },
    history: Array.isArray(value.history)
      ? value.history.filter(isHistoryEntry).slice(0, maximumHistoryEntries)
      : [],
    lastAutomaticCheckAt:
      typeof value.lastAutomaticCheckAt === "number" &&
      Number.isFinite(value.lastAutomaticCheckAt) &&
      value.lastAutomaticCheckAt >= 0
        ? value.lastAutomaticCheckAt
        : null,
    extensionStatuses: normalizeExtensionStatuses(value.extensionStatuses),
  };
}

function normalizeExtensionStatuses(
  value: unknown,
): PersistentExtensionUpdateStatus[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, PersistentExtensionUpdateStatus>();
  for (const entry of value) {
    if (!isExtensionStatus(entry) || byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
    if (byId.size >= maximumExtensionStatuses) break;
  }
  return [...byId.values()];
}

function isExtensionStatus(
  value: unknown,
): value is PersistentExtensionUpdateStatus {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PersistentExtensionUpdateStatus>;
  return (
    typeof entry.id === "string" &&
    extensionIdPattern.test(entry.id) &&
    isExtensionVersion(entry.installedVersion) &&
    (entry.availableVersion === null ||
      isExtensionVersion(entry.availableVersion)) &&
    (entry.provider === "chrome-web-store" || entry.provider === "unpacked") &&
    [
      "unknown",
      "up-to-date",
      "installed",
      "manual-required",
      "approval-required",
      "failed",
    ].includes(entry.state ?? "") &&
    (entry.detail === null ||
      (typeof entry.detail === "string" && entry.detail.length <= 500)) &&
    (entry.lastCheckedAt === null ||
      (typeof entry.lastCheckedAt === "number" &&
        Number.isFinite(entry.lastCheckedAt) &&
        entry.lastCheckedAt >= 0))
  );
}

function isExtensionVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^\d+(?:\.\d+){0,3}$/u.test(value)
  );
}

function isHistoryEntry(value: unknown): value is UpdateHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<UpdateHistoryEntry>;
  return (
    typeof entry.id === "string" &&
    entry.id.length <= 100 &&
    ["extensions", "dependencies", "chromecraft"].includes(
      entry.category ?? "",
    ) &&
    typeof entry.label === "string" &&
    entry.label.length <= 200 &&
    typeof entry.fromVersion === "string" &&
    entry.fromVersion.length <= 80 &&
    (entry.toVersion === null ||
      (typeof entry.toVersion === "string" && entry.toVersion.length <= 80)) &&
    ["installed", "ready", "failed", "approval-required"].includes(
      entry.result ?? "",
    ) &&
    typeof entry.timestamp === "number" &&
    Number.isFinite(entry.timestamp) &&
    (entry.detail === null ||
      (typeof entry.detail === "string" && entry.detail.length <= 500))
  );
}
