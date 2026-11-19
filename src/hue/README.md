# src/hue

One color per sheet. The color themes recolor the finished frame, so they cannot tell sheets apart; this colors inside the frame graph instead. Opt in with `?raster=hue` or the "points, one hue per sheet" rasterizer in the Esc menu.

- **Key files:** `sheetHue.ts` (`createSheetHuePasses`). It has two passes: `sheet-hue` (stage `rasterize`: one-pixel additive points that write density in red and hue-weighted density in green, blue and alpha) and `sheet-hue-tint` (stage `ui`, right after the tone map: multiplies the canvas by the per-pixel color). The shared density tone map is untouched.
- **Depends on:** `src/core/contracts.ts`, `src/gpu` (shared WGSL and layouts).
- **Used by:** the app, through `src/app/graph.ts` (the `hue` row in `RASTERIZERS`).
- **Status:** live in the app, off by default. The HDR target is f16, so colors stop adding past about 2048 hits per pixel, the same cap as the points rasterizer. A color theme other than "white" replaces these colors with its own ramp.
