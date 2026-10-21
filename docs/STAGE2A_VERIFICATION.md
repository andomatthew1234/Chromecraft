# Stage 2A verification

Stage 2A is the browser-polish and daily-driver increment. It keeps browser data local and preserves the Phase 1 security boundary: the Electron main process owns tabs, persistence, downloads, and policy; the trusted React shell receives only typed snapshots and named operations; remote sites remain sandboxed `WebContentsView` instances with no preload or Node access.

## Implemented

- Collapsible vertical Sidebar with bookmarks, history, downloads, and settings.
- Local bookmarks with search, folders, HTML import/export, and an optional bookmark bar.
- Local history with search, entry deletion, and last-hour/day/all clearing.
- Downloads with live progress, pause, resume, cancel, retry, open, show in folder, and bounded history.
- URL-only session restore, lazy restored background tabs, and recently closed tabs.
- Minecraft-inspired CSS new-tab themes, pinned quick links, and recent sites.
- Find in page, per-tab isolated zoom, duplicate/reopen/mute tab actions, tab context menu, fullscreen, and command palette.

## Verification commands

Use the bundled Node runtime on this development machine, then run:

```powershell
pnpm lint
pnpm test
pnpm package:win
pnpm package:linux
pnpm smoke:win
```

The Windows smoke suite exercises a packaged build with uBlock disabled, enabled from a fresh profile, and enabled from a warm profile. It verifies local-shell startup, navigation, tab lifecycle, shortcut handling, remote-view cleanup, live HTTPS loading, the uBlock dashboard, and actual request blocking.

## Deliberately deferred

Private Windows, per-site permission UI, the Privacy Center, Site Network Control, profiles, accounts, sync, AI, music, and messaging are not part of Stage 2A.
