import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalWebOrigin, WebsiteControlsService } from "./website-controls";

describe("WebsiteControlsService", () => {
  let directory: string;
  let beforeRequest:
    | ((
        details: Electron.OnBeforeRequestListenerDetails,
        callback: (response: Electron.CallbackResponse) => void,
      ) => void)
    | null;
  let headersReceived:
    | ((
        details: Electron.OnHeadersReceivedListenerDetails,
        callback: (response: Electron.HeadersReceivedResponse) => void,
      ) => void)
    | null;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "chromecraft-controls-"),
    );
    beforeRequest = null;
    headersReceived = null;
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  function createSession() {
    return {
      cookies: { get: vi.fn().mockResolvedValue([]) },
      clearData: vi.fn().mockResolvedValue(undefined),
      clearAuthCache: vi.fn().mockResolvedValue(undefined),
      clearHostResolverCache: vi.fn().mockResolvedValue(undefined),
      closeAllConnections: vi.fn().mockResolvedValue(undefined),
      webRequest: {
        onBeforeRequest: vi.fn(
          (
            _filter: Electron.WebRequestFilter,
            listener: typeof beforeRequest,
          ) => {
            beforeRequest = listener;
          },
        ),
        onHeadersReceived: vi.fn(
          (
            _filter: Electron.WebRequestFilter,
            listener: typeof headersReceived,
          ) => {
            headersReceived = listener;
          },
        ),
      },
    };
  }

  function createService(
    browserSession: ReturnType<typeof createSession>,
    prompt = vi.fn().mockResolvedValue("allow-once" as const),
  ) {
    const applySecureDns = vi.fn();
    const service = new WebsiteControlsService(
      browserSession as unknown as Electron.Session,
      {
        filePath: path.join(directory, "website-controls.json"),
        prompt,
        applySecureDns,
      },
    );
    return { service, applySecureDns };
  }

  it("canonicalises HTTP(S) origins and rejects browser-internal schemes", () => {
    expect(canonicalWebOrigin("https://Example.com:443/path?q=1")).toBe(
      "https://example.com",
    );
    expect(canonicalWebOrigin("http://example.com:8080/a")).toBe(
      "http://example.com:8080",
    );
    expect(canonicalWebOrigin("blob:https://example.com/id")).toBe(
      "https://example.com",
    );
    expect(canonicalWebOrigin("file:///private/file")).toBeNull();
    expect(canonicalWebOrigin("chromecraft://settings/")).toBeNull();
  });

  it("persists only customised decisions and restores secure DNS", async () => {
    const firstSession = createSession();
    const first = createService(firstSession);
    await first.service.initialize();
    expect(first.applySecureDns).toHaveBeenCalledWith("automatic", null);

    await first.service.setDecision(
      "https://example.com/path",
      "camera",
      "block",
    );
    await first.service.setSecureDns("secure", "https://dns.example/dns-query");
    expect((await first.service.snapshot()).sites[0].decisions.camera).toBe(
      "block",
    );

    const secondSession = createSession();
    const second = createService(secondSession);
    await second.service.initialize();
    expect(second.applySecureDns).toHaveBeenCalledWith(
      "secure",
      "https://dns.example/dns-query",
    );
    expect(
      (await second.service.siteSnapshot("https://example.com")).decisions
        .camera,
    ).toBe("block");
  });

  it("uses saved and document-scoped permission decisions", async () => {
    const browserSession = createSession();
    const prompt = vi.fn().mockResolvedValue("allow-once" as const);
    const { service } = createService(browserSession, prompt);
    await service.initialize();
    const contents = {
      id: 12,
      isDestroyed: () => false,
      getURL: () => "https://meet.example/room",
    } as Electron.WebContents;
    const details = {
      isMainFrame: true,
      requestingUrl: "https://meet.example/room",
      securityOrigin: "https://meet.example",
      mediaTypes: ["video"],
    } as Electron.MediaAccessPermissionRequest;

    await expect(
      service.requestPermission(contents, "media", details),
    ).resolves.toBe(true);
    expect(
      service.checkPermission(contents, "media", "https://meet.example", {
        isMainFrame: true,
        mediaType: "video",
      }),
    ).toBe(true);
    service.revoke(contents);
    expect(
      service.checkPermission(contents, "media", "https://meet.example", {
        isMainFrame: true,
        mediaType: "video",
      }),
    ).toBe(false);

    await service.setDecision("https://meet.example", "camera", "allow");
    expect(
      service.checkPermission(contents, "media", "https://meet.example", {
        isMainFrame: true,
        mediaType: "video",
      }),
    ).toBe(true);
  });

  it("blocks network and script requests without blocking unrelated sites", async () => {
    const browserSession = createSession();
    const { service } = createService(browserSession);
    await service.initialize();
    await service.setDecision("https://offline.example", "network", "block");
    await service.setDecision("https://quiet.example", "javascript", "block");

    const decide = (
      details: Partial<Electron.OnBeforeRequestListenerDetails>,
    ) => {
      let result: Electron.CallbackResponse | undefined;
      beforeRequest?.(
        {
          id: 1,
          url: "https://cdn.example/item",
          method: "GET",
          resourceType: "image",
          referrer: "",
          timestamp: Date.now(),
          uploadData: [],
          ...details,
        },
        (response) => {
          result = response;
        },
      );
      return result;
    };

    expect(decide({ initiatorOrigin: "https://offline.example" })).toEqual({
      cancel: true,
    });
    expect(
      decide({
        initiatorOrigin: "https://quiet.example",
        resourceType: "script",
      }),
    ).toEqual({ cancel: true });
    expect(decide({ initiatorOrigin: "https://ordinary.example" })).toEqual({
      cancel: false,
    });

    let response: Electron.HeadersReceivedResponse | undefined;
    headersReceived?.(
      {
        id: 2,
        url: "https://quiet.example/page",
        method: "GET",
        resourceType: "mainFrame",
        referrer: "",
        timestamp: Date.now(),
        statusLine: "HTTP/1.1 200 OK",
        statusCode: 200,
        responseHeaders: { "Content-Type": ["text/html"] },
      },
      (value) => {
        response = value;
      },
    );
    expect(response?.responseHeaders?.["Content-Security-Policy"]).toContain(
      "script-src 'none'; worker-src 'none'",
    );
  });

  it("rejects insecure custom DNS providers", async () => {
    const browserSession = createSession();
    const { service } = createService(browserSession);
    await service.initialize();
    await expect(
      service.setSecureDns("secure", "http://dns.example/dns-query"),
    ).rejects.toThrow(/HTTPS/);
    await expect(service.setSecureDns("secure", "")).rejects.toThrow(
      /requires/,
    );
  });

  it("clears only the requested canonical origin", async () => {
    const browserSession = createSession();
    const { service } = createService(browserSession);
    await service.initialize();
    await service.clearSiteData("https://example.com/private/path");

    expect(browserSession.clearData).toHaveBeenCalledWith(
      expect.objectContaining({
        origins: ["https://example.com"],
        originMatchingMode: "origin-in-all-contexts",
      }),
    );
    expect(browserSession.clearAuthCache).not.toHaveBeenCalled();
    expect(browserSession.closeAllConnections).not.toHaveBeenCalled();
  });
});
