# src/depth

Depth cues for flat layers in a black void: fog into black, depth of field, size and brightness falloff, autofocus, and pointer parallax. Monochrome only. See `docs/depth.md`.

- **Entry point:** `index.ts`.
- **Key files:** `depth.wgsl.ts` (WGSL library, `depth_` prefixed), `params.ts` (CPU side of the `DepthParams` uniform), `sprite-pass.ts` (rasterize pass that draws planes as depth-cued sprites), `focus.ts` (autofocus on the nearest plane), `parallax.ts` and `parallax-camera.ts` (wrap any `CameraController` with off-axis parallax).
- **`demo/`:** standalone page with its own renderer (`/src/depth/demo/`). **`test/`:** `node src/depth/test/run.mjs`.
- **Used by:** `src/main.ts` (`createParallaxCamera`), `src/passes/sprites.pass.ts`.
- **Status:** in the app but off by default (`?depth=1` for the cues in the compute rasterizer, `src/raster`; `?raster=sprites` for the debug sprites; `?parallax=1` for parallax). Not yet tuned on a real GPU.
