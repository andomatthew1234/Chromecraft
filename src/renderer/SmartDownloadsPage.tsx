import { useEffect, useState, type ReactNode } from "react";

import type {
  SmartDownloadCleanupPolicy,
  SmartDownloadsCheckResult,
  SmartDownloadsCheckSnapshot,
  SmartDownloadInitialMode,
  SmartDownloadQuality,
  SmartDownloadsSnapshot,
} from "../shared/browser";
import "./smart-downloads.css";

const GB = 1024 ** 3;

function Icon({ children }: { children: ReactNode }) {
  return (
    <span className="material-icon material-symbols-rounded" aria-hidden="true">
      {children}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < GB) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;
}

function formatTime(value: number | null): string {
  if (value === null) return "Not yet";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export function smartDownloadsCheckMessage(
  check: SmartDownloadsCheckSnapshot,
): string | null {
  if (check.state === "idle") return null;
  if (check.state === "checking") {
    if (check.totalChannels === 0) return "Preparing channel check…";
    return `Checking ${Math.min(check.checkedChannels + 1, check.totalChannels)} of ${check.totalChannels} ${check.totalChannels === 1 ? "channel" : "channels"}…`;
  }
  if (check.state === "blocked") {
    if (check.reason === "disabled") return "Smart Downloads is off";
    if (check.reason === "no-channels") return "No channels are followed yet";
    return "No followed channels are enabled";
  }
  if (check.state === "failed") return "Check failed — Retry";
  if (check.state === "partial") {
    return `${check.newVideosFound} new ${check.newVideosFound === 1 ? "video" : "videos"} found · ${check.failures} ${check.failures === 1 ? "channel" : "channels"} failed`;
  }
  if (check.newVideosFound === 0) return "No new videos found";
  return `${check.newVideosFound} new ${check.newVideosFound === 1 ? "video" : "videos"} found`;
}

function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="smart-setting-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch-input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function SmartDownloadsPage({
  snapshot,
  onBack,
}: {
  snapshot: SmartDownloadsSnapshot;
  onBack: () => void;
}) {
  const [channelInput, setChannelInput] = useState("");
  const [initialMode, setInitialMode] =
    useState<SmartDownloadInitialMode>("future");
  const [quotaGb, setQuotaGb] = useState(
    snapshot.config.storageQuotaBytes / GB,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastManualCheck, setLastManualCheck] =
    useState<SmartDownloadsCheckResult | null>(null);
  useEffect(
    () => setQuotaGb(snapshot.config.storageQuotaBytes / GB),
    [snapshot.config.storageQuotaBytes],
  );
  const run = (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    void action()
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Smart Downloads could not complete that action.",
        ),
      )
      .finally(() => setBusy(null));
  };
  const runCheck = (key: string, channelId?: string) => {
    setBusy(key);
    setError(null);
    void window.chromecraft
      .checkSmartDownloads(channelId)
      .then(setLastManualCheck)
      .catch(() =>
        setError("Smart Downloads could not check followed channels."),
      )
      .finally(() => setBusy(null));
  };
  const maximumGb = Math.max(0.5, snapshot.storage.maximumQuotaBytes / GB);
  const windowsStartupSupported =
    typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
  const storagePercent = Math.min(
    100,
    (snapshot.storage.usedBytes / Math.max(1, snapshot.storage.quotaBytes)) *
      100,
  );
  const activeJobs = snapshot.queue.filter((job) =>
    ["pending", "preparing", "downloading", "processing", "paused"].includes(
      job.state,
    ),
  );
  const displayedCheck =
    snapshot.check.state === "checking"
      ? snapshot.check
      : (lastManualCheck ?? snapshot.check);
  const checkMessage = smartDownloadsCheckMessage(displayedCheck);

  return (
    <div className="smart-downloads-page">
      <header className="smart-downloads-hero">
        <button type="button" className="smart-icon-button" onClick={onBack}>
          <Icon>arrow_back</Icon>
          <span className="visually-hidden">Back to Downloads and Gallery</span>
        </button>
        <span className="smart-downloads-hero-icon">
          <Icon>download_for_offline</Icon>
        </span>
        <span className="smart-downloads-title">
          <small>Youtube downloads + Gallery</small>
          <h2>Smart Downloads</h2>
          <p>
            Your favourite videos, automatically downloaded and ready to watch
            offline.
          </p>
        </span>
        <label className="smart-master-switch">
          <span>{snapshot.config.enabled ? "On" : "Off"}</span>
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            checked={snapshot.config.enabled}
            onChange={(event) =>
              run("master", () =>
                window.chromecraft.setSmartDownloadsEnabled(
                  event.target.checked,
                ),
              )
            }
          />
        </label>
      </header>

      {error && (
        <div className="smart-error" role="alert">
          <Icon>error</Icon>
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <section className="smart-overview" aria-label="Smart Downloads overview">
        <article>
          <Icon>hard_drive</Icon>
          <span>
            <small>Managed storage</small>
            <strong>{formatBytes(snapshot.storage.usedBytes)}</strong>
            <span>of {formatBytes(snapshot.storage.quotaBytes)}</span>
          </span>
        </article>
        <article>
          <Icon>queue</Icon>
          <span>
            <small>Download queue</small>
            <strong>{activeJobs.length}</strong>
            <span>{snapshot.queuePaused ? "Paused" : "active or waiting"}</span>
          </span>
        </article>
        <article>
          <Icon>sync</Icon>
          <span>
            <small>Last channel check</small>
            <strong>
              {snapshot.checking
                ? "Checking now"
                : formatTime(snapshot.lastCheckAt)}
            </strong>
            <span>Next: {formatTime(snapshot.nextCheckAt)}</span>
          </span>
        </article>
      </section>

      {!snapshot.config.enabled && (
        <section className="smart-disabled-note">
          <Icon>pause_circle</Icon>
          <span>
            <strong>Automatic checks are off</strong>
            <small>
              Your followed channels, downloaded videos and settings are
              preserved. Manual video downloads still work normally.
            </small>
          </span>
        </section>
      )}

      <section className="smart-section" aria-labelledby="smart-channels-title">
        <header>
          <span>
            <small>Subscriptions</small>
            <h3 id="smart-channels-title">Channels to Follow</h3>
            <p>
              New videos from these channels will be automatically downloaded.
            </p>
          </span>
          <button
            type="button"
            className="tonal-button"
            disabled={
              snapshot.checking ||
              busy === "check-all" ||
              snapshot.channels.length === 0
            }
            onClick={() => runCheck("check-all")}
          >
            <Icon>refresh</Icon>
            {snapshot.checking ? "Checking…" : "Check Smart Downloads now"}
          </button>
        </header>
        {checkMessage && (
          <div
            className={`smart-check-feedback smart-check-feedback--${displayedCheck.state}`}
            role="status"
            aria-live="polite"
          >
            <Icon>
              {displayedCheck.state === "failed" ||
              displayedCheck.state === "partial"
                ? "error"
                : displayedCheck.state === "checking"
                  ? "sync"
                  : "check_circle"}
            </Icon>
            <span>{checkMessage}</span>
          </div>
        )}
        <form
          className="smart-add-channel"
          onSubmit={(event) => {
            event.preventDefault();
            const input = channelInput.trim();
            if (!input) return;
            run("add-channel", async () => {
              await window.chromecraft.addSmartDownloadsChannel(
                input,
                initialMode,
              );
              setChannelInput("");
            });
          }}
        >
          <label>
            <Icon>add_circle</Icon>
            <input
              value={channelInput}
              onChange={(event) => setChannelInput(event.target.value)}
              placeholder="Paste a YouTube channel URL or @handle"
              aria-label="YouTube channel URL or handle"
            />
          </label>
          <select
            value={String(initialMode)}
            onChange={(event) =>
              setInitialMode(
                event.target.value === "future"
                  ? "future"
                  : (Number(event.target.value) as 1 | 3 | 5),
              )
            }
            aria-label="First-time download behaviour"
          >
            <option value="future">Future uploads only</option>
            <option value="1">Download latest 1</option>
            <option value="3">Download latest 3</option>
            <option value="5">Download latest 5</option>
          </select>
          <button
            type="submit"
            className="filled-button"
            disabled={!channelInput.trim() || busy === "add-channel"}
          >
            {busy === "add-channel" ? "Resolving…" : "Add channel"}
          </button>
        </form>
        <div className="smart-channel-list">
          {snapshot.channels.map((channel) => (
            <article className="smart-channel-card" key={channel.id}>
              <span className="smart-avatar">
                {channel.avatarUrl ? (
                  <img src={channel.avatarUrl} alt="" loading="lazy" />
                ) : (
                  <Icon>subscriptions</Icon>
                )}
              </span>
              <span className="smart-channel-copy">
                <strong>{channel.title}</strong>
                <small>{channel.handle ?? channel.id}</small>
                <span>
                  {channel.downloadedCount} downloaded · {channel.pendingCount}{" "}
                  pending
                </span>
                <span>
                  Last successful check:{" "}
                  {formatTime(channel.lastSuccessfulCheckAt)}
                </span>
                {channel.error && <em>{channel.error}</em>}
              </span>
              <span className={`smart-status smart-status--${channel.status}`}>
                {channel.status}
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch-input"
                checked={channel.enabled}
                aria-label={`${channel.enabled ? "Pause" : "Resume"} ${channel.title}`}
                onChange={(event) =>
                  run(`toggle-${channel.id}`, () =>
                    window.chromecraft.setSmartDownloadsChannelEnabled(
                      channel.id,
                      event.target.checked,
                    ),
                  )
                }
              />
              <details className="smart-menu">
                <summary aria-label={`More options for ${channel.title}`}>
                  <Icon>more_vert</Icon>
                </summary>
                <div>
                  <button
                    type="button"
                    onClick={() => runCheck(`check-${channel.id}`, channel.id)}
                  >
                    Check for new videos now
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.chromecraft.openGallery()}
                  >
                    View downloaded videos
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      run(`pause-${channel.id}`, () =>
                        window.chromecraft.setSmartDownloadsChannelEnabled(
                          channel.id,
                          !channel.enabled,
                        ),
                      )
                    }
                  >
                    {channel.enabled ? "Pause channel" : "Resume channel"}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Stop following ${channel.title}? Existing downloads will remain.`,
                        )
                      ) {
                        run(`remove-${channel.id}`, () =>
                          window.chromecraft.removeSmartDownloadsChannel(
                            channel.id,
                          ),
                        );
                      }
                    }}
                  >
                    Remove channel
                  </button>
                </div>
              </details>
            </article>
          ))}
          {snapshot.channels.length === 0 && (
            <div className="smart-empty">
              <Icon>subscriptions</Icon>
              <strong>No channels followed yet</strong>
              <span>
                Add a YouTube channel to automatically download new videos.
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="smart-section" aria-labelledby="smart-storage-title">
        <header>
          <span>
            <small>Offline library</small>
            <h3 id="smart-storage-title">Storage and Quality</h3>
            <p>
              Only verified automatic downloads count toward this allocation.
            </p>
          </span>
          <span className="smart-storage-total">
            {storagePercent.toFixed(0)}% used
          </span>
        </header>
        <div className="smart-storage-body">
          <div
            className="smart-storage-meter"
            aria-label={`${storagePercent.toFixed(0)} percent used`}
          >
            <span style={{ width: `${storagePercent}%` }} />
          </div>
          <div className="smart-storage-labels">
            <span>{formatBytes(snapshot.storage.usedBytes)} used</span>
            <span>
              {formatBytes(snapshot.storage.availableBytes)} available in
              allocation
            </span>
            {snapshot.storage.diskAvailableBytes !== null && (
              <span>
                {formatBytes(snapshot.storage.diskAvailableBytes)} free on disk
              </span>
            )}
          </div>
          <label className="smart-quota-control">
            <span>Storage allocation</span>
            <input
              type="range"
              min="0.5"
              max={maximumGb}
              step="0.5"
              value={Math.min(quotaGb, maximumGb)}
              onChange={(event) => setQuotaGb(Number(event.target.value))}
              onPointerUp={() =>
                run("quota", () =>
                  window.chromecraft.setSmartDownloadsQuotaBytes(
                    Math.round(quotaGb * GB),
                  ),
                )
              }
              aria-label="Smart Downloads storage allocation in GB"
            />
            <span className="smart-number-field">
              <input
                type="number"
                min="0.5"
                max={maximumGb}
                step="0.5"
                value={Number(quotaGb.toFixed(1))}
                onChange={(event) => setQuotaGb(Number(event.target.value))}
                onBlur={() =>
                  run("quota", () =>
                    window.chromecraft.setSmartDownloadsQuotaBytes(
                      Math.round(Math.max(0.5, quotaGb) * GB),
                    ),
                  )
                }
              />
              GB
            </span>
          </label>
          <label className="smart-select-row">
            <span>
              <strong>Download quality</strong>
              <small>
                Uses a fallback below your preferred resolution ceiling.
              </small>
            </span>
            <select
              value={snapshot.config.quality}
              onChange={(event) =>
                run("quality", () =>
                  window.chromecraft.setSmartDownloadsQuality(
                    event.target.value as SmartDownloadQuality,
                  ),
                )
              }
            >
              <option value="best">Best available</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
              <option value="audio">Audio only</option>
            </select>
          </label>
          <fieldset className="smart-radio-group">
            <legend>When the allocation is full</legend>
            {[
              [
                "oldest",
                "Delete oldest automatically",
                "Remove the oldest eligible managed video.",
              ],
              [
                "watched-first",
                "Delete watched videos first",
                "Prefer watched videos, then the oldest eligible download.",
              ],
              [
                "pause",
                "Pause new downloads",
                "Wait until you free enough storage.",
              ],
            ].map(([value, title, description]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="smart-cleanup-policy"
                  checked={snapshot.config.cleanupPolicy === value}
                  onChange={() =>
                    run("cleanup", () =>
                      window.chromecraft.setSmartDownloadsCleanupPolicy(
                        value as SmartDownloadCleanupPolicy,
                      ),
                    )
                  }
                />
                <span>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {snapshot.cleanupPreview.length > 0 && (
            <details className="smart-cleanup-preview">
              <summary>
                Preview next cleanup · {snapshot.cleanupPreview.length} video(s)
              </summary>
              <ul>
                {snapshot.cleanupPreview.map((item) => (
                  <li key={item.sourceKey}>
                    <span>
                      {item.watched ? "Watched video" : "Downloaded video"}
                    </span>
                    <strong>{formatBytes(item.bytes)}</strong>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </section>

      <section
        className="smart-section"
        aria-labelledby="smart-recommendations-title"
      >
        <header>
          <span>
            <small>Private and on-device</small>
            <h3 id="smart-recommendations-title">Recommended for you</h3>
            <p>
              Discover channels you watch often and add them to Smart Downloads.
            </p>
          </span>
        </header>
        <SwitchRow
          title="Use YouTube viewing activity for recommendations"
          description="Chromecraft privately analyses actual playback. Viewing activity stays on this device."
          checked={snapshot.config.recommendationsEnabled}
          onChange={(enabled) =>
            run("recommendations", () =>
              window.chromecraft.setSmartDownloadsRecommendationsEnabled(
                enabled,
              ),
            )
          }
        />
        <div className="smart-recommendations">
          {snapshot.recommendations.map((recommendation) => (
            <article key={recommendation.channelId}>
              <span className="smart-avatar">
                {recommendation.avatarUrl ? (
                  <img src={recommendation.avatarUrl} alt="" loading="lazy" />
                ) : (
                  <Icon>person</Icon>
                )}
              </span>
              <span>
                <strong>{recommendation.title}</strong>
                <small>{recommendation.reason}</small>
              </span>
              <button
                type="button"
                className="filled-button"
                onClick={() =>
                  run(`follow-${recommendation.channelId}`, () =>
                    window.chromecraft.addSmartDownloadsChannel(
                      `https://www.youtube.com/channel/${recommendation.channelId}`,
                      "future",
                    ),
                  )
                }
              >
                Follow
              </button>
              <button
                type="button"
                className="smart-icon-button"
                aria-label={`Not interested in ${recommendation.title}`}
                onClick={() =>
                  run(`dismiss-${recommendation.channelId}`, () =>
                    window.chromecraft.dismissSmartDownloadsRecommendation(
                      recommendation.channelId,
                    ),
                  )
                }
              >
                <Icon>close</Icon>
              </button>
            </article>
          ))}
          {snapshot.recommendations.length === 0 && (
            <div className="smart-empty smart-empty--compact">
              <Icon>recommend</Icon>
              <strong>No recommendations yet</strong>
              <span>
                {snapshot.config.recommendationsEnabled
                  ? "Watch a few YouTube videos and suggestions will appear here."
                  : "Turn on private viewing analysis to receive local suggestions."}
              </span>
            </div>
          )}
        </div>
      </section>

      <section
        className="smart-section"
        aria-labelledby="smart-behaviour-title"
      >
        <header>
          <span>
            <small>Scheduling</small>
            <h3 id="smart-behaviour-title">Automatic Download Behaviour</h3>
            <p>Keep checks bounded and ordinary browsing responsive.</p>
          </span>
          <button
            type="button"
            className="tonal-button"
            onClick={() =>
              run("queue", () =>
                snapshot.queuePaused
                  ? window.chromecraft.resumeSmartDownloadsQueue()
                  : window.chromecraft.pauseSmartDownloadsQueue(),
              )
            }
          >
            <Icon>{snapshot.queuePaused ? "play_arrow" : "pause"}</Icon>
            {snapshot.queuePaused ? "Resume queue" : "Pause queue"}
          </button>
        </header>
        <label className="smart-select-row">
          <span>
            <strong>Check channels</strong>
            <small>Checks run when due, not when this page is reopened.</small>
          </span>
          <select
            value={snapshot.config.checkIntervalMinutes}
            onChange={(event) =>
              run("interval", () =>
                window.chromecraft.setSmartDownloadsCheckInterval(
                  Number(event.target.value),
                ),
              )
            }
          >
            <option value="15">Every 15 minutes</option>
            <option value="30">Every 30 minutes</option>
            <option value="60">Every hour</option>
            <option value="180">Every 3 hours</option>
            <option value="360">Every 6 hours</option>
            <option value="720">Every 12 hours</option>
            <option value="1440">Once per day</option>
          </select>
        </label>
        <SwitchRow
          title="Include Shorts"
          description="Include new videos published as YouTube Shorts."
          checked={snapshot.config.includeShorts}
          onChange={(enabled) =>
            run("shorts", () =>
              window.chromecraft.setSmartDownloadsIncludeShorts(enabled),
            )
          }
        />
        <SwitchRow
          title="Include livestream replays"
          description="Finished replays only. Live streams and scheduled premieres are never queued."
          checked={snapshot.config.includeLivestreamReplays}
          onChange={(enabled) =>
            run("replays", () =>
              window.chromecraft.setSmartDownloadsIncludeLivestreamReplays(
                enabled,
              ),
            )
          }
        />
        <SwitchRow
          title="Pause during heavy activity"
          description="Limits automatic work to one download. Active manual downloads always take priority."
          checked={snapshot.config.pauseDuringHeavyActivity}
          onChange={(enabled) =>
            run("activity", () =>
              window.chromecraft.setSmartDownloadsPauseDuringHeavyActivity(
                enabled,
              ),
            )
          }
        />
      </section>

      <section
        className="smart-section"
        aria-labelledby="smart-background-title"
      >
        <header>
          <span>
            <small>System integration</small>
            <h3 id="smart-background-title">Background Downloads</h3>
            <p>
              Background operation is explicit and never installs a hidden
              service.
            </p>
          </span>
        </header>
        <SwitchRow
          title="Keep checking while Chromecraft is closed"
          description="Closing the window hides Chromecraft in the system tray. Use the tray menu to quit completely."
          checked={snapshot.config.backgroundEnabled}
          onChange={(enabled) =>
            run("background", () =>
              window.chromecraft.setSmartDownloadsBackgroundEnabled(enabled),
            )
          }
        />
        <SwitchRow
          title="Start Smart Downloads with Windows"
          description={
            windowsStartupSupported
              ? "Starts Chromecraft hidden in the tray after you sign in to Windows."
              : "Available on Windows. Linux Mint autostart is not installed automatically."
          }
          checked={snapshot.config.startWithWindows}
          disabled={!windowsStartupSupported}
          onChange={(enabled) =>
            run("startup", () =>
              window.chromecraft.setSmartDownloadsStartWithWindows(enabled),
            )
          }
        />
      </section>

      <details className="smart-advanced">
        <summary>
          <span>
            <Icon>tune</Icon>
            <span>
              <strong>Advanced</strong>
              <small>Privacy resets, queue details and troubleshooting.</small>
            </span>
          </span>
          <Icon>expand_more</Icon>
        </summary>
        <div>
          <button
            type="button"
            className="tonal-button"
            onClick={() =>
              run("clear-recommendations", () =>
                window.chromecraft.clearSmartDownloadsRecommendationHistory(),
              )
            }
          >
            Clear recommendation history
          </button>
          <p>
            {snapshot.storage.managedDownloadCount} managed download(s) ·{" "}
            {snapshot.queue.length} queue record(s). Smart Downloads does not
            delete manual files or files outside its managed directory.
          </p>
          {snapshot.queue
            .filter((job) => job.state === "failed")
            .map((job) => (
              <div className="smart-failed-job" key={job.id}>
                <span>
                  <strong>{job.title ?? job.videoId}</strong>
                  <small>{job.error ?? "Download failed"}</small>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    run(`retry-${job.id}`, () =>
                      window.chromecraft.retrySmartDownloadJob(job.id),
                    )
                  }
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={() =>
                    run(`cancel-${job.id}`, () =>
                      window.chromecraft.cancelSmartDownloadJob(job.id),
                    )
                  }
                >
                  Cancel
                </button>
              </div>
            ))}
        </div>
      </details>
    </div>
  );
}
