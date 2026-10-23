import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type {
  GalleryEntrySnapshot,
  GalleryMediaRepairResult,
  GallerySnapshot,
  SmartDownloadsSnapshot,
} from "../shared/browser";

import "./gallery.css";

type GallerySort = "newest" | "oldest" | "name" | "duration" | "size";
type GalleryView = "grid" | "list";
type MenuPosition = { left: number; top: number; transformOrigin: string };
type GalleryMenuAction = {
  label: string;
  icon: string;
  run: () => void;
  danger?: boolean;
};

const GALLERY_PAGE_SIZE = 60;
const galleryMetadataRequests = new Set<string>();
const SORT_OPTIONS: ReadonlyArray<{ value: GallerySort; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name" },
  { value: "duration", label: "Duration" },
  { value: "size", label: "File size" },
];

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatPlayerTime(seconds: number | null): string {
  return formatDuration(seconds) ?? "0:00";
}

function resolution(item: GalleryEntrySnapshot): string | null {
  if (!item.width || !item.height) return null;
  if (item.height >= 2160) return "4K";
  if (item.height >= 1440) return "1440p";
  if (item.height >= 1080) return "1080p";
  if (item.height >= 720) return "720p";
  return `${item.width} × ${item.height}`;
}

function portal(content: ReactNode): ReactNode {
  return typeof document === "undefined"
    ? content
    : createPortal(content, document.body);
}

function positionMenu(
  anchor: HTMLElement,
  width: number,
  height: number,
  gap = 8,
): MenuPosition {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const fittedWidth = Math.min(width, Math.max(0, viewportWidth - 24));
  const fittedHeight = Math.min(height, Math.max(0, viewportHeight - 24));
  const left = Math.max(
    12,
    Math.min(rect.right - fittedWidth, viewportWidth - fittedWidth - 12),
  );
  const opensUp =
    rect.bottom + gap + fittedHeight > viewportHeight &&
    rect.top > fittedHeight;
  return {
    left,
    top: opensUp
      ? Math.max(12, rect.top - gap - fittedHeight)
      : Math.max(
          12,
          Math.min(viewportHeight - fittedHeight - 12, rect.bottom + gap),
        ),
    transformOrigin: opensUp ? "bottom right" : "top right",
  };
}

function useDismissableMenu(
  open: boolean,
  close: () => void,
  trigger: React.RefObject<HTMLElement | null>,
  menu: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target))
        close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      trigger.current?.focus();
    };
    const onViewportChange = () => close();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open, close, trigger, menu]);
}

const GalleryVideoPreview = memo(function GalleryVideoPreview({
  item,
}: {
  item: GalleryEntrySnapshot;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [item.id, item.mediaUrl]);

  useEffect(() => {
    const element = video.current;
    if (!element || !item.available) return;
    const loadedMetadata = () => {
      setLoaded(true);
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
    element.addEventListener("loadedmetadata", loadedMetadata, { once: true });
    return () => element.removeEventListener("loadedmetadata", loadedMetadata);
  }, [
    item.id,
    item.mediaUrl,
    item.available,
    item.durationSeconds,
    item.width,
    item.height,
  ]);

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
        <span
          className="material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          movie
        </span>
        <small>
          {item.available ? "Preview unavailable" : "Video unavailable"}
        </small>
      </span>
    );

  return (
    <>
      {!loaded && (
        <span className="gallery-preview gallery-preview--skeleton" />
      )}
      <video
        ref={video}
        className={`gallery-preview${loaded ? " is-loaded" : ""}`}
        src={visible ? item.mediaUrl : undefined}
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
        onError={() => setFailed(true)}
      />
    </>
  );
});

const GalleryPreview = memo(function GalleryPreview({
  item,
}: {
  item: GalleryEntrySnapshot;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  useEffect(() => {
    setImageFailed(false);
    setImageLoaded(false);
  }, [item.id, item.thumbnailUrl]);
  const duration = formatDuration(item.durationSeconds);
  const quality = resolution(item);
  return (
    <span className="gallery-preview-frame">
      {item.thumbnailUrl && !imageFailed ? (
        <>
          {!imageLoaded && (
            <span className="gallery-preview gallery-preview--skeleton" />
          )}
          <img
            className={`gallery-preview${imageLoaded ? " is-loaded" : ""}`}
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageFailed(true)}
          />
        </>
      ) : (
        <GalleryVideoPreview item={item} />
      )}
      <span className="gallery-play-indicator" aria-hidden="true">
        <span className="material-icon material-symbols-rounded">
          play_arrow
        </span>
      </span>
      {duration && <span className="gallery-duration-badge">{duration}</span>}
      {quality && <span className="gallery-quality-badge">{quality}</span>}
    </span>
  );
});

function MaterialSelect<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  label: string;
  onChange: (value: T) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.value === value),
    ),
  );
  const [position, setPosition] = useState<MenuPosition>({
    left: 0,
    top: 0,
    transformOrigin: "top right",
  });
  const close = () => setOpen(false);
  useDismissableMenu(open, close, trigger, menu);

  const show = () => {
    if (!trigger.current) return;
    setPosition(positionMenu(trigger.current, 220, options.length * 48 + 16));
    setActiveIndex(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      menu.current
        ?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)
        ?.focus();
    });
  }, [open, activeIndex]);

  const select = (option: T) => {
    onChange(option);
    close();
    requestAnimationFrame(() => trigger.current?.focus());
  };

  const onOptionKeyDown = (event: ReactKeyboardEvent, index: number) => {
    if (event.key === "Tab") {
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        event.key === "ArrowDown"
          ? (index + 1) % options.length
          : (index - 1 + options.length) % options.length;
      setActiveIndex(next);
      menu.current
        ?.querySelector<HTMLElement>(`[data-option-index="${next}"]`)
        ?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : options.length - 1;
      setActiveIndex(next);
      menu.current
        ?.querySelector<HTMLElement>(`[data-option-index="${next}"]`)
        ?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(options[index].value);
    }
  };

  const selectedLabel = options.find((option) => option.value === value)?.label;
  return (
    <div className="gallery-select">
      <button
        ref={trigger}
        type="button"
        className="gallery-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            show();
          }
        }}
      >
        <span>{selectedLabel}</span>
        <span
          className="material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>
      {open &&
        portal(
          <div
            ref={menu}
            id={listboxId}
            className="gallery-popover gallery-select-menu"
            role="listbox"
            aria-label={label}
            style={position}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                tabIndex={index === activeIndex ? 0 : -1}
                data-option-index={index}
                onFocus={() => setActiveIndex(index)}
                onKeyDown={(event) => onOptionKeyDown(event, index)}
                onClick={() => select(option.value)}
              >
                <span>{option.label}</span>
                {option.value === value && (
                  <span
                    className="material-icon material-symbols-rounded"
                    aria-hidden="true"
                  >
                    check
                  </span>
                )}
              </button>
            ))}
          </div>,
        )}
    </div>
  );
}

function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    cancelButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
        ) ?? []),
      ];
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onCancel]);
  return portal(
    <div
      className="gallery-dialog-scrim"
      role="presentation"
      onMouseDown={onCancel}
    >
      <section
        ref={dialog}
        className="gallery-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="gallery-confirm-title"
        aria-describedby="gallery-confirm-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span
          className="gallery-dialog-icon material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          delete_forever
        </span>
        <h2 id="gallery-confirm-title">{title}</h2>
        <p id="gallery-confirm-description">{description}</p>
        <div className="gallery-dialog-actions">
          <button
            ref={cancelButton}
            type="button"
            className="tonal-button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="gallery-danger-button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>,
  );
}

function GalleryRepairDialog({
  repairing,
  onCancel,
  onRepair,
}: {
  repairing: boolean;
  onCancel: () => void;
  onRepair: (fetchOriginalThumbnails: boolean) => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    cancelButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !repairing) {
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
        ) ?? []),
      ];
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onCancel, repairing]);
  return portal(
    <div
      className="gallery-dialog-scrim"
      role="presentation"
      onMouseDown={() => {
        if (!repairing) onCancel();
      }}
    >
      <section
        ref={dialog}
        className="gallery-dialog gallery-repair-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gallery-repair-title"
        aria-describedby="gallery-repair-description"
        aria-busy={repairing}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span
          className="gallery-dialog-icon gallery-repair-dialog-icon material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          auto_fix_high
        </span>
        <h2 id="gallery-repair-title">Repair Gallery artwork?</h2>
        <p id="gallery-repair-description">
          Chromecraft can recover cached artwork, inspect local video metadata,
          and create a local preview where supported.
        </p>
        <div className="gallery-repair-network-note">
          <span
            className="material-icon material-symbols-rounded"
            aria-hidden="true"
          >
            public
          </span>
          <span>
            <strong>Fetch original thumbnails</strong>
            <small>
              This contacts YouTube only for Gallery videos whose artwork is
              still missing.
            </small>
          </span>
        </div>
        {repairing && (
          <div className="gallery-repair-progress" role="status">
            <span
              className="material-icon material-symbols-rounded is-spinning"
              aria-hidden="true"
            >
              progress_activity
            </span>
            Repairing your library…
          </div>
        )}
        <div className="gallery-dialog-actions gallery-repair-actions">
          <button
            ref={cancelButton}
            type="button"
            className="tonal-button"
            onClick={onCancel}
            disabled={repairing}
          >
            Cancel
          </button>
          <button
            type="button"
            className="tonal-button"
            onClick={() => onRepair(false)}
            disabled={repairing}
          >
            Repair locally
          </button>
          <button
            type="button"
            className="filled-button"
            onClick={() => onRepair(true)}
            disabled={repairing}
          >
            Fetch originals &amp; repair
          </button>
        </div>
      </section>
    </div>,
  );
}

export function formatGalleryRepairResult(
  result: GalleryMediaRepairResult,
): string {
  const recovered = result.thumbnailsRepaired + result.metadataRecovered;
  if (
    recovered === 0 &&
    result.missingThumbnails === 0 &&
    result.metadataUnavailable === 0 &&
    result.errors.length === 0
  )
    return "Your Gallery is already healthy.";
  const parts: string[] = [];
  if (result.thumbnailsRepaired > 0)
    parts.push(
      `${result.thumbnailsRepaired} ${result.thumbnailsRepaired === 1 ? "thumbnail" : "thumbnails"} repaired`,
    );
  if (result.metadataRecovered > 0)
    parts.push(
      `${result.metadataRecovered} ${result.metadataRecovered === 1 ? "video" : "videos"} updated`,
    );
  if (result.missingThumbnails > 0)
    parts.push(
      `${result.missingThumbnails} ${result.missingThumbnails === 1 ? "thumbnail is" : "thumbnails are"} still unavailable`,
    );
  if (result.metadataUnavailable > 0)
    parts.push(
      `${result.metadataUnavailable} ${result.metadataUnavailable === 1 ? "video has" : "videos have"} limited metadata`,
    );
  if (result.errors.length > 0)
    parts.push(
      `${result.errors.length} ${result.errors.length === 1 ? "item needs" : "items need"} attention`,
    );
  return `${parts.join(" · ")}.`;
}

function GalleryMenu({
  item,
  onError,
}: {
  item: GalleryEntrySnapshot;
  onError: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({
    left: 0,
    top: 0,
    transformOrigin: "top right",
  });
  const close = () => setOpen(false);
  useDismissableMenu(open, close, trigger, menu);

  const run = (operation: () => Promise<unknown>) => {
    close();
    void operation().catch(onError);
  };
  const rename = () => {
    close();
    const next = window.prompt("Rename video", item.title)?.trim();
    if (next && next !== item.title)
      void window.chromecraft.renameGalleryItem(item.id, next).catch(onError);
  };
  const show = () => {
    if (!trigger.current) return;
    setPosition(
      positionMenu(
        trigger.current,
        264,
        Math.min(396, actions.length * 46 + 16),
      ),
    );
    setOpen(true);
    requestAnimationFrame(() =>
      menu.current?.querySelector<HTMLElement>("button")?.focus(),
    );
  };
  const actions: GalleryMenuAction[] = [
    {
      label: "Play video",
      icon: "play_arrow",
      run: () => run(() => window.chromecraft.openGallery(item.id)),
    },
    {
      label: "Show in folder",
      icon: "folder_open",
      run: () => run(() => window.chromecraft.showGalleryFile(item.id)),
    },
    { label: "Rename", icon: "edit", run: rename },
    {
      label: "Copy file path",
      icon: "content_copy",
      run: () => run(() => window.chromecraft.copyGalleryPath(item.id)),
    },
  ];
  if (item.sourceUrl)
    actions.push({
      label: "Copy original URL",
      icon: "link",
      run: () => run(() => window.chromecraft.copyGallerySourceUrl(item.id)),
    });
  if (item.managedBy === "smart")
    actions.push({
      label: item.keepForever ? "Allow automatic cleanup" : "Keep forever",
      icon: item.keepForever ? "auto_delete" : "keep",
      run: () =>
        run(() =>
          window.chromecraft.setSmartDownloadKeepForever(
            item.id,
            !item.keepForever,
          ),
        ),
    });
  actions.push(
    {
      label: "Remove from gallery",
      icon: "playlist_remove",
      run: () => run(() => window.chromecraft.removeGalleryItem(item.id)),
    },
    {
      label: "Delete from disk",
      icon: "delete",
      danger: true,
      run: () => {
        close();
        setConfirmDelete(true);
      },
    },
  );

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    ];
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const direction = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + direction + buttons.length) % buttons.length]?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="gallery-menu-trigger"
        aria-label={`More actions for ${item.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          if (open) close();
          else show();
        }}
      >
        <span
          className="material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          more_vert
        </span>
      </button>
      {open &&
        portal(
          <div
            ref={menu}
            className="gallery-popover gallery-menu"
            role="menu"
            aria-label={`Actions for ${item.title}`}
            style={position}
            onKeyDown={onMenuKeyDown}
          >
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                className={action.danger ? "danger" : undefined}
                onClick={action.run}
              >
                <span
                  className="material-icon material-symbols-rounded"
                  aria-hidden="true"
                >
                  {action.icon}
                </span>
                {action.label}
              </button>
            ))}
          </div>,
        )}
      {confirmDelete && (
        <ConfirmationDialog
          title="Delete this video?"
          description={`“${item.title}” will be permanently removed from this device. This cannot be undone.`}
          confirmLabel="Delete from disk"
          onCancel={() => {
            setConfirmDelete(false);
            requestAnimationFrame(() => trigger.current?.focus());
          }}
          onConfirm={() => {
            setConfirmDelete(false);
            void window.chromecraft.deleteGalleryItem(item.id).catch(onError);
          }}
        />
      )}
    </>
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
  onError: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [speed, setSpeed] = useState("1");
  const [unsupported, setUnsupported] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(item.durationSeconds ?? 0);
  const watchedReported = useRef(Boolean(item.watchedAt));
  const index = items.findIndex((candidate) => candidate.id === item.id);

  useEffect(() => {
    setUnsupported(false);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(item.durationSeconds ?? 0);
    watchedReported.current = Boolean(item.watchedAt);
  }, [item.id, item.durationSeconds, item.watchedAt]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLButtonElement
      )
        return;
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
      else if (event.key.toLowerCase() === "m") element.muted = !element.muted;
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [item.id]);

  const select = (offset: number) => {
    const next = items[index + offset];
    if (next) void window.chromecraft.openGallery(next.id);
  };
  const togglePlayback = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play();
    else element.pause();
  };

  return (
    <main className="gallery-page gallery-player-page">
      <header className="gallery-player-header">
        <button
          className="gallery-icon-button"
          onClick={onBack}
          aria-label="Return to My Gallery"
        >
          <span
            className="material-icon material-symbols-rounded"
            aria-hidden="true"
          >
            arrow_back
          </span>
        </button>
        <div className="gallery-player-heading">
          <span className="gallery-eyebrow">Now playing</span>
          <h1 title={item.title}>{item.title}</h1>
          <p>
            {[item.sourceName, resolution(item), formatBytes(item.fileSize)]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <button
          className="tonal-button gallery-show-folder"
          onClick={() =>
            void window.chromecraft.showGalleryFile(item.id).catch(onError)
          }
        >
          <span
            className="material-icon material-symbols-rounded"
            aria-hidden="true"
          >
            folder_open
          </span>
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
            onLoadedMetadata={(event) =>
              setDuration(
                Number.isFinite(event.currentTarget.duration)
                  ? event.currentTarget.duration
                  : 0,
              )
            }
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
            <span
              className="material-icon material-symbols-rounded"
              aria-hidden="true"
            >
              video_file
            </span>
            <h2>
              {item.available
                ? "This video cannot play here"
                : "This video has moved"}
            </h2>
            <p>Open it with your device’s default video application instead.</p>
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
              {formatPlayerTime(currentTime)}
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
              aria-valuetext={`${formatPlayerTime(currentTime)} of ${formatPlayerTime(duration)}`}
              style={
                {
                  "--gallery-progress": `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
                } as CSSProperties
              }
            />
            <span className="gallery-media-time" aria-hidden="true">
              {formatPlayerTime(duration)}
            </span>
            <button
              type="button"
              className="gallery-media-icon-button"
              onClick={() => {
                if (video.current) video.current.muted = !video.current.muted;
              }}
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
                const element = video.current;
                if (element && document.pictureInPictureEnabled)
                  void element.requestPictureInPicture();
              }}
              aria-label="Picture in picture"
            >
              <span
                className="material-icon material-symbols-rounded"
                aria-hidden="true"
              >
                picture_in_picture_alt
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
          <span
            className="material-icon material-symbols-rounded"
            aria-hidden="true"
          >
            skip_previous
          </span>
          Previous
        </button>
        <MaterialSelect
          value={speed}
          label="Playback speed"
          options={[
            { value: "0.5", label: "0.5× speed" },
            { value: "1", label: "Normal speed" },
            { value: "1.25", label: "1.25× speed" },
            { value: "1.5", label: "1.5× speed" },
            { value: "2", label: "2× speed" },
          ]}
          onChange={(next) => {
            setSpeed(next);
            if (video.current) video.current.playbackRate = Number(next);
          }}
        />
        <button
          disabled={index < 0 || index >= items.length - 1}
          onClick={() => select(1)}
        >
          Next
          <span
            className="material-icon material-symbols-rounded"
            aria-hidden="true"
          >
            skip_next
          </span>
        </button>
      </footer>
    </main>
  );
}

function SmartDownloadsStatus({
  snapshot,
  onOpenSettings,
  onCheck,
  checking,
  checkMessage,
}: {
  snapshot: SmartDownloadsSnapshot | null;
  onOpenSettings: () => void;
  onCheck: () => void;
  checking: boolean;
  checkMessage: string | null;
}) {
  if (!snapshot) return null;
  const configured = snapshot.status.configured;
  const error = snapshot.status.error;
  const paused = snapshot.status.state === "disabled" || snapshot.status.paused;
  const activeCheck = snapshot.check;

  if (error)
    return (
      <section
        className="gallery-status-banner gallery-status-banner--error"
        role="alert"
      >
        <span
          className="material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          warning
        </span>
        <div>
          <strong>Smart Downloads needs attention</strong>
          <p>
            The latest channel check could not finish. Review Smart Downloads to
            retry.
          </p>
        </div>
        <button type="button" onClick={onOpenSettings}>
          Review
        </button>
      </section>
    );

  if (!configured)
    return (
      <section
        className="gallery-smart-downloads-banner"
        aria-labelledby="gallery-smart-downloads-title"
      >
        <span
          className="gallery-smart-downloads-icon material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          smart_display
        </span>
        <div className="gallery-smart-downloads-copy">
          <span className="gallery-eyebrow">Made for offline watching</span>
          <h2 id="gallery-smart-downloads-title">Set up Smart Downloads?</h2>
          <p>Automatically download from your favorite creators</p>
        </div>
        <button
          type="button"
          className="gallery-smart-downloads-action"
          onClick={onOpenSettings}
        >
          Check Smart Downloads
          <span
            className="material-icon material-symbols-rounded"
            aria-hidden="true"
          >
            arrow_forward
          </span>
        </button>
      </section>
    );

  if (paused)
    return (
      <section
        className="gallery-status-banner gallery-status-banner--paused"
        role="status"
      >
        <span
          className="material-icon material-symbols-rounded"
          aria-hidden="true"
        >
          pause_circle
        </span>
        <div>
          <strong>Smart Downloads is paused</strong>
          <p>Your existing videos are safe. Resume whenever you are ready.</p>
        </div>
        <button type="button" onClick={onOpenSettings}>
          Manage
        </button>
      </section>
    );

  if (checking || checkMessage)
    return (
      <section
        className="gallery-status-banner gallery-status-banner--success"
        role="status"
        aria-live="polite"
      >
        <span
          className={`material-icon material-symbols-rounded${checking ? " is-spinning" : ""}`}
          aria-hidden="true"
        >
          {checking ? "progress_activity" : "check_circle"}
        </span>
        <div>
          <strong>
            {checking ? "Checking Smart Downloads" : "Smart Downloads checked"}
          </strong>
          <p>
            {checking
              ? activeCheck.totalChannels > 0
                ? `Checking ${Math.min(activeCheck.checkedChannels + 1, activeCheck.totalChannels)} of ${activeCheck.totalChannels} channels…`
                : "Preparing channel check…"
              : checkMessage}
          </p>
        </div>
        {!checking && (
          <button type="button" onClick={onCheck}>
            Check again
          </button>
        )}
      </section>
    );

  return null;
}

export function GalleryPage({
  snapshot,
  selectedId,
  onOpenSmartDownloads,
  smartDownloads: suppliedSmartDownloads,
}: {
  snapshot: GallerySnapshot;
  selectedId: string | null;
  onOpenSmartDownloads: () => void;
  smartDownloads?: SmartDownloadsSnapshot | null;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<GallerySort>("newest");
  const [view, setView] = useState<GalleryView>("grid");
  const [visibleCount, setVisibleCount] = useState(GALLERY_PAGE_SIZE);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  const [liveSmartDownloads, setLiveSmartDownloads] =
    useState<SmartDownloadsSnapshot | null>(suppliedSmartDownloads ?? null);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const smartDownloads = suppliedSmartDownloads ?? liveSmartDownloads;

  useEffect(() => {
    if (suppliedSmartDownloads !== undefined) {
      setLiveSmartDownloads(suppliedSmartDownloads);
      return;
    }
    let disposed = false;
    void window.chromecraft
      .getSmartDownloads()
      .then((next) => {
        if (!disposed) setLiveSmartDownloads(next);
      })
      .catch(() => {
        if (!disposed)
          setActionError("Smart Downloads status is temporarily unavailable.");
      });
    const unsubscribe = window.chromecraft.onSmartDownloads((next) => {
      if (!disposed) setLiveSmartDownloads(next);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [suppliedSmartDownloads]);

  const reportError = () =>
    setActionError("That action could not be completed. Please try again.");
  const runDeleteAll = () => {
    if (deletingAll) return;
    setConfirmDeleteAll(false);
    setActionError(null);
    setDeletingAll(true);
    void window.chromecraft
      .deleteAllGalleryItems()
      .catch(reportError)
      .finally(() => setDeletingAll(false));
  };
  const checkSmartDownloads = () => {
    if (checking || smartDownloads?.checking) return;
    if (
      !smartDownloads?.config.enabled ||
      smartDownloads.channels.length === 0 ||
      smartDownloads.status.enabledChannelCount === 0
    ) {
      onOpenSmartDownloads();
      return;
    }
    setChecking(true);
    setCheckMessage(null);
    setActionError(null);
    void window.chromecraft
      .checkSmartDownloads()
      .then(async (result) => {
        const latest = await window.chromecraft.getSmartDownloads();
        setLiveSmartDownloads(latest);
        if (result.state === "failed") {
          setCheckMessage("Check failed — Retry.");
        } else if (result.state === "blocked") {
          setCheckMessage(
            result.reason === "disabled"
              ? "Smart Downloads is off."
              : "No enabled channels to check.",
          );
        } else if (result.state === "partial") {
          setCheckMessage(
            `${result.newVideosFound} new ${result.newVideosFound === 1 ? "video" : "videos"} found · ${result.failures} ${result.failures === 1 ? "channel" : "channels"} failed.`,
          );
        } else {
          setCheckMessage(
            result.newVideosFound === 0
              ? "No new videos found."
              : `${result.newVideosFound} new ${result.newVideosFound === 1 ? "video" : "videos"} found${result.queuedVideos > 0 ? ` · ${result.queuedVideos} queued` : ""}.`,
          );
        }
      })
      .catch(() =>
        setActionError("Smart Downloads could not be checked. Try again."),
      )
      .finally(() => setChecking(false));
  };
  const repairGallery = (fetchOriginalThumbnails: boolean) => {
    if (repairing) return;
    setRepairing(true);
    setRepairMessage(null);
    setActionError(null);
    void window.chromecraft
      .repairGalleryMedia({
        fetchOriginalThumbnails,
        generateLocalFallbacks: true,
      })
      .then((result) => {
        setRepairMessage(formatGalleryRepairResult(result));
        setRepairOpen(false);
      })
      .catch(() =>
        setActionError(
          "Gallery repair could not finish. Your videos were not changed.",
        ),
      )
      .finally(() => setRepairing(false));
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

  const smartConfigured = Boolean(smartDownloads?.status.configured);
  const smartChecking = checking || smartDownloads?.check.state === "checking";
  return (
    <main className="gallery-page">
      <header className="gallery-hero">
        <div className="gallery-hero-copy">
          <span className="gallery-eyebrow">Your offline collection</span>
          <h1>My Gallery</h1>
          <p>
            Downloaded videos, private on this device and ready whenever you
            are.
          </p>
        </div>
        <div className="gallery-hero-actions">
          {smartConfigured && (
            <button
              type="button"
              className="gallery-check-button"
              onClick={checkSmartDownloads}
              disabled={smartChecking}
            >
              <span
                className={`material-icon material-symbols-rounded${smartChecking ? " is-spinning" : ""}`}
                aria-hidden="true"
              >
                refresh
              </span>
              {smartChecking ? "Checking…" : "Check Smart Downloads now"}
            </button>
          )}
          <button
            type="button"
            className="gallery-manage-button"
            onClick={onOpenSmartDownloads}
          >
            <span
              className="material-icon material-symbols-rounded"
              aria-hidden="true"
            >
              settings
            </span>
            Manage My Gallery
          </button>
          <button
            type="button"
            className="gallery-repair-button"
            onClick={() => setRepairOpen(true)}
            disabled={snapshot.items.length === 0 || repairing}
          >
            <span
              className="material-icon material-symbols-rounded"
              aria-hidden="true"
            >
              auto_fix_high
            </span>
            {repairing ? "Repairing…" : "Repair Gallery"}
          </button>
          <button
            type="button"
            className="gallery-delete-all"
            onClick={() => setConfirmDeleteAll(true)}
            disabled={snapshot.items.length === 0 || deletingAll}
          >
            <span
              className="material-icon material-symbols-rounded"
              aria-hidden="true"
            >
              delete_sweep
            </span>
            {deletingAll ? "Deleting…" : "Delete all"}
          </button>
        </div>
      </header>

      <SmartDownloadsStatus
        snapshot={smartDownloads}
        onOpenSettings={onOpenSmartDownloads}
        onCheck={checkSmartDownloads}
        checking={smartChecking}
        checkMessage={checkMessage}
      />

      {actionError && (
        <div className="gallery-action-error" role="alert">
          <span
            className="material-icon material-symbols-rounded"
            aria-hidden="true"
          >
            error
          </span>
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {repairMessage && !actionError && (
        <div className="gallery-repair-result" role="status">
          <span
            className="material-icon material-symbols-rounded"
            aria-hidden="true"
          >
            check_circle
          </span>
          <span>{repairMessage}</span>
          <button type="button" onClick={() => setRepairMessage(null)}>
            Dismiss
          </button>
        </div>
      )}

      {snapshot.items.length === 0 ? (
        <section className="gallery-empty">
          <span
            className="gallery-empty-art material-icon material-symbols-rounded"
            aria-hidden="true"
          >
            subscriptions
          </span>
          <span className="gallery-eyebrow">Your library starts here</span>
          <h2>Save something worth replaying</h2>
          <p>
            Download a YouTube video or follow a creator with Smart Downloads.
            Your videos stay local and play offline.
          </p>
          <button
            type="button"
            className="filled-button"
            onClick={onOpenSmartDownloads}
          >
            Set up Smart Downloads
          </button>
        </section>
      ) : (
        <>
          <section className="gallery-toolbar" aria-label="Library controls">
            <label className="gallery-search-field">
              <span
                className="material-icon material-symbols-rounded"
                aria-hidden="true"
              >
                search
              </span>
              <input
                type="search"
                placeholder="Search titles and creators"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                >
                  <span
                    className="material-icon material-symbols-rounded"
                    aria-hidden="true"
                  >
                    close
                  </span>
                </button>
              )}
            </label>
            <MaterialSelect
              value={sort}
              options={SORT_OPTIONS}
              label="Sort gallery"
              onChange={setSort}
            />
            <div
              className="gallery-view-toggle"
              role="group"
              aria-label="Gallery layout"
            >
              <button
                type="button"
                className={view === "grid" ? "active" : ""}
                onClick={() => setView("grid")}
                aria-label="Grid view"
                aria-pressed={view === "grid"}
              >
                <span
                  className="material-icon material-symbols-rounded"
                  aria-hidden="true"
                >
                  grid_view
                </span>
              </button>
              <button
                type="button"
                className={view === "list" ? "active" : ""}
                onClick={() => setView("list")}
                aria-label="List view"
                aria-pressed={view === "list"}
              >
                <span
                  className="material-icon material-symbols-rounded"
                  aria-hidden="true"
                >
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
            <span>
              {formatBytes(
                snapshot.items.reduce(
                  (total, item) => total + item.fileSize,
                  0,
                ),
              )}{" "}
              used
            </span>
          </div>
          <section
            key={`${view}-${sort}-${query}`}
            className={`gallery-collection gallery-collection--${view}`}
            aria-label="Downloaded videos"
          >
            {items.slice(0, visibleCount).map((item, index) => {
              const metadata = [
                resolution(item),
                formatBytes(item.fileSize),
              ].filter(Boolean);
              return (
                <article
                  key={item.id}
                  className="gallery-card"
                  data-missing={!item.available || undefined}
                  style={
                    {
                      "--gallery-card-index": Math.min(index, 10),
                    } as CSSProperties
                  }
                >
                  <button
                    className="gallery-card-main"
                    onClick={() => void window.chromecraft.openGallery(item.id)}
                    disabled={!item.available}
                    aria-label={`${item.available ? "Play" : "Unavailable"}: ${item.title}`}
                  >
                    <GalleryPreview item={item} />
                    <span className="gallery-card-copy">
                      <strong title={item.title}>{item.title}</strong>
                      {item.sourceName && (
                        <span className="gallery-card-source">
                          {item.sourceName}
                        </span>
                      )}
                      <small>{metadata.join(" · ")}</small>
                      <small>
                        Downloaded{" "}
                        {new Date(item.downloadedAt).toLocaleDateString()}
                      </small>
                    </span>
                  </button>
                  <GalleryMenu item={item} onError={reportError} />
                </article>
              );
            })}
            {items.length === 0 && (
              <div className="gallery-no-results">
                <span
                  className="material-icon material-symbols-rounded"
                  aria-hidden="true"
                >
                  search_off
                </span>
                <h2>No videos found</h2>
                <p>Nothing in your library matches “{query}”.</p>
                <button
                  type="button"
                  className="tonal-button"
                  onClick={() => setQuery("")}
                >
                  Clear search
                </button>
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

      {confirmDeleteAll && (
        <ConfirmationDialog
          title="Delete every video?"
          description={`All ${snapshot.items.length} videos in My Gallery will be permanently deleted from this device. This cannot be undone.`}
          confirmLabel="Delete all videos"
          onCancel={() => setConfirmDeleteAll(false)}
          onConfirm={runDeleteAll}
        />
      )}
      {repairOpen && (
        <GalleryRepairDialog
          repairing={repairing}
          onCancel={() => setRepairOpen(false)}
          onRepair={repairGallery}
        />
      )}
    </main>
  );
}
