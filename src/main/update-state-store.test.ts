import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UpdateStateStore } from "./update-state-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function storeFixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "chromecraft-updates-"),
  );
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "update-state.json");
  return { filePath, store: new UpdateStateStore(filePath) };
}

describe("UpdateStateStore", () => {
  it("loads secure defaults when no state has been written", async () => {
    const { store } = await storeFixture();
    await expect(store.load()).resolves.toEqual({
      preferences: {
        automaticChecksEnabled: true,
        automaticExtensionUpdatesEnabled: true,
        notifyWhenReady: true,
      },
      history: [],
      lastAutomaticCheckAt: null,
      extensionStatuses: [],
    });
  });

  it("atomically persists preferences, automatic cooldown and bounded history", async () => {
    const { filePath, store } = await storeFixture();
    await store.load();
    const history = Array.from({ length: 120 }, (_, index) => ({
      id: `entry-${index}`,
      category: "extensions" as const,
      label: `Extension ${index}`,
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      result: "installed" as const,
      timestamp: index + 1,
      detail: null,
    }));
    await store.save({
      preferences: {
        automaticChecksEnabled: false,
        automaticExtensionUpdatesEnabled: false,
        notifyWhenReady: false,
      },
      history,
      lastAutomaticCheckAt: 42,
      extensionStatuses: [
        {
          id: "a".repeat(32),
          installedVersion: "1.0",
          availableVersion: "1.1",
          provider: "chrome-web-store",
          state: "approval-required",
          detail: "New host access requested.",
          lastCheckedAt: 41,
        },
      ],
    });

    const reloaded = new UpdateStateStore(filePath);
    const state = await reloaded.load();
    expect(state.preferences.automaticChecksEnabled).toBe(false);
    expect(state.lastAutomaticCheckAt).toBe(42);
    expect(state.history).toHaveLength(100);
    expect(state.extensionStatuses).toEqual([
      expect.objectContaining({
        id: "a".repeat(32),
        state: "approval-required",
      }),
    ]);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      version: 1,
    });
  });

  it("rejects malformed persisted values without carrying them into the UI", async () => {
    const { filePath, store } = await storeFixture();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        preferences: { automaticChecksEnabled: "yes" },
        history: [{ id: "unsafe", detail: { secret: true } }],
        lastAutomaticCheckAt: -1,
        extensionStatuses: [
          {
            id: "not-an-extension",
            installedVersion: "secret",
            availableVersion: "also-secret",
            provider: "remote-script",
            state: "checking",
            detail: { secret: true },
            lastCheckedAt: -1,
          },
        ],
      }),
    );
    const state = await store.load();
    expect(state.preferences.automaticChecksEnabled).toBe(true);
    expect(state.history).toEqual([]);
    expect(state.lastAutomaticCheckAt).toBeNull();
    expect(state.extensionStatuses).toEqual([]);
  });

  it("rejects unknown schemas instead of interpreting them as current state", async () => {
    const { filePath, store } = await storeFixture();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        preferences: { automaticChecksEnabled: false },
      }),
    );

    await expect(store.load()).resolves.toMatchObject({
      preferences: { automaticChecksEnabled: true },
      history: [],
      lastAutomaticCheckAt: null,
    });
  });
});
