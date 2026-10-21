import { describe, expect, it, vi } from "vitest";

import { ExtensionActionHost } from "./extension-action-host";

const ID = "abcdefghijklmnopabcdefghijklmnop";

describe("ExtensionActionHost", () => {
  it("resolves manifest, global, and per-tab state with Chrome precedence", async () => {
    const changed = vi.fn();
    const host = new ExtensionActionHost({ changed });
    host.register({
      id: ID,
      name: "Fixture",
      baseUrl: `chrome-extension://${ID}/`,
      manifest: {
        action: {
          default_title: "Default title",
          default_popup: "popup.html",
          default_icon: { 16: "icon-16.png", 32: "icon-32.png" },
        },
      },
    });

    await host.execute(ID, "setTitle", { title: "Global" });
    await host.execute(ID, "setBadgeText", { text: "7" });
    await host.execute(ID, "setTitle", { tabId: 42, title: "Tab 42" });
    await host.execute(ID, "setPopup", { tabId: 42, popup: "vault.html" });
    await host.execute(ID, "disable", { tabId: 42 });

    expect(host.resolve(ID, 7)).toMatchObject({
      title: "Global",
      popupUrl: `chrome-extension://${ID}/popup.html`,
      badgeText: "7",
      enabled: true,
      iconUrl: `chrome-extension://${ID}/icon-32.png`,
    });
    expect(host.resolve(ID, 42)).toMatchObject({
      title: "Tab 42",
      popupUrl: `chrome-extension://${ID}/vault.html`,
      badgeText: "7",
      enabled: false,
    });
    expect(await host.execute(ID, "getTitle", { tabId: 42 })).toBe("Tab 42");
    expect(await host.execute(ID, "getPopup", { tabId: 42 })).toBe(
      `chrome-extension://${ID}/vault.html`,
    );
    expect(await host.execute(ID, "isEnabled", { tabId: 42 })).toBe(false);
    expect(changed).toHaveBeenCalledWith(ID);
  });

  it("opens the effective popup and supports Bitwarden-style temporary routes", async () => {
    const openPopup = vi.fn(async () => undefined);
    const host = new ExtensionActionHost({ openPopup });
    registerAction(host);

    await host.execute(ID, "setPopup", {
      tabId: 73,
      popup: "popup/index.html#/autofill",
    });
    await host.execute(ID, "openPopup", { tabId: 73 });
    await host.execute(ID, "setPopup", { tabId: 73, popup: "popup.html" });

    expect(openPopup).toHaveBeenCalledOnce();
    expect(openPopup).toHaveBeenCalledWith(
      ID,
      `chrome-extension://${ID}/popup/index.html#/autofill`,
      73,
    );
    expect(host.resolve(ID, 73)?.popupUrl).toBe(
      `chrome-extension://${ID}/popup.html`,
    );
  });

  it("round-trips badge colors and clears tab state on removal", async () => {
    const host = new ExtensionActionHost();
    registerAction(host);
    await host.execute(ID, "setBadgeBackgroundColor", {
      tabId: 42,
      color: "#1a2b3c80",
    });
    await host.execute(ID, "setBadgeTextColor", {
      tabId: 42,
      color: [1, 2, 3],
    });
    await host.execute(ID, "setBadgeText", { tabId: 42, text: "!" });

    expect(
      await host.execute(ID, "getBadgeBackgroundColor", { tabId: 42 }),
    ).toEqual([26, 43, 60, 128]);
    expect(await host.execute(ID, "getBadgeTextColor", { tabId: 42 })).toEqual([
      1, 2, 3, 255,
    ]);
    host.removeTab(42);
    expect(host.resolve(ID, 42)?.badgeText).toBe("");
  });

  it("resets page-action visibility on navigation without losing other state", async () => {
    const host = new ExtensionActionHost();
    host.register({
      id: ID,
      name: "Page fixture",
      baseUrl: `chrome-extension://${ID}/`,
      manifest: { page_action: { default_title: "Page action" } },
    });
    expect(host.resolve(ID, 42)?.visible).toBe(false);
    await host.execute(ID, "show", { tabId: 42 });
    await host.execute(ID, "setTitle", { tabId: 42, title: "Visible here" });
    expect(host.resolve(ID, 42)).toMatchObject({
      visible: true,
      title: "Visible here",
    });

    host.navigatedTab(42);
    expect(host.resolve(ID, 42)).toMatchObject({
      visible: false,
      title: "Visible here",
    });
  });

  it("rejects cross-extension resources and malformed untrusted details", async () => {
    const host = new ExtensionActionHost();
    registerAction(host);
    await expect(
      host.execute(ID, "setPopup", {
        popup: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/evil.html",
      }),
    ).rejects.toThrow("must belong to the extension");
    await expect(
      host.execute(ID, "setBadgeText", { text: "x".repeat(257) }),
    ).rejects.toThrow("too long");
    await expect(host.execute(ID, "enable", { tabId: -1 })).rejects.toThrow(
      "positive integer",
    );
  });

  it("opens popups with a toolbar-gesture activeTab grant", () => {
    const host = new ExtensionActionHost();
    host.register({
      id: ID,
      name: "Popup fixture",
      baseUrl: `chrome-extension://${ID}/`,
      manifest: {
        permissions: ["activeTab"],
        action: { default_popup: "popup.html" },
      },
    });

    expect(
      host.invokeFromToolbar(ID, { id: 42, url: "https://example.com/a" }),
    ).toEqual({
      kind: "popup",
      popupUrl: `chrome-extension://${ID}/popup.html`,
    });
    expect(host.hasActiveTabGrant(ID, 42, "https://example.com/a")).toBe(true);
  });

  it("dispatches popup-less clicks and scopes activeTab to tab and origin", () => {
    const host = new ExtensionActionHost();
    host.register({
      id: ID,
      name: "Click fixture",
      baseUrl: `chrome-extension://${ID}/`,
      manifest: { permissions: ["activeTab"], action: {} },
    });

    expect(
      host.invokeFromToolbar(ID, {
        id: 42,
        url: "https://example.com/first",
      }),
    ).toEqual({ kind: "clicked" });
    expect(host.hasActiveTabGrant(ID, 42, "https://example.com/second")).toBe(
      true,
    );
    expect(host.hasActiveTabGrant(ID, 7, "https://example.com/second")).toBe(
      false,
    );

    host.navigatedTab(42, "https://example.com/third");
    expect(host.hasActiveTabGrant(ID, 42, "https://example.com/third")).toBe(
      true,
    );
    host.navigatedTab(42, "https://other.example/path");
    expect(host.hasActiveTabGrant(ID, 42, "https://example.com/third")).toBe(
      false,
    );
  });

  it("suppresses disabled and hidden toolbar invocations", async () => {
    const host = new ExtensionActionHost();
    host.register({
      id: ID,
      name: "Click fixture",
      baseUrl: `chrome-extension://${ID}/`,
      manifest: { action: {} },
    });
    await host.execute(ID, "disable", { tabId: 42 });
    expect(() =>
      host.invokeFromToolbar(ID, { id: 42, url: "https://example.com" }),
    ).toThrow("disabled or hidden");
    await host.execute(ID, "enable", { tabId: 42 });
    await host.execute(ID, "hide", { tabId: 42 });
    expect(() =>
      host.invokeFromToolbar(ID, { id: 42, url: "https://example.com" }),
    ).toThrow("disabled or hidden");
  });

  it("does not grant optional activeTab before permission consent exists", () => {
    const host = new ExtensionActionHost();
    host.register({
      id: ID,
      name: "Optional fixture",
      baseUrl: `chrome-extension://${ID}/`,
      manifest: { optional_permissions: ["activeTab"], action: {} },
    });
    host.invokeFromToolbar(ID, { id: 42, url: "https://example.com" });
    expect(host.hasActiveTabGrant(ID, 42, "https://example.com")).toBe(false);
  });
});

function registerAction(host: ExtensionActionHost): void {
  host.register({
    id: ID,
    name: "Fixture",
    baseUrl: `chrome-extension://${ID}/`,
    manifest: { action: { default_popup: "popup.html" } },
  });
}
