import { describe, expect, it, vi } from "vitest";

import { AppMetricsCollector } from "./app-metrics-collector";

describe("AppMetricsCollector", () => {
  it("warms up CPU, converts KiB once, and preserves multicore totals", () => {
    let now = 1_000;
    const read = vi.fn(
      () =>
        [
          {
            pid: 7,
            creationTime: 10,
            type: "Tab",
            cpu: { percentCPUUsage: 145.2, idleWakeupsPerSecond: 0 },
            memory: {
              workingSetSize: 20,
              peakWorkingSetSize: 25,
              privateBytes: 10,
            },
          },
        ] as Electron.ProcessMetric[],
    );
    const collector = new AppMetricsCollector(
      read,
      () => now,
      () => 1_000_000,
    );
    expect(collector.sample().processes[0]).toMatchObject({
      cpuPercent: null,
      memoryBytes: 10 * 1_024,
    });
    now += 1_000;
    expect(collector.sample().processes[0]?.cpuPercent).toBe(145.2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares a cached sample with browser snapshots", () => {
    let now = 1_000;
    const read = vi.fn(() => [] as Electron.ProcessMetric[]);
    const collector = new AppMetricsCollector(
      read,
      () => now,
      () => 0,
    );
    collector.memoryByProcessId();
    now += 200;
    collector.memoryByProcessId();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
