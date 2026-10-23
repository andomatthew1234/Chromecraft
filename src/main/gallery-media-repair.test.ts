import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GalleryMediaRepairService,
  parseFfprobeJson,
} from "./gallery-media-repair";
import { GalleryStore } from "./gallery-store";

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gallery-repair-"));
  temporaryDirectories.push(root);
  const downloadsDirectory = path.join(root, "Downloads");
  const thumbnailDirectory = path.join(root, "profile", "thumbnails");
  await fs.mkdir(downloadsDirectory, { recursive: true });
  await fs.mkdir(thumbnailDirectory, { recursive: true });
  const mediaPath = path.join(
    downloadsDirectory,
    "Original title [abcdefghijk].mp4",
  );
  await fs.writeFile(mediaPath, "video");
  const gallery = new GalleryStore({
    filePath: path.join(root, "profile", "gallery.json"),
    downloadsDirectory,
    thumbnailDirectory,
    generateId: () => "gallery-entry",
  });
  await gallery.initialize();
  await gallery.addCompleted({
    filePath: mediaPath,
    sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    sourceName: "YouTube",
  });
  return {
    root,
    downloadsDirectory,
    thumbnailDirectory,
    mediaPath,
    gallery,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("GalleryMediaRepairService", () => {
  it("rehomes an existing sidecar and caches local ffprobe metadata", async () => {
    const paths = await fixture();
    await fs.writeFile(
      paths.mediaPath.replace(/\.mp4$/u, ".webp"),
      "RIFF0000WEBPoriginal-artwork",
    );
    const runTool = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        format: { duration: "91.25", format_name: "mov,mp4,m4a" },
        streams: [
          { codec_type: "audio" },
          { codec_type: "video", width: 1920, height: 1080 },
        ],
      }),
      stderr: "",
    }));
    const service = new GalleryMediaRepairService({
      ...paths,
      ytDlpPath: "yt-dlp",
      denoPath: "deno",
      ffprobePath: process.execPath,
      runTool,
    });

    const result = await service.repair({
      fetchOriginalThumbnails: false,
      generateLocalFallbacks: false,
    });

    expect(result).toMatchObject({
      scanned: 1,
      thumbnailsRepaired: 1,
      originalThumbnailsFetched: 0,
      metadataRecovered: 1,
      missingThumbnails: 0,
      metadataUnavailable: 0,
    });
    const entry = paths.gallery.snapshot.items[0];
    expect(entry).toMatchObject({
      thumbnailUrl: "chromecraft-media://thumbnail/gallery-entry",
      durationSeconds: 91.25,
      width: 1920,
      height: 1080,
      videoFormat: "MOV",
      metadataFileSize: 5,
    });
    expect(entry.thumbnailPath).toContain(paths.thumbnailDirectory);
    await expect(fs.readFile(entry.thumbnailPath!, "utf8")).resolves.toBe(
      "RIFF0000WEBPoriginal-artwork",
    );
  });

  it("fetches original artwork only during an explicitly permitted repair", async () => {
    const paths = await fixture();
    await fs.writeFile(
      path.join(paths.thumbnailDirectory, "abcdefghijk.webp"),
      "not-an-image",
    );
    const invocations: Array<{ executable: string; args: readonly string[] }> =
      [];
    const runTool = vi.fn(
      async (executable: string, args: readonly string[]) => {
        invocations.push({ executable, args });
        if (executable === "yt-dlp") {
          const output = args[args.indexOf("--output") + 1];
          const directory = path.dirname(output);
          await fs.writeFile(
            path.join(directory, "gallery-entry.webp"),
            "RIFF0000WEBPremote",
          );
          await fs.writeFile(
            path.join(directory, "gallery-entry.info.json"),
            JSON.stringify({
              title: "Recovered source title",
              duration: 42,
              width: 1280,
              height: 720,
              ext: "mp4",
              format_note: "720p",
            }),
          );
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unavailable" };
      },
    );
    const service = new GalleryMediaRepairService({
      ...paths,
      ytDlpPath: "yt-dlp",
      denoPath: "deno",
      runTool,
    });

    const result = await service.repair({
      fetchOriginalThumbnails: true,
      generateLocalFallbacks: false,
    });

    expect(result.originalThumbnailsFetched).toBe(1);
    expect(result.thumbnailsRepaired).toBe(1);
    expect(invocations[0]?.executable).toBe("yt-dlp");
    expect(invocations[0]?.args).toContain("--skip-download");
    expect(invocations[0]?.args).toContain("--write-thumbnail");
    expect(invocations[0]?.args.at(-1)).toBe(
      "https://www.youtube.com/watch?v=abcdefghijk",
    );
    expect(paths.gallery.snapshot.items[0]).toMatchObject({
      sourceTitle: "Recovered source title",
      durationSeconds: 42,
      width: 1280,
      height: 720,
      videoFormat: "MP4 · 720p",
    });
    await expect(
      fs.readFile(
        path.join(paths.thumbnailDirectory, "abcdefghijk.webp"),
        "utf8",
      ),
    ).resolves.toBe("RIFF0000WEBPremote");
  });

  it("coalesces simultaneous repair requests", async () => {
    const paths = await fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new GalleryMediaRepairService({
      ...paths,
      ytDlpPath: "yt-dlp",
      denoPath: "deno",
      runTool: async () => {
        await waiting;
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const request = {
      fetchOriginalThumbnails: false,
      generateLocalFallbacks: false,
    };
    const first = service.repair(request);
    const second = service.repair(request);
    expect(second).toBe(first);
    release();
    await first;
  });
});

describe("parseFfprobeJson", () => {
  it("rejects malformed output and extracts only the video stream", () => {
    expect(parseFfprobeJson("not-json")).toBeNull();
    expect(
      parseFfprobeJson(
        JSON.stringify({
          format: { duration: "10.5", format_name: "matroska,webm" },
          streams: [
            { codec_type: "audio", width: 1, height: 1 },
            { codec_type: "video", width: 640, height: 360 },
          ],
        }),
      ),
    ).toEqual({
      title: null,
      durationSeconds: 10.5,
      width: 640,
      height: 360,
      videoFormat: "MATROSKA",
    });
  });
});
