import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import type { OllamaModelSnapshot } from "../shared/ai-tools";
import {
  isOnboardingOllamaModel,
  ollamaInstallerCommand,
  OnboardingLocalAiController,
} from "./onboarding-local-ai-controller";

function model(name: string): OllamaModelSnapshot {
  return {
    name,
    size: 1_000,
    modifiedAt: null,
    family: null,
    parameterSize: null,
  };
}

function fakeChildProcess(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 724;
  child.exitCode = null;
  child.kill = vi.fn();
  return child as unknown as ChildProcessWithoutNullStreams;
}

describe("OnboardingLocalAiController", () => {
  it("uses only fixed official installer commands", () => {
    expect(ollamaInstallerCommand("win32")).toEqual({
      executable: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "irm https://ollama.com/install.ps1 | iex",
      ],
    });
    expect(ollamaInstallerCommand("linux")).toEqual({
      executable: "/bin/sh",
      args: ["-c", "curl -fsSL https://ollama.com/install.sh | sh"],
    });
    expect(ollamaInstallerCommand("darwin")).toEqual(
      ollamaInstallerCommand("linux"),
    );
    expect(ollamaInstallerCommand("aix")).toBeNull();
  });

  it("accepts only the four onboarding model identifiers", () => {
    expect(isOnboardingOllamaModel("gemma4:26b")).toBe(true);
    expect(isOnboardingOllamaModel("devstral-small-2:24b")).toBe(true);
    expect(isOnboardingOllamaModel("qwen3.5:4b")).toBe(true);
    expect(isOnboardingOllamaModel("qwen3.5:0.8b")).toBe(true);
    expect(isOnboardingOllamaModel("qwen3.5:4b; rm -rf /")).toBe(false);
    expect(isOnboardingOllamaModel("qwen3:1.7b")).toBe(false);
  });

  it("detects an already-ready service without redownloading the required model", async () => {
    const installModelWithProgress = vi.fn();
    const controller = new OnboardingLocalAiController({
      ollama: {
        listModels: vi
          .fn()
          .mockResolvedValue([model("qwen3.5:0.8b"), model("custom:latest")]),
        installModelWithProgress,
      },
    });

    await expect(controller.start()).resolves.toMatchObject({
      service: "ready",
      installedModels: ["qwen3.5:0.8b", "custom:latest"],
      operation: null,
    });
    expect(installModelWithProgress).not.toHaveBeenCalled();
  });

  it("automatically downloads qwen3.5:0.8b when Ollama is ready without it", async () => {
    const snapshots: string[][] = [];
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([model("qwen3.5:0.8b")]);
    const installModelWithProgress = vi.fn(
      async (
        _name: string,
        _signal: AbortSignal,
        report: (progress: {
          status: string;
          completed: number | null;
          total: number | null;
        }) => void,
      ) => {
        report({ status: "pulling layer", completed: 25, total: 100 });
        await new Promise((resolve) => setTimeout(resolve, 90));
        report({ status: "success", completed: 100, total: 100 });
      },
    );
    const observed: Array<{ percent: number | null; label: string }> = [];
    const controller = new OnboardingLocalAiController({
      ollama: { listModels, installModelWithProgress },
      onChange: (snapshot) => {
        snapshots.push(snapshot.installedModels.slice());
        if (snapshot.operation) {
          observed.push({
            percent: snapshot.operation.percent,
            label: snapshot.operation.label,
          });
        }
      },
    });

    await controller.start();
    await vi.waitFor(() => {
      expect(controller.snapshot.installedModels).toContain("qwen3.5:0.8b");
    });

    expect(installModelWithProgress).toHaveBeenCalledWith(
      "qwen3.5:0.8b",
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(observed).toContainEqual({
      percent: 25,
      label: "Downloading qwen3.5:0.8b",
    });
    expect(snapshots.at(-1)).toEqual(["qwen3.5:0.8b"]);
  });

  it("runs the installer without shell expansion and waits for the service", async () => {
    const child = fakeChildProcess();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        (child.stdout as PassThrough).write("Downloading package");
        child.emit("close", 0, null);
      });
      return child;
    });
    const listModels = vi.fn().mockResolvedValue([model("qwen3.5:0.8b")]);
    const controller = new OnboardingLocalAiController({
      platform: "win32",
      spawnProcess,
      ollama: { listModels, installModelWithProgress: vi.fn() },
    });

    await expect(controller.installService()).resolves.toMatchObject({
      service: "ready",
      installedModels: ["qwen3.5:0.8b"],
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining([
        "-Command",
        "irm https://ollama.com/install.ps1 | iex",
      ]),
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("rejects renderer-shaped arbitrary model input before reaching Ollama", async () => {
    const installModelWithProgress = vi.fn();
    const controller = new OnboardingLocalAiController({
      ollama: {
        listModels: vi.fn().mockResolvedValue([model("qwen3.5:0.8b")]),
        installModelWithProgress,
      },
    });
    await controller.start();

    await expect(
      controller.installModel("other/model:latest" as "qwen3.5:4b"),
    ).rejects.toThrow("supported local AI model");
    expect(installModelWithProgress).not.toHaveBeenCalled();
  });

  it("cancels an active model download and clears its progress", async () => {
    const download = { signal: null as AbortSignal | null };
    const installModelWithProgress = vi.fn(
      (_name: string, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          download.signal = signal;
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    const controller = new OnboardingLocalAiController({
      ollama: {
        listModels: vi.fn().mockResolvedValue([model("qwen3.5:0.8b")]),
        installModelWithProgress,
      },
    });
    await controller.start();
    const installing = controller.installModel("qwen3.5:4b");
    await vi.waitFor(() => expect(download.signal).not.toBeNull());

    controller.cancel();
    await installing;

    expect(download.signal?.aborted).toBe(true);
    expect(controller.snapshot.operation).toBeNull();
    expect(controller.snapshot.error).toBeNull();
  });

  it("terminates an installer process when disposed", async () => {
    const child = fakeChildProcess();
    const terminateProcess = vi.fn(async () => undefined);
    const controller = new OnboardingLocalAiController({
      platform: "linux",
      spawnProcess: () => child,
      terminateProcess,
      ollama: {
        listModels: vi.fn(),
        installModelWithProgress: vi.fn(),
      },
    });
    const installing = controller.installService();
    await vi.waitFor(() =>
      expect(controller.snapshot.service).toBe("installing"),
    );

    controller.dispose();
    await installing;

    expect(terminateProcess).toHaveBeenCalledWith(child);
    expect(controller.snapshot.operation).toBeNull();
  });
});
