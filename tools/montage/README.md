# tools/montage

Records short clips of the live Strata app in headless Chromium with software WebGPU
(SwiftShader), one MP4 + JSON sidecar per "look" (dice seed, theme, rasterizer, camera move).

```sh
npm ci
node tools/montage/record-looks.mjs tools/montage/looks-randomizer.json out/looks
node tools/montage/record-looks.mjs tools/montage/looks-randomizer.json out/looks --only 0,2
```

- `shim.js` is injected before the app: requestAnimationFrame runs only when the recorder steps it
  and `performance.now` advances exactly one frame, so every frame is a fixed dt; the WebGPU canvas
  renders into a plain texture that is read back (headless canvases cannot present).
- Themes are an SVG filter in the app, invisible to a readback, so the recorder applies the same ramp
  (parsed from `src/ux/theme/index.ts`) to the pixels.
- Sidecar counts are `strata.stats().particles` per captured frame (the budget's active count).
- Software GPU: about 0.7 s per 720p frame at 300k particles, much slower with `raster=sprites`.
  It shows looks and motion, never speed. Concatenate the clips with ffmpeg's concat demuxer.
