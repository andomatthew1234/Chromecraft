const CHROME_WEB_STORE_ORIGIN = "https://chromewebstore.google.com";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export interface ChromeWebStoreListing {
  extensionId: string;
  canonicalUrl: string;
}

export function parseChromeWebStoreListingUrl(
  value: string,
): ChromeWebStoreListing | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "chromewebstore.google.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return null;
  }

  const segments = url.pathname.split("/");
  if (segments[0] === "") segments.shift();
  if (segments.at(-1) === "") segments.pop();
  if (
    segments.length < 2 ||
    segments[0] !== "detail" ||
    segments.some((segment) => segment === "")
  ) {
    return null;
  }

  const extensionId = segments.at(-1) ?? "";
  if (!EXTENSION_ID_PATTERN.test(extensionId)) return null;

  return {
    extensionId,
    canonicalUrl: `${CHROME_WEB_STORE_ORIGIN}/detail/${extensionId}`,
  };
}
