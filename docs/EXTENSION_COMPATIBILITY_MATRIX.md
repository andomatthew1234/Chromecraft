# Extension compatibility matrix

Chromecraft's extension checks distinguish **package loading** from **working
browser behavior**. A ready status from Electron is necessary, but it does not
prove that an extension's APIs or user flows work.

## Deterministic packaged matrix

`scripts/test-extension-compatibility-matrix.mjs` launches the packaged Windows
browser with a disposable profile, a local HTTP origin, and one deterministic
Manifest V3 extension. The fixture requests the same API families used by
content modifiers, password managers, productivity extensions, and network
observers. Every row records observable evidence independently, so one failed
API does not conceal later results.

Run it with the repository's required Node version after packaging:

```powershell
pnpm package:win
node scripts/test-extension-compatibility-matrix.mjs
```

The machine-readable report is written to
`.artifacts/extensions/extension-compatibility-matrix.json`; Electron output is
written beside it as `extension-compatibility-matrix.log`. The command exits
nonzero when any required capability fails or the complete ten-row matrix does
not run.

| Category            | Behavior proved by the harness                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Lifecycle           | A persisted MV3 extension is enabled and ready after startup.                                        |
| Content scripts     | A declared matching script actually changes a web document.                                          |
| Storage             | A content script writes and reads `storage.local`.                                                   |
| Runtime messaging   | A content script receives a response from the MV3 worker.                                            |
| Background          | The MV3 service worker starts as a real Chromium target.                                             |
| Tabs                | `tabs.query` returns the active website tab with an integer ID.                                      |
| Scripting           | `scripting.executeScript` resolves and demonstrably changes the target DOM.                          |
| Network observation | `webRequest.onBeforeRequest` observes a matching request and records it.                             |
| Toolbar action      | Clicking the browser-owned action opens a rendered anchored popup.                                   |
| Popup APIs          | The popup reads its manifest and shared storage, and sees the same active website tab as the worker. |

## Current packaged evidence

The latest 2026-10-21 run against
`out/Chromecraft-win32-x64/chromecraft.exe` passed all ten rows. The packaged
test now proves lifecycle, content-script, storage, runtime-message, MV3-worker,
tab-query, scripting, MV3 network-observation, toolbar-popup, and popup API
behavior. Chromecraft's popup compatibility layer resolves
`tabs.query({ active: true })` to the active website tab rather than the popup's
own WebContents target.

The network row is backed by a browser-owned MV3 bridge rather than a reported
namespace alone. Electron 44.7.2 and 44.9.3 expose a listener-shaped API in MV3
workers but do not route matching requests to it. Chromecraft now authenticates
the worker from its `ServiceWorkerMain` scope, validates `webRequest` and host
permissions in the main process, receives events from a bundled internal MV2
observer, wakes a suspended worker, and dispatches the real matching request to
its registered listener. The internal observer uses Electron's native extension
event path, so it coexists with uBlock instead of replacing its request handler.
This first slice is observational `onBeforeRequest`; blocking responses, header
stages, request-body access, and the remaining event family are not yet claimed.

Passing this deterministic matrix proves only these named behaviors; broad
Chrome Web Store compatibility still requires more matrices for bookmarks,
downloads, context menus, commands, notifications, identity/authentication,
native messaging, devtools, offscreen documents, side panels, declarative APIs,
the remaining `webRequest` stages, and security-sensitive end-to-end flows such
as password-manager autofill and passkeys.

## Relationship to the other validators

- `test-packaged-extensions.mjs` covers install-state lifecycle, action popup
  toggling, disable/re-enable, uninstall cleanup, and its own MV3 worker
  handshake.
- `diagnose-web-store-extension.mjs` uses a real signed Web Store package and
  records Electron warnings, but does not prove every feature of that package.
- `validate-real-bitwarden-popup.mjs` and
  `validate-real-bitwarden-window-bridge.mjs` exercise Bitwarden-specific popup
  and extension-window integration against the local profile.
- The compatibility matrix fills the missing middle: deterministic API behavior
  with a disposable package, explicit assertions, and per-capability results.
