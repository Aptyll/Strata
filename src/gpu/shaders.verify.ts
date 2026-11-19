/**
 * Compile check for the engine's generated shaders: every registered
 * behavior wrapped by buildSimShader must compile and pass the WGSL lint.
 * Runs with `npm run verify` (about a second, software GPU is fine).
 */

import { behaviors } from "../behaviors";
import { shaderCase } from "../verify/shader-case";
import type { VerifyCase } from "../verify/types";
import { buildSimShader } from "./shaderLib";

const cases: VerifyCase[] = behaviors.map((b) => shaderCase(`engine sim shader compiles: ${b.id}`, () => buildSimShader(b)));

export default cases;
