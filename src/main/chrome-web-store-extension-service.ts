import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import type { Extension, Session } from "electron";

import { parseChromeWebStoreListingUrl } from "../shared/web-store-listing";

const UPDATE_SERVICE_URL = "https://clients2.google.com/service/update2/crx";
const REGISTRY_FILENAME = "installed-extensions.json";
const MAX_CRX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4_096;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const COMPATIBILITY_REVISION = 5;
const COMPATIBILITY_DIRECTORY = "chromecraft-compat";
const LEGACY_COMPATIBILITY_DIRECTORY = "__chromecraft";
const COMPATIBILITY_SCRIPT_PATH = `${COMPATIBILITY_DIRECTORY}/extension-compat.js`;
const COMPATIBILITY_WINDOW_BRIDGE_PATH = `${COMPATIBILITY_DIRECTORY}/window-bridge.js`;
const COMPATIBILITY_REVISION_PATH = `${COMPATIBILITY_DIRECTORY}/revision.json`;
const COMPATIBILITY_WORKER_PATH = "chromecraft-background-v5.js";
const LEGACY_COMPATIBILITY_WORKER_PATHS = new Set([
  `${LEGACY_COMPATIBILITY_DIRECTORY}/background-wrapper.js`,
  "__chromecraft_background-wrapper.js",
  "__chromecraft_background-v2.js",
  "__chromecraft_background-v3.js",
  "__chromecraft_background-v4.js",
]);
const LEGACY_COMPATIBILITY_SCRIPT_PATHS = new Set([
  `${LEGACY_COMPATIBILITY_DIRECTORY}/extension-compat.js`,
]);
const LEGACY_COMPATIBILITY_WINDOW_BRIDGE_PATHS = new Set([
  `${LEGACY_COMPATIBILITY_DIRECTORY}/window-bridge.js`,
]);

export interface InstalledExtensionSnapshot {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  ready: boolean;
  permissions: string[];
  hostPermissions: string[];
  warnings: string[];
  error: string | null;
  sourceUrl: string;
  optionsUrl: string | null;
  popupUrl: string | null;
  iconDataUrl: string | null;
}

export type ExtensionInstallProgressStage =
  | "downloading"
  | "verifying"
  | "preparing"
  | "installing"
  | "finishing"
  | "installed";

export interface ExtensionInstallProgress {
  stage: ExtensionInstallProgressStage;
  receivedBytes?: number;
  totalBytes?: number;
}

export type ExtensionInstallProgressListener = (
  progress: ExtensionInstallProgress,
) => void;

export interface PreparedExtensionPreview {
  token: string;
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  hostPermissions: string[];
  warnings: string[];
  sourceUrl: string;
}

interface StoredExtension {
  id: string;
  version: string;
  enabled: boolean;
  sourceUrl: string;
}

interface ExtensionRegistry {
  version: 1;
  extensions: StoredExtension[];
}

interface ExtensionRuntime {
  stored: StoredExtension;
  snapshot: InstalledExtensionSnapshot;
  extension: Extension | null;
}

interface PreparedExtension {
  preview: PreparedExtensionPreview;
  entries: ArchiveEntry[];
  manifest: ExtensionManifest;
}

export interface ChromeWebStoreExtensionServiceOptions {
  storagePath: string;
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  chromiumVersion: string;
  maximumCrxBytes?: number;
}

interface ParsedCrx {
  archive: Buffer;
  extensionId: string;
  publicKey: Buffer;
}

interface ArchiveEntry {
  name: string;
  data: Buffer;
  directory: boolean;
}

interface ExtensionManifest {
  manifest_version: number;
  name: string;
  version: string;
  default_locale?: unknown;
  key?: unknown;
  description?: string;
  permissions?: unknown;
  host_permissions?: unknown;
  optional_permissions?: unknown;
  options_page?: unknown;
  options_ui?: { page?: unknown };
  icons?: Record<string, unknown>;
  action?: { default_popup?: unknown; default_icon?: unknown };
  browser_action?: { default_popup?: unknown; default_icon?: unknown };
  page_action?: { default_popup?: unknown; default_icon?: unknown };
  background?: {
    service_worker?: unknown;
    scripts?: unknown;
    type?: unknown;
  };
  content_scripts?: Array<{
    matches?: unknown;
    js?: unknown;
    run_at?: unknown;
    all_frames?: unknown;
  }>;
}

export class ChromeWebStoreExtensionService {
  private readonly storagePath: string;
  private readonly registryPath: string;
  private readonly maximumCrxBytes: number;
  private readonly runtimes = new Map<string, ExtensionRuntime>();
  private preparedExtension: PreparedExtension | null = null;
  private activePreparation: {
    token: string;
    controller: AbortController;
  } | null = null;
  private committingPreviewToken: string | null = null;
  private initialized = false;

  constructor(
    private readonly browserSession: Session,
    private readonly options: ChromeWebStoreExtensionServiceOptions,
  ) {
    this.storagePath = path.resolve(options.storagePath);
    this.registryPath = path.join(this.storagePath, REGISTRY_FILENAME);
    this.maximumCrxBytes = Math.min(
      Math.max(options.maximumCrxBytes ?? MAX_CRX_BYTES, 1_024),
      MAX_EXTRACTED_BYTES,
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.storagePath, { recursive: true });
    const registry = await this.readRegistry();
    for (const stored of registry.extensions) {
      const runtime = await this.readRuntime(stored);
      this.runtimes.set(stored.id, runtime);
      if (stored.enabled) await this.loadRuntime(runtime, false);
    }
    this.initialized = true;
  }

  async listInstalled(): Promise<InstalledExtensionSnapshot[]> {
    this.requireInitialized();
    return [...this.runtimes.values()]
      .map(({ snapshot }) => cloneSnapshot(snapshot))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async installFromWebStoreUrl(
    itemUrl: string,
  ): Promise<InstalledExtensionSnapshot> {
    this.requireInitialized();
    const preview = await this.prepareFromWebStoreUrl(itemUrl);
    return this.commitPreparedExtension(preview.token);
  }

  async prepareFromWebStoreUrl(
    itemUrl: string,
    onProgress?: ExtensionInstallProgressListener,
  ): Promise<PreparedExtensionPreview> {
    this.requireInitialized();
    if (this.committingPreviewToken) {
      throw new Error("An extension installation is already in progress.");
    }
    this.cancelPreparedExtension();

    const extensionId = parseChromeWebStoreItemUrl(itemUrl);
    const token = randomUUID();
    const controller = new AbortController();
    this.activePreparation = { token, controller };

    try {
      emitInstallProgress(onProgress, {
        stage: "downloading",
        receivedBytes: 0,
      });
      const response = await this.options.fetch(
        buildUpdateUrl(extensionId, this.options.chromiumVersion),
        {
          method: "GET",
          redirect: "follow",
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        },
      );
      this.assertActivePreparation(token);
      if (!response.ok) {
        throw new Error(
          `Chrome Web Store download failed with HTTP ${response.status}.`,
        );
      }
      const crx = await readBoundedResponse(
        response,
        this.maximumCrxBytes,
        (receivedBytes, totalBytes) => {
          emitInstallProgress(onProgress, {
            stage: "downloading",
            receivedBytes,
            ...(totalBytes === undefined ? {} : { totalBytes }),
          });
        },
        controller.signal,
      );
      this.assertActivePreparation(token);
      emitInstallProgress(onProgress, { stage: "verifying" });
      const parsed = parseAndVerifyCrx3(crx);
      if (parsed.extensionId !== extensionId) {
        throw new Error(
          "The CRX signing identity does not match the requested extension id.",
        );
      }
      const entries = extractZipEntries(parsed.archive);
      const manifestEntry = entries.find(
        (entry) => !entry.directory && entry.name === "manifest.json",
      );
      if (!manifestEntry)
        throw new Error("The CRX archive has no manifest.json.");
      const manifest = parseManifest(manifestEntry.data);
      const signingKey = parsed.publicKey.toString("base64");
      if (manifest.key !== undefined && manifest.key !== signingKey) {
        throw new Error(
          "The extension manifest key does not match the verified CRX signing identity.",
        );
      }
      manifest.key = signingKey;
      this.assertActivePreparation(token);
      emitInstallProgress(onProgress, { stage: "preparing" });
      const localizedName = localizedManifestText(
        manifest.name,
        manifest,
        entries,
      );
      const localizedDescription = localizedManifestText(
        manifest.description,
        manifest,
        entries,
      );
      if (localizedName) manifest.name = localizedName;
      if (localizedDescription) manifest.description = localizedDescription;
      applyElectronCompatibility(entries, manifest);
      manifestEntry.data = Buffer.from(
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      this.assertActivePreparation(token);

      const sourceUrl = canonicalItemUrl(itemUrl, extensionId);
      const preview: PreparedExtensionPreview = {
        token,
        id: extensionId,
        name: manifest.name,
        version: manifest.version,
        description:
          typeof manifest.description === "string" ? manifest.description : "",
        permissions: stringArray(manifest.permissions),
        hostPermissions: stringArray(manifest.host_permissions),
        warnings: compatibilityWarnings(manifest),
        sourceUrl,
      };
      this.preparedExtension = { preview, entries, manifest };
      return clonePreparedPreview(preview);
    } finally {
      if (this.activePreparation?.token === token) {
        this.activePreparation = null;
      }
    }
  }

  async commitPreparedExtension(
    token: string,
    onProgress?: ExtensionInstallProgressListener,
  ): Promise<InstalledExtensionSnapshot> {
    this.requireInitialized();
    if (this.committingPreviewToken) {
      throw new Error("An extension installation is already in progress.");
    }
    const prepared = this.preparedExtension;
    if (!prepared || prepared.preview.token !== token) {
      throw new Error("The prepared extension preview is no longer available.");
    }
    this.committingPreviewToken = token;
    const { id: extensionId, sourceUrl } = prepared.preview;
    const { entries, manifest } = prepared;

    try {
      emitInstallProgress(onProgress, { stage: "installing" });
      const destination = this.extensionVersionPath(
        extensionId,
        manifest.version,
      );
      await this.writeArchiveAtomically(destination, entries);

      const previous = this.runtimes.get(extensionId);
      if (previous?.extension) {
        await this.browserSession.extensions.removeExtension(extensionId);
        previous.extension = null;
      }
      const stored: StoredExtension = {
        id: extensionId,
        version: manifest.version,
        enabled: true,
        sourceUrl,
      };
      const runtime = this.runtimeFromManifest(stored, manifest);
      runtime.snapshot.iconDataUrl = extensionIconDataUrlFromEntries(
        entries,
        manifest,
      );
      try {
        await this.loadRuntime(runtime, true);
        this.runtimes.set(extensionId, runtime);
        emitInstallProgress(onProgress, { stage: "finishing" });
        await this.persistRegistry();
      } catch (error) {
        if (previous) {
          this.runtimes.set(extensionId, previous);
          if (previous.stored.enabled && !previous.extension) {
            await this.loadRuntime(previous, false);
          }
        }
        throw error;
      }
      const snapshot = cloneSnapshot(runtime.snapshot);
      emitInstallProgress(onProgress, { stage: "installed" });
      return snapshot;
    } finally {
      this.committingPreviewToken = null;
      if (this.preparedExtension === prepared) {
        this.preparedExtension = null;
      }
    }
  }

  cancelPreparedExtension(token?: string): boolean {
    let cancelled = false;
    if (
      this.activePreparation &&
      (token === undefined || token === this.activePreparation.token)
    ) {
      this.activePreparation.controller.abort();
      this.activePreparation = null;
      cancelled = true;
    }
    if (
      this.preparedExtension &&
      this.committingPreviewToken !== this.preparedExtension.preview.token &&
      (token === undefined || token === this.preparedExtension.preview.token)
    ) {
      this.preparedExtension = null;
      cancelled = true;
    }
    return cancelled;
  }

  async setEnabled(
    extensionId: string,
    enabled: boolean,
  ): Promise<InstalledExtensionSnapshot> {
    this.requireInitialized();
    requireExtensionId(extensionId);
    const runtime = this.runtimes.get(extensionId);
    if (!runtime) throw new Error("The extension is not installed.");
    if (runtime.stored.enabled === enabled)
      return cloneSnapshot(runtime.snapshot);

    if (!enabled) {
      if (runtime.extension) {
        await this.browserSession.extensions.removeExtension(extensionId);
        runtime.extension = null;
      }
      runtime.stored.enabled = false;
      runtime.snapshot.enabled = false;
      runtime.snapshot.ready = false;
      runtime.snapshot.error = null;
      await this.persistRegistry();
      return cloneSnapshot(runtime.snapshot);
    }

    runtime.stored.enabled = true;
    runtime.snapshot.enabled = true;
    try {
      await this.loadRuntime(runtime, true);
    } catch (error) {
      runtime.stored.enabled = false;
      runtime.snapshot.enabled = false;
      throw error;
    }
    await this.persistRegistry();
    return cloneSnapshot(runtime.snapshot);
  }

  async uninstall(extensionId: string): Promise<void> {
    this.requireInitialized();
    requireExtensionId(extensionId);
    const runtime = this.runtimes.get(extensionId);
    if (!runtime) return;
    if (runtime.extension) {
      await this.browserSession.extensions.removeExtension(extensionId);
    }
    this.runtimes.delete(extensionId);
    await this.persistRegistry();
    const extensionRoot = path.join(this.storagePath, extensionId);
    assertChildPath(this.storagePath, extensionRoot);
    await fs.rm(extensionRoot, { recursive: true, force: true });
  }

  isAllowedExtensionUrl(value: string): boolean {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "chrome-extension:" ||
        url.username ||
        url.password ||
        url.port ||
        !EXTENSION_ID_PATTERN.test(url.hostname)
      ) {
        return false;
      }
      const runtime = this.runtimes.get(url.hostname);
      return Boolean(
        runtime?.stored.enabled && runtime.extension && runtime.snapshot.ready,
      );
    } catch {
      return false;
    }
  }

  getExtensionPage(
    extensionId: string,
    page: "options" | "popup",
  ): string | null {
    requireExtensionId(extensionId);
    const runtime = this.runtimes.get(extensionId);
    if (!runtime?.stored.enabled || !runtime.snapshot.ready) return null;
    return page === "options"
      ? runtime.snapshot.optionsUrl
      : runtime.snapshot.popupUrl;
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("The extension service has not been initialized.");
    }
  }

  private assertActivePreparation(token: string): void {
    if (
      this.activePreparation?.token !== token ||
      this.activePreparation.controller.signal.aborted
    ) {
      throw abortError();
    }
  }

  private extensionVersionPath(extensionId: string, version: string): string {
    requireExtensionId(extensionId);
    requireVersion(version);
    const destination = path.join(this.storagePath, extensionId, version);
    assertChildPath(this.storagePath, destination);
    return destination;
  }

  private async readRegistry(): Promise<ExtensionRegistry> {
    let raw: string;
    try {
      raw = await fs.readFile(this.registryPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, extensions: [] };
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<ExtensionRegistry>;
    if (parsed.version !== 1 || !Array.isArray(parsed.extensions)) {
      throw new Error("The installed extension registry is invalid.");
    }
    const extensions: StoredExtension[] = [];
    const seen = new Set<string>();
    for (const value of parsed.extensions) {
      if (!isStoredExtension(value) || seen.has(value.id)) {
        throw new Error("The installed extension registry is invalid.");
      }
      seen.add(value.id);
      extensions.push({ ...value });
    }
    return { version: 1, extensions };
  }

  private async persistRegistry(): Promise<void> {
    const registry: ExtensionRegistry = {
      version: 1,
      extensions: [...this.runtimes.values()].map(({ stored }) => ({
        ...stored,
      })),
    };
    const temporary = `${this.registryPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      await fs.rename(temporary, this.registryPath);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  private async readRuntime(
    stored: StoredExtension,
  ): Promise<ExtensionRuntime> {
    const extensionPath = this.extensionVersionPath(stored.id, stored.version);
    const manifestPath = path.join(extensionPath, "manifest.json");
    try {
      const manifest = parseManifest(await fs.readFile(manifestPath));
      if (manifest.version !== stored.version) {
        throw new Error(
          "The installed manifest version does not match its registry entry.",
        );
      }
      const resetServiceWorker = await migrateStoredElectronCompatibility(
        extensionPath,
        manifest,
      );
      if (resetServiceWorker) {
        await this.browserSession.clearStorageData({
          origin: `chrome-extension://${stored.id}`,
          storages: ["serviceworkers"],
        });
      }
      const runtime = this.runtimeFromManifest(stored, manifest);
      runtime.snapshot.iconDataUrl = await extensionIconDataUrlFromDirectory(
        extensionPath,
        manifest,
      );
      return runtime;
    } catch (error) {
      return {
        stored,
        extension: null,
        snapshot: {
          id: stored.id,
          name: stored.id,
          version: stored.version,
          description: "",
          enabled: stored.enabled,
          ready: false,
          permissions: [],
          hostPermissions: [],
          warnings: [],
          error: errorMessage(error),
          sourceUrl: stored.sourceUrl,
          optionsUrl: null,
          popupUrl: null,
          iconDataUrl: null,
        },
      };
    }
  }

  private runtimeFromManifest(
    stored: StoredExtension,
    manifest: ExtensionManifest,
  ): ExtensionRuntime {
    const origin = `chrome-extension://${stored.id}/`;
    return {
      stored,
      extension: null,
      snapshot: {
        id: stored.id,
        name: manifest.name,
        version: manifest.version,
        description:
          typeof manifest.description === "string" &&
          !/^__MSG_.+__$/iu.test(manifest.description)
            ? manifest.description
            : "",
        enabled: stored.enabled,
        ready: false,
        permissions: stringArray(manifest.permissions),
        hostPermissions: stringArray(manifest.host_permissions),
        warnings: compatibilityWarnings(manifest),
        error: null,
        sourceUrl: stored.sourceUrl,
        optionsUrl: extensionPageUrl(
          origin,
          manifest.options_ui?.page ?? manifest.options_page,
        ),
        popupUrl: extensionPageUrl(
          origin,
          manifest.action?.default_popup ??
            manifest.browser_action?.default_popup ??
            manifest.page_action?.default_popup,
        ),
        iconDataUrl: null,
      },
    };
  }

  private async loadRuntime(
    runtime: ExtensionRuntime,
    failInstallation: boolean,
  ): Promise<void> {
    try {
      const extension = await this.browserSession.extensions.loadExtension(
        this.extensionVersionPath(runtime.stored.id, runtime.stored.version),
        { allowFileAccess: false },
      );
      if (extension.id !== runtime.stored.id) {
        await this.browserSession.extensions.removeExtension(extension.id);
        throw new Error(
          "Electron loaded the extension with an unexpected extension id.",
        );
      }
      runtime.extension = extension;
      if (extension.name.trim()) runtime.snapshot.name = extension.name;
      runtime.snapshot.ready = true;
      runtime.snapshot.error = null;
    } catch (error) {
      runtime.extension = null;
      runtime.snapshot.ready = false;
      runtime.snapshot.error = errorMessage(error);
      if (failInstallation) throw error;
    }
  }

  private async writeArchiveAtomically(
    destination: string,
    entries: ArchiveEntry[],
  ): Promise<void> {
    try {
      const existing = await fs.stat(destination);
      if (existing.isDirectory()) return;
      throw new Error("The extension destination is not a directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(destination);
    await fs.mkdir(parent, { recursive: true });
    const temporary = path.join(
      parent,
      `.${path.basename(destination)}-${randomUUID()}.tmp`,
    );
    assertChildPath(this.storagePath, temporary);
    await fs.mkdir(temporary, { recursive: false });
    try {
      for (const entry of entries) {
        const target = path.join(temporary, ...entry.name.split("/"));
        assertChildPath(temporary, target);
        if (entry.directory) {
          await fs.mkdir(target, { recursive: true });
          continue;
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, entry.data, { flag: "wx" });
      }
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}

export function parseChromeWebStoreItemUrl(itemUrl: string): string {
  const listing = parseChromeWebStoreListingUrl(itemUrl);
  if (!listing) {
    throw new TypeError("The Chrome Web Store item URL is invalid.");
  }
  return listing.extensionId;
}

function canonicalItemUrl(itemUrl: string, extensionId: string): string {
  const listing = parseChromeWebStoreListingUrl(itemUrl);
  if (!listing || listing.extensionId !== extensionId) {
    throw new TypeError("The Chrome Web Store item URL is invalid.");
  }
  return listing.canonicalUrl;
}

function buildUpdateUrl(extensionId: string, chromiumVersion: string): string {
  if (!/^\d+(?:\.\d+){0,3}$/.test(chromiumVersion)) {
    throw new TypeError("The Chromium version is invalid.");
  }
  const url = new URL(UPDATE_SERVICE_URL);
  url.searchParams.set("response", "redirect");
  url.searchParams.set("prodversion", chromiumVersion);
  url.searchParams.set("acceptformat", "crx3");
  url.searchParams.set("x", `id=${extensionId}&installsource=ondemand&uc`);
  return url.toString();
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  onProgress?: (receivedBytes: number, totalBytes?: number) => void,
  signal?: AbortSignal,
): Promise<Buffer> {
  const contentLengthHeader = response.headers.get("content-length");
  const parsedContentLength =
    contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  const totalBytes =
    parsedContentLength !== undefined &&
    Number.isFinite(parsedContentLength) &&
    parsedContentLength >= 0
      ? parsedContentLength
      : undefined;
  if (totalBytes !== undefined && totalBytes > maximumBytes) {
    throw new Error("The CRX download exceeds the configured size limit.");
  }
  if (signal?.aborted) throw abortError();
  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (signal?.aborted) throw abortError();
    if (data.length > maximumBytes) {
      throw new Error("The CRX download exceeds the configured size limit.");
    }
    onProgress?.(data.length, totalBytes);
    return data;
  }
  const reader = response.body.getReader();
  const cancelReader = (): void => {
    void reader.cancel("Extension preparation was cancelled.");
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("CRX download exceeded the size limit.");
        throw new Error("The CRX download exceeds the configured size limit.");
      }
      chunks.push(Buffer.from(value));
      onProgress?.(total, totalBytes);
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function emitInstallProgress(
  listener: ExtensionInstallProgressListener | undefined,
  progress: ExtensionInstallProgress,
): void {
  if (!listener) return;
  try {
    listener({ ...progress });
  } catch {
    // Progress observers must never be able to interrupt a verified install.
  }
}

function abortError(): Error {
  const error = new Error("Extension preparation was cancelled.");
  error.name = "AbortError";
  return error;
}

function clonePreparedPreview(
  preview: PreparedExtensionPreview,
): PreparedExtensionPreview {
  return {
    ...preview,
    permissions: [...preview.permissions],
    hostPermissions: [...preview.hostPermissions],
    warnings: [...preview.warnings],
  };
}

function parseAndVerifyCrx3(crx: Buffer): ParsedCrx {
  if (crx.length < 12 || crx.subarray(0, 4).toString("ascii") !== "Cr24") {
    throw new Error("The downloaded file is not a CRX archive.");
  }
  if (crx.readUInt32LE(4) !== 3) {
    throw new Error("Only signed CRX3 extensions are supported.");
  }
  const headerLength = crx.readUInt32LE(8);
  const archiveOffset = 12 + headerLength;
  if (headerLength === 0 || archiveOffset > crx.length) {
    throw new Error("The CRX3 header is invalid.");
  }
  const header = crx.subarray(12, archiveOffset);
  const archive = crx.subarray(archiveOffset);
  const fields = parseProtobufFields(header);
  const signedHeaderData = fields.get(10_000)?.[0];
  if (!signedHeaderData) throw new Error("The CRX3 signed header is missing.");
  const signedFields = parseProtobufFields(signedHeaderData);
  const declaredId = signedFields.get(1)?.[0];
  if (!declaredId || declaredId.length !== 16) {
    throw new Error("The CRX3 signed extension id is invalid.");
  }
  const declaredExtensionId = extensionIdFromBytes(declaredId);
  const signedInput = Buffer.concat([
    Buffer.from("CRX3 SignedData\0", "ascii"),
    uint32(signedHeaderData.length),
    signedHeaderData,
    archive,
  ]);
  const proofs = [...(fields.get(2) ?? []), ...(fields.get(3) ?? [])];
  let verifiedPublicKey: Buffer | null = null;
  for (const proof of proofs) {
    const proofFields = parseProtobufFields(proof);
    const publicKey = proofFields.get(1)?.[0];
    const signature = proofFields.get(2)?.[0];
    if (!publicKey || !signature) continue;
    if (extensionIdFromPublicKey(publicKey) !== declaredExtensionId) continue;
    try {
      const key = createPublicKey({
        key: publicKey,
        format: "der",
        type: "spki",
      });
      if (verify("sha256", signedInput, key, signature)) {
        verifiedPublicKey = Buffer.from(publicKey);
        break;
      }
    } catch {
      // Continue to another proof. An invalid key can never authorize the CRX.
    }
  }
  if (!verifiedPublicKey) throw new Error("The CRX3 signature is invalid.");
  return {
    archive: Buffer.from(archive),
    extensionId: declaredExtensionId,
    publicKey: verifiedPublicKey,
  };
}

function parseProtobufFields(input: Uint8Array): Map<number, Buffer[]> {
  const fields = new Map<number, Buffer[]>();
  let offset = 0;
  while (offset < input.length) {
    const tag = readVarint(input, offset);
    offset = tag.offset;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    if (field <= 0) throw new Error("The CRX3 protobuf header is invalid.");
    if (wireType === 2) {
      const length = readVarint(input, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end < offset || end > input.length) {
        throw new Error("The CRX3 protobuf header is truncated.");
      }
      const values = fields.get(field) ?? [];
      values.push(Buffer.from(input.subarray(offset, end)));
      fields.set(field, values);
      offset = end;
      continue;
    }
    if (wireType === 0) {
      offset = readVarint(input, offset).offset;
      continue;
    }
    if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw new Error(
        "The CRX3 protobuf header uses an unsupported wire type.",
      );
    }
    if (offset > input.length) {
      throw new Error("The CRX3 protobuf header is truncated.");
    }
  }
  return fields;
}

function readVarint(
  input: Uint8Array,
  start: number,
): { value: number; offset: number } {
  let value = 0;
  let multiplier = 1;
  for (
    let offset = start;
    offset < input.length && offset < start + 10;
    offset += 1
  ) {
    const byte = input[offset];
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) {
      throw new Error("The CRX3 protobuf value is too large.");
    }
    if ((byte & 0x80) === 0) return { value, offset: offset + 1 };
    multiplier *= 128;
  }
  throw new Error("The CRX3 protobuf varint is invalid.");
}

function extensionIdFromPublicKey(publicKey: Uint8Array): string {
  return extensionIdFromBytes(
    createHash("sha256").update(publicKey).digest().subarray(0, 16),
  );
}

function extensionIdFromBytes(bytes: Uint8Array): string {
  return [...bytes]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join("");
}

function extractZipEntries(archive: Buffer): ArchiveEntry[] {
  const endOffset = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error("The extension archive has too many entries.");
  }
  if (centralOffset + centralSize !== endOffset) {
    throw new Error("The extension archive central directory is invalid.");
  }

  const entries: ArchiveEntry[] = [];
  const paths = new Set<string>();
  let offset = centralOffset;
  let extractedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > endOffset ||
      archive.readUInt32LE(offset) !== 0x02014b50
    ) {
      throw new Error("The extension archive central directory is corrupt.");
    }
    const versionMadeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const compression = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const disk = archive.readUInt16LE(offset + 34);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > endOffset || disk !== 0) {
      throw new Error("The extension archive entry is invalid.");
    }
    if ((flags & 1) !== 0) {
      throw new Error("Encrypted extension archive entries are not supported.");
    }
    if (compression !== 0 && compression !== 8) {
      throw new Error("The extension archive uses unsupported compression.");
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("ZIP64 extension archives are not supported.");
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error("An extension archive entry exceeds the size limit.");
    }
    extractedBytes += uncompressedSize;
    if (extractedBytes > MAX_EXTRACTED_BYTES) {
      throw new Error("The extracted extension exceeds the size limit.");
    }
    const rawName = archive.subarray(offset + 46, offset + 46 + nameLength);
    const name = rawName.toString("utf8");
    validateArchivePath(name);
    const collisionKey = name.replace(/\/$/, "").toLocaleLowerCase("en-US");
    if (paths.has(collisionKey)) {
      throw new Error("The extension archive contains duplicate paths.");
    }
    paths.add(collisionKey);

    const creatorSystem = versionMadeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0o170000;
    if (creatorSystem === 3 && fileType === 0o120000) {
      throw new Error("Symbolic links are not allowed in extension archives.");
    }
    const directory = name.endsWith("/") || fileType === 0o040000;
    if (
      localOffset + 30 > centralOffset ||
      archive.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      throw new Error("The extension archive local entry is invalid.");
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataOffset < localOffset || dataEnd > centralOffset) {
      throw new Error("The extension archive entry data is invalid.");
    }
    const compressed = archive.subarray(dataOffset, dataEnd);
    let data: Buffer;
    try {
      data =
        compression === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (error) {
      throw new Error(
        "The extension archive contains invalid compressed data.",
        {
          cause: error,
        },
      );
    }
    if (data.length !== uncompressedSize || crc32(data) !== checksum) {
      throw new Error(
        "The extension archive entry failed integrity validation.",
      );
    }
    if (directory && data.length !== 0) {
      throw new Error(
        "An extension archive directory contains unexpected data.",
      );
    }
    entries.push({ name: name.replace(/\/$/, ""), data, directory });
    offset = recordEnd;
  }
  if (offset !== endOffset || entries.length === 0) {
    throw new Error("The extension archive directory is incomplete.");
  }
  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error("The extension archive has no valid central directory.");
}

function validateArchivePath(name: string): void {
  if (
    !name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-zA-Z]:/.test(name)
  ) {
    throw new Error("The extension archive contains an unsafe path.");
  }
  const segments = name.replace(/\/$/, "").split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        /[<>:"|?*]/.test(segment),
    )
  ) {
    throw new Error("The extension archive contains a path traversal entry.");
  }
}

function parseManifest(input: Uint8Array): ExtensionManifest {
  if (input.byteLength > 2 * 1024 * 1024) {
    throw new Error("The extension manifest exceeds the size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(input).toString("utf8"));
  } catch (error) {
    throw new Error("The extension manifest is invalid JSON.", {
      cause: error,
    });
  }
  if (!value || typeof value !== "object") {
    throw new Error("The extension manifest is invalid.");
  }
  const manifest = value as Partial<ExtensionManifest>;
  if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) {
    throw new Error(
      "Only Manifest V2 and Manifest V3 extensions are supported.",
    );
  }
  if (
    typeof manifest.name !== "string" ||
    manifest.name.trim().length === 0 ||
    manifest.name.length > 512 ||
    typeof manifest.version !== "string"
  ) {
    throw new Error("The extension manifest name or version is invalid.");
  }
  requireVersion(manifest.version);
  return manifest as ExtensionManifest;
}

function extensionPageUrl(origin: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return null;
  }
  try {
    const url = new URL(value, origin);
    return url.origin === new URL(origin).origin ? url.toString() : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.length <= 2_048,
  );
}

function localizedManifestText(
  value: unknown,
  manifest: ExtensionManifest,
  entries: ArchiveEntry[],
): string {
  if (typeof value !== "string") return "";
  const match = /^__MSG_([A-Za-z0-9_@]+)__$/u.exec(value);
  if (!match) return value;

  const configuredLocale =
    typeof manifest.default_locale === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/u.test(manifest.default_locale)
      ? manifest.default_locale
      : null;
  const locales = [configuredLocale, "en", "en_US", "en_GB"].filter(
    (locale, index, all): locale is string =>
      locale !== null && all.indexOf(locale) === index,
  );
  const messageKey = match[1].toLowerCase();
  for (const locale of locales) {
    const entry = entries.find(
      (candidate) =>
        !candidate.directory &&
        candidate.name === `_locales/${locale}/messages.json`,
    );
    if (!entry) continue;
    try {
      const messages = JSON.parse(entry.data.toString("utf8")) as unknown;
      if (
        !messages ||
        typeof messages !== "object" ||
        Array.isArray(messages)
      ) {
        continue;
      }
      const message = Object.entries(messages).find(
        ([key]) => key.toLowerCase() === messageKey,
      )?.[1];
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        continue;
      }
      const text = (message as { message?: unknown }).message;
      if (typeof text === "string" && text.trim() && text.length <= 2_048) {
        return text;
      }
    } catch {
      // A malformed optional locale should not invalidate an otherwise signed
      // package; the preview keeps its safe placeholder fallback instead.
    }
  }
  return "";
}

function compatibilityWarnings(manifest: ExtensionManifest): string[] {
  const warnings = [
    "Electron supports only a subset of Chrome extension APIs; some features may be unavailable.",
  ];
  const documentedPermissions = new Set([
    "activeTab",
    "scripting",
    "storage",
    "tabs",
    "webRequest",
  ]);
  const permissions = [
    ...stringArray(manifest.permissions),
    ...stringArray(manifest.optional_permissions),
  ];
  const unsupported = [...new Set(permissions)].filter(
    (permission) =>
      !documentedPermissions.has(permission) &&
      permission !== "<all_urls>" &&
      !permission.includes("://"),
  );
  if (unsupported.length > 0) {
    warnings.push(
      `Electron does not document support for requested APIs: ${unsupported.sort().join(", ")}.`,
    );
  }
  if (permissions.includes("webRequest")) {
    warnings.push(
      "This extension requests webRequest; Electron warns that extension handlers can conflict with browser-level request handlers such as uBlock Origin.",
    );
  }
  if (
    manifest.manifest_version === 3 &&
    typeof manifest.background?.service_worker === "string"
  ) {
    warnings.push(
      "Manifest V3 service-worker backgrounds are outside Electron's documented stable manifest subset.",
    );
  }
  if (
    manifest.action?.default_popup ||
    manifest.browser_action?.default_popup ||
    manifest.page_action?.default_popup
  ) {
    warnings.push(
      "Chromecraft hosts this declared toolbar popup. Dynamic chrome.action features such as badges and per-tab overrides remain limited by Electron.",
    );
  }
  return warnings;
}

/**
 * Reconciles extensions installed by older Chromecraft builds. The migration is
 * deliberately limited to the same popup and classic MV3 worker surfaces used
 * for newly verified packages, and is idempotent so every startup can repair an
 * interrupted prior migration before Electron loads the extension.
 */
async function migrateStoredElectronCompatibility(
  extensionPath: string,
  manifest: ExtensionManifest,
): Promise<boolean> {
  await assertSafeStoredExtensionPath(extensionPath, extensionPath);
  const safePath = async (manifestPath: string): Promise<string> => {
    const target = extensionFilePath(extensionPath, manifestPath);
    await assertSafeStoredExtensionPath(extensionPath, target);
    return target;
  };
  const topLevelEntries = await fs.readdir(extensionPath);
  const reservedDirectoryNames = new Set([
    COMPATIBILITY_DIRECTORY,
    LEGACY_COMPATIBILITY_DIRECTORY,
  ]);
  const reservedEntry = topLevelEntries.find((entry) =>
    [...reservedDirectoryNames].some(
      (reserved) => entry.toLowerCase() === reserved.toLowerCase(),
    ),
  );
  const reservedWorkerNames = new Set([
    COMPATIBILITY_WORKER_PATH,
    ...[...LEGACY_COMPATIBILITY_WORKER_PATHS].filter(
      (entry) => !entry.includes("/"),
    ),
  ]);
  const reservedWorker = topLevelEntries.find((entry) =>
    [...reservedWorkerNames].some(
      (reserved) => entry.toLowerCase() === reserved.toLowerCase(),
    ),
  );
  if (
    (reservedEntry && !reservedDirectoryNames.has(reservedEntry)) ||
    (reservedWorker && !reservedWorkerNames.has(reservedWorker))
  ) {
    throw new Error(
      "The installed extension collides with Chromecraft compatibility resources.",
    );
  }
  await assertLegacyCompatibilityDirectoryIsOwned(safePath);

  const popupPaths = new Set(
    [
      manifest.action?.default_popup,
      manifest.browser_action?.default_popup,
      manifest.page_action?.default_popup,
    ].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const scriptTag = `<script src="/${COMPATIBILITY_SCRIPT_PATH}"></script>`;
  let compatibilityRequired = false;
  let storedCompatibilityRevision = 0;
  try {
    const marker = JSON.parse(
      await fs.readFile(await safePath(COMPATIBILITY_REVISION_PATH), "utf8"),
    ) as { revision?: unknown };
    if (typeof marker.revision === "number") {
      storedCompatibilityRevision = marker.revision;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const popupPath of popupPaths) {
    const target = await safePath(popupPath);
    let html: string;
    try {
      html = await fs.readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    compatibilityRequired = true;
    let compatibleHtml = html;
    for (const legacyPath of LEGACY_COMPATIBILITY_SCRIPT_PATHS) {
      compatibleHtml = compatibleHtml.replaceAll(
        `<script src="/${legacyPath}"></script>`,
        "",
      );
    }
    if (!compatibleHtml.includes(scriptTag)) {
      compatibleHtml = /<head(?:\s[^>]*)?>/iu.test(compatibleHtml)
        ? compatibleHtml.replace(
            /<head(?:\s[^>]*)?>/iu,
            (head) => `${head}${scriptTag}`,
          )
        : `${scriptTag}${compatibleHtml}`;
    }
    if (compatibleHtml !== html) {
      await fs.writeFile(target, compatibleHtml, "utf8");
    }
  }

  const declaredServiceWorker = manifest.background?.service_worker;
  let serviceWorker = declaredServiceWorker;
  let compatibilityWorkerChanged = false;
  if (
    (typeof serviceWorker === "string" &&
      LEGACY_COMPATIBILITY_WORKER_PATHS.has(serviceWorker)) ||
    serviceWorker === COMPATIBILITY_WORKER_PATH
  ) {
    const compatibilityWorker = await fs.readFile(
      await safePath(serviceWorker),
      "utf8",
    );
    const originalWorker =
      compatibilityWorker.match(
        /Chromecraft original worker: ("(?:[^"\\]|\\.)*")/u,
      )?.[1] ??
      compatibilityWorker.match(
        /importScripts\(chrome\.runtime\.getURL\(("(?:[^"\\]|\\.)*")\)\);/u,
      )?.[1];
    if (!originalWorker) {
      throw new Error(
        "The installed extension has an invalid legacy compatibility wrapper.",
      );
    }
    serviceWorker = JSON.parse(originalWorker) as string;
  }
  const classicServiceWorker =
    typeof serviceWorker === "string" &&
    serviceWorker.length > 0 &&
    manifest.background?.type !== "module";
  let manifestChanged = false;
  if (
    classicServiceWorker &&
    typeof serviceWorker === "string" &&
    serviceWorker !== COMPATIBILITY_WORKER_PATH
  ) {
    const normalizedWorker = normalizeManifestPath(serviceWorker);
    await fs.access(await safePath(normalizedWorker));
    const wrapperPath = await safePath(COMPATIBILITY_WORKER_PATH);
    const originalWorkerSource = await fs.readFile(
      await safePath(normalizedWorker),
      "utf8",
    );
    const nextWorkerSource = compatibleWorkerSource(
      normalizedWorker,
      originalWorkerSource,
    );
    let existingWorkerSource: string | null = null;
    try {
      existingWorkerSource = await fs.readFile(wrapperPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    compatibilityWorkerChanged = existingWorkerSource !== nextWorkerSource;
    if (compatibilityWorkerChanged) {
      await fs.writeFile(wrapperPath, nextWorkerSource, "utf8");
    }
    manifest.background = {
      ...manifest.background,
      service_worker: COMPATIBILITY_WORKER_PATH,
    };
    compatibilityRequired = true;
    manifestChanged = declaredServiceWorker !== COMPATIBILITY_WORKER_PATH;
  }

  if (compatibilityRequired) {
    if (removeLegacyCompatibilityWindowBridges(manifest)) {
      manifestChanged = true;
    }
    if (ensureCompatibilityWindowBridge(manifest)) manifestChanged = true;
    const compatibilityPath = await safePath(COMPATIBILITY_SCRIPT_PATH);
    const windowBridgePath = await safePath(COMPATIBILITY_WINDOW_BRIDGE_PATH);
    await fs.mkdir(path.dirname(compatibilityPath), { recursive: true });
    await assertSafeStoredExtensionPath(extensionPath, compatibilityPath);
    await assertSafeStoredExtensionPath(extensionPath, windowBridgePath);
    await fs.writeFile(
      compatibilityPath,
      extensionCompatibilitySource(),
      "utf8",
    );
    await fs.writeFile(windowBridgePath, extensionWindowBridgeSource(), "utf8");
    await fs.writeFile(
      await safePath(COMPATIBILITY_REVISION_PATH),
      `${JSON.stringify({ revision: COMPATIBILITY_REVISION })}\n`,
      "utf8",
    );
  }
  if (manifestChanged) {
    await fs.writeFile(
      await safePath("manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }
  if (compatibilityRequired) {
    const legacyDirectory = await safePath(LEGACY_COMPATIBILITY_DIRECTORY);
    for (const legacyFile of [
      "background-wrapper.js",
      "extension-compat.js",
      "revision.json",
      "window-bridge.js",
    ]) {
      await fs.rm(path.join(legacyDirectory, legacyFile), { force: true });
    }
    try {
      await fs.rmdir(legacyDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const legacyWorkerPath of LEGACY_COMPATIBILITY_WORKER_PATHS) {
      if (legacyWorkerPath.includes("/")) continue;
      await fs.rm(await safePath(legacyWorkerPath), { force: true });
    }
  }
  return (
    compatibilityRequired &&
    typeof declaredServiceWorker === "string" &&
    (storedCompatibilityRevision !== COMPATIBILITY_REVISION ||
      compatibilityWorkerChanged)
  );
}

async function assertLegacyCompatibilityDirectoryIsOwned(
  safePath: (manifestPath: string) => Promise<string>,
): Promise<void> {
  const legacyDirectory = await safePath(LEGACY_COMPATIBILITY_DIRECTORY);
  let entries;
  try {
    entries = await fs.readdir(legacyDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const knownFiles = new Set([
    "background-wrapper.js",
    "extension-compat.js",
    "revision.json",
    "window-bridge.js",
  ]);
  if (
    entries.some(
      (entry) =>
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !knownFiles.has(entry.name),
    )
  ) {
    throw new Error(
      "The legacy Chromecraft compatibility directory contains unknown resources.",
    );
  }
}

function extensionFilePath(
  extensionPath: string,
  manifestPath: string,
): string {
  const normalized = normalizeManifestPath(manifestPath);
  const target = path.join(extensionPath, ...normalized.split("/"));
  assertChildPath(extensionPath, target);
  return target;
}

async function assertSafeStoredExtensionPath(
  extensionPath: string,
  targetPath: string,
): Promise<void> {
  const root = path.resolve(extensionPath);
  const target = path.resolve(targetPath);
  if (target !== root) assertChildPath(root, target);
  const relative = path.relative(root, target);
  const candidates = [
    root,
    ...relative
      .split(path.sep)
      .filter(Boolean)
      .map((_, index, parts) => path.join(root, ...parts.slice(0, index + 1))),
  ];
  for (const candidate of candidates) {
    try {
      const stats = await fs.lstat(candidate);
      if (stats.isSymbolicLink()) {
        throw new Error(
          "Installed extension compatibility paths cannot contain filesystem links.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

function applyElectronCompatibility(
  entries: ArchiveEntry[],
  manifest: ExtensionManifest,
): void {
  if (
    entries.some((entry) => {
      const normalized = entry.name.toLowerCase();
      return (
        normalized.split("/", 1)[0] === COMPATIBILITY_DIRECTORY ||
        normalized.split("/", 1)[0] === LEGACY_COMPATIBILITY_DIRECTORY ||
        normalized === COMPATIBILITY_WORKER_PATH.toLowerCase() ||
        [...LEGACY_COMPATIBILITY_WORKER_PATHS].some(
          (reserved) => normalized === reserved.toLowerCase(),
        )
      );
    })
  ) {
    throw new Error(
      "The extension archive collides with Chromecraft compatibility resources.",
    );
  }

  const popupPaths = new Set(
    [
      manifest.action?.default_popup,
      manifest.browser_action?.default_popup,
      manifest.page_action?.default_popup,
    ].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  let injectedPopup = false;
  for (const popupPath of popupPaths) {
    const normalized = normalizeManifestPath(popupPath);
    const popupEntry = entries.find(
      (entry) => !entry.directory && entry.name === normalized,
    );
    if (!popupEntry) continue;
    const html = popupEntry.data.toString("utf8");
    const script = `<script src="/${COMPATIBILITY_SCRIPT_PATH}"></script>`;
    popupEntry.data = Buffer.from(
      /<head(?:\s[^>]*)?>/iu.test(html)
        ? html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${script}`)
        : `${script}${html}`,
      "utf8",
    );
    injectedPopup = true;
  }

  const serviceWorker = manifest.background?.service_worker;
  const classicServiceWorker =
    typeof serviceWorker === "string" &&
    serviceWorker.length > 0 &&
    manifest.background?.type !== "module";
  let wrappedServiceWorker = false;
  if (classicServiceWorker) {
    const normalized = normalizeManifestPath(serviceWorker);
    if (
      entries.some((entry) => !entry.directory && entry.name === normalized)
    ) {
      entries.push({
        name: COMPATIBILITY_WORKER_PATH,
        directory: false,
        data: Buffer.from(
          compatibleWorkerSource(
            normalized,
            entries
              .find((entry) => !entry.directory && entry.name === normalized)!
              .data.toString("utf8"),
          ),
          "utf8",
        ),
      });
      manifest.background = {
        ...manifest.background,
        service_worker: COMPATIBILITY_WORKER_PATH,
      };
      wrappedServiceWorker = true;
    }
  }

  if (injectedPopup || wrappedServiceWorker) {
    ensureCompatibilityWindowBridge(manifest);
    entries.push({
      name: COMPATIBILITY_SCRIPT_PATH,
      directory: false,
      data: Buffer.from(extensionCompatibilitySource(), "utf8"),
    });
    entries.push({
      name: COMPATIBILITY_REVISION_PATH,
      directory: false,
      data: Buffer.from(
        `${JSON.stringify({ revision: COMPATIBILITY_REVISION })}\n`,
        "utf8",
      ),
    });
    entries.push({
      name: COMPATIBILITY_WINDOW_BRIDGE_PATH,
      directory: false,
      data: Buffer.from(extensionWindowBridgeSource(), "utf8"),
    });
  }

  const compatibilityBytes = entries.reduce(
    (total, entry) => total + (entry.directory ? 0 : entry.data.byteLength),
    0,
  );
  if (
    entries.length > MAX_ARCHIVE_ENTRIES ||
    compatibilityBytes > MAX_EXTRACTED_BYTES
  ) {
    throw new Error(
      "The extension exceeds the extracted size limit after compatibility resources are applied.",
    );
  }
}

function ensureCompatibilityWindowBridge(manifest: ExtensionManifest): boolean {
  const contentScripts = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts
    : [];
  const alreadyRegistered = contentScripts.some(
    (entry) =>
      Array.isArray(entry?.js) &&
      entry.js.some((script) => script === COMPATIBILITY_WINDOW_BRIDGE_PATH),
  );
  if (alreadyRegistered) return false;
  manifest.content_scripts = [
    ...contentScripts,
    {
      matches: ["http://*/*", "https://*/*"],
      js: [COMPATIBILITY_WINDOW_BRIDGE_PATH],
      run_at: "document_start",
      all_frames: false,
    },
  ];
  return true;
}

function removeLegacyCompatibilityWindowBridges(
  manifest: ExtensionManifest,
): boolean {
  if (!Array.isArray(manifest.content_scripts)) return false;
  let changed = false;
  const contentScripts = manifest.content_scripts.flatMap((entry) => {
    if (!Array.isArray(entry?.js)) return [entry];
    const js = entry.js.filter(
      (script) => !LEGACY_COMPATIBILITY_WINDOW_BRIDGE_PATHS.has(script),
    );
    if (js.length === entry.js.length) return [entry];
    changed = true;
    return js.length > 0 ? [{ ...entry, js }] : [];
  });
  if (changed) manifest.content_scripts = contentScripts;
  return changed;
}

function extensionWindowBridgeSource(): string {
  return `(() => {
  const marker = "chromecraft-extension-window-v1";
  const handles = new Map();
  const number = (value, fallback, minimum, maximum) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(maximum, Math.max(minimum, Math.round(value)))
      : fallback;
  const snapshot = (id, options = {}) => ({
    id,
    focused: true,
    incognito: false,
    alwaysOnTop: false,
    type: "popup",
    state: "normal",
    left: number(options.left, 0, -32768, 32768),
    top: number(options.top, 0, -32768, 32768),
    width: number(options.width, 420, 280, 1600),
    height: number(options.height, 630, 320, 1400)
  });
  globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    if (
      !message ||
      message.__chromecraftExtensionWindow !== marker ||
      sender?.id !== globalThis.chrome.runtime.id ||
      !Number.isInteger(message.id)
    ) {
      return false;
    }
    const id = message.id;
    const options = message.options && typeof message.options === "object" ? message.options : {};
    if (message.operation === "create") {
      try {
        const url = new URL(String(options.url ?? ""));
        if (url.origin !== new URL(globalThis.chrome.runtime.getURL("")).origin) {
          sendResponse({ ok: false, error: "Only same-extension popup URLs are allowed." });
          return false;
        }
        const bounds = snapshot(id, options);
        const features = [
          "popup=yes",
          "width=" + bounds.width,
          "height=" + bounds.height,
          "left=" + bounds.left,
          "top=" + bounds.top
        ].join(",");
        const child = globalThis.open(
          url.href,
          "__chromecraft_extension_window_" + id,
          features
        );
        if (!child) {
          sendResponse({ ok: false, error: "The extension popup window was blocked." });
          return false;
        }
        handles.set(id, child);
        sendResponse({ ok: true, window: bounds });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return false;
    }
    const child = handles.get(id);
    if (message.operation === "remove") {
      try { child?.close(); } catch { /* Window may already be gone. */ }
      handles.delete(id);
      sendResponse({ ok: true });
      return false;
    }
    if (message.operation === "update") {
      if (!child || child.closed) {
        handles.delete(id);
        sendResponse({ ok: false, error: "The extension popup window is not open." });
        return false;
      }
      try {
        if (typeof options.left === "number" || typeof options.top === "number") {
          child.moveTo(
            number(options.left, child.screenX, -32768, 32768),
            number(options.top, child.screenY, -32768, 32768)
          );
        }
        if (typeof options.width === "number" || typeof options.height === "number") {
          child.resizeTo(
            number(options.width, child.outerWidth, 280, 1600),
            number(options.height, child.outerHeight, 320, 1400)
          );
        }
        if (options.focused !== false) child.focus();
        sendResponse({ ok: true, window: snapshot(id, options) });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return false;
    }
    if (message.operation === "get") {
      if (!child || child.closed) handles.delete(id);
      sendResponse({
        ok: Boolean(child && !child.closed),
        window: child && !child.closed ? snapshot(id, options) : undefined
      });
      return false;
    }
    return false;
  });
})();`;
}

function normalizeManifestPath(value: string): string {
  const normalized = value.replace(/^\/+/, "");
  validateArchivePath(normalized);
  return normalized;
}

const MAX_EXTENSION_ICON_BYTES = 256 * 1024;

function extensionIconCandidates(manifest: ExtensionManifest): string[] {
  const candidates: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") {
      candidates.push(value);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    Object.entries(value)
      .filter(([, iconPath]) => typeof iconPath === "string")
      .sort(([left], [right]) => {
        const leftSize = Number(left);
        const rightSize = Number(right);
        const leftDistance = Number.isFinite(leftSize)
          ? Math.abs(leftSize - 38)
          : Number.MAX_SAFE_INTEGER;
        const rightDistance = Number.isFinite(rightSize)
          ? Math.abs(rightSize - 38)
          : Number.MAX_SAFE_INTEGER;
        return leftDistance - rightDistance || rightSize - leftSize;
      })
      .forEach(([, iconPath]) => candidates.push(iconPath as string));
  };
  add(manifest.action?.default_icon);
  add(manifest.browser_action?.default_icon);
  add(manifest.page_action?.default_icon);
  add(manifest.icons);
  return [...new Set(candidates)];
}

function extensionIconDataUrl(data: Buffer): string | null {
  if (data.length === 0 || data.length > MAX_EXTENSION_ICON_BYTES) return null;
  let mime: string | null = null;
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    mime = "image/png";
  } else if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8) {
    mime = "image/jpeg";
  } else if (data.length >= 6 && data.subarray(0, 3).toString() === "GIF") {
    mime = "image/gif";
  } else if (
    data.length >= 12 &&
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WEBP"
  ) {
    mime = "image/webp";
  }
  return mime ? `data:${mime};base64,${data.toString("base64")}` : null;
}

function extensionIconDataUrlFromEntries(
  entries: ArchiveEntry[],
  manifest: ExtensionManifest,
): string | null {
  for (const candidate of extensionIconCandidates(manifest)) {
    try {
      const normalized = normalizeManifestPath(candidate);
      const entry = entries.find(
        (item) => !item.directory && item.name === normalized,
      );
      if (!entry) continue;
      const dataUrl = extensionIconDataUrl(entry.data);
      if (dataUrl) return dataUrl;
    } catch {
      // Invalid manifest paths are ignored and fall back to the next icon.
    }
  }
  return null;
}

async function extensionIconDataUrlFromDirectory(
  extensionPath: string,
  manifest: ExtensionManifest,
): Promise<string | null> {
  for (const candidate of extensionIconCandidates(manifest)) {
    try {
      const normalized = normalizeManifestPath(candidate);
      const iconPath = path.resolve(extensionPath, normalized);
      assertChildPath(extensionPath, iconPath);
      const file = await fs.open(iconPath, "r");
      try {
        const stats = await file.stat();
        if (!stats.isFile() || stats.size > MAX_EXTENSION_ICON_BYTES) continue;
        const dataUrl = extensionIconDataUrl(await file.readFile());
        if (dataUrl) return dataUrl;
      } finally {
        await file.close();
      }
    } catch {
      // Missing and unsafe icon candidates fall back without breaking loading.
    }
  }
  return null;
}

function compatibleWorkerSource(
  originalWorkerPath: string,
  originalWorkerSource: string,
): string {
  return `/* Chromecraft original worker: ${JSON.stringify(originalWorkerPath)} */
const __chromecraftWorkerGlobal = self;
// Keep the real worker global identity. Native Web APIs validate their receiver,
// so proxying globalThis makes otherwise valid calls such as addEventListener,
// fetch and WebAssembly initialization throw "Illegal invocation".
const globalThis = __chromecraftWorkerGlobal;
${extensionCompatibilitySource()}
const chrome = globalThis.__chromecraftChromeFacade ?? globalThis.chrome;
const browser = globalThis.__chromecraftBrowserFacade ?? globalThis.browser;
${originalWorkerSource}`;
}

function extensionCompatibilitySource(): string {
  return `(() => {
  const makeEvent = () => {
    const listeners = new Set();
    return {
      addListener(listener) { if (typeof listener === "function") listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      hasListener(listener) { return listeners.has(listener); },
      hasListeners() { return listeners.size > 0; }
    };
  };
  const ensureEvent = (owner, name) => {
    if (!owner) return;
    try {
      const event = owner[name];
      if (event && typeof event.addListener === "function") return;
    } catch {
      // Electron exposes a few event getters that throw when unsupported.
    }
    try {
      Object.defineProperty(owner, name, {
        value: makeEvent(),
        configurable: true,
        enumerable: true
      });
    } catch {
      // A non-configurable native binding remains unsupported.
    }
  };
  const ensureNamespace = (owner, name) => {
    try {
      const existing = owner[name];
      if (existing && (typeof existing === "object" || typeof existing === "function")) return existing;
    } catch {
      // Fall through to a browser-owned compatibility namespace.
    }
    const namespace = {};
    try {
      Object.defineProperty(owner, name, {
        value: namespace,
        configurable: true,
        enumerable: true
      });
    } catch {
      // Native API objects can reject new properties; the local namespace can
      // still be attached to the WebExtension browser facade after it exists.
    }
    try {
      return owner[name] ?? namespace;
    } catch {
      return namespace;
    }
  };
  const setDefault = (owner, name, value) => {
    try {
      const existing = owner[name];
      if (existing !== undefined) return existing;
    } catch {
      // Fall through to an own compatibility property.
    }
    try {
      Object.defineProperty(owner, name, {
        value,
        configurable: true,
        enumerable: true
      });
    } catch {
      // A non-configurable native binding remains unsupported.
    }
    return value;
  };
  const setOverride = (owner, name, value) => {
    if (!owner) return value;
    try {
      Object.defineProperty(owner, name, {
        value,
        configurable: true,
        enumerable: true
      });
      return value;
    } catch {
      try {
        owner[name] = value;
        return owner[name];
      } catch {
        return value;
      }
    }
  };
  const complete = (callback, value) => {
    if (typeof callback === "function") {
      queueMicrotask(() => callback(value));
      return undefined;
    }
    return Promise.resolve(value);
  };
  const completeAsync = (callback, operation) => {
    if (typeof callback === "function") {
      Promise.resolve(operation).then(
        (value) => queueMicrotask(() => callback(value)),
        (error) => {
          console.warn("Chromecraft extension window bridge failed.", error);
          queueMicrotask(() => callback(undefined));
        }
      );
      return undefined;
    }
    return Promise.resolve(operation);
  };
  let nextExtensionWindowId = 1000000;
  const extensionWindows = new Map();
  const install = (api) => {
    if (!api) return;
    const runtime = ensureNamespace(api, "runtime");
    const getContexts = (_filter, callback) => {
      const href = typeof globalThis.location?.href === "string" ? globalThis.location.href : "";
      const contextType = typeof globalThis.ServiceWorkerGlobalScope === "function" && globalThis instanceof globalThis.ServiceWorkerGlobalScope
        ? "BACKGROUND"
        : href.includes("/popup/") || href.endsWith("/popup.html")
          ? "POPUP"
          : "TAB";
      const context = {
        contextId: "chromecraft-current-context",
        contextType,
        documentUrl: href,
        documentOrigin: globalThis.location?.origin ?? "",
        incognito: false
      };
      const contexts = Array.isArray(_filter?.contextTypes) && !_filter.contextTypes.includes(contextType)
        ? []
        : [context];
      return complete(callback, contexts);
    };
    setOverride(runtime, "getContexts", getContexts);

    const webNavigation = ensureNamespace(api, "webNavigation");
    for (const name of ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted", "onErrorOccurred", "onCreatedNavigationTarget", "onReferenceFragmentUpdated", "onTabReplaced", "onHistoryStateUpdated"]) {
      ensureEvent(webNavigation, name);
    }
    setDefault(webNavigation, "getFrame", (_details, callback) => complete(callback, null));
    setDefault(webNavigation, "getAllFrames", (_details, callback) => complete(callback, []));

    const tabs = ensureNamespace(api, "tabs");
    setDefault(tabs, "getCurrent", (callback) => complete(callback, undefined));
    for (const name of ["onActivated", "onAttached", "onCreated", "onDetached", "onHighlighted", "onMoved", "onRemoved", "onReplaced", "onUpdated", "onZoomChange"]) {
      ensureEvent(tabs, name);
    }

    const windows = ensureNamespace(api, "windows");
    setDefault(windows, "WINDOW_ID_NONE", -1);
    setDefault(windows, "WINDOW_ID_CURRENT", -2);
    const currentWindowId = () => {
      if (typeof globalThis.name !== "string") return -1;
      const match = globalThis.name.match(/^__chromecraft_extension_window_(\\d+)$/u);
      return match ? Number(match[1]) : -1;
    };
    const windowSnapshot = (id = currentWindowId(), details = {}) => ({
      id,
      focused: typeof globalThis.document === "object" ? globalThis.document.hasFocus() : true,
      incognito: false,
      alwaysOnTop: false,
      type: id >= 1000000 ? "popup" : "normal",
      state: "normal",
      left: typeof globalThis.screenX === "number" ? globalThis.screenX : 0,
      top: typeof globalThis.screenY === "number" ? globalThis.screenY : 0,
      width: typeof globalThis.outerWidth === "number" && globalThis.outerWidth > 0 ? globalThis.outerWidth : 1280,
      height: typeof globalThis.outerHeight === "number" && globalThis.outerHeight > 0 ? globalThis.outerHeight : 820,
      ...details
    });
    const bridgeRequest = async (operation, id, options = {}) => {
      const request = {
        __chromecraftExtensionWindow: "chromecraft-extension-window-v1",
        operation,
        id,
        options,
      };
      if (operation !== "create" && typeof runtime.sendMessage === "function") {
        const directResponse = await new Promise((resolve) => {
          runtime.sendMessage(request, (value) => {
            void runtime.lastError;
            resolve(value ?? null);
          });
        });
        if (directResponse?.ok) return directResponse;
      }
      if (typeof tabs.query !== "function" || typeof tabs.sendMessage !== "function") {
        throw new Error("No compatible page is available for the extension window bridge.");
      }
      const candidates = await new Promise((resolve) => {
        tabs.query({}, (items) => {
          void runtime.lastError;
          resolve(Array.isArray(items) ? items : []);
        });
      });
      for (const tab of candidates) {
        if (!Number.isInteger(tab?.id)) continue;
        const response = await new Promise((resolve) => {
          tabs.sendMessage(
            tab.id,
            request,
            (value) => {
              void runtime.lastError;
              resolve(value ?? null);
            }
          );
        });
        if (response?.ok) return response;
      }
      throw new Error("No Chromecraft page accepted the extension popup request.");
    };
    setDefault(windows, "getCurrent", (_options, callback) => {
      const current = windowSnapshot();
      if (typeof _options === "function") return complete(_options, current);
      return complete(callback, current);
    });
    setDefault(windows, "get", (id, _options, callback) => {
      const current = extensionWindows.get(id) ?? windowSnapshot(id);
      if (typeof _options === "function") return complete(_options, current);
      return complete(callback, current);
    });
    setDefault(windows, "getAll", (_options, callback) => {
      const items = [windowSnapshot(-1), ...extensionWindows.values()];
      if (typeof _options === "function") return complete(_options, items);
      return complete(callback, items);
    });
    setDefault(windows, "create", (details, callback) => {
      const id = nextExtensionWindowId++;
      const operation = bridgeRequest("create", id, details).then((response) => {
        const created = response.window ?? windowSnapshot(id, details);
        extensionWindows.set(id, created);
        return created;
      });
      return completeAsync(callback, operation);
    });
    setDefault(windows, "update", (id, details, callback) => {
      const ownId = currentWindowId();
      if (id === ownId && typeof globalThis.document === "object") {
        try {
          if (typeof details?.left === "number" || typeof details?.top === "number") {
            globalThis.moveTo(details.left ?? globalThis.screenX, details.top ?? globalThis.screenY);
          }
          if (typeof details?.width === "number" || typeof details?.height === "number") {
            globalThis.resizeTo(details.width ?? globalThis.outerWidth, details.height ?? globalThis.outerHeight);
          }
          if (details?.focused !== false) globalThis.focus();
        } catch {
          // The host may constrain popup positioning; focus remains best-effort.
        }
        return complete(callback, windowSnapshot(id, details));
      }
      if (!extensionWindows.has(id)) return complete(callback, windowSnapshot(id, details));
      const operation = bridgeRequest("update", id, details).then((response) => {
        const updated = response.window ?? windowSnapshot(id, details);
        extensionWindows.set(id, updated);
        return updated;
      });
      return completeAsync(callback, operation);
    });
    setDefault(windows, "remove", (id, callback) => {
      const ownId = currentWindowId();
      if (id === ownId && typeof globalThis.close === "function") {
        globalThis.close();
        return complete(callback, undefined);
      }
      if (!extensionWindows.has(id)) return complete(callback, undefined);
      const operation = bridgeRequest("remove", id).then(() => {
        extensionWindows.delete(id);
        return undefined;
      });
      return completeAsync(callback, operation);
    });
    if (
      typeof globalThis.document === "object" &&
      runtime.onMessage?.addListener
    ) {
      runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (
          !message ||
          message.__chromecraftExtensionWindow !== "chromecraft-extension-window-v1" ||
          sender?.id !== runtime.id ||
          message.id !== currentWindowId()
        ) {
          return false;
        }
        if (message.operation === "get") {
          sendResponse({ ok: true, window: windowSnapshot(message.id) });
          return false;
        }
        if (message.operation === "update") {
          const details = message.options ?? {};
          try {
            if (typeof details.left === "number" || typeof details.top === "number") {
              globalThis.moveTo(details.left ?? globalThis.screenX, details.top ?? globalThis.screenY);
            }
            if (typeof details.width === "number" || typeof details.height === "number") {
              globalThis.resizeTo(details.width ?? globalThis.outerWidth, details.height ?? globalThis.outerHeight);
            }
            if (details.focused !== false) globalThis.focus();
          } catch {
            // The host may constrain popup positioning; focus remains best-effort.
          }
          sendResponse({
            ok: true,
            window: windowSnapshot(message.id, details)
          });
          return false;
        }
        if (message.operation === "remove") {
          sendResponse({ ok: true });
          queueMicrotask(() => globalThis.close());
          return false;
        }
        return false;
      });
    }
    for (const name of ["onBoundsChanged", "onCreated", "onFocusChanged", "onRemoved"]) {
      ensureEvent(windows, name);
    }

    const storage = ensureNamespace(api, "storage");
    ensureEvent(storage, "onChanged");

    const alarms = ensureNamespace(api, "alarms");
    ensureEvent(alarms, "onAlarm");

    const commands = ensureNamespace(api, "commands");
    ensureEvent(commands, "onCommand");

    const idle = ensureNamespace(api, "idle");
    ensureEvent(idle, "onStateChanged");

    const notifications = ensureNamespace(api, "notifications");
    for (const name of ["onClicked", "onButtonClicked", "onClosed", "onPermissionLevelChanged", "onShowSettings"]) {
      ensureEvent(notifications, name);
    }

    const permissions = ensureNamespace(api, "permissions");
    const supportedPermissions = new Set(["scripting", "storage", "tabs", "webRequest"]);
    const declaredPermissions = () => {
      const manifest = api.runtime?.getManifest?.() ?? globalThis.chrome?.runtime?.getManifest?.() ?? {};
      const required = Array.isArray(manifest.permissions) ? manifest.permissions : [];
      const origins = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
      return {
        permissions: required.filter((value) => typeof value === "string" && supportedPermissions.has(value)),
        origins: [...origins, ...required.filter((value) => typeof value === "string" && (value.includes("://") || value === "<all_urls>"))]
      };
    };
    setDefault(permissions, "contains", (details, callback) => {
      const declared = declaredPermissions();
      const requestedPermissions = Array.isArray(details?.permissions) ? details.permissions : [];
      const requestedOrigins = Array.isArray(details?.origins) ? details.origins : [];
      const granted = requestedPermissions.every((value) => declared.permissions.includes(value)) &&
        requestedOrigins.every((value) => declared.origins.includes(value) || declared.origins.includes("<all_urls>"));
      return complete(callback, granted);
    });
    setDefault(permissions, "getAll", (callback) => complete(callback, declaredPermissions()));
    setDefault(permissions, "request", (_details, callback) => complete(callback, false));
    setDefault(permissions, "remove", (_details, callback) => complete(callback, false));
    ensureEvent(permissions, "onAdded");
    ensureEvent(permissions, "onRemoved");
    return { runtime, webNavigation, tabs, windows, storage, alarms, commands, idle, notifications, permissions };
  };
  const facade = (api) => {
    if (!api) return api;
    const namespaces = install(api);
    if (!namespaces) return api;
    return new Proxy(api, {
      get(target, property) {
        if (Object.prototype.hasOwnProperty.call(namespaces, property)) return namespaces[property];
        return Reflect.get(target, property, target);
      },
      has(target, property) {
        return Object.prototype.hasOwnProperty.call(namespaces, property) || Reflect.has(target, property);
      },
      getOwnPropertyDescriptor(target, property) {
        const nativeDescriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (!nativeDescriptor && Object.prototype.hasOwnProperty.call(namespaces, property)) {
          return { value: namespaces[property], configurable: true, enumerable: true, writable: false };
        }
        return nativeDescriptor;
      }
    });
  };
  const nativeChrome = globalThis.chrome;
  const chromeApi = facade(nativeChrome);
  try {
    globalThis.chrome = chromeApi;
  } catch {
    // The native binding remains available even when the global is fixed.
  }
  let browserApi = globalThis.browser;
  try {
    browserApi = browserApi === nativeChrome ? chromeApi : facade(browserApi);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "browser");
    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(globalThis, "browser", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() { return browserApi; },
        set(value) {
          browserApi = value === nativeChrome ? chromeApi : facade(value);
        }
      });
    }
  } catch {
    // Some extension worlds expose a fixed browser binding.
  }
  try {
    Object.defineProperty(globalThis, "__chromecraftChromeFacade", {
      value: chromeApi,
      configurable: true
    });
    Object.defineProperty(globalThis, "__chromecraftBrowserFacade", {
      get() { return browserApi; },
      configurable: true
    });
  } catch {
    // The lexical aliases below still fall back to native globals.
  }
})();`;
}

function isStoredExtension(value: unknown): value is StoredExtension {
  if (!value || typeof value !== "object") return false;
  const stored = value as Partial<StoredExtension>;
  if (
    typeof stored.id !== "string" ||
    !EXTENSION_ID_PATTERN.test(stored.id) ||
    typeof stored.version !== "string" ||
    typeof stored.enabled !== "boolean" ||
    typeof stored.sourceUrl !== "string"
  ) {
    return false;
  }
  try {
    requireVersion(stored.version);
    return parseChromeWebStoreItemUrl(stored.sourceUrl) === stored.id;
  } catch {
    return false;
  }
}

function requireExtensionId(extensionId: string): void {
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new TypeError("The extension id is invalid.");
  }
}

function requireVersion(version: string): void {
  if (!/^\d+(?:\.\d+){0,3}$/.test(version) || version.length > 64) {
    throw new TypeError("The extension version is invalid.");
  }
}

function assertChildPath(parent: string, candidate: string): void {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The extension path escaped its storage directory.");
  }
}

function cloneSnapshot(
  snapshot: InstalledExtensionSnapshot,
): InstalledExtensionSnapshot {
  return {
    ...snapshot,
    permissions: [...snapshot.permissions],
    hostPermissions: [...snapshot.hostPermissions],
    warnings: [...snapshot.warnings],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
