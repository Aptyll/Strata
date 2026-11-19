/**
 * WGSL for the stateless accumulation pass.
 *
 * One compute dispatch evaluates a contiguous range of one plane's particles
 * and adds each of them to a 64-bit integer accumulation grid. Integer adds
 * commute, so the finished frame is bit-identical however the particles are
 * split into batches, in whatever order the GPU schedules its threads, and
 * across an interrupted and resumed render.
 */
import type { LawId, SplatMode } from "./job";
import { WGSL_COMMON, WGSL_LAWS } from "./laws";

/** Size of the Batch uniform in bytes. Layout must match the struct below. */
export const BATCH_UNIFORM_BYTES = 128;

/** Invocations per workgroup. */
export const WORKGROUP_SIZE = 64;

const LAW_FN: Record<LawId, string> = { kepler: "lawKepler", vortex: "lawVortex", lissajous: "lawLissajous" };

export function accumulateShader(law: LawId, splat: SplatMode): string {
  return /* wgsl */ `
${WGSL_COMMON}
${WGSL_LAWS}

struct Batch {
  // Homography columns: (px * depth, py * depth, depth) = c0 * x + c1 * y + c2.
  c0: vec4f,
  c1: vec4f,
  c2: vec4f,
  // The law's 8 params.
  pa: vec4f,
  pb: vec4f,
  // First particle index of this batch within its plane, and how many.
  start: u32,
  count: u32,
  seed: u32,
  // Each invocation evaluates this many consecutive particles.
  perInvocation: u32,
  // Invocations per row of the 2D dispatch.
  rowStride: u32,
  gridWidth: u32,
  gridHeight: u32,
  _pad: u32,
  // Simulated seconds at the middle of the shutter, and the shutter length.
  time: f32,
  shutterSpan: f32,
  // Flux mode: (reference depth)^2. Zero or less selects count mode.
  fluxRef2: f32,
  near: f32,
}

@group(0) @binding(0) var<uniform> B: Batch;
// The 64-bit accumulator, split into low and high words.
@group(0) @binding(1) var<storage, read_write> accLo: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> accHi: array<atomic<u32>>;
// Exact 64-bit counts, counted on the GPU as the work happens:
// [0..1] particles whose position landed inside the frame (low, high word),
// [2..3] particles evaluated (low, high word).
@group(0) @binding(3) var<storage, read_write> tally: array<atomic<u32>, 4>;

var<workgroup> wgLanded: atomic<u32>;
var<workgroup> wgEvaluated: atomic<u32>;

fn tallyAdd(slot: u32, v: u32) {
  let old = atomicAdd(&tally[slot], v);
  if (old > 0xffffffffu - v) { atomicAdd(&tally[slot + 1u], 1u); }
}

// Exact 64-bit atomic add. atomicAdd returns the value before the add, so a
// wrap of the low word is detected exactly once, by the thread that caused it.
fn add64(idx: u32, w: u32) {
  let old = atomicAdd(&accLo[idx], w);
  if (old > 0xffffffffu - w) {
    atomicAdd(&accHi[idx], 1u);
  }
}

// Adds one particle to the grid. Returns true when its position is inside
// the frame, whatever its weight.
fn splat(pos: vec2f, key: Key) -> bool {
  let c = B.c0.xyz * pos.x + B.c1.xyz * pos.y + B.c2.xyz;
  // Written so that a NaN fails the test and is dropped.
  if (!(c.z > B.near)) { return false; }
  let s = c.xy / c.z;
  let size = vec2f(f32(B.gridWidth), f32(B.gridHeight));
  let inFrame = s.x >= 0.0 && s.y >= 0.0 && s.x < size.x && s.y < size.y;
${
  splat === "point"
    ? /* wgsl */ `
  if (!inFrame) { return false; }
  // Weight in units of 1/65536 of a particle.
  var w = 65536u;
  if (B.fluxRef2 > 0.0) {
    let f = min(1.0, B.fluxRef2 / (c.z * c.z));
    // Unbiased stochastic rounding to an integer weight.
    w = u32(f * 65536.0 + u01(draw(key, 7u)));
    if (w == 0u) { return true; }
  }
  add64(u32(s.y) * B.gridWidth + u32(s.x), w);
  return true;`
    : /* wgsl */ `
  // Particles just outside the frame still spread light onto its edge pixels.
  if (!(s.x > -1.0 && s.y > -1.0 && s.x < size.x + 1.0 && s.y < size.y + 1.0)) { return false; }
  // Weight in units of 1/256 of a particle, spread over 4 pixels with 4-bit
  // subpixel weights. The 4 integer weights sum to exactly 256 * unit.
  var unit = 256u;
  if (B.fluxRef2 > 0.0) {
    let f = min(1.0, B.fluxRef2 / (c.z * c.z));
    unit = u32(f * 256.0 + u01(draw(key, 7u)));
    if (unit == 0u) { return inFrame; }
  }
  let q = s - vec2f(0.5);
  let fl = floor(q);
  let fr = min(vec2u((q - fl) * 16.0), vec2u(16u));
  let ix = i32(fl.x);
  let iy = i32(fl.y);
  let gw = i32(B.gridWidth);
  let gh = i32(B.gridHeight);
  for (var t = 0u; t < 4u; t++) {
    let dx = t & 1u;
    let dy = t >> 1u;
    let x = ix + i32(dx);
    let y = iy + i32(dy);
    let wx = select(16u - fr.x, fr.x, dx == 1u);
    let wy = select(16u - fr.y, fr.y, dy == 1u);
    let w = unit * wx * wy;
    if (w != 0u && x >= 0 && y >= 0 && x < gw && y < gh) {
      add64(u32(y) * B.gridWidth + u32(x), w);
    }
  }
  return inFrame;`
}
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let inv = gid.x + gid.y * B.rowStride;
  // The host sizes the dispatch so this product cannot overflow.
  let first = inv * B.perInvocation;
  // No early return: every invocation must reach the barrier below.
  var n = 0u;
  if (first < B.count) { n = min(B.perInvocation, B.count - first); }
  let p = array<f32, 8>(B.pa.x, B.pa.y, B.pa.z, B.pa.w, B.pb.x, B.pb.y, B.pb.z, B.pb.w);
  var landed = 0u;
  var evaluated = 0u;
  for (var k = 0u; k < n; k++) {
    evaluated++;
    let key = particleKey(B.start + first + k, B.seed);
    // Each particle has its own fixed instant inside the shutter window.
    let t = B.time + B.shutterSpan * (u01(draw(key, 6u)) - 0.5);
    if (splat(${LAW_FN[law]}(key, t, p), key)) { landed++; }
  }
  // One global atomic per workgroup, not per particle. At most
  // WORKGROUP_SIZE * perInvocation <= 2^18 per workgroup, so u32 is enough.
  atomicAdd(&wgLanded, landed);
  atomicAdd(&wgEvaluated, evaluated);
  workgroupBarrier();
  if (lid == 0u) {
    tallyAdd(0u, atomicLoad(&wgLanded));
    tallyAdd(2u, atomicLoad(&wgEvaluated));
  }
}
`;
}
