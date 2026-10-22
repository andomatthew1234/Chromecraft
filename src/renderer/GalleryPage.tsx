import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import type { GalleryEntrySnapshot, GallerySnapshot } from "../shared/browser";

import "./gallery.css";

type GallerySort = "newest" | "oldest" | "name" | "duration" | "size";
type GalleryView = "grid" | "list";
const GALLERY_PAGE_SIZE = 60;
const galleryMetadataRequests = new Set<string>();

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

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "Duration unknown";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function resolution(item: GalleryEntrySnapshot): string {
  return item.width && item.height
    ? `${item.width} × ${item.height}`
    : "Resolution unknown";
}

const GalleryPreview = memo(function GalleryPreview({
  item,
}: {
  item: GalleryEntrySnapshot;
}) {
  if (item.thumbnailUrl) {
    return (
      <img
        className="gallery-preview"
        src={item.thumbnailUrl}
        alt=""
        loading="lazy"
        decoding="async"
      />
    );
  }
  return <GalleryVideoPreview item={item} />;
});

const GalleryVideoPreview = memo(function GalleryVideoPreview({
  item,
}: {
  item: GalleryEntrySnapshot;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const element = video.current;
    if (!element || !item.available) return;
    const loaded = () => {
      if (element.duration && element.videoWidth && element.videoHeight) {
        const metadataChanged =
          item.durationSeconds === null ||
          Math.abs(item.durationSeconds - element.duration) > 0.1 ||
          item.width !== element.videoWidth ||
          item.height !== element.videoHeight;
        const requestKey = `${item.id}:${element.duration.toFixed(1)}:${element.videoWidth}:${element.videoHeight}`;
        if (metadataChanged && !galleryMetadataRequests.has(requestKey)) {
          galleryMetadataRequests.add(requestKey);
          void window.chromecraft
            .updateGalleryMediaMetadata(
              item.id,
              element.duration,
              element.videoWidth,
              element.videoHeight,
            )
            .catch(() => galleryMetadataRequests.delete(requestKey));
        }
      }
      if (element.duration > 2)
        element.currentTime = Math.min(3, element.duration * 0.08);
    };
    element.addEventListener("loadedmetadata", loaded, { once: true });
    return () => element.removeEventListener("loadedmetadata", loaded);
  }, [item.id, item.mediaUrl, item.available]);
  useEffect(() => {
    const element = video.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [item.id]);
  if (!item.available || failed)
    return (
      <span className="gallery-preview gallery-preview--missing">
        <span className="material-icon material-symbols-rounded">
          video_file
        </span>
        <small>
          {item.available ? "Preview unavailable" : "File moved or missing"}
        </small>
      </span>
    );
  return (
    <video
      ref={video}
      className="gallery-preview"
      src={visible ? item.mediaUrl : undefined}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  );
});

function GalleryMenu({
  item,
  onError,
}: {
  item: GalleryEntrySnapshot;
  onError: (error: unknown) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const run = (operation: () => Promise<unknown>) => {
    if (menu.current) menu.current.open = false;
    void operation().catch(onError);
  };
  const rename = () => {
    const next = window.prompt("Rename video", item.title)?.trim();
    if (next && next !== item.title)
      run(() => window.chromecraft.renameGalleryItem(item.id, next));
  };
  const remove = () => {
    if (
      window.confirm(
        `Remove “${item.title}” from My Gallery? The file will stay on disk.`,
      )
    )
      run(() => window.chromecraft.removeGalleryItem(item.id));
  };
  const destroy = () => {
    run(() => window.chromecraft.deleteGalleryItem(item.id));
  };
  return (
    <details
      ref={menu}
      className="gallery-menu"
      onClick={(event) => event.stopPropagation()}
    >
      <summary aria-label={`More actions for ${item.title}`}>
        <span className="material-icon material-symbols-rounded">
          more_vert
        </span>
      </summary>
      <div>
        <button
          onClick={() => run(() => window.chromecraft.openGallery(item.id))}
        >
          Play
        </button>
        <button
          onClick={() => run(() => window.chromecraft.showGalleryFile(item.id))}
        >
          Open file location
        </button>
        <button onClick={rename}>Rename</button>
        <button
          onClick={() => run(() => window.chromecraft.copyGalleryPath(item.id))}
        >
          Copy file path
        </button>
        {item.sourceUrl && (
          <button
            onClick={() =>
              run(() => window.chromecraft.copyGallerySourceUrl(item.id))
            }
          >
            Copy original URL
          </button>
        )}
        {item.managedBy === "smart" && (
          <button
            onClick={() =>
              run(() =>
                window.chromecraft.setSmartDownloadKeepForever(
                  item.id,
                  !item.keepForever,
                ),
              )
            }
          >
            {item.keepForever ? "Allow automatic cleanup" : "Keep forever"}
          </button>
        )}
        <button onClick={remove}>Remove from gallery</button>
        <button className="danger" onClick={destroy}>
          Delete from disk
        </button>
      </div>
    </details>
  );
}

function GalleryPlayer({
  item,
  items,
  onBack,
  onError,
}: {
  item: GalleryEntrySnapshot;
  items: GalleryEntrySnapshot[];
  onBack: () => void;
  onError: (error: unknown) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [speed, setSpeed] = useState(1);
  const [unsupported, setUnsupported] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(item.durationSeconds ?? 0);
  const watchedReported = useRef(Boolean(item.watchedAt));
  useEffect(() => {
    setUnsupported(false);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(item.durationSeconds ?? 0);
    watchedReported.current = Boolean(item.watchedAt);
  }, [item.id]);
  const index = items.findIndex((candidate) => candidate.id === item.id);
  const select = (offset: number) => {
    const next = items[index + offset];
    if (next) void window.chromecraft.openGallery(next.id);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      const element = video.current;
      if (!element) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (element.paused) void element.play();
        else element.pause();
      } else if (event.key === "ArrowRight") element.currentTime += 5;
      else if (event.key === "ArrowLeft") element.currentTime -= 5;
      else if (event.key.toLowerCase() === "f")
        void element.requestFullscreen();
      else if (event.key.toLowerCase() === "m") {
        element.muted = !element.muted;
        setMuted(element.muted);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [item.id]);
  const togglePlayback = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play();
    else element.pause();
  };
  const toggleMuted = () => {
    const element = video.current;
    if (!element) return;
    element.muted = !element.muted;
    setMuted(element.muted);
  };
  return (
    <main className="gallery-page gallery-player-page">
      <header className="gallery-player-header">
        <button
          className="gallery-icon-button"
          onClick={onBack}
          aria-label="Return to My Gallery"
        >
          <span className="material-icon material-symbols-rounded">
            arrow_back
          </span>
        </button>
        <div>
          <span className="gallery-eyebrow">Now playing</span>
          <h1>{item.title}</h1>
        </div>
        <button
          className="tonal-button"
          onClick={() =>
            void window.chromecraft.showGalleryFile(item.id).catch(onError)
          }
        >
          Show in folder
        </button>
      </header>
      <section className="gallery-player-stage">
        {item.available && !unsupported ? (
          <video
            ref={video}
            src={item.mediaUrl}
            autoPlay
            playsInline
            onError={() => setUnsupported(true)}
            onLoadedMetadata={(event) => {
              setDuration(
                Number.isFinite(event.currentTarget.duration)
                  ? event.currentTarget.duration
                  : 0,
              );
            }}
            onDurationChange={(event) =>
              setDuration(
                Number.isFinite(event.currentTarget.duration)
                  ? event.currentTarget.duration
                  : 0,
              )
            }
            onTimeUpdate={(event) => {
              const current = event.currentTarget.currentTime;
              setCurrentTime(current);
              const usefulThreshold = Math.min(
                60,
                Math.max(20, event.currentTarget.duration * 0.1),
              );
              if (
                item.managedBy === "smart" &&
                !watchedReported.current &&
                current >= usefulThreshold
              ) {
                watchedReported.current = true;
                void window.chromecraft.markGalleryItemWatched(item.id);
              }
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
          />
        ) : (
          <div className="gallery-player-error">
            <span className="material-icon material-symbols-rounded">
              video_file
            </span>
            <h2>
              {item.available
                ? "This codec isn’t supported in Chromecraft"
                : "This video has moved"}
            </h2>
            <p>
              Open the file with your operating system’s default video
              application.
            </p>
            <button
              className="filled-button"
              onClick={() =>
                void window.chromecraft.openGalleryFile(item.id).catch(onError)
              }
            >
              Open externally
            </button>
          </div>
        )}
        {item.available && !unsupported && (
          <div
            className="gallery-media-controls"
            role="group"
            aria-label="Video controls"
          >
            <button
              type="button"
              className="gallery-media-icon-button"
              onClick={togglePlayback}
              aria-label={playing ? "Pause video" : "Play video"}
            >
              <span
                className="material-icon material-symbols-rounded"
                aria-hidden="true"
              >
                {playing ? "pause" : "play_arrow"}
              </span>
            </button>
            <span className="gallery-media-time" aria-hidden="true">
              {formatDuration(currentTime)}
            </span>
            <input
              className="gallery-media-scrubber"
              type="range"
              min="0"
              max={Math.max(duration, 0.01)}
              step="0.1"
              value={Math.min(currentTime, Math.max(duration, 0.01))}
              onInput={(event) => {
                const next = Number(event.currentTarget.value);
                if (video.current) video.current.currentTime = next;
                setCurrentTime(next);
              }}
              aria-label="Video progress"
              aria-valuetext={`${formatDuration(currentTime)} of ${formatDuration(duration)}`}
              style={
                {
                  "--gallery-progress": `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
                } as CSSProperties
              }
            />
            <span className="gallery-media-time" aria-hidden="true">
              {formatDuration(duration)}
            </span>
            <button
              type="button"
              className="gallery-media-icon-button"
              onClick={toggleMuted}
              aria-label={muted ? "Unmute video" : "Mute video"}
            >
              <span
                className="material-icon material-symbols-rounded"
                aria-hidden="true"
              >
                {muted ? "volume_off" : "volume_up"}
              </span>
            </button>
            <button
              type="button"
              className="gallery-media-icon-button"
              onClick={() => {
                if (video.current) void video.current.requestFullscreen();
              }}
              aria-label="Enter fullscreen"
            >
              <span
                className="material-icon material-symbols-rounded"
                aria-hidden="true"
              >
                fullscreen
              </span>
            </button>
          </div>
        )}
      </section>
      <footer className="gallery-player-actions">
        <button disabled={index <= 0} onClick={() => select(-1)}>
          <span className="material-icon material-symbols-rounded">
            skip_previous
          </span>
          Previous
        </button>
        <label>
          Speed
          <select
            value={speed}
            onChange={(event) => {
              const next = Number(event.target.value);
              setSpeed(next);
              if (video.current) video.current.playbackRate = next;
            }}
          >
            <option value="0.5">0.5×</option>
            <option value="1">1×</option>
            <option value="1.25">1.25×</option>
            <option value="1.5">1.5×</option>
            <option value="2">2×</option>
          </select>
        </label>
        <button
          onClick={() => {
            const element = video.current;
            if (element && document.pictureInPictureEnabled)
              void element.requestPictureInPicture();
          }}
        >
          <span className="material-icon material-symbols-rounded">
            picture_in_picture_alt
          </span>
          Picture in picture
        </button>
        <button
          disabled={index < 0 || index >= items.length - 1}
          onClick={() => select(1)}
        >
          Next
          <span className="material-icon material-symbols-rounded">
            skip_next
          </span>
        </button>
      </footer>
    </main>
  );
}

export function GalleryPage({
  snapshot,
  selectedId,
}: {
  snapshot: GallerySnapshot;
  selectedId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<GallerySort>("newest");
  const [view, setView] = useState<GalleryView>("grid");
  const [visibleCount, setVisibleCount] = useState(GALLERY_PAGE_SIZE);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const reportError = (error: unknown) =>
    setActionError(
      error instanceof Error
        ? error.message
        : "The action could not be completed.",
    );
  const deleteAll = () => {
    if (deletingAll) return;
    setActionError(null);
    setDeletingAll(true);
    void window.chromecraft
      .deleteAllGalleryItems()
      .catch(reportError)
      .finally(() => setDeletingAll(false));
  };
  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const next = snapshot.items.filter((item) =>
      `${item.title} ${item.sourceName ?? ""}`.toLowerCase().includes(needle),
    );
    next.sort((a, b) =>
      sort === "newest"
        ? b.downloadedAt - a.downloadedAt
        : sort === "oldest"
          ? a.downloadedAt - b.downloadedAt
          : sort === "name"
            ? a.title.localeCompare(b.title)
            : sort === "duration"
              ? (b.durationSeconds ?? -1) - (a.durationSeconds ?? -1)
              : b.fileSize - a.fileSize,
    );
    return next;
  }, [snapshot.items, query, sort]);
  const selected = selectedId
    ? snapshot.items.find((item) => item.id === selectedId)
    : null;
  useEffect(
    () => setVisibleCount(GALLERY_PAGE_SIZE),
    [query, sort, view, snapshot.items.length],
  );
  if (selected)
    return (
      <GalleryPlayer
        item={selected}
        items={snapshot.items}
        onBack={() => void window.chromecraft.openGallery()}
        onError={reportError}
      />
    );
  return (
    <main className="gallery-page">
      <header className="gallery-hero">
        <span className="gallery-hero-icon material-icon material-symbols-rounded">
          video_library
        </span>
        <div>
          <span className="gallery-eyebrow">Local and private</span>
          <h1>My Gallery</h1>
          <p>Your downloaded videos, ready to watch offline.</p>
        </div>
        <button
          type="button"
          className="gallery-delete-all"
          onClick={deleteAll}
          disabled={snapshot.items.length === 0 || deletingAll}
        >
          <span className="material-icon material-symbols-rounded">
            delete_sweep
          </span>
          {deletingAll ? "Deleting…" : "Delete all"}
        </button>
      </header>
      {actionError && (
        <div className="gallery-action-error" role="alert">
          <span className="material-icon material-symbols-rounded">error</span>
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {snapshot.items.length === 0 ? (
        <section className="gallery-empty">
          <span className="material-icon material-symbols-rounded">
            video_library
          </span>
          <h2>Your gallery is ready</h2>
          <p>
            Videos downloaded with Chromecraft will appear here automatically.
          </p>
        </section>
      ) : (
        <>
          <section className="gallery-toolbar">
            <label>
              <span className="material-icon material-symbols-rounded">
                search
              </span>
              <input
                type="search"
                placeholder="Search your gallery"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="gallery-sort-field">
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as GallerySort)}
                aria-label="Sort gallery"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="name">Name</option>
                <option value="duration">Duration</option>
                <option value="size">File size</option>
              </select>
              <span
                className="material-icon material-symbols-rounded"
                aria-hidden="true"
              >
                expand_more
              </span>
            </label>
            <div className="gallery-view-toggle">
              <button
                className={view === "grid" ? "active" : ""}
                onClick={() => setView("grid")}
                aria-label="Grid view"
              >
                <span className="material-icon material-symbols-rounded">
                  grid_view
                </span>
              </button>
              <button
                className={view === "list" ? "active" : ""}
                onClick={() => setView("list")}
                aria-label="List view"
              >
                <span className="material-icon material-symbols-rounded">
                  view_list
                </span>
              </button>
            </div>
          </section>
          <div className="gallery-library-heading">
            <div>
              <h2>{query ? "Search results" : "Your videos"}</h2>
              <p>
                {items.length} {items.length === 1 ? "video" : "videos"} stored
                locally
              </p>
            </div>
          </div>
          <section
            className={`gallery-collection gallery-collection--${view}`}
            aria-label="Downloaded videos"
          >
            {items.slice(0, visibleCount).map((item) => (
              <article
                key={item.id}
                className="gallery-card"
                data-missing={!item.available || undefined}
              >
                <button
                  className="gallery-card-main"
                  onClick={() => void window.chromecraft.openGallery(item.id)}
                  disabled={!item.available}
                >
                  <GalleryPreview item={item} />
                  <span className="gallery-card-copy">
                    <strong>{item.title}</strong>
                    <small>
                      {formatDuration(item.durationSeconds)} ·{" "}
                      {resolution(item)}
                    </small>
                    <small>
                      {formatBytes(item.fileSize)} ·{" "}
                      {new Date(item.downloadedAt).toLocaleDateString()}
                    </small>
                    {item.sourceName && <small>{item.sourceName}</small>}
                  </span>
                </button>
                <GalleryMenu item={item} onError={reportError} />
              </article>
            ))}
            {items.length === 0 && (
              <div className="gallery-no-results">
                <span className="material-icon material-symbols-rounded">
                  search_off
                </span>
                <h2>No matching videos</h2>
                <p>Try another title or source.</p>
              </div>
            )}
            {items.length > visibleCount && (
              <button
                type="button"
                className="tonal-button gallery-load-more"
                onClick={() =>
                  setVisibleCount((count) => count + GALLERY_PAGE_SIZE)
                }
              >
                Load more videos
              </button>
            )}
          </section>
        </>
      )}
    </main>
  );
}
