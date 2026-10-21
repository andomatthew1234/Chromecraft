import "./extension-install-banner.css";

export type ExtensionInstallBannerState =
  | "available"
  | "reviewing"
  | "awaiting-confirmation"
  | "installing"
  | "installed"
  | "installed-disabled"
  | "updating"
  | "updated"
  | "removing"
  | "removed"
  | "unsupported"
  | "error";

export interface ExtensionInstallBannerMetadata {
  name: string;
  description?: string | null;
  version?: string | null;
  extensionId?: string | null;
  sourceLabel?: string | null;
}

export interface ExtensionInstallBannerAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export interface ExtensionInstallBannerProps {
  metadata: ExtensionInstallBannerMetadata;
  state: ExtensionInstallBannerState;
  /** A truthful, user-facing description of the current backend state. */
  status?: string | null;
  /** Real operation completion from 0 to 100, or null when indeterminate. */
  progress?: number | null;
  primaryAction?: ExtensionInstallBannerAction | null;
  secondaryAction?: ExtensionInstallBannerAction | null;
  removeAction?: ExtensionInstallBannerAction | null;
  onDismiss: () => void;
  className?: string;
}

const busyStates = new Set<ExtensionInstallBannerState>([
  "reviewing",
  "installing",
  "updating",
  "removing",
]);

const stateContent: Record<
  ExtensionInstallBannerState,
  { icon: string; label: string }
> = {
  available: { icon: "extension", label: "Available to install" },
  reviewing: { icon: "verified", label: "Reviewing package" },
  "awaiting-confirmation": {
    icon: "fact_check",
    label: "Ready for your review",
  },
  installing: { icon: "download", label: "Installing" },
  installed: { icon: "check_circle", label: "Already installed" },
  "installed-disabled": { icon: "pause_circle", label: "Installed, off" },
  updating: { icon: "sync", label: "Updating" },
  updated: { icon: "check_circle", label: "Updated" },
  removing: { icon: "delete", label: "Removing" },
  removed: { icon: "delete", label: "Removed" },
  unsupported: { icon: "extension_off", label: "Not supported" },
  error: { icon: "error", label: "Installation failed" },
};

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function ExtensionInstallBanner({
  metadata,
  state,
  status,
  progress = null,
  primaryAction,
  secondaryAction,
  removeAction,
  onDismiss,
  className,
}: ExtensionInstallBannerProps) {
  const content = stateContent[state];
  const busy = busyStates.has(state);
  const determinateProgress =
    busy && progress !== null ? clampProgress(progress) : null;
  const description = metadata.description?.trim();
  const sourceLabel = metadata.sourceLabel?.trim() || "Chrome Web Store";
  const titleId = `extension-install-banner-title-${metadata.extensionId ?? "offer"}`;
  const statusId = `extension-install-banner-status-${metadata.extensionId ?? "offer"}`;
  const rootClassName = ["extension-install-banner", className]
    .filter(Boolean)
    .join(" ");

  return (
    <section
      className={rootClassName}
      data-state={state}
      aria-labelledby={titleId}
      aria-describedby={statusId}
      aria-busy={busy}
    >
      <span className="extension-install-banner__mark" aria-hidden="true">
        <span className="extension-install-banner__mark-texture" />
        <span className="material-icon material-symbols-rounded">
          {content.icon}
        </span>
      </span>

      <div className="extension-install-banner__copy">
        <div className="extension-install-banner__heading">
          <strong id={titleId}>{metadata.name}</strong>
          {metadata.version && <span>Version {metadata.version}</span>}
        </div>
        {description && (
          <p className="extension-install-banner__description">{description}</p>
        )}
        <div className="extension-install-banner__meta">
          <span>{sourceLabel}</span>
          <span aria-hidden="true">·</span>
          <span
            id={statusId}
            role={state === "error" ? "alert" : "status"}
            aria-live={state === "error" ? "assertive" : "polite"}
            aria-atomic="true"
          >
            {status?.trim() || content.label}
          </span>
        </div>
        {busy && (
          <div className="extension-install-banner__progress-row">
            <progress
              className="extension-install-banner__progress"
              max={100}
              value={determinateProgress ?? undefined}
              aria-label={status?.trim() || content.label}
            />
            {determinateProgress !== null && (
              <span aria-hidden="true">{Math.round(determinateProgress)}%</span>
            )}
          </div>
        )}
      </div>

      <div className="extension-install-banner__actions">
        {removeAction && (
          <button
            type="button"
            className="extension-install-banner__button extension-install-banner__button--danger"
            onClick={removeAction.onClick}
            disabled={removeAction.disabled || busy}
            aria-label={removeAction.ariaLabel}
          >
            {removeAction.label}
          </button>
        )}
        {secondaryAction && (
          <button
            type="button"
            className="extension-install-banner__button extension-install-banner__button--tonal"
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled || busy}
            aria-label={secondaryAction.ariaLabel}
          >
            {secondaryAction.label}
          </button>
        )}
        {primaryAction && (
          <button
            type="button"
            className="extension-install-banner__button extension-install-banner__button--filled"
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled || busy}
            aria-label={primaryAction.ariaLabel}
          >
            {primaryAction.label}
          </button>
        )}
      </div>

      <button
        type="button"
        className="extension-install-banner__dismiss"
        onClick={onDismiss}
        aria-label={`Dismiss install banner for ${metadata.name}`}
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
