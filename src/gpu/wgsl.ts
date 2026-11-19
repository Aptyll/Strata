/**
 * Small WGSL building blocks shared by every shader in the repo.
 *
 * Each export is plain WGSL text. Concatenate the ones a module needs in
 * front of its own code:
 *
 *   const code = PCG_WGSL + U01_WGSL + FULLSCREEN_VS_WGSL + `...your shader...`;
 *
 * Rules:
 * - A WGSL module may declare a function only once. The behavior prelude
 *   (`buildSimShader` and `behaviorPreludeWGSL` in ./shaderLib.ts) already
 *   contains `pcg`, so code appended after it must not add PCG_WGSL again.
 * - These blocks depend on nothing else: no bindings, no structs from the
 *   engine. Engine layouts (Globals, Plane, Particle) live in ./shaderLib.ts.
 * - Changing a block changes every shader that uses it. src/gpu/shaders.verify.ts
 *   compiles the engine and perf shaders built from them (`npm run verify`).
 */

/**
 * PCG hash (RXS-M-XS variant, Jarzynski and Olano 2020). A permutation of u32:
 * distinct inputs give distinct outputs, so `pcg(index ^ key)` never repeats
 * within one key. Chain it (`pcg(pcg(x))`) for further independent values.
 * CPU twin: `pcg` in src/verify/reference.ts.
 */
export const PCG_WGSL = /* wgsl */ `
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
`;

/**
 * The top 24 bits of a hash as a float in [0, 1). Exact, and never 1.0
 * (f32(h) / 2^32 can round up to 1.0, see docs/gpu-scale.md).
 */
export const U01_WGSL = /* wgsl */ `
fn u01(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
`;

/**
 * Fullscreen triangle: draw(3) with no vertex buffer covers the target.
 * Entry point `vs`; `uv` has its origin at the top left, like texture space.
 * A fragment shader may ignore `uv` and read `@builtin(position)` instead.
 */
export const FULLSCREEN_VS_WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var o: VSOut;
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;

/**
 * The plain tone curve: accumulated light (unbounded, >= 0) to a display
 * value in [0, 1). `1 - exp(-x)` maps any sum smoothly toward white, then
 * gamma 2.2 encodes it. The density look in src/render/tonemap.ts is the
 * richer default; this is the curve of `?tonemap=basic` and the perf resolve.
 */
export const BASIC_TONE_WGSL = /* wgsl */ `
fn basicTone(light: f32) -> f32 { return pow(1.0 - exp(-light), 1.0 / 2.2); }
`;
