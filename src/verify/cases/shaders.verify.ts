/**
 * Every production shader the app, the challenge mode, the perf path and the
 * offline renderer build, compiled with the real WGSL compiler and linted.
 * (The density pipeline in src/render builds its own pipelines in
 * src/render/render.verify.ts.)
 * Compile-only, so the whole file runs in well under a second. A behavior
 * that breaks any engine's shader shows up here by name.
 */

import { behaviors } from "../../behaviors";
import { initWgsl, procWgsl, resolveWgsl, simWgsl } from "../../challenge/shaders";
import { DEPTH_SPRITE_WGSL } from "../../depth/sprite-pass";
import { buildSimShader } from "../../gpu/shaderLib";
import { accumulateShader } from "../../offline/core/shaders";
import { POINTS_WGSL } from "../../passes/points.pass";
import { BASIC_TONEMAP_WGSL } from "../../passes/tonemap.pass";
import { ATOMIC_COMPOSITE_WGSL, ATOMIC_RASTER_WGSL } from "../../perf/atomicRasterPass";
import { buildSimRasterWGSL, INIT_WGSL, RESOLVE_WGSL } from "../../perf/shaders";
import { rasterKernelWgsl } from "../../raster/kernel";
import { shaderCase } from "../shader-case";
import type { VerifyCase } from "../types";

const cases: VerifyCase[] = [
  ...behaviors.map((b) => shaderCase(`engine sim: ${b.id}`, () => buildSimShader(b))),
  ...behaviors.map((b) => shaderCase(`perf sim+raster: ${b.id}`, () => buildSimRasterWGSL(b))),
  shaderCase("atomic raster pass (default rasterizer)", ATOMIC_RASTER_WGSL),
  shaderCase("atomic raster composite", ATOMIC_COMPOSITE_WGSL),
  shaderCase("compute raster, sub-pixel (?subpixel=1)", () => rasterKernelWgsl({ subpixel: true })),
  shaderCase("compute raster, depth cues (?depth=1)", () => rasterKernelWgsl({ depth: true })),
  shaderCase("compute raster, depth cues and sub-pixel", () => rasterKernelWgsl({ depth: true, subpixel: true })),
  shaderCase("points pass (?raster=points)", POINTS_WGSL),
  shaderCase("depth sprite pass (?raster=sprites)", DEPTH_SPRITE_WGSL),
  shaderCase("basic tone map pass (?tonemap=basic)", BASIC_TONEMAP_WGSL),
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
