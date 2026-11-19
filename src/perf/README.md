# src/perf

The high particle count path. Two parts: pieces the app uses, and `PerfEngine`, a standalone engine with 8-byte packed particles and a fused simulate-and-rasterize kernel. See `docs/perf.md`.

- **Used by the app:** `atomicRasterPass.ts` (`createAtomicRasterPass`: the app's default compute rasterizer, kept under its old names as a re-export of `src/raster`) and `budget.ts` (`PerfBudget`: density cap per plane).
- **Standalone engine:** `engine.ts` (`PerfEngine`), `shaders.ts`, `packing.ts` (8-byte particle format), `particlePool.ts` (paged storage past the 256 MB buffer limit), `culling.ts` (frustum culling and LOD), `gpuTimer.ts` (timestamp queries), `index.ts`. Matrices come from `src/math.ts`, the device from `requestGpuDevice` in `src/gpu/context.ts`.
- **`bench/`:** benchmark page (`/src/perf/bench/`, also in the production build; `?selftest=1` runs exact-sum checks). Its shaders are compiled by `src/verify/cases/shaders.verify.ts` (`npm run verify`).
- **Depends on:** `src/core/contracts.ts`, `src/gpu`, `src/behaviors`, `src/world/layout` (bench).
- **Status:** atomic raster and budget live in the app; `PerfEngine` standalone (bench only).
