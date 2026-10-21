# Hyperdrive: Electron/Chromium capability research

Research date: 2026-10-15  
Target: Chromecraft on Electron 44.7.2 / Chromium 152.0.7977.149

## Executive conclusion

Hyperdrive can safely provide real acceleration in this build through DNS resolution, connection warming, and cache-populating GET prefetches. It **cannot provide full-page prerendering** in Chromecraft's current `WebContentsView` architecture. A probe against the exact installed runtime accepted Speculation Rules syntax but Chromium rejected prerender with `PreloadingUnsupportedByWebContents`; the eventual navigation had `activationStart = 0`. Speculation Rules prefetch also registered a rule but did not issue a request. These tiers must stay disabled unless a future Electron upgrade passes a runtime capability-and-activation test.

The strongest defensible implementation for this release is therefore:

1. `browserSession.resolveHost()` for bounded DNS warming.
2. `browserSession.preconnect()` for one-socket origin warming.
3. A cancellable `browserSession.fetch()` GET, or same-site `<link rel="prefetch">`, for eligible public navigation documents.
4. Ordinary navigation in the existing tab, with measured cache reuse.

This is meaningful acceleration, but it is not a prepared page. The monitor may say **Connecting** or **Prefetched**; it must not say **Ready** or **Preparing page** for these operations.

## Exact runtime and current architecture

- `package.json` pins `electron` to `44.7.2`. Electron's release record maps that build to Chromium `152.0.7977.149`, Node `24.21.0`, and V8 `15.2.124.37` ([Electron 44.7.2 release](https://releases.electronjs.org/release/v44.7.2)).
- `src/main/main.ts` creates one persistent `persist:chromecraft-default` Session and passes it to the tab manager, download manager, search suggestions, and uBlock service. Electron enables a Session's HTTP cache by default, and a `persist:` partition stores the session persistently ([Electron Session API](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options)).
- Each loaded browser tab owns a sandboxed `WebContentsView` using that shared Session. `nodeIntegration` is off, context isolation and the Chromium sandbox are on, and the permission policy is default-deny (`src/main/tab-manager.ts`). Inactive tabs remain real but invisible views; unloaded/restored tabs are materialized lazily.
- The trusted React shell is a separate local `WebContentsView`; page content does not receive its typed preload API (`src/main/main.ts`, `src/preload/preload.ts`).
- uBlock Origin is loaded into the same browser Session before remote navigation (`src/main/ublock-service.ts`). Its compatibility layer leaves uBlock's `chrome.webRequest` filtering path intact (`resources/extensions/ublock-origin/js/chromecraft-compat.js`).
- Preferences are an atomic local JSON file under Electron's user-data directory (`src/main/preferences.ts`). Hyperdrive settings should extend this store rather than introduce another persistence mechanism.

## Capability matrix

| Mechanism                                  | Status in Electron 44.7.2                                            | Hyperdrive use                     | Important limits                                                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DNS warming                                | Supported: `Session.resolveHost()`                                   | Tier 1                             | Use `source: "any"`; it can resolve from cache, hosts, the OS, or DNS. A result can be ignored but there is no cancellation handle.                                                                                    |
| Socket/TLS warming                         | Supported: `Session.preconnect()`                                    | Tier 1                             | Only the origin is used; 1-6 sockets are allowed. The call has no per-request completion/cancellation API. Use one socket and a short origin TTL.                                                                      |
| Chromium Session fetch                     | Supported: `Session.fetch()`                                         | Tier 2                             | Uses Chromium's network stack and triggers `webRequest`; use `AbortController`, a byte cap, GET only, and privacy-safe credentials/referrer policy. Cache reuse still depends on response and request cache semantics. |
| `<link rel="prefetch">` in the active page | Supported in the exact runtime probe                                 | Tier 2, preferably same-site       | Fetches/caches the named resource, not the destination's dependency graph. Cross-site reuse is undermined by cache partitioning; keep cross-site off by default.                                                       |
| Speculation Rules `prefetch`               | Not operational in the exact `WebContentsView` probe                 | Disabled                           | Chromium parsed the rule and reported its source but did not start a request or emit a successful prefetch state. Do not build the engine around it.                                                                   |
| Speculation Rules `prerender`              | Explicitly unsupported in the exact `WebContentsView` probe          | Disabled                           | CDP reported `PreloadingUnsupportedByWebContents`; navigation was a normal load with `activationStart = 0`.                                                                                                            |
| Hidden prepared `WebContentsView`          | Technically loadable, not a safe navigation primitive                | Rejected                           | It is a fully executing hidden page, not a Chromium prerender, and Electron has no API to atomically activate it into the current tab's navigation controller.                                                         |
| HTTP cache inspection                      | Supported: `Session.getCacheSize()`                                  | Whole-session diagnostics only     | This is the entire Session cache, not speculative RAM or per-entry usage.                                                                                                                                              |
| Selective speculative cache eviction       | No public API                                                        | Not available                      | `clearCache()` clears the Session's entire HTTP cache. Do not erase normal browsing cache when the user clears Hyperdrive work.                                                                                        |
| App/process memory and CPU                 | Supported: `app.getAppMetrics()` and `process.getSystemMemoryInfo()` | Pressure guard and observed totals | Renderer processes may be shared, and network/GPU/cache costs are not attributable exactly to one prediction. Report estimates or deltas, not exact per-destination RAM.                                               |

Electron documents `resolveHost`, `preconnect`, `fetch`, cache size, and cache clearing on its [Session API](https://www.electronjs.org/docs/latest/api/session). `Session.fetch()` uses Chromium's network stack and triggers Session `webRequest` handlers, so requests issued through Chromecraft's browser Session remain in uBlock's filtering path ([Electron Session fetch](https://www.electronjs.org/docs/latest/api/session#sesfetchinput-init)).

The HTML Standard defines `prefetch` as preemptively fetching and caching a resource or same-site document likely to be used by a later navigation ([WHATWG link type `prefetch`](https://html.spec.whatwg.org/dev/links.html#link-type-prefetch)). It is not a full-page load. Chrome's own Speculation Rules tooling likewise distinguishes document-only prefetch from prerender, which loads and renders a page in a separate renderer ([Chrome DevTools speculative-load documentation](https://developer.chrome.com/docs/devtools/application/debugging-speculation-rules)).

Chrome keys its HTTP cache with a Network Isolation Key containing the top-level and current-frame sites, not just the URL. That is why a cross-site resource prefetch initiated by the current page cannot be assumed reusable after top-level navigation to another site ([Chrome HTTP cache partitioning](https://developer.chrome.com/blog/http-cache-partitioning)).

## Exact-runtime probe results

A disposable local HTTP fixture was run in a sandboxed `WebContentsView` configured like a Chromecraft tab. The probe used the installed Electron binary, attached the Chrome DevTools Protocol `Preload` domain, and measured the destination's Navigation Timing entry plus server request counts. No probe code was retained in the repository.

| Probe                                    | Result                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature detection                        | `HTMLScriptElement.supports("speculationrules")` returned `true`. Syntax availability alone was therefore not sufficient evidence.                                                                              |
| Speculation Rules prerender              | `Preload.prerenderStatusUpdated` returned `status: "Failure"` and `prerenderStatus: "PreloadingUnsupportedByWebContents"`. Only the eventual real navigation requested the document; `activationStart` was `0`. |
| Speculation Rules prefetch               | The rule set and attempt source appeared, but no prefetch request or successful prefetch status occurred before navigation.                                                                                     |
| `<link rel="prefetch">`                  | The destination was requested once before navigation; navigation caused no second server request and reported `transferSize: 0`.                                                                                |
| `Session.fetch()` with the body consumed | The destination was requested once before navigation; navigation caused no second server request and reported `transferSize: 0`.                                                                                |

For this same-origin fixture, the server count plus zero navigation transfer size proves cache reuse, rather than merely proving that bytes were downloaded. The Resource Timing specification defines a zero transfer size for a locally cached response ([W3C Resource Timing](https://w3c.github.io/resource-timing/#dom-performanceresourcetiming-transfersize)). This does **not** guarantee reuse for arbitrary sites: `Cache-Control`, `Vary`, cookies, redirects, service workers, authentication, request credentials, and cache partition keys can all change the result. Every benchmark must measure the subsequent navigation.

## Why hidden WebContentsViews are not Tier 3

Electron can construct multiple `WebContentsView` objects and can adopt a `WebContents` into one view at a time ([WebContentsView API](https://www.electronjs.org/docs/latest/api/web-contents-view)). That is insufficient for safe prerender activation:

- A hidden view executes page JavaScript with the normal Session, cookies, storage, service workers, and network permissions. It lacks native prerender's delayed/restricted API behavior. It can therefore run analytics or state-changing GET behavior before the user chooses to navigate.
- Swapping a hidden view into a tab is not the same operation as activating a Chromium prerender in the current navigation controller. It risks losing or altering history, opener/referrer behavior, SPA state, focus, downloads, audio, and the original page's navigation semantics.
- `WebContents.clone()` only produces an independent empty WebContents that can reuse the same-origin renderer process; Electron explicitly says it contains no open page. It is not a snapshot or prepared-navigation API ([Electron `webContents.clone`](https://www.electronjs.org/docs/latest/api/web-contents#contentsclone)).
- Each speculative view would require all current tab lifecycle and safety handlers. Electron warns that child `WebContentsView` contents are not destroyed automatically and leak unless explicitly closed ([Electron BaseWindow resource management](https://www.electronjs.org/docs/latest/api/base-window#resource-management)).

Native Chrome prerender normally provides a genuine activation signal: a successfully activated page has non-zero `PerformanceNavigationTiming.activationStart` ([Chrome prerender measurement](https://developer.chrome.com/docs/web-platform/prerender-pages#measure-prerenders)). Chromecraft's exact runtime returned zero and the embedder rejection above. Hyperdrive should disable Tier 3 instead of emulating it.

## Recommended implementation boundary

### Central scheduler in the main process

Use one scheduler owning all pointer and Omnibox predictions so they share candidate, network, and byte budgets. It should receive sanitized candidates and never give a remote renderer authority to start unrestricted requests.

- Validate `http:`/`https:` URLs and reject credentials, non-default sensitive ports, IP/local-network targets unless explicitly allowed, state-changing path keywords, downloads, and configured exclusions.
- Default to same-site speculation. Require a separate explicit preference before cross-site speculation.
- Deduplicate by normalized URL and origin. Omnibox selection should raise priority rather than start a duplicate operation.
- Maintain small, fixed candidate limits. Ranking and event publication should be synchronous and bounded; networking should begin only after debounce/stability thresholds.
- On disable, abort in-flight `Session.fetch()` calls, remove injected prefetch elements/rules, discard queues and locally learned candidates, and release instrumentation. Do not call `Session.closeAllConnections()`: Electron warns that it terminates **all** in-flight requests, including real page loads. Do not call `clearCache()`: it clears normal browsing cache too ([Electron Session API](https://www.electronjs.org/docs/latest/api/session#sescloseallconnections)).

### Pointer instrumentation

The current remote views have no preload. A minimal sandboxed page-instrumentation preload is the lowest-overhead reliable seam for pointer samples and visible-link geometry. Keep context isolation and the sandbox enabled, expose no API to the page, send only validated/sanitized link data to the main process, and verify the sender belongs to a managed tab. Electron's security guidance requires Node integration to stay disabled for remote content ([Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)).

Do not repeatedly call `executeJavaScript()` on mouse movement. Electron documents that `executeJavaScript()` can be suspended until page loading stops, and serialization plus IPC would put work on the interaction path ([Electron webContents API](https://www.electronjs.org/docs/latest/api/web-contents#contentsexecutejavascriptcode-usergesture)). Compute cursor trajectory in the isolated renderer, rebuild geometry on scroll/resize/mutation at a throttle, and send only the top bounded candidates.

### Tier policy

- **Low confidence:** call `resolveHost(host, { source: "any" })` once per host TTL or go directly to one-socket `preconnect`; preconnect already includes the useful connection setup. Do not create 6 sockets per prediction.
- **Medium/high confidence public GET:** use `browserSession.fetch()` with an `AbortSignal`, no-store-sensitive exclusions, a strict response/body byte ceiling, and credentials omitted by default. Consume the response stream while counting bytes; do not retain the body in JavaScript. Label completion **Prefetched**, not **Ready**.
- **Same-site active-page candidates:** `<link rel="prefetch">` is an alternative that gives Chromium the source-document context and worked in the runtime probe. Remove the element on cancellation, but do not claim that removal always recalls bytes already sent.
- **Full page:** disabled for Electron 44.7.2 `WebContentsView`. Keep a capability probe behind tests so a later Electron upgrade can enable it only after CDP reports `Ready`/`Success` and the following navigation has non-zero `activationStart`.

## uBlock and network observation constraints

Use the existing `browserSession` for every Hyperdrive network operation. Electron states that `Session.fetch()` triggers `webRequest`, so the bundled extension remains able to block the request. A separate speculative Session would evade the user's live Session/cookies/proxy/cache, and its cache could not accelerate a normal tab.

DNS resolution and socket preconnection do not create an HTTP request, so uBlock cannot veto them through `webRequest`. Restrict Tier 1 to the already policy-approved, user-visible navigation origin; never warm arbitrary third-party subresource origins discovered on a page. Cross-site Tier 1 should remain off unless the user explicitly enables it and a blocker-aware eligibility path exists.

Do **not** install ad-hoc Session `webRequest` listeners for the monitor. Electron warns that only the last listener attached to each `WebRequest` event is used ([Electron WebRequest API](https://www.electronjs.org/docs/latest/api/web-request)). Adding instrumentation there risks colliding with browser or blocker integration. Prefer scheduler-owned events, Navigation/Resource Timing, and short-lived benchmark-only NetLog/CDP instrumentation.

The bundled uBlock configuration defaults `prefetchingDisabled` to true, and `resources/extensions/ublock-origin/js/vapi-background-ext.js` adds `X-DNS-Prefetch-Control: off` to page responses. Hyperdrive's direct Session DNS/preconnect calls are browser-owned, opt-in work and should not alter that uBlock preference or remove those headers.

## Memory and pressure handling

Electron exposes useful guardrails, but not exact per-prediction RAM accounting:

- `process.getSystemMemoryInfo()` reports total/free memory on Windows and Linux; Linux additionally exposes `available`, explicitly recommended by Electron as the no-swap pressure signal. Windows and Linux expose swap totals/free values ([Electron process API](https://www.electronjs.org/docs/latest/api/process#processgetsystemmemoryinfo)).
- `app.getAppMetrics()` reports memory and interval CPU usage for all Electron app processes. CPU samples are interval-based and shared by all callers ([Electron app metrics](https://www.electronjs.org/docs/latest/api/app#appgetappmetrics)).
- `webContents.getOSProcessId()` can associate a view with a renderer PID, but Chromium may share a renderer between same-origin WebContents; network, GPU, shared memory, and cache costs live elsewhere. A per-destination number must therefore be marked **estimated** ([Electron webContents process APIs](https://www.electronjs.org/docs/latest/api/web-contents#contentsgetosprocessid)).
- `Session.getCacheSize()` is whole-session cache bytes, not RAM and not speculative-only bytes. `Session.clearCache()` is correspondingly global.

Treat the configured RAM number as a scheduler ceiling over estimated in-flight work, candidate count, and any future prepared-view cost—not as permission to fill memory. Evict/cancel low-confidence fetches when Linux `available` memory or Windows `free` memory crosses a conservative threshold, when swap begins tightening, or when app-wide working-set deltas exceed the budget. With Tier 3 disabled, most Hyperdrive memory is scheduler metadata and transient response streaming; report fetched bytes separately from RAM.

## Accurate monitor and benchmark signals

The monitor can report these states honestly:

- **Predicted / Queued:** produced by the deterministic ranker/scheduler.
- **Connecting:** DNS/preconnect requested; Electron does not expose per-preconnect completion, so do not upgrade it to Ready.
- **Prefetching:** a live cancellable fetch or injected prefetch.
- **Prefetched:** the response completed within policy and byte caps.
- **Activated:** the user navigated to the exact predicted URL.
- **Reused:** only after evidence such as a fixture server request count, Electron `fromCache`, or same-origin Navigation Timing confirms cache delivery.
- **Cancelled / Failed / Evicted:** emitted from actual AbortController, error, timeout, policy, or budget transitions.
- **Ready / Preparing page:** unavailable in this Electron build and should not be emitted.

For repeatable benchmarks:

1. Use a local deterministic HTTPS/HTTP fixture with explicit `Cache-Control`, configurable response/resource delays, request and byte counters, and pages large enough to make differences measurable.
2. Run randomized/interleaved Off, Balanced, Aggressive, and Maximum trials from fresh profiles and warmed profiles. Separate DNS/connect wins from document-cache wins.
3. Measure prediction duration with `performance.now()`, real clicked top-1 precision, wasted bytes, cancellation rate, app metrics deltas, navigation `responseStart`, DOM milestones, FCP/LCP where exposed, and `did-finish-load`.
4. Count reuse only when the navigation itself proves it. Resource Timing defines cache delivery semantics; `activationStart` is reserved for genuine prerender activation.
5. Use Electron's `Session.netLog` only for bounded development benchmark runs. Default capture records metadata; sensitive modes can include cookies/authentication or all socket bytes, so never enable them for the live sidebar or persist them by default ([Electron NetLog API](https://www.electronjs.org/docs/latest/api/net-log)).

## Windows and Linux Mint portability

All recommended runtime primitives—Session host resolution, preconnect, fetch/cache, WebContentsView, app metrics, and process memory information—are cross-platform Electron APIs. The current Forge configuration already packages `win32-x64` and `linux-x64`, and no recommendation here adds a native dependency. Electron officially publishes `win32` and `linux` binaries and documents x64 as a supported architecture ([Electron installation/platforms](https://www.electronjs.org/docs/latest/tutorial/installation#advanced-installation-instructions)).

The one platform branch is memory pressure: prefer `available` on Linux Mint and use conservative `free`/swap thresholds on Windows. Linux packaging is not Linux runtime verification; the Hyperdrive benchmark and cleanup suite still needs to run on an actual Linux Mint host.

## Decision record

- Implement Tier 1 and cancellable Tier 2 now.
- Keep Hyperdrive opt-in and same-site by default.
- Preserve the existing shared Session so cache, proxy, authentication policy, and uBlock remain consistent.
- Do not attach extra `Session.webRequest` listeners.
- Do not create hidden speculative tabs/views.
- Do not claim exact speculative RAM, page readiness, or time saved without observed reuse and paired navigation measurements.
- Disable Tier 3 on Electron 44.7.2; reconsider only when an exact-runtime test proves supported prerender and actual activation.
