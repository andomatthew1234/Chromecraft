import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

import type { BrowserTabSnapshot } from "../shared/browser";
import type {
  SmartReaderAppearance,
  SmartReaderFont,
  SmartReaderTheme,
} from "../shared/smart-reader";
import {
  readSmartReaderAppearance,
  writeSmartReaderAppearance,
} from "./smart-reader-appearance";
import "./smart-reader-controls.css";

function MaterialIcon({ name }: { name: string }) {
  return (
    <span className="material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

function AppearancePopover({
  tabId,
  anchor,
  close,
}: {
  tabId: string;
  anchor: HTMLButtonElement;
  close: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [appearance, setAppearance] = useState(readSmartReaderAppearance);
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 });

  useLayoutEffect(() => {
    const place = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const panelRect = panel.current?.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 16);
      const height = panelRect?.height ?? 330;
      setStyle({
        width,
        left: Math.max(
          8,
          Math.min(anchorRect.right - width, window.innerWidth - width - 8),
        ),
        top: Math.max(
          8,
          Math.min(anchorRect.bottom + 8, window.innerHeight - height - 8),
        ),
        opacity: 1,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [anchor]);

  useEffect(() => {
    panel.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        (panel.current?.contains(event.target) || anchor.contains(event.target))
      ) {
        return;
      }
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      anchor.focus();
    };
  }, [anchor, close]);

  const update = (next: SmartReaderAppearance) => {
    const saved = writeSmartReaderAppearance(next);
    setAppearance(saved);
    void window.chromecraft.setSmartReaderAppearance(tabId, saved);
  };
  const chooseTheme = (theme: SmartReaderTheme) =>
    update({ ...appearance, theme });
  const chooseFont = (font: SmartReaderFont) => update({ ...appearance, font });

  return createPortal(
    <div
      ref={panel}
      className="reader-appearance-popover"
      style={style}
      role="dialog"
      aria-label="Smart Reader appearance"
      tabIndex={-1}
      data-smart-reader-appearance
    >
      <header>
        <span className="reader-appearance-icon">
          <MaterialIcon name="text_fields" />
        </span>
        <span>
          <strong>Reading appearance</strong>
          <small>Comfortable on every page</small>
        </span>
      </header>
      <section aria-labelledby="reader-theme-title">
        <h3 id="reader-theme-title">Paper</h3>
        <div className="reader-theme-grid">
          {(
            [
              ["system", "System"],
              ["light", "Light"],
              ["warm", "Warm"],
              ["dark", "Dark"],
            ] as const
          ).map(([theme, label]) => (
            <button
              key={theme}
              type="button"
              className={`reader-theme-choice reader-theme-${theme}`}
              aria-pressed={appearance.theme === theme}
              onClick={() => chooseTheme(theme)}
            >
              <span aria-hidden="true">Aa</span>
              {label}
            </button>
          ))}
        </div>
      </section>
      <section aria-labelledby="reader-size-title">
        <h3 id="reader-size-title">Text size</h3>
        <div className="reader-size-control">
          <button
            type="button"
            aria-label="Decrease text size"
            disabled={appearance.textScale <= 0.8}
            onClick={() =>
              update({ ...appearance, textScale: appearance.textScale - 0.05 })
            }
          >
            A−
          </button>
          <output>{Math.round(appearance.textScale * 100)}%</output>
          <button
            type="button"
            aria-label="Increase text size"
            disabled={appearance.textScale >= 1.35}
            onClick={() =>
              update({ ...appearance, textScale: appearance.textScale + 0.05 })
            }
          >
            A+
          </button>
        </div>
      </section>
      <section aria-labelledby="reader-font-title">
        <h3 id="reader-font-title">Typeface</h3>
        <div className="reader-font-control">
          <button
            type="button"
            className="serif"
            aria-pressed={appearance.font === "serif"}
            onClick={() => chooseFont("serif")}
          >
            Serif
          </button>
          <button
            type="button"
            aria-pressed={appearance.font === "sans"}
            onClick={() => chooseFont("sans")}
          >
            Sans
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function SmartReaderControls({
  tab,
  onPopoverOpenChange,
}: {
  tab: BrowserTabSnapshot;
  onPopoverOpenChange: (open: boolean) => void;
}) {
  const appearanceButton = useRef<HTMLButtonElement>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const visible = tab.reader.availability === "available" || tab.reader.active;

  useEffect(() => {
    setAppearanceOpen(false);
  }, [tab.id, tab.reader.active]);
  useEffect(() => {
    onPopoverOpenChange(appearanceOpen);
    return () => onPopoverOpenChange(false);
  }, [appearanceOpen, onPopoverOpenChange]);
  if (!visible) return null;

  const toggle = () => {
    setAppearanceOpen(false);
    void window.chromecraft.toggleSmartReader(
      tab.id,
      readSmartReaderAppearance(),
    );
  };
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
        title="Smart Reader"
        onClick={toggle}
      >
        <MaterialIcon name="chrome_reader_mode" />
      </button>
      {tab.reader.active && (
        <button
          ref={appearanceButton}
          type="button"
          className="tool-button reader-appearance-button"
          data-smart-reader-appearance-button
          aria-label="Reading appearance"
          aria-haspopup="dialog"
          aria-expanded={appearanceOpen}
          title="Reading appearance"
          onClick={() => setAppearanceOpen((open) => !open)}
        >
          <MaterialIcon name="text_fields" />
        </button>
      )}
      {appearanceOpen && appearanceButton.current && (
        <AppearancePopover
          tabId={tab.id}
          anchor={appearanceButton.current}
          close={() => setAppearanceOpen(false)}
        />
      )}
    </div>
  );
}
