# Update and release automation

Chromecraft keeps one authoritative application release even when the Update
Centre presents that release under Chromecraft, Browser Dependencies, or both.
Windows releases use the existing Electron Forge Squirrel.Windows package and
Electron `autoUpdater`; Chromium and Node move only when Electron moves.

## Workflows

- `CI` runs locked installs, lint, unit tests, Windows and Linux packaging,
  browser smoke tests, extension lifecycle tests, and Scout UI checks.
- `Dependabot Auto-merge` accepts only the exact Dependabot commit that passed
  the complete `CI` workflow. Major updates stop for manual compatibility
  review. A successful merge dispatches dependency maintenance.
- `Dependency Maintenance Release` verifies the merged Dependabot PR, creates a
  unique patch-version PR, explicitly dispatches CI for that bot-created commit,
  merges only that tested SHA, and calls the shared signed release workflow.
- `Feature Release` is the shared build and publish path. Intentional releases
  are dispatched manually after `package.json` is updated and merged. Select
  `chromecraft` for product code, `dependencies` for maintenance, or `both`.

Release publishing is fail-closed. The Windows app and installer must have valid
Authenticode signatures from the configured certificate. The workflow also
extracts the application executable from the full nupkg, pins its signer
thumbprint, and proves it is byte-identical to the verified packaged executable.
It then validates Squirrel's `RELEASES` entry against that full nupkg, generates
`SHA256SUMS`, re-verifies the downloaded workflow artifact, uploads everything
to a draft GitHub Release, and publishes the draft only after every check
succeeds. Existing tags and releases are never overwritten.

Each release contains:

- the Squirrel installer, full nupkg, and `RELEASES` feed artifact;
- the portable Windows ZIP;
- `release.json`, including the change category and actual Electron, Chromium,
  Node, V8, yt-dlp, and Deno versions;
- `signature-report.json`, `SHA256SUMS`, and release notes.

## Required repository setup

Complete these settings before enabling unattended maintenance releases:

1. Create a `chromecraft-release` GitHub Environment. Add required reviewers,
   restrict deployments to `main`, and do not allow administrators to bypass
   its protection for routine releases. Both the signing job and the final
   publishing job use this environment, so GitHub may request approval at each
   trust boundary.
2. Add environment secrets `WINDOWS_CERTIFICATE_PFX_BASE64`,
   `WINDOWS_CERTIFICATE_PASSWORD`, and `WINDOWS_CERTIFICATE_THUMBPRINT`. The
   first is the base64 encoding of a trusted Authenticode PFX. The thumbprint is
   the signing certificate's uppercase, 40-character SHA-1 thumbprint; it pins
   the identity after Windows validates the SHA-256 Authenticode signature.
   Never commit the certificate or password. Do not duplicate these values as
   repository-wide secrets; only the protected signing job needs them.
3. Under **Actions > General > Workflow permissions**, allow read and write
   access. The workflows still declare least-privilege permissions per job.
4. Protect `main` with required `CI` checks, require branches to be up to date,
   and disallow force pushes and branch deletion. Do not require a human review
   for the dedicated release-version PR unless maintenance releases are
   intentionally meant to pause.
5. Enable Dependabot alerts, Dependabot security updates, the dependency graph,
   and repository auto-merge. Major Dependabot updates remain blocked by the
   workflow even when auto-merge is available.
6. Verify the first signed prerelease on a disposable Windows profile before
   using the stable channel. GitHub prereleases are suitable for direct install
   and smoke testing, but `update.electronjs.org` intentionally ignores drafts
   and prereleases. Test updater discovery in a separate public test repository
   or with a disposable stable release, then confirm an upgrade from the
   previously installed Squirrel release preserves the profile.

The release workflow sets the public GitHub feed to
`update.electronjs.org/andomatthew1234/Chromecraft`. GitHub Releases must remain
public and use `vMAJOR.MINOR.PATCH` tags. Do not publish source-only or ZIP-only
releases as stable application updates.

## Dependency coverage

Dependabot covers the pnpm lockfile and GitHub Actions. Electron updates carry
their compatible Chromium and Node runtimes and are rebuilt through Forge,
including Forge's native-module rebuild phase. Major updates are tested but are
not merged automatically.

The following pinned, non-package assets still need a reviewed discovery bot or
Renovate regex manager before maintenance is truly hands-off:

- yt-dlp and Deno in `resources/media-tools/manifest.json`;
- the vendored uBlock Origin distribution and compatibility revision.

Those automations must update versions, URLs, SHA-256 values, notices, and the
relevant compatibility tests in one pull request. They must never download an
unverified binary or rewrite a checksum merely to make a failing build pass.

## Feature release

1. Update `package.json` to the intended unused semantic version and merge it
   after CI passes.
2. Copy the exact 40-character SHA of the current protected `main` tip after its
   `CI` workflow succeeds. Run **Feature Release** with that SHA, the exact
   version, category, and release notes. Use `both` when product code and
   dependencies both changed. The workflow rejects branch names, older commits,
   missing exact-SHA CI evidence, and prerelease versions whose suffix disagrees
   with the prerelease toggle before any signing secret is materialized.
3. Watch the signed build and release validation. A failure leaves no public
   release; an upload failure leaves only a draft for inspection.

Linux packages continue to use the distribution package manager. The built-in
Electron updater supports installed Squirrel.Windows builds, not development or
portable ZIP builds.
