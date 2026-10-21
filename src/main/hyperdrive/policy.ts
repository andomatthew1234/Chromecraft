import type { PreparationTier } from "./model";
import { isIP } from "node:net";

export type EligibilityReason =
  | "eligible"
  | "invalid-url"
  | "unsupported-scheme"
  | "insecure-downgrade"
  | "credentials-in-url"
  | "private-network"
  | "same-document"
  | "cross-site-disabled"
  | "site-disabled"
  | "sensitive-domain"
  | "sensitive-path"
  | "sensitive-query"
  | "download-like-url";

export interface HyperdrivePolicyOptions {
  allowCrossSite?: boolean;
  allowSensitiveSites?: boolean;
  allowPrivateNetworks?: boolean;
  disabledHosts?: readonly string[];
}

export interface EligibilityDecision {
  eligible: boolean;
  reason: EligibilityReason;
  maxTier: PreparationTier;
  sameOrigin: boolean;
  sameSite: boolean;
  sensitive: boolean;
  url?: URL;
}

const SENSITIVE_HOST_PATTERNS = [
  /(^|\.)accounts\./iu,
  /(^|\.)login\./iu,
  /(^|\.)auth\./iu,
  /(^|\.)paypal\.com$/iu,
  /(^|\.)stripe\.com$/iu,
];

const SENSITIVE_PATH_SEGMENTS = new Set([
  "account",
  "auth",
  "billing",
  "checkout",
  "invite",
  "login",
  "oauth",
  "password",
  "payment",
  "payments",
  "purchase",
  "reset",
  "subscribe",
  "signin",
]);

const STATE_CHANGING_PATH_SEGMENTS = new Set([
  "delete",
  "logout",
  "admin",
  "signout",
  "transfer",
]);

const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "auth",
  "code",
  "password",
  "payment",
  "session",
  "token",
]);

const STATE_CHANGING_QUERY_TERMS = /(?:delete|logout|signout|transfer)/iu;

const DOWNLOAD_EXTENSIONS =
  /\.(?:7z|apk|appimage|deb|dmg|exe|iso|msi|pkg|rar|rpm|tar|zip)(?:$|[?#])/iu;

function canonicalHost(hostname: string): string {
  return hostname.toLocaleLowerCase().replace(/^www\./u, "");
}

function isPrivateNetworkHost(hostname: string): boolean {
  const host = canonicalHost(hostname).replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  const version = isIP(host);
  if (version === 6) return true;
  if (version !== 4) return false;
  const octets = host.split(".").map(Number);
  return (
    octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] >= 224
  );
}

/**
 * A conservative site comparison. It intentionally does not guess at public suffixes;
 * an exact host (ignoring www) is safer than accidentally treating two co.uk hosts as
 * the same privacy boundary.
 */
function isSameSite(current: URL, target: URL): boolean {
  return canonicalHost(current.hostname) === canonicalHost(target.hostname);
}

function isDisabled(
  hostname: string,
  disabledHosts: readonly string[],
): boolean {
  const host = canonicalHost(hostname);
  return disabledHosts.some((entry) => {
    const disabled = canonicalHost(entry.trim());
    return (
      disabled.length > 0 &&
      (host === disabled || host.endsWith(`.${disabled}`))
    );
  });
}

function hasSensitivePath(url: URL): boolean {
  const segments = url.pathname.toLocaleLowerCase().split("/").filter(Boolean);

  if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment)))
    return true;

  // ChatGPT conversation identifiers are private user content. Public share pages are
  // also excluded by default because their sensitivity cannot be inferred safely.
  const host = canonicalHost(url.hostname);
  return (
    (host === "chatgpt.com" || host === "chat.openai.com") &&
    (segments[0] === "c" || segments[0] === "g" || segments[0] === "share")
  );
}

function hasStateChangingPath(url: URL): boolean {
  return url.pathname
    .toLocaleLowerCase()
    .split("/")
    .filter(Boolean)
    .some((segment) => STATE_CHANGING_PATH_SEGMENTS.has(segment));
}

function hasSensitiveQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLocaleLowerCase())) return true;
  }
  return false;
}

function hasStateChangingQuery(url: URL): boolean {
  for (const [key, value] of url.searchParams) {
    const lowerKey = key.toLocaleLowerCase();
    if (
      STATE_CHANGING_QUERY_TERMS.test(lowerKey) ||
      ((lowerKey === "action" || lowerKey === "intent") &&
        STATE_CHANGING_QUERY_TERMS.test(value))
    )
      return true;
  }
  return false;
}

function decision(
  reason: EligibilityReason,
  details: Pick<EligibilityDecision, "sameOrigin" | "sameSite" | "sensitive">,
  url?: URL,
): EligibilityDecision {
  return {
    eligible: reason === "eligible",
    reason,
    maxTier: reason === "eligible" ? "prefetch" : "none",
    ...details,
    url,
  };
}

export function evaluateSpeculationEligibility(
  currentUrl: string,
  targetUrl: string,
  options: HyperdrivePolicyOptions = {},
): EligibilityDecision {
  let current: URL;
  let target: URL;
  try {
    current = new URL(currentUrl);
    target = new URL(targetUrl, current);
  } catch {
    return decision("invalid-url", {
      sameOrigin: false,
      sameSite: false,
      sensitive: false,
    });
  }

  const sameOrigin = current.origin === target.origin;
  const sameSite = isSameSite(current, target);
  const details = { sameOrigin, sameSite, sensitive: false };

  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return decision("unsupported-scheme", details, target);
  }
  if (current.protocol === "https:" && target.protocol === "http:") {
    return decision("insecure-downgrade", details, target);
  }
  if (target.username || target.password) {
    return decision(
      "credentials-in-url",
      { ...details, sensitive: true },
      target,
    );
  }
  if (isPrivateNetworkHost(target.hostname) && !options.allowPrivateNetworks) {
    return decision("private-network", { ...details, sensitive: true }, target);
  }

  const comparableCurrent = new URL(current.href);
  const comparableTarget = new URL(target.href);
  comparableCurrent.hash = "";
  comparableTarget.hash = "";
  if (comparableCurrent.href === comparableTarget.href) {
    return decision("same-document", details, target);
  }

  if (isDisabled(target.hostname, options.disabledHosts ?? [])) {
    return decision("site-disabled", details, target);
  }
  if (!options.allowCrossSite && !sameSite) {
    return decision("cross-site-disabled", details, target);
  }

  const sensitiveHost = SENSITIVE_HOST_PATTERNS.some((pattern) =>
    pattern.test(target.hostname),
  );
  if (sensitiveHost && !options.allowSensitiveSites) {
    return decision(
      "sensitive-domain",
      { ...details, sensitive: true },
      target,
    );
  }
  // A GET endpoint such as /logout can mutate account state. It stays blocked even
  // when a user permits otherwise sensitive sites.
  if (hasStateChangingPath(target)) {
    return decision("sensitive-path", { ...details, sensitive: true }, target);
  }
  if (hasStateChangingQuery(target)) {
    return decision("sensitive-query", { ...details, sensitive: true }, target);
  }
  if (hasSensitivePath(target) && !options.allowSensitiveSites) {
    return decision("sensitive-path", { ...details, sensitive: true }, target);
  }
  if (hasSensitiveQuery(target) && !options.allowSensitiveSites) {
    return decision("sensitive-query", { ...details, sensitive: true }, target);
  }
  if (DOWNLOAD_EXTENSIONS.test(target.href)) {
    return decision("download-like-url", details, target);
  }

  return decision("eligible", details, target);
}
