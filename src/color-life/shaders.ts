/**
 * WGSL for color life: particle life on one sheet, neighbors found through a
 * uniform grid rebuilt every frame by a GPU counting sort.
 *
 * Per frame (all on the GPU, no readback):
 *
 *   clear    counts = 0                                  (clearBuffer)
 *   bin      counts[cell(p)] += 1                        one thread per particle
 *   scan     starts = exclusive prefix sum of counts     scanLocal, scanBlocks, addBlocks
 *   scatter  state A -> state B in cell order            one thread per particle
 *   force    read neighbors from B, integrate, write A   one thread per sorted slot
 *
 * After `force`, A holds every particle again, now sorted by cell, which is
 * what keeps the neighbor loop cache friendly on the next frame. Species
 * travel with the particle through the sort.
 *
 * The interaction radius equals the cell size, so the 3 x 3 cells around a
 * particle hold every neighbor that can touch it. The sheet wraps (a torus),
 * so nothing piles up against an edge.
 *
 * Uniform layout (`Params`, 304 bytes), byte offsets:
 *    0 n u32        4 grid u32      8 species u32    12 seed u32
 *   16 radius f32  20 beta f32     24 force f32     28 friction f32
 *   32 dt f32      36 numBlocks u32 40 cells u32    44 pad
 *   48 matrix: array<vec4f, 16>  (8 x 8 floats, row major: [a * 8 + b])
 */

import { DISPATCH_ROW_PARTICLES } from "../gpu/shaderLib";
import { PCG_WGSL } from "../gpu/wgsl";

export const PARAMS_SIZE = 304;
export const SCAN_BLOCK = 256;

const COMMON = /* wgsl */ `
struct Params {
  n: u32, grid: u32, species: u32, seed: u32,
  radius: f32, beta: f32, force: f32, friction: f32,
  dt: f32, numBlocks: u32, cells: u32, _pad: u32,
  matrix: array<vec4f, 16>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> stateA: array<vec4f>;   // pos.xy, vel.xy
@group(0) @binding(2) var<storage, read_write> speciesA: array<u32>;
@group(0) @binding(3) var<storage, read_write> stateB: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> speciesB: array<u32>;
// [0, cells): per-cell counts. [cells, 2 * cells): scatter cursors.
@group(0) @binding(5) var<storage, read_write> cellCounters: array<atomic<u32>>;
// cells + 1 entries: starts[c] is the first sorted slot of cell c, starts[cells] = particles binned.
@group(0) @binding(6) var<storage, read_write> starts: array<u32>;
@group(0) @binding(7) var<storage, read_write> blockSums: array<u32>;

const ROW: u32 = ${DISPATCH_ROW_PARTICLES}u;

fn cellXY(p: vec2f) -> vec2u {
  let g = f32(P.grid);
  let q = clamp((p * 0.5 + 0.5) * g, vec2f(0.0), vec2f(g - 1.0));
  return vec2u(q);
}

fn cellIndex(p: vec2f) -> u32 {
  let q = cellXY(p);
  return q.y * P.grid + q.x;
}

// Wrap into [-1, 1) on both axes.
fn wrap(p: vec2f) -> vec2f {
  return p - 2.0 * floor(p * 0.5 + 0.5);
}

fn rule(a: u32, b: u32) -> f32 {
  let k = a * 8u + b;
  return P.matrix[k / 4u][k % 4u];
}

// Particle life force at distance rn (in interaction radii) for rule value a.
// CPU twin: pairForce in rules.ts.
fn force(rn: f32, a: f32) -> f32 {
  let beta = P.beta;
  if (rn < beta) { return rn / beta - 1.0; }
  if (rn < 1.0) { return a * (1.0 - abs(2.0 * rn - 1.0 - beta) / (1.0 - beta)); }
  return 0.0;
}

var<workgroup> sh: array<u32, ${SCAN_BLOCK}>;

// In-place inclusive scan of sh across the workgroup.
fn scanShared(lid: u32) {
  for (var off = 1u; off < ${SCAN_BLOCK}u; off = off << 1u) {
    var t = 0u;
    if (lid >= off) { t = sh[lid - off]; }
    workgroupBarrier();
    sh[lid] = sh[lid] + t;
    workgroupBarrier();
  }
}
`;

/** Every compute entry point, one module. */
export function buildComputeShader(): string {
  return PCG_WGSL + COMMON + /* wgsl */ `
// Scatter particles uniformly and give each a species. Also used on a reset.
@compute @workgroup_size(256)
fn init(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ROW;
  if (i >= P.n) { return; }
  let h1 = pcg(i ^ pcg(P.seed));
  let h2 = pcg(h1);
  let p = vec2f(f32(h1 >> 8u), f32(h2 >> 8u)) * (2.0 / 16777216.0) - 1.0;
  stateA[i] = vec4f(p, 0.0, 0.0);
  speciesA[i] = pcg(h2) % P.species;
}

// Deal species again (after a roll changes the species count) without moving anyone.
@compute @workgroup_size(256)
fn reassign(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ROW;
  if (i >= P.n) { return; }
  speciesA[i] = pcg(i ^ pcg(P.seed ^ 0x9e3779b9u)) % P.species;
}

@compute @workgroup_size(256)
fn bin(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ROW;
  if (i >= P.n) { return; }
  atomicAdd(&cellCounters[cellIndex(stateA[i].xy)], 1u);
}

// Exclusive scan of each block of 256 counts; block totals go to blockSums.
@compute @workgroup_size(256)
fn scanLocal(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let c = gid.x;
  var v = 0u;
  if (c < P.cells) { v = atomicLoad(&cellCounters[c]); }
  sh[lid.x] = v;
  workgroupBarrier();
  scanShared(lid.x);
  if (c < P.cells) { starts[c] = sh[lid.x] - v; }
  if (lid.x == ${SCAN_BLOCK - 1}u) { blockSums[wid.x] = sh[lid.x]; }
}

// One workgroup: exclusive scan of the block totals, any number of blocks.
@compute @workgroup_size(256)
fn scanBlocks(@builtin(local_invocation_id) lid: vec3u) {
  let per = (P.numBlocks + ${SCAN_BLOCK - 1}u) / ${SCAN_BLOCK}u;
  let base = lid.x * per;
  var sum = 0u;
  for (var k = 0u; k < per; k++) {
    let b = base + k;
    if (b < P.numBlocks) { sum += blockSums[b]; }
  }
  sh[lid.x] = sum;
  workgroupBarrier();
  scanShared(lid.x);
  var run = sh[lid.x] - sum;
  for (var k = 0u; k < per; k++) {
    let b = base + k;
    if (b < P.numBlocks) {
      let s = blockSums[b];
      blockSums[b] = run;
      run += s;
    }
  }
  if (lid.x == ${SCAN_BLOCK - 1}u) { starts[P.cells] = sh[lid.x]; }
}

@compute @workgroup_size(256)
fn addBlocks(@builtin(global_invocation_id) gid: vec3u) {
  let c = gid.x;
  if (c >= P.cells) { return; }
  let s = starts[c] + blockSums[c / ${SCAN_BLOCK}u];
  starts[c] = s;
  atomicStore(&cellCounters[P.cells + c], s);
}

@compute @workgroup_size(256)
fn scatter(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ROW;
  if (i >= P.n) { return; }
  let p = stateA[i];
  let slot = atomicAdd(&cellCounters[P.cells + cellIndex(p.xy)], 1u);
  stateB[slot] = p;
  speciesB[slot] = speciesA[i];
}

// One thread per sorted slot: sum the rule forces from the 3 x 3 cells around
// the particle, then integrate and write it back to A (same slot, so A ends
// the frame sorted by cell).
@compute @workgroup_size(256)
fn integrate(@builtin(global_invocation_id) gid: vec3u) {
  let j = gid.x + gid.y * ROW;
  if (j >= P.n) { return; }
  let me = stateB[j];
  let s = speciesB[j];
  let p = me.xy;
  let g = P.grid;
  let c = cellXY(p);
  let r = P.radius;
  let invR = 1.0 / r;
  var acc = vec2f(0.0);
  for (var dy = 0u; dy < 3u; dy++) {
    let cy = (c.y + g + dy - 1u) % g;
    for (var dx = 0u; dx < 3u; dx++) {
      let cx = (c.x + g + dx - 1u) % g;
      let cell = cy * g + cx;
      let end = starts[cell + 1u];
      for (var k = starts[cell]; k < end; k++) {
        if (k == j) { continue; }
        // Shortest offset on the torus.
        let d = wrap(stateB[k].xy - p);
        let d2 = dot(d, d);
        if (d2 >= r * r || d2 <= 0.0) { continue; }
        let dist = sqrt(d2);
        acc += d * (force(dist * invR, rule(s, speciesB[k])) / dist);
      }
    }
  }
  acc *= r * P.force;
  let v = me.zw * P.friction + acc * P.dt;
  stateA[j] = vec4f(wrap(p + v * P.dt), v);
  speciesA[j] = s;
}
`;
}

/**
 * View uniform for drawing (160 bytes):
 *   0 center vec2f   8 scale vec2f   16 energy f32  (pad to 32)
 *   32 palette: array<vec4f, 8>
 */
export const VIEW_SIZE = 160;

/** Additive colored points: each particle adds its species color into an HDR target. */
export function buildDrawShader(): string {
  return /* wgsl */ `
struct View { center: vec2f, scale: vec2f, energy: f32, _p0: f32, _p1: f32, _p2: f32, palette: array<vec4f, 8> }
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> state: array<vec4f>;
@group(0) @binding(2) var<storage, read> species: array<u32>;

struct Out { @builtin(position) pos: vec4f, @location(0) color: vec3f }

@vertex
fn vs(@builtin(vertex_index) i: u32) -> Out {
  var o: Out;
  let p = state[i].xy;
  o.pos = vec4f((p - V.center) * V.scale, 0.0, 1.0);
  o.color = V.palette[species[i] & 7u].rgb * V.energy;
  return o;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
`;
}

/** HDR sum to screen: per channel 1 - exp(-x * exposure), so dense clusters glow in their own hue. */
export function buildTonemapShader(): string {
  return /* wgsl */ `
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var<uniform> exposure: vec4f;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let c = textureLoad(hdr, vec2i(frag.xy), 0).rgb;
  // Tone map each channel, then pull toward white where density is extreme,
  // so the brightest cores read as light, not as a flat primary color.
  let t = 1.0 - exp(-c * exposure.x);
  let lum = 1.0 - exp(-dot(c, vec3f(0.3333)) * exposure.x * 0.25);
  return vec4f(mix(t, vec3f(1.0), lum * lum * 0.6), 1.0);
}
`;
}
