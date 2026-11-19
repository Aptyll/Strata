# src/raster

The app's default rasterizer, the `atomic-raster` pass: a compute shader projects every particle and adds its light into one `u32` per pixel with `atomicAdd` (`LIGHT_ONE` = 256 per full-brightness hit), and one fullscreen draw adds that grid to the HDR target. Nothing blends per particle, so a pixel keeps counting to 16.7 million full hits instead of stopping near 2048 like an f16 blend.

Two options, off by default, each its own pipeline so the default pays nothing for them:

| option | URL | live switch | what it does |
| --- | --- | --- | --- |
| sub-pixel | `?subpixel=1` | `pass.subpixel` | splits each particle over the 2x2 pixels around its true position (bilinear), so slow motion stays smooth below one pixel |
| depth cues | `?depth=1` | `pass.depth`, `pass.params`, `pass.autofocus` | fog, near fade and size gain as a weight per particle, and depth of field as a fixed point inside the circle of confusion, from `src/depth` (`depth_point_weight`, `depth_lens_jitter_ndc`) |

The weighted variants round with a hash (stochastic rounding), so dim light survives on average. The lens offset is hashed from the particle, not the frame, so blurred sheets do not shimmer. With both options off, `rasterKernelWgsl()` returns the kernel the pass has run since PR #8, byte for byte.

- **Key files:** `kernel.ts` (`rasterKernelWgsl`, the four kernels, and the composite), `pass.ts` (`createComputeRasterPass`: pipelines, world fit and autofocus for the depth cues, fog culling of whole planes).
- **Depends on:** `src/core/contracts.ts`, `src/gpu` (shared structs, `dispatchSize`), `src/depth` (`DepthParams`, the WGSL library, `depthSettingsForWorld`, `FocusTracker`), `src/perf/shaders.ts` (`LIGHT_ONE`).
- **Used by:** `src/app/graph.ts` (the default rasterizer; `?depth=1` and `?subpixel=1` come from `src/app/options.ts`). `src/perf/atomicRasterPass.ts` re-exports it under the old names (`createAtomicRasterPass`, `ATOMIC_RASTER_WGSL`), which the perf bench and `src/verify` still use.
- **Tests:** `raster.verify.ts` (`npm run verify -- raster`) runs the kernels on a GPU: the exact point add, the exact 2x2 split, fog against `DepthParams.pointWeight`, and depth of field spreading light inside the circle of confusion without losing any.
- **Status:** live in the app as the default rasterizer. The two options are checked on a software GPU only, and have no menu switches yet.
