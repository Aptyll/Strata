/**
 * WGSL for Challenge mode.
 *
 * Three compute kernels and one resolve shader:
 *
 *   init    seed a slab of packed particles (runs once per slab)
 *   sim     fused kernel: unpack, integrate, pack, project, atomic splat
 *   proc    stateless kernel: position from (id, time), project, atomic splat
 *   resolve accumulation buffer to the canvas (tonemapped) or to an HDR target
 *
 * Particle state is 8 bytes: two u32 words.
 *   word 0: position, x in the low 16 bits and y in the high 16 bits, fixed
 *           point over the sheet [-1, 1) with wrap-around (a torus).
 *   word 1: velocity, same packing, biased by 32768, V_MAX at full scale.
 * Every quantization uses stochastic rounding, so motion slower than one
 * quantum per frame is still correct on average instead of freezing.
 *
 * Every invocation covers a full row of ROW particles: counts are always a
 * multiple of ROW, and the dispatch is (ROW / WG, count / ROW).
 */

/** Particles per dispatch row. Counts are multiples of this. */
export const ROW = 65536;
/** Sheets the kernels can address. */
export const MAX_PLANES = 64;
/** Bytes per Plane struct below. */
export const PLANE_BYTES = 208;
/** Bytes before the planes array in Globals. */
export const GLOBALS_HEADER_BYTES = 32;
export const GLOBALS_BYTES = GLOBALS_HEADER_BYTES + MAX_PLANES * PLANE_BYTES;
/** Wells and wave modes per plane. */
export const WELLS = 4;
export const MODES = 4;
/** Velocity at full scale of the 16 bit field, in sheet units per second. */
export const V_MAX = 4;
/** Stride of one entry in the dispatch table (uniform, dynamic offset). */
export const DISPATCH_STRIDE = 256;
/**
 * u32 slots of the GPU particle count. Workgroups spread their adds over the
 * slots so they do not contend for one address; the CPU sums them. 256 slots
 * keep every slot far below 2^32 even at the stateless mode's largest count.
 */
export const COUNT_SLOTS = 256;

const common = (wg: number) => /* wgsl */ `
const WG: u32 = ${wg}u;
const ROW: u32 = ${ROW}u;
const V_MAX: f32 = ${V_MAX}.0;
const V_SCALE: f32 = V_MAX / 32768.0;      // sheet units per second per velocity quantum
const INV_V_SCALE: f32 = 32768.0 / V_MAX;
const NEAR_W: f32 = 1e-3;

struct Plane {
  // Homography from sheet coordinates to pixels: (px * w, py * w, w) = h0 * x + h1 * y + h2.
  h0: vec4f,
  h1: vec4f,
  h2: vec4f,
  // x: splat weight numerator (weight = x / w^2), y: weight cap,
  // z: drag toward the flow (1/s), w: random kick per frame (velocity units).
  a: vec4f,
  // x: number of wells, y: procedural style, z: seed, w: unused.
  b: vec4f,
  // xy: position on the sheet, z: strength, w: softening squared.
  wells: array<vec4f, ${WELLS}>,
  // xy: wave vector, z: phase (already advanced in time), w: amplitude.
  modes: array<vec4f, ${MODES}>,
}

struct Globals {
  fbSize: vec2u,
  frame: u32,
  planeCount: u32,
  dt: f32,
  time: f32,
  pad0: f32,
  pad1: f32,
  planes: array<Plane, ${MAX_PLANES}>,
}

struct Dispatch {
  base: u32,   // id of this dispatch's first particle (sim), or 0
  count: u32,  // particles in this dispatch, a multiple of ROW
  keyA: u32,   // per-dispatch hash keys (proc)
  keyB: u32,
}

@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var<storage, read_write> fb: array<atomic<u32>>;
// The frame's GPU count of processed particles, spread over slots. See countWorkgroup.
@group(0) @binding(2) var<storage, read_write> counted: array<atomic<u32>, ${COUNT_SLOTS}>;

// The frame's particle count, taken on the GPU: the first invocation of every
// workgroup that runs adds how many particles its workgroup processes (the
// part of its WG consecutive ids below D.count). Ids in a workgroup are
// consecutive and the kernels have no early exit past the bounds check, so
// this equals counting every particle, at one atomic per workgroup instead of
// a workgroup atomic and a barrier per particle. It proves on the GPU that
// every dispatch ran at its full size, and it reads zero for work the browser
// dropped (a command buffer that fails validation runs nothing at all).
fn countWorkgroup(wid: vec3u, lid: u32) {
  if (lid != 0u) { return; }
  let first = wid.y * ROW + wid.x * WG;
  if (first < D.count) {
    atomicAdd(&counted[(wid.x + wid.y) % ${COUNT_SLOTS}u], min(WG, D.count - first));
  }
}

// PCG RXS-M-XS: a permutation of u32, so distinct inputs give distinct outputs.
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

// Two uniform numbers in [0, 1) from the two halves of a hash.
fn halves(h: u32) -> vec2f {
  return vec2f(f32(h & 0xffffu), f32(h >> 16u)) * (1.0 / 65536.0);
}

// Add one particle's light to the pixel it lands on. 'rnd' in [0, 1) dithers
// the fixed point weight, so weights below one unit still add up correctly.
fn splat(pi: u32, pos: vec2f, rnd: f32) {
  let h = G.planes[pi].h0.xyz * pos.x + G.planes[pi].h1.xyz * pos.y + G.planes[pi].h2.xyz;
  if (!(h.z > NEAR_W)) { return; }
  let inv = 1.0 / h.z;
  let px = h.xy * inv;
  let size = vec2f(G.fbSize);
  // Written so that NaN fails the test.
  if (!(px.x >= 0.0 && px.y >= 0.0 && px.x < size.x && px.y < size.y)) { return; }
  let a = G.planes[pi].a;
  let w = u32(min(a.x * inv * inv, a.y) + rnd);
  if (w == 0u) { return; }
  // min() guards the one-ulp case where px rounds up to exactly size.
  let ix = min(u32(px.x), G.fbSize.x - 1u);
  let iy = min(u32(px.y), G.fbSize.y - 1u);
  atomicAdd(&fb[iy * G.fbSize.x + ix], w);
}
`;

/** Seeds a slab: uniform positions, at rest. */
export const initWgsl = (wg: number) => /* wgsl */ `
${common(wg)}
@group(1) @binding(0) var<uniform> D: Dispatch;
@group(1) @binding(1) var<storage, read_write> P: array<vec2u>;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.y * ROW + gid.x;
  if (i >= D.count) { return; }
  let id = D.base + i;
  let h = pcg(id ^ D.keyA);
  P[i] = vec2u(h, 32768u | (32768u << 16u));
}
`;

/**
 * The fused stateful kernel. Each particle is read once, integrated,
 * written once, and splatted once.
 *
 * Forces: drag toward a time-dependent incompressible flow (a sum of
 * travelling waves of a stream function), plus softened gravity toward up to
 * four moving wells, plus a small random kick. Particles carry inertia, so
 * they do not follow the flow exactly: they are flung out of vortices and
 * collect along strain lines, which is where the filaments come from.
 */
export const simWgsl = (wg: number) => /* wgsl */ `
${common(wg)}
@group(1) @binding(0) var<uniform> D: Dispatch;
@group(1) @binding(1) var<storage, read_write> P: array<vec2u>;

@compute @workgroup_size(WG)
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_index) lid: u32,
) {
  let i = gid.y * ROW + gid.x;
  if (i >= D.count) { return; }
  let id = D.base + i;
  // Each workgroup of 256 ids belongs to one sheet. Sheets are interleaved,
  // so the first n particles are always spread evenly over all sheets.
  let pi = (id >> 8u) % G.planeCount;

  let s = P[i];
  var pu = vec2u(s.x & 0xffffu, s.x >> 16u);
  var vel = (vec2f(vec2u(s.y & 0xffffu, s.y >> 16u)) - 32768.0) * V_SCALE;
  let pos = vec2f(pu) * (1.0 / 32768.0) - 1.0;

  let a = G.planes[pi].a;
  let b = G.planes[pi].b;

  // Flow velocity: u = (d psi / dy, -d psi / dx), psi = sum amp * sin(k . x + phase).
  var flow = vec2f(0.0);
  for (var m = 0u; m < ${MODES}u; m++) {
    let md = G.planes[pi].modes[m];
    let c = md.w * cos(dot(md.xy, pos) + md.z);
    flow += c * vec2f(md.y, -md.x);
  }
  var acc = (flow - vel) * a.z;

  // Softened gravity toward each well, using the nearest image on the torus.
  let wells = u32(b.x);
  for (var k = 0u; k < wells; k++) {
    let wl = G.planes[pi].wells[k];
    var d = wl.xy - pos;
    d = d - 2.0 * round(d * 0.5);
    let ir = inverseSqrt(dot(d, d) + wl.w);
    acc += d * (wl.z * ir * ir * ir);
  }

  // Four independent hashes per particle per frame.
  let h1 = pcg(id + pcg(G.frame));
  let h2 = pcg(h1);
  let h3 = pcg(h2);
  let h4 = pcg(h3);

  // Semi-implicit Euler: velocity first, then position with the new velocity.
  vel += acc * G.dt + (halves(h3) - 0.5) * a.w;
  vel = clamp(vel, vec2f(-V_MAX), vec2f(V_MAX));

  // Position advances in whole quanta, rounded stochastically, and wraps.
  let stepq = vec2i(floor(vel * (G.dt * 32768.0) + halves(h1)));
  pu = vec2u(vec2i(pu) + stepq) & vec2u(0xffffu);

  let vq = vec2u(clamp(floor(vel * INV_V_SCALE + 32768.0 + halves(h2)), vec2f(0.0), vec2f(65535.0)));
  P[i] = vec2u(pu.x | (pu.y << 16u), vq.x | (vq.y << 16u));

  splat(pi, vec2f(pu) * (1.0 / 32768.0) - 1.0, f32(h4 >> 8u) * (1.0 / 16777216.0));
  countWorkgroup(wid, lid);
}
`;

/**
 * The stateless kernel: nothing is stored, a particle's position is a closed
 * form function of its id and the time. Two looks:
 *
 *   style 0  "silk": a uniform cloud pushed through nested compression waves.
 *            Where a wave folds the cloud over itself, density piles up into
 *            caustics. Each particle rides the waves at its own amplitude, so
 *            the folds form soft sheets instead of razor lines.
 *   style 1  "disc": orbits on nested ellipses whose orientation turns with
 *            radius, the classic density wave picture of a spiral galaxy.
 *
 * Ids: a particle is (dispatch, index). h1 is a permutation of the index for
 * a fixed dispatch, and h2 is a permutation of h1 keyed by the dispatch, so
 * the pair (h1, h2) is unique for every particle. No two particles are copies.
 */
export const procWgsl = (wg: number) => /* wgsl */ `
${common(wg)}
@group(1) @binding(0) var<uniform> D: Dispatch;

const TAU: f32 = 6.283185307179586;

@compute @workgroup_size(WG)
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_index) lid: u32,
) {
  let i = gid.y * ROW + gid.x;
  if (i >= D.count) { return; }
  let pi = (i >> 8u) % G.planeCount;
  let h1 = pcg(i + D.keyA);
  let h2 = pcg(h1 ^ D.keyB);
  let h3 = pcg(h2);
  let u = halves(h1);
  let v = halves(h2);
  let b = G.planes[pi].b;

  var pos: vec2f;
  if (b.y < 0.5) {
    // Silk. v.x is this particle's own amplitude, in [0.35, 1.35).
    pos = u * 2.0 - 1.0;
    let gain = 0.35 + v.x;
    for (var m = 0u; m < ${MODES}u; m++) {
      let md = G.planes[pi].modes[m];
      pos += md.xy * (gain * md.w * sin(dot(md.xy, pos) + md.z + v.y * 0.6));
    }
    // Back onto the sheet.
    pos = pos - 2.0 * floor(pos * 0.5 + 0.5);
  } else {
    // Disc. Semi-major axis from u.x (denser toward the centre), phase from u.y.
    let md = G.planes[pi].modes[0];
    let sma = 0.02 + 0.93 * u.x * sqrt(u.x) + 0.03 * v.x;
    let ecc = 0.28 + 0.1 * v.y;
    // Orbital angular speed falls with radius (flat rotation curve).
    let ang = TAU * u.y + G.time * md.w / (sma + 0.08);
    let tilt = md.z + md.x * log(sma + 0.02);
    let e = vec2f(cos(ang), sin(ang) * (1.0 - ecc)) * sma;
    let ct = cos(tilt);
    let st = sin(tilt);
    pos = vec2f(e.x * ct - e.y * st, e.x * st + e.y * ct);
  }
  splat(pi, pos, f32(h3 >> 8u) * (1.0 / 16777216.0));
  countWorkgroup(wid, lid);
}
`;

/**
 * Reads the accumulation buffer. 'fs_canvas' tonemaps to the canvas,
 * 'fs_hdr' writes linear light for an additive HDR target.
 */
export const resolveWgsl = /* wgsl */ `
struct Resolve {
  fbSize: vec2u,
  scale: f32,   // accumulated units to linear light
  curve: f32,   // tonemap shoulder, see fs_canvas
}
@group(0) @binding(0) var<uniform> R: Resolve;
@group(0) @binding(1) var<storage, read> fb: array<u32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn light(pos: vec4f) -> f32 {
  let x = min(u32(pos.x), R.fbSize.x - 1u);
  let y = min(u32(pos.y), R.fbSize.y - 1u);
  return f32(fb[y * R.fbSize.x + x]) * R.scale;
}

@fragment
fn fs_canvas(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let v = light(pos);
  // Log shoulder: linear near black, compresses orders of magnitude of
  // density into the visible range without clipping the dense cores to flat white.
  let t = log(1.0 + v * R.curve) / log(1.0 + R.curve);
  let c = pow(clamp(t, 0.0, 1.0), 1.0 / 2.2);
  return vec4f(c, c, c, 1.0);
}

@fragment
fn fs_hdr(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let v = light(pos);
  return vec4f(v, v, v, 0.0);
}
`;
