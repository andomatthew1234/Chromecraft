# Chromecraft performance optimisation

The optimisation pass concentrated on the critical path and repeated shell
work. It deliberately retained Chromium defaults, site isolation, TLS
verification, the existing session security policy, one persistent renderer per
open tab, and full uBlock Origin filter functionality.

## Investigation findings

The main startup path was serial: preferences loaded, the bundled extension was
checked/copied, uBlock was loaded, and only then was the shell displayed. A
disabled uBlock setting still paid extension preparation work. The smoke module
was statically imported during every normal launch.

The tab manager performed work proportional to every open tab on each switch:
all views were visited for visibility and layout, navigation events emitted
several complete snapshots, and each snapshot queried native navigation state.
Resize events also performed synchronous layout repeatedly.

In the renderer, omnibox keystrokes lived in root application state. Each
character rerendered the browser shell and tab strip. Tab buttons were not
memoized, and Ctrl+L introduced an unnecessary animation-frame delay.

The original extension readiness signal only meant Electron had created the
extension. It did not guarantee that uBlock had loaded its filter lists or
started `webRequest`, allowing a fast first navigation to escape filtering.

## Implemented changes

### Startup critical path

- The shell is loaded, shown, and interactive before optional extension work is
  awaited.
- uBlock initialization begins immediately after the first usable shell, while
  page navigation is held behind the protection-readiness gate when protection
  is enabled.
- The extension copy/load path is skipped completely when the saved setting is
  disabled.
- Initialization is idempotent, so concurrent UI/navigation requests share one
  promise instead of starting duplicate work.
- The smoke-only module is dynamically imported only for smoke runs.
- Production main/preload builds no longer emit source maps.

### Correct and fast uBlock readiness

- The reviewed bundled uBlock 1.75.0 compatibility revision now emits a private
  marker immediately after uBlock has loaded its filters and started its own
  network observer.
- Chromecraft listens for that marker only on extension/background contents and
  does not expose a remote-page bridge.
- Initial page navigation waits for this real readiness point. uBlock remains
  enabled by default, its dashboard and lists are unchanged, and disabling it
  avoids the extension process entirely.
- The compatibility revision is stored with the stable extension copy, ensuring
  existing profiles receive the updated reviewed bundle.

### Tab and view lifecycle

- Switching tabs is now O(1): only the previous view is hidden and the next view
  shown. Hidden views are not walked or laid out on every switch.
- Only the shell and active page view are resized; inactive views receive their
  current bounds just before activation.
- Resize handling and bursty navigation/title events are coalesced over an
  eight-millisecond window.
- `canGoBack` and `canGoForward` are cached from navigation events instead of
  queried from native history for every snapshot.
- Immediate user actions still publish immediate state, while duplicate event
  state is discarded.
- Background-tab dispositions create a real hidden background tab instead of
  stealing focus.
- Closed tabs are removed from the window and their `webContents` are explicitly
  closed. The benchmark then closes a 20-tab set back to one and samples the
  released process tree.
- Chromium's normal background throttling remains enabled. Tabs are neither
  discarded nor aggressively slept, preserving media, downloads, sessions, and
  compatibility.

### Lightweight React shell

- Omnibox text is local to a memoized `Omnibox` component, so typing no longer
  rerenders the application root and complete tab strip.
- Tab buttons are memoized using only the fields that affect their output.
- New-tab search input is local state.
- Ctrl+L focuses and selects the omnibox immediately without an extra animation
  frame.
- The toolbar shows uBlock's initializing state and disables its toggle until a
  transition is safe.

### Navigation and IPC

- Navigation IPC waits only for required uBlock readiness and command
  initiation; it does not hold the shell request open until the whole page
  finishes loading.
- Snapshot bursts are coalesced without coalescing direct user acknowledgements.
- Web pages continue to use isolated sandboxed `WebContentsView` instances in a
  dedicated persistent session.

### Measurement and regression tooling

- `scripts/perf/run-perf.mjs` launches isolated profiles and records raw startup,
  UI, navigation, scrolling, CPU, and full process-tree memory samples in both
  uBlock modes.
- Shell readiness and actual filtering readiness are separate timestamps.
- Omnibox character feedback is measured directly rather than inferred from
  focus latency.
- The harness verifies resource release after closing back to one tab.
- A transient CDP failure was removed by avoiding an unused `Runtime.enable`
  observer step; direct evaluation is sufficient and does not charge DevTools
  context enumeration to browser startup.
- `scripts/perf/run-edge-reference.mjs` supplies a clearly labelled same-PC Edge
  scale reference.

## Architecture decisions

`WebContentsView` remains the right Phase 1 architecture. It gives each website
a real Chromium renderer and lifecycle while the React shell remains small and
trusted. Replacing it with webviews or rebuilding tabs would sacrifice isolation
or compatibility and would not address the measured shell bottlenecks.

The following tempting changes were rejected:

- experimental Chromium/network flags without workload evidence;
- disabling sandboxing, site isolation, TLS checks, or web security;
- prefetching or preconnecting to unrequested sites;
- loading uBlock directly from a changing application path, which risks its
  extension identity and stored settings;
- weakening filter lists or starting navigation before filtering is active;
- aggressive tab discard/sleep behavior before a safe user-facing policy exists.

## Reproduction

```powershell
pnpm package:win
pnpm perf:win
pnpm smoke:win
```

For release-quality interaction p95 data, use at least ten launches. The exact
commands and metric definitions are in `docs/perf-methodology-notes.md`.
