import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { YouTubeDownloadsSnapshot } from "../shared/browser";

import {
  buildYtDlpArguments,
  isYtDlpPostprocessLine,
  parseYtDlpFileLine,
  parseYtDlpInfoJson,
  parseYtDlpProgressLine,
  YouTubeDownloadService,
} from "./youtube-download-service";

function fakeChildProcess(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    exitCode: number | null;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 0;
  child.exitCode = null;
  return child as unknown as ChildProcessWithoutNullStreams;
}

describe("YouTubeDownloadService helpers", () => {
  it("builds a fixed, no-shell argument list from a canonical video id", () => {
    const args = buildYtDlpArguments(
      {
        videoId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=ignored",
      },
      path.resolve("staging"),
      path.resolve("deno"),
    );
    expect(args).toContain("--ignore-config");
    expect(args).toContain("--no-update");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--encoding");
    expect(args).toContain("utf-8");
    expect(args).toContain("0.1");
    expect(args).toContain("--write-thumbnail");
    expect(args).toContain("--write-info-json");
    expect(args).toContain("postprocess:CHROMECRAFT_POSTPROCESS:%(progress)j");
    expect(args).toContain("after_move:CHROMECRAFT_FILE:%(filepath)j");
    expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(args.join(" ")).not.toContain("list=ignored");
  });

  it("extracts bounded source metadata from the yt-dlp sidecar", () => {
    expect(
      parseYtDlpInfoJson({
        title: "Original source title",
        duration: 62.5,
        width: 1920,
        height: 1080,
        ext: "mp4",
        format_note: "1080p",
      }),
    ).toEqual({
      title: "Original source title",
      durationSeconds: 62.5,
      width: 1920,
      height: 1080,
      videoFormat: "MP4 · 1080p",
    });
    expect(parseYtDlpInfoJson({ unexpected: true })).toBeNull();
  });

  it("applies a bounded quality ceiling without shell interpolation", () => {
    const args = buildYtDlpArguments(
      {
        videoId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
      path.resolve("staging"),
      path.resolve("deno"),
      "720p",
    );
    expect(args[args.indexOf("--format") + 1]).toBe(
      "best[height<=720][ext=mp4]/best[height<=720]/best",
    );
    expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("parses bounded structured progress", () => {
    expect(
      parseYtDlpProgressLine(
        'CHROMECRAFT_PROGRESS:{"downloaded_bytes":50,"total_bytes":100,"_percent_str":" 50.0%","filename":"C:/tmp/video.mp4"}',
      ),
    ).toEqual({
      receivedBytes: 50,
      totalBytes: 100,
      percent: 50,
      bytesPerSecond: null,
      etaSeconds: null,
      filename: "video.mp4",
    });
  });

  it("parses transfer rate and ETA without reporting stream completion", () => {
    expect(
      parseYtDlpProgressLine(
        'CHROMECRAFT_PROGRESS:{"downloaded_bytes":100,"total_bytes":100,"_percent_str":"100%","speed":2048,"eta":0}',
      ),
    ).toMatchObject({
      percent: 99,
      bytesPerSecond: 2048,
      etaSeconds: 0,
    });
  });

  it("recognises only structured post-processing progress", () => {
    expect(
      isYtDlpPostprocessLine('CHROMECRAFT_POSTPROCESS:{"status":"started"}'),
    ).toBe(true);
    expect(isYtDlpPostprocessLine("CHROMECRAFT_POSTPROCESS:{bad")).toBe(false);
    expect(isYtDlpPostprocessLine("[Merger] Merging formats")).toBe(false);
  });

  it("ignores malformed and unrelated output", () => {
    expect(parseYtDlpProgressLine("[download] 50%")).toBeNull();
    expect(parseYtDlpProgressLine("CHROMECRAFT_PROGRESS:{bad")).toBeNull();
  });

  it("parses Unicode output paths without relying on the Windows code page", () => {
    expect(
      parseYtDlpFileLine(
        'CHROMECRAFT_FILE:"C:\\\\Downloads\\\\I\\u2019ve Killed My MacBook Air.mp4"',
      ),
    ).toBe("C:\\Downloads\\I’ve Killed My MacBook Air.mp4");
    expect(parseYtDlpFileLine("CHROMECRAFT_FILE:not-json")).toBeNull();
    expect(parseYtDlpFileLine("unrelated output")).toBeNull();
  });

  it("throttles progress snapshots and supports cancellation and retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "chromecraft-youtube-service-"),
    );
    const children: ChildProcessWithoutNullStreams[] = [];
    const changes: YouTubeDownloadsSnapshot[] = [];
    const service = new YouTubeDownloadService({
      downloadsDirectory: directory,
      toolsDirectory: path.join(directory, "tools"),
      spawnProcess: () => {
        const child = fakeChildProcess();
        children.push(child);
        return child;
      },
      onChange: (snapshot) => changes.push(snapshot),
    });
    (service as unknown as { verified: boolean }).verified = true;

    try {
      const id = await service.start({
        videoId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      });
      expect(service.snapshot.items[0]).toMatchObject({
        id,
        stage: "pending",
        bytesPerSecond: null,
        etaSeconds: null,
      });

      (children[0].stdout as PassThrough).write(
        'CHROMECRAFT_PROGRESS:{"downloaded_bytes":25,"total_bytes":100,"_percent_str":"25%","speed":4096,"eta":3}\n',
      );
      (children[0].stdout as PassThrough).write(
        'CHROMECRAFT_PROGRESS:{"downloaded_bytes":50,"total_bytes":100,"_percent_str":"50%","speed":8192,"eta":1}\n',
      );
      expect(changes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(changes).toHaveLength(2);
      expect(service.snapshot.items[0]).toMatchObject({
        stage: "downloading",
        percent: 50,
        bytesPerSecond: 8192,
        etaSeconds: 1,
      });

      (children[0].stdout as PassThrough).write(
        'CHROMECRAFT_POSTPROCESS:{"status":"started"}\n',
      );
      expect(service.snapshot.items[0]).toMatchObject({
        stage: "finishing",
        percent: null,
        bytesPerSecond: null,
        etaSeconds: null,
      });

      await expect(service.cancel(id)).resolves.toBe(true);
      expect(service.snapshot.items[0].stage).toBe("cancelled");
      const retryId = await service.retry(id);
      expect(retryId).not.toBe(id);
      expect(children).toHaveLength(2);
      expect(service.snapshot.items[0].stage).toBe("pending");
    } finally {
      await service.dispose();
      vi.useRealTimers();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a crash as an interrupted, retryable download and cleans staging", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "chromecraft-youtube-recovery-"),
    );
    const id = "0c345b6f-0638-4d5f-9ef4-3ff89b56f80b";
    const staging = path.join(directory, ".chromecraft-media", id);
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(
      path.join(staging, "job.json"),
      JSON.stringify({
        version: 1,
        id,
        videoId: "dQw4w9WgXcQ",
        sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        startedAt: 42,
      }),
    );
    const service = new YouTubeDownloadService({
      downloadsDirectory: directory,
      toolsDirectory: path.join(directory, "tools"),
      spawnProcess: () => fakeChildProcess(),
    });
    (service as unknown as { verified: boolean }).verified = true;
    try {
      await (
        service as unknown as { recoverInterruptedJobs(): Promise<void> }
      ).recoverInterruptedJobs();
      expect(service.snapshot.items[0]).toMatchObject({
        id,
        stage: "interrupted",
        videoId: "dQw4w9WgXcQ",
      });
      await expect(fs.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(service.retry(id)).resolves.not.toBe(id);
    } finally {
      await service.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves recovery state when the browser closes during a download", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "chromecraft-youtube-close-recovery-"),
    );
    const service = new YouTubeDownloadService({
      downloadsDirectory: directory,
      toolsDirectory: path.join(directory, "tools"),
      spawnProcess: () => fakeChildProcess(),
    });
    (service as unknown as { verified: boolean }).verified = true;
    try {
      const id = await service.start({
        videoId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      });
      await service.dispose();
      await expect(
        fs.stat(path.join(directory, ".chromecraft-media", id, "job.json")),
      ).resolves.toBeTruthy();

      const restored = new YouTubeDownloadService({
        downloadsDirectory: directory,
        toolsDirectory: path.join(directory, "tools"),
        spawnProcess: () => fakeChildProcess(),
      });
      (restored as unknown as { verified: boolean }).verified = true;
      await (
        restored as unknown as { recoverInterruptedJobs(): Promise<void> }
      ).recoverInterruptedJobs();
      expect(restored.snapshot.items).toHaveLength(1);
      expect(restored.snapshot.items[0]).toMatchObject({
        id,
        stage: "interrupted",
      });
      await restored.dispose();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("retains original artwork and source metadata before cleaning staging", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "chromecraft-youtube-completion-"),
    );
    const thumbnails = path.join(directory, "profile", "thumbnails");
    const child = fakeChildProcess();
    const onCompleted = vi.fn(async () => true);
    const service = new YouTubeDownloadService({
      downloadsDirectory: directory,
      thumbnailDirectory: thumbnails,
      toolsDirectory: path.join(directory, "tools"),
      spawnProcess: () => child,
      onCompleted,
    });
    (service as unknown as { verified: boolean }).verified = true;
    try {
      const id = await service.start({
        videoId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      });
      const staging = path.join(directory, ".chromecraft-media", id);
      const media = path.join(staging, "Source title [dQw4w9WgXcQ].mp4");
      await fs.writeFile(media, "video");
      await fs.writeFile(
        path.join(staging, "Source title [dQw4w9WgXcQ].webp"),
        "RIFF0000WEBPoriginal",
      );
      await fs.writeFile(
        path.join(staging, "Source title [dQw4w9WgXcQ].info.json"),
        JSON.stringify({
          title: "Source title",
          duration: 30,
          width: 1280,
          height: 720,
          ext: "mp4",
          format_note: "720p",
        }),
      );
      (child.stdout as PassThrough).write(
        `CHROMECRAFT_FILE:${JSON.stringify(media)}\n`,
      );
      child.emit("close", 0, null);

      await vi.waitFor(() => {
        expect(service.snapshot.items[0].stage).toBe("completed");
      });
      expect(onCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: "dQw4w9WgXcQ" }),
        expect.stringContaining("Source title [dQw4w9WgXcQ].mp4"),
        expect.objectContaining({
          thumbnailPath: path.join(thumbnails, "dQw4w9WgXcQ.webp"),
          mediaMetadata: {
            title: "Source title",
            durationSeconds: 30,
            width: 1280,
            height: 720,
            videoFormat: "MP4 · 720p",
          },
        }),
      );
      await expect(
        fs.readFile(path.join(thumbnails, "dQw4w9WgXcQ.webp"), "utf8"),
      ).resolves.toBe("RIFF0000WEBPoriginal");
      await expect(fs.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await service.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

afterEach(() => vi.useRealTimers());
