/**
 * WGSL for the perf path.
 *
 * One compute pass does everything per particle: unpack, run the plane's
 * behavior, pack, and rasterize by atomicAdd into a u32 framebuffer.
 * Simulation and rendering share a single read of the particle data, which
 * matters because at tens of millions of particles the frame is bound by
 * memory bandwidth, not math.
 *
 * Behaviors are the shared engine's own (`Behavior` in src/core/contracts.ts).
 * The shader is derived from the core engine's `buildSimShader`, so behaviors
 * see exactly the same prelude and helpers (rand, noise2, wrap, respawn, ...)
 * and run unchanged. Only the storage and the entry point are swapped.
 */

import type { Behavior } from '../core/contracts';
import { BRUSH_DISPLACE, buildSimShader, GLOBALS_SIZE, PLANE_UNIFORM_SIZE } from '../gpu/shaderLib';

export const WORKGROUP_SIZE = 256;
/**
 * Workgroups per dispatch row; planes larger than one row dispatch several rows.
 * Short rows keep the overshoot small: a 2D dispatch is a rectangle, so up to
 * one row of invocations runs past the count. 256 groups wastes under 65,536
 * invocations per dispatch; 32,768 wasted up to 8.4 million.
 */
export const DISPATCH_ROW_GROUPS = 256;
/** Fixed-point value of one full-brightness particle in the atomic framebuffer. */
export const WEIGHT_ONE = 256;

/**
 * Each active plane gets one slot of three uniform blocks, each aligned to the
 * 256-byte dynamic offset granularity: Globals, Plane (both laid out exactly
 * like the core engine's) and Perf (this path's own data).
 */
export const BLOCK_ALIGN = 256;
export const SLOT_STRIDE = BLOCK_ALIGN * 3;
export const GLOBALS_BLOCK_SIZE = GLOBALS_SIZE;
export const PLANE_BLOCK_SIZE = PLANE_UNIFORM_SIZE;
if (GLOBALS_BLOCK_SIZE > BLOCK_ALIGN || PLANE_BLOCK_SIZE > BLOCK_ALIGN) {
  throw new Error('perf: a core uniform outgrew its 256-byte block. Raise BLOCK_ALIGN in src/perf/shaders.ts.');
}
export const PERF_BLOCK_SIZE = 96;

export const FLAG_SIM = 1;
export const FLAG_DRAW = 2;
export const FLAG_BILINEAR = 4;

export function dispatchSize(count: number): [number, number] {
  const groups = Math.ceil(count / WORKGROUP_SIZE);
  return [Math.min(groups, DISPATCH_ROW_GROUPS), Math.ceil(groups / DISPATCH_ROW_GROUPS)];
}

const PERF_DECLS = /* wgsl */ `
struct Perf {
  mvp: mat4x4f,     //  0  viewProj * plane model, so projection is one multiply
  base: u32,        // 64  first particle of the plane inside its page
  drawCount: u32,   // 68  particles to rasterize (LOD prefix)
  simCount: u32,    // 72  particles to simulate
  weight: u32,      // 76  fixed-point brightness per particle
  flags: u32,       // 80  1 sim, 2 draw, 4 bilinear splat
  fbWidth: u32,     // 84
  fbHeight: u32,    // 88
  velMax: f32,      // 92  velocity that maps to snorm 1.0
}

struct Packed {
  pos: u32, // x:u16 | y:u16 << 16, unorm over the sheet's [-1, 1) square
  vel: u32, // x:i16 | y:i16 << 16, snorm * velMax
}

@group(0) @binding(2) var<uniform> perf: Perf;
@group(0) @binding(3) var<storage, read_write> perfStore: array<Packed>;
`;

const PACK_FNS = /* wgsl */ `
fn perfHash(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn perfRnd(h: u32) -> f32 {
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

fn perfUnpack(s: Packed) -> Particle {
  let pos = vec2f(f32(s.pos & 0xffffu), f32(s.pos >> 16u)) * (2.0 / 65536.0) - 1.0;
  let vel = vec2f(f32(i32(s.vel << 16u) >> 16u), f32(i32(s.vel) >> 16u)) * (perf.velMax / 32767.0);
  return Particle(pos, vel);
}

// Dithered rounding: round up with probability equal to the fractional part,
// so motion and acceleration smaller than one quantum survive on average and
// values already on the grid stay exactly where they are. u16 wrap makes the
// sheet a torus for anything a behavior lets leave it.
fn perfDither(t: vec2f, r: vec2f) -> vec2i {
  let b = floor(t);
  return vec2i(b) + vec2i(r < (t - b));
}

fn perfPack(p: Particle, seed: u32) -> Packed {
  let h0 = perfHash(seed);
  let h1 = perfHash(h0);
  let h2 = perfHash(h1);
  let h3 = perfHash(h2);
  let pq = perfDither((p.pos * 0.5 + 0.5) * 65536.0, vec2f(perfRnd(h0), perfRnd(h1))) & vec2i(0xffff);
  let vq = clamp(
    perfDither(p.vel * (32767.0 / perf.velMax), vec2f(perfRnd(h2), perfRnd(h3))),
    vec2i(-32767),
    vec2i(32767),
  );
  return Packed(u32(pq.x) | (u32(pq.y) << 16u), (u32(vq.x) & 0xffffu) | (u32(vq.y) << 16u));
}
`;

function mustReplace(src: string, pattern: RegExp, replacement: string, what: string): string {
  if (!pattern.test(src)) {
    throw new Error(`perf: the core sim shader changed shape (${what}). Update src/perf/shaders.ts.`);
  }
  return src.replace(pattern, replacement);
}

/** The core engine's prelude and the behavior's WGSL, rebound to this path's bind group. */
function corePrelude(behavior: Behavior): string {
  let src = buildSimShader(behavior);
  src = mustReplace(src, /@compute[\s\S]*$/, '', 'entry point');
  src = mustReplace(
    src,
    /@group\(0\)\s*@binding\(0\)\s*var<uniform>\s*globals\s*:\s*Globals\s*;/,
    '@group(0) @binding(0) var<uniform> globals: Globals;',
    'globals binding',
  );
  src = mustReplace(
    src,
    /@group\(1\)\s*@binding\(0\)\s*var<uniform>\s*plane\s*:\s*Plane\s*;/,
    '@group(0) @binding(1) var<uniform> plane: Plane;',
    'plane binding',
  );
  src = mustReplace(
    src,
    /@group\(1\)\s*@binding\(1\)\s*var<storage,\s*read_write>\s*particles\s*:\s*array<Particle>\s*;/,
    '',
    'particle storage binding',
  );
  return src;
}

export function buildSimRasterWGSL(behavior: Behavior): string {
  return /* wgsl */ `${corePrelude(behavior)}
${PERF_DECLS}
@group(0) @binding(4) var<storage, read_write> perfFb: array<atomic<u32>>;
${PACK_FNS}

fn perfSplat(x: i32, y: i32, w: u32) {
  if (w == 0u || x < 0 || y < 0 || x >= i32(perf.fbWidth) || y >= i32(perf.fbHeight)) { return; }
  atomicAdd(&perfFb[u32(y) * perf.fbWidth + u32(x)], w);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ${DISPATCH_ROW_GROUPS * WORKGROUP_SIZE}u;
  let doSim = (perf.flags & ${FLAG_SIM}u) != 0u && i < perf.simCount;
  let doDraw = (perf.flags & ${FLAG_DRAW}u) != 0u && i < perf.drawCount;
  if (!doSim && !doDraw) { return; }

  let idx = perf.base + i;
  var p = perfUnpack(perfStore[idx]);

  if (doSim) {
    p = update(p, i);
    // Pointer brushes, applied exactly like the core engine's entry point.
    let push = brushAccel(p.pos) * globals.dt;
    p.vel += push;
    p.pos += push * ${BRUSH_DISPLACE.toFixed(3)};
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
 * Default seeding on the GPU, matching the core engine's default: uniform
 * random positions, at rest. 50M particles never cross the CPU.
 * perf.weight carries the seed.
 */
export const INIT_WGSL = /* wgsl */ `
struct Particle { pos: vec2f, vel: vec2f }
${PERF_DECLS}
${PACK_FNS}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ${DISPATCH_ROW_GROUPS * WORKGROUP_SIZE}u;
  if (i >= perf.simCount) { return; }
  // 32 random bits are exactly one uniform packed position.
  perfStore[perf.base + i] = Packed(perfHash(i * 2u + 1u + perf.weight * 0x9e3779b9u), 0u);
}
`;

/**
 * Fullscreen resolve of the atomic framebuffer. Entry point \`fsTonemap\` writes
 * the finished image (same curve as the core tonemap pass); \`fsHdr\` writes
 * linear light for an additive HDR target.
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

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn light(pos: vec4f) -> f32 {
  let x = min(u32(pos.x), R.width - 1u);
  let y = min(u32(pos.y), R.height - 1u);
  return f32(fb[y * R.width + x]) * (R.brightness / ${WEIGHT_ONE}.0);
}

@fragment
fn fsTonemap(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let v = pow(1.0 - exp(-light(pos)), 1.0 / 2.2);
  return vec4f(v, v, v, 1.0);
}

@fragment
fn fsHdr(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let v = light(pos);
  return vec4f(v, v, v, 1.0);
}
`;
