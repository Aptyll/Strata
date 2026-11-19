# src/render

Turns particles into the monochrome picture through a float density buffer: splat, trails, bloom, tone map. Also tone maps integer hit counters for the 1T render. See `docs/render.md`.

- **Entry point:** `index.ts`, whose header says which piece to use for which input.
- **Key files:** `passes.ts` (frame-graph adapters: `createDensityTonemapPass`, the app's tone map, and `createDensitySplatPass`, `?raster=splat`), `post.ts` (`DensityPost`: trails, bloom, tone map), `splat.ts` (`SplatAccumulator`), `counts.ts` (`CountToneMapper`: integer counters to picture), `pipeline.ts` (`DensityRenderer`: splat plus post in one object), `tonemap.ts`, `bloom.ts`, `trails.ts`, `common.ts` (shared WGSL), `render.verify.ts` (`npm run verify -- render`).
- **`demo/`:** `/src/render/demo/` (pipeline) and `/src/render/demo/counts.html` (counter tone mapping).
- **Depends on:** `src/core/contracts.ts`.
- **Used by:** `src/main.ts`, `src/passes/tonemap.pass.ts`.
- **Status:** live in the app.
