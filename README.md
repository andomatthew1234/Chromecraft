# Chromecraft

Chromecraft is an early Windows and Linux Mint desktop browser built with Electron, TypeScript, and React. Phase 1 provides the dependable browsing core: an omnibox, horizontal tabs, isolated web pages, navigation controls, keyboard shortcuts, recoverable page failures, and bundled uBlock Origin filtering.

The sidebar and Minecraft-inspired visual theme are intentionally deferred to the next phase.

## Requirements

- Node.js 22.13 or newer
- pnpm 11
- Windows x64 or Linux Mint x64

## Development

```sh
pnpm install
pnpm start
```

Useful checks:

```sh
pnpm typecheck
pnpm test
pnpm lint
```

Repeatable performance runs are available with `pnpm perf:win` and
`pnpm perf:linux`. See [the baseline](docs/PERFORMANCE_BASELINE.md),
[implemented optimisations](docs/PERFORMANCE_OPTIMISATION.md), and
[measured results](docs/PERFORMANCE_RESULTS.md).

## Packaging

Create an unpacked Windows application:

```sh
pnpm package:win
```

Create an unpacked Linux x64 application suitable for Linux Mint runtime testing:

```sh
pnpm package:linux
pnpm smoke:linux
```

Outputs are written beneath `out/`. Installer and automatic-update work remains deliberately out of scope for Phase 1.

## uBlock Origin

The repository vendors the reviewed uBlock Origin 1.75.0 Chromium distribution. Chromecraft copies it to a stable per-user path and loads it into the same persistent Electron session as browser tabs.

Electron lacks some Chrome extension UI/privacy APIs that uBlock touches during startup. The small, documented `chromecraft-compat.js` bridge provides conservative no-op fallbacks so the upstream filtering engine can start. Automated packaged-app tests prove that a deterministic `doubleclick.net` request loads when protection is disabled and is blocked when protection is enabled. The upstream dashboard and filter settings open from the toolbar.

Stock Electron does not associate `WebContentsView` network requests with normal Chrome tab IDs. Consequently, uBlock's original per-site toolbar popup cannot truthfully show or toggle the active website; Chromecraft does not display that broken control. Global filtering, dashboard settings, filter lists, enable/disable, and restart persistence work.

See [third-party notices](THIRD_PARTY_NOTICES.md) for the pinned source, license, and checksum.

## Current non-goals

- Sidebar, Minecraft theme, accounts, profiles, sync, AI, music, and messaging
- Downloads, bookmarks, history UI, session restore, and site permission prompts
- Installer, signing, or automatic updates
- A Chromium fork or a replacement browser engine
