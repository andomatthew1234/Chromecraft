export type ExtensionActionKind = "action" | "browserAction" | "pageAction";

export type ExtensionActionMethod =
  | "enable"
  | "disable"
  | "isEnabled"
  | "show"
  | "hide"
  | "setTitle"
  | "getTitle"
  | "setPopup"
  | "getPopup"
  | "setBadgeText"
  | "getBadgeText"
  | "setBadgeBackgroundColor"
  | "getBadgeBackgroundColor"
  | "setBadgeTextColor"
  | "getBadgeTextColor"
  | "setIcon"
  | "getUserSettings"
  | "openPopup";

export interface ExtensionActionRegistration {
  id: string;
  name: string;
  baseUrl: string;
  manifest: Record<string, unknown>;
}

export interface ResolvedExtensionAction {
  extensionId: string;
  kind: ExtensionActionKind;
  title: string;
  popupUrl: string | null;
  enabled: boolean;
  visible: boolean;
  badgeText: string;
  badgeBackgroundColor: [number, number, number, number];
  badgeTextColor: [number, number, number, number];
  iconUrl: string | null;
}

export interface ExtensionActionHostOptions {
  changed?: (extensionId: string) => void;
  activeTabId?: () => number | null;
  openPopup?: (
    extensionId: string,
    popupUrl: string,
    tabId: number | null,
  ) => Promise<void>;
  resolveIcon?: (
    extensionId: string,
    iconUrl: string,
  ) => Promise<string | null>;
}

export interface ExtensionActionInvocationTab {
  id: number;
  url: string;
}

export type ExtensionActionInvocation =
  | { kind: "popup"; popupUrl: string }
  | { kind: "clicked" };

interface ActionDefaults {
  kind: ExtensionActionKind;
  title: string;
  popupUrl: string | null;
  enabled: boolean;
  visible: boolean;
  badgeText: string;
  badgeBackgroundColor: [number, number, number, number];
  badgeTextColor: [number, number, number, number];
  iconUrl: string | null;
}

interface ActionOverrides {
  title?: string;
  popupUrl?: string | null;
  enabled?: boolean;
  visible?: boolean;
  badgeText?: string;
  badgeBackgroundColor?: [number, number, number, number];
  badgeTextColor?: [number, number, number, number];
  iconUrl?: string | null;
}

interface RegisteredAction {
  baseUrl: string;
  activeTabPermission: boolean;
  activeTabGrants: Map<number, string>;
  defaults: ActionDefaults;
  global: ActionOverrides;
  perTab: Map<number, ActionOverrides>;
}

const EXTENSION_ID = /^[a-p]{32}$/u;
const MAX_TEXT_LENGTH = 4_096;
const MAX_BADGE_LENGTH = 256;

/**
 * Owns all browser-action state and Chrome-compatible precedence rules.
 * Installation, transport, toolbar rendering, and popup hosting are adapters;
 * callers only register manifests, execute authenticated commands, and resolve
 * the effective action for one tab.
 */
export class ExtensionActionHost {
  private readonly registrations = new Map<string, RegisteredAction>();

  constructor(private readonly options: ExtensionActionHostOptions = {}) {}

  register(registration: ExtensionActionRegistration): boolean {
    requireExtensionId(registration.id);
    const defaults = defaultsFromManifest(registration);
    if (!defaults) {
      this.registrations.delete(registration.id);
      return false;
    }
    const existing = this.registrations.get(registration.id);
    this.registrations.set(registration.id, {
      baseUrl: normalizedExtensionBase(registration.id, registration.baseUrl),
      activeTabPermission: manifestPermissions(registration.manifest).has(
        "activeTab",
      ),
      activeTabGrants: existing?.activeTabGrants ?? new Map(),
      defaults,
      global: existing?.global ?? {},
      perTab: existing?.perTab ?? new Map(),
    });
    return true;
  }

  unregister(extensionId: string): void {
    if (this.registrations.delete(extensionId)) this.changed(extensionId);
  }

  has(extensionId: string): boolean {
    return this.registrations.has(extensionId);
  }

  get extensionIds(): string[] {
    return [...this.registrations.keys()];
  }

  resolve(
    extensionId: string,
    tabId: number | null = null,
  ): ResolvedExtensionAction | null {
    const registration = this.registrations.get(extensionId);
    if (!registration) return null;
    const tab = tabId === null ? undefined : registration.perTab.get(tabId);
    const value = <K extends keyof ActionOverrides>(key: K) =>
      tab?.[key] !== undefined
        ? tab[key]
        : registration.global[key] !== undefined
          ? registration.global[key]
          : registration.defaults[key as keyof ActionDefaults];
    return {
      extensionId,
      kind: registration.defaults.kind,
      title: value("title") as string,
      popupUrl: value("popupUrl") as string | null,
      enabled: value("enabled") as boolean,
      visible: value("visible") as boolean,
      badgeText: value("badgeText") as string,
      badgeBackgroundColor: cloneColor(
        value("badgeBackgroundColor") as [number, number, number, number],
      ),
      badgeTextColor: cloneColor(
        value("badgeTextColor") as [number, number, number, number],
      ),
      iconUrl: value("iconUrl") as string | null,
    };
  }

  async execute(
    extensionId: string,
    method: ExtensionActionMethod,
    rawDetails?: unknown,
  ): Promise<unknown> {
    const registration = this.requireRegistration(extensionId);
    const details = actionDetails(rawDetails);
    const explicitTabId = optionalTabId(details.tabId);
    const tabId =
      method === "openPopup" && explicitTabId === null
        ? (this.options.activeTabId?.() ?? null)
        : explicitTabId;
    const resolved = () => this.requireResolved(extensionId, tabId);

    switch (method) {
      case "enable":
        this.setOverride(registration, extensionId, tabId, "enabled", true);
        return undefined;
      case "disable":
        this.setOverride(registration, extensionId, tabId, "enabled", false);
        return undefined;
      case "isEnabled":
        return resolved().enabled;
      case "show":
        this.setOverride(registration, extensionId, tabId, "visible", true);
        return undefined;
      case "hide":
        this.setOverride(registration, extensionId, tabId, "visible", false);
        return undefined;
      case "setTitle":
        this.setOverride(
          registration,
          extensionId,
          tabId,
          "title",
          boundedString(details.title, "title", MAX_TEXT_LENGTH),
        );
        return undefined;
      case "getTitle":
        return resolved().title;
      case "setPopup":
        this.setOverride(
          registration,
          extensionId,
          tabId,
          "popupUrl",
          popupUrl(registration.baseUrl, details.popup),
        );
        return undefined;
      case "getPopup":
        return resolved().popupUrl ?? "";
      case "setBadgeText":
        this.setOverride(
          registration,
          extensionId,
          tabId,
          "badgeText",
          boundedString(details.text, "text", MAX_BADGE_LENGTH),
        );
        return undefined;
      case "getBadgeText":
        return resolved().badgeText;
      case "setBadgeBackgroundColor":
        this.setOverride(
          registration,
          extensionId,
          tabId,
          "badgeBackgroundColor",
          parseColor(details.color),
        );
        return undefined;
      case "getBadgeBackgroundColor":
        return resolved().badgeBackgroundColor;
      case "setBadgeTextColor":
        this.setOverride(
          registration,
          extensionId,
          tabId,
          "badgeTextColor",
          parseColor(details.color),
        );
        return undefined;
      case "getBadgeTextColor":
        return resolved().badgeTextColor;
      case "setIcon": {
        const resourceUrl = iconUrl(registration.baseUrl, details);
        this.setOverride(
          registration,
          extensionId,
          tabId,
          "iconUrl",
          resourceUrl && this.options.resolveIcon
            ? await this.options.resolveIcon(extensionId, resourceUrl)
            : resourceUrl,
        );
        return undefined;
      }
      case "getUserSettings":
        return { isOnToolbar: true };
      case "openPopup": {
        const action = resolved();
        if (!action.enabled || !action.visible)
          throw new Error("The extension action is disabled or hidden.");
        if (!action.popupUrl)
          throw new Error("The extension action has no popup.");
        if (!this.options.openPopup)
          throw new Error("The extension popup host is unavailable.");
        await this.options.openPopup(extensionId, action.popupUrl, tabId);
        return undefined;
      }
    }
  }

  /**
   * Applies Chrome's toolbar-click semantics after a trusted browser-UI click.
   * Popup actions do not emit onClicked. Popup-less actions may acquire a
   * temporary activeTab grant which remains scoped to this tab and origin.
   */
  invokeFromToolbar(
    extensionId: string,
    tab: ExtensionActionInvocationTab,
  ): ExtensionActionInvocation {
    const registration = this.requireRegistration(extensionId);
    if (!Number.isSafeInteger(tab.id) || tab.id < 1)
      throw new TypeError("Extension action tabId must be a positive integer.");
    const action = this.requireResolved(extensionId, tab.id);
    if (!action.enabled || !action.visible)
      throw new Error("The extension action is disabled or hidden.");
    if (registration.activeTabPermission) {
      const origin = activeTabOrigin(tab.url);
      if (origin) registration.activeTabGrants.set(tab.id, origin);
    }
    if (action.popupUrl) return { kind: "popup", popupUrl: action.popupUrl };
    return { kind: "clicked" };
  }

  hasActiveTabGrant(extensionId: string, tabId: number, url: string): boolean {
    const registration = this.registrations.get(extensionId);
    const origin = activeTabOrigin(url);
    return Boolean(
      registration &&
      origin &&
      registration.activeTabGrants.get(tabId) === origin,
    );
  }

  removeTab(tabId: number): void {
    for (const [extensionId, registration] of this.registrations) {
      const changed = registration.perTab.delete(tabId);
      registration.activeTabGrants.delete(tabId);
      if (changed) this.changed(extensionId);
    }
  }

  navigatedTab(tabId: number, url?: string): void {
    for (const [extensionId, registration] of this.registrations) {
      const grantedOrigin = registration.activeTabGrants.get(tabId);
      if (
        grantedOrigin &&
        (url === undefined || activeTabOrigin(url) !== grantedOrigin)
      ) {
        registration.activeTabGrants.delete(tabId);
      }
      if (registration.defaults.kind !== "pageAction") continue;
      const tab = registration.perTab.get(tabId);
      if (!tab || tab.visible === undefined) continue;
      delete tab.visible;
      if (Object.keys(tab).length === 0) registration.perTab.delete(tabId);
      this.changed(extensionId);
    }
  }

  private requireRegistration(extensionId: string): RegisteredAction {
    const registration = this.registrations.get(extensionId);
    if (!registration) throw new Error("The extension has no toolbar action.");
    return registration;
  }

  private requireResolved(
    extensionId: string,
    tabId: number | null,
  ): ResolvedExtensionAction {
    const resolved = this.resolve(extensionId, tabId);
    if (!resolved) throw new Error("The extension has no toolbar action.");
    return resolved;
  }

  private setOverride<K extends keyof ActionOverrides>(
    registration: RegisteredAction,
    extensionId: string,
    tabId: number | null,
    key: K,
    value: Exclude<ActionOverrides[K], undefined>,
  ): void {
    const target =
      tabId === null
        ? registration.global
        : (registration.perTab.get(tabId) ?? {});
    target[key] = value;
    if (tabId !== null) {
      registration.perTab.set(tabId, target);
    } else {
      for (const [candidateTabId, overrides] of registration.perTab) {
        delete overrides[key];
        if (Object.keys(overrides).length === 0)
          registration.perTab.delete(candidateTabId);
      }
    }
    this.changed(extensionId);
  }

  private changed(extensionId: string): void {
    this.options.changed?.(extensionId);
  }
}

function manifestPermissions(manifest: Record<string, unknown>): Set<string> {
  const values = (
    Array.isArray(manifest.permissions) ? manifest.permissions : []
  ).filter((entry): entry is string => typeof entry === "string");
  return new Set(values);
}

function activeTabOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function defaultsFromManifest(
  registration: ExtensionActionRegistration,
): ActionDefaults | null {
  const entries: Array<[ExtensionActionKind, unknown]> = [
    ["action", registration.manifest.action],
    ["browserAction", registration.manifest.browser_action],
    ["pageAction", registration.manifest.page_action],
  ];
  const selected = entries.find(
    ([, value]) => value && typeof value === "object",
  );
  if (!selected) return null;
  const [kind, raw] = selected;
  const manifestAction = raw as Record<string, unknown>;
  const baseUrl = normalizedExtensionBase(
    registration.id,
    registration.baseUrl,
  );
  return {
    kind,
    title:
      typeof manifestAction.default_title === "string"
        ? manifestAction.default_title
        : registration.name,
    popupUrl: popupUrl(baseUrl, manifestAction.default_popup ?? ""),
    enabled: manifestAction.default_state !== "disabled",
    visible: kind !== "pageAction",
    badgeText: "",
    badgeBackgroundColor: [0, 0, 0, 0],
    badgeTextColor: [255, 255, 255, 255],
    iconUrl:
      manifestAction.default_icon === undefined
        ? null
        : iconUrl(baseUrl, { path: manifestAction.default_icon }),
  };
}

function normalizedExtensionBase(extensionId: string, rawBase: string): string {
  const expected = `chrome-extension://${extensionId}/`;
  try {
    const base = new URL(rawBase);
    if (base.protocol === "chrome-extension:" && base.hostname === extensionId)
      return expected;
  } catch {
    // Reject malformed or cross-extension bases below.
  }
  throw new Error("The extension action base URL is invalid.");
}

function popupUrl(baseUrl: string, raw: unknown): string | null {
  const value = boundedString(raw, "popup", MAX_TEXT_LENGTH);
  if (value === "") return null;
  return sameExtensionUrl(baseUrl, value);
}

function iconUrl(
  baseUrl: string,
  details: Record<string, unknown>,
): string | null {
  const raw = details.path;
  if (typeof raw === "string")
    return raw === "" ? null : sameExtensionUrl(baseUrl, raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const candidates = Object.entries(raw as Record<string, unknown>)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
      .sort(([left], [right]) => Number(right) - Number(left));
    const selected = candidates[0]?.[1];
    return selected ? sameExtensionUrl(baseUrl, selected) : null;
  }
  if (details.imageData !== undefined) return null;
  throw new TypeError("Action icon details require path or imageData.");
}

function sameExtensionUrl(baseUrl: string, value: string): string {
  const base = new URL(baseUrl);
  const resolved = new URL(value, base);
  if (
    resolved.protocol !== "chrome-extension:" ||
    resolved.hostname !== base.hostname ||
    resolved.username ||
    resolved.password ||
    resolved.port
  ) {
    throw new Error("Extension action resources must belong to the extension.");
  }
  return resolved.toString();
}

function actionDetails(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new TypeError("Extension action details must be an object.");
  return raw as Record<string, unknown>;
}

function optionalTabId(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (!Number.isSafeInteger(raw) || (raw as number) < 1)
    throw new TypeError("Extension action tabId must be a positive integer.");
  return raw as number;
}

function boundedString(raw: unknown, name: string, maximum: number): string {
  if (typeof raw !== "string")
    throw new TypeError(`Extension action ${name} must be a string.`);
  if (raw.length > maximum)
    throw new TypeError(`Extension action ${name} is too long.`);
  return raw;
}

function parseColor(raw: unknown): [number, number, number, number] {
  if (Array.isArray(raw)) {
    if (raw.length !== 3 && raw.length !== 4)
      throw new TypeError(
        "Extension action colors need three or four channels.",
      );
    const values = raw.map((value) => Number(value));
    if (
      values.some(
        (value) => !Number.isFinite(value) || value < 0 || value > 255,
      )
    )
      throw new TypeError(
        "Extension action color channels must be from 0 to 255.",
      );
    return [
      Math.round(values[0]),
      Math.round(values[1]),
      Math.round(values[2]),
      Math.round(values[3] ?? 255),
    ];
  }
  if (typeof raw !== "string")
    throw new TypeError(
      "Extension action colors must be CSS colors or arrays.",
    );
  const value = raw.trim().toLowerCase();
  if (value === "transparent") return [0, 0, 0, 0];
  const short = /^#([0-9a-f]{3,4})$/u.exec(value)?.[1];
  if (short) {
    const channels = [...short].map((channel) =>
      Number.parseInt(channel + channel, 16),
    );
    return [channels[0], channels[1], channels[2], channels[3] ?? 255];
  }
  const full = /^#([0-9a-f]{6}|[0-9a-f]{8})$/u.exec(value)?.[1];
  if (full) {
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
      full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) : 255,
    ];
  }
  throw new TypeError("The extension action color is unsupported.");
}

function cloneColor(
  color: [number, number, number, number],
): [number, number, number, number] {
  return [...color];
}

function requireExtensionId(value: string): void {
  if (!EXTENSION_ID.test(value))
    throw new Error("The extension id is invalid.");
}
