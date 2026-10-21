# Performance benchmark methodology

`scripts/perf/run-perf.mjs` is the repeatable Phase 1 packaged-browser
benchmark. It drives an isolated Chromecraft profile against a deterministic
loopback page, records every raw sample, and writes medians and p95 values to
machine-readable JSON.

## Standard run

Package the app before benchmarking, close unrelated heavy workloads, connect
the machine to power, and leave the desktop unlocked. On Windows:

```powershell
pnpm package:win
node scripts/perf/run-perf.mjs --platform=win32 --runs=5
```

On an x64 Linux Mint machine:

```sh
pnpm package:linux
node scripts/perf/run-perf.mjs --platform=linux --runs=5
```

The default run performs one unmeasured profile warmup and five measured
launches for each of two modes: uBlock Origin enabled and disabled. Each launch
uses 7 interaction samples and measures resource use at 1, 5, 10, and 20 fully
loaded local tabs. Results and per-launch Electron logs are written below
`.artifacts/perf/<timestamp>/` unless `--output` overrides the destination.

For a fast harness check, while retaining all four tab-count points:

```powershell
node scripts/perf/run-perf.mjs --platform=win32 --modes=disabled --runs=1 --warmups=0 --interaction-samples=2 --idle-sample-ms=500 --settle-ms=100
```

Run `node scripts/perf/run-perf.mjs --help` for all options. The report embeds
the complete configuration, executable path, host details, raw samples,
failures, and aggregate statistics. Do not compare reports whose fixture delay,
sample duration, tab counts, power mode, display environment, or executable
build differs.

## What the metrics mean

- **Startup ready** is elapsed wall time from spawning the packaged executable
  until the browser shell DOM is present and its context-bridge API returns a
  valid browser snapshot. It is a readiness measurement, not first-pixel paint.
- **uBlock protection ready** is separately measured from process spawn until
  uBlock has loaded its filter data and started its request observer. The shell
  may be usable before this point, but protected navigation remains gated.
- **New tab main acknowledgement** measures the context-bridge request/response.
  **New tab shell state** additionally waits until React exposes the new tab in
  the accessibility tree.
- **Tab switch main acknowledgement** measures the activation IPC round trip.
  **Tab switch shell state** additionally waits until React marks the requested
  tab `aria-selected`. Neither number claims compositor or visible paint time.
- **Omnibox focus proxy** measures a CDP pointer press/release on the address
  input until it becomes the shell's active element. It covers browser input
  dispatch and DOM focus handling, but not click-to-pixel latency. Ctrl+L is
  verified separately by the smoke suite.
- **Omnibox input feedback** inserts a character through CDP and waits until the
  address input's DOM value reflects it. It includes browser input dispatch and
  React's controlled-input update, but not display scan-out.
- **Navigation initiation** measures command issue until the requested URL is
  observable in Chromecraft's browser snapshot.
- **Local page shell complete** measures command issue through the tab's
  non-loading state and expected title. **Browser navigation timing** and
  **DOMContentLoaded** come from the page's Navigation Timing entry when its
  target is available through CDP.
- **Working set** is the sum of resident working sets for the exact spawned
  Electron process tree. Shared pages can appear in more than one process
  working set, so this is an operational process-tree total, not unique physical
  memory. Windows reports the analogous summed private-byte value as well;
  Linux leaves it null.
- **Idle CPU** is the process-tree CPU-time delta during a quiet interval after
  the requested loaded-tab count has settled. `percentOfOneCore` can exceed
  100% when several processes run simultaneously. `percentOfMachine` divides by
  logical CPU count.
- **Scroll smoothness** animates the deterministic page for 800 ms and records
  rAF intervals. “Long” means greater than both 1.5 times the run median and the
  median plus 4 ms. Chromium may suspend rAF for an occluded window; such runs
  are recorded as unavailable instead of being fabricated from timers.
- **After closing to one tab** repeats memory and CPU sampling after the largest
  loaded-tab set is explicitly closed and the shell reports exactly one tab.
  This checks renderer/process release rather than only peak allocation.

The local fixture deliberately sends `Cache-Control: no-store`, creates 240
deterministic DOM rows, and uses no timers or external network resources. This
keeps page-load and idle samples independent of internet and DNS conditions.
The uBlock comparison therefore measures extension overhead, not ad-blocking
speed or effectiveness; the separate smoke suite verifies blocking behavior.

## Statistical and operational limits

The report uses linear-interpolated median and p95 statistics over raw samples.
Five launches are enough for a development signal, but use at least 10 launches
for release decisions involving p95. Keep the raw JSON so regressions can be
distinguished from outliers.

The harness controls only benchmark instances that it starts, using a freshly
allocated loopback DevTools port and an isolated profile. DevTools traffic adds
a small, consistent observer cost to interaction proxies. The app window may be
visible during a run; do not interact with it. Antivirus scans, thermal
throttling, OS updates, Electron renderer-process reuse, and other desktop
activity can materially change results.

The default startup result is a warm-profile daily-launch measurement because
the first unmeasured launch prepares the profile and extension copy. To inspect
first-launch behavior separately, use a new `--output` directory with
`--warmups=0 --runs=1`; do not mix that number into warm-start aggregates.

## Microsoft Edge reference

On Windows, a compact Edge reference run uses the same 240-row deterministic
loopback workload shape and records five fresh-profile launches:

```powershell
node scripts/perf/run-edge-reference.mjs --runs=5 --output=.artifacts/perf/edge-reference
```

It measures process launch until the initial local page reports complete DOM
readiness, the page's Navigation Timing, and whole spawned-process-tree RSS at
1, 5, 10, and 20 fully loaded tabs. The output contains raw samples plus
median/p95 aggregates in `.artifacts/perf/edge-reference/performance.json`.

This is deliberately labelled a **non-apples-to-apples reference**. Edge does
not use Chromecraft's Electron shell, uBlock Origin configuration, tab views,
or startup/profile lifecycle. The reference suppresses Edge's first-run and
default-browser prompts and disables sync, uses a fresh isolated profile for
every measured launch, and runs under CDP. Chromecraft's standard result uses a
warmed persistent profile. Edge also has different built-in services, process
reuse, caches, and mitigations. Treat the reference as context for scale, not a
winner/loser score or a regression gate.
