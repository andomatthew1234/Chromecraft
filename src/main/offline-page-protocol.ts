import { open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import type { Session } from "electron";

const SCHEME = "chromecraft-offline";
const ENTRY_ID_PATTERN = /^[a-z0-9_-]{1,128}$/u;
const DOCUMENT_CSP = [
  "default-src 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const MIME_TYPES = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".ogv", "video/ogg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

export type OfflinePageResourceResolver = (
  entryId: string,
  relativePath: string,
) => string | null | Promise<string | null>;

export interface ParsedOfflinePageUrl {
  entryId: string;
  relativePath: string;
}

export function parseOfflinePageUrl(
  value: string,
): ParsedOfflinePageUrl | null {
  try {
    if (/%(?:2f|5c)/iu.test(value)) return null;
    const url = new URL(value);
    if (
      url.protocol !== `${SCHEME}:` ||
      !ENTRY_ID_PATTERN.test(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const relativePath = decodeURIComponent(url.pathname.slice(1));
    if (
      !relativePath ||
      relativePath.includes("\0") ||
      relativePath.includes("\\") ||
      relativePath.split("/").some((segment) => segment === "..")
    ) {
      return null;
    }
    return { entryId: url.hostname, relativePath };
  } catch {
    return null;
  }
}

function errorResponse(status: number, message: string, headers?: HeadersInit) {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/plain; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

/** Serves one browser-owned static page archive per isolated local origin. */
export function registerOfflinePageProtocol(
  browserSession: Session,
  resolveResource: OfflinePageResourceResolver,
): void {
  browserSession.protocol.handle(SCHEME, async (request) => {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return errorResponse(405, "Method not allowed", { allow: "GET, HEAD" });
    }
    const parsed = parseOfflinePageUrl(request.url);
    if (!parsed) return errorResponse(404, "Offline page not found");

    const resolvedPath = await Promise.resolve(
      resolveResource(parsed.entryId, parsed.relativePath),
    ).catch(() => null);
    if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
      return errorResponse(404, "Offline page not found");
    }

    let fileHandle;
    try {
      fileHandle = await open(resolvedPath, "r");
      const stats = await fileHandle.stat();
      if (!stats.isFile()) {
        await fileHandle.close();
        return errorResponse(404, "Offline page not found");
      }
      const extension = path.extname(resolvedPath).toLowerCase();
      const isDocument = extension === ".html" || extension === ".htm";
      const isThumbnail = parsed.relativePath === "thumbnail.png";
      const headers: Record<string, string> = {
        "cache-control": "private, no-store",
        "content-length": String(stats.size),
        "content-security-policy": DOCUMENT_CSP,
        "content-type": MIME_TYPES.get(extension) ?? "application/octet-stream",
        "cross-origin-resource-policy": isThumbnail
          ? "cross-origin"
          : "same-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      };
      if (isDocument) headers["x-frame-options"] = "DENY";
      if (method === "HEAD") {
        await fileHandle.close();
        return new Response(null, { status: 200, headers });
      }
      const body = Readable.toWeb(
        fileHandle.createReadStream({ autoClose: true }),
      ) as ReadableStream<Uint8Array>;
      return new Response(body, { status: 200, headers });
    } catch {
      await fileHandle?.close().catch(() => undefined);
      return errorResponse(404, "Offline page not found");
    }
  });
}
