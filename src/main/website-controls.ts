import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Session, WebContents } from "electron";

import type {
  SecureDnsMode,
  SitePermissionDecision,
  SitePermissionKey,
  WebsiteControlSnapshot,
  WebsiteControlsSnapshot,
} from "../shared/browser";

export const SITE_PERMISSION_KEYS = [
  "camera",
  "microphone",
  "location",
  "notifications",
  "popups",
  "clipboard",
  "autoplay",
  "downloads",
  "network",
  "javascript",
  "hyperdrive",
] as const satisfies readonly SitePermissionKey[];

const PERMISSION_KEY_SET = new Set<string>(SITE_PERMISSION_KEYS);
const DECISION_SET = new Set<SitePermissionDecision>(["ask", "allow", "block"]);
const DATA_TYPES: Electron.ClearDataOptions["dataTypes"] = [
  "backgroundFetch",
  "cache",
  "cookies",
  "fileSystems",
  "indexedDB",
  "localStorage",
  "serviceWorkers",
  "webSQL",
];

const LIMITATIONS: WebsiteControlsSnapshot["limitations"] = {
  autoplay:
    "Electron has no per-origin autoplay content setting. Blocking is enforced by the Chromecraft page preload and takes effect on the next document load.",
  javascript:
    "JavaScript blocking is enforced by request cancellation and a restrictive response policy. Reload the site after changing it.",
};

interface PersistedWebsiteControls {
  version: 1;
  secureDns: {
    mode: SecureDnsMode;
    providerUrl: string | null;
  };
  sites: Record<
    string,
    Partial<Record<SitePermissionKey, SitePermissionDecision>>
  >;
}

export type WebsitePermissionPromptResult = "allow-once" | "allow" | "block";

export interface WebsitePermissionPromptRequest {
  origin: string;
  permissions: SitePermissionKey[];
}

export interface WebsiteControlsOptions {
  filePath: string;
  prompt: (
    request: WebsitePermissionPromptRequest,
  ) => Promise<WebsitePermissionPromptResult>;
  applySecureDns: (mode: SecureDnsMode, providerUrl: string | null) => void;
  onChanged?: (snapshot: WebsiteControlsSnapshot) => void;
  onHyperdriveDecisionChanged?: (
    origin: string,
    decision: SitePermissionDecision,
  ) => Promise<void> | void;
}

/**
 * Persistent, local-only website controls for the browser profile.
 *
 * Only canonical HTTP(S) origins are accepted. Request enforcement is deliberately
 * hosted in the main process so a compromised page cannot grant itself access.
 */
export class WebsiteControlsService {
  private secureDns: PersistedWebsiteControls["secureDns"] = {
    mode: "automatic",
    providerUrl: null,
  };
  private readonly sites = new Map<
    string,
    Partial<Record<SitePermissionKey, SitePermissionDecision>>
  >();
  private readonly oneTimeGrants = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly browserSession: Session,
    private readonly options: WebsiteControlsOptions,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.load();
    this.options.applySecureDns(
      this.secureDns.mode,
      this.secureDns.providerUrl,
    );
    this.attachRequestPolicy();
    this.initialized = true;
  }

  getDecision(
    originOrUrl: string,
    key: SitePermissionKey,
  ): SitePermissionDecision {
    const origin = requireWebOrigin(originOrUrl);
    return this.decisionForOrigin(origin, key);
  }

  documentPolicy(
    originOrUrl: string,
  ): Pick<
    Record<SitePermissionKey, SitePermissionDecision>,
    "autoplay" | "javascript" | "network"
  > {
    const origin = requireWebOrigin(originOrUrl);
    return {
      autoplay: this.decisionForOrigin(origin, "autoplay"),
      javascript: this.decisionForOrigin(origin, "javascript"),
      network: this.decisionForOrigin(origin, "network"),
    };
  }

  async snapshot(): Promise<WebsiteControlsSnapshot> {
    const sites = [...this.sites.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map((origin) => ({
        origin,
        hostname: new URL(origin).hostname,
        decisions: this.decisionsFor(origin),
        // Storage enumeration is intentionally limited to the actively inspected
        // site instead of issuing one cookies query for every saved exception.
        hasStoredData: null,
      }));
    return {
      secureDns: { ...this.secureDns },
      sites,
      limitations: { ...LIMITATIONS },
    };
  }

  async siteSnapshot(originOrUrl: string): Promise<WebsiteControlSnapshot> {
    const origin = requireWebOrigin(originOrUrl);
    let hasStoredData: boolean | null = null;
    try {
      const cookies = await this.browserSession.cookies.get({
        url: `${origin}/`,
      });
      hasStoredData = cookies.length > 0 ? true : null;
    } catch {
      // Electron cannot cheaply enumerate every storage bucket per origin.
    }
    return {
      origin,
      hostname: new URL(origin).hostname,
      decisions: this.decisionsFor(origin),
      hasStoredData,
    };
  }

  async setDecision(
    originOrUrl: string,
    key: SitePermissionKey,
    decision: SitePermissionDecision,
  ): Promise<void> {
    const origin = requireWebOrigin(originOrUrl);
    if (!isSitePermissionKey(key))
      throw new TypeError("Unknown website permission.");
    if (!isSitePermissionDecision(decision))
      throw new TypeError("Unknown website permission decision.");

    const current = { ...(this.sites.get(origin) ?? {}) };
    if (decision === "ask") delete current[key];
    else current[key] = decision;
    if (Object.keys(current).length === 0) this.sites.delete(origin);
    else this.sites.set(origin, current);

    this.dropOneTimeGrants(origin, key);
    if (key === "hyperdrive") {
      await this.options.onHyperdriveDecisionChanged?.(origin, decision);
    }
    await this.persistAndEmit();
  }

  async resetSite(originOrUrl: string): Promise<void> {
    const origin = requireWebOrigin(originOrUrl);
    const hyperdriveWasBlocked =
      this.getDecision(origin, "hyperdrive") === "block";
    this.sites.delete(origin);
    this.dropOneTimeGrants(origin);
    if (hyperdriveWasBlocked) {
      await this.options.onHyperdriveDecisionChanged?.(origin, "ask");
    }
    await this.persistAndEmit();
  }

  async clearSiteData(originOrUrl: string): Promise<void> {
    const origin = requireWebOrigin(originOrUrl);
    await this.browserSession.clearData({
      origins: [origin],
      dataTypes: DATA_TYPES,
      originMatchingMode: "origin-in-all-contexts",
    });
    await this.emit();
  }

  async setSecureDns(mode: SecureDnsMode, providerUrl?: string): Promise<void> {
    if (!isSecureDnsMode(mode)) throw new TypeError("Unknown secure DNS mode.");
    const provider = normalizeSecureDnsProvider(mode, providerUrl);
    this.options.applySecureDns(mode, provider);
    this.secureDns = { mode, providerUrl: provider };
    await this.browserSession.clearHostResolverCache().catch(() => undefined);
    await this.browserSession.closeAllConnections().catch(() => undefined);
    await this.persistAndEmit();
  }

  checkPermission(
    contents: WebContents | null,
    electronPermission: string,
    requestingOrigin: string,
    details?: Electron.PermissionCheckHandlerHandlerDetails,
  ): boolean | null {
    const origin = permissionOrigin(
      details?.securityOrigin ?? details?.requestingUrl ?? requestingOrigin,
    );
    const keys = siteKeysForElectronPermission(electronPermission, details);
    if (!origin || !keys) return null;
    return keys.every(
      (key) =>
        this.getDecision(origin, key) === "allow" ||
        Boolean(
          contents && this.oneTimeGrants.has(grantKey(contents, origin, key)),
        ),
    );
  }

  async requestPermission(
    contents: WebContents,
    electronPermission: string,
    details: Electron.PermissionRequest,
  ): Promise<boolean | null> {
    if (contents.isDestroyed()) return false;
    const media = details as Electron.MediaAccessPermissionRequest;
    const origin = permissionOrigin(
      media.securityOrigin ?? details.requestingUrl ?? contents.getURL(),
    );
    const keys = siteKeysForElectronPermission(
      electronPermission,
      undefined,
      media,
    );
    if (!origin || !keys) return null;

    if (keys.some((key) => this.getDecision(origin, key) === "block")) {
      return false;
    }
    const undecided = keys.filter(
      (key) =>
        this.getDecision(origin, key) !== "allow" &&
        !this.oneTimeGrants.has(grantKey(contents, origin, key)),
    );
    if (undecided.length === 0) return true;

    const result = await this.options.prompt({
      origin,
      permissions: undecided,
    });
    if (contents.isDestroyed()) return false;
    if (result === "allow-once") {
      for (const key of undecided)
        this.oneTimeGrants.add(grantKey(contents, origin, key));
      return true;
    }
    const decision: SitePermissionDecision =
      result === "allow" ? "allow" : "block";
    for (const key of undecided) {
      const current = { ...(this.sites.get(origin) ?? {}) };
      current[key] = decision;
      this.sites.set(origin, current);
    }
    await this.persistAndEmit();
    return decision === "allow";
  }

  revoke(contents: WebContents): void {
    const prefix = `${contents.id}\n`;
    for (const key of this.oneTimeGrants) {
      if (key.startsWith(prefix)) this.oneTimeGrants.delete(key);
    }
  }

  shouldAllowPopup(originOrUrl: string): boolean {
    return this.getDecision(originOrUrl, "popups") !== "block";
  }

  shouldAllowDownload(originOrUrl: string): boolean {
    return this.getDecision(originOrUrl, "downloads") !== "block";
  }

  private decisionsFor(
    origin: string,
  ): Record<SitePermissionKey, SitePermissionDecision> {
    const stored = this.sites.get(origin);
    return Object.fromEntries(
      SITE_PERMISSION_KEYS.map((key) => [key, stored?.[key] ?? "ask"]),
    ) as Record<SitePermissionKey, SitePermissionDecision>;
  }

  private decisionForOrigin(
    origin: string,
    key: SitePermissionKey,
  ): SitePermissionDecision {
    return this.sites.get(origin)?.[key] ?? "ask";
  }

  private attachRequestPolicy(): void {
    const filter = { urls: ["http://*/*", "https://*/*"] };
    this.browserSession.webRequest.onBeforeRequest(
      filter,
      (details, callback) => {
        const targetOrigin = optionalWebOrigin(details.url);
        const documentOrigin =
          optionalWebOrigin(details.initiatorOrigin) ??
          optionalWebOrigin(details.webContents?.getURL());
        const targetNetworkBlocked = Boolean(
          targetOrigin &&
          this.decisionForOrigin(targetOrigin, "network") === "block",
        );
        const documentNetworkBlocked = Boolean(
          documentOrigin &&
          this.decisionForOrigin(documentOrigin, "network") === "block",
        );
        const scriptBlocked = Boolean(
          details.resourceType === "script" &&
          documentOrigin &&
          this.decisionForOrigin(documentOrigin, "javascript") === "block",
        );
        callback({
          cancel:
            targetNetworkBlocked || documentNetworkBlocked || scriptBlocked,
        });
      },
    );
    this.browserSession.webRequest.onHeadersReceived(
      filter,
      (details, callback) => {
        const origin = optionalWebOrigin(details.url);
        if (
          !origin ||
          (details.resourceType !== "mainFrame" &&
            details.resourceType !== "subFrame") ||
          this.decisionForOrigin(origin, "javascript") !== "block"
        ) {
          callback({});
          return;
        }
        const headers = { ...(details.responseHeaders ?? {}) };
        const existingKey = Object.keys(headers).find(
          (key) => key.toLowerCase() === "content-security-policy",
        );
        const policy = "script-src 'none'; worker-src 'none'";
        if (existingKey)
          headers[existingKey] = [...headers[existingKey], policy];
        else headers["Content-Security-Policy"] = [policy];
        callback({ responseHeaders: headers });
      },
    );
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.options.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isPersistedWebsiteControls(parsed))
        throw new TypeError("Website controls file has an unsupported format.");
      this.secureDns = {
        mode: parsed.secureDns.mode,
        providerUrl: normalizeSecureDnsProvider(
          parsed.secureDns.mode,
          parsed.secureDns.providerUrl ?? undefined,
        ),
      };
      for (const [rawOrigin, rawDecisions] of Object.entries(parsed.sites)) {
        const origin = optionalWebOrigin(rawOrigin);
        if (!origin) continue;
        const decisions: Partial<
          Record<SitePermissionKey, SitePermissionDecision>
        > = {};
        for (const [key, decision] of Object.entries(rawDecisions)) {
          if (isSitePermissionKey(key) && isSitePermissionDecision(decision)) {
            decisions[key] = decision;
          }
        }
        if (Object.keys(decisions).length > 0)
          this.sites.set(origin, decisions);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "Could not read website controls; using safe defaults.",
          error,
        );
      }
    }
  }

  private async persistAndEmit(): Promise<void> {
    const pendingWrite = this.writeChain.then(
      () => this.write(),
      () => this.write(),
    );
    this.writeChain = pendingWrite.catch(() => undefined);
    await pendingWrite;
    await this.emit();
  }

  private async write(): Promise<void> {
    const payload: PersistedWebsiteControls = {
      version: 1,
      secureDns: { ...this.secureDns },
      sites: Object.fromEntries(this.sites),
    };
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
    const temporary = `${this.options.filePath}.${process.pid}.${randomUUID()}.next`;
    try {
      await fs.writeFile(
        temporary,
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf8",
      );
      await fs.rename(temporary, this.options.filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async emit(): Promise<void> {
    if (!this.options.onChanged) return;
    this.options.onChanged(await this.snapshot());
  }

  private dropOneTimeGrants(
    origin: string,
    permission?: SitePermissionKey,
  ): void {
    const suffix = permission ? `\n${origin}\n${permission}` : `\n${origin}\n`;
    for (const key of this.oneTimeGrants) {
      if (permission ? key.endsWith(suffix) : key.includes(suffix)) {
        this.oneTimeGrants.delete(key);
      }
    }
  }
}

export function isSitePermissionKey(
  value: unknown,
): value is SitePermissionKey {
  return typeof value === "string" && PERMISSION_KEY_SET.has(value);
}

export function isSitePermissionDecision(
  value: unknown,
): value is SitePermissionDecision {
  return (
    typeof value === "string" &&
    DECISION_SET.has(value as SitePermissionDecision)
  );
}

export function isSecureDnsMode(value: unknown): value is SecureDnsMode {
  return value === "system" || value === "automatic" || value === "secure";
}

export function canonicalWebOrigin(value: string): string | null {
  return optionalWebOrigin(value);
}

function requireWebOrigin(value: string): string {
  const origin = optionalWebOrigin(value);
  if (!origin) throw new TypeError("A valid HTTP or HTTPS site is required.");
  return origin;
}

function optionalWebOrigin(value?: string): string | null {
  if (!value || value.length > 8_192) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "blob:") return optionalWebOrigin(parsed.origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function permissionOrigin(value?: string): string | null {
  return optionalWebOrigin(value);
}

function siteKeysForElectronPermission(
  permission: string,
  checkDetails?: Electron.PermissionCheckHandlerHandlerDetails,
  requestDetails?: Electron.MediaAccessPermissionRequest,
): SitePermissionKey[] | null {
  if (permission === "geolocation" || permission === "geolocation-approximate")
    return ["location"];
  if (permission === "notifications") return ["notifications"];
  if (
    permission === "clipboard-read" ||
    permission === "clipboard-sanitized-write" ||
    permission === "deprecated-sync-clipboard-read"
  )
    return ["clipboard"];
  if (permission !== "media") return null;
  const mediaTypes =
    requestDetails?.mediaTypes ??
    (checkDetails?.mediaType && checkDetails.mediaType !== "unknown"
      ? [checkDetails.mediaType]
      : ["video", "audio"]);
  const keys = new Set<SitePermissionKey>();
  if (mediaTypes.includes("video")) keys.add("camera");
  if (mediaTypes.includes("audio")) keys.add("microphone");
  return [...keys];
}

function grantKey(
  contents: WebContents,
  origin: string,
  permission: SitePermissionKey,
): string {
  return `${contents.id}\n${origin}\n${permission}`;
}

function normalizeSecureDnsProvider(
  mode: SecureDnsMode,
  providerUrl?: string,
): string | null {
  if (mode !== "secure") return null;
  const provider = providerUrl?.trim();
  if (!provider || provider.length > 2_048)
    throw new TypeError(
      "Secure DNS mode requires a bounded HTTPS provider URL.",
    );
  const templateBase = provider.split("{", 1)[0];
  let parsed: URL;
  try {
    parsed = new URL(templateBase);
  } catch {
    throw new TypeError("The secure DNS provider URL is invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new TypeError(
      "The secure DNS provider must use HTTPS without credentials.",
    );
  return provider;
}

function isPersistedWebsiteControls(
  value: unknown,
): value is PersistedWebsiteControls {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedWebsiteControls>;
  return (
    candidate.version === 1 &&
    Boolean(candidate.secureDns) &&
    isSecureDnsMode(candidate.secureDns?.mode) &&
    (candidate.secureDns?.providerUrl === null ||
      typeof candidate.secureDns?.providerUrl === "string") &&
    Boolean(candidate.sites) &&
    typeof candidate.sites === "object" &&
    !Array.isArray(candidate.sites)
  );
}
