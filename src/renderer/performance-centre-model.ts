import type { PerformanceTaskRow } from "../shared/performance-centre";

export type PerformanceSortColumn =
  | "task"
  | "cpu"
  | "memory"
  | "pid"
  | "type"
  | "status";

export interface PerformanceSort {
  column: PerformanceSortColumn;
  direction: "ascending" | "descending";
}

export function filterPerformanceRows(
  rows: readonly PerformanceTaskRow[],
  query: string,
): PerformanceTaskRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    [
      row.title,
      row.subtitle,
      row.taskType,
      row.kind,
      String(row.pid),
      ...row.children.flatMap((child) => [child.title, child.subtitle]),
    ].some((value) => value.toLocaleLowerCase().includes(needle)),
  );
}

export function sortPerformanceRows(
  rows: readonly PerformanceTaskRow[],
  sort: PerformanceSort,
): PerformanceTaskRow[] {
  const originalIndex = new Map(rows.map((row, index) => [row.id, index]));
  const factor = sort.direction === "ascending" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = valueForSort(left, sort.column);
    const rightValue = valueForSort(right, sort.column);
    let compared = 0;
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      compared = leftValue - rightValue;
    } else if (leftValue === null && rightValue !== null) {
      return 1;
    } else if (leftValue !== null && rightValue === null) {
      return -1;
    } else {
      compared = String(leftValue ?? "").localeCompare(
        String(rightValue ?? ""),
        undefined,
        { sensitivity: "base" },
      );
    }
    return compared === 0
      ? (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0)
      : compared * factor;
  });
}

function valueForSort(
  row: PerformanceTaskRow,
  column: PerformanceSortColumn,
): string | number | null {
  switch (column) {
    case "task":
      return row.title;
    case "cpu":
      return row.cpuPercent;
    case "memory":
      return row.memoryBytes;
    case "pid":
      return row.pid;
    case "type":
      return row.taskType;
    case "status":
      return row.status;
  }
}

export function formatPerformanceMemory(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function formatPerformanceCpu(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(value >= 100 ? 0 : 1)}%`;
}
