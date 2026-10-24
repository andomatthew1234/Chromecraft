import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WebsiteControlSnapshot } from "../shared/browser";
import { PageActionsPanel } from "./PageActionsPanel";

const site: WebsiteControlSnapshot = {
  origin: "https://example.com",
  hostname: "example.com",
  hasStoredData: true,
  decisions: {
    camera: "ask",
    microphone: "ask",
    location: "ask",
    notifications: "ask",
    popups: "ask",
    clipboard: "ask",
    autoplay: "ask",
    downloads: "ask",
    network: "allow",
    javascript: "allow",
    hyperdrive: "allow",
  },
};

describe("PageActionsPanel", () => {
  it("offers security, offline saving and sharing from one page menu", () => {
    const markup = renderToStaticMarkup(
      <PageActionsPanel
        tabId="tab-1"
        pageTitle="An example"
        pageUrl="https://example.com/article"
        site={site}
        close={vi.fn()}
        manageSecurity={vi.fn()}
      />,
    );

    expect(markup).toContain("Page Security");
    expect(markup).toContain("Save for later");
    expect(markup).toContain("Share page");
    expect(markup).toContain("Connection, permissions and site data");
    expect(markup).toContain("Keep a static copy available offline");
    expect(markup).toContain("Try Smart Reader");
    expect(markup.match(/class="page-action-row"/g)).toHaveLength(4);
    expect(markup).not.toContain("qrserver");
  });
});
