import { useMemo, useState } from "react";

import type { OfflinePagesSnapshot } from "../shared/offline-pages";
import "./offline-pages.css";

function MaterialIcon({ name }: { name: string }) {
  return (
    <span className="material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function sourceHost(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return sourceUrl;
  }
}

export function OfflinePagesPage({
  snapshot,
  selectedId,
}: {
  snapshot: OfflinePagesSnapshot;
  selectedId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const visibleItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return snapshot.items;
    return snapshot.items.filter((item) =>
      `${item.title} ${item.sourceUrl}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, snapshot.items]);

  return (
    <main className="offline-pages-surface">
      <header className="offline-pages-hero">
        <span className="offline-pages-hero-icon">
          <MaterialIcon name="download_for_offline" />
        </span>
        <span>
          <h1>Offline Pages</h1>
          <p>Static page copies you can open without an internet connection.</p>
        </span>
        {snapshot.items.length > 0 && (
          <label className="offline-pages-search">
            <MaterialIcon name="search" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search saved pages"
              aria-label="Search offline pages"
            />
          </label>
        )}
      </header>

      {snapshot.items.length === 0 ? (
        <section className="offline-pages-empty">
          <span>
            <MaterialIcon name="travel_explore" />
          </span>
          <h2>No offline pages yet</h2>
          <p>
            Open a website, press the info icon in the address bar, then choose
            Save for later.
          </p>
        </section>
      ) : visibleItems.length === 0 ? (
        <section className="offline-pages-empty compact">
          <span>
            <MaterialIcon name="search_off" />
          </span>
          <h2>No matching pages</h2>
          <p>Try another title or website.</p>
        </section>
      ) : (
        <section
          className="offline-pages-grid"
          aria-label="Saved offline pages"
        >
          {visibleItems.map((item) => (
            <article
              className="offline-page-card"
              data-selected={item.id === selectedId}
              data-available={item.available}
              key={item.id}
            >
              <button
                type="button"
                className="offline-page-preview"
                disabled={!item.available}
                onClick={() => void window.chromecraft.openOfflinePage(item.id)}
                aria-label={`Open ${item.title} offline`}
              >
                {item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl} alt="" />
                ) : (
                  <span className="offline-page-placeholder">
                    <MaterialIcon name="language" />
                  </span>
                )}
                <span className="offline-page-open-badge">
                  <MaterialIcon
                    name={item.available ? "offline_bolt" : "broken_image"}
                  />
                  {item.available ? "Open offline" : "Copy missing"}
                </span>
              </button>
              <div className="offline-page-card-copy">
                <h2 title={item.title}>{item.title}</h2>
                <p>{sourceHost(item.sourceUrl)}</p>
                <small>
                  Saved {new Date(item.savedAt).toLocaleDateString()} ·{" "}
                  {formatBytes(item.fileSize)}
                </small>
              </div>
              <div className="offline-page-card-actions">
                <button
                  type="button"
                  disabled={!item.available}
                  onClick={() =>
                    void window.chromecraft.openOfflinePage(item.id)
                  }
                >
                  <MaterialIcon name="offline_bolt" />
                  Open
                </button>
                <button
                  type="button"
                  title="Open the live website"
                  aria-label={`Open live website for ${item.title}`}
                  onClick={() =>
                    void window.chromecraft.createTab(item.sourceUrl)
                  }
                >
                  <MaterialIcon name="open_in_new" />
                </button>
                <button
                  type="button"
                  disabled={removingId === item.id}
                  title="Delete offline copy"
                  aria-label={`Delete offline copy of ${item.title}`}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Delete the offline copy of “${item.title}”?`,
                      )
                    )
                      return;
                    setRemovingId(item.id);
                    void window.chromecraft
                      .deleteOfflinePage(item.id)
                      .finally(() => setRemovingId(null));
                  }}
                >
                  <MaterialIcon name="delete" />
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
