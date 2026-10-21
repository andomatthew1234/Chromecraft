# Chromecraft implementation plan

## Product boundary

Chromecraft is a Windows and Linux Mint Electron browser. It aims to become a dependable daily browser before it adds accounts, sync, AI, messaging, music, a Minecraft-inspired visual theme, or other workspace modules.

Phase 1 established reliable browsing and horizontal tabs. Stage 2A now adds daily-driver polish: a vertical Opera-style Sidebar, local browser data, download management, session restore, and a lightweight Minecraft-inspired new-tab surface. The horizontal tab bar remains the primary tab control.

## Decisions already made

- Electron, TypeScript, and React power the local Browser Shell on Windows.
- There is no Chromecraft account, sync, analytics, or automatic crash-report upload in the first release.
- One persistent local Default Profile holds normal browsing data. Private Windows are a later Daily Driver Fundamentals capability.
- uBlock Origin is preinstalled, enabled by default, visible on the new-tab page, and user-disableable. Its upstream filtering engine and dashboard must work; a weaker private replacement is not an acceptable silent fallback. Electron does not provide usable tab IDs for uBlock's per-site popup, so that misleading control is not exposed.
- The Privacy Center will add Site Network Control focused on third-party requests, with an advanced whole-site offline switch later. This is not a DNS server.
- The browser includes a user-triggered full-release update interface and Windows Squirrel installer path. Production signing, a hosted release feed, Linux package repository, and public distribution remain release-preparation work.

## Architecture to build toward

```text
Chromecraft Browser Shell (local React UI)
  ├── window controls / omnibox / horizontal tabs
  ├── Sidebar, local-data panels, and future Privacy Center
  └── narrow, validated IPC API
              │
Electron main process (owns browser state and policy)
  ├── tab lifecycle and WebContentsView layout
  ├── persistent Default Profile session
  ├── permission, navigation, popup, and download policy
  ├── uBlock Origin extension lifecycle
  └── later third-party request policy dispatcher
              │
Remote WebContentsView per browser tab
  └── sandboxed, Node-disabled, isolated website content
```

Use `BaseWindow` plus `WebContentsView` for remote tabs; do not use the deprecated `BrowserView` or the `<webview>` tag. Each remote tab is explicitly destroyed when closed, because `BaseWindow` does not automatically destroy child web contents. The Browser Shell is served through a local custom protocol, never from a remote URL.

Every remote tab uses the normal hardened Electron baseline: Node integration off, context isolation on, sandbox on, no insecure content bypasses, a default-deny permission policy, validated navigation, deliberately routed popups, controlled downloads, and a small typed preload bridge. This is baseline browser engineering rather than a user-facing security feature.

## Repository shape

Start with Electron Forge, TypeScript, React, and the Vite integration. Keep the application boundary explicit from the first commit:

```text
src/
  main/                 # Electron lifecycle, sessions, tab manager, policies
  preload/              # typed, minimal bridge exposed to local shell only
  renderer/             # React Browser Shell and new-tab page
  shared/               # IPC contracts, tab/domain types, validation schemas
  extensions/ublock/    # pinned, reviewed unpacked uBlock Origin distribution
tests/
  unit/                 # browser-state and URL/policy tests
  integration/          # main-process/session/extension tests
  e2e/                  # packaged-app browsing flows
docs/
  adr/
```

The main process owns the source of truth for tabs and sessions. React receives snapshots and invokes only named operations such as `createTab`, `navigateTab`, `closeTab`, and `setActiveTab`; it must never receive generic process or filesystem access.

## Phased execution

### Phase 0 — foundation and uBlock acceptance spike

1. Scaffold the Electron Forge application, linting, formatting, type checking, unit-test runner, and packaged-app end-to-end test harness.
2. Build one local shell view and one isolated remote `WebContentsView`; load a known HTTPS page, handle navigation events, and close all views cleanly.
3. Create the persistent Default Profile session and apply the baseline permission/navigation policy.
4. Bundle a reviewed, version-pinned, unpacked upstream uBlock Origin build into app resources. Load it after Electron is ready into the persistent session on every launch.
5. Test actual uBlock behaviour: extension startup, filter-list request blocking, dashboard/settings UI, restart persistence, and user disable/enable. Record Electron's lack of a truthful per-site popup as a known platform boundary.

**Gate:** do not proceed with an “ad blocking works” claim until this exact extension behaves acceptably in the selected Electron version. Electron supports only a subset of Chrome extension APIs and does not install Chrome Web Store CRX files, so this is an executable compatibility check—not paperwork. If it fails, record the result and stop for an explicit product decision; do not substitute a hidden custom blocker.

### Phase 1 — Core Browsing Foundation

Build the reliable everyday browsing loop without optional browser-management features:

1. Application frame: accessible window controls, omnibox, conventional horizontal tab bar, loading indicator, and focused keyboard flow.
2. Tab manager: create, select, close, and reorder tabs; title/favicon/loading state; safe cleanup; one active tab visible at a time.
3. Navigation: URL normalization, configurable search-template plumbing, go/back/forward/reload/stop, error pages, crash recovery for an individual tab, and common keyboard shortcuts.
4. New tab: a fast local address/search entry point that works without network access. Minecraft visual styling is intentionally deferred.
5. Local data: persist only the minimum ordinary browsing state needed for the core experience. Do not build profiles, sync, account flows, music, AI, messaging, or the Sidebar in this phase.

**Phase 1 acceptance scenarios**

- A user can open several ordinary HTTPS sites, switch among tabs, navigate each tab independently, and close tabs without leaking views or crashing the browser.
- A malformed URL, failed navigation, popup request, denied permission, or renderer crash is handled predictably and does not terminate the application.
- Restarting the app starts a clean, usable Browser Shell; uBlock Origin remains available and enabled unless the user disabled it.
- No first-party analytics, account request, or crash upload is emitted by the app.
- Keyboard-only use can create, close, switch, and focus tabs/omnibox.

### Phase 2 — Daily Driver Fundamentals

Add the capabilities required for sustained use, in this order:

1. Download flow, download shelf/history, safe default location choice, and cancellation/open-in-folder actions.
2. History, bookmarks, find-in-page, startup/session restore, clear-browsing-data controls, and Private Windows.
3. Per-site permission settings and a user-visible Privacy Center.
4. The vertical Sidebar: browser destinations first, then pinned sites and tab/workspace grouping. It supplements rather than replaces the horizontal tab bar.
5. Site Network Control for third-party requests. Implement it as one central request-policy dispatcher so it can coexist with uBlock and later exceptions. Show exactly what will be blocked and avoid noisy prompts.

#### Stage 2A — implemented browser polish

- Collapsible vertical Sidebar with local bookmarks, history, downloads, and settings panels.
- Atomic, bounded local storage for bookmarks, history, recently closed tabs, quick links, and URL-only session restore.
- Lazy background-tab restoration to preserve startup time and memory use.
- Download progress, pause/resume/cancel/retry, history, open, and show-in-folder actions. Executable-like files require a second explicit confirmation before opening.
- Searchable bookmarks and history, bookmark HTML import/export, optional bookmark bar, folders, selected-entry deletion, and time-range clearing.
- Native find-in-page, isolated per-tab zoom, duplicate/reopen/mute tab actions, a tab context menu, F11 fullscreen, and a local command palette.
- A lightweight CSS-rendered Minecraft-inspired new-tab page with selectable worlds, pinned/recent sites, and visible uBlock status.

Private Windows, per-site permissions, the Privacy Center, and Site Network Control remain later Phase 2 work.

### Phase 3 — hardening and release preparation

Before public distribution, complete accessibility testing, memory/lifecycle profiling, recovery testing, dependency and Electron upgrade policy, reproducible Windows packaging, code signing, and a privacy-preserving update design. Updates must have no analytics requirement and be disclosed in the Privacy Center. Maintain third-party notices and license compliance for uBlock Origin and every shipped dependency.

### Phase 4 — optional workspace modules

Only after the browser is stable:

- Music controls and opt-in web-app shortcuts.
- Sandboxed messaging panels such as Discord, each isolated from normal browsing state.
- Opt-in AI: ChatGPT OAuth through PKCE and OS credential storage, plus explicit local-LLM integration with resource limits and per-request consent.
- Multiple profiles, optional encrypted sync, and only then a separately designed Chromecraft/Firebase account system.

## Work order for the first implementation session

1. Initialize the repository and development tooling.
2. Create the typed Browser Shell/main/preload boundaries.
3. Implement a minimal tab manager with one remote view.
4. Add navigation controls and the new-tab page.
5. Run the uBlock Origin compatibility spike before adding visual polish or browser extras.
6. Automate the Phase 1 acceptance scenarios from the start; every new tab/session bug should produce a regression test.

## Explicit non-goals until later

- A custom browser engine or Chromium fork.
- A local DNS server.
- Any telemetry/advertising SDK, Chromecraft account, sync, or automated crash-report upload.
- AI, ChatGPT OAuth, local Llama models, Discord, music, or other embedded services.
- Accounts, sync, AI, music, or messaging inside the Sidebar.
- A hosted update service, production signing pipeline, Linux package repository, or public release channel.

## Primary risks and controls

| Risk                                                                         | Control                                                                                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| uBlock Origin does not fully operate in Electron's subset of extension APIs. | Phase 0 uses the actual pinned upstream extension and blocks the ad-blocking promise on test results.      |
| Browser tabs leak memory or become stale.                                    | Main process owns tab lifetime; explicitly destroy every view; test create/close/restart cycles.           |
| Remote sites gain Browser Shell privileges.                                  | Separate local and remote content, sandbox remote pages, and expose only typed operations through preload. |
| Privacy language exceeds actual behaviour.                                   | Maintain a network-data inventory and test that first-party analytics/crash uploads are absent.            |
| Sidebar modules blur into privileged browser features.                       | Keep modules opt-in and separately partitioned; they do not receive Browser Shell privileges.              |
| Phase 1 grows into a feature chase.                                          | Keep its acceptance scenarios fixed; queue fundamentals and integrations for their stated phases.          |

## Evidence that governs the plan

- [Electron extension support](https://www.electronjs.org/docs/latest/api/extensions): only unpacked extensions and a subset of Chrome extension APIs are supported.
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security): supports the isolated remote-content baseline above.
- [Electron BaseWindow](https://www.electronjs.org/docs/latest/api/base-window) and [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view): govern view composition and explicit lifecycle handling.
- [uBlock Origin Chromium instructions](https://github.com/gorhill/uBlock/blob/master/dist/README.md): govern the reviewed unpacked-build approach.
