import { MAX_BEHAVIOR_PARAMS, MAX_BRUSHES, type Behavior } from "../core/contracts";

/** Bytes per particle: pos.xy + vel.xy as f32. */
export const PARTICLE_STRIDE = 16;
export const WORKGROUP_SIZE = 256;
/**
 * Workgroups per dispatch row. A plane with more particles than one row holds
 * (65,536) dispatches several rows, so the per-dimension workgroup limit
 * (65,535 by default) never caps a plane's size. Rows are short on purpose:
 * a dispatch is a rectangle, so up to one row of invocations runs past the
 * count and exits early. With 256 groups that is under 65,536 wasted
 * invocations; with 32,768 it was up to 8.4 million. 65,535 rows still reach
 * 4.29 billion particles, the u32 index limit.
 */
export const DISPATCH_ROW_GROUPS = 256;

/** Workgroup counts (x, y) that cover \`count\` particles. */
export function dispatchSize(count: number): [number, number] {
  const groups = Math.ceil(count / WORKGROUP_SIZE);
  return [Math.min(groups, DISPATCH_ROW_GROUPS), Math.ceil(groups / DISPATCH_ROW_GROUPS)];
}

/** Globals uniform: viewProj (64) + time, dt, frame, brightness (16) + 4 brushes (128). */
export const GLOBALS_SIZE = 208;
/** Byte offset of the first brush in the Globals uniform. */
export const GLOBALS_BRUSHES_OFFSET = 80;
/** Acceleration, in sheet units per second squared, of a full-strength brush. */
export const BRUSH_GAIN = 2.0;
/** Fraction of the brush push applied straight to position, so behaviors that ignore velocity still respond. */
export const BRUSH_DISPLACE = 0.25;
/** Plane uniform: model (64) + 8 params (32) + count, seed, brightness, pad (16). */
export const PLANE_UNIFORM_SIZE = 112;
export const PLANE_PARAMS_OFFSET = 64;
export const PLANE_COUNT_OFFSET = 96;
export const PLANE_SEED_OFFSET = 100;
export const PLANE_BRIGHTNESS_OFFSET = 104;

export const GLOBALS_WGSL = /* wgsl */ `
// The pointer as a force on one sheet. See Brush in src/core/contracts.ts.
struct Brush {
  pos: vec2f,     // sheet-local, [-1, 1]
  radius: f32,    // sheet-local units, 0 when unused
  strength: f32,  // positive pulls particles in, negative pushes them away
  vel: vec2f,     // sheet-local units per second
  plane: f32,     // seed of the plane it touches, -1 when unused
  charge: f32,    // 0..1, how long it has been held
}
struct Globals {
  viewProj: mat4x4f,
  time: f32,       // seconds since start
  dt: f32,         // seconds simulated this frame (clamped)
  frame: u32,
  brightness: f32, // light added per particle per pixel, before tonemapping
  brushes: array<Brush, ${MAX_BRUSHES}>,
}
@group(0) @binding(0) var<uniform> globals: Globals;
`;

/** Param names in slot order, padded with placeholders to MAX_BEHAVIOR_PARAMS. */
export function paramNames(behavior: Behavior): string[] {
  const names = Object.keys(behavior.params);
  while (names.length < MAX_BEHAVIOR_PARAMS) names.push(`unused${names.length}`);
  return names;
}

/** Full compute shader for a behavior: shared prelude + behavior snippet + entry point. */
export function buildSimShader(behavior: Behavior): string {
  const fields = paramNames(behavior).map((n) => `  ${n}: f32,`).join("\n");
  return /* wgsl */ `
${GLOBALS_WGSL}

struct Particle {
  pos: vec2f, // plane-local, the sheet spans [-1, 1] on both axes
  vel: vec2f,
}
struct Params {
${fields}
}
struct Plane {
  model: mat4x4f,
  params: Params,
  count: u32, // particles active this frame
  seed: f32, // unique per plane, in [0, 1)
  brightness: f32, // multiplies globals.brightness for this plane
}
@group(1) @binding(0) var<uniform> plane: Plane;
@group(1) @binding(1) var<storage, read_write> particles: array<Particle>;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

// Uniform random in [0, 1). Changes every frame; vary \`salt\` for independent draws.
fn rand(i: u32, salt: u32) -> f32 {
  let h = pcg(i ^ pcg(salt * 2654435761u + globals.frame + bitcast<u32>(plane.seed)));
  return f32(h >> 8u) / 16777216.0;
}

fn latticeGradient(ip: vec2i) -> vec2f {
  let h = pcg(bitcast<u32>(ip.x) + pcg(bitcast<u32>(ip.y)));
  let a = f32(h >> 8u) * (6.2831853 / 16777216.0);
  return vec2f(cos(a), sin(a));
}

// 2D gradient noise, roughly in [-0.7, 0.7].
fn noise2(p: vec2f) -> f32 {
  let ip = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = dot(latticeGradient(ip), f);
  let b = dot(latticeGradient(ip + vec2i(1, 0)), f - vec2f(1.0, 0.0));
  let c = dot(latticeGradient(ip + vec2i(0, 1)), f - vec2f(0.0, 1.0));
  let d = dot(latticeGradient(ip + vec2i(1, 1)), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn outside(pos: vec2f) -> bool {
  return any(abs(pos) > vec2f(1.0));
}

// Wrap a position around the sheet edges (torus).
fn wrap(pos: vec2f) -> vec2f {
  return fract(pos * 0.5 + 0.5) * 2.0 - 1.0;
}

// A fresh particle at a random spot on the sheet, at rest.
fn respawn(i: u32) -> Particle {
  return Particle(vec2f(rand(i, 101u), rand(i, 102u)) * 2.0 - 1.0, vec2f(0.0));
}

// Acceleration from the pointer brushes touching this plane. Applied to every
// behavior after update(); a behavior may also call it to react in its own way.
// Smooth and finite: zero at the edge of the radius and soft at the centre,
// so an attract well gathers a ring instead of collapsing to a point.
fn brushAccel(pos: vec2f) -> vec2f {
  var a = vec2f(0.0);
  for (var k = 0u; k < ${MAX_BRUSHES}u; k++) {
    let b = globals.brushes[k];
    if (b.plane != plane.seed || b.radius <= 0.0) { continue; }
    let d = b.pos - pos;
    let r = length(d) + 1e-6;
    if (r >= b.radius) { continue; }
    let q = r / b.radius;
    let falloff = (1.0 - q) * (1.0 - q);
    let core = q / (q + 0.12);
    a += d * (b.strength * falloff * core / r);
  }
  return a * ${BRUSH_GAIN.toFixed(3)};
}

// ---- behavior: ${behavior.id} ----
${behavior.wgsl}
// ---- end behavior ----

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * ${DISPATCH_ROW_GROUPS * WORKGROUP_SIZE}u;
  if (i >= plane.count) { return; }
  var p = update(particles[i], i);
  let push = brushAccel(p.pos) * globals.dt;
  p.vel += push;
  p.pos += push * ${BRUSH_DISPLACE.toFixed(3)};
  particles[i] = p;
}
`;
}
