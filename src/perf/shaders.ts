/**
 * WGSL for the perf path.
 *
 * One compute pass does everything per particle: unpack, integrate, pack, and
 * rasterize by atomicAdd into a u32 framebuffer. Simulation and rendering
 * share a single read of the particle data, which matters because at tens of
 * millions of particles the frame is bound by memory bandwidth, not math.
 *
 * Updates are in place (no ping-pong buffers): behaviors read fields, not
 * other particles, so there is no read/write hazard and we halve the memory.
 */

export const WORKGROUP_SIZE = 256;
/** Fixed-point value of one full-brightness particle in the atomic framebuffer. */
export const WEIGHT_ONE = 256;
/** Bytes of PlaneU, and the dynamic-offset stride between plane slots. */
export const PLANE_UNIFORM_SIZE = 144;
export const PLANE_UNIFORM_STRIDE = 256;

export const FLAG_SIM = 1;
export const FLAG_DRAW = 2;
export const FLAG_BILINEAR = 4;

export interface Behavior {
  name: string;
  /**
   * Body of `fn(p: vec2f, v: vec2f, id: u32) -> vec2f` returning acceleration.
   * `p` is the position in the plane's [0,1) square, `v` the velocity in plane
   * units per second, `id` a stable particle index. The plane uniform is in
   * scope as `U` (U.params, U.time, U.dt, U.seed).
   */
  wgsl: string;
  params: [number, number, number, number];
  velMax: number;
  /** Velocity decay per second (0 = none). */
  damping: number;
  init: InitPattern;
  initVelocity: InitVelocity;
}

export type InitPattern = 'uniform' | 'disc' | 'ring' | 'gaussian';
export type InitVelocity = 'zero' | 'orbital' | 'random';
export const INIT_PATTERNS: InitPattern[] = ['uniform', 'disc', 'ring', 'gaussian'];
export const INIT_VELOCITIES: InitVelocity[] = ['zero', 'orbital', 'random'];

/** Demo behaviors for the benchmark. Real behaviors plug in through the same interface. */
export const BUILTIN_BEHAVIORS: Behavior[] = [
  {
    // Divergence-free flow from a stream function of periodic sines.
    name: 'flow',
    params: [0.08, 2, 0, 0], // speed, relaxation rate
    velMax: 1,
    damping: 0,
    init: 'uniform',
    initVelocity: 'zero',
    wgsl: /* wgsl */ `
      let q = p * TAU;
      let t = U.time;
      var f = vec2f(0.0);
      f += cos(q.x + 2.0 * q.y + 0.31 * t) * vec2f(2.0, -1.0) * 0.447;
      f += cos(-2.0 * q.x + q.y - 0.23 * t + 1.7) * vec2f(1.0, 2.0) * 0.447;
      f += cos(3.0 * q.x - q.y + 0.17 * t + 4.1) * vec2f(-1.0, -3.0) * 0.316;
      f += cos(2.0 * q.x + 3.0 * q.y - 0.41 * t + 2.9) * vec2f(3.0, -2.0) * 0.277;
      return (f * U.params.x - v) * U.params.y;`,
  },
  {
    // Softened central gravity: a disc that shears into spiral structure.
    name: 'orbit',
    params: [0.02, 0.0004, 0, 0], // G, softening
    velMax: 2,
    damping: 0,
    init: 'disc',
    initVelocity: 'orbital',
    wgsl: /* wgsl */ `
      let c = p - 0.5;
      let r2 = dot(c, c) + U.params.y;
      return -c * U.params.x / (r2 * sqrt(r2));`,
  },
  {
    // Three drifting point vortices on the torus.
    name: 'vortex',
    params: [0.01, 4, 0.002, 0], // circulation, relaxation rate, core size
    velMax: 1,
    damping: 0,
    init: 'uniform',
    initVelocity: 'zero',
    wgsl: /* wgsl */ `
      var f = vec2f(0.0);
      for (var k = 0u; k < 3u; k++) {
        let fk = f32(k);
        let c = vec2f(0.5) + 0.28 * vec2f(cos(U.time * (0.11 + 0.05 * fk) + fk * 2.1), sin(U.time * (0.13 - 0.03 * fk) + fk * 1.3));
        let d = fract(p - c + 0.5) - 0.5;
        let s = select(1.0, -1.0, k == 1u);
        f += s * vec2f(-d.y, d.x) / (dot(d, d) + U.params.z);
      }
      return (f * U.params.x - v) * U.params.y;`,
  },
  {
    // Particles slide down a moving height field and bunch into ripples.
    name: 'wave',
    params: [0.01, 1.5, 0, 0], // slope force, drag
    velMax: 1,
    damping: 0,
    init: 'uniform',
    initVelocity: 'zero',
    wgsl: /* wgsl */ `
      let a = TAU * 3.0 * p.x + U.time;
      let b = TAU * 2.0 * p.y - 0.7 * U.time;
      let g = TAU * vec2f(3.0 * cos(a) * sin(b), 2.0 * sin(a) * cos(b));
      return -U.params.x * g - v * U.params.y;`,
  },
  {
    // Three wandering soft attractors.
    name: 'attractors',
    params: [0.004, 0.001, 0, 0], // G, softening
    velMax: 2,
    damping: 0.15,
    init: 'gaussian',
    initVelocity: 'random',
    wgsl: /* wgsl */ `
      var acc = vec2f(0.0);
      for (var k = 0u; k < 3u; k++) {
        let fk = f32(k);
        let c = vec2f(0.5) + 0.3 * vec2f(cos(U.time * (0.21 + 0.07 * fk) + fk * 2.4), sin(U.time * (0.17 + 0.05 * fk) + fk * 0.9));
        let d = c - p;
        let r2 = dot(d, d) + U.params.y;
        acc += d * U.params.x / (r2 * sqrt(r2));
      }
      return acc;`,
  },
];

const COMMON = /* wgsl */ `
const TAU = 6.283185307179586;

struct PlaneU {
  mvp: mat4x4f,     //   0  viewProj * plane model
  params: vec4f,    //  64  behavior parameters
  dt: f32,          //  80  seconds simulated by this dispatch
  time: f32,        //  84
  velMax: f32,      //  88  velocity that maps to snorm 1.0
  damping: f32,     //  92  velocity multiplier for this step
  base: u32,        //  96  first particle of the plane inside its page
  drawCount: u32,   // 100  particles to rasterize (LOD prefix)
  simCount: u32,    // 104  particles to simulate
  weight: u32,      // 108  fixed-point brightness per particle
  behavior: u32,    // 112
  flags: u32,       // 116  1 sim, 2 draw, 4 bilinear splat
  seed: u32,        // 120
  frame: u32,       // 124
  fbWidth: u32,     // 128
  fbHeight: u32,    // 132
}

struct Particle {
  pos: u32, // x:u16 | y:u16 << 16, unorm over the plane
  vel: u32, // x:i16 | y:i16 << 16, snorm * velMax
}

@group(0) @binding(0) var<uniform> U: PlaneU;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

/** Uniform in [0, 1). */
fn rnd(h: u32) -> f32 {
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

fn unpackPos(w: u32) -> vec2f {
  return vec2f(f32(w & 0xffffu), f32(w >> 16u)) * (1.0 / 65536.0);
}

fn unpackVel(w: u32) -> vec2f {
  let x = f32(i32(w << 16u) >> 16u);
  let y = f32(i32(w) >> 16u);
  return vec2f(x, y) * (U.velMax / 32767.0);
}

/** Dithered pack: rounding error is random, so tiny accelerations survive on average. */
fn packVel(v: vec2f, r: vec2f) -> u32 {
  let q = clamp(vec2i(floor(v * (32767.0 / U.velMax) + r)), vec2i(-32767), vec2i(32767));
  return (u32(q.x) & 0xffffu) | (u32(q.y) << 16u);
}
`;

export function buildSimRasterWGSL(behaviors: Behavior[]): string {
  const fns = behaviors
    .map((b, i) => `fn behavior_${i}(p: vec2f, v: vec2f, id: u32) -> vec2f {${b.wgsl}\n}`)
    .join('\n\n');
  const cases = behaviors.map((_, i) => `    case ${i}u: { return behavior_${i}(p, v, id); }`).join('\n');

  return /* wgsl */ `${COMMON}
@group(0) @binding(2) var<storage, read_write> fb: array<atomic<u32>>;

${fns}

fn accel(p: vec2f, v: vec2f, id: u32) -> vec2f {
  switch U.behavior {
${cases}
    default: { return vec2f(0.0); }
  }
}

fn splat(x: i32, y: i32, w: u32) {
  if (w == 0u || x < 0 || y < 0 || x >= i32(U.fbWidth) || y >= i32(U.fbHeight)) { return; }
  atomicAdd(&fb[u32(y) * U.fbWidth + u32(x)], w);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let doSim = (U.flags & ${FLAG_SIM}u) != 0u && i < U.simCount;
  let doDraw = (U.flags & ${FLAG_DRAW}u) != 0u && i < U.drawCount;
  if (!doSim && !doDraw) { return; }

  let idx = U.base + i;
  var P = particles[idx];

  if (doSim) {
    let h0 = pcg(idx ^ U.seed ^ (U.frame * 0x9e3779b9u));
    let h1 = pcg(h0);
    let h2 = pcg(h1);
    let h3 = pcg(h2);
    let p = unpackPos(P.pos);
    var v = unpackVel(P.vel);
    v = (v + accel(p, v, idx) * U.dt) * U.damping;
    // Move in u16 units with dithered rounding; u16 wrap makes the plane a torus.
    let mv = vec2i(floor(v * (U.dt * 65536.0) + vec2f(rnd(h0), rnd(h1))));
    let xi = (i32(P.pos & 0xffffu) + mv.x) & 0xffff;
    let yi = (i32(P.pos >> 16u) + mv.y) & 0xffff;
    P.pos = u32(xi) | (u32(yi) << 16u);
    P.vel = packVel(v, vec2f(rnd(h2), rnd(h3)));
    particles[idx] = P;
  }

  if (doDraw) {
    let p = unpackPos(P.pos);
    let clip = U.mvp * vec4f(p - 0.5, 0.0, 1.0);
    if (clip.w <= 0.0) { return; }
    let ndc = clip.xyz / clip.w;
    if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0 || ndc.z < 0.0 || ndc.z > 1.0) { return; }
    let px = (ndc.xy * vec2f(0.5, -0.5) + 0.5) * vec2f(f32(U.fbWidth), f32(U.fbHeight));
    if ((U.flags & ${FLAG_BILINEAR}u) != 0u) {
      let q = px - 0.5;
      let b = floor(q);
      let f = q - b;
      let x = i32(b.x);
      let y = i32(b.y);
      let w = f32(U.weight);
      splat(x, y, u32(w * (1.0 - f.x) * (1.0 - f.y) + 0.5));
      splat(x + 1, y, u32(w * f.x * (1.0 - f.y) + 0.5));
      splat(x, y + 1, u32(w * (1.0 - f.x) * f.y + 0.5));
      splat(x + 1, y + 1, u32(w * f.x * f.y + 0.5));
    } else {
      splat(i32(px.x), i32(px.y), U.weight);
    }
  }
}
`;
}

/** Seeds a plane on the GPU so 50M particles never cross the CPU. U.behavior = pattern | velocity << 8. */
export const INIT_WGSL = /* wgsl */ `${COMMON}
fn gauss2(h: u32) -> vec2f {
  let u1 = max(rnd(h), 1e-7);
  let u2 = rnd(pcg(h ^ 0x68bc21ebu));
  return sqrt(-2.0 * log(u1)) * vec2f(cos(TAU * u2), sin(TAU * u2));
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= U.simCount) { return; }
  let idx = U.base + i;
  let h0 = pcg(idx * 2u + 1u + U.seed * 0x9e3779b9u);
  let h1 = pcg(h0);
  let h2 = pcg(h1);
  let h3 = pcg(h2);
  let pattern = U.behavior & 0xffu;
  let velMode = U.behavior >> 8u;

  var p = vec2f(rnd(h0), rnd(h1));
  if (pattern == 1u) {
    let a = TAU * rnd(h1);
    p = vec2f(0.5) + 0.42 * sqrt(rnd(h0)) * vec2f(cos(a), sin(a));
  } else if (pattern == 2u) {
    let a = TAU * rnd(h1);
    p = vec2f(0.5) + (0.3 + 0.03 * gauss2(h0).x) * vec2f(cos(a), sin(a));
  } else if (pattern == 3u) {
    p = vec2f(0.5) + 0.12 * gauss2(h0);
  }
  p = fract(p);

  var v = vec2f(0.0);
  if (velMode == 1u) {
    // Circular orbit speed for the softened central gravity of the 'orbit' behavior.
    let c = p - 0.5;
    let r2 = dot(c, c);
    let rs = r2 + U.params.y;
    let speed = sqrt(U.params.x * r2 / (rs * sqrt(rs)));
    v = vec2f(-c.y, c.x) / max(sqrt(r2), 1e-6) * speed;
  } else if (velMode == 2u) {
    v = 0.05 * gauss2(h2);
  }

  let pq = vec2u(p * 65536.0) & vec2u(0xffffu);
  particles[idx] = Particle(pq.x | (pq.y << 16u), packVel(v, vec2f(rnd(h2), rnd(h3))));
}
`;

/** Fullscreen resolve of the atomic framebuffer: white on black with an exponential tone curve. */
export const RESOLVE_WGSL = /* wgsl */ `
struct ResolveU {
  width: u32,
  height: u32,
  exposure: f32,
  gamma: f32,
}
@group(0) @binding(0) var<uniform> R: ResolveU;
@group(0) @binding(1) var<storage, read> fb: array<u32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let x = min(u32(pos.x), R.width - 1u);
  let y = min(u32(pos.y), R.height - 1u);
  let c = f32(fb[y * R.width + x]) * (1.0 / ${WEIGHT_ONE}.0);
  let v = pow(1.0 - exp(-c * R.exposure), R.gamma);
  return vec4f(v, v, v, 1.0);
}
`;
