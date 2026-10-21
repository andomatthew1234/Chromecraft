# Chromecraft performance results

## Result summary

Chromecraft is materially faster at startup tails, focus/input responsiveness,
local navigation, and uBlock-enabled memory scaling. The browser remains a
real multi-process Chromium application, so 20 live tabs are not lightweight;
the optimisation reduces overhead without discarding or reloading those tabs.

All final statistical launches passed: 10/10 in the strict enabled interaction
set and 5/5 in each mode in the full 1/5/10/20-tab set. The packaged Windows
smoke matrix also passed with real HTTPS and deterministic ad blocking.

## Matched ten-run latency comparison

These values compare the preserved baseline executable and final executable on
the same PC with identical warmed-profile settings: two warm-ups, ten launches,
ten interaction samples per launch, uBlock enabled. Negative percentages are
improvements.

| Metric                       | Baseline median | Final median | Median change |  Baseline p95 |    Final p95 | p95 change |
| ---------------------------- | --------------: | -----------: | ------------: | ------------: | -----------: | ---------: |
| Shell ready                  |    3,722.870 ms | 2,090.283 ms |    **−43.8%** |  9,645.559 ms | 2,551.290 ms | **−73.5%** |
| Filtering ready              |    4,401.351 ms | 3,532.907 ms |    **−19.7%** | 20,816.537 ms | 4,520.849 ms | **−78.3%** |
| New tab in shell             |        6.651 ms |     9.404 ms |        +41.4% |    125.020 ms |    66.528 ms | **−46.8%** |
| Tab switch in shell          |        9.177 ms |     9.179 ms |         +0.0% |     49.199 ms |    38.928 ms | **−20.9%** |
| Omnibox focus proxy          |       12.886 ms |    10.275 ms |    **−20.3%** |    203.917 ms |    36.125 ms | **−82.3%** |
| Omnibox input feedback       |        9.535 ms |     6.929 ms |    **−27.3%** |    139.939 ms |    55.950 ms | **−60.0%** |
| Navigation initiation        |       19.862 ms |    31.289 ms |        +57.5% |    256.651 ms |   129.967 ms | **−49.4%** |
| Local page complete in shell |      111.687 ms |   107.105 ms |     **−4.1%** |    838.361 ms |   490.889 ms | **−41.4%** |
| Browser Navigation Timing    |       72.100 ms |    43.050 ms |    **−40.3%** |    459.005 ms |   245.030 ms | **−46.6%** |

The two median regressions are not hidden. New-tab creation remains 9.4 ms
median, well below the 50 ms stretch goal. Navigation initiation now includes a
stricter protection gate and remains 31.3 ms median; its p95 nearly halved.

The available ten-run scroll proxy was unchanged at an 11.2 ms p95 frame
interval. Adaptive long frames moved from 21.0% to 20.0%. Chromium suspended
the rAF sample for several occluded runs, so scrolling is not claimed as fully
verified at every refresh rate.

## Memory comparison

The full five-run capacity workload used identical 1/5/10/20-tab checkpoints,
750 ms settling, and two-second CPU windows.

| Loaded tabs | Baseline RSS, uBlock on | Final RSS, uBlock on |     Change | Baseline RSS, off | Final RSS, off | Change |
| ----------: | ----------------------: | -------------------: | ---------: | ----------------: | -------------: | -----: |
|           1 |               982.4 MiB |            753.3 MiB | **−23.3%** |         439.8 MiB |      448.6 MiB |  +2.0% |
|           5 |             1,397.4 MiB |          1,165.9 MiB | **−16.6%** |         808.0 MiB |      820.1 MiB |  +1.5% |
|          10 |             1,953.5 MiB |          1,634.9 MiB | **−16.3%** |       1,262.2 MiB |    1,282.4 MiB |  +1.6% |
|          20 |             3,068.6 MiB |          2,546.7 MiB | **−17.0%** |       2,180.8 MiB |    2,202.3 MiB |  +1.0% |

The disabled-mode 1–2% increase is within the observed desktop/process-working-
set variance and is reported as a small regression, not an improvement.

After the final 20-tab checkpoint, the harness closed back to one live tab. RSS
fell from 2,546.7 to 583.4 MiB with uBlock enabled (−77.1%) and from 2,202.3 to
426.3 MiB when disabled (−80.6%). Process counts returned from 25 to 6 and 24
to 5 respectively. This does not prove the absence of every leak, but it shows
that closed renderer processes and most of their working set are released.

## Idle CPU and uBlock cost

Final median idle CPU, as a percentage of one logical core:

|        Loaded tabs | uBlock on | uBlock off |
| -----------------: | --------: | ---------: |
|                  1 |    0.430% |     1.054% |
|                  5 |    0.772% |     0.585% |
|                 10 |    2.757% |     0.995% |
|                 20 |    1.528% |     2.188% |
| After closing to 1 |    0.357% |     0.363% |

Desktop CPU samples are noisy and not monotonic with tab count. The important
steady post-cleanup result is about 0.36% of one core (about 0.045% of this
eight-thread machine) in either mode. The baseline's early enabled samples were
contaminated by filter compilation; the final harness exposes protection-ready
and post-cleanup states separately instead of presenting that startup work as
idle.

At final full-run medians, enabling uBlock added 304–352 MiB of process-tree RSS
depending on tab count. The deterministic no-ad page navigated in 39.2 ms with
uBlock and 35.2 ms without it. That cost preserves the complete filter engine;
no lists or blocking capabilities were removed.

## Stretch goals

| Goal                                      | Result                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Warm startup under 800 ms                 | **Not met.** Shell 2,090 ms median; filtering 3,533 ms.                                          |
| Blank new tab under 50 ms                 | **Median met** at 9.4 ms; p95 66.5 ms.                                                           |
| Tab switch under 30 ms                    | **Median met** at 9.18 ms; p95 38.9 ms.                                                          |
| Omnibox feedback within one display frame | **Median met** at 6.93 ms; p95 55.95 ms.                                                         |
| Near-zero settled idle CPU                | **Met in the post-cleanup state** at 0.36% of one core.                                          |
| Smooth scrolling without shell drops      | 11.2 ms available p95 proxy; **not fully proven** because occluded rAF samples were unavailable. |
| Lower memory than baseline                | **Met with uBlock enabled** (16–23% lower); disabled mode is 1–2% higher.                        |

## Functional verification

The final packaged Windows matrix verified:

- a deterministic `doubleclick.net` script loaded twice with protection off;
- the same request reached the server zero times on both cold and warm protected
  runs;
- uBlock Origin 1.75.0, its dashboard, and its filter settings loaded;
- `https://example.com/` loaded on both protected runs;
- navigation and keyboard shortcuts worked;
- repeated tab creation/closing returned to one tab and one live view;
- no main-process or renderer error was reported by the matrix.

Windows x64 and Linux x64 packages were both produced. Linux Mint could not be
executed on this Windows host because no WSL distribution, container runtime,
or Mint VM is installed; the Linux runtime matrix remains an explicit follow-up
on a Linux Mint x64 machine.

## Browser reference and limitations

The Edge fresh-profile result is retained in `PERFORMANCE_BASELINE.md`. It is
not directly comparable with Chromecraft's warmed-profile shell result. At 1
tab, final protected Chromecraft RSS (753.3 MiB) is close to the Edge reference
(742.7 MiB); at 20 tabs Chromecraft is higher (2,546.7 vs 1,763.3 MiB), reflecting
different process reuse, UI services, and the bundled blocker. Chrome was not
available.

Window capture is unavailable for `WebContentsView` on this remote desktop
surface, so screenshots are best-effort and not a pass condition. Functional
state, real page timing, request counts, and process liveness are used instead.
The Windows app-control helper timed out repeatedly, including after a clean
reset, so automated mouse/keyboard inspection could not be completed. The final
packaged browser is launched visibly for manual inspection rather than claiming
that missing coverage.

## Raw evidence

- `.artifacts/perf/final-interaction-10-filter-ready/performance.json`
- `.artifacts/perf/final-full-filter-ready/performance.json`
- `.artifacts/ublock-disabled-report.json`
- `.artifacts/ublock-enabled-report.json`
- `.artifacts/ublock-enabled-warm-report.json`
- `docs/perf-methodology-notes.md`
