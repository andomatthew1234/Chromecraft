import { describe, expect, it, vi } from "vitest";

import type { InstalledVersionSnapshot } from "../shared/updates";
import {
  UpdateManager,
  type ApplicationUpdateProgress,
  type ApplicationUpdateResult,
  type ExtensionUpdateProvider,
  type UpdateAdapter,
  type UpdateManagerOptions,
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
  installedExtensions: UpdateManagerOptions["installedExtensions"] = [],
  persistentState?: UpdateManagerOptions["persistentState"],
) {
  const emit = vi.fn();
  const prepareForRestart = vi.fn(async () => undefined);
  const persist = vi.fn<UpdateManagerOptions["persist"]>(async () => undefined);
  const notifyUpdateReady = vi.fn();
  const manager = new UpdateManager({
    adapter,
    extensions,
    installedVersions,
    installedExtensions,
    persistentState: persistentState ?? {
      preferences: {
        automaticChecksEnabled: true,
        automaticExtensionUpdatesEnabled: true,
        notifyWhenReady: true,
      },
      history: [],
      lastAutomaticCheckAt: null,
      extensionStatuses: [],
    },
    automaticEligible: false,
    emit,
    persist,
    prepareForRestart,
    notifyUpdateReady,
    now: () => 42,
  });
  return {
    adapter,
    emit,
    manager,
    notifyUpdateReady,
    persist,
    prepareForRestart,
  };
}

describe("UpdateManager", () => {
  it("classifies one dependency release without presenting a second app download", async () => {
    const adapter = new FakeAdapter();
    adapter.result = {
      state: "ready",
      release: {
        version: "0.1.1",
        category: "dependencies",
        releaseNotes: "Engine maintenance",
        downloadSizeBytes: 1024,
      },
    };
    const { manager } = setup(adapter);
    const snapshot = await manager.check();
    expect(
      snapshot.results.filter((result) => result.kind === "application"),
    ).toHaveLength(1);
    expect(snapshot.categories.dependencies).toMatchObject({
      status: "ready",
      availableVersion: "0.1.1",
      restartRequired: true,
    });
    expect(snapshot.categories.chromecraft.status).toBe("up-to-date");
    expect(snapshot.applicationRelease).toMatchObject({
      category: "dependencies",
      releaseNotes: "Engine maintenance",
    });
  });

  it("checks the first-run application channel without touching extensions", async () => {
    const adapter = new FakeAdapter();
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: vi.fn(async () => []),
    };
    const { manager } = setup(adapter, extensions);

    await expect(manager.checkApplication()).resolves.toMatchObject({
      status: "up-to-date",
      canRestart: false,
    });

    expect(adapter.checks).toBe(1);
    expect(extensions.checkAndInstallUpdates).not.toHaveBeenCalled();
  });

  it("updates one selected extension without checking the app channel", async () => {
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: vi.fn(async (_report, ids) => [
        {
          id: ids?.[0] ?? "",
          name: "Guard",
          fromVersion: "1.0",
          toVersion: "1.1",
          state: "installed" as const,
        },
      ]),
    };
    const adapter = new FakeAdapter();
    const persist = vi.fn(async () => undefined);
    const manager = new UpdateManager({
      adapter,
      extensions,
      installedVersions,
      installedExtensions: [
        {
          id: "a".repeat(32),
          name: "Guard",
          version: "1.0",
          enabled: false,
          sourceUrl: `https://chromewebstore.google.com/detail/${"a".repeat(32)}`,
          iconDataUrl: null,
        },
      ],
      persistentState: {
        preferences: {
          automaticChecksEnabled: true,
          automaticExtensionUpdatesEnabled: true,
          notifyWhenReady: true,
        },
        history: [],
        lastAutomaticCheckAt: null,
        extensionStatuses: [],
      },
      automaticEligible: false,
      emit: vi.fn(),
      persist,
      prepareForRestart: async () => undefined,
      now: () => 73,
    });

    const snapshot = await manager.updateExtension("a".repeat(32));
    expect(adapter.checks).toBe(0);
    expect(extensions.checkAndInstallUpdates).toHaveBeenCalledWith(
      expect.any(Function),
      ["a".repeat(32)],
    );
    expect(snapshot.extensions[0]).toMatchObject({
      installedVersion: "1.1",
      enabled: false,
      state: "installed",
      lastCheckedAt: 73,
    });
    expect(snapshot.history[0]).toMatchObject({
      category: "extensions",
      result: "installed",
    });
    expect(persist).toHaveBeenCalled();
  });

  it("updates all extensions without checking the app channel", async () => {
    const extensionId = "a".repeat(32);
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: vi.fn(async () => [
        {
          id: extensionId,
          name: "Guard",
          fromVersion: "1.0",
          toVersion: "1.1",
          state: "installed" as const,
        },
      ]),
    };
    const adapter = new FakeAdapter();
    const { manager } = setup(adapter, extensions, [
      {
        id: extensionId,
        name: "Guard",
        version: "1.0",
        enabled: true,
        sourceUrl: `https://chromewebstore.google.com/detail/${extensionId}`,
        iconDataUrl: null,
      },
    ]);

    const snapshot = await manager.updateExtensions();

    expect(adapter.checks).toBe(0);
    expect(extensions.checkAndInstallUpdates).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
    );
    expect(snapshot.extensions[0]).toMatchObject({
      installedVersion: "1.1",
      state: "installed",
    });
  });

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

    release({
      state: "ready",
      release: { version: "v0.2.0", category: "both" },
    });
    await first;
    expect(manager.snapshot).toMatchObject({
      status: "ready",
      canRestart: true,
      checkedAt: 42,
      results: [{ fromVersion: "0.1.0", toVersion: "0.2.0" }],
    });
  });

  it("rejects a differently scoped check instead of silently coalescing it", async () => {
    const extensionId = "a".repeat(32);
    let finishExtensionCheck!: (results: []) => void;
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: vi.fn(
        () =>
          new Promise<[]>((resolve) => {
            finishExtensionCheck = resolve;
          }),
      ),
    };
    const { manager } = setup(new FakeAdapter(), extensions, [
      {
        id: extensionId,
        name: "Guard",
        version: "1.0",
        enabled: true,
        sourceUrl: `https://chromewebstore.google.com/detail/${extensionId}`,
        iconDataUrl: null,
      },
    ]);

    const extensionCheck = manager.updateExtension(extensionId);
    await expect(manager.check()).rejects.toThrow(/already in progress/i);
    finishExtensionCheck([]);
    await extensionCheck;
  });

  it("still updates extensions after an application release is ready", async () => {
    const extensionId = "a".repeat(32);
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: extensionId,
            name: "Guard",
            fromVersion: "1.0",
            toVersion: "1.0",
            state: "up-to-date" as const,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: extensionId,
            name: "Guard",
            fromVersion: "1.0",
            toVersion: "1.1",
            state: "installed" as const,
          },
        ]),
    };
    const adapter = new FakeAdapter();
    adapter.result = {
      state: "ready",
      release: { version: "0.2.0", category: "both" },
    };
    const { manager, notifyUpdateReady } = setup(adapter, extensions, [
      {
        id: extensionId,
        name: "Guard",
        version: "1.0",
        enabled: true,
        sourceUrl: `https://chromewebstore.google.com/detail/${extensionId}`,
        iconDataUrl: null,
      },
    ]);

    await manager.check();
    expect(manager.snapshot.canCheck).toBe(true);
    const extensionCheck = manager.check();
    expect(manager.check()).toBe(extensionCheck);
    const snapshot = await extensionCheck;

    expect(adapter.checks).toBe(1);
    expect(extensions.checkAndInstallUpdates).toHaveBeenCalledTimes(2);
    expect(snapshot).toMatchObject({
      status: "ready",
      canRestart: true,
      extensions: [{ installedVersion: "1.1", state: "installed" }],
    });
    expect(notifyUpdateReady).toHaveBeenCalledTimes(1);
  });

  it("does not postpone application checks after checking one extension", async () => {
    const extensionId = "a".repeat(32);
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: async () => [],
    };
    const { manager, persist } = setup(new FakeAdapter(), extensions, [
      {
        id: extensionId,
        name: "Guard",
        version: "1.0",
        enabled: true,
        sourceUrl: `https://chromewebstore.google.com/detail/${extensionId}`,
        iconDataUrl: null,
      },
    ]);

    await manager.updateExtension(extensionId);

    expect(persist).toHaveBeenLastCalledWith(
      expect.objectContaining({ lastAutomaticCheckAt: null }),
    );
  });

  it("rolls back emitted preferences when persistence fails", async () => {
    const { emit, manager, persist } = setup();
    persist.mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(
      manager.setPreferences({ automaticChecksEnabled: false }),
    ).rejects.toThrow("disk unavailable");

    expect(manager.snapshot.preferences.automaticChecksEnabled).toBe(true);
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        preferences: expect.objectContaining({ automaticChecksEnabled: true }),
      }),
    );
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

  it("records provider-level extension failures in results and history", async () => {
    const extensionId = "a".repeat(32);
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: async () => {
        throw new Error("extension initialization failed");
      },
    };
    const { manager } = setup(new FakeAdapter(), extensions, [
      {
        id: extensionId,
        name: "Guard",
        version: "1.0",
        enabled: true,
        sourceUrl: `https://chromewebstore.google.com/detail/${extensionId}`,
        iconDataUrl: null,
      },
    ]);

    const snapshot = await manager.check();

    expect(snapshot.results).toContainEqual(
      expect.objectContaining({
        id: `extension:${extensionId}`,
        state: "failed",
      }),
    );
    expect(snapshot.history).toContainEqual(
      expect.objectContaining({
        category: "extensions",
        label: "Guard",
        result: "failed",
      }),
    );
  });

  it("clears stale approval state once the installed extension reaches the offered version", async () => {
    const extensionId = "a".repeat(32);
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: async () => [
        {
          id: extensionId,
          name: "Guard",
          fromVersion: "1.0",
          toVersion: "1.1",
          state: "approval-required",
          detail: "New access requested.",
        },
      ],
    };
    const installedExtension = {
      id: extensionId,
      name: "Guard",
      version: "1.0",
      enabled: true,
      sourceUrl: `https://chromewebstore.google.com/detail/${extensionId}`,
      iconDataUrl: null,
    };
    const { manager } = setup(new FakeAdapter(), extensions, [
      installedExtension,
    ]);
    await manager.check();
    expect(manager.snapshot.extensions[0].state).toBe("approval-required");

    manager.setInstalledExtensions([{ ...installedExtension, version: "1.1" }]);

    expect(manager.snapshot.extensions[0]).toMatchObject({
      installedVersion: "1.1",
      availableVersion: null,
      state: "installed",
      detail: null,
    });
  });

  it("restores bounded extension update status across manager restarts", async () => {
    const extensionId = "a".repeat(32);
    const installedExtension = {
      id: extensionId,
      name: "Guard",
      version: "1.0",
      enabled: true,
      sourceUrl: `https://chromewebstore.google.com/detail/${extensionId}`,
      iconDataUrl: null,
    };
    const extensions: ExtensionUpdateProvider = {
      checkAndInstallUpdates: async () => [
        {
          id: extensionId,
          name: "Guard",
          fromVersion: "1.0",
          toVersion: "1.1",
          state: "approval-required",
          detail: "New access requested.",
        },
      ],
    };
    const first = setup(new FakeAdapter(), extensions, [installedExtension]);
    await first.manager.updateExtensions();
    const persisted = first.persist.mock.lastCall?.[0];
    expect(persisted?.extensionStatuses).toEqual([
      expect.objectContaining({
        id: extensionId,
        installedVersion: "1.0",
        availableVersion: "1.1",
        state: "approval-required",
      }),
    ]);

    const restored = setup(
      new FakeAdapter(),
      undefined,
      [installedExtension],
      persisted,
    );
    expect(restored.manager.snapshot.extensions[0]).toMatchObject({
      availableVersion: "1.1",
      state: "approval-required",
      detail: "New access requested.",
    });

    const reconciled = setup(
      new FakeAdapter(),
      undefined,
      [{ ...installedExtension, version: "1.1" }],
      persisted,
    );
    expect(reconciled.manager.snapshot.extensions[0]).toMatchObject({
      installedVersion: "1.1",
      availableVersion: null,
      state: "installed",
    });
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
    adapter.result = {
      state: "ready",
      release: { version: "0.2.0", category: "both" },
    };
    const { manager, prepareForRestart } = setup(adapter);
    await manager.check();
    await Promise.all([manager.restart(), manager.restart()]);
    expect(prepareForRestart).toHaveBeenCalledTimes(1);
    expect(adapter.restarts).toBe(1);
  });
});
