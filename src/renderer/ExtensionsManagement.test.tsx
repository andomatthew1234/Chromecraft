import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionsSnapshot } from "../shared/browser";
import { ExtensionsPage, ExtensionsSidebarPanel } from "./App";

const snapshot: ExtensionsSnapshot = {
  initialized: true,
  operation: "idle",
  operationExtensionId: null,
  popupExtensionId: null,
  error: null,
  errorExtensionId: null,
  progress: null,
  items: [
    {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Fixture extension",
      version: "1.2.3",
      description: "A useful extension description.",
      enabled: true,
      ready: true,
      status: "ready",
      permissions: ["storage"],
      hostPermissions: [],
      warnings: ["One compatibility warning"],
      error: "One developer load error",
      sourceUrl: "unpacked:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      optionsUrl: null,
      popupUrl: null,
      iconDataUrl: "data:image/png;base64,AA==",
      action: null,
    },
  ],
};

describe("extension management surfaces", () => {
  it("shows installed extension identity and descriptions in the sidebar", () => {
    const markup = renderToStaticMarkup(
      <ExtensionsSidebarPanel snapshot={snapshot} openPage={vi.fn()} />,
    );

    expect(markup).toContain("Fixture extension");
    expect(markup).toContain("A useful extension description.");
    expect(markup).toContain("data:image/png;base64,AA==");
    expect(markup).toContain('aria-label="Open extensions page"');
  });

  it("renders the three management tiles and gates diagnostics behind dev mode", () => {
    const regular = renderToStaticMarkup(
      <ExtensionsPage
        snapshot={snapshot}
        developerMode={false}
        close={vi.fn()}
        requestInstall={vi.fn()}
        requestRemove={vi.fn()}
      />,
    );
    const developer = renderToStaticMarkup(
      <ExtensionsPage
        snapshot={snapshot}
        developerMode
        close={vi.fn()}
        requestInstall={vi.fn()}
        requestRemove={vi.fn()}
      />,
    );

    expect(regular).toContain('data-extension-tile="add"');
    expect(regular).toContain('data-extension-tile="updates"');
    expect(regular).toContain('data-extension-tile="developer"');
    expect(regular).toContain('aria-label="Open Chrome Web Store"');
    expect(regular).not.toContain("One developer load error");
    expect(developer).toContain("One developer load error");
    expect(developer).toContain("One compatibility warning");
  });
});
