import { BaseWindow, type Session, WebContentsView } from "electron";

import type { ExtensionPopupAnchor } from "../shared/browser";
import { isAllowedWebUrl } from "../shared/navigation";
import { ChromeWebStoreExtensionService } from "./chrome-web-store-extension-service";

const POPUP_WIDTH = 400;
const POPUP_HEIGHT = 600;
const POPUP_MARGIN = 10;
const POPUP_GAP = 6;

export interface ExtensionPopupControllerOptions {
  onStateChanged: () => void;
  openExternalUrl: (url: string) => void;
}

/**
 * Owns the complete lifecycle of the one browser-action popup a window may
 * display. Callers only choose an installed extension and provide the toolbar
 * button's client-space rectangle; positioning, focus dismissal, navigation
 * confinement, renderer isolation, and cleanup stay behind this interface.
 */
export class ExtensionPopupController {
  private popup: WebContentsView | null = null;
  private extensionId: string | null = null;
  private anchor: ExtensionPopupAnchor | null = null;
  private disposed = false;
  private generation = 0;
  private parentBlurArmed = false;

  private readonly reposition = (): void => {
    const popup = this.popup;
    const anchor = this.anchor;
    if (!popup || popup.webContents.isDestroyed() || !anchor) return;
    popup.setBounds(calculateExtensionPopupBounds(this.parent, anchor));
  };

  private readonly closeOnParentBlur = (): void => {
    if (!this.parentBlurArmed) return;
    const popup = this.popup;
    if (!popup || popup.webContents.isDestroyed()) return;
    const generation = this.generation;
    setImmediate(() => {
      if (
        !this.parentBlurArmed ||
        this.generation !== generation ||
        this.popup !== popup ||
        popup.webContents.isDestroyed()
      )
        return;
      // A WebContentsView receives focus through the same native window. Electron
      // emits a parent blur during that transition, which is not an outside click.
      if (popup.webContents.isFocused()) return;
      this.close();
    });
  };

  constructor(
    private readonly parent: BaseWindow,
    private readonly browserSession: Session,
    private readonly extensions: ChromeWebStoreExtensionService,
    private readonly options: ExtensionPopupControllerOptions,
  ) {
    parent.on("move", this.reposition);
    parent.on("resize", this.close);
    parent.on("maximize", this.close);
    parent.on("unmaximize", this.close);
    parent.on("hide", this.close);
    parent.on("blur", this.closeOnParentBlur);
  }

  get openExtensionId(): string | null {
    return this.extensionId;
  }

  async toggle(
    extensionId: string,
    anchor: ExtensionPopupAnchor,
  ): Promise<void> {
    if (this.disposed) throw new Error("Extension popups are unavailable.");
    requireAnchor(anchor);
    if (this.extensionId === extensionId && this.popup) {
      this.close();
      return;
    }

    const popupUrl = this.extensions.getExtensionPage(extensionId, "popup");
    if (!popupUrl) {
      throw new Error("That extension has no available toolbar popup.");
    }
    this.close();
    const generation = ++this.generation;
    this.extensionId = extensionId;
    this.anchor = { ...anchor };

    const popup = new WebContentsView({
      webPreferences: {
        session: this.browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    this.popup = popup;
    popup.setBackgroundColor("#ffffff");
    popup.setBounds(calculateExtensionPopupBounds(this.parent, anchor));
    popup.setVisible(false);
    this.parent.contentView.addChildView(popup);
    this.options.onStateChanged();

    const allowedExtension = new URL(popupUrl);
    popup.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedWebUrl(url)) {
        queueMicrotask(() => this.options.openExternalUrl(url));
      }
      return { action: "deny" };
    });
    popup.webContents.on("will-navigate", (event, url) => {
      let sameExtension = false;
      try {
        const candidate = new URL(url);
        sameExtension =
          candidate.protocol === "chrome-extension:" &&
          candidate.hostname === allowedExtension.hostname;
      } catch {
        // Invalid URLs are never a valid popup navigation.
      }
      if (sameExtension) return;
      event.preventDefault();
      if (isAllowedWebUrl(url)) this.options.openExternalUrl(url);
    });
    popup.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
    popup.webContents.on(
      "did-fail-load",
      (_event, errorCode, _description, _url, isMainFrame) => {
        if (isMainFrame && errorCode !== -3 && this.popup === popup) {
          this.close();
        }
      },
    );
    popup.webContents.on("render-process-gone", () => {
      if (this.popup === popup) this.close();
    });
    popup.webContents.once("destroyed", () => {
      if (this.popup !== popup) return;
      this.popup = null;
      this.extensionId = null;
      this.anchor = null;
      this.options.onStateChanged();
    });

    try {
      await popup.webContents.loadURL(popupUrl);
      if (
        this.generation !== generation ||
        this.popup !== popup ||
        popup.webContents.isDestroyed()
      )
        return;
      this.reposition();
      popup.setVisible(true);
      popup.webContents.focus();
      setImmediate(() => {
        if (
          this.generation === generation &&
          this.popup === popup &&
          !popup.webContents.isDestroyed()
        ) {
          this.parentBlurArmed = true;
        }
      });
    } catch (error) {
      if (this.popup === popup) this.close();
      throw error;
    }
  }

  close = (): void => {
    const popup = this.popup;
    this.generation += 1;
    this.parentBlurArmed = false;
    const changed = Boolean(popup || this.extensionId);
    this.popup = null;
    this.extensionId = null;
    this.anchor = null;
    if (popup) {
      try {
        this.parent.contentView.removeChildView(popup);
      } catch {
        // The parent may already be closing.
      }
      if (!popup.webContents.isDestroyed()) popup.webContents.close();
    }
    if (changed) this.options.onStateChanged();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.parent.removeListener("move", this.reposition);
    this.parent.removeListener("resize", this.close);
    this.parent.removeListener("maximize", this.close);
    this.parent.removeListener("unmaximize", this.close);
    this.parent.removeListener("hide", this.close);
    this.parent.removeListener("blur", this.closeOnParentBlur);
    this.close();
  }
}

export function calculateExtensionPopupBounds(
  parent: Pick<BaseWindow, "getContentBounds">,
  anchor: ExtensionPopupAnchor,
): Electron.Rectangle {
  requireAnchor(anchor);
  const content = parent.getContentBounds();
  const width = Math.max(
    1,
    Math.min(POPUP_WIDTH, content.width - POPUP_MARGIN * 2),
  );
  const availableBelow =
    content.height - (anchor.y + anchor.height + POPUP_GAP) - POPUP_MARGIN;
  const height = Math.max(
    1,
    Math.min(POPUP_HEIGHT, Math.max(240, availableBelow), content.height - 20),
  );
  const localX = Math.min(
    Math.max(POPUP_MARGIN, anchor.x + anchor.width - width),
    Math.max(POPUP_MARGIN, content.width - width - POPUP_MARGIN),
  );
  const preferredY = anchor.y + anchor.height + POPUP_GAP;
  const localY = Math.min(
    Math.max(POPUP_MARGIN, preferredY),
    Math.max(POPUP_MARGIN, content.height - height - POPUP_MARGIN),
  );
  return {
    x: Math.round(localX),
    y: Math.round(localY),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function requireAnchor(anchor: ExtensionPopupAnchor): void {
  const values = [anchor.x, anchor.y, anchor.width, anchor.height];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    anchor.x < 0 ||
    anchor.y < 0 ||
    anchor.width <= 0 ||
    anchor.height <= 0 ||
    values.some((value) => value > 16_384)
  ) {
    throw new TypeError("The extension popup anchor is invalid.");
  }
}
