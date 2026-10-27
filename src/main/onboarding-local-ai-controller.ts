import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";

import type { OllamaModelSnapshot } from "../shared/ai-tools";
import {
  ONBOARDING_OLLAMA_MODELS,
  REQUIRED_ONBOARDING_OLLAMA_MODEL,
  type OnboardingLocalAiProgress,
  type OnboardingLocalAiSnapshot,
  type OnboardingOllamaModel,
} from "../shared/onboarding";
import type { OllamaClient } from "./ai/ollama-client";

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const SERVICE_START_TIMEOUT_MS = 60_000;
const SERVICE_POLL_MS = 1_000;
const MAX_INSTALLER_OUTPUT_BYTES = 512 * 1024;
const PROGRESS_EMIT_INTERVAL_MS = 80;

const WINDOWS_INSTALL_SCRIPT =
  "irm https://ollama.com/install.ps1 | iex" as const;
const UNIX_INSTALL_SCRIPT =
  "curl -fsSL https://ollama.com/install.sh | sh" as const;

export interface OllamaInstallerCommand {
  executable: string;
  args: readonly string[];
}

type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

interface OllamaSetupClient {
  listModels(signal?: AbortSignal): Promise<OllamaModelSnapshot[]>;
  installModelWithProgress(
    modelName: string,
    signal: AbortSignal,
    report: (progress: {
      status: string;
      completed: number | null;
      total: number | null;
    }) => void,
  ): Promise<void>;
}

export interface OnboardingLocalAiControllerOptions {
  ollama: Pick<OllamaClient, "listModels" | "installModelWithProgress"> &
    OllamaSetupClient;
  onChange?: (snapshot: OnboardingLocalAiSnapshot) => void;
  platform?: NodeJS.Platform;
  spawnProcess?: SpawnProcess;
  terminateProcess?: (
    child: ChildProcessWithoutNullStreams,
  ) => void | Promise<void>;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function isOnboardingOllamaModel(
  value: unknown,
): value is OnboardingOllamaModel {
  return (
    typeof value === "string" &&
    (ONBOARDING_OLLAMA_MODELS as readonly string[]).includes(value)
  );
}

export function ollamaInstallerCommand(
  platform: NodeJS.Platform,
): OllamaInstallerCommand | null {
  if (platform === "win32") {
    return {
      executable: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_INSTALL_SCRIPT,
      ],
    };
  }
  if (platform === "linux" || platform === "darwin") {
    return {
      executable: "/bin/sh",
      args: ["-c", UNIX_INSTALL_SCRIPT],
    };
  }
  return null;
}

function emptySnapshot(): OnboardingLocalAiSnapshot {
  return {
    service: "checking",
    installedModels: [],
    operation: null,
    error: null,
  };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Cancelled", "AbortError"));
      return;
    }
    const finish = () => {
      signal.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    const cancel = () => {
      clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function finiteBytes(value: number | null): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function modelProgress(
  model: OnboardingOllamaModel,
  progress: { status: string; completed: number | null; total: number | null },
): OnboardingLocalAiProgress {
  const completed = finiteBytes(progress.completed);
  const total = finiteBytes(progress.total);
  const percent =
    completed !== null && total !== null && total > 0
      ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
      : null;
  const status = progress.status.toLocaleLowerCase();
  const label = status.includes("success")
    ? `Installed ${model}`
    : status.includes("verif")
      ? `Verifying ${model}`
      : status.includes("writing") || status.includes("removing")
        ? `Finishing ${model}`
        : status.includes("manifest")
          ? `Preparing ${model}`
          : `Downloading ${model}`;
  return {
    kind: "model",
    model,
    label,
    percent,
    completedBytes: completed,
    totalBytes: total,
  };
}

function installerPhase(line: string): {
  label: string;
  percent: number | null;
} {
  const clean = line.replaceAll(/\x1b\[[0-9;]*m/gu, "").toLocaleLowerCase();
  if (/start|launch|service/iu.test(clean)) {
    return { label: "Starting the Ollama service", percent: 90 };
  }
  if (/install|extract|unpack|copy/iu.test(clean)) {
    return { label: "Installing Ollama", percent: 65 };
  }
  if (/download|fetch|retriev/iu.test(clean)) {
    return { label: "Downloading Ollama", percent: 30 };
  }
  return { label: "Running the official Ollama installer", percent: null };
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", "/f"],
        { shell: false, windowsHide: true },
      );
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** Owns explicit, first-run Ollama setup without exposing a general shell IPC. */
export class OnboardingLocalAiController {
  private state = emptySnapshot();
  private readonly platform: NodeJS.Platform;
  private readonly spawnProcess: SpawnProcess;
  private readonly terminateProcess: NonNullable<
    OnboardingLocalAiControllerOptions["terminateProcess"]
  >;
  private readonly wait: NonNullable<
    OnboardingLocalAiControllerOptions["delay"]
  >;
  private active: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private progressTimer: NodeJS.Timeout | null = null;
  private lastProgressEmitAt = 0;
  private disposed = false;

  constructor(private readonly options: OnboardingLocalAiControllerOptions) {
    this.platform = options.platform ?? process.platform;
    this.spawnProcess =
      options.spawnProcess ??
      ((executable, args, spawnOptions) =>
        spawn(
          executable,
          [...args],
          spawnOptions,
        ) as ChildProcessWithoutNullStreams);
    this.terminateProcess = options.terminateProcess ?? terminateProcessTree;
    this.wait = options.delay ?? delay;
  }

  get snapshot(): OnboardingLocalAiSnapshot {
    return {
      ...this.state,
      installedModels: [...this.state.installedModels],
      operation: this.state.operation ? { ...this.state.operation } : null,
    };
  }

  async start(): Promise<OnboardingLocalAiSnapshot> {
    this.assertAvailable();
    if (this.active) return this.snapshot;
    await this.track(() => this.checkService());
    if (
      this.state.service === "ready" &&
      !this.state.installedModels.includes(REQUIRED_ONBOARDING_OLLAMA_MODEL)
    ) {
      void this.track(() =>
        this.runModelInstall(REQUIRED_ONBOARDING_OLLAMA_MODEL),
      );
    }
    return this.snapshot;
  }

  async installService(): Promise<OnboardingLocalAiSnapshot> {
    this.assertAvailable();
    this.assertIdle();
    await this.track(() => this.runServiceInstall());
    return this.snapshot;
  }

  async installModel(
    model: OnboardingOllamaModel,
  ): Promise<OnboardingLocalAiSnapshot> {
    this.assertAvailable();
    if (!isOnboardingOllamaModel(model)) {
      throw new TypeError("Choose a supported local AI model.");
    }
    if (this.state.service !== "ready") {
      throw new Error("Install and start Ollama before downloading models.");
    }
    if (this.state.installedModels.includes(model)) return this.snapshot;
    this.assertIdle();
    await this.track(() => this.runModelInstall(model));
    return this.snapshot;
  }

  cancel(): void {
    this.abortController?.abort();
    if (this.child) void this.terminateProcess(this.child);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.clearProgressTimer();
  }

  private async checkService(): Promise<void> {
    this.state = {
      ...this.state,
      service: "checking",
      operation: null,
      error: null,
    };
    this.emit();
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const models = await this.options.ollama.listModels(controller.signal);
      this.setReady(models);
    } catch (error) {
      if (isAbort(error)) return;
      this.state = {
        service: "missing",
        installedModels: [],
        operation: null,
        error: null,
      };
      this.emit();
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private async runServiceInstall(): Promise<void> {
    const command = ollamaInstallerCommand(this.platform);
    if (!command) {
      this.state = {
        ...this.state,
        service: "failed",
        error: "Ollama setup is not supported on this operating system.",
      };
      this.emit();
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    this.state = {
      ...this.state,
      service: "installing",
      error: null,
      operation: {
        kind: "service",
        model: null,
        label: "Starting the official Ollama installer",
        percent: null,
        completedBytes: null,
        totalBytes: null,
      },
    };
    this.emit();
    try {
      await this.runInstaller(command, controller.signal);
      this.state = {
        ...this.state,
        operation: {
          kind: "service",
          model: null,
          label: "Waiting for the Ollama service",
          percent: 95,
          completedBytes: null,
          totalBytes: null,
        },
      };
      this.emit();
      const models = await this.waitForService(controller.signal);
      this.setReady(models);
      if (
        !this.state.installedModels.includes(REQUIRED_ONBOARDING_OLLAMA_MODEL)
      ) {
        await this.runModelInstall(REQUIRED_ONBOARDING_OLLAMA_MODEL);
      }
    } catch (error) {
      if (isAbort(error)) {
        this.state = {
          ...this.state,
          service: "missing",
          operation: null,
          error: null,
        };
      } else {
        this.state = {
          ...this.state,
          service: "failed",
          operation: null,
          error:
            "Chromecraft could not finish the Ollama installation. Check your system permissions and try again.",
        };
      }
      this.emit();
    } finally {
      if (this.abortController === controller) this.abortController = null;
      if (this.child) {
        void this.terminateProcess(this.child);
        this.child = null;
      }
    }
  }

  private async runInstaller(
    command: OllamaInstallerCommand,
    signal: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(command.executable, command.args, {
          shell: false,
          windowsHide: true,
          detached: this.platform !== "win32",
          stdio: "pipe",
          env: { ...process.env, NO_COLOR: "1" },
        });
      } catch (error) {
        reject(error);
        return;
      }
      this.child = child;
      child.stdin.end();
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", cancel);
        if (this.child === child) this.child = null;
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => {
        void this.terminateProcess(child);
        finish(new DOMException("Cancelled", "AbortError"));
      };
      const report = (chunk: Buffer | string) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_INSTALLER_OUTPUT_BYTES) {
          void this.terminateProcess(child);
          finish(new Error("The Ollama installer returned too much output."));
          return;
        }
        const phase = installerPhase(String(chunk));
        this.state = {
          ...this.state,
          operation: {
            kind: "service",
            model: null,
            label: phase.label,
            percent: phase.percent,
            completedBytes: null,
            totalBytes: null,
          },
        };
        this.scheduleProgressEmit();
      };
      const timeout = setTimeout(() => {
        void this.terminateProcess(child);
        finish(new Error("The Ollama installer timed out."));
      }, INSTALL_TIMEOUT_MS);
      timeout.unref?.();
      child.stdout.on("data", report);
      child.stderr.on("data", report);
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (code === 0) finish();
        else finish(new Error("The Ollama installer did not complete."));
      });
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
  }

  private async waitForService(
    signal: AbortSignal,
  ): Promise<OllamaModelSnapshot[]> {
    const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.options.ollama.listModels(signal);
      } catch (error) {
        if (isAbort(error)) throw error;
        lastError = error;
      }
      await this.wait(SERVICE_POLL_MS, signal);
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("The Ollama service did not start.");
  }

  private async runModelInstall(model: OnboardingOllamaModel): Promise<void> {
    const controller = this.abortController ?? new AbortController();
    this.abortController = controller;
    this.state = {
      ...this.state,
      error: null,
      operation: {
        kind: "model",
        model,
        label: `Preparing ${model}`,
        percent: null,
        completedBytes: null,
        totalBytes: null,
      },
    };
    this.emit();
    try {
      await this.options.ollama.installModelWithProgress(
        model,
        controller.signal,
        (progress) => {
          this.state = {
            ...this.state,
            operation: modelProgress(model, progress),
          };
          this.scheduleProgressEmit();
        },
      );
      const models = await this.options.ollama.listModels(controller.signal);
      if (!models.some((candidate) => candidate.name === model)) {
        throw new Error("Ollama did not report the installed model.");
      }
      this.setReady(models);
    } catch (error) {
      this.clearProgressTimer();
      this.state = {
        ...this.state,
        operation: null,
        error: isAbort(error)
          ? null
          : `Chromecraft could not download ${model}. Check Ollama and your connection, then try again.`,
      };
      this.emit();
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private setReady(models: OllamaModelSnapshot[]): void {
    this.clearProgressTimer();
    this.state = {
      service: "ready",
      installedModels: models.map((model) => model.name),
      operation: null,
      error: null,
    };
    this.emit();
  }

  private track(operation: () => Promise<void>): Promise<void> {
    this.assertIdle();
    const active = operation().finally(() => {
      if (this.active === active) this.active = null;
    });
    this.active = active;
    return active;
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("Local AI onboarding is unavailable.");
  }

  private assertIdle(): void {
    if (this.active) throw new Error("Another local AI setup task is running.");
  }

  private scheduleProgressEmit(): void {
    const elapsed = Date.now() - this.lastProgressEmitAt;
    if (elapsed >= PROGRESS_EMIT_INTERVAL_MS) {
      this.clearProgressTimer();
      this.emit();
      return;
    }
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.emit();
    }, PROGRESS_EMIT_INTERVAL_MS - elapsed);
    this.progressTimer.unref?.();
  }

  private clearProgressTimer(): void {
    if (!this.progressTimer) return;
    clearTimeout(this.progressTimer);
    this.progressTimer = null;
  }

  private emit(): void {
    if (this.disposed) return;
    this.lastProgressEmitAt = Date.now();
    this.options.onChange?.(this.snapshot);
  }
}
