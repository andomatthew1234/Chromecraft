import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExtensionInstallBanner } from "./ExtensionInstallBanner";

const metadata = {
  name: "Password Manager",
  description: "A verified Chrome Web Store extension.",
  version: "1.2.3",
  extensionId: "abcdefghijklmnopabcdefghijklmnop",
};

describe("ExtensionInstallBanner", () => {
  it("presents review as an explicit action before installation", () => {
    const markup = renderToStaticMarkup(
      <ExtensionInstallBanner
        metadata={metadata}
        state="available"
        primaryAction={{ label: "Review & install", onClick: vi.fn() }}
        onDismiss={vi.fn()}
      />,
    );

    expect(markup).toContain("Password Manager");
    expect(markup).toContain("Review &amp; install");
    expect(markup).toContain("Available to install");
    expect(markup).toContain('aria-busy="false"');
  });

  it("shows real determinate progress and its truthful stage label", () => {
    const markup = renderToStaticMarkup(
      <ExtensionInstallBanner
        metadata={metadata}
        state="installing"
        status="Downloading…"
        progress={42.4}
        onDismiss={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('value="42.4"');
    expect(markup).toContain("42%");
    expect(markup).toContain("Downloading…");
  });

  it("keeps installed state actionable without offering a second install", () => {
    const markup = renderToStaticMarkup(
      <ExtensionInstallBanner
        metadata={metadata}
        state="installed"
        removeAction={{ label: "Remove", onClick: vi.fn() }}
        onDismiss={vi.fn()}
      />,
    );

    expect(markup).toContain('data-state="installed"');
    expect(markup).toContain("check_circle");
    expect(markup).toContain("Already installed");
    expect(markup).toContain(">Remove<");
    expect(markup).not.toContain("Review &amp; install");
  });
});
