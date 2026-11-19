/**
 * Every production shader the app, the challenge mode, the perf path and the
 * offline renderer build, compiled with the real WGSL compiler and linted.
 * Compile-only, so the whole file runs in well under a second. A behavior
 * that breaks any engine's shader shows up here by name.
 */

import { behaviors } from "../../behaviors";
import { initWgsl, procWgsl, resolveWgsl, simWgsl } from "../../challenge/shaders";
import { buildSimShader } from "../../gpu/shaderLib";
import { accumulateShader } from "../../offline/core/shaders";
import { buildSimRasterWGSL, INIT_WGSL, RESOLVE_WGSL } from "../../perf/shaders";
import { shaderCase } from "../shader-case";
import type { VerifyCase } from "../types";

const cases: VerifyCase[] = [
  ...behaviors.map((b) => shaderCase(`engine sim: ${b.id}`, () => buildSimShader(b))),
  ...behaviors.map((b) => shaderCase(`perf sim+raster: ${b.id}`, () => buildSimRasterWGSL(b))),
  shaderCase("perf init", INIT_WGSL),
  shaderCase("perf resolve", RESOLVE_WGSL),
  ...[64, 256].flatMap((wg) => [
    shaderCase(`challenge init (wg ${wg})`, () => initWgsl(wg)),
    shaderCase(`challenge sim (wg ${wg})`, () => simWgsl(wg)),
    shaderCase(`challenge proc (wg ${wg})`, () => procWgsl(wg)),
  ]),
  shaderCase("challenge resolve", resolveWgsl),
  ...(["kepler", "vortex", "lissajous"] as const).flatMap((law) =>
    (["point", "bilinear"] as const).map((splat) => shaderCase(`offline ${law} ${splat}`, () => accumulateShader(law, splat))),
  ),
];

export default cases;
