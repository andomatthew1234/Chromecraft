import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReadingPositionStore } from "./reading-position-store";

describe("ReadingPositionStore", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "chromecraft-reader-"));
    filePath = path.join(directory, "positions.json");
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("normalizes, clamps and reloads article positions", async () => {
    const store = new ReadingPositionStore(filePath);
    await store.load();
    await store.set("https://example.com/article#section", 0.4);
    await store.set("https://example.com/article#other", 1.4);
    expect(store.get("https://example.com/article#final")).toBe(1);

    const reloaded = new ReadingPositionStore(filePath);
    await reloaded.load();
    expect(reloaded.get("https://example.com/article")).toBe(1);
    expect(reloaded.get("file:///private")).toBeNull();
  });

  it("recovers from malformed local data", async () => {
    await fs.writeFile(filePath, "not-json", "utf8");
    const store = new ReadingPositionStore(filePath);
    await store.load();
    expect(store.get("https://example.com")).toBeNull();
  });
});
