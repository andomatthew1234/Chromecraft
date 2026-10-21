# Chromecraft Material 3 design guide

Chromecraft uses one semantic Material 3 token system for its browser chrome, new-tab page, navigation rail, panels, menus, and dialogs. The renderer follows the operating-system light or dark preference; components consume roles rather than hard-coded component colours.

## Colour

- Primary: Google-inspired blue (`#0b57d0` light, `#adc6ff` dark).
- Surfaces: neutral-blue Material surface containers from lowest through highest.
- Secondary and tertiary roles are reserved for tonal separation and optional new-tab moods.
- Green is used only for a semantic success state, such as active content blocking.
- Error roles are used for destructive actions, failures, and no-match feedback.

## Shape, spacing, and type

- Spacing follows a 4px base scale.
- Compact controls use 8–12px corners; panels and menus use 16px; dialogs and major floating surfaces use 28px; search fields and tonal buttons are fully rounded.
- The UI uses the Material type hierarchy with Google Sans fallbacks to Segoe UI/Roboto.
- Icons use the self-hosted Material Symbols Rounded variable font, with optical size and fill controlled per icon.

## Browser chrome

- Electron's native Window Controls Overlay keeps Windows/Linux minimize, maximize, close, resize, and snap behavior while the 42px tab strip becomes the title bar.
- The tab-strip background is draggable. Tabs and buttons are explicit non-drag regions.
- Active tabs merge tonally into the toolbar; inactive tabs use state layers rather than outlines or underlines.
- The omnibox is the visual focus. Suggestions are local-only, sourced from bookmarks and history, and use the existing main-process navigation parser.
- uBlock remains a compact toolbar status; its full controls remain in Settings.

## Motion and accessibility

- Standard state changes use a 200ms emphasized easing; larger surface transitions use 300ms.
- Genuine shell initialization uses a web adaptation of the official Material 3 Expressive seven-shape loading sequence (650ms morph interval, 4666ms global rotation).
- Normal page navigation keeps the smaller tab activity indicator.
- Reduced-motion mode disables transitions and swaps the expressive animation for a static shape.
- Focus rings, selected states, live find-result announcements, keyboard omnibox navigation, semantic dialogs, and minimum desktop target sizes are preserved.

## References

- [Material Design 3](https://m3.material.io/)
- [AndroidX Material 3 LoadingIndicator source](https://android.googlesource.com/platform/frameworks/support/+/72aa0200196dcc2517b3fb340a7614bcd9147515/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/LoadingIndicator.kt)
- [Electron custom title bar guidance](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)
- [Chrome Material You desktop refresh](https://blog.google/products-and-platforms/products/chrome/google-chrome-new-features-redesign-2023/)

The requested reference video was not present with the supplied text attachment, so the loading indicator is based on Google's verified implementation and is not claimed as a pixel-for-pixel match to that missing video.
