import { describe, expect, it } from "vitest";

import type { DownloadRecord } from "../shared/browser";
import {
  deriveDownloadIndicator,
  didAnyDownloadComplete,
} from "./download-indicator";

function download(
  state: DownloadRecord["state"],
  receivedBytes: number,
  totalBytes: number,
): DownloadRecord {
  return {
    id: `${state}-${receivedBytes}`,
    filename: "file.bin",
    sourceUrl: "https://example.test/file.bin",
    savePath: "C:\\Downloads\\file.bin",
    receivedBytes,
    totalBytes,
    state,
    startedAt: 1,
    finishedAt: state === "completed" ? 2 : null,
    danger: null,
  };
}

describe("deriveDownloadIndicator", () => {
  it("is idle when only terminal downloads exist", () => {
    expect(deriveDownloadIndicator([download("completed", 100, 100)])).toEqual({
      unfinishedCount: 0,
      progressingCount: 0,
      percent: null,
    });
  });

  it("uses byte-weighted aggregate progress", () => {
    expect(
      deriveDownloadIndicator([
        download("progressing", 50, 100),
        download("paused", 100, 300),
      ]),
    ).toEqual({ unfinishedCount: 2, progressingCount: 1, percent: 37.5 });
  });

  it("is indeterminate when any unfinished size is unknown", () => {
    expect(
      deriveDownloadIndicator([
        download("progressing", 50, 100),
        download("progressing", 2, 0),
      ]),
    ).toEqual({ unfinishedCount: 2, progressingCount: 2, percent: null });
  });

  it("clamps invalid received byte counts", () => {
    expect(
      deriveDownloadIndicator([
        download("progressing", 150, 100),
        download("paused", -20, 100),
      ]).percent,
    ).toBe(50);
  });

  it("only reports a completion after an active-to-completed transition", () => {
    const completed = download("completed", 100, 100);
    expect(didAnyDownloadComplete(null, [completed])).toBe(false);
    expect(
      didAnyDownloadComplete(new Map([[completed.id, "completed"]]), [
        completed,
      ]),
    ).toBe(false);
    expect(
      didAnyDownloadComplete(new Map([[completed.id, "progressing"]]), [
        completed,
      ]),
    ).toBe(true);
  });
});
