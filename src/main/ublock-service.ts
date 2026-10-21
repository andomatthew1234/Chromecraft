import { app, type Extension, type Session, type WebContents } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { UblockSnapshot } from "../shared/browser";
import { PreferencesStore } from "./preferences";

interface ExtensionManifest {
  name?: string;
  version?: string;
}

export class UblockService {
  private extension: Extension | null = null;
  private error: string | null = null;
  private initialization: Promise<void> | null = null;
  private initializing = false;
  private stableExtensionPath: string | null = null;

  constructor(
    private readonly browserSession: Session,
    private readonly preferences: PreferencesStore,
  ) {}

  get snapshot(): UblockSnapshot {
    return {
      enabled: this.preferences.snapshot.ublockEnabled,
      initializing:
        this.initializing ||
        (this.preferences.snapshot.ublockEnabled &&
          this.extension === null &&
          this.error === null),
      ready: this.extension !== null,
      name: this.extension?.name ?? null,
      version: this.extension?.version ?? null,
      error: this.error,
    };
  }

  get extensionOrigin(): string | null {
    return this.extension ? `chrome-extension://${this.extension.id}` : null;
  }

  initialize(): Promise<void> {
    this.initialization ??= this.initializeOnce();
    return this.initialization;
  }

  async readyForNavigation(): Promise<void> {
    await this.initialize();
  }

  private async initializeOnce(): Promise<void> {
    this.initializing = true;
    try {
      if (this.preferences.snapshot.ublockEnabled) {
        this.stableExtensionPath = await this.installBundledExtension();
        await this.load();
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      console.error("uBlock Origin initialization failed.", error);
    } finally {
      this.initializing = false;
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.initialize();
    await this.preferences.setUblockEnabled(enabled);
    this.error = null;

    if (enabled) {
      this.initializing = true;
      try {
        if (!this.stableExtensionPath) {
          this.stableExtensionPath = await this.installBundledExtension();
        }
        await this.load();
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.initializing = false;
      }
      return;
    }

    if (this.extension) {
      await this.browserSession.extensions.removeExtension(this.extension.id);
      this.extension = null;
    }
  }

  getDashboardUrl(): string | null {
    return this.extensionOrigin
      ? `${this.extensionOrigin}/dashboard.html`
      : null;
  }

  private async load(): Promise<void> {
    if (this.extension || !this.stableExtensionPath) return;

    const filterReadyMarker = "[Chromecraft] uBlock filtering ready";
    const readyExtensionIds = new Set<string>();
    const consoleListeners = new Map<
      WebContents,
      (
        details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
        level: number,
        message: string,
        line: number,
        sourceId: string,
      ) => void
    >();
    let loadedExtension: Extension | null = null;
    let resolveReady!: () => void;
    let resolveFilterReady!: () => void;
    let rejectFilterReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const filterReady = new Promise<void>((resolve, reject) => {
      resolveFilterReady = resolve;
      rejectFilterReady = reject;
    });
    const filterReadyTimer = setTimeout(
      () =>
        rejectFilterReady(
          new Error("uBlock Origin's filtering engine did not become ready."),
        ),
      60_000,
    );
    const onReady = (_event: Electron.Event, extension: Extension) => {
      readyExtensionIds.add(extension.id);
      if (extension.id === loadedExtension?.id) resolveReady();
    };
    const attachConsoleListener = (contents: WebContents) => {
      const onConsoleMessage = (
        details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
        _level: number,
        legacyMessage: string,
      ) => {
        const message = details.message ?? legacyMessage;
        const isExtensionBackground =
          contents.getType() === "backgroundPage" ||
          contents.getURL().startsWith("chrome-extension://");
        if (isExtensionBackground && message === filterReadyMarker) {
          resolveFilterReady();
        }
      };
      consoleListeners.set(contents, onConsoleMessage);
      contents.on("console-message", onConsoleMessage);
    };
    const onWebContentsCreated = (
      _event: Electron.Event,
      contents: WebContents,
    ) => attachConsoleListener(contents);
    this.browserSession.extensions.on("extension-ready", onReady);
    app.on("web-contents-created", onWebContentsCreated);

    let extension: Extension;
    try {
      extension = await this.browserSession.extensions.loadExtension(
        this.stableExtensionPath,
        {
          allowFileAccess: false,
        },
      );
      loadedExtension = extension;
      if (readyExtensionIds.has(extension.id)) resolveReady();

      if (
        extension.name !== "uBlock Origin" ||
        extension.version !== "1.75.0"
      ) {
        await this.browserSession.extensions.removeExtension(extension.id);
        throw new Error(
          `Unexpected bundled extension: ${extension.name} ${extension.version}. Expected uBlock Origin 1.75.0.`,
        );
      }

      await Promise.all([ready, filterReady]);
    } finally {
      clearTimeout(filterReadyTimer);
      this.browserSession.extensions.removeListener("extension-ready", onReady);
      app.removeListener("web-contents-created", onWebContentsCreated);
      for (const [contents, listener] of consoleListeners) {
        if (!contents.isDestroyed()) {
          contents.removeListener("console-message", listener);
        }
      }
    }

    this.extension = extension;
    console.info(
      `Loaded ${extension.name} ${extension.version} (${extension.id}).`,
    );
  }

  private async installBundledExtension(): Promise<string> {
    const bundledPath = app.isPackaged
      ? path.join(process.resourcesPath, "extensions", "ublock-origin")
      : path.join(app.getAppPath(), "resources", "extensions", "ublock-origin");
    const bundledManifest = await this.readManifest(bundledPath);
    const bundledCompatVersion = await this.readCompatVersion(bundledPath);

    if (bundledManifest.version !== "1.75.0") {
      throw new Error(
        `Bundled uBlock Origin version is ${bundledManifest.version ?? "unknown"}.`,
      );
    }

    const root = path.join(app.getPath("userData"), "extensions");
    const destination = path.join(root, "ublock-origin");
    const temporary = path.join(root, "ublock-origin.next");
    const previous = path.join(root, "ublock-origin.previous");

    try {
      const installedManifest = await this.readManifest(destination);
      const installedCompatVersion = await this.readCompatVersion(destination);
      if (
        installedManifest.version === bundledManifest.version &&
        installedCompatVersion === bundledCompatVersion
      )
        return destination;
    } catch {
      // A missing or invalid installed copy is replaced from the reviewed bundled asset.
    }

    await fs.mkdir(root, { recursive: true });
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.rm(previous, { recursive: true, force: true });
    await fs.cp(bundledPath, temporary, { recursive: true, force: false });

    try {
      await fs.rename(destination, previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await fs.rename(temporary, destination);
    await fs.rm(previous, { recursive: true, force: true });
    return destination;
  }

  private async readManifest(
    extensionPath: string,
  ): Promise<ExtensionManifest> {
    const raw = await fs.readFile(
      path.join(extensionPath, "manifest.json"),
      "utf8",
    );
    return JSON.parse(raw) as ExtensionManifest;
  }

  private async readCompatVersion(extensionPath: string): Promise<string> {
    return (
      await fs.readFile(
        path.join(extensionPath, ".chromecraft-compat-version"),
        "utf8",
      )
    ).trim();
  }
}
