# src/passes

The app's auto-registered frame-graph passes. Every `*.pass.ts` file here default-exports `(gpu) => Pass` and is registered in filename order by `index.ts` (`createPasses`); the pass's `stage` decides when it runs.

- **Key files:** `points.pass.ts` (one-pixel point rasterizer, `?raster=points`), `sprites.pass.ts` (depth-cued sprites from `src/depth`, off unless `?depth=1`), `tonemap.pass.ts` (the one tonemap pass, using the density look from `src/render`).
- **Depends on:** `src/core/contracts.ts`, `src/gpu`, `src/depth`, `src/render`.
- **Used by:** `src/main.ts`, which keeps exactly one rasterize pass enabled at a time (the default rasterizer lives in `src/perf/atomicRasterPass.ts`).
- **Status:** live in the app.
