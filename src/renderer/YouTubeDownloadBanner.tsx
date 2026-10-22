import type { YouTubeDownloadItemSnapshot } from "../shared/browser";

import "./youtube-download-banner.css";

export interface YouTubeDownloadBannerProps {
  available: boolean;
  download: YouTubeDownloadItemSnapshot | null;
  onDownload: () => void;
  onDismiss: () => void;
}

function bannerCopy(
  available: boolean,
  download: YouTubeDownloadItemSnapshot | null,
): string {
  if (!available) return "YouTube downloads are unavailable in this build";
  if (!download) return "Download this video for later?";
  if (download.stage === "pending") return "Preparing download…";
  if (download.stage === "downloading") {
    return download.percent === null
      ? "Downloading video…"
      : `Downloading video… ${Math.round(download.percent)}%`;
  }
  if (download.stage === "finishing") return "Finishing download…";
  if (download.stage === "completed")
    return download.filename
      ? `Saved ${download.filename}`
      : "Video saved to Downloads";
  if (download.stage === "failed")
    return download.error || "The video could not be downloaded.";
  return "Download cancelled";
}

export function YouTubeDownloadBanner({
  available,
  download,
  onDownload,
  onDismiss,
}: YouTubeDownloadBannerProps) {
  const busy =
    download?.stage === "pending" ||
    download?.stage === "downloading" ||
    download?.stage === "finishing";
  const completed = download?.stage === "completed";
  const failed =
    download?.stage === "failed" || download?.stage === "cancelled";
  const label = bannerCopy(available, download);

  return (
    <section
      className="youtube-download-banner"
      data-state={download?.stage ?? "available"}
      aria-label="YouTube video download"
      aria-busy={busy}
    >
      <span className="youtube-download-banner__icon" aria-hidden="true">
        <span className="material-icon material-symbols-rounded">
          {completed ? "download_done" : failed ? "error" : "download"}
        </span>
      </span>
      <span
        className="youtube-download-banner__copy"
        role="status"
        aria-live="polite"
      >
        {label}
      </span>
      {busy && (
        <progress
          className="youtube-download-banner__progress"
          max={100}
          value={download?.percent ?? undefined}
          aria-label={label}
        />
      )}
      {!busy && !completed && (
        <button
          type="button"
          className="youtube-download-banner__download"
          onClick={onDownload}
          disabled={!available}
        >
          {failed ? "Retry" : "Download"}
        </button>
      )}
      {completed && (
        <span className="youtube-download-banner__complete" aria-hidden="true">
          Saved
        </span>
      )}
      <button
        type="button"
        className="youtube-download-banner__close"
        onClick={onDismiss}
        aria-label="Close YouTube download banner"
      >
        <span
          className="material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          close
        </span>
      </button>
    </section>
  );
}
