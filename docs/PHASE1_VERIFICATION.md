# Phase 1 verification

Verified on 2026-10-15 using the packaged x64 application on Windows 11 Pro build 26200, an Intel Core i7-7700K, and 32 GB RAM.

## Automated checks

- TypeScript strict type check: passed.
- Formatting/lint gate: passed.
- URL/omnibox unit tests: 6 passed.
- Windows x64 Electron Forge package: passed.
- Linux x64 Electron Forge package: passed; output contains an x64 ELF executable, Chromium sandbox binary, ASAR bundle, and uBlock Origin 1.75.0 resources.
- Packaged Windows smoke suite: passed with no reported failures.

## Packaged Windows smoke results

The smoke suite launches real packaged applications using isolated profiles and a deterministic loopback web server.

| Check                                      | Result                                                       |
| ------------------------------------------ | ------------------------------------------------------------ |
| Disabled-uBlock control request            | Loaded; server received two requests across the two-tab flow |
| Enabled-uBlock request                     | Blocked; server received zero requests                       |
| uBlock version/status                      | uBlock Origin 1.75.0 ready                                   |
| uBlock dashboard                           | Loaded                                                       |
| Real HTTPS page                            | `https://example.com/` loaded                                |
| Ctrl+T, Ctrl+W, Ctrl+L                     | Passed                                                       |
| Tab lifecycle                              | Returned to one tab and one live remote view                 |
| Warm shell readiness                       | 1,161 ms                                                     |
| Warm deterministic navigation              | 282 ms                                                       |
| Warm live HTTPS navigation                 | 307 ms                                                       |
| Main-process resident memory at completion | approximately 123 MB                                         |

The first protected launch took 4,821 ms because a fresh profile copies and initializes the bundled extension. The next protected launch took 1,161 ms.

Screenshots, detailed JSON reports, and Electron logs are saved beneath `.artifacts/` by `pnpm smoke:win`.

## Known verification boundary

This Windows host has no installed WSL distribution, container runtime, or Linux Mint VM. The Linux x64 application has been cross-packaged and statically inspected here, but it has not been executed under Linux Mint on this PC. Run `pnpm smoke:linux` from a Linux Mint x64 machine before calling the Mint runtime matrix verified.

Stock Electron also does not provide uBlock with usable per-tab IDs for remote `WebContentsView` requests. Global filtering, enable/disable, dashboard/filter settings, and restart persistence are verified; the upstream per-site toolbar popup is intentionally not exposed because it would show incorrect site state.
