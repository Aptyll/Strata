/**
 * WGSL for edge crossing. COMMON holds the layouts and the two pure functions
 * that define a crossing (where it lands, where it is mid flight); the compute
 * and render shaders both use it so they always agree.
 */

export const LINK_UNIFORM_BYTES = 192;
export const COURIER_BYTES = 24;

const COMMON = /* wgsl */ `
struct Globals {
  viewProj: mat4x4f,
  time: f32,
  dt: f32,
  frame: u32,
  brightness: f32,
}
@group(0) @binding(0) var<uniform> globals: Globals;

// One per link, 192 bytes.
struct LinkU {
  src: mat4x4f,       // source plane local to world (half size baked in)
  dst: mat4x4f,       // destination plane local to world
  base: u32,          // first courier of this link
  count: u32,         // couriers owned by this link
  srcCount: u32,      // active particles on the source plane
  dstCount: u32,      // active particles on the destination plane
  exit: u32,          // edge of src the particles leave through (0 +x, 1 -x, 2 +y, 3 -y)
  entry: u32,         // edge of dst they arrive through
  flip: f32,          // -1 when the along-edge coordinate is mirrored
  invLength: f32,     // 1 / world distance between the edge centres
  leak: f32,          // chance that a particle found at the edge is taken
  margin: f32,        // width of the edge band, in plane-local units
  speed: f32,         // world units per second along the stream
  pinch: f32,         // 0..1, how tightly the stream ropes together mid flight
  twist: f32,         // whole turns the stream winds around its spine
  boost: f32,         // brightness multiplier for particles in flight
  seed: u32,
  pad: u32,
}
@group(1) @binding(0) var<uniform> L: LinkU;

// Matches the engine: plane-local, the sheet spans [-1, 1] on both axes.
struct Particle { pos: vec2f, vel: vec2f }

// A particle in transit. pos/vel are its state at the moment it left, frozen;
// t == 0 means the courier is idle, 0 < t < 1 is flight progress.
struct Courier { pos: vec2f, vel: vec2f, t: f32, pad: f32 }

const PI = 3.14159265;

fn hash(x: u32) -> u32 {
  let s = x * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand01(x: u32) -> f32 { return f32(x >> 8u) * (1.0 / 16777216.0); }

fn edge_normal(e: u32) -> vec2f {
  let s = 1.0 - 2.0 * f32(e & 1u);
  if (e < 2u) { return vec2f(s, 0.0); }
  return vec2f(0.0, s);
}
fn to_world(m: mat4x4f, p: vec2f) -> vec3f { return (m * vec4f(p, 0.0, 1.0)).xyz; }
fn to_world_dir(m: mat4x4f, d: vec2f) -> vec3f { return normalize((m * vec4f(d, 0.0, 0.0)).xyz); }

// Where a particle that left src at (pos, vel) arrives on dst: same place
// along the edge, same speed, now heading inward.
fn landing(pos: vec2f, vel: vec2f) -> Particle {
  var s: f32; var vout: f32; var vtan: f32;
  if (L.exit < 2u) { s = pos.y; vout = abs(vel.x); vtan = vel.y; }
  else { s = pos.x; vout = abs(vel.y); vtan = vel.x; }
  let inward = -edge_normal(L.entry);
  let along = abs(inward.yx);
  return Particle(-inward * 0.99 + along * clamp(s * L.flip, -0.98, 0.98),
                  inward * max(vout, 0.05) + along * vtan * L.flip);
}

fn bezier(a: vec3f, b: vec3f, c: vec3f, d: vec3f, t: f32) -> vec3f {
  let r = 1.0 - t;
  return a * (r * r * r) + b * (3.0 * r * r * t) + c * (3.0 * r * t * t) + d * (t * t * t);
}

// World position mid flight. Each particle rides its own curve from where it
// left to where it lands, leaving and arriving square to the edges. The link's
// "spine" is the same curve between the two edge centres; pinch pulls
// particles toward it and twist winds them around it.
fn flight(pos: vec2f, vel: vec2f, t: f32) -> vec3f {
  let en = edge_normal(L.exit);
  let inward = -edge_normal(L.entry);
  let p0 = to_world(L.src, pos);
  let p1 = to_world(L.dst, landing(pos, vel).pos);
  let s0 = to_world(L.src, en);
  let s1 = to_world(L.dst, -inward);
  let t0 = to_world_dir(L.src, en);
  let t1 = to_world_dir(L.dst, inward);
  let h = 0.45 * distance(s0, s1);
  let sp = bezier(s0, s0 + t0 * h, s1 - t1 * h, s1, t);
  let sn = sin(PI * t);
  var off = (bezier(p0, p0 + t0 * h, p1 - t1 * h, p1, t) - sp) * (1.0 - L.pinch * sn * sn);
  let axis = normalize(s1 - s0 + vec3f(1e-6, 0.0, 0.0));
  let ang = 2.0 * PI * L.twist * t;
  off = off * cos(ang) + cross(axis, off) * sin(ang) + axis * dot(axis, off) * (1.0 - cos(ang));
  return sp + off;
}
`;

/**
 * Steps the couriers of one link. An idle courier looks at a few random
 * particles of the source plane; if one sits in the band along the exit edge
 * it carries that particle away and the plane's slot is refilled at a random
 * spot. A courier that finishes its flight writes the particle into a random
 * slot of the destination plane, at the entry edge, heading inward.
 *
 * Work is proportional to the number of couriers. Plane particles are only
 * touched by the few random reads and writes above, never iterated.
 */
export const simShader = /* wgsl */ `
${COMMON}
@group(1) @binding(1) var<storage, read_write> srcParticles: array<Particle>;
@group(1) @binding(2) var<storage, read_write> dstParticles: array<Particle>;
@group(1) @binding(3) var<storage, read_write> couriers: array<Courier>;

const TRIES = 4u;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= L.count) { return; }
  let ci = L.base + gid.x;
  var c = couriers[ci];
  var rng = hash(ci ^ hash(globals.frame ^ L.seed));

  if (c.t > 0.0) {
    // Per courier speed spread so a stream is a ribbon, not a pulse train.
    let jitter = 0.7 + 0.6 * rand01(hash(ci));
    c.t += globals.dt * L.speed * L.invLength * jitter;
    if (c.t >= 1.0) {
      if (L.dstCount > 0u) { dstParticles[hash(rng + 1u) % L.dstCount] = landing(c.pos, c.vel); }
      c.t = 0.0;
    }
    couriers[ci] = c;
    return;
  }

  if (L.srcCount == 0u) { return; }
  let n = edge_normal(L.exit);
  for (var k = 0u; k < TRIES; k++) {
    rng = hash(rng);
    let idx = rng % L.srcCount;
    let p = srcParticles[idx];
    let d = dot(p.pos, n);
    if (d > 1.0 - L.margin && d < 1.5) {
      rng = hash(rng);
      if (rand01(rng) < L.leak) {
        c.pos = p.pos + n * (1.0 - d); // snap onto the edge
        c.vel = p.vel;
        c.t = 1e-4;
        let a = hash(rng); let b = hash(a);
        srcParticles[idx] = Particle(vec2f(rand01(a), rand01(b)) * 2.0 - 1.0, vec2f(0.0));
        couriers[ci] = c;
      }
      return;
    }
  }
}
`;

/** Draws the couriers of one link as additive points. Idle ones are clipped. */
export const drawShader = /* wgsl */ `
${COMMON}
@group(1) @binding(1) var<storage, read> couriers: array<Courier>;

struct VOut { @builtin(position) pos: vec4f, @location(0) light: f32 }

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let c = couriers[L.base + i];
  var o: VOut;
  o.light = globals.brightness * L.boost;
  if (c.t <= 0.0) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  o.pos = globals.viewProj * vec4f(flight(c.pos, c.vel, c.t), 1.0);
  return o;
}
@fragment fn fs(v: VOut) -> @location(0) vec4f { return vec4f(v.light, v.light, v.light, 0.0); }
`;
