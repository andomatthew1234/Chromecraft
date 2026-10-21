import { describe, expect, it, vi } from "vitest";

import {
  resolveWebsitePermissionOrigin,
  WebsitePermissionController,
} from "./website-permission-controller";

function fakeContents(): Electron.WebContents {
  return { id: 41, isDestroyed: () => false } as Electron.WebContents;
}

describe("WebsitePermissionController", () => {
  it("resolves HTTP, HTTPS, blob, and opaque-frame permission origins", () => {
    expect(
      resolveWebsitePermissionOrigin(
        "https://host.example/watch",
        "https://player.example/embed",
      ),
    ).toBe("https://player.example");
    expect(
      resolveWebsitePermissionOrigin(
        "https://host.example/watch",
        "blob:https://player.example/id",
      ),
    ).toBe("https://player.example");
    expect(
      resolveWebsitePermissionOrigin(
        "https://host.example/watch",
        "about:blank",
      ),
    ).toBe("https://host.example");
    expect(
      resolveWebsitePermissionOrigin(
        "https://host.example/watch",
        "file:///private/player.html",
      ),
    ).toBe(null);
    expect(
      resolveWebsitePermissionOrigin(
        "https://host.example/watch",
        "chrome-extension://id/player.html",
      ),
    ).toBe(null);
    expect(resolveWebsitePermissionOrigin("chrome-extension://id/page")).toBe(
      null,
    );
  });

  it("prompts once and keeps an allowed capability scoped to the origin", async () => {
    const contents = fakeContents();
    const prompt = vi.fn().mockResolvedValue(true);
    const controller = new WebsitePermissionController({
      contextFor: (candidate) =>
        candidate === contents
          ? {
              topLevelUrl: "https://game.example/play",
              websiteFullscreen: false,
              documentId: "tab:1",
            }
          : null,
      prompt,
    });

    expect(controller.check(contents, "pointerLock")).toBe(false);
    await expect(controller.request(contents, "pointerLock")).resolves.toBe(
      true,
    );
    expect(controller.check(contents, "pointerLock")).toBe(true);
    await expect(controller.request(contents, "pointerLock")).resolves.toBe(
      true,
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(controller.check(contents, "geolocation")).toBe(false);
  });

  it("requires active website fullscreen before granting keyboard lock", async () => {
    const contents = fakeContents();
    let websiteFullscreen = false;
    const prompt = vi.fn().mockResolvedValue(true);
    const controller = new WebsitePermissionController({
      contextFor: () => ({
        topLevelUrl: "https://game.example/play",
        websiteFullscreen,
        documentId: "tab:1",
      }),
      prompt,
    });

    await expect(controller.request(contents, "keyboardLock")).resolves.toBe(
      false,
    );
    websiteFullscreen = true;
    await expect(controller.request(contents, "keyboardLock")).resolves.toBe(
      true,
    );
    websiteFullscreen = false;
    expect(controller.check(contents, "keyboardLock")).toBe(false);
  });

  it("revalidates the active context after the user answers", async () => {
    const contents = fakeContents();
    let active = true;
    let answer: ((allowed: boolean) => void) | undefined;
    const controller = new WebsitePermissionController({
      contextFor: () =>
        active
          ? {
              topLevelUrl: "https://video.example/watch",
              websiteFullscreen: false,
              documentId: "tab:1",
            }
          : null,
      prompt: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });

    const request = controller.request(contents, "screen-wake-lock");
    active = false;
    answer?.(true);
    await expect(request).resolves.toBe(false);
  });

  it("does not carry grants or blocks into a new document", async () => {
    const contents = fakeContents();
    let documentId = "tab:1";
    const prompt = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const controller = new WebsitePermissionController({
      contextFor: () => ({
        topLevelUrl: "https://game.example/play",
        websiteFullscreen: false,
        documentId,
      }),
      prompt,
    });

    await expect(controller.request(contents, "pointerLock")).resolves.toBe(
      false,
    );
    await expect(controller.request(contents, "pointerLock")).resolves.toBe(
      false,
    );
    expect(prompt).toHaveBeenCalledTimes(1);

    documentId = "tab:2";
    await expect(controller.request(contents, "pointerLock")).resolves.toBe(
      true,
    );
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("invalidates an outstanding prompt when its tab is deactivated", async () => {
    const contents = fakeContents();
    let answer: ((allowed: boolean) => void) | undefined;
    const controller = new WebsitePermissionController({
      contextFor: () => ({
        topLevelUrl: "https://game.example/play",
        websiteFullscreen: false,
        documentId: "tab:1",
      }),
      prompt: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });

    const request = controller.request(contents, "pointerLock");
    controller.revoke(contents);
    answer?.(true);
    await expect(request).resolves.toBe(false);
    expect(controller.check(contents, "pointerLock")).toBe(false);
  });
});
