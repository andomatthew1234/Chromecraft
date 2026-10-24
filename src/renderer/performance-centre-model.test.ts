import { describe, expect, it } from "vitest";

import type { PerformanceTaskRow } from "../shared/performance-centre";
import {
  filterPerformanceRows,
  formatPerformanceCpu,
  formatPerformanceMemory,
  sortPerformanceRows,
} from "./performance-centre-model";

function row(
  id: string,
  memoryBytes: number | null,
  cpuPercent: number | null,
  title = id,
): PerformanceTaskRow {
  return {
    id,
    pid: Number(id.replace(/\D/gu, "")) || 1,
    kind: "renderer",
    taskType: "Tab",
    title,
    subtitle: "example.test",
    cpuPercent,
    memoryBytes,
    networkBytesPerSecond: null,
    javascriptMemoryBytes: null,
    status: "running",
    protected: false,
    canEndProcess: true,
    affectedTabCount: 1,
    children: [
      {
        id: `tab-${id}`,
        kind: "tab",
        title: "Child page",
        subtitle: "child.test",
        faviconDataUrl: null,
        active: false,
        crashed: false,
      },
    ],
  };
}

describe("Performance Centre view model", () => {
  it("sorts memory descending stably and keeps unavailable values last", () => {
    const rows = [row("p1", 20, 1), row("p2", null, 2), row("p3", 20, 3)];
    expect(
      sortPerformanceRows(rows, {
        column: "memory",
        direction: "descending",
      }).map((item) => item.id),
    ).toEqual(["p1", "p3", "p2"]);
  });

  it("searches process and child tab identity", () => {
    expect(
      filterPerformanceRows([row("p1", 20, 1)], "CHILD.TEST"),
    ).toHaveLength(1);
    expect(filterPerformanceRows([row("p1", 20, 1)], "missing")).toHaveLength(
      0,
    );
  });

  it("formats process metrics without clamping multicore CPU", () => {
    expect(formatPerformanceCpu(145.2)).toBe("145%");
    expect(formatPerformanceCpu(null)).toBe("—");
    expect(formatPerformanceMemory(1024 ** 3)).toBe("1.00 GB");
    expect(formatPerformanceMemory(null)).toBe("—");
  });
});
