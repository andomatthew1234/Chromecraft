export type PerformanceRefreshInterval = 1_000 | 2_000 | 5_000 | null;

export type PerformanceProcessKind =
  | "browser"
  | "renderer"
  | "gpu"
  | "utility"
  | "extension"
  | "other";

export interface PerformanceTabTask {
  id: string;
  title: string;
  hostname: string;
  faviconDataUrl: string | null;
  processId: number;
  active: boolean;
  crashed: boolean;
}

export interface PerformanceProcessInput {
  pid: number;
  creationTime: number;
  type: string;
  name?: string;
  cpuPercent: number | null;
  memoryBytes: number | null;
}

export interface PerformanceTaskChild {
  id: string;
  kind: "tab";
  title: string;
  subtitle: string;
  faviconDataUrl: string | null;
  active: boolean;
  crashed: boolean;
}

export interface PerformanceTaskRow {
  id: string;
  pid: number;
  kind: PerformanceProcessKind;
  taskType: string;
  title: string;
  subtitle: string;
  cpuPercent: number | null;
  memoryBytes: number | null;
  networkBytesPerSecond: number | null;
  javascriptMemoryBytes: number | null;
  status: "running" | "unavailable";
  protected: boolean;
  canEndProcess: boolean;
  affectedTabCount: number;
  children: PerformanceTaskChild[];
}

export interface PerformanceCentreSnapshot {
  sampledAt: number;
  refreshInterval: PerformanceRefreshInterval;
  cpuPercent: number | null;
  memoryBytes: number | null;
  processCount: number;
  systemMemoryBytes: number | null;
  theme: "light" | "dark";
  rows: PerformanceTaskRow[];
  notes: {
    cpu: string;
    memory: string;
  };
}

export type PerformanceAction =
  | { type: "switch-to-tab"; tabId: string }
  | { type: "close-tab"; tabId: string }
  | { type: "reload-tab"; tabId: string }
  | { type: "end-process"; processId: string };

export interface PerformanceActionResult {
  ok: boolean;
  message: string;
}

export interface PerformanceCentreApi {
  getSnapshot(): Promise<PerformanceCentreSnapshot>;
  setRefreshInterval(interval: PerformanceRefreshInterval): Promise<void>;
  performAction(action: PerformanceAction): Promise<PerformanceActionResult>;
  close(): Promise<void>;
  onSnapshot(
    listener: (snapshot: PerformanceCentreSnapshot) => void,
  ): () => void;
}

const PROCESS_LABELS: Record<string, string> = {
  Browser: "Main browser process",
  Tab: "Renderer process",
  GPU: "GPU process",
  Utility: "Utility process",
  Zygote: "Process launcher",
  PepperPlugin: "Plugin process",
  SandboxHelper: "Sandbox helper",
};

function processKind(type: string, name?: string): PerformanceProcessKind {
  if (type === "Browser") return "browser";
  if (type === "Tab") return "renderer";
  if (type === "GPU") return "gpu";
  if (/extension/iu.test(`${type} ${name ?? ""}`)) return "extension";
  if (type === "Utility") return "utility";
  return "other";
}

function safeNumber(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function buildPerformanceRows(
  processes: readonly PerformanceProcessInput[],
  tabs: readonly PerformanceTabTask[],
): PerformanceTaskRow[] {
  const tabsByPid = new Map<number, PerformanceTabTask[]>();
  for (const tab of tabs) {
    if (!Number.isSafeInteger(tab.processId) || tab.processId < 1) continue;
    const list = tabsByPid.get(tab.processId) ?? [];
    list.push(tab);
    tabsByPid.set(tab.processId, list);
  }

  return processes.map((process) => {
    const kind = processKind(process.type, process.name);
    const associatedTabs = tabsByPid.get(process.pid) ?? [];
    const children = associatedTabs.map(
      (tab): PerformanceTaskChild => ({
        id: tab.id,
        kind: "tab",
        title: tab.title || "Untitled tab",
        subtitle: tab.hostname || "Browser tab",
        faviconDataUrl: tab.faviconDataUrl,
        active: tab.active,
        crashed: tab.crashed,
      }),
    );
    const rendererTitle =
      associatedTabs.length === 1
        ? associatedTabs[0]!.title || "Untitled tab"
        : associatedTabs.length > 1
          ? `${associatedTabs.length} shared tabs`
          : (PROCESS_LABELS[process.type] ??
            process.name ??
            `${process.type} process`);
    const title =
      kind === "renderer"
        ? rendererTitle
        : (PROCESS_LABELS[process.type] ??
          process.name ??
          `${process.type} process`);
    const protectedProcess = kind !== "renderer" || associatedTabs.length === 0;

    return {
      id: `process:${process.pid}:${process.creationTime}`,
      pid: process.pid,
      kind,
      taskType: process.type,
      title,
      subtitle:
        associatedTabs.length > 0
          ? associatedTabs
              .map((tab) => tab.hostname)
              .filter(Boolean)
              .join(" · ")
          : `Chromecraft ${process.type.toLowerCase()} infrastructure`,
      cpuPercent: safeNumber(process.cpuPercent),
      memoryBytes: safeNumber(process.memoryBytes),
      networkBytesPerSecond: null,
      javascriptMemoryBytes: null,
      status: "running",
      protected: protectedProcess,
      canEndProcess: !protectedProcess,
      affectedTabCount: associatedTabs.length,
      children,
    };
  });
}

export function isPerformanceRefreshInterval(
  value: unknown,
): value is PerformanceRefreshInterval {
  return (
    value === null || value === 1_000 || value === 2_000 || value === 5_000
  );
}

export function isPerformanceAction(
  value: unknown,
): value is PerformanceAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (
    ["switch-to-tab", "close-tab", "reload-tab"].includes(String(action.type))
  ) {
    return (
      typeof action.tabId === "string" &&
      action.tabId.length > 0 &&
      action.tabId.length <= 128
    );
  }
  return (
    action.type === "end-process" &&
    typeof action.processId === "string" &&
    /^process:\d+:\d+(?:\.\d+)?$/u.test(action.processId)
  );
}
