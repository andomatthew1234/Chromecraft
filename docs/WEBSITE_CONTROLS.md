# Website controls

Chromecraft stores website decisions locally in the active profile's
`website-controls.json`. Keys are canonical HTTP or HTTPS origins; paths,
queries, fragments, credentials, browser-internal URLs, and extension URLs are
not retained as permission identities. Blob URLs inherit their HTTPS origin.

## Enforcement

- Camera and microphone use Electron's `media` permission with the requested
  media types separated into the two user-visible controls.
- Location, notifications, and clipboard use Electron's session permission
  check and request handlers. `Allow once` grants are tied to a WebContents and
  are revoked when its tab is deactivated, its document navigates, it is
  discarded, or it closes.
- Network blocking cancels requests whose target or initiating document is a
  blocked origin. It does not change proxy, firewall, or operating-system
  policy outside Chromecraft.
- JavaScript blocking cancels script requests and adds a restrictive
  `script-src`/`worker-src` policy to subsequent document responses. A reload is
  required after changing the setting. Chromium service workers that were
  already running may finish in-flight work.
- Popup blocking is applied to website-created windows before Chromecraft turns
  them into tabs. Electron does not expose Chrome's native per-origin popup
  content-setting prompt, so `Ask` preserves the browser's existing new-tab
  behaviour and `Block` rejects it.
- Automatic-download blocking cancels website downloads before a file is
  created. Electron does not expose Chromium's multiple-automatic-download
  gesture classifier, so `Ask` continues to permit explicit downloads and
  `Block` is the enforceable restriction.
- Autoplay blocking is applied by the isolated page preload on the next
  document load. Electron does not expose Chromium's native per-origin autoplay
  content setting, so already-playing media is not retroactively stopped when
  the setting changes.
- A Hyperdrive block is mirrored into Hyperdrive's excluded-host list. Other
  Hyperdrive safety rules can still deny preparation when a site is explicitly
  allowed here.

## Secure DNS

`System` disables Chromium DNS-over-HTTPS, `Automatic` uses Chromium's secure
DNS upgrade behaviour, and `Secure` requires an HTTPS DNS-over-HTTPS provider
template. Applying a change clears Chromium's resolver cache and closes pooled
connections. The setting does not alter DNS used by other applications.

## Clearing data

The clear-site-data action uses Electron's origin-scoped browsing-data API for
cookies, caches, local storage, IndexedDB, file systems, service workers, WebSQL,
and background fetch data. It does not clear another site's HTTP authentication
state or storage.
