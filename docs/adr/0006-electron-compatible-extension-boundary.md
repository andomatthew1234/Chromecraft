# Support verified Electron-compatible extensions

Chromecraft will support user-installed extensions that can run within
Electron's documented Chrome extension subset. A browser-owned installer may
download Chrome Web Store CRX3 packages, but it must verify the package
signature and requested extension ID, safely extract the package into the local
Default Profile, obtain explicit confirmation in the Browser Shell, and reload
enabled extensions into the persistent Session on every launch.

Chromecraft will not claim complete Chrome Web Store compatibility. Stock
Electron does not implement Chrome's store installer, does not load packed CRX
files directly, and exposes only part of the Chrome extension platform. An
extension is described as loaded only after Electron accepts its unpacked
directory; unsupported APIs and toolbar-action limitations remain visible to
the user. Browser-owned anchored action popups and narrowly scoped compatibility
bridges are allowed when their behavior is tested and documented. Such bridges
must not report unsupported permissions as granted or turn a partial load into
a claim that security-sensitive workflows are safe.

A compatibility bridge may host a separate extension-owned window only when the
request is authenticated as coming from an enabled extension, the requested URL
has that same extension origin, the window uses the existing sandboxed Session,
its geometry is bounded, cross-origin navigation is blocked, and its lifecycle
is covered by a packaged or real-profile runtime test. This exception exists for
flows such as a password manager's passkey hand-off; it is not a general
`window.open` capability for websites.

The extension registry and extracted packages remain local. User extensions
load with file access disabled, remote pages cannot invoke extension-management
IPC, and only exact origins belonging to currently loaded extensions may open as
internal browser pages. The bundled uBlock Origin lifecycle remains separate so
its pinned compatibility bridge and readiness checks cannot be removed through
the generic manager.

## Considered options

- Pretend Chromecraft is Google Chrome and rely on the Web Store button. Rejected:
  it does not provide an installer or missing extension APIs.
- Pass CRX files directly to Electron. Rejected: Electron accepts only unpacked
  directories.
- Load unverified ZIP/CRX downloads. Rejected: extensions are privileged code
  that can read or modify matching sites.
- Replace Electron with a Chromium fork. Deferred as a separate architecture
  decision because it replaces the browser foundation and creates a substantial
  security/update maintenance obligation.
