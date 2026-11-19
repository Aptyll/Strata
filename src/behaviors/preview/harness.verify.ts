/**
 * Compile check for the behavior preview page's own draw shaders. Its compute
 * shader is the engine's buildSimShader, already compiled for every behavior
 * in src/verify/cases/shaders.verify.ts.
 */

import { shaderCase } from "../../verify/shader-case";
import type { VerifyCase } from "../../verify/types";
import { POINTS_WGSL, TONEMAP_WGSL } from "./harness";

const cases: VerifyCase[] = [
  shaderCase("behavior preview points", POINTS_WGSL),
  shaderCase("behavior preview tone map", TONEMAP_WGSL),
];

export default cases;
