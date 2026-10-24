const MAX_FAVICON_BYTES = 1024 * 1024;
const MAX_FAVICON_DATA_URL_LENGTH =
  Math.ceil((MAX_FAVICON_BYTES * 4) / 3) + 256;

interface FaviconResponse {
  ok: boolean;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FaviconFetcher = (
  url: string,
  init: RequestInit,
) => Promise<FaviconResponse>;

export type BlobFaviconReader = (url: string) => Promise<string | null>;

const supportedImageMime =
  /^image\/(?:avif|bmp|gif|jpeg|png|svg\+xml|vnd\.microsoft\.icon|webp|x-icon)$/iu;

function cleanImageMime(value: string | null): string | null {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return supportedImageMime.test(mime) ? mime : null;
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8)
    return "image/jpeg";
  if (
    bytes.length >= 6 &&
    String.fromCharCode(...bytes.subarray(0, 6)).startsWith("GIF8")
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 1 &&
    bytes[3] === 0
  )
    return "image/x-icon";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d)
    return "image/bmp";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(4, 12)).includes("ftyp")
  )
    return "image/avif";
  const prefix = new TextDecoder()
    .decode(bytes.subarray(0, Math.min(bytes.length, 512)))
    .replace(/^\uFEFF/u, "")
    .trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(prefix))
    return "image/svg+xml";
  return null;
}

export function safeFaviconDataUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > MAX_FAVICON_DATA_URL_LENGTH
  )
    return null;
  const match = /^data:([^;,]+)(?:;[^,]*)?,/iu.exec(value);
  return match && cleanImageMime(match[1] ?? null) ? value : null;
}

async function fetchFavicon(
  url: string,
  pageUrl: string,
  fetcher: FaviconFetcher,
): Promise<string | null> {
  try {
    const response = await fetcher(url, {
      credentials: "include",
      referrer: pageUrl,
    });
    if (!response.ok) return null;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FAVICON_BYTES)
      return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 1 || bytes.length > MAX_FAVICON_BYTES) return null;
    const mime =
      cleanImageMime(response.headers.get("content-type")) ??
      sniffImageMime(bytes);
    if (!mime) return null;
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Resolves the URLs Chromium discovered for a page into one shell-safe image.
 * No hostname list or `/favicon.ico` guessing is involved: every standard page
 * favicon Chromium reports is eligible, including authenticated and blob icons.
 */
export async function resolveFaviconDataUrl(
  candidates: readonly string[],
  pageUrl: string,
  fetcher: FaviconFetcher,
  readBlob?: BlobFaviconReader,
): Promise<string | null> {
  for (const candidate of candidates) {
    const direct = safeFaviconDataUrl(candidate);
    if (direct) return direct;
    let url: URL;
    try {
      url = new URL(candidate, pageUrl);
    } catch {
      continue;
    }
    if (url.protocol === "blob:" && readBlob) {
      const blob = safeFaviconDataUrl(await readBlob(url.href));
      if (blob) return blob;
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const fetched = await fetchFavicon(url.href, pageUrl, fetcher);
    if (fetched) return fetched;
  }
  return null;
}

export const faviconLimits = {
  maxBytes: MAX_FAVICON_BYTES,
  maxDataUrlLength: MAX_FAVICON_DATA_URL_LENGTH,
} as const;
