import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GalleryStore } from "./gallery-store";

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chromecraft-gallery-"));
  temporaryDirectories.push(root);
  const downloadsDirectory = path.join(root, "Downloads");
  await fs.mkdir(downloadsDirectory);
  return {
    root,
    downloadsDirectory,
    filePath: path.join(root, "profile", "gallery.json"),
  };
}

async function video(directory: string, filename: string, contents = "video") {
  const filePath = path.join(directory, filename);
  await fs.writeFile(filePath, contents);
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("GalleryStore", () => {
  it("deduplicates an exact path and persists updated metadata atomically", async () => {
    const paths = await fixture();
    const file = await video(paths.downloadsDirectory, "clip.mp4", "media");
    let nextId = 0;
    const store = new GalleryStore({
      ...paths,
      generateId: () => `gallery-${++nextId}`,
    });
    await store.initialize();

    const first = await store.addCompleted({
      filePath: file,
      title: "First title",
      durationSeconds: 12,
      width: 1280,
      height: 720,
      sourceName: "YouTube",
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      downloadedAt: 10,
    });
    const duplicate = await store.addCompleted({
      filePath: file,
      title: "Updated title",
      durationSeconds: 13,
      width: 1920,
      height: 1080,
      downloadedAt: 20,
    });

    expect(duplicate.id).toBe(first.id);
    expect(store.snapshot.items).toHaveLength(1);
    expect(store.snapshot.items[0]).toMatchObject({
      title: "Updated title",
      durationSeconds: 13,
      width: 1920,
      height: 1080,
      available: true,
    });

    const restored = new GalleryStore(paths);
    await restored.initialize();
    expect(restored.snapshot).toEqual(store.snapshot);
    const persisted = JSON.parse(await fs.readFile(paths.filePath, "utf8")) as {
      version: number;
      items: unknown[];
    };
    expect(persisted.version).toBe(1);
    expect(persisted.items).toHaveLength(1);
  });

  it("reconciles missing files and resolves only available entries by ID", async () => {
    const paths = await fixture();
    const file = await video(paths.downloadsDirectory, "missing.webm");
    const store = new GalleryStore({
      ...paths,
      generateId: () => "missing-id",
    });
    await store.initialize();
    const entry = await store.addCompleted({ filePath: file });
    expect(await store.resolveFile(entry.id)).toBe(await fs.realpath(file));

    await fs.unlink(file);
    expect(await store.reconcile()).toBe(1);
    expect(store.snapshot.items[0].available).toBe(false);
    expect(await store.resolveFile(entry.id)).toBeNull();

    const restored = new GalleryStore(paths);
    await restored.initialize();
    expect(restored.snapshot.items[0].available).toBe(false);
  });

  it("indexes verified managed media and original thumbnails under owned roots", async () => {
    const paths = await fixture();
    const managed = path.join(
      paths.downloadsDirectory,
      ".chromecraft-smart-downloads",
    );
    const thumbnails = path.join(paths.root, "profile", "smart", "thumbnails");
    await fs.mkdir(managed, { recursive: true });
    await fs.mkdir(thumbnails, { recursive: true });
    const file = await video(managed, "smart [abcdefghijk].mp4");
    const thumbnailPath = path.join(thumbnails, "abcdefghijk.webp");
    await fs.writeFile(thumbnailPath, "image");
    const store = new GalleryStore({
      ...paths,
      thumbnailDirectory: thumbnails,
      generateId: () => "smart-gallery-id",
    });
    await store.initialize();

    const entry = await store.addCompleted({
      filePath: file,
      thumbnailPath,
      managedBy: "smart",
      smartChannelId: "UC1234567890123456789012",
    });

    expect(entry).toMatchObject({
      managedBy: "smart",
      thumbnailUrl: "chromecraft-media://thumbnail/smart-gallery-id",
      smartChannelId: "UC1234567890123456789012",
    });
    await expect(store.resolveThumbnail(entry.id)).resolves.toBe(
      await fs.realpath(thumbnailPath),
    );
    await expect(store.resolveFile(entry.id)).resolves.toBe(
      await fs.realpath(file),
    );
  });

  it("imports only bounded Chromecraft-named top-level media", async () => {
    const paths = await fixture();
    await video(paths.downloadsDirectory, "one [abcdefghijk].mp4");
    await video(paths.downloadsDirectory, "two [123456789ab].mkv");
    await video(paths.downloadsDirectory, "unrelated.mp4");
    await video(paths.downloadsDirectory, "notes.txt");
    const nested = path.join(paths.downloadsDirectory, "nested");
    await fs.mkdir(nested);
    await video(nested, "three.mp4");
    let nextId = 0;
    const store = new GalleryStore({
      ...paths,
      generateId: () => `import-${++nextId}`,
    });
    await store.initialize();

    expect(await store.importDownloads()).toBe(2);
    expect(await store.importDownloads()).toBe(0);
    expect(store.snapshot.items.map((item) => item.filename).sort()).toEqual([
      "one [abcdefghijk].mp4",
      "two [123456789ab].mkv",
    ]);
  });

  it("deduplicates repeat downloads by their original source URL", async () => {
    const paths = await fixture();
    const first = await video(
      paths.downloadsDirectory,
      "clip [abcdefghijk].mp4",
    );
    const second = await video(
      paths.downloadsDirectory,
      "clip [abcdefghijk] (1).mp4",
    );
    let nextId = 0;
    const store = new GalleryStore({
      ...paths,
      generateId: () => `source-${++nextId}`,
    });
    await store.initialize();
    const sourceUrl = "https://www.youtube.com/watch?v=abcdefghijk";
    const original = await store.addCompleted({ filePath: first, sourceUrl });
    const duplicate = await store.addCompleted({ filePath: second, sourceUrl });
    expect(duplicate.id).toBe(original.id);
    expect(store.snapshot.items).toHaveLength(1);
    expect(store.snapshot.items[0].filePath).toBe(original.filePath);
  });

  it("renames inside Downloads without overwrite and rejects traversal", async () => {
    const paths = await fixture();
    const file = await video(paths.downloadsDirectory, "original.mp4", "media");
    const store = new GalleryStore({
      ...paths,
      generateId: () => "rename-id",
    });
    await store.initialize();
    const entry = await store.addCompleted({ filePath: file });

    await expect(store.rename(entry.id, "../escaped")).rejects.toThrow(
      /safe filename/i,
    );
    await expect(store.rename(entry.id, "subdir\\escaped")).rejects.toThrow(
      /safe filename/i,
    );

    await video(paths.downloadsDirectory, "occupied.mp4", "other");
    await expect(store.rename(entry.id, "occupied")).rejects.toThrow(
      /already exists/i,
    );
    expect(await fs.readFile(file, "utf8")).toBe("media");

    const renamed = await store.rename(entry.id, "My clip");
    expect(renamed).toMatchObject({
      title: "My clip",
      filename: "My clip.mp4",
      available: true,
    });
    await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(renamed.filePath, "utf8")).toBe("media");
    expect(await store.resolveFile(entry.id)).toBe(
      await fs.realpath(renamed.filePath),
    );
  });

  it("rejects completed files outside Downloads and filters tampered records", async () => {
    const paths = await fixture();
    const outside = await video(paths.root, "outside.mp4");
    const store = new GalleryStore(paths);
    await store.initialize();
    await expect(store.addCompleted({ filePath: outside })).rejects.toThrow(
      /unavailable or unsafe/i,
    );

    await fs.mkdir(path.dirname(paths.filePath), { recursive: true });
    await fs.writeFile(
      paths.filePath,
      JSON.stringify({
        version: 1,
        items: [
          {
            id: "tampered",
            title: "Outside",
            filename: "outside.mp4",
            filePath: outside,
            mediaUrl: "chromecraft://media/tampered",
            durationSeconds: null,
            width: null,
            height: null,
            fileSize: 5,
            downloadedAt: 1,
            sourceName: null,
            sourceUrl: null,
            available: true,
          },
        ],
      }),
    );
    const restored = new GalleryStore(paths);
    await restored.initialize();
    expect(restored.snapshot.items).toEqual([]);
  });

  it("removes a batch with one persisted index update", async () => {
    const paths = await fixture();
    const firstFile = await video(paths.downloadsDirectory, "first.mp4");
    const secondFile = await video(paths.downloadsDirectory, "second.mp4");
    let nextId = 0;
    const store = new GalleryStore({
      ...paths,
      generateId: () => `batch-${++nextId}`,
    });
    await store.initialize();
    const first = await store.addCompleted({ filePath: firstFile });
    const second = await store.addCompleted({ filePath: secondFile });

    await expect(store.removeMany([first.id, "missing"])).resolves.toBe(1);
    expect(store.snapshot.items.map((item) => item.id)).toEqual([second.id]);

    const restored = new GalleryStore(paths);
    await restored.initialize();
    expect(restored.snapshot.items.map((item) => item.id)).toEqual([second.id]);
  });
});
