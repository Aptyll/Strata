import type { GpuContext, Pass } from "../core/contracts";
import { createDepthSpritePass } from "../depth";

/**
 * Depth-cued sprites: fog into black, depth of field, size and brightness
 * falloff. Off by default; open the app with ?depth=1, or flip `enabled` on
 * the "depth-sprites" pass at runtime. It runs after the points pass (passes
 * register in filename order) and clears the HDR target, so while it is on it
 * replaces the one pixel points. See docs/depth.md.
 */
export default function createSpritesPass(gpu: GpuContext): Pass {
  const pass = createDepthSpritePass(gpu);
  const flag = new URLSearchParams(location.search).get("depth");
  pass.enabled = flag !== null && flag !== "0" && flag !== "false";
  return pass;
}
