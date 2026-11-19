// WGSL for the trillion particle splat kernel. See docs/trillion.md.
//
// One invocation evaluates `perThread` stateless particles of one plane and
// adds exactly 1 to exactly one pixel counter for each particle that lands
// in the frame. Nothing is stored per particle.

/** Bytes per batch record in the uniform ring (minUniformBufferOffsetAlignment). */
export const SLOT_BYTES = 256;
export const WORKGROUP = 256;

/**
 * Helpers every law may call. Same names and signatures as the offline
 * runner's law interface: pcg, u01, tri, draw, TAU.
 */
export const LAW_PRELUDE = /* wgsl */ `
const TAU: f32 = 6.283185307179586;
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// Uniform in [0, 1), 24 bits, never returns 1.
fn u01(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
// Triangular on (-1, 1): difference of two 16 bit uniforms from one hash.
fn tri(h: u32) -> f32 { return (f32(h & 0xffffu) - f32(h >> 16u)) * (1.0 / 65536.0); }
// k-th independent draw for a particle key. Laws use k = 0..5.
fn draw(key: u32, k: u32) -> u32 { return pcg(key + (k + 1u) * 0x9e3779b9u); }
`;

const BATCH_STRUCT = /* wgsl */ `
struct Batch {
  r0: vec4f,        // homography rows: (px*w, py*w, w) = r.x*sx + r.y*sy + r.z
  r1: vec4f,
  r2: vec4f,        // r2.w = smallest w accepted (near plane)
  p0: vec4f,        // law params 0..3
  p1: vec4f,        // law params 4..7
  start: u32,       // first plane-local particle index of this dispatch
  count: u32,       // particles in this dispatch, <= 2^31
  perThread: u32,   // particles per invocation
  gridX: u32,       // workgroups per row of the 2D dispatch
  groups: u32,      // workgroups that do work (gridX * gridY may overshoot)
  seed: u32,        // plane seed
  salt: u32,        // frame salt for sub-pixel and shutter jitter
  keep: u32,        // keep a particle when (hash >> 8) < keep; 2^24 keeps all
  width: u32,
  height: u32,
  flags: u32,       // bit 0: stochastic sub-pixel splat
  _pad: u32,
  time: f32,        // seconds
  shutter: f32,     // seconds of exposure; 0 = no motion blur
  _pad2: vec2f,
  tile: vec4i,      // shared memory window: x0, y0, w, h (w * h <= TILE_BINS); w = 0: none
};
`;

/**
 * The splat module for one law. Two entry points:
 *   direct  every hit is a global atomicAdd (no workgroup memory)
 *   tiled   hits inside `tile` go to workgroup memory first, flushed once
 */
export function splatWgsl(law: { fn: string; wgsl: string }, tileBins: number, prelude = LAW_PRELUDE): string {
  return /* wgsl */ `
${prelude}
${law.wgsl}
${BATCH_STRUCT}
@group(0) @binding(0) var<uniform> B: Batch;
@group(0) @binding(1) var<storage, read_write> acc: array<atomic<u32>>;
// [0] landed lo, [1] landed hi, [2] in view lo, [3] in view hi
@group(0) @binding(2) var<storage, read_write> tally: array<atomic<u32>, 4>;

const TILE_BINS: u32 = ${tileBins}u;
var<workgroup> bins: array<atomic<u32>, TILE_BINS>;
var<workgroup> wgLanded: atomic<u32>;
var<workgroup> wgInView: atomic<u32>;

fn add64(i: u32, n: u32) {
  if (n == 0u) { return; }
  let old = atomicAdd(&tally[i], n);
  if (old > 0xffffffffu - n) { atomicAdd(&tally[i + 1u], 1u); }
}

// Pixel for particle (key, jitter bits), or (-1, -1) when it misses the frame.
fn project(key: u32, jr: u32, p: array<f32, 8>) -> vec2i {
  var t = B.time;
  if (B.shutter != 0.0) { t += B.shutter * (f32(jr >> 22u) * (1.0 / 1024.0) - 0.5); }
  let s = ${law.fn}(key, t, p);
  let hw = B.r2.x * s.x + B.r2.y * s.y + B.r2.z;
  if (!(hw > B.r2.w)) { return vec2i(-1); }       // behind the camera, or NaN
  let inv = 1.0 / hw;
  let qx = (B.r0.x * s.x + B.r0.y * s.y + B.r0.z) * inv;
  let qy = (B.r1.x * s.x + B.r1.y * s.y + B.r1.z) * inv;
  var ix: i32;
  var iy: i32;
  if ((B.flags & 1u) != 0u) {
    // Stochastic bilinear: pick one of the 4 nearest pixels with the bilinear
    // weight as probability. floor + compare, never floor(x + r) (f32 creep).
    let ax = qx - 0.5;
    let ay = qy - 0.5;
    let bx = floor(ax);
    let by = floor(ay);
    ix = i32(bx) + select(0, 1, f32(jr & 0x7ffu) * (1.0 / 2048.0) < ax - bx);
    iy = i32(by) + select(0, 1, f32((jr >> 11u) & 0x7ffu) * (1.0 / 2048.0) < ay - by);
  } else {
    ix = i32(floor(qx));
    iy = i32(floor(qy));
  }
  if (u32(ix) >= B.width || u32(iy) >= B.height) { return vec2i(-1); }
  return vec2i(ix, iy);
}

fn params() -> array<f32, 8> {
  return array<f32, 8>(B.p0.x, B.p0.y, B.p0.z, B.p0.w, B.p1.x, B.p1.y, B.p1.z, B.p1.w);
}

fn kept(jr: u32) -> bool {
  return B.keep >= 0x1000000u || (pcg(jr ^ 0x5bd1e995u) >> 8u) < B.keep;
}

@compute @workgroup_size(${WORKGROUP})
fn direct(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let wgIndex = wg.x + wg.y * B.gridX;
  if (wgIndex >= B.groups) { return; }
  let base = wgIndex * ${WORKGROUP}u * B.perThread;
  let p = params();
  var landed = 0u;
  var inView = 0u;
  for (var j = 0u; j < B.perThread; j++) {
    let off = base + j * ${WORKGROUP}u + lid;
    if (off >= B.count) { break; }
    let key = pcg(pcg(B.start + off) + B.seed);
    let jr = pcg(key ^ B.salt);
    let px = project(key, jr, p);
    if (px.x < 0) { continue; }
    inView += 1u;
    if (!kept(jr)) { continue; }
    landed += 1u;
    atomicAdd(&acc[u32(px.y) * B.width + u32(px.x)], 1u);
  }
  atomicAdd(&wgLanded, landed);
  atomicAdd(&wgInView, inView);
  workgroupBarrier();
  if (lid == 0u) {
    add64(0u, atomicLoad(&wgLanded));
    add64(2u, atomicLoad(&wgInView));
  }
}

@compute @workgroup_size(${WORKGROUP})
fn tiled(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let wgIndex = wg.x + wg.y * B.gridX;
  if (wgIndex >= B.groups) { return; }
  let base = wgIndex * ${WORKGROUP}u * B.perThread;
  let p = params();
  let tile = B.tile;
  let tw = u32(tile.z);
  let th = u32(tile.w);
  var landed = 0u;
  var inView = 0u;
  // Workgroup memory starts zeroed (WebGPU guarantees it).
  for (var j = 0u; j < B.perThread; j++) {
    let off = base + j * ${WORKGROUP}u + lid;
    if (off >= B.count) { break; }
    let key = pcg(pcg(B.start + off) + B.seed);
    let jr = pcg(key ^ B.salt);
    let px = project(key, jr, p);
    if (px.x < 0) { continue; }
    inView += 1u;
    if (!kept(jr)) { continue; }
    landed += 1u;
    let lx = u32(px.x - tile.x);
    let ly = u32(px.y - tile.y);
    if (lx < tw && ly < th) {
      atomicAdd(&bins[ly * tw + lx], 1u);
    } else {
      atomicAdd(&acc[u32(px.y) * B.width + u32(px.x)], 1u);
    }
  }
  atomicAdd(&wgLanded, landed);
  atomicAdd(&wgInView, inView);
  workgroupBarrier();
  let area = tw * th;
  for (var b = lid; b < area; b += ${WORKGROUP}u) {
    let v = atomicLoad(&bins[b]);
    if (v != 0u) {
      let x = u32(tile.x) + b % tw;
      let y = u32(tile.y) + b / tw;
      atomicAdd(&acc[y * B.width + x], v);
    }
  }
  if (lid == 0u) {
    add64(0u, atomicLoad(&wgLanded));
    add64(2u, atomicLoad(&wgInView));
  }
}
`;
}

/**
 * Adds the 32 bit hot counters into the 64 bit counters (CountToneMapper
 * layout, words = 2: lo at 2i, hi at 2i + 1) and zeroes them.
 */
export const FOLD_WGSL = /* wgsl */ `
struct Fold { pixels: u32, rowStride: u32, _a: u32, _b: u32 };
@group(0) @binding(0) var<uniform> F: Fold;
@group(0) @binding(1) var<storage, read_write> acc: array<u32>;
@group(0) @binding(2) var<storage, read_write> counts: array<u32>;

@compute @workgroup_size(${WORKGROUP})
fn fold(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x + g.y * F.rowStride;
  if (i >= F.pixels) { return; }
  let v = acc[i];
  if (v == 0u) { return; }
  acc[i] = 0u;
  let lo = counts[2u * i];
  let n = lo + v;
  counts[2u * i] = n;
  if (n < lo) { counts[2u * i + 1u] = counts[2u * i + 1u] + 1u; }
}
`;
