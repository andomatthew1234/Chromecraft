# Third-party notices

## uBlock Origin 1.75.0

Chromecraft includes the unpacked Chromium distribution of uBlock Origin 1.75.0 by Raymond Hill and contributors. Chromecraft adds `js/chromecraft-compat.js` and loads it from `background.html` to provide conservative no-op fallbacks for Chrome UI/privacy APIs absent from Electron; the upstream request-filtering implementation is unchanged.

- License: GNU General Public License v3.0
- Source tag: <https://github.com/gorhill/uBlock/tree/1.75.0>
- Source commit: `21f0e686506bb21b514b451c8c6cb9bf8c82d232`
- Distribution: <https://github.com/gorhill/uBlock/releases/download/1.75.0/uBlock0_1.75.0.chromium.zip>
- SHA-256: `393cf95709d1074d4022970e9014e434395c53a822387f1e25f43be97cf4b582`

The upstream license is retained at `resources/extensions/ublock-origin/LICENSE.txt`. Some bundled filter lists may have separate terms; see the upstream [filter-list license inventory](https://github.com/gorhill/uBlock/wiki/Filter-list-licenses).

## Scout provider identification assets

Chromecraft bundles official provider marks for the Scout settings interface.
They are used only to identify the corresponding user-selectable integration.
Asset-level source URLs, retrieval dates, and checksums are recorded in
`src/renderer/assets/providers/SOURCES.md`.

### Google Gemini

`Google`, `Gemini`, and their associated marks are trademarks of Google LLC.
The bundled marks remain subject to Google's brand terms and are not licensed
under Chromecraft's source-code license. Their use does not imply endorsement
or sponsorship by Google.

- Brand guidance: <https://about.google/brand-resource-center/guidance/>
- Gemini API documentation: <https://ai.google.dev/gemini-api/docs>

### Ollama

The bundled Ollama logo is sourced from the official Ollama repository.
`Ollama` and its associated marks remain the property of Ollama Inc. The mark
is used only to identify a user-selectable integration and does not imply
endorsement or sponsorship. Branding use remains subject to Ollama's
[Terms of Service](https://registry.ollama.com/terms).

- Copyright: Copyright (c) Ollama
- Source: <https://github.com/ollama/ollama/blob/main/docs/logo.svg>
- Source-repository license: MIT

```text
MIT License

Copyright (c) Ollama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
