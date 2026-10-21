# Material 3 overhaul verification

## Visual evidence

The automated Windows QA run captures both light and dark variants. The earlier green-theme images remain in `.artifacts/ublock-*-shell*.png` as the before set. The corrected images use the `.artifacts/material3-after-*` prefix.

After views include:

- base shell and new tab;
- bookmarks, history, downloads, and settings;
- local omnibox suggestions;
- command palette and tab context menu;
- Material confirmation dialog;
- find-in-page surface;
- narrow and maximized layouts.

## Automated checks

- TypeScript type checking
- Vitest unit suite, including local omnibox ranking/deduplication tests
- production packaging for Windows x64 and Linux x64
- Windows cold and warm browser smoke runs
- deterministic page navigation and a live HTTPS page
- tab lifecycle, keyboard shortcuts, zoom, mute, history, bookmarks, quick links, downloads, and find UI
- uBlock Origin 1.75.0 startup, dashboard load, and deterministic blocking control
- light/dark screenshot capture

## Scope notes

- Linux Mint output is packaged on Windows but must still be runtime-tested on a Linux Mint machine, ideally under both Cinnamon X11 and Wayland.
- Electron's native Window Controls Overlay owns minimize, maximize, close, resize edges, and Windows snap UI. Shell-only screenshots do not include those operating-system-drawn buttons, but the packaged app uses the native overlay.
- The supplied attachment contained no loading-indicator reference video. The implementation therefore follows the verified AndroidX Material 3 Expressive shape sequence and timings and is not described as a pixel-identical copy of an unavailable video.
