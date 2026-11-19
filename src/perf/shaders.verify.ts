/**
 * Compile check for the perf path's shaders: the fused simulate + rasterize
 * kernel for every registered behavior, the GPU seeding and resolve shaders,
 * and the atomic raster pass. Runs with `npm run verify`.
 */

import { behaviors } from "../behaviors";
import { shaderCase } from "../verify/shader-case";
import type { VerifyCase } from "../verify/types";
import { ATOMIC_COMPOSITE_WGSL, ATOMIC_RASTER_WGSL } from "./atomicRasterPass";
import { buildSimRasterWGSL, INIT_WGSL, RESOLVE_WGSL } from "./shaders";

const cases: VerifyCase[] = [
  ...behaviors.map((b) => shaderCase(`perf sim+raster shader compiles: ${b.id}`, () => buildSimRasterWGSL(b))),
  shaderCase("perf init shader compiles", INIT_WGSL),
  shaderCase("perf resolve shader compiles", RESOLVE_WGSL),
  shaderCase("atomic raster pass compute shader compiles", ATOMIC_RASTER_WGSL),
  shaderCase("atomic raster pass composite shader compiles", ATOMIC_COMPOSITE_WGSL),
];

export default cases;
