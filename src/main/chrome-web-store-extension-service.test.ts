import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import type { Extension, Session } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChromeWebStoreExtensionService,
  compareExtensionVersions,
} from "./chrome-web-store-extension-service";

const temporaryDirectories: string[] = [];

function trustedResponse(
  body?: BodyInit | null,
  init?: ResponseInit,
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", {
    configurable: true,
    value: "https://clients2.googleusercontent.com/crx/fixture",
  });
  return response;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("ChromeWebStoreExtensionService", () => {
  it("uses the process fetch implementation when no transport is injected", async () => {
    const fixture = createCrxFixture();
    const runtime = createSessionDouble(fixture.id);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(trustedResponse(new Uint8Array(fixture.crx)));
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath: await makeTemporaryDirectory(),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    try {
      await expect(
        service.installFromWebStoreUrl(
          `https://chromewebstore.google.com/detail/${fixture.id}`,
        ),
      ).resolves.toEqual(expect.objectContaining({ id: fixture.id }));
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("compares Chrome extension versions numerically", () => {
    expect(compareExtensionVersions("1.10", "1.2.9")).toBe(1);
    expect(compareExtensionVersions("2", "2.0.0.0")).toBe(0);
    expect(compareExtensionVersions("3.0.0", "4")).toBe(-1);
  });

  it("reports an installed extension as up to date without reloading it", async () => {
    const fixture = createCrxFixture();
    const runtime = createSessionDouble(fixture.id);
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath: await makeTemporaryDirectory(),
      fetch: async () => trustedResponse(new Uint8Array(fixture.crx)),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();
    await service.installFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${fixture.id}`,
    );
    runtime.loadExtension.mockClear();

    await expect(service.checkAndInstallUpdates()).resolves.toEqual([
      expect.objectContaining({
        id: fixture.id,
        fromVersion: "1.0.0",
        toVersion: "1.0.0",
        state: "up-to-date",
      }),
    ]);
    expect(runtime.loadExtension).not.toHaveBeenCalled();
  });

  it("reports unpacked extensions as locally managed during update checks", async () => {
    const fixture = createCrxFixture();
    const sourcePath = await makeTemporaryDirectory();
    await fs.writeFile(
      path.join(sourcePath, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Local extension",
        version: "1.0.0",
        key: fixture.publicKeyBase64,
        background: { service_worker: "background.js" },
      }),
    );
    await fs.writeFile(path.join(sourcePath, "background.js"), "// local\n");
    const runtime = createSessionDouble(fixture.id);
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath: await makeTemporaryDirectory(),
      fetch: vi.fn(),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();
    await service.importUnpacked(sourcePath);

    await expect(service.checkAndInstallUpdates()).resolves.toEqual([
      expect.objectContaining({
        id: fixture.id,
        state: "unavailable",
        detail: expect.stringMatching(/manual update|required|re-import/i),
      }),
    ]);
  });

  it("installs a verified extension update while preserving its disabled state", async () => {
    const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const initial = createCrxFixture({
      signingKeys,
      manifest: { version: "1.0.0", permissions: ["storage"] },
    });
    const update = createCrxFixture({
      signingKeys,
      manifest: { version: "1.1.0", permissions: ["storage"] },
    });
    const runtime = createSessionDouble(initial.id);
    let response = initial.crx;
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath: await makeTemporaryDirectory(),
      fetch: async () => trustedResponse(new Uint8Array(response)),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();
    await service.installFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${initial.id}`,
    );
    await service.setEnabled(initial.id, false);
    runtime.loadExtension.mockClear();
    response = update.crx;

    await expect(service.checkAndInstallUpdates()).resolves.toEqual([
      expect.objectContaining({
        id: initial.id,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        state: "installed",
      }),
    ]);
    await expect(service.listInstalled()).resolves.toEqual([
      expect.objectContaining({
        id: initial.id,
        version: "1.1.0",
        enabled: false,
        ready: false,
      }),
    ]);
    expect(runtime.loadExtension).not.toHaveBeenCalled();
  });

  it("requires review instead of installing an update with new access", async () => {
    const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const initial = createCrxFixture({
      signingKeys,
      manifest: { version: "1.0.0", permissions: ["storage"] },
    });
    const update = createCrxFixture({
      signingKeys,
      manifest: {
        version: "2.0.0",
        permissions: ["storage"],
        content_scripts: [
          {
            matches: ["https://sensitive.example/*"],
            js: ["content.js"],
          },
        ],
      },
      extraFiles: { "content.js": "globalThis.newHostAccess = true;\n" },
    });
    const runtime = createSessionDouble(initial.id);
    let response = initial.crx;
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath: await makeTemporaryDirectory(),
      fetch: async () => trustedResponse(new Uint8Array(response)),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();
    await service.installFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${initial.id}`,
    );
    runtime.loadExtension.mockClear();
    response = update.crx;

    await expect(service.checkAndInstallUpdates()).resolves.toEqual([
      expect.objectContaining({
        id: initial.id,
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        state: "approval-required",
        detail: expect.stringContaining("https://sensitive.example/*"),
      }),
    ]);
    await expect(service.listInstalled()).resolves.toEqual([
      expect.objectContaining({ version: "1.0.0" }),
    ]);
    expect(runtime.loadExtension).not.toHaveBeenCalled();
  });

  it("restores the previous live runtime when registry persistence fails", async () => {
    const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const initial = createCrxFixture({
      signingKeys,
      manifest: { version: "1.0.0" },
    });
    const update = createCrxFixture({
      signingKeys,
      manifest: { version: "2.0.0" },
    });
    const storagePath = await makeTemporaryDirectory();
    const registryPath = path.join(storagePath, "installed-extensions.json");
    const runtime = createSessionDouble(initial.id);
    let response = initial.crx;
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: async () => trustedResponse(new Uint8Array(response)),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();
    await service.installFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${initial.id}`,
    );
    response = update.crx;
    const preview = await service.prepareFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${initial.id}`,
    );
    const rename = fs.rename.bind(fs);
    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockImplementation(async (source, destination) => {
        if (path.resolve(String(destination)) === path.resolve(registryPath)) {
          throw new Error("registry persistence failed");
        }
        await rename(source, destination);
      });

    await expect(
      service.commitPreparedExtension(preview.token),
    ).rejects.toThrow(/registry persistence failed/i);
    renameSpy.mockRestore();

    await expect(service.listInstalled()).resolves.toEqual([
      expect.objectContaining({ version: "1.0.0", ready: true }),
    ]);
    expect(runtime.loadExtension).toHaveBeenCalledTimes(3);
    expect(runtime.session.extensions.getAllExtensions()).toEqual([
      expect.objectContaining({ version: "1.0.0" }),
    ]);
    await expect(
      fs.access(path.join(storagePath, initial.id, "2.0.0")),
    ).rejects.toThrow();
  });

  it("replaces a pre-existing version directory with verified package bytes", async () => {
    const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const initial = createCrxFixture({
      signingKeys,
      manifest: { version: "1.0.0" },
    });
    const update = createCrxFixture({
      signingKeys,
      manifest: { version: "2.0.0" },
      extraFiles: { "payload.txt": "verified package\n" },
    });
    const storagePath = await makeTemporaryDirectory();
    const runtime = createSessionDouble(initial.id);
    let response = initial.crx;
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: async () => trustedResponse(new Uint8Array(response)),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();
    await service.installFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${initial.id}`,
    );
    const staleDestination = path.join(storagePath, initial.id, "2.0.0");
    await fs.mkdir(staleDestination, { recursive: true });
    await fs.writeFile(path.join(staleDestination, "payload.txt"), "stale\n");
    await fs.writeFile(
      path.join(staleDestination, "stale-only.txt"),
      "stale\n",
    );
    response = update.crx;

    await expect(service.checkAndInstallUpdates()).resolves.toEqual([
      expect.objectContaining({ state: "installed", toVersion: "2.0.0" }),
    ]);
    await expect(
      fs.readFile(path.join(staleDestination, "payload.txt"), "utf8"),
    ).resolves.toBe("verified package\n");
    await expect(
      fs.access(path.join(staleDestination, "stale-only.txt")),
    ).rejects.toThrow();
  });

  it("rejects a Web Store downgrade before replacing package bytes", async () => {
    const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const current = createCrxFixture({
      signingKeys,
      manifest: { version: "2.0.0" },
    });
    const downgrade = createCrxFixture({
      signingKeys,
      manifest: { version: "1.0.0" },
    });
    const storagePath = await makeTemporaryDirectory();
    let response = current.crx;
    const service = new ChromeWebStoreExtensionService(
      createSessionDouble(current.id).session,
      {
        storagePath,
        fetch: async () => trustedResponse(new Uint8Array(response)),
        chromiumVersion: "152.0.0.0",
      },
    );
    await service.initialize();
    await service.installFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${current.id}`,
    );
    response = downgrade.crx;
    const preview = await service.prepareFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${current.id}`,
    );

    await expect(
      service.commitPreparedExtension(preview.token),
    ).rejects.toThrow(/cannot be downgraded/i);
    await expect(service.listInstalled()).resolves.toEqual([
      expect.objectContaining({ version: "2.0.0", ready: true }),
    ]);
    await expect(
      fs.access(path.join(storagePath, current.id, "1.0.0")),
    ).rejects.toThrow();
  });

  it("rejects an untrusted redirect before requesting its destination", async () => {
    const fixture = createCrxFixture();
    const fetchExtension = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        trustedResponse(null, {
          status: 302,
          headers: { location: "https://downloads.example/crx" },
        }),
    );
    const service = new ChromeWebStoreExtensionService(
      createSessionDouble(fixture.id).session,
      {
        storagePath: await makeTemporaryDirectory(),
        fetch: fetchExtension,
        chromiumVersion: "152.0.0.0",
      },
    );
    await service.initialize();

    await expect(
      service.prepareFromWebStoreUrl(
        `https://chromewebstore.google.com/detail/${fixture.id}`,
      ),
    ).rejects.toThrow(/untrusted origin/i);
    expect(fetchExtension).toHaveBeenCalledTimes(1);
    expect(fetchExtension.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
    });
  });

  it("rejects a package response without a trustworthy response URL", async () => {
    const fixture = createCrxFixture();
    const service = new ChromeWebStoreExtensionService(
      createSessionDouble(fixture.id).session,
      {
        storagePath: await makeTemporaryDirectory(),
        fetch: async () => new Response(new Uint8Array(fixture.crx)),
        chromiumVersion: "152.0.0.0",
      },
    );
    await service.initialize();

    await expect(
      service.prepareFromWebStoreUrl(
        `https://chromewebstore.google.com/detail/${fixture.id}`,
      ),
    ).rejects.toThrow(/untrusted origin/i);
  });

  it("uses the signed package action icon for toolbar snapshots", async () => {
    const fixture = createCrxFixture({
      manifest: {
        action: {
          default_popup: "popup.html",
          default_icon: { 16: "../unsafe.webp", 38: "images/icon38.webp" },
        },
        icons: { 48: "images/fallback.webp" },
      },
      extraFiles: {
        "images/icon38.webp": "RIFF0000WEBPofficial-toolbar-icon",
        "images/fallback.webp": "RIFF0000WEBPfallback-icon",
      },
    });
    const service = new ChromeWebStoreExtensionService(
      createSessionDouble(fixture.id).session,
      {
        storagePath: await makeTemporaryDirectory(),
        fetch: async () => trustedResponse(new Uint8Array(fixture.crx)),
        chromiumVersion: "152.0.0.0",
      },
    );
    await service.initialize();

    const installed = await service.installFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${fixture.id}`,
    );

    expect(installed.iconDataUrl).toBe(
      `data:image/webp;base64,${Buffer.from("RIFF0000WEBPofficial-toolbar-icon").toString("base64")}`,
    );
  });

  it("resolves localized manifest names and descriptions for the verified review", async () => {
    const fixture = createCrxFixture({
      manifest: {
        name: "__MSG_extName__",
        description: "__MSG_extDescription__",
        default_locale: "en",
      },
      extraFiles: {
        "_locales/en/messages.json": JSON.stringify({
          extName: { message: "Localized fixture" },
          extDescription: { message: "Localized review description." },
        }),
      },
    });
    const service = new ChromeWebStoreExtensionService(
      createSessionDouble(fixture.id).session,
      {
        storagePath: await makeTemporaryDirectory(),
        fetch: async () => trustedResponse(new Uint8Array(fixture.crx)),
        chromiumVersion: "152.0.0.0",
      },
    );
    await service.initialize();

    const preview = await service.prepareFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${fixture.id}`,
    );

    expect(preview.name).toBe("Localized fixture");
    expect(preview.description).toBe("Localized review description.");
    service.cancelPreparedExtension(preview.token);
  });

  it("prepares a verified preview without loading it, then commits the same package with truthful progress", async () => {
    const fixture = createCrxFixture({
      manifest: {
        description: "A signed fixture awaiting explicit approval.",
        permissions: ["storage", "tabs"],
        host_permissions: ["https://example.com/*"],
      },
    });
    const storagePath = await makeTemporaryDirectory();
    const runtime = createSessionDouble(fixture.id);
    const fetchExtension = vi.fn(async () =>
      trustedResponse(new Uint8Array(fixture.crx), {
        status: 200,
        headers: { "content-length": String(fixture.crx.length) },
      }),
    );
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: fetchExtension,
      chromiumVersion: "152.0.0.0",
    });
    const itemUrl = `https://chromewebstore.google.com/detail/a-flexible-human-readable-slug/${fixture.id}?hl=en#overview`;
    const preparationProgress: Array<{
      stage: string;
      receivedBytes?: number;
      totalBytes?: number;
    }> = [];
    await service.initialize();

    const preview = await service.prepareFromWebStoreUrl(itemUrl, (progress) =>
      preparationProgress.push(progress),
    );

    expect(preview).toMatchObject({
      id: fixture.id,
      name: "Chromecraft extension fixture",
      version: fixture.version,
      description: "A signed fixture awaiting explicit approval.",
      permissions: ["storage", "tabs"],
      hostPermissions: ["https://example.com/*"],
      sourceUrl: `https://chromewebstore.google.com/detail/${fixture.id}`,
    });
    expect(preview.token).toMatch(/^[0-9a-f-]{36}$/i);
    expect(preview.warnings.length).toBeGreaterThan(0);
    expect(preparationProgress.map(({ stage }) => stage)).toEqual([
      "downloading",
      "downloading",
      "verifying",
      "preparing",
    ]);
    expect(preparationProgress[1]).toMatchObject({
      receivedBytes: fixture.crx.length,
      totalBytes: fixture.crx.length,
    });
    expect(fetchExtension).toHaveBeenCalledTimes(1);
    expect(runtime.loadExtension).not.toHaveBeenCalled();
    await expect(
      fs.access(path.join(storagePath, fixture.id)),
    ).rejects.toThrow();

    const commitProgress: string[] = [];
    await expect(service.checkAndInstallUpdates()).rejects.toThrow(
      /pending extension review/i,
    );
    const installed = await service.commitPreparedExtension(
      preview.token,
      ({ stage }) => commitProgress.push(stage),
    );

    expect(installed).toMatchObject({
      id: fixture.id,
      name: "Chromecraft extension fixture",
      version: fixture.version,
      ready: true,
    });
    expect(commitProgress).toEqual(["installing", "finishing", "installed"]);
    expect(fetchExtension).toHaveBeenCalledTimes(1);
    expect(runtime.loadExtension).toHaveBeenCalledTimes(1);
    await expect(
      service.commitPreparedExtension(preview.token),
    ).rejects.toThrow(/no longer available/i);
  });

  it("keeps at most one prepared package and lets abandoned previews be cleared", async () => {
    const firstFixture = createCrxFixture();
    const secondFixture = createCrxFixture();
    const storagePath = await makeTemporaryDirectory();
    const runtime = createSessionDouble(secondFixture.id);
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: vi.fn(async (input: string | URL | Request) => {
        const requestUrl = decodeURIComponent(String(input));
        const fixture = requestUrl.includes(`id=${firstFixture.id}`)
          ? firstFixture
          : secondFixture;
        return trustedResponse(new Uint8Array(fixture.crx));
      }),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    const first = await service.prepareFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${firstFixture.id}`,
    );
    const second = await service.prepareFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/fixture/${secondFixture.id}`,
    );

    await expect(service.commitPreparedExtension(first.token)).rejects.toThrow(
      /no longer available/i,
    );
    expect(service.cancelPreparedExtension("not-the-current-token")).toBe(
      false,
    );
    expect(service.cancelPreparedExtension(second.token)).toBe(true);
    expect(service.cancelPreparedExtension(second.token)).toBe(false);
    await expect(service.commitPreparedExtension(second.token)).rejects.toThrow(
      /no longer available/i,
    );
    expect(runtime.loadExtension).not.toHaveBeenCalled();
  });

  it("releases a prepared package after a failed commit", async () => {
    const fixture = createCrxFixture();
    const runtime = createSessionDouble(fixture.id);
    runtime.loadExtension.mockRejectedValueOnce(
      new Error("The extension could not be loaded."),
    );
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath: await makeTemporaryDirectory(),
      fetch: async () => trustedResponse(new Uint8Array(fixture.crx)),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();
    const preview = await service.prepareFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/${fixture.id}`,
    );

    await expect(
      service.commitPreparedExtension(preview.token),
    ).rejects.toThrow(/could not be loaded/i);
    expect(service.cancelPreparedExtension(preview.token)).toBe(false);
    await expect(
      service.commitPreparedExtension(preview.token),
    ).rejects.toThrow(/no longer available/i);
  });

  it("aborts an in-flight preparation without loading extension code", async () => {
    const fixture = createCrxFixture();
    const storagePath = await makeTemporaryDirectory();
    const runtime = createSessionDouble(fixture.id);
    const fetchExtension = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("fetch aborted")),
            { once: true },
          );
        }),
    );
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: fetchExtension,
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    const preparation = service.prepareFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/fixture/${fixture.id}`,
    );
    await vi.waitFor(() => expect(fetchExtension).toHaveBeenCalledTimes(1));

    expect(service.cancelPreparedExtension()).toBe(true);
    await expect(preparation).rejects.toThrow(/aborted/i);
    expect(runtime.loadExtension).not.toHaveBeenCalled();
    await expect(
      fs.access(path.join(storagePath, fixture.id)),
    ).rejects.toThrow();
  });

  it("installs a signed Chrome Web Store CRX and restores it on restart", async () => {
    const fixture = createCrxFixture({
      manifest: { host_permissions: ["https://example.com/*"] },
    });
    const storagePath = await makeTemporaryDirectory();
    const firstRuntime = createSessionDouble(fixture.id);
    const fetchExtension = vi.fn(async (input: string | URL | Request) => {
      const requestUrl = String(input);
      expect(requestUrl).toContain("clients2.google.com/service/update2/crx");
      expect(decodeURIComponent(requestUrl)).toContain(`id=${fixture.id}`);
      return trustedResponse(new Uint8Array(fixture.crx), {
        status: 200,
        headers: {
          "content-type": "application/x-chrome-extension",
        },
      });
    });
    const itemUrl = `https://chromewebstore.google.com/detail/chromecraft-fixture/${fixture.id}`;

    const service = new ChromeWebStoreExtensionService(firstRuntime.session, {
      storagePath,
      fetch: fetchExtension,
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();
    const installed = await service.installFromWebStoreUrl(itemUrl);

    expect(installed).toMatchObject({
      id: fixture.id,
      name: "Chromecraft extension fixture",
      version: "1.0.0",
      enabled: true,
    });
    expect(firstRuntime.loadExtension).toHaveBeenCalledTimes(1);
    expect(
      service.isAllowedExtensionUrl(
        `chrome-extension://${fixture.id}/popup.html`,
      ),
    ).toBe(true);
    expect(service.getExtensionPage(fixture.id, "popup")).toBe(
      `chrome-extension://${fixture.id}/popup.html`,
    );
    const loadedPath = firstRuntime.loadExtension.mock.calls[0]?.[0];
    expect(loadedPath).toEqual(
      path.join(storagePath, fixture.id, fixture.version),
    );
    await expect(
      fs.readFile(path.join(loadedPath!, "manifest.json"), "utf8"),
    ).resolves.toContain(`"key": "${fixture.publicKeyBase64}"`);
    await expect(
      fs.readFile(path.join(loadedPath!, "background.js"), "utf8"),
    ).resolves.toContain("chromecraftExtensionFixture");
    const extractedManifest = JSON.parse(
      await fs.readFile(path.join(loadedPath!, "manifest.json"), "utf8"),
    ) as {
      background: { service_worker: string };
    };
    expect(extractedManifest.background.service_worker).toBe(
      "chromecraft-background-v5.js",
    );
    await expect(
      fs.readFile(
        path.join(loadedPath!, "chromecraft-background-v5.js"),
        "utf8",
      ),
    ).resolves.toMatch(
      /Chromecraft original worker: "background\.js"[\s\S]+const globalThis = __chromecraftWorkerGlobal;[\s\S]+webNavigation[\s\S]+chromecraftExtensionFixture/,
    );
    await expect(
      fs.readFile(
        path.join(loadedPath!, "chromecraft-background-v5.js"),
        "utf8",
      ),
    ).resolves.not.toContain("const globalThis = new Proxy");
    await expect(
      fs.readFile(path.join(loadedPath!, "popup.html"), "utf8"),
    ).resolves.toContain(
      '<script src="/chromecraft-compat/extension-compat.js"></script>',
    );
    await expect(
      fs.readFile(
        path.join(loadedPath!, "chromecraft-background-v5.js"),
        "utf8",
      ),
    ).resolves.toContain('setDefault(permissions, "contains"');
    await expect(
      fs.readFile(
        path.join(loadedPath!, "chromecraft-compat", "extension-compat.js"),
        "utf8",
      ),
    ).resolves.toMatch(
      /setDefault\(tabs, "getCurrent"[\s\S]+actionPopupContext[\s\S]+setOverride\(tabs, "query"[\s\S]+setDefault\(permissions, "contains"/,
    );
    await expect(
      fs.readFile(
        path.join(loadedPath!, "chromecraft-compat", "window-bridge.js"),
        "utf8",
      ),
    ).resolves.toContain("chromecraft-extension-window-v1");
    const generatedWorkerSource = await fs.readFile(
      path.join(loadedPath!, "chromecraft-background-v5.js"),
      "utf8",
    );
    const generatedWindowBridgeSource = await fs.readFile(
      path.join(loadedPath!, "chromecraft-compat", "window-bridge.js"),
      "utf8",
    );
    expect(() => new Function(generatedWorkerSource)).not.toThrow();
    expect(() => new Function(generatedWindowBridgeSource)).not.toThrow();
    expect(generatedWorkerSource).toContain('setDefault(windows, "create"');
    const installedManifest = JSON.parse(
      await fs.readFile(path.join(loadedPath!, "manifest.json"), "utf8"),
    ) as {
      content_scripts: Array<{ js: string[] }>;
    };
    expect(installedManifest.content_scripts).toContainEqual(
      expect.objectContaining({
        matches: ["https://example.com/*"],
        js: ["chromecraft-compat/window-bridge.js"],
      }),
    );

    const legacyManifest = JSON.parse(
      await fs.readFile(path.join(loadedPath!, "manifest.json"), "utf8"),
    ) as {
      background: { service_worker: string };
      content_scripts?: Array<{ js: string[] }>;
    };
    legacyManifest.background.service_worker =
      "__chromecraft/background-wrapper.js";
    legacyManifest.content_scripts = [
      { js: ["__chromecraft/window-bridge.js"] },
    ];
    await fs.writeFile(
      path.join(loadedPath!, "manifest.json"),
      `${JSON.stringify(legacyManifest, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(loadedPath!, "popup.html"),
      '<script src="/__chromecraft/extension-compat.js"></script><!doctype html><title>Fixture popup</title>',
      "utf8",
    );
    await fs.rm(path.join(loadedPath!, "chromecraft-compat"), {
      recursive: true,
      force: true,
    });
    await fs.mkdir(path.join(loadedPath!, "__chromecraft"));
    await fs.writeFile(
      path.join(loadedPath!, "__chromecraft", "background-wrapper.js"),
      'importScripts(chrome.runtime.getURL("background.js"));\n',
      "utf8",
    );
    await fs.rm(path.join(loadedPath!, "chromecraft-background-v5.js"), {
      force: true,
    });

    const secondRuntime = createSessionDouble(fixture.id);
    const restartedService = new ChromeWebStoreExtensionService(
      secondRuntime.session,
      {
        storagePath,
        fetch: vi.fn(() => {
          throw new Error(
            "Restart must not redownload an installed extension.",
          );
        }),
        chromiumVersion: "152.0.0.0",
      },
    );
    await restartedService.initialize();

    await expect(restartedService.listInstalled()).resolves.toEqual([
      expect.objectContaining({
        id: fixture.id,
        name: "Chromecraft extension fixture",
        version: "1.0.0",
        enabled: true,
      }),
    ]);
    expect(secondRuntime.loadExtension).toHaveBeenCalledWith(
      path.join(storagePath, fixture.id, fixture.version),
      { allowFileAccess: false },
    );
    expect(secondRuntime.session.clearStorageData).toHaveBeenCalledWith({
      origin: `chrome-extension://${fixture.id}`,
      storages: ["serviceworkers"],
    });
    const migratedManifest = JSON.parse(
      await fs.readFile(path.join(loadedPath!, "manifest.json"), "utf8"),
    ) as {
      background: { service_worker: string };
      content_scripts: Array<{ js: string[] }>;
    };
    expect(migratedManifest.background.service_worker).toBe(
      "chromecraft-background-v5.js",
    );
    await expect(
      fs.readFile(path.join(loadedPath!, "popup.html"), "utf8"),
    ).resolves.toContain(
      '<script src="/chromecraft-compat/extension-compat.js"></script>',
    );
    await expect(
      fs.readFile(path.join(loadedPath!, "popup.html"), "utf8"),
    ).resolves.not.toContain("/__chromecraft/");
    expect(migratedManifest.content_scripts).toContainEqual(
      expect.objectContaining({
        matches: ["https://example.com/*"],
        js: ["chromecraft-compat/window-bridge.js"],
      }),
    );
    expect(migratedManifest.content_scripts).not.toContainEqual(
      expect.objectContaining({ js: ["__chromecraft/window-bridge.js"] }),
    );
    await expect(
      fs.access(path.join(loadedPath!, "__chromecraft")),
    ).rejects.toThrow();

    const disabled = await restartedService.setEnabled(fixture.id, false);
    expect(disabled).toMatchObject({ enabled: false, ready: false });
    expect(
      restartedService.isAllowedExtensionUrl(
        `chrome-extension://${fixture.id}/popup.html`,
      ),
    ).toBe(false);
    expect(
      secondRuntime.session.extensions.removeExtension,
    ).toHaveBeenCalledWith(fixture.id);
    await fs.writeFile(
      path.join(loadedPath!, "chromecraft-background-v5.js"),
      'importScripts(chrome.runtime.getURL("background.js"));\n',
      "utf8",
    );

    const thirdRuntime = createSessionDouble(fixture.id);
    const disabledRestart = new ChromeWebStoreExtensionService(
      thirdRuntime.session,
      {
        storagePath,
        fetch: vi.fn(),
        chromiumVersion: "152.0.0.0",
      },
    );
    await disabledRestart.initialize();
    expect(thirdRuntime.loadExtension).not.toHaveBeenCalled();
    expect(thirdRuntime.session.clearStorageData).toHaveBeenCalledWith({
      origin: `chrome-extension://${fixture.id}`,
      storages: ["serviceworkers"],
    });
    await expect(
      fs.readFile(
        path.join(loadedPath!, "chromecraft-background-v5.js"),
        "utf8",
      ),
    ).resolves.toContain('setDefault(permissions, "contains"');
    await expect(
      disabledRestart.setEnabled(fixture.id, true),
    ).resolves.toMatchObject({ enabled: true, ready: true });
    expect(thirdRuntime.loadExtension).toHaveBeenCalledTimes(1);

    await disabledRestart.uninstall(fixture.id);
    await expect(disabledRestart.listInstalled()).resolves.toEqual([]);
    await expect(
      fs.access(path.join(storagePath, fixture.id)),
    ).rejects.toThrow();
  }, 15_000);

  it("does not report an extension ready before Electron initializes its browser state", async () => {
    const fixture = createCrxFixture();
    const runtime = createSessionDouble(fixture.id, {
      automaticallyReady: false,
    });
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath: await makeTemporaryDirectory(),
      fetch: async () => trustedResponse(new Uint8Array(fixture.crx)),
      chromiumVersion: "152.0.0.0",
      // Leave enough headroom for loaded CI/development machines. The assertion
      // below controls when readiness is emitted; this timeout is not the subject
      // of this test.
      extensionReadyTimeoutMs: 2_000,
    });
    await service.initialize();

    let settled = false;
    const installing = service
      .installFromWebStoreUrl(
        `https://chromewebstore.google.com/detail/readiness-fixture/${fixture.id}`,
      )
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(
      () => {
        expect(runtime.loadExtension).toHaveBeenCalled();
        expect(runtime.session.extensions.getAllExtensions()).toHaveLength(1);
      },
      { timeout: 10_000, interval: 20 },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    runtime.emitReady();
    await expect(installing).resolves.toMatchObject({
      ready: true,
      error: null,
    });
  }, 15_000);

  it("fails installation when Electron never reports the extension ready", async () => {
    const fixture = createCrxFixture();
    const runtime = createSessionDouble(fixture.id, {
      automaticallyReady: false,
    });
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath: await makeTemporaryDirectory(),
      fetch: async () => trustedResponse(new Uint8Array(fixture.crx)),
      chromiumVersion: "152.0.0.0",
      extensionReadyTimeoutMs: 10,
    });
    await service.initialize();

    await expect(
      service.installFromWebStoreUrl(
        `https://chromewebstore.google.com/detail/readiness-timeout/${fixture.id}`,
      ),
    ).rejects.toThrow(/did not become ready/i);
    await expect(service.listInstalled()).resolves.toEqual([]);
    expect(runtime.session.extensions.getAllExtensions()).toEqual([]);
  });

  it("tracks Electron reload and unload lifecycle events after installation", async () => {
    const fixture = createCrxFixture();
    const onChanged = vi.fn();
    const runtime = createSessionDouble(fixture.id);
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath: await makeTemporaryDirectory(),
      fetch: async () => trustedResponse(new Uint8Array(fixture.crx)),
      chromiumVersion: "152.0.0.0",
      onChanged,
    });
    await service.initialize();
    await service.installFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/lifecycle-fixture/${fixture.id}`,
    );

    runtime.emitLoaded();
    await expect(service.listInstalled()).resolves.toEqual([
      expect.objectContaining({ ready: false }),
    ]);
    runtime.emitReady();
    await expect(service.listInstalled()).resolves.toEqual([
      expect.objectContaining({ ready: true }),
    ]);
    runtime.emitUnloaded();
    await expect(service.listInstalled()).resolves.toEqual([
      expect.objectContaining({ ready: false }),
    ]);
    expect(onChanged).toHaveBeenCalledTimes(3);

    service.dispose();
    runtime.emitReady();
    await expect(service.listInstalled()).resolves.toEqual([
      expect.objectContaining({ ready: false }),
    ]);
  });

  it("wraps module-based Manifest V3 workers before loading the extension", async () => {
    const fixture = createCrxFixture({
      manifest: {
        background: {
          service_worker: "workers/background.mjs",
          type: "module",
        },
        action: undefined,
      },
      extraFiles: {
        "workers/background.mjs":
          'import "./dependency.mjs"; globalThis.moduleWorkerStarted = true;\n',
        "workers/dependency.mjs":
          "globalThis.moduleWorkerDependencyLoaded = true;\n",
      },
    });
    const storagePath = await makeTemporaryDirectory();
    const runtime = createSessionDouble(fixture.id);
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: async () => trustedResponse(new Uint8Array(fixture.crx)),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    await service.installFromWebStoreUrl(
      `https://chromewebstore.google.com/detail/module-fixture/${fixture.id}`,
    );

    const loadedPath = runtime.loadExtension.mock.calls[0]?.[0];
    const installedManifest = JSON.parse(
      await fs.readFile(path.join(loadedPath!, "manifest.json"), "utf8"),
    ) as {
      background: { service_worker: string; type: string };
      content_scripts?: Array<{ js?: string[]; matches?: string[] }>;
    };
    expect(installedManifest.background).toEqual({
      service_worker: "chromecraft-background-v5.js",
      type: "module",
    });
    expect(installedManifest.content_scripts).toBeUndefined();
    await expect(
      fs.readFile(
        path.join(loadedPath!, "chromecraft-background-v5.js"),
        "utf8",
      ),
    ).resolves.toBe(
      '/* Chromecraft original worker: "workers/background.mjs" */\n' +
        'import "./chromecraft-compat/extension-compat.js";\n' +
        'import "./workers/background.mjs";\n',
    );
    await expect(
      fs.readFile(
        path.join(loadedPath!, "chromecraft-compat", "extension-compat.js"),
        "utf8",
      ),
    ).resolves.toContain('setDefault(permissions, "contains"');

    const restartedRuntime = createSessionDouble(fixture.id);
    const restartedService = new ChromeWebStoreExtensionService(
      restartedRuntime.session,
      {
        storagePath,
        fetch: vi.fn(() => {
          throw new Error("Restart must not redownload the extension.");
        }),
        chromiumVersion: "152.0.0.0",
      },
    );
    await restartedService.initialize();
    expect(restartedRuntime.loadExtension).toHaveBeenCalledTimes(1);
    await expect(
      fs.readFile(
        path.join(loadedPath!, "chromecraft-background-v5.js"),
        "utf8",
      ),
    ).resolves.toBe(
      '/* Chromecraft original worker: "workers/background.mjs" */\n' +
        'import "./chromecraft-compat/extension-compat.js";\n' +
        'import "./workers/background.mjs";\n',
    );
  }, 15_000);

  it.each([
    "http://chromewebstore.google.com/detail/example/abcdefghijklmnopabcdefghijklmnop",
    "https://chromewebstore.google.com.example/detail/example/abcdefghijklmnopabcdefghijklmnop",
    "https://example.com/detail/example/abcdefghijklmnopabcdefghijklmnop",
    "https://chromewebstore.google.com/detail/example/not-an-extension-id",
  ])("rejects an untrusted Web Store item URL: %s", async (itemUrl) => {
    const storagePath = await makeTemporaryDirectory();
    const runtime = createSessionDouble("abcdefghijklmnopabcdefghijklmnop");
    const fetchExtension = vi.fn();
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: fetchExtension,
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    await expect(service.installFromWebStoreUrl(itemUrl)).rejects.toThrow();
    expect(fetchExtension).not.toHaveBeenCalled();
    expect(runtime.loadExtension).not.toHaveBeenCalled();
  });

  it("rejects a CRX whose signing key does not match the requested extension id", async () => {
    const fixture = createCrxFixture();
    const storagePath = await makeTemporaryDirectory();
    const requestedId =
      fixture.id === "abcdefghijklmnopabcdefghijklmnop"
        ? "bcdefghijklmnopabcdefghijklmnopa"
        : "abcdefghijklmnopabcdefghijklmnop";
    const runtime = createSessionDouble(requestedId);
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: vi.fn(async () => trustedResponse(new Uint8Array(fixture.crx))),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    await expect(
      service.installFromWebStoreUrl(
        `https://chromewebstore.google.com/detail/fixture/${requestedId}`,
      ),
    ).rejects.toThrow(/identity|signature|extension id/i);
    expect(runtime.loadExtension).not.toHaveBeenCalled();
  });

  it("rejects a CRX with a tampered signed archive", async () => {
    const fixture = createCrxFixture();
    const tampered = Buffer.from(fixture.crx);
    tampered[tampered.length - 24] ^= 0xff;
    const storagePath = await makeTemporaryDirectory();
    const runtime = createSessionDouble(fixture.id);
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: vi.fn(async () => trustedResponse(new Uint8Array(tampered))),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    await expect(
      service.installFromWebStoreUrl(
        `https://chromewebstore.google.com/detail/fixture/${fixture.id}`,
      ),
    ).rejects.toThrow(/signature|invalid|corrupt/i);
    expect(runtime.loadExtension).not.toHaveBeenCalled();
  });

  it("installs a signed extension containing Adobe Photoshop's large WASM-sized entry", async () => {
    const fixture = createCrxFixture({
      extraFiles: {
        "release/legacy/acr_web.wasm": {
          contents: Buffer.alloc(45_789_365),
          compression: "deflate",
        },
      },
    });
    const storagePath = await makeTemporaryDirectory();
    const runtime = createSessionDouble(fixture.id);
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: vi.fn(async () => trustedResponse(new Uint8Array(fixture.crx))),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    await expect(
      service.installFromWebStoreUrl(
        `https://chromewebstore.google.com/detail/fixture/${fixture.id}`,
      ),
    ).resolves.toMatchObject({ id: fixture.id, ready: true });
    await expect(
      fs.stat(
        path.join(
          storagePath,
          fixture.id,
          fixture.version,
          "release",
          "legacy",
          "acr_web.wasm",
        ),
      ),
    ).resolves.toMatchObject({ size: 45_789_365 });
  });

  it("rejects an archive entry above the bounded 64 MiB ceiling", async () => {
    const fixture = createCrxFixture({
      extraFiles: {
        "oversized.bin": {
          contents: Buffer.alloc(1),
          declaredUncompressedSize: 64 * 1024 * 1024 + 1,
        },
      },
    });
    const runtime = createSessionDouble(fixture.id);
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath: await makeTemporaryDirectory(),
      fetch: vi.fn(async () => trustedResponse(new Uint8Array(fixture.crx))),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    await expect(
      service.installFromWebStoreUrl(
        `https://chromewebstore.google.com/detail/fixture/${fixture.id}`,
      ),
    ).rejects.toThrow(/entry exceeds the size limit/i);
    expect(runtime.loadExtension).not.toHaveBeenCalled();
  });

  it("retains the aggregate extracted-size ceiling for large valid entries", async () => {
    const maximumEntryBytes = 64 * 1024 * 1024;
    const fixture = createCrxFixture({
      extraFiles: {
        "large-valid.bin": {
          contents: Buffer.alloc(maximumEntryBytes),
          compression: "deflate",
        },
        "aggregate-overflow.bin": {
          contents: Buffer.alloc(1),
          declaredUncompressedSize: maximumEntryBytes,
        },
      },
    });
    const runtime = createSessionDouble(fixture.id);
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath: await makeTemporaryDirectory(),
      fetch: vi.fn(async () => trustedResponse(new Uint8Array(fixture.crx))),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    await expect(
      service.installFromWebStoreUrl(
        `https://chromewebstore.google.com/detail/fixture/${fixture.id}`,
      ),
    ).rejects.toThrow(/extracted extension exceeds the size limit/i);
    expect(runtime.loadExtension).not.toHaveBeenCalled();
  });

  it("rejects archive traversal before extracting or loading the extension", async () => {
    const fixture = createCrxFixture({
      extraFiles: {
        "../escaped.txt": "This must never leave the extension directory.",
      },
    });
    const storagePath = await makeTemporaryDirectory();
    const runtime = createSessionDouble(fixture.id);
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: vi.fn(async () => trustedResponse(new Uint8Array(fixture.crx))),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    await expect(
      service.installFromWebStoreUrl(
        `https://chromewebstore.google.com/detail/fixture/${fixture.id}`,
      ),
    ).rejects.toThrow(/archive|path|traversal|entry/i);
    await expect(
      fs.access(path.join(storagePath, fixture.id, "escaped.txt")),
    ).rejects.toThrow();
    expect(runtime.loadExtension).not.toHaveBeenCalled();
  });

  it.each([
    "chromecraft-compat/extension-compat.js",
    "CHROMECRAFT-COMPAT/extension-compat.js",
    "chromecraft-compat",
    "chromecraft-background-v5.js",
    "__chromecraft/extension-compat.js",
    "__CHROMECRAFT/extension-compat.js",
    "__chromecraft",
    "__chromecraft_background-v4.js",
    "__chromecraft_background-v3.js",
    "__CHROMECRAFT_BACKGROUND-V2.JS",
    "__chromecraft_background-wrapper.js",
    "__CHROMECRAFT_BACKGROUND-WRAPPER.JS",
  ])(
    "rejects an extension archive that collides with browser-owned compatibility files: %s",
    async (collisionPath) => {
      const fixture = createCrxFixture({
        extraFiles: {
          [collisionPath]: "untrusted collision",
        },
      });
      const storagePath = await makeTemporaryDirectory();
      const runtime = createSessionDouble(fixture.id);
      const service = new ChromeWebStoreExtensionService(runtime.session, {
        storagePath,
        fetch: vi.fn(async () => trustedResponse(new Uint8Array(fixture.crx))),
        chromiumVersion: "152.0.0.0",
      });
      await service.initialize();

      await expect(
        service.installFromWebStoreUrl(
          `https://chromewebstore.google.com/detail/fixture/${fixture.id}`,
        ),
      ).rejects.toThrow(/collides|compatibility/i);
      expect(runtime.loadExtension).not.toHaveBeenCalled();
    },
  );

  it("imports an unpacked extension into managed storage without deleting its source", async () => {
    const storagePath = await makeTemporaryDirectory();
    const sourcePath = await makeTemporaryDirectory();
    await fs.writeFile(
      path.join(sourcePath, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Developer fixture",
        version: "1.2.3",
        description: "Loaded from a selected folder",
      }),
    );
    const runtime = createSessionDouble("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: vi.fn(),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    const installed = await service.importUnpacked(sourcePath);

    expect(installed.name).toBe("Developer fixture");
    expect(installed.sourceUrl).toBe(`unpacked:${installed.id}`);
    expect(installed.ready).toBe(true);
    expect(runtime.loadExtension).toHaveBeenCalledTimes(1);
    await expect(
      fs.stat(path.join(storagePath, installed.id, "1.2.3", "manifest.json")),
    ).resolves.toBeDefined();

    service.dispose();
    const restartedRuntime = createSessionDouble(installed.id);
    const restarted = new ChromeWebStoreExtensionService(
      restartedRuntime.session,
      {
        storagePath,
        fetch: vi.fn(),
        chromiumVersion: "152.0.0.0",
      },
    );
    await restarted.initialize();
    expect(await restarted.listInstalled()).toEqual([
      expect.objectContaining({
        id: installed.id,
        sourceUrl: `unpacked:${installed.id}`,
        ready: true,
      }),
    ]);

    await restarted.uninstall(installed.id);
    await expect(
      fs.stat(path.join(sourcePath, "manifest.json")),
    ).resolves.toBeDefined();
  });

  it("rejects unpacked folders without a valid manifest", async () => {
    const storagePath = await makeTemporaryDirectory();
    const sourcePath = await makeTemporaryDirectory();
    const runtime = createSessionDouble("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const service = new ChromeWebStoreExtensionService(runtime.session, {
      storagePath,
      fetch: vi.fn(),
      chromiumVersion: "152.0.0.0",
    });
    await service.initialize();

    await expect(service.importUnpacked(sourcePath)).rejects.toThrow(
      /manifest\.json/i,
    );
    expect(runtime.loadExtension).not.toHaveBeenCalled();
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chromecraft-extension-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function createSessionDouble(
  extensionId: string,
  options: { automaticallyReady?: boolean } = {},
): {
  session: Session;
  loadExtension: ReturnType<typeof vi.fn>;
  emitLoaded: () => void;
  emitReady: () => void;
  emitUnloaded: () => void;
} {
  const loadedExtensions: Extension[] = [];
  const extensions = new EventEmitter();
  const loadExtension = vi.fn(
    async (extensionPath: string): Promise<Extension> => {
      const manifest = JSON.parse(
        await fs.readFile(path.join(extensionPath, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      const manifestKey =
        typeof manifest.key === "string"
          ? Buffer.from(manifest.key, "base64")
          : Buffer.alloc(0);
      const loadedId = manifestKey.length
        ? extensionIdFromKey(manifestKey)
        : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const extension = {
        id: loadedId,
        name: String(manifest.name),
        path: extensionPath,
        version: String(manifest.version),
        url: `chrome-extension://${loadedId}/`,
        manifest,
      } as unknown as Extension;
      loadedExtensions.push(extension);
      if (options.automaticallyReady !== false) {
        queueMicrotask(() => extensions.emit("extension-ready", {}, extension));
      }
      return extension;
    },
  );
  Object.assign(extensions, {
    getAllExtensions: () => [...loadedExtensions],
    getExtension: (id: string) =>
      loadedExtensions.find((extension) => extension.id === id) ?? null,
    loadExtension,
    removeExtension: vi.fn(async (id: string) => {
      const index = loadedExtensions.findIndex(
        (extension) => extension.id === id,
      );
      if (index >= 0) loadedExtensions.splice(index, 1);
    }),
  });
  return {
    session: {
      clearStorageData: vi.fn(async () => undefined),
      extensions,
    } as unknown as Session,
    loadExtension,
    emitLoaded: () => {
      const extension = loadedExtensions.at(-1);
      if (extension) extensions.emit("extension-loaded", {}, extension);
    },
    emitReady: () => {
      const extension = loadedExtensions.at(-1);
      if (extension) extensions.emit("extension-ready", {}, extension);
    },
    emitUnloaded: () => {
      const extension = loadedExtensions.at(-1);
      if (extension) extensions.emit("extension-unloaded", {}, extension);
    },
  };
}

interface ZipFixtureFile {
  contents: string | Buffer;
  compression?: "deflate";
  declaredUncompressedSize?: number;
}

interface CrxFixtureOptions {
  extraFiles?: Record<string, string | Buffer | ZipFixtureFile>;
  manifest?: Record<string, unknown>;
  signingKeys?: { privateKey: KeyObject; publicKey: KeyObject };
}

function createCrxFixture(options: CrxFixtureOptions = {}): {
  crx: Buffer;
  id: string;
  version: string;
  publicKeyBase64: string;
} {
  const { privateKey, publicKey } =
    options.signingKeys ??
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const idBytes = createHash("sha256")
    .update(publicKeyDer)
    .digest()
    .subarray(0, 16);
  const id = [...idBytes]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
  const version =
    typeof options.manifest?.version === "string"
      ? options.manifest.version
      : "1.0.0";
  const manifest = JSON.stringify(
    {
      manifest_version: 3,
      name: "Chromecraft extension fixture",
      version,
      background: { service_worker: "background.js" },
      action: { default_popup: "popup.html" },
      ...options.manifest,
    },
    null,
    2,
  );
  const archive = createStoredZip({
    "manifest.json": manifest,
    "background.js":
      "globalThis.chromecraftExtensionFixture = 'installed-and-running';\n",
    "popup.html": "<!doctype html><title>Fixture popup</title>",
    ...options.extraFiles,
  });
  const signedHeaderData = protobufBytes(1, idBytes);
  const signatureInput = Buffer.concat([
    Buffer.from("CRX3 SignedData\0", "ascii"),
    uint32(signedHeaderData.length),
    signedHeaderData,
    archive,
  ]);
  const signature = sign("sha256", signatureInput, privateKey);
  const proof = Buffer.concat([
    protobufBytes(1, publicKeyDer),
    protobufBytes(2, signature),
  ]);
  const header = Buffer.concat([
    protobufBytes(2, proof),
    protobufBytes(10_000, signedHeaderData),
  ]);
  return {
    id,
    version,
    publicKeyBase64: publicKeyDer.toString("base64"),
    crx: Buffer.concat([
      Buffer.from("Cr24", "ascii"),
      uint32(3),
      uint32(header.length),
      header,
      archive,
    ]),
  };
}

function extensionIdFromKey(publicKey: Uint8Array): string {
  return [...createHash("sha256").update(publicKey).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

function protobufBytes(field: number, value: Uint8Array): Buffer {
  return Buffer.concat([
    protobufVarint(field * 8 + 2),
    protobufVarint(value.byteLength),
    Buffer.from(value),
  ]);
}

function protobufVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 128) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function createStoredZip(
  files: Record<string, string | Buffer | ZipFixtureFile>,
): Buffer {
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;
  for (const [filename, input] of Object.entries(files)) {
    const name = Buffer.from(filename, "utf8");
    const file =
      typeof input === "string" || Buffer.isBuffer(input)
        ? { contents: input }
        : input;
    const data = Buffer.isBuffer(file.contents)
      ? file.contents
      : Buffer.from(file.contents, "utf8");
    const compressed =
      file.compression === "deflate" ? deflateRawSync(data) : data;
    const compression = file.compression === "deflate" ? 8 : 0;
    const declaredUncompressedSize =
      file.declaredUncompressedSize ?? data.length;
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(compression, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(declaredUncompressedSize, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([localHeader, name, compressed]);
    localEntries.push(local);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(compression, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(declaredUncompressedSize, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralEntries.push(Buffer.concat([centralHeader, name]));
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centralEntries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(localEntries.length, 8);
  end.writeUInt16LE(localEntries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localEntries, centralDirectory, end]);
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}
