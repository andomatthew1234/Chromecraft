import type { DownloadRecord } from "../shared/browser";

export interface DownloadIndicatorState {
  unfinishedCount: number;
  progressingCount: number;
  percent: number | null;
}

export function deriveDownloadIndicator(
  items: DownloadRecord[],
): DownloadIndicatorState {
  const unfinished = items.filter(
    (item) => item.state === "progressing" || item.state === "paused",
  );
  const progressingCount = unfinished.filter(
    (item) => item.state === "progressing",
  ).length;
  if (unfinished.length === 0) {
    return { unfinishedCount: 0, progressingCount: 0, percent: null };
  }
  if (
    unfinished.some(
      (item) => !Number.isFinite(item.totalBytes) || item.totalBytes <= 0,
    )
  ) {
    return {
      unfinishedCount: unfinished.length,
      progressingCount,
      percent: null,
    };
  }

  const totalBytes = unfinished.reduce((sum, item) => sum + item.totalBytes, 0);
  const receivedBytes = unfinished.reduce(
    (sum, item) =>
      sum + Math.min(item.totalBytes, Math.max(0, item.receivedBytes)),
    0,
  );
  return {
    unfinishedCount: unfinished.length,
    progressingCount,
    percent: Math.min(100, Math.max(0, (receivedBytes / totalBytes) * 100)),
  };
}

export function didAnyDownloadComplete(
  previousStates: ReadonlyMap<string, DownloadRecord["state"]> | null,
  items: DownloadRecord[],
): boolean {
  if (!previousStates) return false;
  return items.some(
    (item) =>
      item.state === "completed" &&
      (previousStates.get(item.id) === "progressing" ||
        previousStates.get(item.id) === "paused"),
  );
}
