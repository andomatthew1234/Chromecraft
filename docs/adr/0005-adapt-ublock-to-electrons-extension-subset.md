# Adapt uBlock Origin to Electron's extension subset

Chromecraft ships uBlock Origin 1.75.0 with a small, documented compatibility bridge for Chrome UI/privacy APIs that Electron omits, while leaving uBlock's request-filtering engine in control. Packaged tests must prove enabled-versus-disabled blocking and dashboard access; Chromecraft does not expose uBlock's per-site toolbar popup because Electron does not assign `WebContentsView` requests usable Chrome tab IDs, and presenting it would give misleading site state.
