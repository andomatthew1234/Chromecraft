# Bundled media tools

Chromecraft release builds bundle a version-pinned `yt-dlp` executable and the
Deno JavaScript runtime required by modern YouTube extraction. The exact source
URLs and SHA-256 digests are in `manifest.json`.

These tools never self-update. They are replaced only by a signed Chromecraft
browser update so the browser and its media downloader remain one reviewed,
reproducible release.

`yt-dlp` is available under the Unlicense, while its standalone PyInstaller
build includes third-party components under additional licenses. Release builds
copy the upstream `LICENSE` and `THIRD_PARTY_LICENSES.txt` beside the binaries.
Deno is MIT licensed and its license is copied as `DENO_LICENSE`.
