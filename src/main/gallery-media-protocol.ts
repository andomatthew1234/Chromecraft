import { open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import type { Session } from "electron";

const MEDIA_SCHEME = "chromecraft-media";
const MEDIA_HOST = "video";
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const VIDEO_MIME_TYPES = new Map<string, string>([
  [".m4v", "video/x-m4v"],
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
]);

export type GalleryMediaPathResolver = (
  entryId: string,
) => string | null | undefined | Promise<string | null | undefined>;

type ParsedRange =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "range"; start: number; end: number };

function errorResponse(status: number, message: string, headers?: HeadersInit) {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function parseEntryId(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl);
    if (
      url.protocol !== `${MEDIA_SCHEME}:` ||
      url.hostname !== MEDIA_HOST ||
      url.username ||
      url.password ||
      url.port ||
      url.search
    ) {
      return null;
    }

    const encodedId = url.pathname.slice(1);
    if (!encodedId || encodedId.includes("/")) {
      return null;
    }

    const entryId = decodeURIComponent(encodedId);
    return OPAQUE_ID_PATTERN.test(entryId) ? entryId : null;
  } catch {
    return null;
  }
}

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseRangeHeader(value: string | null, size: number): ParsedRange {
  if (value === null) {
    return { kind: "none" };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) {
    return { kind: "invalid" };
  }

  if (!match[1]) {
    const suffixLength = parseNonNegativeInteger(match[2]);
    if (suffixLength === null || suffixLength === 0) {
      return { kind: "invalid" };
    }
    return {
      kind: "range",
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = parseNonNegativeInteger(match[1]);
  const requestedEnd = match[2] ? parseNonNegativeInteger(match[2]) : size - 1;
  if (
    start === null ||
    requestedEnd === null ||
    start >= size ||
    requestedEnd < start
  ) {
    return { kind: "invalid" };
  }

  return {
    kind: "range",
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}

/**
 * Serves downloaded gallery videos without ever exposing their filesystem path
 * in a renderer-visible URL. URLs have the form chromecraft-media://video/<id>.
 */
export function registerGalleryMediaProtocol(
  browserSession: Session,
  resolveEntryPathById: GalleryMediaPathResolver,
): void {
  browserSession.protocol.handle(MEDIA_SCHEME, async (request) => {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return errorResponse(405, "Method not allowed", { allow: "GET, HEAD" });
    }

    const entryId = parseEntryId(request.url);
    if (!entryId) {
      return errorResponse(404, "Media not found");
    }

    let resolvedPath: string | null | undefined;
    try {
      resolvedPath = await resolveEntryPathById(entryId);
    } catch {
      return errorResponse(404, "Media not found");
    }

    if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
      return errorResponse(404, "Media not found");
    }

    const contentType = VIDEO_MIME_TYPES.get(
      path.extname(resolvedPath).toLowerCase(),
    );
    if (!contentType) {
      return errorResponse(415, "Unsupported media type");
    }

    let fileHandle;
    try {
      fileHandle = await open(resolvedPath, "r");
      const stats = await fileHandle.stat();
      if (!stats.isFile()) {
        await fileHandle.close();
        return errorResponse(404, "Media not found");
      }

      const parsedRange = parseRangeHeader(
        request.headers.get("range"),
        stats.size,
      );
      if (parsedRange.kind === "invalid") {
        await fileHandle.close();
        return errorResponse(416, "Range not satisfiable", {
          "accept-ranges": "bytes",
          "content-range": `bytes */${stats.size}`,
        });
      }

      const isPartial = parsedRange.kind === "range";
      const start = isPartial ? parsedRange.start : 0;
      const end = isPartial ? parsedRange.end : Math.max(stats.size - 1, 0);
      const contentLength = isPartial ? end - start + 1 : stats.size;
      const headers: Record<string, string> = {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-length": String(contentLength),
        "content-type": contentType,
        "x-content-type-options": "nosniff",
      };
      if (isPartial) {
        headers["content-range"] = `bytes ${start}-${end}/${stats.size}`;
      }

      if (method === "HEAD") {
        await fileHandle.close();
        return new Response(null, {
          status: isPartial ? 206 : 200,
          headers,
        });
      }

      const nodeStream = fileHandle.createReadStream(
        stats.size === 0 ? undefined : { start, end, autoClose: true },
      );
      const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      return new Response(body, {
        status: isPartial ? 206 : 200,
        headers,
      });
    } catch {
      await fileHandle?.close().catch(() => undefined);
      return errorResponse(404, "Media not found");
    }
  });
}
