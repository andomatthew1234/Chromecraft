# Extensions in Chromecraft

Chromecraft provides a browser-owned installer and manager for extensions that
fit Electron's extension runtime. When a Chrome Web Store listing is open, an
88-pixel browser-owned banner appears below the navigation and bookmarks bars.
It is outside the website `WebContentsView`, so Chromecraft never rewrites the
Web Store page. The same listing URL can be pasted into the **Extensions**
sidebar.

## Installation pipeline

1. Accept only an HTTPS `chromewebstore.google.com/detail/.../<id>` URL.
2. **Review & install** requests the package from Google's Chrome Web Store
   update service without cookies and reports truthful byte progress when the
   server supplies a content length.
3. Enforce download, archive-entry, extracted-size, and entry-count limits.
4. Require CRX3 and verify an RSA or ECDSA proof over the signed header and ZIP.
5. Derive the extension ID from the signing key and require it to match both the
   signed header and requested Web Store ID.
6. Persist that verified public key in the unpacked manifest so Electron assigns
   the same stable extension ID that Chrome Web Store signed. Reject a manifest
   that declares a different key.
7. Reject encryption, ZIP64, unsupported compression, corrupt CRCs, duplicate
   paths, traversal, Windows-unsafe names, and symbolic links.
8. Keep one bounded verified package in memory and show its manifest name,
   version, permissions, website access, and compatibility warnings. Nothing is
   written or loaded until the user confirms this review.
9. After confirmation, extract the exact reviewed package into a new
   profile-owned temporary directory and atomically publish the verified
   version; it is not downloaded a second time.
10. Load the unpacked directory into Chromecraft's persistent browsing Session
    with local-file access disabled.
11. Persist only the extension ID, version, enabled state, and canonical source
    listing. Enabled extensions are explicitly loaded again before tabs navigate
    on the next launch.

The banner follows the actual operation through downloading, signature
verification, preparation, installation, and finishing. An installed listing
shows a green confirmation and a removal action; failures remain attributable
to that listing with retry and detail controls. Dismissal applies only to the
current tab and listing visit.

Install, enable, disable, page-opening, and removal requests cross a narrow IPC
surface available only to the local Browser Shell. Websites cannot call it.
Only exact `chrome-extension://<installed-id>/...` URLs for currently enabled and
loaded extensions may open as internal pages.

## Compatibility boundary

Electron 44 supports only a subset of Chrome's extension platform and explicitly
does not promise arbitrary Chrome Web Store compatibility. It accepts unpacked
directories rather than CRX files and forgets loaded extensions on exit unless
the application reloads them. Chromecraft handles the package and lifecycle work
but cannot invent missing Chromium browser APIs.

The manager displays requested permissions and compatibility warnings. For a
declared `action`/`browser_action` popup, Chromecraft provides a browser-owned,
anchored `WebContentsView` using the same persistent Session. It is sandboxed,
confined to the installed extension's exact origin, and destroyed when it is
closed. Options pages continue to open as internal tabs. This host reproduces
the desktop popup interaction, but it does not turn Electron into Chrome's
native ExtensionHost implementation.

Chromecraft applies a narrow compatibility bridge to classic and module-based
Manifest V3 workers and popup pages. Module workers retain their declared
module type and imports while the compatibility module runs before the original
worker module. It never reports an unsupported permission as granted and resets
only the extension's service-worker registration when the bridge changes.

For Manifest V3 `webRequest.onBeforeRequest`, Chromecraft supplies a real
browser-owned event path because Electron 44 exposes the API shape but does not
route matching requests to the worker. A service-worker preload exposes only a
small typed bridge; the main process derives the extension identity from the
trusted worker scope, re-checks the `webRequest` and host permissions, filters
requests, wakes a dormant worker, and dispatches the matching details. Ordinary
website workers and caller-provided extension IDs are rejected. The current
bridge is observation-only: it does not claim blocking, redirect, header, or
request-body behavior that has not been implemented and behaviorally tested.

For enabled extensions, the bridge also implements a deliberately narrow
`chrome.windows.create`, `chrome.windows.update`, and `chrome.windows.remove`
path. A request may open only a URL belonging to the calling extension. The
result is hosted in a separate, size-bounded, sandboxed BrowserWindow using the
same persistent Session; it cannot navigate to another extension origin, and
ordinary web links are routed back into Chromecraft tabs. This is sufficient
for extension-owned popouts such as Bitwarden's passkey hand-off window without
exposing a general website-controlled native-window API.

Current Bitwarden releases request many APIs outside Electron's documented
subset, including security-sensitive capabilities. The package may be verified
and Electron may load part of it, but Chromecraft must not claim the password
manager is fully functional without dedicated runtime tests for autofill, vault
unlock, passkeys, authentication, storage, and every security-relevant flow.

Primary runtime documentation:

- [Electron Chrome Extension Support](https://www.electronjs.org/docs/latest/api/extensions/)
- [Electron Extensions API](https://www.electronjs.org/docs/latest/api/extensions-api)
- [Chrome extension permission model](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)

## Verification

The service tests generate real signed CRX3 fixtures and cover signature/ID
validation, tampering, unsafe archive paths, compressed archives, bounded
downloads, persistence, disable/re-enable, internal-origin allowlisting, and
uninstall cleanup:

```powershell
pnpm exec vitest run src/main/chrome-web-store-extension-service.test.ts
```

The packaged extension smoke test uses a disposable profile and local HTTP page
to prove that the real Electron Session loads a persisted extension, executes its
content script, opens and closes an anchored toolbar popup without creating a
tab, disables it, reloads it, and removes it without weakening the existing
website sandbox.

```powershell
pnpm test:extensions:win
```

The Web Store diagnostic downloads the current Bitwarden package into a fresh,
disposable browser profile. It verifies that the browser-owned API can install
and load the signed package with the expected identity, opens its declared
anchored toolbar popup, confines all extracted files to that profile, records
Electron's runtime warnings, uninstalls it, and removes the test profile. This
proves installation and initial popup rendering—not Bitwarden's
security-sensitive vault, autofill, passkey, or authentication workflows.

```powershell
pnpm diagnose:extension-webstore:win
```

The real-profile popup diagnostic backs up the local browser profile, opens the
installed Bitwarden toolbar popup, verifies the WebAuthn interception hooks,
and exercises a real extension-owned BrowserWindow through
`chrome.windows.create`, `update`, and `remove`. It restores the profile and
relaunches Chromecraft after the run. The test deliberately does not submit a
credential request, unlock a vault, or authenticate to a website, so those
security-sensitive flows still require a manual end-to-end check.

```powershell
node scripts/validate-real-bitwarden-popup.mjs
```
