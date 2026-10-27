import { describe, expect, it } from "vitest";

import {
  parseReleaseCategory,
  releaseSnapshot,
} from "./electron-update-adapter";

describe("parseReleaseCategory", () => {
  it("reads each supported release category from the bounded metadata comment", () => {
    for (const category of ["chromecraft", "dependencies", "both"] as const) {
      expect(
        parseReleaseCategory(
          `Notes\n<!-- chromecraft-update:{"category":"${category}"} -->`,
        ),
      ).toBe(category);
    }
  });

  it("uses both for absent, malformed or unsupported metadata", () => {
    expect(parseReleaseCategory(null)).toBe("both");
    expect(parseReleaseCategory("ordinary notes")).toBe("both");
    expect(
      parseReleaseCategory(
        '<!-- chromecraft-update:{"category":"unknown"} -->',
      ),
    ).toBe("both");
    expect(parseReleaseCategory("<!-- chromecraft-update:{ -->")).toBe("both");
  });
});

describe("releaseSnapshot", () => {
  it("uses GitHub metadata only when it describes the downloaded release", () => {
    expect(
      releaseSnapshot("v0.2.0", "Squirrel notes", new Date("2026-01-01"), {
        version: "0.2.0",
        category: "dependencies",
        releaseNotes: "Verified engine update",
        publishedAt: "2026-01-02T00:00:00.000Z",
        downloadSizeBytes: 2048,
      }),
    ).toEqual({
      version: "0.2.0",
      category: "dependencies",
      releaseNotes: "Verified engine update",
      publishedAt: "2026-01-02T00:00:00.000Z",
      downloadSizeBytes: 2048,
    });
  });

  it("falls back to Squirrel data when latest GitHub metadata is for another version", () => {
    expect(
      releaseSnapshot(
        "v0.2.0",
        'Native notes\n<!-- chromecraft-update:{"category":"chromecraft"} -->',
        new Date("2026-01-01T00:00:00.000Z"),
        {
          version: "0.3.0",
          category: "dependencies",
          releaseNotes: "Notes for a different package",
          publishedAt: "2026-02-01T00:00:00.000Z",
          downloadSizeBytes: 4096,
        },
      ),
    ).toEqual({
      version: "0.2.0",
      category: "chromecraft",
      releaseNotes: "Native notes",
      publishedAt: "2026-01-01T00:00:00.000Z",
      downloadSizeBytes: null,
    });
  });
});
