import { describe, expect, it } from "vitest";

import { ExtensionCommandHost } from "./extension-command-host";

const FIRST = "abcdefghijklmnopabcdefghijklmnop";
const SECOND = "bcdefghijklmnopabcdefghijklmnopa";

describe("ExtensionCommandHost", () => {
  it("selects platform shortcuts and matches Bitwarden-shaped commands", () => {
    const host = new ExtensionCommandHost("win32");
    host.register({
      id: FIRST,
      manifest: {
        manifest_version: 3,
        permissions: ["activeTab"],
        action: { default_popup: "popup.html" },
        commands: {
          _execute_action: {
            suggested_key: { default: "Ctrl+Shift+Y", linux: "Ctrl+Shift+U" },
            description: "Open popup",
          },
          autofill_login: {
            suggested_key: { default: "Ctrl+Shift+L" },
            description: "Autofill",
          },
          lock_vault: { description: "Lock" },
        },
      },
    });

    expect(host.getAll(FIRST)).toEqual([
      {
        name: "_execute_action",
        description: "Open popup",
        shortcut: "Ctrl+Shift+Y",
      },
      {
        name: "autofill_login",
        description: "Autofill",
        shortcut: "Ctrl+Shift+L",
      },
      { name: "lock_vault", description: "Lock", shortcut: "" },
    ]);
    expect(
      host.match(
        {
          key: "l",
          code: "KeyL",
          control: true,
          shift: true,
          alt: false,
          meta: false,
        },
        { id: 7, url: "https://vault.example/page" },
      ),
    ).toEqual({
      extensionId: FIRST,
      command: "autofill_login",
      reservedAction: false,
    });
    expect(
      host.hasActiveTabGrant(FIRST, 7, "https://vault.example/other"),
    ).toBe(true);
    host.navigatedTab(7, "https://elsewhere.example/");
    expect(host.hasActiveTabGrant(FIRST, 7, "https://elsewhere.example/")).toBe(
      false,
    );
  });

  it("uses Linux overrides and marks reserved action commands", () => {
    const host = new ExtensionCommandHost("linux", []);
    host.register({
      id: FIRST,
      manifest: {
        action: {},
        commands: {
          _execute_action: {
            suggested_key: { default: "Ctrl+Shift+Y", linux: "Ctrl+Shift+U" },
          },
        },
      },
    });
    expect(host.getAll(FIRST)[0].shortcut).toBe("Ctrl+Shift+U");
    expect(
      host.match(
        { key: "u", control: true, shift: true, alt: false, meta: false },
        null,
      ),
    ).toEqual({
      extensionId: FIRST,
      command: "_execute_action",
      reservedAction: true,
    });
  });

  it("leaves browser conflicts and later extension collisions unassigned", () => {
    const host = new ExtensionCommandHost("win32");
    const command = (shortcut: string) => ({
      commands: { run: { suggested_key: shortcut, description: "Run" } },
    });
    host.register({ id: FIRST, manifest: command("Ctrl+Shift+K") });
    host.register({ id: SECOND, manifest: command("Ctrl+Shift+K") });
    expect(host.getAll(FIRST)[0].shortcut).toBe("Ctrl+Shift+K");
    expect(host.getAll(SECOND)[0].shortcut).toBe("");

    host.register({ id: SECOND, manifest: command("Ctrl+L") });
    expect(host.getAll(SECOND)[0].shortcut).toBe("");
  });

  it("does not activate a reserved alias without its matching action", () => {
    const host = new ExtensionCommandHost("win32", []);
    host.register({
      id: FIRST,
      manifest: {
        commands: {
          _execute_action: { suggested_key: "Ctrl+Shift+Y" },
        },
      },
    });
    expect(host.getAll(FIRST)[0].shortcut).toBe("");
  });
});
