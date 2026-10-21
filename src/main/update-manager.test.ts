import { describe, expect, it, vi } from "vitest";

import type { InstalledVersionSnapshot } from "../shared/updates";
import {
  UpdateManager,
  type ApplicationUpdateProgress,
  type ApplicationUpdateResult,
  type ExtensionUpdateProvider,
  type UpdateAdapter,
} from "./update-manager";

const installedVersions: InstalledVersionSnapshot[] = [
  { id: "chromecraft", label: "ChromeCraft", version: "0.1.0" },
  { id: "electron", label: "Electron", version: "44.7.2" },
  { id: "chromium", label: "Chromium", version: "152" },
  { id: "node", label: "Node.js", version: "22" },
];

class FakeAdapter implements UpdateAdapter {
  checks = 0;
  restarts = 0;
  result: ApplicationUpdateResult = { state: "up-to-date" };
  pending: Promise<ApplicationUpdateResult> | null = null;

  checkForUpdates(
    report: (progress: ApplicationUpdateProgress) => void,
  ): Promise<ApplicationUpdateResult> {
    this.checks += 1;
    report({ stage: "checking", label: "Checking app" });
    return this.pending ?? Promise.resolve(this.result);
  }

  restartAndInstall(): void {
    this.restarts += 1;
  }
}

function setup(
  adapter = new FakeAdapter(),
  extensions?: ExtensionUpdateProvider,
) {
  const emit = vi.fn();
  const prepareForRestart = vi.fn(async () => undefined);
  const manager = new UpdateManager({
    adapter,
    extensions,
    installedVersions,
    emit,
    prepareForRestart,
    now: () => 42,
  });
  return { adapter, emit, manager, prepareForRestart };
}

describe("UpdateManager", () => {
  it("checks and installs extensions even when the portable app cannot self-update", async () => {
    const adapter = new FakeAdapter();
    adapter.result = {
      state: "unavailable",
      detail: "Application updates require an installed build.",
    };
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: vi.fn(async (report) => {
        report({
          label: "Downloading Guard",
          receivedBytes: 50,
          totalBytes: 100,
        });
        return [
          {
            id: "a".repeat(32),
            name: "Guard",
            fromVersion: "1.0",
            toVersion: "1.1",
            state: "installed" as const,
          },
        ];
      }),
    };
    const { manager } = setup(adapter, extensions);

    await expect(manager.check()).resolves.toMatchObject({
      status: "partial",
      canCheck: true,
      canRestart: false,
      results: [
        { kind: "extension", state: "installed" },
        { kind: "application", state: "unavailable" },
      ],
    });
    expect(extensions.checkAndInstallUpdates).toHaveBeenCalledOnce();
    expect(adapter.checks).toBe(1);
  });

  it("reports a portable check as partial when the extension source has no installed items", async () => {
    const adapter = new FakeAdapter();
    adapter.result = {
      state: "unavailable",
      detail: "Application updates require an installed build.",
    };
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: async () => [],
    };
    const { manager } = setup(adapter, extensions);

    await expect(manager.check()).resolves.toMatchObject({
      status: "partial",
      canCheck: true,
      results: [{ kind: "application", state: "unavailable" }],
    });
  });

  it("coalesces checks until the application check reaches a terminal result", async () => {
    const adapter = new FakeAdapter();
    let release!: (result: ApplicationUpdateResult) => void;
    adapter.pending = new Promise<ApplicationUpdateResult>((resolve) => {
      release = resolve;
    });
    const { manager } = setup(adapter);

    const first = manager.check();
    const second = manager.check();
    expect(first).toBe(second);
    expect(adapter.checks).toBe(1);
    expect(manager.snapshot.status).toBe("checking");

    release({ state: "ready", version: "v0.2.0" });
    await first;
    expect(manager.snapshot).toMatchObject({
      status: "ready",
      canRestart: true,
      checkedAt: 42,
      results: [{ fromVersion: "0.1.0", toVersion: "0.2.0" }],
    });
  });

  it("reports all update sources as up to date", async () => {
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: async () => [
        {
          id: "a".repeat(32),
          name: "Guard",
          fromVersion: "1.0",
          toVersion: "1.0",
          state: "up-to-date",
        },
      ],
    };
    const { manager } = setup(new FakeAdapter(), extensions);
    await manager.check();
    expect(manager.snapshot).toMatchObject({
      status: "up-to-date",
      canCheck: true,
      canRestart: false,
    });
  });

  it("isolates source errors and does not expose internal error details", async () => {
    const adapter = new FakeAdapter();
    adapter.checkForUpdates = async () => {
      throw new Error("secret feed token https://example.invalid/token");
    };
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: async () => {
        throw new Error("private extension path");
      },
    };
    const { manager } = setup(adapter, extensions);
    await manager.check();
    expect(manager.snapshot.status).toBe("error");
    expect(JSON.stringify(manager.snapshot)).not.toContain("token");
    expect(JSON.stringify(manager.snapshot)).not.toContain(
      "private extension path",
    );
    await expect(manager.restart()).rejects.toThrow(/finish downloading/i);
  });

  it("does not claim extensions are current when their source fails", async () => {
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: async () => {
        throw new Error("extension initialization failed");
      },
    };
    const { manager } = setup(new FakeAdapter(), extensions);
    await manager.check();
    expect(manager.snapshot.status).toBe("partial");
    expect(manager.snapshot.message).not.toMatch(/extensions are up to date/i);
  });

  it("clamps determinate extension download progress", async () => {
    let observedPercent: number | null = null;
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: async (report) => {
        report({ label: "Downloading", receivedBytes: 150, totalBytes: 100 });
        return [];
      },
    };
    const { emit, manager } = setup(new FakeAdapter(), extensions);
    emit.mockImplementation((snapshot) => {
      if (snapshot.progress?.label === "Downloading") {
        observedPercent = snapshot.progress.percent;
      }
    });
    await manager.check();
    expect(observedPercent).toBe(100);
  });

  it("flushes once before handing a ready release to the platform updater", async () => {
    const adapter = new FakeAdapter();
    adapter.result = { state: "ready", version: "0.2.0" };
    const { manager, prepareForRestart } = setup(adapter);
    await manager.check();
    await Promise.all([manager.restart(), manager.restart()]);
    expect(prepareForRestart).toHaveBeenCalledTimes(1);
    expect(adapter.restarts).toBe(1);
  });
});
