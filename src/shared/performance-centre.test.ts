import { describe, expect, it } from "vitest";

import {
  buildPerformanceRows,
  isPerformanceAction,
} from "./performance-centre";

describe("Performance Centre process model", () => {
  it("groups shared tabs beneath one renderer without duplicating memory", () => {
    const rows = buildPerformanceRows(
      [
        {
          pid: 42,
          creationTime: 100,
          type: "Tab",
          cpuPercent: 12.5,
          memoryBytes: 256,
        },
      ],
      [
        {
          id: "a",
          title: "A",
          hostname: "a.test",
          faviconDataUrl: null,
          processId: 42,
          active: true,
          crashed: false,
        },
        {
          id: "b",
          title: "B",
          hostname: "b.test",
          faviconDataUrl: null,
          processId: 42,
          active: false,
          crashed: false,
        },
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "process:42:100",
      memoryBytes: 256,
      affectedTabCount: 2,
      canEndProcess: true,
    });
    expect(rows[0]?.children.map((child) => child.id)).toEqual(["a", "b"]);
  });

  it("protects main and unattributed renderer processes", () => {
    const rows = buildPerformanceRows(
      [
        {
          pid: 1,
          creationTime: 1,
          type: "Browser",
          cpuPercent: 1,
          memoryBytes: 10,
        },
        {
          pid: 2,
          creationTime: 2,
          type: "Tab",
          cpuPercent: 1,
          memoryBytes: 10,
        },
      ],
      [],
    );
    expect(rows.every((row) => row.protected && !row.canEndProcess)).toBe(true);
  });

  it("accepts only narrow action shapes and opaque process identities", () => {
    expect(
      isPerformanceAction({ type: "end-process", processId: "process:42:100" }),
    ).toBe(true);
    expect(isPerformanceAction({ type: "end-process", pid: 42 })).toBe(false);
    expect(isPerformanceAction({ type: "close-tab", tabId: "a" })).toBe(true);
  });
});
