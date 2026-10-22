# Smart Downloads 2.0

Smart Downloads is a local-first YouTube channel monitor layered on top of
Chromecraft's existing yt-dlp download service and My Gallery. It is disabled
by default.

## Data and ownership

- Configuration, canonical channel IDs, bounded seen-video records, queue
  state, verified managed downloads, and recommendation aggregates are stored
  atomically in `smart-downloads/state.json` under Electron's user-data path.
- Automatic media is written only below
  `Downloads/.chromecraft-smart-downloads`. Manual downloads remain in the
  normal Downloads directory and never count toward the Smart Downloads quota.
- Original yt-dlp thumbnails are stored in the profile's managed thumbnail
  cache and served to the shell by opaque
  `chromecraft-media://thumbnail/<gallery-id>` URLs.
- Cleanup accepts only verified Smart ownership records and real paths under
  the managed roots. Manual, unknown, keep-forever, and currently-playing
  records are excluded by policy.
- Viewing recommendations are opt-in. The page preload measures actual visible
  YouTube playback in 30-second buckets. The main process validates the active
  watch URL, resolves the canonical channel with yt-dlp, and persists only
  bounded channel aggregates. Nothing is transmitted to Chromecraft services.

## Scheduling and reliability

- Channel URLs and handles are resolved through a bounded, no-shell yt-dlp
  metadata process. Recent upload scans are capped at 15 entries by default.
- The controller keeps a durable seen index distinct from the completion index,
  supports future-only or latest 1/3/5 baselines, and applies exponential
  backoff to extraction and download failures.
- Automatic jobs use `YouTubeDownloadService`, appear in the existing progress
  UI, and are tagged as Smart Downloads. Only one automatic job is dispatched
  at a time. A manual job prevents new automatic dispatch and may use the other
  global slot.
- Pausing stops queue dispatch. An already-running yt-dlp process is allowed to
  finish because portable safe process suspension is not available on Windows.
- Background mode keeps the ordinary Electron process alive in the system tray;
  no hidden service or remote scheduler is installed. Full application exit
  stops all checking and downloading.

## Format limitations

Chromecraft currently bundles integrity-pinned yt-dlp and Deno, but not FFmpeg.
Resolution choices therefore use progressive formats beneath the requested
ceiling with a graceful fallback. Original JPEG, PNG, WebP, GIF, or AVIF
thumbnails work offline. Reliable separate-stream 1080p muxing, audio
transcoding, and generated-frame thumbnail fallbacks require a future pinned,
licensed FFmpeg bundle; the UI does not claim those unsupported conversions.

## Security boundary

Website renderers can only send a bounded playback observation through their
sandboxed preload. The browser shell receives a sanitized snapshot without raw
seen-video history, observation IDs, or managed paths. All renderer mutations
use dedicated, validated IPC handlers. URLs are never interpolated into a
shell command.
