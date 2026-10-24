import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PreferencesStore } from "./preferences";

describe("PreferencesStore search suggestions", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "chromecraft-prefs-"));
    filePath = path.join(directory, "preferences.json");
  });

  it("keeps Hyperdrive opt-in with private defaults", async () => {
    const preferences = new PreferencesStore(filePath);
    await preferences.load();

    expect(preferences.snapshot).toMatchObject({
      hyperdriveMode: "off",
      hyperdriveRamBudgetMb: 256,
      hyperdriveCrossSitePreloadingEnabled: false,
      hyperdriveSearchPreloadingEnabled: false,
      hyperdriveExcludedHosts: [],
      hyperdriveMonitorOpen: false,
      hyperdriveDeveloperMode: false,
    });
  });

  it("keeps legacy sidebar preferences attached and preserves panel state", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({ sidebarOpen: false }),
      "utf8",
    );

    const preferences = new PreferencesStore(filePath);
    await preferences.load();

    expect(preferences.snapshot.sidebarAttached).toBe(true);
    expect(preferences.snapshot.sidebarOpen).toBe(false);

    await preferences.setSidebarAttached(false);
    const reloaded = new PreferencesStore(filePath);
    await reloaded.load();
    expect(reloaded.snapshot.sidebarAttached).toBe(false);
    expect(reloaded.snapshot.sidebarOpen).toBe(false);
  });

  it("persists every Hyperdrive preference", async () => {
    const preferences = new PreferencesStore(filePath);
    await preferences.load();
    await preferences.setHyperdriveMode("aggressive");
    await preferences.setHyperdriveRamBudgetMb(768);
    await preferences.setHyperdriveCrossSitePreloadingEnabled(true);
    await preferences.setHyperdriveSearchPreloadingEnabled(true);
    await preferences.setHyperdriveExcludedHosts([
      " WWW.Example.com ",
      "example.com",
      "news.example.org",
    ]);
    await preferences.setHyperdriveMonitorOpen(true);
    await preferences.setHyperdriveDeveloperMode(true);

    const reloaded = new PreferencesStore(filePath);
    await reloaded.load();
    expect(reloaded.snapshot).toMatchObject({
      hyperdriveMode: "aggressive",
      hyperdriveRamBudgetMb: 768,
      hyperdriveCrossSitePreloadingEnabled: true,
      hyperdriveSearchPreloadingEnabled: true,
      hyperdriveExcludedHosts: ["example.com", "news.example.org"],
      hyperdriveMonitorOpen: true,
      hyperdriveDeveloperMode: true,
    });
  });

  it("normalises malformed Hyperdrive values back to safe defaults", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        hyperdriveMode: "warp-nine",
        hyperdriveRamBudgetMb: 65.5,
        hyperdriveCrossSitePreloadingEnabled: "yes",
        hyperdriveSearchPreloadingEnabled: 1,
        hyperdriveExcludedHosts: [
          "...",
          "https://example.com",
          "Valid.Example",
          42,
        ],
        hyperdriveMonitorOpen: "true",
        hyperdriveDeveloperMode: "true",
      }),
      "utf8",
    );

    const preferences = new PreferencesStore(filePath);
    await preferences.load();
    expect(preferences.snapshot).toMatchObject({
      hyperdriveMode: "off",
      hyperdriveRamBudgetMb: 256,
      hyperdriveCrossSitePreloadingEnabled: false,
      hyperdriveSearchPreloadingEnabled: false,
      hyperdriveExcludedHosts: ["valid.example"],
      hyperdriveMonitorOpen: false,
      hyperdriveDeveloperMode: false,
    });
  });

  it("rejects invalid Hyperdrive setter values without changing persisted state", async () => {
    const preferences = new PreferencesStore(filePath);
    await preferences.load();

    await expect(
      preferences.setHyperdriveMode("warp-nine" as "off"),
    ).rejects.toThrow("Unsupported mode");
    await expect(preferences.setHyperdriveRamBudgetMb(32)).rejects.toThrow(
      "64-4096",
    );
    await expect(preferences.setHyperdriveRamBudgetMb(128.5)).rejects.toThrow(
      "64-4096",
    );

    expect(preferences.snapshot.hyperdriveMode).toBe("off");
    expect(preferences.snapshot.hyperdriveRamBudgetMb).toBe(256);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("keeps remote search suggestions off by default", async () => {
    const preferences = new PreferencesStore(filePath);
    await preferences.load();
    expect(preferences.snapshot.remoteSearchSuggestionsEnabled).toBe(false);
    expect(preferences.snapshot.searchEngine).toBe("duckduckgo");
  });

  it("keeps extension developer mode off by default and persists opt-in", async () => {
    const preferences = new PreferencesStore(filePath);
    await preferences.load();
    expect(preferences.snapshot.extensionDeveloperMode).toBe(false);

    await preferences.setExtensionDeveloperMode(true);
    const reloaded = new PreferencesStore(filePath);
    await reloaded.load();
    expect(reloaded.snapshot.extensionDeveloperMode).toBe(true);
  });

  it("keeps toolbar actions visible by default and persists hidden actions", async () => {
    const extensionId = "a".repeat(32);
    const preferences = new PreferencesStore(filePath);
    await preferences.load();

    expect(preferences.snapshot.hiddenToolbarExtensionIds).toEqual([]);
    expect(preferences.snapshot.hiddenToolbarActions).toEqual([]);

    await preferences.setExtensionToolbarPinned(extensionId, false);
    await preferences.setToolbarActionPinned("bookmark", false);
    await preferences.setToolbarActionPinned("find", false);

    const reloaded = new PreferencesStore(filePath);
    await reloaded.load();
    expect(reloaded.snapshot.hiddenToolbarExtensionIds).toEqual([extensionId]);
    expect(reloaded.snapshot.hiddenToolbarActions).toEqual([
      "bookmark",
      "find",
    ]);

    await reloaded.setExtensionToolbarPinned(extensionId, true);
    await reloaded.setToolbarActionPinned("bookmark", true);
    expect(reloaded.snapshot.hiddenToolbarExtensionIds).toEqual([]);
    expect(reloaded.snapshot.hiddenToolbarActions).toEqual(["find"]);
  });

  it("rejects malformed persisted toolbar visibility preferences", async () => {
    const extensionId = "b".repeat(32);
    await fs.writeFile(
      filePath,
      JSON.stringify({
        hiddenToolbarExtensionIds: [
          extensionId,
          extensionId,
          "B".repeat(32),
          "not-an-extension",
          42,
        ],
        hiddenToolbarActions: ["find", "unknown", "find", 42],
      }),
      "utf8",
    );

    const preferences = new PreferencesStore(filePath);
    await preferences.load();
    expect(preferences.snapshot.hiddenToolbarExtensionIds).toEqual([
      extensionId,
    ]);
    expect(preferences.snapshot.hiddenToolbarActions).toEqual(["find"]);
  });

  it("persists explicit opt-in and validates malformed stored values", async () => {
    const preferences = new PreferencesStore(filePath);
    await preferences.load();
    await preferences.setRemoteSearchSuggestionsEnabled(true);

    const reloaded = new PreferencesStore(filePath);
    await reloaded.load();
    expect(reloaded.snapshot.remoteSearchSuggestionsEnabled).toBe(true);

    await fs.writeFile(
      filePath,
      JSON.stringify({ remoteSearchSuggestionsEnabled: "yes" }),
      "utf8",
    );
    const malformed = new PreferencesStore(filePath);
    await malformed.load();
    expect(malformed.snapshot.remoteSearchSuggestionsEnabled).toBe(false);
  });
});
