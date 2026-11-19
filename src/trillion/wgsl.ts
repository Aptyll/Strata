// WGSL for the trillion particle splat kernel. See docs/trillion.md.

import { STATELESS_RNG_WGSL } from '../stateless/rng';
//
// One invocation evaluates `perThread` stateless particles of one plane and
// adds exactly 1 to exactly one pixel counter for each particle that lands
// in the frame. Nothing is stored per particle.

/** Bytes per batch record in the uniform ring (minUniformBufferOffsetAlignment). */
export const SLOT_BYTES = 256;
export const WORKGROUP = 256;

/**
 * Helpers every law may call: the shared stateless RNG from src/stateless
 * (Key = vec2u, particleKey, pcg, u01, tri, draw, TAU), so laws written for
 * src/offline and src/stateless plug in unchanged.
 */
export const LAW_PRELUDE = STATELESS_RNG_WGSL;

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
  flags: u32,       // bit 0: stochastic sub-pixel splat, bit 1: math only (no counter writes, bench), bit 2: no tile (bench)
  _pad: u32,
  time: f32,        // seconds
  shutter: f32,     // seconds of exposure; 0 = no motion blur
  _pad2: vec2f,
  tile: vec4i,      // shared memory window: x0, y0, w, h (w * h <= TILE_BINS); w = 0: none
  strata0: vec4u,   // strata: first patch of this dispatch, base particles per patch, remainder, gu
  strata1: vec4u,   // strata: gv, _, _, _
};
`;

/**
 * The splat module for one law. Three entry points:
 *   direct  every hit is a global atomicAdd (no workgroup memory)
 *   tiled   hits inside `tile` go to workgroup memory first, flushed once
 *   strata  one workgroup per patch of stratified ids; the tile is placed per
 *           workgroup from a sample of the patch, runs merge in registers
 */
export function splatWgsl(law: { fn: string; wgsl: string }, tileBins: number, prelude = LAW_PRELUDE): string {
  return /* wgsl */ `
${prelude}
// The particle's stratified coordinate in [0, 1)^2. In the strata entry
// point neighbouring ids get neighbouring coordinates (a jittered grid over
// the plane's ids), so a workgroup's particles land close together. In the
// other entry points it is (u01(key.x), u01(key.y)): same distribution, no
// coherence. Laws that use it for their main two coordinates get the fast path.
var<private> SQ: vec2f;
fn strat(key: Key) -> vec2f { return SQ; }
${law.wgsl}
${BATCH_STRUCT}
@group(0) @binding(0) var<uniform> B: Batch;
@group(0) @binding(1) var<storage, read_write> acc: array<atomic<u32>>;
// [0] landed lo, [1] landed hi, [2] in view lo, [3] in view hi,
// [4] strata patches run, [5] strata patches that found a tile
@group(0) @binding(2) var<storage, read_write> tally: array<atomic<u32>, 8>;

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
fn project(key: Key, jr: u32, p: array<f32, 8>) -> vec2i {
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
    let key = particleKey(B.start + off, B.seed);
    let jr = pcg(key.x ^ (key.y * 0x9e3779b9u) ^ B.salt);
    SQ = vec2f(u01(key.x), u01(key.y));
    let px = project(key, jr, p);
    if (px.x < 0) { continue; }
    inView += 1u;
    if (!kept(jr)) { continue; }
    landed += 1u;
    if ((B.flags & 2u) != 0u) { continue; }   // math only: no counter write
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
    let key = particleKey(B.start + off, B.seed);
    let jr = pcg(key.x ^ (key.y * 0x9e3779b9u) ^ B.salt);
    SQ = vec2f(u01(key.x), u01(key.y));
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

// ---- strata: one workgroup per patch of a jittered grid over the plane's ids.
var<workgroup> sNX0: atomic<u32>;   // max of ~x, i.e. min x
var<workgroup> sNY0: atomic<u32>;
var<workgroup> sX1: atomic<u32>;    // max of x + 1; 0 when no sample landed
var<workgroup> sY1: atomic<u32>;

fn flushRun(pk: u32, n: u32, tile: vec4i) {
  if (n == 0u) { return; }
  let x = pk & 0xffffu;
  let y = pk >> 16u;
  let lx = x - u32(tile.x);
  let ly = y - u32(tile.y);
  if (lx < u32(tile.z) && ly < u32(tile.w)) {
    atomicAdd(&bins[ly * u32(tile.z) + lx], n);
  } else {
    atomicAdd(&acc[y * B.width + x], n);
  }
}

struct Row { first: u32, len: u32, rows: u32, cu: u32, cv: u32 };

// Ids of this thread's row in patch c: [first, first + len).
fn patchRow(c: u32, lid: u32) -> Row {
  let base = B.strata0.y;
  let rem = B.strata0.z;
  let n = base + select(0u, 1u, c < rem);
  let start = c * base + min(c, rem);
  let rows = min(${WORKGROUP}u, n);
  let m = n / rows;
  let mr = n % rows;
  var r: Row;
  r.rows = rows;
  r.len = select(0u, m + select(0u, 1u, lid < mr), lid < rows);
  r.first = start + lid * m + min(lid, mr);
  r.cu = c % B.strata0.w;
  r.cv = c / B.strata0.w;
  return r;
}

// Per thread constants of the stratified grid: q = o + (cell + jitter) * s.
struct Grid { o: vec2f, s: vec2f, row: f32 };

fn rowGrid(r: Row, lid: u32) -> Grid {
  let gu = f32(B.strata0.w);
  let gv = f32(B.strata1.x);
  var g: Grid;
  g.o = vec2f(f32(r.cu) / gu, f32(r.cv) / gv);
  g.s = vec2f(1.0 / (f32(max(r.len, 1u)) * gu), 1.0 / (f32(max(r.rows, 1u)) * gv));
  g.row = f32(lid);
  return g;
}

fn stratQ(g: Grid, j: u32, key: Key) -> vec2f {
  return g.o + (vec2f(f32(j), g.row) + vec2f(u01(key.x), u01(key.y))) * g.s;
}

fn samplePixel(r: Row, g: Grid, j: u32, p: array<f32, 8>) -> vec2i {
  let key = particleKey(r.first + j, B.seed);
  SQ = stratQ(g, j, key);
  return project(key, pcg(key.x ^ (key.y * 0x9e3779b9u) ^ B.salt), p);
}

@compute @workgroup_size(${WORKGROUP})
fn strata(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let wgIndex = wg.x + wg.y * B.gridX;
  if (wgIndex >= B.groups) { return; }
  let p = params();
  let r = patchRow(B.strata0.x + wgIndex, lid);
  let g = rowGrid(r, lid);

  // 1. Footprint of the patch from its two u edges (first and last id of every row).
  var lo = vec2u(0xffffffffu);
  var hi = vec2u(0u);
  if (r.len > 0u) {
    let a = samplePixel(r, g, 0u, p);
    let b = samplePixel(r, g, r.len - 1u, p);
    if (a.x >= 0) { lo = min(lo, vec2u(a)); hi = max(hi, vec2u(a) + 1u); }
    if (b.x >= 0) { lo = min(lo, vec2u(b)); hi = max(hi, vec2u(b) + 1u); }
  }
  if (hi.x > 0u) {
    atomicMax(&sNX0, ~lo.x);
    atomicMax(&sNY0, ~lo.y);
    atomicMax(&sX1, hi.x);
    atomicMax(&sY1, hi.y);
  }
  workgroupBarrier();
  var tile = vec4i(0);
  let x1 = atomicLoad(&sX1);
  let y1 = atomicLoad(&sY1);
  if (x1 > 0u) {
    let x0 = ~atomicLoad(&sNX0);
    let y0 = ~atomicLoad(&sNY0);
    // A quarter of the sampled extent as margin for the patch interior.
    let mx = (x1 - x0) / 4u + 2u;
    let my = (y1 - y0) / 4u + 2u;
    var ax = max(i32(x0) - i32(mx), 0);
    var ay = max(i32(y0) - i32(my), 0);
    var bx = min(i32(x1 + mx), i32(B.width));
    var by = min(i32(y1 + my), i32(B.height));
    if (u32((bx - ax) * (by - ay)) > TILE_BINS) {
      ax = max(i32(x0) - 2, 0);
      ay = max(i32(y0) - 2, 0);
      bx = min(i32(x1) + 2, i32(B.width));
      by = min(i32(y1) + 2, i32(B.height));
    }
    if (bx > ax && by > ay && u32((bx - ax) * (by - ay)) <= TILE_BINS && (B.flags & 4u) == 0u) {
      tile = vec4i(ax, ay, bx - ax, by - ay);
    }
  }

  // 2. Walk the row. Consecutive ids are neighbours on the grid, so runs of
  // hits on one pixel are merged in registers before any atomic.
  var landed = 0u;
  var inView = 0u;
  var runPix = 0xffffffffu;
  var runN = 0u;
  for (var j = 0u; j < r.len; j++) {
    let id = r.first + j;
    if (id - B.start >= B.count) { continue; }   // outside this batch
    let key = particleKey(id, B.seed);
    let jr = pcg(key.x ^ (key.y * 0x9e3779b9u) ^ B.salt);
    SQ = stratQ(g, j, key);
    let px = project(key, jr, p);
    if (px.x < 0) { continue; }
    inView += 1u;
    if (!kept(jr)) { continue; }
    landed += 1u;
    let pk = (u32(px.y) << 16u) | u32(px.x);
    if (pk == runPix) {
      runN += 1u;
    } else {
      flushRun(runPix, runN, tile);
      runPix = pk;
      runN = 1u;
    }
  }
  flushRun(runPix, runN, tile);
  atomicAdd(&wgLanded, landed);
  atomicAdd(&wgInView, inView);
  workgroupBarrier();
  if (lid == 0u) {
    atomicAdd(&tally[4], 1u);
    atomicAdd(&tally[5], select(0u, 1u, tile.z > 0));
  }
  let tw = u32(tile.z);
  let area = tw * u32(tile.w);
  for (var b = lid; b < area; b += ${WORKGROUP}u) {
    let v = atomicLoad(&bins[b]);
    if (v != 0u) {
      atomicAdd(&acc[(u32(tile.y) + b / tw) * B.width + u32(tile.x) + b % tw], v);
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
