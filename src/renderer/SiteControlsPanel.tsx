import { useEffect, useMemo, useRef, useState } from "react";

import type {
  SecureDnsMode,
  SitePermissionDecision,
  SitePermissionKey,
  WebsiteControlSnapshot,
  WebsiteControlsSnapshot,
} from "../shared/browser";
import "./site-controls.css";

const permissionDetails: Array<{
  key: SitePermissionKey;
  label: string;
  icon: string;
}> = [
  { key: "camera", label: "Camera", icon: "videocam" },
  { key: "microphone", label: "Microphone", icon: "mic" },
  { key: "location", label: "Location", icon: "location_on" },
  { key: "notifications", label: "Notifications", icon: "notifications" },
  { key: "popups", label: "Pop-ups", icon: "open_in_new" },
  { key: "clipboard", label: "Clipboard", icon: "content_paste" },
  { key: "autoplay", label: "Autoplay", icon: "play_circle" },
  { key: "downloads", label: "Automatic downloads", icon: "download" },
  { key: "network", label: "Internet access", icon: "language" },
  { key: "javascript", label: "JavaScript", icon: "code" },
  { key: "hyperdrive", label: "Hyperdrive", icon: "bolt" },
];
const promptablePermissions = new Set<SitePermissionKey>([
  "camera",
  "microphone",
  "location",
  "notifications",
  "clipboard",
]);

const dnsProviders = {
  cloudflare: "https://cloudflare-dns.com/dns-query",
  google: "https://dns.google/dns-query",
  quad9: "https://dns.quad9.net/dns-query",
} as const;

function MaterialIcon({ name }: { name: string }) {
  return (
    <span className="material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

function permissionSummary(site: WebsiteControlSnapshot): string {
  const customised = Object.values(site.decisions).filter(
    (decision) => decision !== "ask",
  ).length;
  return customised === 0
    ? "Default permissions"
    : `${customised} custom permission${customised === 1 ? "" : "s"}`;
}

function siteSecurity(origin: string): {
  icon: string;
  title: string;
  description: string;
} {
  if (origin.startsWith("https://")) {
    return {
      icon: "lock",
      title: "Connection is secure",
      description: "Information you send to this site is encrypted.",
    };
  }
  return {
    icon: "warning",
    title: "Connection is not secure",
    description: "Avoid entering sensitive information on this site.",
  };
}

export function SiteControlsPanel({
  site,
  close,
  back,
  manage,
}: {
  site: WebsiteControlSnapshot;
  close: () => void;
  back?: () => void;
  manage: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const security = siteSecurity(site.origin);

  useEffect(() => heading.current?.focus(), [site.origin]);

  const updatePermission = async (
    key: SitePermissionKey,
    decision: SitePermissionDecision,
  ) => {
    setBusy(true);
    setNotice("");
    try {
      await window.chromecraft.setWebsitePermission(site.origin, key, decision);
      setNotice(
        `${permissionDetails.find((item) => item.key === key)?.label ?? key} updated`,
      );
    } catch {
      setNotice("That permission could not be updated");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="site-controls-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby="site-controls-title"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (back) back();
          else close();
        }
      }}
    >
      <header className="site-controls-header">
        {back ? (
          <button
            type="button"
            className="site-controls-icon-button"
            aria-label="Back to page actions"
            onClick={back}
          >
            <MaterialIcon name="arrow_back" />
          </button>
        ) : (
          <span className="site-controls-identity" aria-hidden="true">
            {site.hostname.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="site-controls-heading-copy">
          <h2 id="site-controls-title" ref={heading} tabIndex={-1}>
            {site.hostname}
          </h2>
          <small>{permissionSummary(site)}</small>
        </span>
        <button
          type="button"
          className="site-controls-icon-button"
          aria-label="Close site controls"
          onClick={close}
        >
          <MaterialIcon name="close" />
        </button>
      </header>

      <div
        className="site-security-summary"
        data-secure={security.icon === "lock"}
      >
        <span className="site-security-icon">
          <MaterialIcon name={security.icon} />
        </span>
        <span>
          <strong>{security.title}</strong>
          <small>{security.description}</small>
        </span>
      </div>

      <div className="site-controls-section-heading">
        <span>Permissions and content</span>
        <small>Changes apply to this site</small>
      </div>
      <div className="site-permission-list">
        {permissionDetails.map((permission) => (
          <label className="site-permission-row" key={permission.key}>
            <span className="site-permission-icon">
              <MaterialIcon name={permission.icon} />
            </span>
            <span>{permission.label}</span>
            <select
              aria-label={`${permission.label} permission`}
              value={site.decisions[permission.key]}
              disabled={busy}
              onChange={(event) =>
                void updatePermission(
                  permission.key,
                  event.target.value as SitePermissionDecision,
                )
              }
            >
              <option value="ask">
                {promptablePermissions.has(permission.key)
                  ? "Ask (default)"
                  : "Default"}
              </option>
              <option value="allow">Allow</option>
              <option value="block">Block</option>
            </select>
          </label>
        ))}
      </div>

      <div className="site-controls-data-row">
        <span className="site-permission-icon">
          <MaterialIcon name="database" />
        </span>
        <span>
          <strong>Site data</strong>
          <small>
            {site.hasStoredData === false
              ? "No stored data detected"
              : "Cookies, cache and local storage"}
          </small>
        </span>
        <button
          type="button"
          className="site-controls-text-button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setNotice("");
            void window.chromecraft
              .clearWebsiteData(site.origin)
              .then(() => setNotice("Site data cleared"))
              .catch(() => setNotice("Site data could not be cleared"))
              .finally(() => setBusy(false));
          }}
        >
          Clear
        </button>
      </div>

      <footer className="site-controls-footer">
        <span
          className="site-controls-live-status"
          role="status"
          aria-live="polite"
        >
          {notice}
        </span>
        <button type="button" className="site-controls-manage" onClick={manage}>
          <MaterialIcon name="tune" />
          Manage all site settings
        </button>
      </footer>
    </section>
  );
}

function currentDnsChoice(snapshot: WebsiteControlsSnapshot): string {
  if (snapshot.secureDns.mode !== "secure") return snapshot.secureDns.mode;
  const known = Object.entries(dnsProviders).find(
    ([, url]) => url === snapshot.secureDns.providerUrl,
  );
  return known?.[0] ?? "custom";
}

export function WebsitePermissionsDashboard({
  snapshot,
}: {
  snapshot: WebsiteControlsSnapshot;
}) {
  const [query, setQuery] = useState("");
  const [customDns, setCustomDns] = useState(
    currentDnsChoice(snapshot) === "custom"
      ? (snapshot.secureDns.providerUrl ?? "")
      : "",
  );
  const [dnsChoice, setDnsChoice] = useState(currentDnsChoice(snapshot));
  const [dnsStatus, setDnsStatus] = useState("");
  const filteredSites = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return snapshot.sites;
    return snapshot.sites.filter(
      (site) =>
        site.hostname.toLocaleLowerCase().includes(needle) ||
        site.origin.toLocaleLowerCase().includes(needle),
    );
  }, [query, snapshot.sites]);

  const saveDns = (choice: string, customValue = customDns) => {
    let mode: SecureDnsMode;
    let providerUrl: string | undefined;
    if (choice === "system" || choice === "automatic") {
      mode = choice;
    } else {
      mode = "secure";
      providerUrl =
        choice === "custom"
          ? customValue.trim()
          : dnsProviders[choice as keyof typeof dnsProviders];
    }
    setDnsStatus("");
    void window.chromecraft
      .setSecureDns(mode, providerUrl)
      .then(() => setDnsStatus("Secure DNS updated"))
      .catch(() => setDnsStatus("Enter a valid HTTPS DNS provider URL"));
  };

  return (
    <div className="website-permissions-dashboard">
      <section className="settings-card" aria-labelledby="secure-dns-title">
        <header className="settings-card-header">
          <span className="settings-card-icon">
            <MaterialIcon name="dns" />
          </span>
          <span>
            <h3 id="secure-dns-title">Secure DNS</h3>
            <p>Choose how Chromecraft resolves website addresses.</p>
          </span>
        </header>
        <label className="setting-row setting-row-stacked">
          <span className="setting-copy">
            <span className="setting-title">DNS provider</span>
            <small className="setting-description">
              Secure mode sends DNS requests only to the provider you choose.
            </small>
          </span>
          <select
            className="settings-select"
            aria-label="Secure DNS provider"
            value={dnsChoice}
            onChange={(event) => {
              setDnsChoice(event.target.value);
              if (event.target.value !== "custom") saveDns(event.target.value);
            }}
          >
            <option value="system">Use system DNS</option>
            <option value="automatic">Automatic secure DNS</option>
            <option value="cloudflare">Cloudflare (1.1.1.1)</option>
            <option value="google">Google Public DNS</option>
            <option value="quad9">Quad9</option>
            <option value="custom">Custom provider</option>
          </select>
        </label>
        {dnsChoice === "custom" && (
          <form
            className="secure-dns-custom"
            onSubmit={(event) => {
              event.preventDefault();
              saveDns("custom");
            }}
          >
            <input
              type="url"
              value={customDns}
              required
              aria-label="Custom secure DNS template"
              placeholder="https://example.com/dns-query"
              onChange={(event) => setCustomDns(event.target.value)}
            />
            <button type="submit" className="tonal-button">
              Save provider
            </button>
          </form>
        )}
        <span className="secure-dns-status" role="status" aria-live="polite">
          {dnsStatus}
        </span>
      </section>

      <section
        className="settings-card"
        aria-labelledby="site-exceptions-title"
      >
        <header className="settings-card-header site-exceptions-header">
          <span className="settings-card-icon settings-card-icon-tertiary">
            <MaterialIcon name="web_traffic" />
          </span>
          <span>
            <h3 id="site-exceptions-title">Website permissions</h3>
            <p>Review every website with customised access.</p>
          </span>
        </header>
        <label className="site-exceptions-search">
          <MaterialIcon name="search" />
          <input
            type="search"
            value={query}
            placeholder="Search websites"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="site-exceptions-list" aria-live="polite">
          {filteredSites.map((site) => {
            const decisions = permissionDetails.filter(
              ({ key }) => site.decisions[key] !== "ask",
            );
            return (
              <article className="site-exception-item" key={site.origin}>
                <span className="site-exception-avatar" aria-hidden="true">
                  {site.hostname.slice(0, 1).toUpperCase()}
                </span>
                <span className="site-exception-copy">
                  <strong>{site.hostname}</strong>
                  <small>{site.origin}</small>
                  <span className="site-exception-chips">
                    {decisions.map(({ key, label }) => (
                      <span data-decision={site.decisions[key]} key={key}>
                        {label}: {site.decisions[key]}
                      </span>
                    ))}
                  </span>
                </span>
                <button
                  type="button"
                  className="site-controls-text-button"
                  onClick={() =>
                    void window.chromecraft.resetWebsitePermissions(site.origin)
                  }
                >
                  Reset
                </button>
              </article>
            );
          })}
          {filteredSites.length === 0 && (
            <div className="site-exceptions-empty">
              <MaterialIcon name="verified_user" />
              <strong>No matching exceptions</strong>
              <span>
                Websites using the default permissions do not appear here.
              </span>
            </div>
          )}
        </div>
        <details className="site-controls-limitations">
          <summary>Browser-engine notes</summary>
          <p>{snapshot.limitations.autoplay}</p>
          <p>{snapshot.limitations.javascript}</p>
        </details>
      </section>
    </div>
  );
}
