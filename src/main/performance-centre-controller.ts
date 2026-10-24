import { promises as fs } from "node:fs";
import path from "node:path";

import { BrowserWindow, nativeTheme, screen, type Rectangle } from "electron";

import type {
  PerformanceAction,
  PerformanceActionResult,
  PerformanceCentreSnapshot,
  PerformanceRefreshInterval,
} from "../shared/performance-centre";
import {
  buildPerformanceRows,
  isPerformanceRefreshInterval,
} from "../shared/performance-centre";
import type { AppMetricsCollector } from "./app-metrics-collector";
import type { TabManager } from "./tab-manager";
import { channels } from "../shared/channels";

const DEFAULT_BOUNDS: Rectangle = { x: 120, y: 100, width: 850, height: 580 };

interface PerformanceCentreControllerOptions {
  preloadPath: string;
  stateFilePath: string;
  developmentUrl?: string;
  packagedHtmlPath: string;
  metrics: AppMetricsCollector;
  manager: () => TabManager | null;
}

export class PerformanceCentreController {
  private window: BrowserWindow | null = null;
  private refreshInterval: PerformanceRefreshInterval = 1_000;
  private timer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: PerformanceCentreControllerOptions) {}

  get isOpen(): boolean {
    return Boolean(this.window && !this.window.isDestroyed());
  }

  isTrustedSender(sender: Electron.WebContents): boolean {
    return Boolean(
      this.window &&
        !this.window.isDestroyed() &&
        sender === this.window.webContents,
    );
  }

  async openOrFocus(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return;
    }
    const bounds = await this.loadBounds();
    const window = new BrowserWindow({
      title: "Performance Centre",
      ...bounds,
      minWidth: 640,
      minHeight: 420,
      resizable: true,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#111318" : "#f9f9ff",
      webPreferences: {
        preload: this.options.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    this.window = window;
    window.removeMenu();
    const scheduleSave = () => this.scheduleBoundsSave();
    window.on("resize", scheduleSave);
    window.on("move", scheduleSave);
    window.on("closed", () => {
      if (this.window === window) this.window = null;
      this.stopTimer();
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = null;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      const allowed = this.options.developmentUrl
        ? new URL(url).origin === new URL(this.options.developmentUrl).origin
        : url.startsWith("file://");
      if (!allowed) event.preventDefault();
    });
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    if (this.options.developmentUrl) {
      const url = new URL("performance-centre.html", this.options.developmentUrl);
      await window.loadURL(url.toString());
    } else {
      await window.loadFile(this.options.packagedHtmlPath);
    }
    this.startTimer();
    this.publish();
  }

  close(): void {
    this.window?.close();
  }

  snapshot(): PerformanceCentreSnapshot {
    const sample = this.options.metrics.sample(900);
    const rows = buildPerformanceRows(
      sample.processes,
      this.options.manager()?.performanceTabTasks ?? [],
    );
    const cpuValues = rows
      .map((row) => row.cpuPercent)
      .filter((value): value is number => value !== null);
    const memoryValues = rows
      .map((row) => row.memoryBytes)
      .filter((value): value is number => value !== null);
    return {
      sampledAt: sample.sampledAt,
      refreshInterval: this.refreshInterval,
      cpuPercent:
        cpuValues.length === 0
          ? null
          : cpuValues.reduce((total, value) => total + value, 0),
      memoryBytes:
        memoryValues.length === 0
          ? null
          : memoryValues.reduce((total, value) => total + value, 0),
      processCount: rows.length,
      systemMemoryBytes: sample.systemMemoryBytes,
      theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      rows,
      notes: {
        cpu: "Chromecraft process CPU, averaged since the previous sample. Multi-core totals can exceed 100%.",
        memory:
          "Process private memory where available; otherwise working-set memory. Shared tab processes are counted once.",
      },
    };
  }

  setRefreshInterval(value: unknown): void {
    if (!isPerformanceRefreshInterval(value)) {
      throw new TypeError("Unsupported Performance Centre refresh interval.");
    }
    this.refreshInterval = value;
    this.startTimer();
    this.publish();
  }

  performAction(action: PerformanceAction): PerformanceActionResult {
    const manager = this.options.manager();
    if (!manager) return { ok: false, message: "The browser is unavailable." };
    try {
      if (action.type === "switch-to-tab") {
        manager.focusTabFromPerformanceCentre(action.tabId);
        return { ok: true, message: "Switched to tab." };
      }
      if (action.type === "close-tab") {
        manager.closeTab(action.tabId);
        return { ok: true, message: "Tab closed." };
      }
      if (action.type === "reload-tab") {
        manager.reload(action.tabId);
        return { ok: true, message: "Tab reloaded." };
      }
      const sample = this.options.metrics.snapshot;
      const process = sample.processes.find(
        (candidate) =>
          `process:${candidate.pid}:${candidate.creationTime}` === action.processId,
      );
      if (!process || process.type !== "Tab") {
        return { ok: false, message: "That process has exited or is protected." };
      }
      const tabCount = manager.performanceTabTasks.filter(
        (tab) => tab.processId === process.pid,
      ).length;
      if (tabCount === 0) {
        return { ok: false, message: "That renderer is not safe to end." };
      }
      const ended = manager.terminateRendererProcess(process.pid);
      return ended > 0
        ? {
            ok: true,
            message:
              ended === 1
                ? "Renderer process ended. The tab can be reloaded."
                : `${ended} tabs were affected and can be reloaded.`,
          }
        : { ok: false, message: "That process has already exited." };
    } catch {
      return { ok: false, message: "The selected task is no longer available." };
    }
  }

  dispose(): void {
    this.stopTimer();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private publish(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(channels.performanceCentreChanged, this.snapshot());
  }

  private startTimer(): void {
    this.stopTimer();
    if (!this.isOpen || this.refreshInterval === null) return;
    this.timer = setInterval(() => {
      this.options.metrics.sample(0);
      this.publish();
    }, this.refreshInterval);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async loadBounds(): Promise<Rectangle> {
    let candidate = DEFAULT_BOUNDS;
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.options.stateFilePath, "utf8"),
      ) as Partial<Rectangle>;
      if (
        [parsed.x, parsed.y, parsed.width, parsed.height].every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ) &&
        (parsed.width ?? 0) >= 640 &&
        (parsed.height ?? 0) >= 420
      ) {
        candidate = parsed as Rectangle;
      }
    } catch {
      // First run or a damaged optional state file uses sensible defaults.
    }
    const workArea = screen.getDisplayMatching(candidate).workArea;
    const width = Math.min(Math.max(640, candidate.width), workArea.width);
    const height = Math.min(Math.max(420, candidate.height), workArea.height);
    return {
      width,
      height,
      x: Math.min(Math.max(workArea.x, candidate.x), workArea.x + workArea.width - width),
      y: Math.min(Math.max(workArea.y, candidate.y), workArea.y + workArea.height - height),
    };
  }

  private scheduleBoundsSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const window = this.window;
      if (!window || window.isDestroyed() || window.isMaximized()) return;
      const bounds = window.getNormalBounds();
      void fs
        .mkdir(path.dirname(this.options.stateFilePath), { recursive: true })
        .then(() =>
          fs.writeFile(
            this.options.stateFilePath,
            JSON.stringify(bounds, null, 2),
            "utf8",
          ),
        )
        .catch(() => undefined);
    }, 250);
  }
}
