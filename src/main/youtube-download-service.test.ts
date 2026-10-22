import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildYtDlpArguments,
  parseYtDlpFileLine,
  parseYtDlpProgressLine,
} from "./youtube-download-service";

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
    expect(args).toContain("after_move:CHROMECRAFT_FILE:%(filepath)j");
    expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(args.join(" ")).not.toContain("list=ignored");
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
      filename: "video.mp4",
    });
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
});
