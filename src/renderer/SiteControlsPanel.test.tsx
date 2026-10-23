import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  WebsiteControlSnapshot,
  WebsiteControlsSnapshot,
} from "../shared/browser";
import {
  SiteControlsPanel,
  WebsitePermissionsDashboard,
} from "./SiteControlsPanel";

const site: WebsiteControlSnapshot = {
  origin: "https://example.com",
  hostname: "example.com",
  hasStoredData: true,
  decisions: {
    camera: "ask",
    microphone: "allow",
    location: "block",
    notifications: "ask",
    popups: "ask",
    clipboard: "ask",
    autoplay: "ask",
    downloads: "ask",
    network: "allow",
    javascript: "allow",
    hyperdrive: "block",
  },
};

const snapshot: WebsiteControlsSnapshot = {
  secureDns: { mode: "secure", providerUrl: "https://dns.google/dns-query" },
  sites: [site],
  limitations: {
    autoplay: "Autoplay is applied on the next navigation.",
    javascript: "JavaScript is applied on the next document.",
  },
};

describe("SiteControlsPanel", () => {
  it("renders a secure site and every supported permission control", () => {
    const markup = renderToStaticMarkup(
      <SiteControlsPanel site={site} close={vi.fn()} manage={vi.fn()} />,
    );

    expect(markup).toContain("Connection is secure");
    expect(markup).toContain("example.com");
    expect(markup).toContain("Internet access");
    expect(markup).toContain("Automatic downloads");
    expect(markup).toContain("Hyperdrive");
    expect(markup).toContain("Manage all site settings");
    expect(markup.match(/<select/g)).toHaveLength(11);
  });

  it("renders the searchable exception dashboard and secure DNS provider", () => {
    const markup = renderToStaticMarkup(
      <WebsitePermissionsDashboard snapshot={snapshot} />,
    );

    expect(markup).toContain("Secure DNS");
    expect(markup).toContain("Google Public DNS");
    expect(markup).toContain("Website permissions");
    expect(markup).toContain("Microphone: allow");
    expect(markup).toContain("Location: block");
    expect(markup).toContain("Hyperdrive: block");
  });
});
