import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "electron";

import { registerGalleryMediaProtocol } from "./gallery-media-protocol";

type ProtocolHandler = (request: Request) => Promise<Response> | Response;

describe("registerGalleryMediaProtocol", () => {
  let directory: string;
  let mediaPath: string;
  let handler: ProtocolHandler;
  const resolveEntryPathById = vi.fn<(id: string) => Promise<string | null>>();

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "chromecraft-media-"));
    mediaPath = path.join(directory, "sample.mp4");
    await writeFile(mediaPath, Buffer.from("0123456789"));
    resolveEntryPathById.mockReset();
    resolveEntryPathById.mockResolvedValue(mediaPath);

    const browserSession = {
      protocol: {
        handle: vi.fn((_scheme: string, registered: ProtocolHandler) => {
          handler = registered;
        }),
      },
    } as unknown as Session;
    registerGalleryMediaProtocol(browserSession, resolveEntryPathById);
    expect(browserSession.protocol.handle).toHaveBeenCalledWith(
      "chromecraft-media",
      expect.any(Function),
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("streams a video by opaque entry id", async () => {
    const response = await handler(
      new Request("chromecraft-media://video/entry_123"),
    );

    expect(resolveEntryPathById).toHaveBeenCalledWith("video", "entry_123");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("0123456789");
  });

  it("serves an original thumbnail only through the thumbnail resource kind", async () => {
    const thumbnailPath = path.join(directory, "sample.webp");
    await writeFile(thumbnailPath, Buffer.from("thumbnail"));
    resolveEntryPathById.mockResolvedValue(thumbnailPath);

    const response = await handler(
      new Request("chromecraft-media://thumbnail/entry_123"),
    );

    expect(resolveEntryPathById).toHaveBeenCalledWith("thumbnail", "entry_123");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(await response.text()).toBe("thumbnail");
  });

  it("handles HEAD without reading a response body", async () => {
    const response = await handler(
      new Request("chromecraft-media://video/entry_123", {
        method: "HEAD",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("");
  });

  it.each([
    ["bytes=2-5", 206, "bytes 2-5/10", "2345"],
    ["bytes=7-", 206, "bytes 7-9/10", "789"],
    ["bytes=-3", 206, "bytes 7-9/10", "789"],
    ["bytes=8-99", 206, "bytes 8-9/10", "89"],
  ])(
    "serves a bounded range for %s",
    async (range, status, contentRange, body) => {
      const response = await handler(
        new Request("chromecraft-media://video/entry_123", {
          headers: { range },
        }),
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(response.headers.get("content-length")).toBe(String(body.length));
      expect(await response.text()).toBe(body);
    },
  );

  it.each(["bytes=10-", "bytes=5-4", "bytes=-0", "bytes=0-1,4-5"])(
    "rejects an invalid or unsupported range: %s",
    async (range) => {
      const response = await handler(
        new Request("chromecraft-media://video/entry_123", {
          headers: { range },
        }),
      );

      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
    },
  );

  it("rejects non-read methods before resolving media", async () => {
    const response = await handler(
      new Request("chromecraft-media://video/entry_123", { method: "POST" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(resolveEntryPathById).not.toHaveBeenCalled();
  });

  it.each([
    "chromecraft-media://video/C:/Users/person/video.mp4",
    "chromecraft-media://video/..%2Fsecret",
    "chromecraft-media://other/entry_123",
    "chromecraft-media://video/entry_123?path=C%3A%5Cvideo.mp4",
  ])("does not accept a raw path or malformed media URL: %s", async (url) => {
    const response = await handler(new Request(url));

    expect(response.status).toBe(404);
    expect(resolveEntryPathById).not.toHaveBeenCalled();
  });

  it("rejects a resolved file outside the video MIME allowlist", async () => {
    const htmlPath = path.join(directory, "unsafe.html");
    await writeFile(htmlPath, "<script>alert(1)</script>");
    resolveEntryPathById.mockResolvedValue(htmlPath);

    const response = await handler(
      new Request("chromecraft-media://video/entry_123"),
    );

    expect(response.status).toBe(415);
    expect(await response.text()).toBe("Unsupported media type");
  });
});
