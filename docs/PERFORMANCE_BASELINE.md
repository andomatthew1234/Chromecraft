# Chromecraft performance baseline

This document records the preserved pre-optimisation Phase 1 build. The raw
reports and executable remain under `.artifacts/perf/` so later changes can be
retested against the same binary.

## Test machine and workload

- Date: 15 October 2026
- OS: Windows 11 x64, build `10.0.26200`
- CPU: Intel Core i7-7700K at 4.20 GHz, 4 cores / 8 logical processors
- Memory: 32 GiB
- Browser engine: Electron 44.7.2 / its bundled Chromium
- Display: desktop left unlocked; the browser window was allowed to be visible
- Fixture: deterministic loopback HTTP page, `Cache-Control: no-store`, 240 DOM
  rows, no external resources, DNS, or internet variability
- Process measurements: the complete spawned Electron process tree, including
  shell, page renderers, GPU, network service, and extension processes

Two complementary runs were captured:

1. `baseline-interaction-10/performance.json`: two warm-ups followed by ten
   measured launches with uBlock enabled, ten samples per interaction, and 1/5
   loaded-tab checkpoints. This is the statistical baseline for startup and UI
   latency.
2. `baseline-full/performance.json`: one warm-up followed by five measured
   launches in each uBlock mode, seven samples per interaction, 1/5/10/20-tab
   checkpoints, 750 ms settle periods, and two-second idle CPU windows. This is
   the capacity and uBlock-cost baseline.

The reports contain every raw sample, machine metadata, configuration, log,
median, and linearly interpolated p95. Five launches are a development-quality
signal for capacity; the ten-launch run is preferred for latency percentiles.

## Startup and interaction baseline

These are warmed-profile daily launches of the preserved build with uBlock
enabled. “Shell ready” is process spawn until the shell DOM and browser API are
usable. “Protection ready” additionally waits until the extension reports
ready. Interaction values contain 100 samples except tab switching, which is
sampled after the loaded-tab set exists.

| Metric                                |       Median |           p95 |
| ------------------------------------- | -----------: | ------------: |
| Shell ready                           | 3,722.870 ms |  9,645.559 ms |
| uBlock protection reported ready      | 4,401.351 ms | 20,816.537 ms |
| New tab visible in shell              |     6.651 ms |    125.020 ms |
| Existing-tab switch visible in shell  |     9.177 ms |     49.199 ms |
| Omnibox focus proxy                   |    12.886 ms |    203.917 ms |
| Omnibox input feedback                |     9.535 ms |    139.939 ms |
| Navigation visible in browser state   |    19.862 ms |    256.651 ms |
| Local page complete in shell          |   111.687 ms |    838.361 ms |
| Local page Navigation Timing duration |    72.100 ms |    459.005 ms |

The baseline scrolling sample reported an 11.2 ms p95 animation-frame interval
and 21.0% adaptive long frames. This is a CDP/rAF proxy on the local page, not a
screen-photometer result.

## Memory and idle CPU baseline

Medians from the five-run full workload follow. RSS is summed working set and
therefore may double-count shared pages; it is still useful for like-for-like
process-tree comparisons.

| Loaded tabs | RSS, uBlock on | RSS, uBlock off | Idle CPU, uBlock on | Idle CPU, uBlock off |
| ----------: | -------------: | --------------: | ------------------: | -------------------: |
|           1 |      982.4 MiB |       439.8 MiB | 42.778% of one core |               0.000% |
|           5 |    1,397.4 MiB |       808.0 MiB |             28.848% |               2.060% |
|          10 |    1,953.5 MiB |     1,262.2 MiB |             19.942% |               1.526% |
|          20 |    3,068.6 MiB |     2,180.8 MiB |              1.793% |               0.906% |

The high early enabled-mode CPU readings include uBlock filter compilation and
startup work. They exposed that the old benchmark began page/resource work too
soon after Electron's generic extension-ready event; they should not be read as
steady-state idle consumption. The optimised harness separates shell readiness,
actual uBlock filtering readiness, and post-cleanup idle state.

## Cold-start observations

Five original packaged smoke repetitions produced a 3,157 ms median
(3,560 ms p95) first-profile uBlock launch and a 596 ms median (1,055 ms p95)
warm restart. Those smoke timestamps start inside Electron after main-module
loading and used the old extension-ready definition, so they are preserved as
diagnostic evidence, not mixed with the spawn-to-ready table above.

Cold profile preparation is dominated by copying the 14.8 MiB bundled
extension and uBlock compiling filter data. The baseline made clear that cold
and warm launches must be reported separately.

## Browser reference

Microsoft Edge 155.0.4283.45 was measured on the same PC with five isolated,
fresh profiles and the same loopback workload shape:

| Edge reference                    |       Median |          p95 |
| --------------------------------- | -----------: | -----------: |
| Process launch to local DOM ready | 2,817.754 ms | 4,876.640 ms |
| Initial page Navigation Timing    | 1,500.100 ms | 1,916.080 ms |

Edge median RSS was 742.7, 1,035.7, 1,359.7, and 1,763.3 MiB at 1, 5, 10,
and 20 tabs. This is context, not a score: Edge used fresh profiles, has a
different UI and process lifecycle, and did not run Chromecraft's bundled
uBlock configuration. Google Chrome was not installed on the test PC.

## Raw evidence

- `.artifacts/perf/baseline-app/Chromecraft-win32-x64/`
- `.artifacts/perf/baseline-interaction-10/performance.json`
- `.artifacts/perf/baseline-full/performance.json`
- `.artifacts/perf/edge-reference/performance.json`
- `docs/perf-methodology-notes.md`
