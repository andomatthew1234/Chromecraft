import { useEffect, useMemo, useState } from "react";

import type {
  YouTubeDownloadItemSnapshot,
  YouTubeDownloadsSnapshot,
} from "../shared/browser";

import "./youtube-download-progress.css";

function active(item: YouTubeDownloadItemSnapshot): boolean {
  return ["pending", "downloading", "finishing"].includes(item.stage);
}

export function shouldRaiseDownloadOverlay(
  expanded: boolean,
  primary: YouTubeDownloadItemSnapshot | null,
  hiddenTerminalId: string | null,
): boolean {
  return Boolean(
    expanded && primary && (active(primary) || hiddenTerminalId !== primary.id),
  );
}

function status(item: YouTubeDownloadItemSnapshot): string {
  if (item.stage === "pending") return "Preparing download…";
  if (item.stage === "downloading")
    return item.percent === null
      ? "Downloading video…"
      : `Downloading video… ${Math.round(item.percent)}%`;
  if (item.stage === "finishing") return "Finalising video…";
  if (item.stage === "completed")
    return item.savedToGallery ? "Saved to My Gallery" : "Saved to Downloads";
  if (item.stage === "interrupted") return "Download interrupted";
  if (item.stage === "cancelled") return "Download cancelled";
  return item.error || "Download failed";
}

function detail(item: YouTubeDownloadItemSnapshot): string | null {
  const bits: string[] = [];
  if (item.receivedBytes > 0) bits.push(formatBytes(item.receivedBytes));
  if (item.totalBytes > 0) bits.push(`of ${formatBytes(item.totalBytes)}`);
  if (item.bytesPerSecond) bits.push(`${formatBytes(item.bytesPerSecond)}/s`);
  if (item.etaSeconds !== null)
    bits.push(`${formatTime(item.etaSeconds)} left`);
  return bits.length ? bits.join(" ") : null;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatTime(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  return rounded >= 60
    ? `${Math.floor(rounded / 60)}m ${rounded % 60}s`
    : `${rounded}s`;
}

export function YouTubeDownloadProgress({
  snapshot,
  onCancel,
  onRetry,
  onOpenGallery,
  onOpenFile,
  onDismiss,
  onExpandedChange,
}: {
  snapshot: YouTubeDownloadsSnapshot;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onOpenGallery: () => void;
  onOpenFile: (id: string) => void;
  onDismiss: (id: string) => void;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hiddenTerminalId, setHiddenTerminalId] = useState<string | null>(null);
  const items = useMemo(
    () =>
      [...snapshot.items].sort((a, b) => b.startedAt - a.startedAt).slice(0, 8),
    [snapshot.items],
  );
  const activeItems = items.filter(active);
  const primary = activeItems[0] ?? items[0] ?? null;
  useEffect(() => {
    if (!primary || active(primary)) return;
    setHiddenTerminalId(null);
    const timer = window.setTimeout(
      () => setHiddenTerminalId(primary.id),
      5_000,
    );
    return () => clearTimeout(timer);
  }, [primary?.id, primary?.stage]);
  const raisesOverlay = shouldRaiseDownloadOverlay(
    expanded,
    primary,
    hiddenTerminalId,
  );
  useEffect(() => {
    onExpandedChange?.(raisesOverlay);
    return () => onExpandedChange?.(false);
  }, [raisesOverlay, onExpandedChange]);
  if (!primary || (hiddenTerminalId === primary.id && !active(primary)))
    return null;
  const indeterminate =
    primary.stage === "pending" ||
    primary.stage === "finishing" ||
    (primary.stage === "downloading" && primary.percent === null);
  return (
    <section
      className="youtube-global-progress"
      data-state={primary.stage}
      aria-label="Video download progress"
    >
      <button
        type="button"
        className="youtube-global-progress__summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span
          className="material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          {primary.stage === "completed"
            ? "download_done"
            : primary.stage === "failed"
              ? "error"
              : "downloading"}
        </span>
        <span className="youtube-global-progress__copy">
          <strong>{status(primary)}</strong>
          {detail(primary) && <small>{detail(primary)}</small>}
        </span>
        {activeItems.length > 1 && (
          <span className="youtube-global-progress__count">
            {activeItems.length}
          </span>
        )}
        <span
          className="material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          {expanded ? "expand_less" : "expand_more"}
        </span>
      </button>
      <div
        className={`youtube-global-progress__track ${indeterminate ? "is-indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          primary.percent === null ? undefined : Math.round(primary.percent)
        }
      >
        <span
          style={{
            width: indeterminate ? undefined : `${primary.percent ?? 100}%`,
          }}
        />
      </div>
      {expanded && (
        <div className="youtube-global-progress__list">
          {items.map((item) => (
            <article key={item.id}>
              <span
                className="material-icon material-symbols-rounded"
                aria-hidden="true"
              >
                {item.stage === "completed" ? "check_circle" : "movie"}
              </span>
              <span>
                <strong>
                  {item.filename || `YouTube video ${item.videoId}`}
                </strong>
                <small>{status(item)}</small>
              </span>
              {active(item) && (
                <button type="button" onClick={() => onCancel(item.id)}>
                  Cancel
                </button>
              )}
              {(["failed", "cancelled", "interrupted"] as const).includes(
                item.stage as "failed" | "cancelled" | "interrupted",
              ) && (
                <button type="button" onClick={() => onRetry(item.id)}>
                  Retry
                </button>
              )}
              {item.stage === "completed" && (
                <>
                  <button type="button" onClick={() => onOpenFile(item.id)}>
                    Open file
                  </button>
                  {item.savedToGallery && (
                    <button type="button" onClick={onOpenGallery}>
                      Open gallery
                    </button>
                  )}
                </>
              )}
              {!active(item) && (
                <button type="button" onClick={() => onDismiss(item.id)}>
                  Dismiss
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
