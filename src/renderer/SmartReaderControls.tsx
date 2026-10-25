import { useEffect } from "react";

import type { BrowserTabSnapshot } from "../shared/browser";
import { readSmartReaderAppearance } from "./smart-reader-appearance";
import "./smart-reader-controls.css";

function MaterialIcon({ name }: { name: string }) {
  return (
    <span className="material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

export function SmartReaderControls({
  tab,
  onPopoverOpenChange,
}: {
  tab: BrowserTabSnapshot;
  progressVisible?: boolean;
  onAskScout?: () => void;
  onPopoverOpenChange: (open: boolean) => void;
}) {
  const visible = tab.reader.availability === "available" || tab.reader.active;

  useEffect(() => {
    onPopoverOpenChange(false);
    return () => onPopoverOpenChange(false);
  }, [tab.id, tab.reader.active, onPopoverOpenChange]);

  if (!visible) return null;

  return (
    <div
      className="reader-toolbar-cluster"
      data-reader-state={tab.reader.active ? "active" : "available"}
    >
      <button
        type="button"
        className="tool-button reader-button"
        data-smart-reader-button
        data-reader-tab-id={tab.id}
        data-active={tab.reader.active}
        aria-label={
          tab.reader.active ? "Exit Smart Reader" : "Open Smart Reader"
        }
        aria-pressed={tab.reader.active}
        title={tab.reader.active ? "Exit Smart Reader" : "Open Smart Reader"}
        onClick={() =>
          void window.chromecraft.toggleSmartReader(
            tab.id,
            readSmartReaderAppearance(),
          )
        }
      >
        <MaterialIcon name="chrome_reader_mode" />
      </button>
    </div>
  );
}
