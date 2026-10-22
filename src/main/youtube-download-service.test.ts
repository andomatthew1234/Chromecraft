import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildYtDlpArguments,
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
});
