import { describe, expect, it, vi } from "vitest";

import type { InstalledVersionSnapshot } from "../shared/updates";
import {
  UpdateManager,
  type UpdateAdapter,
  type UpdateAdapterEvent,
} from "./update-manager";

const installedVersions: InstalledVersionSnapshot[] = [
  { id: "chromecraft", label: "ChromeCraft", version: "0.1.0" },
  { id: "electron", label: "Electron", version: "44.7.2" },
  { id: "chromium", label: "Chromium", version: "152" },
  { id: "node", label: "Node.js", version: "22" },
];

class FakeAdapter implements UpdateAdapter {
  unavailableReason: string | null = null;
  checks = 0;
  restarts = 0;
  listener: ((event: UpdateAdapterEvent) => void) | null = null;
  pending: Promise<void> = Promise.resolve();

  checkForUpdates(): Promise<void> {
    this.checks += 1;
    return this.pending;
  }

  restartAndInstall(): void {
    this.restarts += 1;
  }

  subscribe(listener: (event: UpdateAdapterEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(event: UpdateAdapterEvent): void {
    this.listener?.(event);
  }
}

function setup(adapter = new FakeAdapter()) {
  const emit = vi.fn();
  const prepareForRestart = vi.fn(async () => undefined);
  const manager = new UpdateManager({
    adapter,
    installedVersions,
    emit,
    prepareForRestart,
    now: () => 42,
  });
  return { adapter, emit, manager, prepareForRestart };
}

describe("UpdateManager", () => {
  it("reports unsupported installations truthfully without invoking an updater", async () => {
    const adapter = new FakeAdapter();
    adapter.unavailableReason = "Updates require an installed build.";
    const { manager } = setup(adapter);

    await expect(manager.check()).resolves.toMatchObject({
      status: "unavailable",
      message: "Updates require an installed build.",
      canCheck: true,
    });
    expect(adapter.checks).toBe(0);
  });

  it("coalesces simultaneous checks and moves through download to ready", async () => {
    const adapter = new FakeAdapter();
    let release!: () => void;
    adapter.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager } = setup(adapter);

    const first = manager.check();
    const second = manager.check();
    expect(first).toBe(second);
    expect(adapter.checks).toBe(1);
    expect(manager.snapshot.status).toBe("checking");

    adapter.emit({ type: "available", version: "v0.2.0" });
    expect(manager.snapshot.status).toBe("downloading");
    adapter.emit({ type: "downloaded", version: "v0.2.0" });
    expect(manager.snapshot).toMatchObject({
      status: "ready",
      canRestart: true,
      checkedAt: 42,
      readyUpdates: [{ fromVersion: "0.1.0", toVersion: "0.2.0" }],
    });
    release();
    await first;
  });

  it("reports an up-to-date release", async () => {
    const { adapter, manager } = setup();
    const check = manager.check();
    adapter.emit({ type: "not-available" });
    await check;
    expect(manager.snapshot).toMatchObject({
      status: "up-to-date",
      canCheck: true,
      canRestart: false,
      readyUpdates: [],
    });
  });

  it("does not expose updater errors or allow an early restart", async () => {
    const { adapter, manager } = setup();
    const check = manager.check();
    adapter.emit({
      type: "error",
      error: new Error("secret feed token https://example.invalid/token"),
    });
    await check;
    expect(manager.snapshot.message).not.toContain("token");
    await expect(manager.restart()).rejects.toThrow(/finish downloading/i);
  });

  it("flushes once before handing a ready release to the platform updater", async () => {
    const { adapter, manager, prepareForRestart } = setup();
    adapter.emit({ type: "downloaded", version: "0.2.0" });
    await Promise.all([manager.restart(), manager.restart()]);
    expect(prepareForRestart).toHaveBeenCalledTimes(1);
    expect(adapter.restarts).toBe(1);
  });
});
