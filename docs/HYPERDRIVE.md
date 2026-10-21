# Chromecraft Hyperdrive

Hyperdrive is Chromecraft's opt-in speculative navigation system. It predicts a
likely destination from pointer intent or Omnibox activity, then moves only work
that Chromium can safely reuse ahead of the click or Enter key. The feature does
not create hidden tabs, weaken the sandbox, or describe a downloaded document as
a rendered page.

This document describes the implementation in Electron 44.7.2 / Chromium 152.
The exact-runtime capability investigation is in
[`docs/research/HYPERDRIVE_ELECTRON_CAPABILITIES.md`](research/HYPERDRIVE_ELECTRON_CAPABILITIES.md).

## Architecture

Hyperdrive has one main-process scheduler. Both page-pointer and Omnibox inputs
enter this scheduler, so they share policy, candidate, network, concurrency, and
memory budgets.

```text
isolated page preload ─┐
                      ├─> sanitize/bound ─> cursor + URL rankers ─> safety policy
shell Omnibox ─────────┘                                           │
                                                                   v
             active tab <link rel=prefetch> <─ scheduler <─ preconnect
                         │
                         └─ navigation timing + click outcome
                                      │
                         monitor + local aggregate learner
```

- The sandboxed page preload reads at most 320 anchors. The main-process boundary
  resolves supported redirect wrappers, canonicalises URLs, removes duplicate
  destinations, and only then applies the 80-candidate limit. Repeated anchors
  can no longer crowd a unique result out of the ranker. Geometry rebuilds after
  relevant DOM, scroll, or resize changes, not for every pointer event. Pointer
  updates are animation-frame scheduled and rate limited. Synthetic DOM events
  are ignored; only trusted pointer input can create click outcomes.
- Cursor intent uses up to four recent samples. It scores direction, velocity,
  acceleration/deceleration, adaptive path intersection, proximity, hover time,
  and a small hysteresis bonus that prevents adjacent-link jitter.
- The deterministic ranker considers no more than 64 candidates and returns no
  more than eight. Network I/O never runs on the input-ranking path.
- Omnibox selection normally outranks background pointer work. Typing,
  autocomplete, highlighted suggestions, history/bookmark signals, and search
  suggestions use the same scheduler. Stale candidates are reprioritised instead
  of rebuilding Chromium's cache.
- Google Search, YouTube, ChatGPT, GitHub, and Wikipedia have independently
  tested adapters. They add conservative priority or suppress known duplicate or
  sensitive work. Generic ranking remains the fallback when a site's markup
  changes. Google's same-origin `/url` result wrappers are resolved only when
  their target is an absolute credential-free HTTP(S) URL; unsafe or malformed
  wrappers remain untouched.
- The outcome learner persists only counters keyed by adapter and trigger. It
  stores no URL, title, query, timestamp, or raw browsing history. Early samples
  are strongly regularised and a mature bucket can adjust a score by at most 15%.

The browser shell remains the only IPC authority. Page messages are accepted only
from the managed tab's main frame. Remote pages receive no Node.js API and cannot
ask the scheduler to fetch arbitrary URLs.

## Preparation tiers and exact Electron capabilities

| Tier                  | Runtime mechanism                                                                                                                     | What it means                                                                              | What it does **not** mean                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Prediction            | Pure bounded ranking                                                                                                                  | A candidate is locally ranked                                                              | No network request occurred                                                          |
| Connection            | `Session.preconnect({ numSockets: 1 })`                                                                                               | Chromium may resolve DNS and warm one connection to an eligible origin                     | Electron exposes no completion or cancellation signal, so it is never labelled Ready |
| Document prefetch     | `<link rel="prefetch" as="document">` injected into the active page by its isolated preload                                           | Chromium fetched a cacheable document in the real page and Session context                 | It did not render the destination or prepare its dependency graph                    |
| Reuse proof           | An owned document prefetch completed before navigation and Navigation Timing reports `transferSize === 0` for the matched destination | The eventual navigation was delivered from a local cache                                   | It is not proof of prerender activation or an exact latency saving                   |
| Full-page preparation | Disabled                                                                                                                              | Electron's `WebContentsView` embedder rejected native prerender in the exact-runtime probe | There is no hidden-view substitute                                                   |

Electron 44 also exposes `Session.resolveHost()` and `Session.fetch()`. They were
verified as available, and a consumed `Session.fetch()` response populated the
same-origin HTTP cache in the probe. Production Hyperdrive prefers the active
page's prefetch hint because it carries the correct source-document, Session,
cookies, cache partition, proxy, and extension context. Speculation Rules syntax
was present, but its prefetch did not issue a request in the exact
`WebContentsView` probe.

Speculation Rules prerender failed with
`PreloadingUnsupportedByWebContents`; the subsequent navigation had
`activationStart === 0`. A hidden `WebContentsView` is deliberately rejected:
it would execute an arbitrary site normally, has no atomic activation API for
the current navigation controller, and risks incorrect history, storage,
permission, audio, download, and lifecycle behaviour. Hyperdrive therefore does
not emit **Preparing page** or **Ready** on this runtime. A future Electron upgrade
must pass an exact-runtime activation test before Tier 3 can be enabled.

`Cache-Control`, `Vary`, authentication, cookies, redirects, service workers, and
Chromium's network-isolation key can prevent reuse. A completed prefetch is named
**Prefetched**, not **Ready**, until the real navigation supplies cache evidence.

## Modes

Hyperdrive starts **Off**. Enabling it is a privacy choice because preconnect and
prefetch can contact a destination before the user clicks.

| Mode       | Behaviour                                                                                  | Concurrent document prefetch ceiling |
| ---------- | ------------------------------------------------------------------------------------------ | -----------------------------------: |
| Off        | No Hyperdrive ranking-driven network preparation; disabling clears active speculative work |                                    0 |
| Balanced   | Higher connection/prefetch thresholds and conservative preparation                         |                                    1 |
| Aggressive | Lower thresholds and more candidate preparation                                            |                                    2 |
| Maximum    | Lowest thresholds and the configured budget used most readily when useful                  |                                    3 |

The RAM setting is a ceiling, never a target. Increasing it does not allocate
memory by itself. Omnibox and pointer work use the same ceiling and concurrency
pool.

## Privacy and safety policy

The default policy permits only HTTP(S), same-site, idempotent-looking navigation
targets. Cross-site preparation requires a separate opt-in. An otherwise-valid
cross-site prediction remains visible as **Blocked** with the reason “Cross-site
preparation blocked by privacy settings” instead of looking like an unexplained
failed preload. Unfinished search queries are not sent to a provider unless
search preloading is separately enabled.

Hyperdrive rejects:

- credentials embedded in a URL and HTTPS-to-HTTP downgrades;
- localhost, `.local`, `.lan`, `.internal`, private/link-local/reserved IPv4,
  and literal IPv6 targets;
- authentication, account, password/reset, payment, checkout, purchase,
  subscription, invitation, logout, deletion, transfer, and administrative
  routes or sensitive query keys;
- executables, installers, archives, disk images, and other download-like URLs;
- private ChatGPT conversation/GPT/share paths;
- configured excluded hosts and their subdomains;
- site-adapter candidates marked sensitive or already prepared by the site.

State-changing endpoints stay blocked even if an otherwise sensitive site is
allowed. Hyperdrive never submits forms, follows non-HTTP schemes, bypasses
authentication, or uses a separate Session. It sends no prediction or learning
telemetry. Displayed ChatGPT conversation URLs are redacted, and diagnostic
history is bounded and in memory.

All HTTP prefetches use the active page and Chromecraft's existing persistent
Session. This preserves Chromium cache/proxy/cookie behaviour and the normal
uBlock Origin request path. When uBlock is enabled, the scheduler waits for
protection readiness before issuing document preparation. Hyperdrive does not
add a second `Session.webRequest` listener because Electron allows listeners to
collide, and it does not change uBlock's own prefetch preference.

## Memory pressure and accounting

Every in-flight document hint reserves a conservative 4 MiB scheduler estimate.
Work is rejected or the lowest-confidence active work is evicted before the sum
would exceed the configured budget. Disabling Hyperdrive, closing/replacing a
tab, reducing the budget, excluding a site, or clearing speculation removes
owned hints and releases scheduler estimates.

System memory is sampled every two seconds. On Linux the guard uses Electron's
`available` value; on Windows it uses `free`. Hyperdrive clears work and pauses
when available memory is below the larger of 512 MiB or 8% of total memory. It
resumes only above 12%, providing hysteresis against pressure oscillation. Normal
page loads and active-tab interaction always take priority.

The monitor distinguishes three different quantities:

- **Estimated speculative memory** is scheduler accounting, not an OS
  measurement.
- **Observed process private memory** is Electron main-process memory and includes
  non-Hyperdrive work. It is not attributable to a destination.
- **Observed speculative bytes** remains unknown unless the runtime can measure
  them honestly. Chromium exposes whole-Session cache size, not per-prefetch RAM
  or bytes, and clearing that cache would erase normal browsing data.

The clear action cancels Hyperdrive-owned work. It intentionally does not call
`Session.clearCache()` or `Session.closeAllConnections()`, both of which would
disrupt ordinary browsing.

## Hyperdrive Monitor semantics

The right-hand development panel reads scheduler snapshots; it contains no demo
data. Publication is throttled to avoid excessive React work. It can be opened
independently, paused, filtered, and cleared. Pausing stops event-history capture;
it does not pause the browser or change the selected performance mode.

States have strict meanings:

- **Predicted** — ranked locally.
- **Queued** — waiting for a scheduler slot or protection readiness.
- **Connecting** — one-socket preconnect was requested; completion is not
  observable.
- **Prefetching** — an active-page document hint is outstanding.
- **Prefetched** — a Hyperdrive-owned hint loaded before navigation; reuse is
  not yet proven.
- **Blocked** — policy intentionally prevented network preparation and the
  monitor shows the exact policy reason.
- **Site-owned prefetch** — the page already had an equivalent hint. Hyperdrive
  does not claim ownership, completion, or reuse for it.
- **Cache reuse confirmed** — an owned prefetch completed before navigation and
  the matching document navigation reported `transferSize === 0`.
- **Preparation not reused** — an owned prefetch existed, but the navigation
  transferred the document or overtook the unfinished preparation.
- **Cancelled / Failed / Evicted** — an actual lifecycle, timeout, policy, tab, or
  budget transition occurred.
- **Ready / Preparing page** — reserved for a future proven native prerender
  implementation and not emitted on Electron 44.

The Omnibox section is a filtered view of real destinations whose source is
`omnibox`. Confidence is the ranker's calibrated local score, not a claim that a
server or model supplied a probability. “Cache reuse” increments only after the
eventual navigation reports a zero transfer size for the matching document
prefetch. “Navigation time saved” remains unavailable because one live navigation
has no valid counterfactual.

## Verification

Run focused and full tests:

```powershell
pnpm exec vitest run src/main/hyperdrive src/main/preferences.test.ts
pnpm test
pnpm typecheck
```

The focused suite covers bounded deterministic ranking, trajectory and hover
intent, hysteresis, each site adapter, private-network and sensitive-route policy,
local aggregate learning, accuracy/benchmark helpers, and preference defaults,
validation, normalisation, and persistence.

### Repeatable packaged-app benchmark

Package Chromecraft first, then run the benchmark for the host platform:

```powershell
pnpm package:win
pnpm hyperdrive:benchmark:win -- --runs=5 --ublock=disabled
pnpm hyperdrive:benchmark:win -- --modes=off,balanced --runs=5 --ublock=enabled
pnpm hyperdrive:trace-google:win
```

On Linux Mint:

```bash
pnpm package:linux
pnpm hyperdrive:benchmark:linux -- --runs=5 --ublock=enabled
```

`scripts/perf/run-hyperdrive.mjs` runs Off, Balanced, Aggressive, and Maximum in a
deterministically interleaved order. Every trial uses a fresh profile and a
cacheable, delayed `publisher.test` document served from loopback. CDP dispatches
trusted pointer movement and the click into the actual tab renderer. Every mode
receives the same fixed pointer-to-click preparation window (1,000 ms by
default), including modes that do not choose to prefetch. The JSON report is
written to `.artifacts/hyperdrive/<timestamp>/hyperdrive.json` and contains:

- pointer-to-click and click-to-usable elapsed time;
- Navigation Timing response, DOM, duration, FCP, transfer size, and
  `activationStart`;
- pre-click and post-navigation server request/byte counts;
- scheduler ranking and preparation metrics;
- process-tree working-set/private-memory deltas and operation CPU seconds;
- speculative and wasted document bytes.

The fixture includes a cacheable document plus separate CSS, JavaScript, and SVG
resources. A navigation is usable only after the external script runs, the load
event fires, and two animation frames complete. The benchmark accepts reuse only
when the owned prefetch completed before the click, exactly one target-document
request occurred in total, navigation `transferSize` was zero, and the controller
reported `cache-reused`. Duplicate speculative requests remain visible in the
request counters, and their redundant bytes count as wasted. The harness does
not equate a download with reuse, label anything a prerender, or calculate an
invented per-navigation saving. Use `--ublock=enabled` to make the harness wait
for enabled and ready protection, or `--ublock=disabled` to isolate Hyperdrive.
Inspect raw distributions; one run is a smoke check, not a performance conclusion.

The benchmark can execute only the current host's binary. A Windows run does not
verify Linux Mint and vice versa. Linux packaging proves build portability, not
runtime behaviour; final Linux verification requires an actual Linux Mint host.
During development, the same harness can launch the unbundled app with
`--executable=node_modules/electron/dist/electron.exe --app=.` (or the Linux
Electron binary). Such a report must be treated as a development integration run,
not packaged-build evidence.

The latest checked-in methodology and packaged-run evidence are summarised in
[`docs/HYPERDRIVE_BENCHMARK_RESULTS.md`](HYPERDRIVE_BENCHMARK_RESULTS.md).

### Latest packaged Windows result — 16 October 2026

The corrected packaged-app run completed and accepted three fresh-profile
trials per mode on the local Windows test machine with a cacheable roughly 70 KiB
document, separate subresources, a 180 ms server delay, and an equal 1,000 ms
pointer-to-click window.

| Mode       | Median click-to-usable | Proven document reuse | Median transfer |
| ---------- | ---------------------: | --------------------: | --------------: |
| Off        |             329.030 ms |                   0/3 |        70,425 B |
| Balanced   |             126.378 ms |                   3/3 |             0 B |
| Aggressive |             162.625 ms |                   3/3 |             0 B |
| Maximum    |             124.620 ms |                   3/3 |             0 B |

Every enabled trial completed one pre-click target request and added no duplicate
navigation request, with zero wasted speculative document bytes and
`activationStart === 0`. A separate uBlock-enabled Off/Balanced run also accepted
all six trials and proved Balanced reuse 3/3. The attempted public Google to
Wikipedia trace was blocked by Google's automated-traffic interstitial, so no
public-site performance result is claimed. Full methodology, the uBlock figures,
raw report locations, and limitations are in the results document linked above.

## Supported platforms

The implementation uses Electron APIs available on Windows and Linux and adds no
native dependency. Forge packages Windows x64 ZIP output and Linux x64 ZIP/DEB
output. The only runtime platform branch is system-memory pressure accounting as
described above. Windows and Linux Mint should run the same predictor, policy,
active-page prefetch, monitor, and benchmark logic.
