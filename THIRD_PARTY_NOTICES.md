# Third-party notices

## uBlock Origin 1.75.0

Chromecraft includes the unpacked Chromium distribution of uBlock Origin 1.75.0 by Raymond Hill and contributors. Chromecraft adds `js/chromecraft-compat.js` and loads it from `background.html` to provide conservative no-op fallbacks for Chrome UI/privacy APIs absent from Electron; the upstream request-filtering implementation is unchanged.

- License: GNU General Public License v3.0
- Source tag: <https://github.com/gorhill/uBlock/tree/1.75.0>
- Source commit: `21f0e686506bb21b514b451c8c6cb9bf8c82d232`
- Distribution: <https://github.com/gorhill/uBlock/releases/download/1.75.0/uBlock0_1.75.0.chromium.zip>
- SHA-256: `393cf95709d1074d4022970e9014e434395c53a822387f1e25f43be97cf4b582`

The upstream license is retained at `resources/extensions/ublock-origin/LICENSE.txt`. Some bundled filter lists may have separate terms; see the upstream [filter-list license inventory](https://github.com/gorhill/uBlock/wiki/Filter-list-licenses).
