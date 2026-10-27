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

Create the Windows ZIP plus the Squirrel installer and update artifacts:

```sh
pnpm make:win
```

Create an unpacked Linux x64 application suitable for Linux Mint runtime testing:

```sh
pnpm package:linux
pnpm smoke:linux
```

Outputs are written beneath `out/`.

## Updates

The sidebar's **Chromecraft Updates** centre provides one place to check User
Extensions, Browser Dependencies, and Chromecraft itself. Installed Windows
builds use Electron's native Squirrel updater to download and apply one complete
application release after a user-approved restart. Browser data and the open-tab
session remain in the existing per-user profile.

The release workflows configure the fixed HTTPS GitHub release feed. Portable
ZIP and development builds truthfully report that self-update is unavailable;
Linux packages continue to update through the distribution package manager.
Public production releases are fail-closed until the Windows application and
installer are Authenticode signed. Signing credentials are intentionally stored
only as GitHub Actions secrets.

See [Update and release automation](docs/UPDATE_RELEASES.md) for the release
model, required repository settings, signing configuration, and recovery steps.

## uBlock Origin

The repository vendors the reviewed uBlock Origin 1.75.0 Chromium distribution. Chromecraft copies it to a stable per-user path and loads it into the same persistent Electron session as browser tabs.

Electron lacks some Chrome extension UI/privacy APIs that uBlock touches during startup. The small, documented `chromecraft-compat.js` bridge provides conservative no-op fallbacks so the upstream filtering engine can start. Automated packaged-app tests prove that a deterministic `doubleclick.net` request loads when protection is disabled and is blocked when protection is enabled. The upstream dashboard and filter settings open from the toolbar.

Stock Electron does not associate `WebContentsView` network requests with normal Chrome tab IDs. Consequently, uBlock's original per-site toolbar popup cannot truthfully show or toggle the active website; Chromecraft does not display that broken control. Global filtering, dashboard settings, filter lists, enable/disable, and restart persistence work.

See [third-party notices](THIRD_PARTY_NOTICES.md) for the pinned source, license, and checksum.

## Current non-goals

- Sidebar, Minecraft theme, accounts, profiles, sync, AI, music, and messaging
- Downloads, bookmarks, history UI, session restore, and site permission prompts
- A Linux package repository or unattended Linux self-update
- A Chromium fork or a replacement browser engine
