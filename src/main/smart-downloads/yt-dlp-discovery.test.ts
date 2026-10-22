import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  normalizeChannelInput,
  YtDlpChannelDiscovery,
} from "./yt-dlp-discovery";

function metadataProcess(metadata: unknown): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    exitCode: number | null;
    kill: () => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 1;
  child.exitCode = null;
  child.kill = () => true;
  queueMicrotask(() => {
    child.stdout.write(JSON.stringify(metadata));
    child.stdout.end();
    child.emit("close", 0, null);
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

describe("YtDlpChannelDiscovery", () => {
  it("normalizes supported handles and rejects non-YouTube inputs", () => {
    expect(normalizeChannelInput("@Chromecraft")).toBe(
      "https://www.youtube.com/@Chromecraft",
    );
    expect(() => normalizeChannelInput("https://example.com/@bad")).toThrow(
      /only youtube/i,
    );
  });

  it("extracts canonical channel and bounded recent video metadata", async () => {
    const discovery = new YtDlpChannelDiscovery({
      executable: "yt-dlp",
      denoPath: "deno",
      spawnProcess: () =>
        metadataProcess({
          channel_id: "UC1234567890123456789012",
          channel: "Chromecraft",
          uploader_id: "@Chromecraft",
          channel_url:
            "https://www.youtube.com/channel/UC1234567890123456789012",
          entries: [
            {
              id: "abcdefghijk",
              title: "A new upload",
              timestamp: 1_700_000_000,
            },
          ],
        }),
    });

    await expect(
      discovery.resolveChannel("@Chromecraft", 15),
    ).resolves.toMatchObject({
      channelId: "UC1234567890123456789012",
      title: "Chromecraft",
      handle: "@Chromecraft",
      recentVideos: [
        {
          videoId: "abcdefghijk",
          title: "A new upload",
          publishedAt: 1_700_000_000_000,
        },
      ],
    });
  });
});
