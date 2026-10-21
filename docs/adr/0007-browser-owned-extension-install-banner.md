# Present Web Store installation through a browser-owned banner

Chromecraft will detect eligible Chrome Web Store Listings with one shared strict-origin parser and present an Extension Install Banner in the Browser Shell, never by injecting or altering store-page HTML. The main process owns the matching native page inset so the separate website `WebContentsView` remains below the banner; only the banner contents animate, avoiding frame-by-frame native resizing. Visiting a listing performs no package download: **Review & install** creates a transient, cryptographically verified Extension Install Preview, and only a second explicit confirmation publishes and loads that exact package. Dismissal is scoped to the current tab and listing, while committed operations continue truthfully through download, verification, preparation, installation, and finishing states.

## Consequences

- Listing text is provisional, plain text, and never establishes package identity; verified manifest data replaces it before confirmation.
- The banner remains contextual for installed, disabled, update, unsupported, failed, and removing states rather than disappearing after installation.
- Progress reports measured bytes or real pipeline stages and never invents percentages.
- Chrome Web Store themes remain unsupported and cannot enter the extension load path.
