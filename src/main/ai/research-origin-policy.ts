const RESTRICTED_HOSTS = new Set([
  "accounts.google.com",
  "myaccount.google.com",
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "login.live.com",
  "account.microsoft.com",
  "www.icloud.com",
]);

const RESTRICTED_TOKEN =
  /^(?:accounts?|admin|auth|authorize|bank|banking|billing|checkout|credentials?|identity|inbox|login|mail|myaccount|oauth|onlinebanking|passkeys?|password|payments?|secure|settings|signin|wallet|webmail)$/u;
const RESTRICTED_QUERY_KEY =
  /^(?:access_token|auth|authorization|code|credential|id_token|password|session|session_id|token)$/iu;

/**
 * Conservative main-process boundary for agent research. Public HTTP(S) pages
 * remain eligible, while obvious authentication, account, mail, payment, and
 * banking surfaces fail closed. This decision is never delegated to the model.
 */
export function isResearchEligibleUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!hostname || RESTRICTED_HOSTS.has(hostname)) return false;
  if (hostname.split(/[.\-_]/u).some((token) => RESTRICTED_TOKEN.test(token))) {
    return false;
  }

  const pathSegments = url.pathname
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .flatMap((segment) => {
      try {
        return decodeURIComponent(segment)
          .toLowerCase()
          .split(/[^a-z0-9]+/u);
      } catch {
        return segment.split(/[^a-z0-9]+/u);
      }
    });
  if (pathSegments.some((segment) => RESTRICTED_TOKEN.test(segment))) {
    return false;
  }
  for (const key of url.searchParams.keys()) {
    if (RESTRICTED_QUERY_KEY.test(key)) return false;
  }
  const fragment = url.hash
    .slice(1)
    .toLowerCase()
    .split(/[^a-z0-9]+/u);
  if (fragment.some((segment) => RESTRICTED_TOKEN.test(segment))) {
    return false;
  }
  return true;
}
