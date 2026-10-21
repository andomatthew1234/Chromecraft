import { BaseWindow, WebContentsView } from "electron";

const HINT_MAX_WIDTH = 420;
const HINT_HEIGHT = 58;
const HINT_MARGIN = 12;
const HINT_VISIBLE_MS = 4_500;

const hintDocument = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <meta name="color-scheme" content="dark">
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
      body { display: grid; place-items: center; padding: 5px; font: 500 13px/1.25 system-ui, sans-serif; }
      .hint {
        min-height: 46px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 0 18px;
        border: 1px solid rgba(255, 255, 255, .16);
        border-radius: 24px;
        color: #f2f1f8;
        background: #24252b;
        box-shadow: 0 3px 12px rgba(0, 0, 0, .34);
        white-space: nowrap;
        animation: enter 180ms cubic-bezier(.2, 0, 0, 1) both;
      }
      @keyframes enter { from { opacity: 0; transform: translateY(-8px) scale(.98); } }
      @media (prefers-reduced-motion: reduce) { .hint { animation: none; } }
      .icon { color: #9ed49f; font-size: 18px; line-height: 1; }
      kbd {
        min-width: 30px;
        padding: 3px 7px;
        border: 1px solid rgba(255, 255, 255, .22);
        border-radius: 7px;
        color: #d7f0d5;
        background: #34363d;
        font: 600 12px/1 system-ui, sans-serif;
        text-align: center;
      }
    </style>
  </head>
  <body><div class="hint" role="status"><span class="icon" aria-hidden="true">⛶</span><span>Fullscreen</span><span>Press <kbd>Esc</kbd> to exit</span></div></body>
</html>`;

export function calculateFullscreenHintBounds(
  width: number,
): Electron.Rectangle {
  const availableWidth = Math.max(0, Math.floor(width));
  const hintWidth = Math.max(
    0,
    Math.min(HINT_MAX_WIDTH, availableWidth - HINT_MARGIN * 2),
  );
  return {
    x: Math.max(0, Math.floor((availableWidth - hintWidth) / 2)),
    y: HINT_MARGIN,
    width: hintWidth,
    height: HINT_HEIGHT,
  };
}

/** Owns Chromecraft's trusted, page-independent fullscreen disclosure. */
export class FullscreenHintController {
  private view: WebContentsView | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly parent: BaseWindow) {}

  show(): void {
    if (this.disposed || this.parent.isDestroyed()) return;
    const view = this.ensureView();
    if (view.webContents.isDestroyed()) return;
    try {
      this.parent.contentView.removeChildView(view);
    } catch {
      // A newly-created view is not attached yet.
    }
    this.parent.contentView.addChildView(view);
    this.layout();
    view.setVisible(true);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), HINT_VISIBLE_MS);
  }

  hide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    const view = this.view;
    if (view && !view.webContents.isDestroyed()) view.setVisible(false);
  }

  layout(): void {
    const view = this.view;
    if (!view || view.webContents.isDestroyed() || this.parent.isDestroyed())
      return;
    view.setBounds(
      calculateFullscreenHintBounds(this.parent.getContentBounds().width),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hide();
    const view = this.view;
    this.view = null;
    if (!view) return;
    try {
      this.parent.contentView.removeChildView(view);
    } catch {
      // The parent may already be closing.
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  private ensureView(): WebContentsView {
    const existing = this.view;
    if (existing && !existing.webContents.isDestroyed()) return existing;
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void view.webContents
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(hintDocument)}`,
      )
      .catch(() => {
        // Closing the window while the hint loads is harmless.
      });
    this.view = view;
    return view;
  }
}
