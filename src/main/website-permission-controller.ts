import type { WebContents } from "electron";

export type WebsiteRuntimePermission =
  | "pointerLock"
  | "keyboardLock"
  | "screen-wake-lock";

export interface ActiveWebsitePermissionContext {
  topLevelUrl: string;
  websiteFullscreen: boolean;
  documentId: string;
}

export interface WebsitePermissionPrompt {
  permission: WebsiteRuntimePermission;
  origin: string;
}

export interface WebsitePermissionControllerOptions {
  contextFor: (contents: WebContents) => ActiveWebsitePermissionContext | null;
  prompt: (request: WebsitePermissionPrompt) => Promise<boolean>;
}

const runtimePermissions = new Set<WebsiteRuntimePermission>([
  "pointerLock",
  "keyboardLock",
  "screen-wake-lock",
]);

export function isWebsiteRuntimePermission(
  permission: string,
): permission is WebsiteRuntimePermission {
  return runtimePermissions.has(permission as WebsiteRuntimePermission);
}

export function resolveWebsitePermissionOrigin(
  topLevelUrl: string,
  requestingUrl?: string,
): string | null {
  const topLevelOrigin = httpOrigin(topLevelUrl);
  if (!topLevelOrigin) return null;
  if (!requestingUrl) return topLevelOrigin;
  const requestingOrigin = httpOrigin(requestingUrl);
  if (requestingOrigin) return requestingOrigin;
  if (isOpaqueFrameUrl(requestingUrl)) return topLevelOrigin;
  return null;
}

/** Session-only grants for interactive capabilities used by games and media. */
export class WebsitePermissionController {
  private readonly grants = new Set<string>();
  private readonly denials = new Set<string>();
  private readonly prompts = new Map<string, Promise<boolean>>();
  private readonly invalidationVersions = new Map<number, number>();

  constructor(private readonly options: WebsitePermissionControllerOptions) {}

  check(
    contents: WebContents,
    permission: string,
    requestingUrl?: string,
  ): boolean {
    if (!isWebsiteRuntimePermission(permission) || contents.isDestroyed())
      return false;
    const context = this.options.contextFor(contents);
    if (!context || !isEligible(permission, context)) return false;
    const origin = resolveWebsitePermissionOrigin(
      context.topLevelUrl,
      requestingUrl,
    );
    return Boolean(
      origin &&
      this.grants.has(grantKey(contents, context, origin, permission)),
    );
  }

  async request(
    contents: WebContents,
    permission: string,
    requestingUrl?: string,
  ): Promise<boolean> {
    if (!isWebsiteRuntimePermission(permission) || contents.isDestroyed())
      return false;
    const initialContext = this.options.contextFor(contents);
    if (!initialContext || !isEligible(permission, initialContext))
      return false;
    const origin = resolveWebsitePermissionOrigin(
      initialContext.topLevelUrl,
      requestingUrl,
    );
    if (!origin) return false;
    const invalidationVersion = this.invalidationVersions.get(contents.id) ?? 0;
    const initialGrantKey = grantKey(
      contents,
      initialContext,
      origin,
      permission,
    );
    if (this.grants.has(initialGrantKey)) return true;
    if (this.denials.has(initialGrantKey)) return false;

    const key = initialGrantKey;
    let decision = this.prompts.get(key);
    if (!decision) {
      decision = this.options.prompt({ permission, origin });
      this.prompts.set(key, decision);
    }
    let allowed = false;
    try {
      allowed = await decision;
    } finally {
      if (this.prompts.get(key) === decision) this.prompts.delete(key);
    }
    if (!allowed || contents.isDestroyed()) {
      if (!contents.isDestroyed()) this.denials.add(initialGrantKey);
      return false;
    }

    const currentContext = this.options.contextFor(contents);
    const currentOrigin = currentContext
      ? resolveWebsitePermissionOrigin(
          currentContext.topLevelUrl,
          requestingUrl,
        )
      : null;
    if (
      !currentContext ||
      !isEligible(permission, currentContext) ||
      currentOrigin !== origin ||
      currentContext.documentId !== initialContext.documentId ||
      (this.invalidationVersions.get(contents.id) ?? 0) !== invalidationVersion
    )
      return false;
    this.grants.add(initialGrantKey);
    return true;
  }

  clear(): void {
    this.grants.clear();
    this.denials.clear();
    this.prompts.clear();
    this.invalidationVersions.clear();
  }

  revoke(contents: WebContents): void {
    this.invalidationVersions.set(
      contents.id,
      (this.invalidationVersions.get(contents.id) ?? 0) + 1,
    );
    const prefix = `${contents.id}\n`;
    for (const key of this.grants) {
      if (key.startsWith(prefix)) this.grants.delete(key);
    }
    for (const key of this.denials) {
      if (key.startsWith(prefix)) this.denials.delete(key);
    }
    for (const key of this.prompts.keys()) {
      if (key.startsWith(prefix)) this.prompts.delete(key);
    }
  }
}

function isEligible(
  permission: WebsiteRuntimePermission,
  context: ActiveWebsitePermissionContext,
): boolean {
  return permission !== "keyboardLock" || context.websiteFullscreen;
}

function grantKey(
  contents: WebContents,
  context: ActiveWebsitePermissionContext,
  origin: string,
  permission: WebsiteRuntimePermission,
): string {
  return `${contents.id}\n${context.documentId}\n${origin}\n${permission}`;
}

function httpOrigin(value?: string): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "blob:") return httpOrigin(parsed.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function isOpaqueFrameUrl(value: string): boolean {
  if (value === "null") return true;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "about:" ||
      parsed.protocol === "data:" ||
      (parsed.protocol === "blob:" && parsed.origin === "null")
    );
  } catch {
    return false;
  }
}
