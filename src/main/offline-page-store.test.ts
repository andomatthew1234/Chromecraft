import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OfflinePageStore,
  type OfflinePageCaptureSource,
} from "./offline-page-store";

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chromecraft-offline-"));
  temporaryDirectories.push(root);
  return { root, directory: path.join(root, "profile", "offline-pages") };
}

function capture(
  overrides?: Partial<OfflinePageCaptureSource>,
): OfflinePageCaptureSource {
  return {
    tabId: "tab-1",
    title: "Example page",
    sourceUrl: "https://example.com/article",
    assertUnchanged: vi.fn(),
    saveCompletePage: async (destinationHtml) => {
      await fs.mkdir(path.dirname(destinationHtml), { recursive: true });
      await fs.writeFile(
        destinationHtml,
        '<html><link href="index_files/site.css"></html>',
      );
      const assets = path.join(path.dirname(destinationHtml), "index_files");
      await fs.mkdir(assets);
      await fs.writeFile(
        path.join(assets, "site.css"),
        "body { color: green; }",
      );
    },
    capturePreview: async () => Buffer.from("preview"),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("OfflinePageStore", () => {
  it("captures a complete page, persists metadata and resolves only owned resources", async () => {
    const paths = await fixture();
    const onChange = vi.fn();
    const store = new OfflinePageStore({
      ...paths,
      generateId: () => "archive-1",
      now: () => 1234,
      onChange,
    });
    await store.initialize();

    const entry = await store.savePage(capture());

    expect(entry).toMatchObject({
      id: "archive-1",
      title: "Example page",
      sourceUrl: "https://example.com/article",
      archiveUrl: "chromecraft-offline://archive-1/index.html",
      savedAt: 1234,
      available: true,
      thumbnailUrl: "chromecraft-offline://archive-1/thumbnail.png",
    });
    expect(store.snapshot.save).toMatchObject({
      stage: "complete",
      entryId: "archive-1",
    });
    await expect(
      store.resolveResource("archive-1", "index.html"),
    ).resolves.toBe(
      await fs.realpath(
        path.join(paths.directory, "archives", "archive-1", "index.html"),
      ),
    );
    await expect(
      store.resolveResource("archive-1", "index_files/site.css"),
    ).resolves.toBe(
      await fs.realpath(
        path.join(
          paths.directory,
          "archives",
          "archive-1",
          "index_files",
          "site.css",
        ),
      ),
    );
    await expect(
      store.resolveResource("archive-1", "../index.json"),
    ).resolves.toBeNull();
    expect(onChange).toHaveBeenCalled();

    const restored = new OfflinePageStore(paths);
    await restored.initialize();
    expect(restored.snapshot.items).toEqual(store.snapshot.items);
  });

  it("rolls back a failed capture without indexing a partial archive", async () => {
    const paths = await fixture();
    const store = new OfflinePageStore({
      ...paths,
      generateId: () => "failed-archive",
    });
    await store.initialize();

    await expect(
      store.savePage(
        capture({
          saveCompletePage: async () => {
            throw new Error("capture stopped");
          },
        }),
      ),
    ).rejects.toThrow("capture stopped");

    expect(store.snapshot.items).toEqual([]);
    expect(store.snapshot.save).toMatchObject({
      stage: "failed",
      error: "capture stopped",
    });
    await expect(
      fs.stat(
        path.join(paths.directory, "archives", ".partial-failed-archive"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects concurrent saves and archives that exceed configured limits", async () => {
    const paths = await fixture();
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let id = 0;
    const store = new OfflinePageStore({
      ...paths,
      generateId: () => `page-${++id}`,
      maxArchiveBytes: 8,
    });
    await store.initialize();
    const first = store.savePage(
      capture({
        saveCompletePage: async (destinationHtml) => {
          await captureGate;
          await fs.mkdir(path.dirname(destinationHtml), { recursive: true });
          await fs.writeFile(destinationHtml, "too much content");
        },
        capturePreview: async () => null,
      }),
    );

    await expect(store.savePage(capture())).rejects.toThrow(
      "Another page is already being saved",
    );
    releaseCapture();
    await expect(first).rejects.toThrow("too large");
    expect(store.snapshot.items).toEqual([]);
  });

  it("removes only the requested browser-owned archive", async () => {
    const paths = await fixture();
    const store = new OfflinePageStore({
      ...paths,
      generateId: () => "remove-me",
    });
    await store.initialize();
    await store.savePage(capture({ capturePreview: async () => null }));

    await store.remove("remove-me");

    expect(store.snapshot.items).toEqual([]);
    await expect(
      fs.stat(path.join(paths.directory, "archives", "remove-me")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.remove("../../outside")).rejects.toThrow(
      "Invalid offline page id",
    );
  });
});
