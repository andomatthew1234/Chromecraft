# Hyperdrive benchmark results

Date: 16 October 2026  
Host: Windows x64, Intel Core i7-7700K, 8 logical CPUs, 32 GiB RAM  
Runtime: packaged Electron 44.7.2 / Chromium 152 app  
Primary report: `.artifacts/hyperdrive/navigation-fixed/hyperdrive.json`  
uBlock report: `.artifacts/hyperdrive/navigation-fixed-ublock-temp-profile/hyperdrive.json`  
Public-site trace: `.artifacts/hyperdrive/google-wikipedia-trace/trace.json`

## Result

The corrected deterministic integration benchmark completed and accepted all 12
fresh-profile trials. Balanced, Aggressive, and Maximum each completed the
predicted document prefetch before the click and proved HTTP-cache reuse in all
three trials. Every enabled trial made exactly one target-document request in
total, reported `transferSize === 0` after navigation, reached the real
`cache-reused` controller state, and reported no wasted speculative document
bytes. `activationStart` remained zero: this is cache reuse, not prerender.

| Mode       | Accepted | Proven reuse | Median click-to-usable | Median navigation duration | Median FCP | Median transfer | Median ranking | Median operation CPU | Median working-set delta |
| ---------- | -------: | -----------: | ---------------------: | -------------------------: | ---------: | --------------: | -------------: | -------------------: | -----------------------: |
| Off        |      3/3 |          0/3 |             329.030 ms |                   289.2 ms |     308 ms |        70,425 B |           0 ms |              0.609 s |                24.42 MiB |
| Balanced   |      3/3 |          3/3 |             126.378 ms |                    95.2 ms |     120 ms |             0 B |       0.212 ms |              0.813 s |                26.31 MiB |
| Aggressive |      3/3 |          3/3 |             162.625 ms |                   103.1 ms |     152 ms |             0 B |       0.161 ms |              0.828 s |                26.98 MiB |
| Maximum    |      3/3 |          3/3 |             124.620 ms |                    95.7 ms |     116 ms |             0 B |       0.227 ms |              0.813 s |                26.97 MiB |

On this controlled fixture, the Balanced median was 202.652 ms (61.6%) lower
than Off. This is a paired-fixture observation, not a promise that arbitrary
websites will improve by the same amount.

## uBlock-enabled compatibility run

The same packaged application was also run with uBlock Origin enabled. The
harness waited for the extension to report both enabled and ready before any
trial work. All six trials passed the same strict acceptance checks.

| Mode     | Accepted | Proven reuse | Median click-to-usable | Median navigation duration | Median FCP | Median transfer | Median ranking |
| -------- | -------: | -----------: | ---------------------: | -------------------------: | ---------: | --------------: | -------------: |
| Off      |      3/3 |          0/3 |             344.980 ms |                   308.6 ms |     324 ms |        70,425 B |           0 ms |
| Balanced |      3/3 |          3/3 |             156.856 ms |                   118.7 ms |     132 ms |             0 B |       0.169 ms |

The Balanced median was 188.124 ms (54.5%) lower than Off on this run. The
result proves that Chromecraft's uBlock-enabled Session path can reuse this
fixture's prefetched document; it does not claim that uBlock caused or improved
the timing difference.

## Method and acceptance criteria

Primary command:

```powershell
node scripts/perf/run-hyperdrive.mjs `
  --platform=win32 `
  --modes=off,balanced,aggressive,maximum `
  --runs=3 `
  --ublock=disabled `
  --fixture-delay-ms=180 `
  --preparation-window-ms=1000 `
  --settle-ms=250 `
  --output=.artifacts/hyperdrive/navigation-fixed
```

uBlock-enabled command:

```powershell
node scripts/perf/run-hyperdrive.mjs `
  --platform=win32 `
  --modes=off,balanced `
  --runs=3 `
  --ublock=enabled `
  --output=.artifacts/hyperdrive/navigation-fixed-ublock-temp-profile
```

- Trials were deterministically interleaved and each used a fresh temporary
  user-data directory outside the OneDrive workspace.
- The same 1,000 ms pointer-to-click window was applied to every mode.
- The destination was a cacheable roughly 70 KiB HTML document with separate
  CSS, JavaScript, and SVG resources. The server delayed the document response
  by 180 ms. The page was considered usable only after its external script ran,
  the load event fired, and two animation frames completed.
- CDP generated trusted pointer movement, hover, and click input in the actual
  packaged Chromecraft tab.
- Off was accepted only with no pre-click target request, one post-click target
  request, and non-zero navigation transfer.
- An enabled mode was accepted only when the document prefetch completed before
  the click, the fixture saw exactly one target-document request both before and
  after navigation (therefore no duplicate navigation fetch), Navigation Timing
  reported zero transfer, and the controller reported `cache-reused`.
- Fixture counters recorded document/resource requests and bytes. Navigation
  Timing supplied response, DOM, duration, FCP, transfer, and activation data.
- Process-tree working-set and CPU values are whole-application observations,
  not Hyperdrive-attributable measurements.

## Real Google to Wikipedia trace

`pnpm hyperdrive:trace-google:win` launches the packaged app with a disposable
profile, waits for uBlock and Balanced mode, opens a public Google query, looks
for a visible Wikipedia result, follows a real pointer path, and captures
controller plus CDP network/timing evidence. The attempted run could not reach a
result page because Google returned its automated-traffic interstitial. The
redacted report records this as a failed trace. No Google-to-Wikipedia speed or
reuse claim is made from that run.

The deterministic test reproduces the same cross-origin navigation shape and
proves the cache mechanism without depending on search-result availability. A
human or permitted test environment should rerun the public trace before making
claims about Google result pages specifically.

## Interpretation and limits

The measurements show that the active-page document prefetch can populate
Chromium's reusable HTTP cache and materially change this controlled
navigation. They do not establish a universal amount of time saved. Real sites
can reject or partition cache entries, vary on cookies or headers, redirect,
use service workers, or put most of their cost in scripts and subresources that
a document-only prefetch does not prepare.

Three samples per mode are sufficient for a deterministic integration check,
not a stable hardware comparison. Run at least five trials and inspect raw
distributions before making performance decisions.

This is packaged Windows x64 evidence. Linux packaging exercises build
portability, but the Linux Mint binary must be benchmarked on a Linux Mint host
before release. No Tier 3 result is reported: `activationStart` remained zero,
consistent with the exact-runtime finding that Electron 44 `WebContentsView`
does not support native prerender activation.
