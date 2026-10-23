import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "electron";

import {
  parseOfflinePageUrl,
  registerOfflinePageProtocol,
} from "./offline-page-protocol";

type ProtocolHandler = (request: Request) => Promise<Response> | Response;

describe("offline page protocol", () => {
  let directory: string;
  let htmlPath: string;
  let handler: ProtocolHandler;
  const resolveResource =
    vi.fn<(id: string, relativePath: string) => Promise<string | null>>();

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(os.tmpdir(), "chromecraft-offline-protocol-"),
    );
    htmlPath = path.join(directory, "index.html");
    await writeFile(htmlPath, "<h1>Available offline</h1>");
    resolveResource.mockReset();
    resolveResource.mockResolvedValue(htmlPath);
    const browserSession = {
      protocol: {
        handle: vi.fn((_scheme: string, registered: ProtocolHandler) => {
          handler = registered;
        }),
      },
    } as unknown as Session;

    registerOfflinePageProtocol(browserSession, resolveResource);
    expect(browserSession.protocol.handle).toHaveBeenCalledWith(
      "chromecraft-offline",
      expect.any(Function),
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("serves an archived document with an offline-only security policy", async () => {
    const response = await handler(
      new Request("chromecraft-offline://archive-1/index.html"),
    );

    expect(resolveResource).toHaveBeenCalledWith("archive-1", "index.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'none'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain("Available offline");
  });

  it("handles HEAD without returning the resource body", async () => {
    const response = await handler(
      new Request("chromecraft-offline://archive-1/index.html", {
        method: "HEAD",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("26");
    expect(await response.text()).toBe("");
  });

  it("allows the trusted shell to embed only the archive thumbnail", async () => {
    const thumbnailPath = path.join(directory, "thumbnail.png");
    await writeFile(thumbnailPath, "png");
    resolveResource.mockResolvedValue(thumbnailPath);

    const response = await handler(
      new Request("chromecraft-offline://archive-1/thumbnail.png"),
    );

    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("rejects methods and malformed or traversal-like archive URLs", async () => {
    const post = await handler(
      new Request("chromecraft-offline://archive-1/index.html", {
        method: "POST",
      }),
    );
    expect(post.status).toBe(405);

    for (const value of [
      "chromecraft-offline://archive-1/..%2Findex.json",
      "chromecraft-offline://archive-1/folder%5Csecret.txt",
      "chromecraft-offline://UPPER/index.html",
      "chromecraft-offline://archive-1/index.html?file=outside",
    ]) {
      const response = await handler(new Request(value));
      expect(response.status, value).toBe(404);
    }
    expect(resolveResource).not.toHaveBeenCalled();
  });

  it("parses nested resources without accepting encoded separators", () => {
    expect(
      parseOfflinePageUrl(
        "chromecraft-offline://archive-1/index_files/styles/site.css",
      ),
    ).toEqual({
      entryId: "archive-1",
      relativePath: "index_files/styles/site.css",
    });
    expect(
      parseOfflinePageUrl(
        "chromecraft-offline://archive-1/index_files%2Fstyles.css",
      ),
    ).toBeNull();
  });
});
