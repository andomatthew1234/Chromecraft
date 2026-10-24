import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  PerformanceCentreApi,
  PerformanceCentreSnapshot,
  PerformanceRefreshInterval,
  PerformanceTaskRow,
} from "../shared/performance-centre";
import {
  filterPerformanceRows,
  formatPerformanceCpu,
  formatPerformanceMemory,
  sortPerformanceRows,
  type PerformanceSort,
  type PerformanceSortColumn,
} from "./performance-centre-model";

declare global {
  interface Window {
    performanceCentre: PerformanceCentreApi;
  }
}

type OptionalColumn = "pid" | "type" | "network" | "javascript" | "status";

const KIND_ICONS: Record<PerformanceTaskRow["kind"], string> = {
  browser: "language",
  renderer: "tab",
  gpu: "memory",
  utility: "settings_suggest",
  extension: "extension",
  other: "deployed_code",
};

export function PerformanceCentre() {
  const [snapshot, setSnapshot] = useState<PerformanceCentreSnapshot | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PerformanceSort>({
    column: "memory",
    direction: "descending",
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [columns, setColumns] = useState<Set<OptionalColumn>>(new Set());
  const [confirmProcess, setConfirmProcess] =
    useState<PerformanceTaskRow | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    void window.performanceCentre.getSnapshot().then((value) => {
      if (live) setSnapshot(value);
    });
    const unsubscribe = window.performanceCentre.onSnapshot((value) => {
      if (live) setSnapshot(value);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!confirmProcess) return;
    cancelButtonRef.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmProcess(null);
    };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [confirmProcess]);

  const rows = useMemo(
    () =>
      sortPerformanceRows(
        filterPerformanceRows(snapshot?.rows ?? [], query),
        sort,
      ),
    [query, snapshot?.rows, sort],
  );
  useEffect(() => {
    if (!selected) return;
    const exists = rows.some(
      (row) =>
        row.id === selected ||
        row.children.some((child) => `tab:${child.id}` === selected),
    );
    if (!exists) setSelected(null);
  }, [rows, selected]);

  const selectedProcess =
    snapshot?.rows.find((row) => row.id === selected) ?? null;
  const selectedTabId = selected?.startsWith("tab:") ? selected.slice(4) : null;
  const closeableTabId =
    selectedTabId ??
    (selectedProcess?.children.length === 1
      ? selectedProcess.children[0]!.id
      : null);

  const chooseSort = (column: PerformanceSortColumn) => {
    setSort((current) => ({
      column,
      direction:
        current.column === column && current.direction === "descending"
          ? "ascending"
          : "descending",
    }));
  };
  const runTabAction = async (
    type: "switch-to-tab" | "close-tab" | "reload-tab",
    tabId: string,
  ) => {
    const result = await window.performanceCentre.performAction({
      type,
      tabId,
    });
    setAnnouncement(result.message);
  };
  const endProcess = async (row: PerformanceTaskRow) => {
    const result = await window.performanceCentre.performAction({
      type: "end-process",
      processId: row.id,
    });
    setAnnouncement(result.message);
    setConfirmProcess(null);
  };

  return (
    <main className="performance-centre">
      <header className="performance-header">
        <div className="performance-title">
          <span
            className="material-symbols-rounded performance-title-icon"
            aria-hidden="true"
          >
            speed
          </span>
          <div>
            <h1>Performance Centre</h1>
            <p>See what&apos;s using your browser&apos;s resources.</p>
          </div>
        </div>
        <div className="performance-controls">
          <label className="performance-search">
            <span className="material-symbols-rounded" aria-hidden="true">
              search
            </span>
            <span className="sr-only">Search tasks</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tasks"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <span className="material-symbols-rounded" aria-hidden="true">
                  close
                </span>
              </button>
            )}
          </label>
          <label className="refresh-control">
            <span className="sr-only">Refresh rate</span>
            <select
              value={snapshot?.refreshInterval ?? "paused"}
              onChange={(event) => {
                const value = event.target.value;
                const interval: PerformanceRefreshInterval =
                  value === "paused"
                    ? null
                    : (Number(value) as 1_000 | 2_000 | 5_000);
                void window.performanceCentre.setRefreshInterval(interval);
              }}
              aria-label="Refresh rate"
            >
              <option value="1000">Every 1 sec</option>
              <option value="2000">Every 2 sec</option>
              <option value="5000">Every 5 sec</option>
              <option value="paused">Paused</option>
            </select>
          </label>
          <button
            type="button"
            className="icon-button"
            title="Choose columns"
            aria-label="Choose columns"
            aria-expanded={columnMenuOpen}
            onClick={() => setColumnMenuOpen((open) => !open)}
          >
            <span className="material-symbols-rounded" aria-hidden="true">
              view_column
            </span>
          </button>
          <button
            type="button"
            className="icon-button"
            title="Close Performance Centre"
            aria-label="Close Performance Centre"
            onClick={() => void window.performanceCentre.close()}
          >
            <span className="material-symbols-rounded" aria-hidden="true">
              close
            </span>
          </button>
          {columnMenuOpen && (
            <section
              className="column-menu"
              role="menu"
              aria-label="Optional columns"
            >
              <strong>Show columns</strong>
              {(
                [
                  ["pid", "Process ID"],
                  ["type", "Task type"],
                  ["network", "Network activity"],
                  ["javascript", "JavaScript memory"],
                  ["status", "Process status"],
                ] as const
              ).map(([column, label]) => (
                <label
                  key={column}
                  role="menuitemcheckbox"
                  aria-checked={columns.has(column)}
                >
                  <input
                    type="checkbox"
                    checked={columns.has(column)}
                    onChange={() =>
                      setColumns((current) => {
                        const next = new Set(current);
                        if (next.has(column)) next.delete(column);
                        else next.add(column);
                        return next;
                      })
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
              <small>
                Network and JavaScript memory show unavailable when Electron
                cannot measure them reliably.
              </small>
            </section>
          )}
        </div>
      </header>

      <section
        className="summary-bar"
        aria-label="Chromecraft resource summary"
      >
        <SummaryMetric
          icon="speed"
          label="Process CPU"
          value={formatPerformanceCpu(snapshot?.cpuPercent ?? null)}
          detail={
            snapshot?.refreshInterval === null
              ? "Updates paused"
              : "Across Chromecraft"
          }
          title={snapshot?.notes.cpu}
        />
        <SummaryMetric
          icon="memory_alt"
          label="Process memory"
          value={formatPerformanceMemory(snapshot?.memoryBytes ?? null)}
          detail={
            snapshot?.systemMemoryBytes
              ? `of ${formatPerformanceMemory(snapshot.systemMemoryBytes)} system memory`
              : "Chromecraft processes"
          }
          title={snapshot?.notes.memory}
        />
        <SummaryMetric
          icon="account_tree"
          label="Processes"
          value={snapshot ? String(snapshot.processCount) : "—"}
          detail="Currently tracked"
        />
      </section>

      <section className="task-table-surface" aria-busy={!snapshot}>
        <div className="task-table-scroll">
          <table className="task-table">
            <thead>
              <tr>
                <SortableHeader column="task" sort={sort} onSort={chooseSort}>
                  Task
                </SortableHeader>
                <SortableHeader
                  column="cpu"
                  sort={sort}
                  onSort={chooseSort}
                  numeric
                >
                  CPU
                </SortableHeader>
                <SortableHeader
                  column="memory"
                  sort={sort}
                  onSort={chooseSort}
                  numeric
                >
                  Memory
                </SortableHeader>
                {columns.has("pid") && (
                  <SortableHeader
                    column="pid"
                    sort={sort}
                    onSort={chooseSort}
                    numeric
                  >
                    Process ID
                  </SortableHeader>
                )}
                {columns.has("type") && (
                  <SortableHeader column="type" sort={sort} onSort={chooseSort}>
                    Task type
                  </SortableHeader>
                )}
                {columns.has("network") && <th className="numeric">Network</th>}
                {columns.has("javascript") && (
                  <th className="numeric">JS memory</th>
                )}
                {columns.has("status") && (
                  <SortableHeader
                    column="status"
                    sort={sort}
                    onSort={chooseSort}
                  >
                    Status
                  </SortableHeader>
                )}
              </tr>
            </thead>
            <tbody>
              {!snapshot && (
                <tr>
                  <td colSpan={8} className="empty-state">
                    <span className="loading-ring" />
                    Taking the first real measurement…
                  </td>
                </tr>
              )}
              {snapshot && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty-state">
                    <span className="material-symbols-rounded">search_off</span>
                    No tasks match “{query}”.
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const open =
                  expanded.has(row.id) ||
                  Boolean(query.trim() && row.children.length);
                return (
                  <Fragment key={row.id}>
                    <tr
                      className={selected === row.id ? "selected" : ""}
                      aria-selected={selected === row.id}
                      tabIndex={
                        selected === row.id || selected === null ? 0 : -1
                      }
                      onClick={() => setSelected(row.id)}
                      onKeyDown={(event) => {
                        if (event.key === " " || event.key === "Enter") {
                          event.preventDefault();
                          setSelected(row.id);
                        } else if (
                          event.key === "ArrowRight" &&
                          row.children.length
                        ) {
                          setExpanded((current) =>
                            new Set(current).add(row.id),
                          );
                        } else if (event.key === "ArrowLeft") {
                          setExpanded((current) => {
                            const next = new Set(current);
                            next.delete(row.id);
                            return next;
                          });
                        }
                      }}
                    >
                      <td>
                        <div className="task-cell">
                          {row.children.length > 0 ? (
                            <button
                              type="button"
                              className="expand-button"
                              aria-label={`${open ? "Collapse" : "Expand"} ${row.title}`}
                              aria-expanded={open}
                              onClick={(event) => {
                                event.stopPropagation();
                                setExpanded((current) => {
                                  const next = new Set(current);
                                  if (next.has(row.id)) next.delete(row.id);
                                  else next.add(row.id);
                                  return next;
                                });
                              }}
                            >
                              <span className="material-symbols-rounded">
                                {open ? "expand_more" : "chevron_right"}
                              </span>
                            </button>
                          ) : (
                            <span className="expand-spacer" />
                          )}
                          <span
                            className={`task-icon ${row.kind}`}
                            aria-hidden="true"
                          >
                            <span className="material-symbols-rounded">
                              {KIND_ICONS[row.kind]}
                            </span>
                          </span>
                          <span className="task-copy">
                            <strong>{row.title}</strong>
                            <small>{row.subtitle}</small>
                          </span>
                          {row.affectedTabCount > 1 && (
                            <span className="shared-chip">
                              Shared · {row.affectedTabCount} tabs
                            </span>
                          )}
                        </div>
                      </td>
                      <td
                        className="numeric"
                        title={
                          row.cpuPercent === null
                            ? "Unavailable until the next sample"
                            : undefined
                        }
                      >
                        {formatPerformanceCpu(row.cpuPercent)}
                      </td>
                      <td className="numeric">
                        {formatPerformanceMemory(row.memoryBytes)}
                      </td>
                      {columns.has("pid") && (
                        <td className="numeric">{row.pid}</td>
                      )}
                      {columns.has("type") && <td>{row.taskType}</td>}
                      {columns.has("network") && (
                        <td
                          className="numeric unavailable"
                          title="Reliable per-process network activity is not available"
                        >
                          —
                        </td>
                      )}
                      {columns.has("javascript") && (
                        <td
                          className="numeric unavailable"
                          title="Reliable per-process JavaScript memory is not available"
                        >
                          —
                        </td>
                      )}
                      {columns.has("status") && (
                        <td>
                          <span className="status-dot" />
                          {row.status === "running" ? "Running" : "Unavailable"}
                        </td>
                      )}
                    </tr>
                    {open &&
                      row.children.map((child) => (
                        <tr
                          key={child.id}
                          className={`child-row ${selected === `tab:${child.id}` ? "selected" : ""}`}
                          aria-selected={selected === `tab:${child.id}`}
                          tabIndex={selected === `tab:${child.id}` ? 0 : -1}
                          onClick={() => setSelected(`tab:${child.id}`)}
                          onDoubleClick={() =>
                            void runTabAction("switch-to-tab", child.id)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter")
                              void runTabAction("switch-to-tab", child.id);
                            if (event.key === " ") {
                              event.preventDefault();
                              setSelected(`tab:${child.id}`);
                            }
                          }}
                        >
                          <td>
                            <div className="task-cell child">
                              <span className="child-branch" aria-hidden="true">
                                ↳
                              </span>
                              <span className="favicon-wrap">
                                {child.faviconDataUrl ? (
                                  <img src={child.faviconDataUrl} alt="" />
                                ) : (
                                  <span className="material-symbols-rounded">
                                    public
                                  </span>
                                )}
                              </span>
                              <span className="task-copy">
                                <strong>{child.title}</strong>
                                <small>
                                  {child.subtitle} ·{" "}
                                  {child.active ? "Active" : "Background"}
                                  {child.crashed ? " · Crashed" : ""}
                                </small>
                              </span>
                            </div>
                          </td>
                          <td className="numeric shared-value">Shared</td>
                          <td className="numeric shared-value">Shared</td>
                          {columns.has("pid") && (
                            <td className="numeric">{row.pid}</td>
                          )}
                          {columns.has("type") && <td>Browser tab</td>}
                          {columns.has("network") && (
                            <td className="numeric unavailable">—</td>
                          )}
                          {columns.has("javascript") && (
                            <td className="numeric unavailable">—</td>
                          )}
                          {columns.has("status") && (
                            <td>
                              {child.crashed
                                ? "Crashed"
                                : child.active
                                  ? "Active"
                                  : "Background"}
                            </td>
                          )}
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="performance-footer">
        <div className="footer-status">
          <span
            className={`live-indicator ${snapshot?.refreshInterval === null ? "paused" : ""}`}
          />
          {snapshot?.refreshInterval === null
            ? "Measurements paused"
            : snapshot
              ? `Updated ${new Date(snapshot.sampledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
              : "Warming up measurements"}
        </div>
        <div className="footer-actions">
          {selectedTabId && (
            <button
              type="button"
              className="text-button"
              onClick={() => void runTabAction("reload-tab", selectedTabId)}
            >
              Reload tab
            </button>
          )}
          <button
            type="button"
            className="tonal-button"
            disabled={!closeableTabId}
            title={
              !closeableTabId
                ? "Select one browser tab to close it normally"
                : "Close the selected tab"
            }
            onClick={() =>
              closeableTabId && void runTabAction("close-tab", closeableTabId)
            }
          >
            Close tab
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={!selectedProcess?.canEndProcess}
            title={
              selectedProcess?.canEndProcess
                ? "End the selected renderer process"
                : "This process is protected or cannot be ended safely"
            }
            onClick={() =>
              selectedProcess && setConfirmProcess(selectedProcess)
            }
          >
            End process
          </button>
        </div>
      </footer>

      {confirmProcess && (
        <div
          className="dialog-scrim"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setConfirmProcess(null)
          }
        >
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="end-process-title"
            aria-describedby="end-process-description"
          >
            <span
              className="material-symbols-rounded dialog-icon"
              aria-hidden="true"
            >
              warning
            </span>
            <h2 id="end-process-title">End this process?</h2>
            <p id="end-process-description">
              Unsaved information in{" "}
              {confirmProcess.affectedTabCount === 1
                ? "the affected tab"
                : `${confirmProcess.affectedTabCount} affected tabs`}{" "}
              may be lost. You can reload crashed tabs afterwards.
            </p>
            <div className="dialog-actions">
              <button
                ref={cancelButtonRef}
                type="button"
                className="text-button"
                onClick={() => setConfirmProcess(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void endProcess(confirmProcess)}
              >
                End process
              </button>
            </div>
          </section>
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </main>
  );
}

function SummaryMetric({
  icon,
  label,
  value,
  detail,
  title,
}: {
  icon: string;
  label: string;
  value: string;
  detail: string;
  title?: string;
}) {
  return (
    <div className="summary-metric" title={title}>
      <span className="material-symbols-rounded" aria-hidden="true">
        {icon}
      </span>
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </div>
  );
}

function SortableHeader({
  column,
  sort,
  onSort,
  numeric,
  children,
}: {
  column: PerformanceSortColumn;
  sort: PerformanceSort;
  onSort: (column: PerformanceSortColumn) => void;
  numeric?: boolean;
  children: ReactNode;
}) {
  const active = sort.column === column;
  return (
    <th
      className={numeric ? "numeric" : undefined}
      aria-sort={active ? sort.direction : "none"}
    >
      <button type="button" onClick={() => onSort(column)}>
        {children}
        {active && (
          <span className="material-symbols-rounded" aria-hidden="true">
            {sort.direction === "ascending" ? "arrow_upward" : "arrow_downward"}
          </span>
        )}
      </button>
    </th>
  );
}
