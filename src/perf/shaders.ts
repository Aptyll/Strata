/**
 * WGSL for the perf path (PerfEngine in ./engine.ts).
 *
 * Packed particle, 8 bytes (CPU twins of the packing are in ./packing.ts):
 *   word 0  pos  x:u16 | y:u16 << 16   unorm over the sheet's [-1, 1) square; u16 wrap makes it a torus
 *   word 1  vel  x:i16 | y:i16 << 16   snorm, 32767 = the plane's velMax (Perf.velMax)
 *
 * Each active plane gets one uniform slot of SLOT_STRIDE bytes: three blocks,
 * each on the 256-byte dynamic offset alignment, bound with dynamic offsets.
 *   +0    Globals  the engine's layout exactly, written by packGlobals (src/gpu/shaderLib.ts)
 *   +256  Plane    the engine's layout exactly, written by packPlane
 *   +512  Perf     this path's own block, `struct Perf` below, written by packPerf
 *
 * Bind group 0, one per particle page (ParticlePool in ./particlePool.ts):
 *   0 Globals   1 Plane   2 Perf   3 the page's packed particles   4 atomic framebuffer
 *
 * Shaders:
 *   buildSimRasterWGSL(behavior)  one pass does everything per particle:
 *       unpack, `simulateParticle` (the behavior plus pointer brushes, from the
 *       engine's own prelude, so behaviors run unchanged), pack, project and
 *       atomicAdd into a u32 framebuffer. Simulation and drawing share one read
 *       of the particle, which matters because at tens of millions of
 *       particles the frame is bound by memory bandwidth, not math.
 *   INIT_WGSL     default seeding on the GPU: uniform positions, at rest.
 *   RESOLVE_WGSL  fullscreen pass from the atomic framebuffer to the target.
 */

import type { Behavior } from '../core/contracts';
import {
  behaviorPreludeWGSL,
  DISPATCH_ROW_PARTICLES,
  GLOBALS_SIZE,
  PLANE_UNIFORM_SIZE,
  WORKGROUP_SIZE,
} from '../gpu/shaderLib';
import { BASIC_TONE_WGSL, FULLSCREEN_VS_WGSL, PCG_WGSL, U01_WGSL } from '../gpu/wgsl';

/**
 * Fixed-point value of one full-brightness particle hit in an atomic
 * framebuffer (this engine's and the atomic raster pass's). The resolve
 * divides by it. 256 leaves 24 bits of headroom: 16M full hits per pixel.
 */
export const LIGHT_ONE = 256;

/** Dynamic offset alignment, and the size of each block in a uniform slot. */
export const BLOCK_ALIGN = 256;
export const SLOT_STRIDE = BLOCK_ALIGN * 3;
export const GLOBALS_BLOCK_SIZE = GLOBALS_SIZE;
export const PLANE_BLOCK_SIZE = PLANE_UNIFORM_SIZE;
if (GLOBALS_BLOCK_SIZE > BLOCK_ALIGN || PLANE_BLOCK_SIZE > BLOCK_ALIGN) {
  throw new Error('perf: a core uniform outgrew its 256-byte block. Raise BLOCK_ALIGN in src/perf/shaders.ts.');
}
/** Bytes of `struct Perf`. */
export const PERF_BLOCK_SIZE = 96;

/** Perf.flags bits. */
export const FLAG_SIM = 1;
export const FLAG_DRAW = 2;
export const FLAG_BILINEAR = 4;

const PERF_DECLS = /* wgsl */ `
struct Perf {
  mvp: mat4x4f,     //  0  viewProj * plane model, so projection is one multiply
  base: u32,        // 64  first particle of the plane inside its page
  drawCount: u32,   // 68  particles to rasterize (the LOD prefix)
  simCount: u32,    // 72  particles to simulate
  weight: u32,      // 76  fixed-point light per drawn particle (LIGHT_ONE = 1.0); INIT_WGSL reads the plane's u32 seed here
  flags: u32,       // 80  FLAG_SIM 1, FLAG_DRAW 2, FLAG_BILINEAR 4
  fbWidth: u32,     // 84
  fbHeight: u32,    // 88
  velMax: f32,      // 92  speed that maps to snorm 1.0
}

struct Packed {
  pos: u32, // x:u16 | y:u16 << 16, unorm over the sheet's [-1, 1) square
  vel: u32, // x:i16 | y:i16 << 16, snorm * velMax
}

@group(0) @binding(2) var<uniform> perf: Perf;
@group(0) @binding(3) var<storage, read_write> perfStore: array<Packed>;
`;

/** The values of one `struct Perf` block. */
export interface PerfValues {
  /** viewProj * plane model, column-major. */
  mvp: ArrayLike<number>;
  /** First particle of the plane inside its page. */
  base: number;
  /** Particles to rasterize (the LOD prefix). */
  drawCount: number;
  /** Particles to simulate. */
  simCount: number;
  /** Fixed-point light per drawn particle (LIGHT_ONE = 1.0). INIT_WGSL reads the plane's u32 seed here instead. */
  weight: number;
  /** FLAG_SIM | FLAG_DRAW | FLAG_BILINEAR. */
  flags: number;
  fbWidth: number;
  fbHeight: number;
  /** Speed that maps to snorm 1.0. */
  velMax: number;
}

/** Writes one Perf block (PERF_BLOCK_SIZE bytes, offsets as in `struct Perf`) at `byteOffset` of `out`. */
export function packPerf(out: DataView, byteOffset: number, v: PerfValues): void {
  for (let k = 0; k < 16; k++) out.setFloat32(byteOffset + 4 * k, v.mvp[k], true);
  out.setUint32(byteOffset + 64, v.base, true);
  out.setUint32(byteOffset + 68, v.drawCount, true);
  out.setUint32(byteOffset + 72, v.simCount, true);
  out.setUint32(byteOffset + 76, v.weight, true);
  out.setUint32(byteOffset + 80, v.flags, true);
  out.setUint32(byteOffset + 84, v.fbWidth, true);
  out.setUint32(byteOffset + 88, v.fbHeight, true);
  out.setFloat32(byteOffset + 92, v.velMax, true);
}

/** Packing between `Packed` and the engine's `Particle`. Needs `pcg` and `u01` in scope. */
const PACK_FNS = /* wgsl */ `
fn perfUnpack(s: Packed) -> Particle {
  let pos = vec2f(f32(s.pos & 0xffffu), f32(s.pos >> 16u)) * (2.0 / 65536.0) - 1.0;
  let vel = vec2f(f32(i32(s.vel << 16u) >> 16u), f32(i32(s.vel) >> 16u)) * (perf.velMax / 32767.0);
  return Particle(pos, vel);
}

// Dithered rounding: round up with probability equal to the fractional part,
// so motion and acceleration smaller than one quantum survive on average and
// values already on the grid stay exactly where they are. (floor(t + r) is not
// safe here: near 65535 the f32 ulp is 1/256, so t + r can round up a whole
// quantum.) u16 wrap makes the sheet a torus for anything a behavior lets leave it.
fn perfDither(t: vec2f, r: vec2f) -> vec2i {
  let b = floor(t);
  return vec2i(b) + vec2i(r < (t - b));
}

fn perfPack(p: Particle, seed: u32) -> Packed {
  let h0 = pcg(seed);
  let h1 = pcg(h0);
  let h2 = pcg(h1);
  let h3 = pcg(h2);
  let pq = perfDither((p.pos * 0.5 + 0.5) * 65536.0, vec2f(u01(h0), u01(h1))) & vec2i(0xffff);
  let vq = clamp(
    perfDither(p.vel * (32767.0 / perf.velMax), vec2f(u01(h2), u01(h3))),
    vec2i(-32767),
    vec2i(32767),
  );
  return Packed(u32(pq.x) | (u32(pq.y) << 16u), (u32(vq.x) & 0xffffu) | (u32(vq.y) << 16u));
}
`;

/** The fused simulate + rasterize compute shader for one behavior. */
export function buildSimRasterWGSL(behavior: Behavior): string {
  // The engine's behavior scope, with Plane moved into this path's bind group
  // and without the engine's f32 particle array (particles live in perfStore).
  const prelude = behaviorPreludeWGSL(behavior, { plane: '@group(0) @binding(1)', particles: null });
  return /* wgsl */ `${prelude}
${PERF_DECLS}
@group(0) @binding(4) var<storage, read_write> perfFb: array<atomic<u32>>;
${U01_WGSL}
${PACK_FNS}

fn perfSplat(x: i32, y: i32, w: u32) {
  if (w == 0u || x < 0 || y < 0 || x >= i32(perf.fbWidth) || y >= i32(perf.fbHeight)) { return; }
  atomicAdd(&perfFb[u32(y) * perf.fbWidth + u32(x)], w);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ${DISPATCH_ROW_PARTICLES}u;
  let doSim = (perf.flags & ${FLAG_SIM}u) != 0u && i < perf.simCount;
  let doDraw = (perf.flags & ${FLAG_DRAW}u) != 0u && i < perf.drawCount;
  if (!doSim && !doDraw) { return; }

  let idx = perf.base + i;
  var p = perfUnpack(perfStore[idx]);

  if (doSim) {
    p = simulateParticle(p, i);
    perfStore[idx] = perfPack(p, idx ^ (globals.frame * 0x9e3779b9u) ^ bitcast<u32>(plane.seed));
  }

  if (doDraw) {
    let clip = perf.mvp * vec4f(p.pos, 0.0, 1.0);
    if (clip.w <= 0.0) { return; }
    let ndc = clip.xyz / clip.w;
    if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0 || ndc.z < 0.0 || ndc.z > 1.0) { return; }
    let px = (ndc.xy * vec2f(0.5, -0.5) + 0.5) * vec2f(f32(perf.fbWidth), f32(perf.fbHeight));
    if ((perf.flags & ${FLAG_BILINEAR}u) != 0u) {
      let q = px - 0.5;
      let b = floor(q);
      let f = q - b;
      let x = i32(b.x);
      let y = i32(b.y);
      let w = f32(perf.weight);
      perfSplat(x, y, u32(w * (1.0 - f.x) * (1.0 - f.y) + 0.5));
      perfSplat(x + 1, y, u32(w * f.x * (1.0 - f.y) + 0.5));
      perfSplat(x, y + 1, u32(w * (1.0 - f.x) * f.y + 0.5));
      perfSplat(x + 1, y + 1, u32(w * f.x * f.y + 0.5));
    } else {
      perfSplat(i32(px.x), i32(px.y), perf.weight);
    }
  }
}
`;
}

/**
 * Default seeding on the GPU, matching the engine's default: uniform random
 * positions, at rest, so 50M particles never cross the CPU. Perf.weight
 * carries the plane's u32 seed (see seedOnGpu in ./engine.ts).
 */
export const INIT_WGSL = /* wgsl */ `
${PERF_DECLS}
${PCG_WGSL}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ${DISPATCH_ROW_PARTICLES}u;
  if (i >= perf.simCount) { return; }
  // 32 random bits are exactly one uniform packed position.
  perfStore[perf.base + i] = Packed(pcg(i * 2u + 1u + perf.weight * 0x9e3779b9u), 0u);
}
`;

/**
 * Fullscreen resolve of the atomic framebuffer. Entry point `fsTonemap`
 * writes the finished image with the basic tone curve; `fsHdr` writes linear
 * light for an additive HDR target. ResolveU is written by PerfEngine.encode.
 */
export const RESOLVE_WGSL = /* wgsl */ `
struct ResolveU {
  width: u32,
  height: u32,
  brightness: f32,
  pad: f32,
}
@group(0) @binding(0) var<uniform> R: ResolveU;
@group(0) @binding(1) var<storage, read> fb: array<u32>;
${FULLSCREEN_VS_WGSL}
${BASIC_TONE_WGSL}

fn light(pos: vec4f) -> f32 {
  let x = min(u32(pos.x), R.width - 1u);
  let y = min(u32(pos.y), R.height - 1u);
  return f32(fb[y * R.width + x]) * (R.brightness / ${LIGHT_ONE}.0);
}

@fragment
fn fsTonemap(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let v = basicTone(light(pos));
  return vec4f(v, v, v, 1.0);
}

@fragment
fn fsHdr(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let v = light(pos);
  return vec4f(v, v, v, 1.0);
}
`;
