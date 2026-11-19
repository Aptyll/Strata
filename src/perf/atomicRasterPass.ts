/**
 * The app's default rasterizer ("atomic-raster" in src/app/graph.ts), under
 * the names it has had since PR #8. The kernel and the pass moved to
 * src/raster, where they gained optional sub-pixel splats and depth cues
 * (docs/briefs/unify-rasterizers.md). With both off, the shader is the same
 * text as before, byte for byte.
 */

export {
  createComputeRasterPass as createAtomicRasterPass,
  RASTER_COMPOSITE_WGSL as ATOMIC_COMPOSITE_WGSL,
  RASTER_KERNEL_WGSL as ATOMIC_RASTER_WGSL,
  type ComputeRasterPass as AtomicRasterPass,
  type ComputeRasterPassOptions as AtomicRasterPassOptions,
} from '../raster';
