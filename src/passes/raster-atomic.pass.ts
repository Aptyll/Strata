import type { GpuContext, Pass } from "../core/contracts";
import { createAtomicRasterPass } from "../perf/atomicRasterPass";

/**
 * Compute rasterizer: counts particles per pixel with atomicAdd instead of
 * drawing points. An alternative to the "points" pass, off by default.
 * Turn it on with ?raster=atomic or from the Rasterizer panel (Tab), which
 * also turns "points" off so only one of the two runs. See docs/perf.md.
 */
export default function createRasterAtomicPass(gpu: GpuContext): Pass {
  const pass = createAtomicRasterPass(gpu, { name: "raster-atomic" });
  pass.enabled = false;
  return pass;
}
