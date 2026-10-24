import os from "node:os";

import { app } from "electron";

import type { PerformanceProcessInput } from "../shared/performance-centre";

export interface AppMetricsSample {
  sampledAt: number;
  processes: PerformanceProcessInput[];
  systemMemoryBytes: number | null;
}

type RawMetric = ReturnType<typeof app.getAppMetrics>[number];

export class AppMetricsCollector {
  private sampledAt = 0;
  private samples = 0;
  private processes: PerformanceProcessInput[] = [];

  constructor(
    private readonly readMetrics: () => RawMetric[] = () => app.getAppMetrics(),
    private readonly now: () => number = Date.now,
    private readonly totalMemory: () => number = () => os.totalmem(),
  ) {}

  sample(maxAgeMs = 0): AppMetricsSample {
    const currentTime = this.now();
    if (this.sampledAt > 0 && currentTime - this.sampledAt < maxAgeMs) {
      return this.snapshot;
    }
    const isWarmup = this.samples === 0;
    try {
      this.processes = this.readMetrics().map((metric) => ({
        pid: metric.pid,
        creationTime: metric.creationTime,
        type: metric.type,
        name: metric.name ?? metric.serviceName,
        cpuPercent: isWarmup ? null : finiteOrNull(metric.cpu.percentCPUUsage),
        memoryBytes: memoryBytes(metric),
      }));
      this.sampledAt = currentTime;
      this.samples += 1;
    } catch {
      this.processes = [];
      this.sampledAt = currentTime;
      this.samples += 1;
    }
    return this.snapshot;
  }

  get snapshot(): AppMetricsSample {
    const total = this.totalMemory();
    return {
      sampledAt: this.sampledAt,
      processes: this.processes.map((process) => ({ ...process })),
      systemMemoryBytes:
        Number.isFinite(total) && total > 0 ? Math.round(total) : null,
    };
  }

  memoryByProcessId(maxAgeMs = 1_000): ReadonlyMap<number, number> {
    const sample = this.sample(maxAgeMs);
    return new Map(
      sample.processes.flatMap((process) =>
        process.memoryBytes === null
          ? []
          : ([[process.pid, process.memoryBytes]] as const),
      ),
    );
  }
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function memoryBytes(metric: RawMetric): number | null {
  const kilobytes = metric.memory.privateBytes ?? metric.memory.workingSetSize;
  return Number.isFinite(kilobytes) && kilobytes >= 0
    ? Math.round(kilobytes * 1_024)
    : null;
}
