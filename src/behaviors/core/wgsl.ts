/**
 * Reusable WGSL building blocks for behavior snippets.
 *
 * Each export is plain WGSL text holding one function. A behavior picks the blocks it
 * needs and joins them into its `wgsl` string with `wgsl(...)`, so composition happens
 * once, when the file loads. The shader only ever contains what the behavior calls:
 * there is no runtime module system and no per-particle cost for blocks left out.
 *
 * Blocks rely only on the scope the engine documents in docs/architecture.md
 * (`Particle`, `globals`, `plane`, `rand`, `noise2`). Their names never collide with
 * the engine helpers (rand, noise2, outside, wrap, respawn).
 */

/** Join blocks and a body into one snippet, dropping repeated blocks. */
export function wgsl(...parts: string[]): string {
  return [...new Set(parts.map((p) => p.trim()))].join("\n\n") + "\n";
}

/** rotate2(v, angle): rotate a vector counter-clockwise by `angle` radians. */
export const ROTATE = /* wgsl */ `
fn rotate2(v: vec2f, angle: f32) -> vec2f {
  let c = cos(angle);
  let s = sin(angle);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}`;

/**
 * curl2(p): divergence-free flow from the engine's noise2, so particles swirl without
 * piling up. About unit magnitude. Costs three noise2 calls. Animate by offsetting p.
 */
export const CURL = /* wgsl */ `
fn curl2(p: vec2f) -> vec2f {
  let e = 0.01;
  let n = noise2(p);
  let dx = (noise2(p + vec2f(e, 0.0)) - n) / e;
  let dy = (noise2(p + vec2f(0.0, e)) - n) / e;
  return vec2f(dy, -dx);
}`;

/** attract(pos, center, mass, soft): softened inverse-square pull toward a point. */
export const ATTRACT = /* wgsl */ `
fn attract(pos: vec2f, center: vec2f, mass: f32, soft: f32) -> vec2f {
  let d = center - pos;
  let r2 = dot(d, d) + soft * soft;
  return d * (mass / (r2 * sqrt(r2)));
}`;

/**
 * orbiters(pos, count, radius, speed, mass, soft): pull from up to 8 point masses
 * circling the sheet center, each a little faster than the last so the pattern
 * never repeats exactly. Positions come from the clock, so they cost no storage.
 */
export const ORBITERS = /* wgsl */ `
fn orbiters(pos: vec2f, count: f32, radius: f32, speed: f32, mass: f32, soft: f32) -> vec2f {
  let n = u32(clamp(count, 1.0, 8.0));
  var acc = vec2f(0.0);
  for (var k = 0u; k < n; k++) {
    let a = 6.2831853 * f32(k) / f32(n) + globals.time * speed * (1.0 + 0.25 * f32(k));
    let d = radius * vec2f(cos(a), sin(a)) - pos;
    let r2 = dot(d, d) + soft * soft;
    acc += d * (mass / (r2 * sqrt(r2)));
  }
  return acc;
}`;

/** vortex(pos, strength, tightness): swirl around the sheet center, fading with distance. */
export const VORTEX = /* wgsl */ `
fn vortex(pos: vec2f, strength: f32, tightness: f32) -> vec2f {
  return vec2f(-pos.y, pos.x) * (strength / (1.0 + tightness * dot(pos, pos)));
}`;

/** damp(vel, rate): frame-rate independent drag. `rate` is per second, 0 means none. */
export const DAMP = /* wgsl */ `
fn damp(vel: vec2f, rate: f32) -> vec2f {
  return vel * exp(-rate * globals.dt);
}`;

/** limitSpeed(vel, lo, hi): keep speed inside lo..hi. Use lo == hi for constant-speed agents. */
export const LIMIT_SPEED = /* wgsl */ `
fn limitSpeed(vel: vec2f, lo: f32, hi: f32) -> vec2f {
  let s = length(vel);
  if (s < 1e-9) { return vec2f(lo, 0.0); }
  return vel * (clamp(s, lo, hi) / s);
}`;

/** jitter2(i, salt): random vector in [-1, 1]^2, new every frame. Uses salts `salt` and `salt + 1`. */
export const JITTER = /* wgsl */ `
fn jitter2(i: u32, salt: u32) -> vec2f {
  return vec2f(rand(i, salt), rand(i, salt + 1u)) * 2.0 - 1.0;
}`;

/** bounce(p, restitution): reflect off the sheet edges at [-1, 1]. */
export const BOUNCE = /* wgsl */ `
fn bounce(p: Particle, restitution: f32) -> Particle {
  var q = p;
  if (q.pos.x < -1.0) { q.pos.x = -2.0 - q.pos.x; q.vel.x = abs(q.vel.x) * restitution; }
  if (q.pos.x > 1.0) { q.pos.x = 2.0 - q.pos.x; q.vel.x = -abs(q.vel.x) * restitution; }
  if (q.pos.y < -1.0) { q.pos.y = -2.0 - q.pos.y; q.vel.y = abs(q.vel.y) * restitution; }
  if (q.pos.y > 1.0) { q.pos.y = 2.0 - q.pos.y; q.vel.y = -abs(q.vel.y) * restitution; }
  q.pos = clamp(q.pos, vec2f(-1.0), vec2f(1.0));
  return q;
}`;
