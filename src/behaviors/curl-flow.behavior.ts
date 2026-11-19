import { defineBehavior } from "./core";

/**
 * Curl flow: particles carried by a drifting, divergence-free noise field.
 *
 * A perfectly incompressible flow keeps a uniform cloud uniform, which would
 * look like static. Two things break that on purpose: `inertia` (heavy
 * particles get flung out of eddies and collect into filaments between them)
 * and `gather` (a small compressible part that pulls particles onto ridges).
 *
 * Cost per particle: two 2D noise taps with analytic derivatives (8 hashes),
 * no trig, no reads of other particles or fields. State: pos + vel, nothing
 * else, and it works from the default init (random positions at rest).
 */
export default defineBehavior({
  id: "curl-flow",
  label: "Curl flow",
  description: "Heavy particles in a drifting noise flow get flung out of the eddies and collect into fine filaments.",
  tags: ["flow", "massive"],
  params: {
    scale: { default: 2.2, min: 0.5, max: 12, scale: "log", label: "Eddy scale" },
    speed: { default: 0.35, min: 0, max: 1.5, step: 0.01, label: "Flow speed" },
    evolve: { default: 0.12, min: 0, max: 1, step: 0.01, label: "Evolution" },
    inertia: { default: 0.6, min: 0, max: 3, step: 0.01, label: "Inertia" },
    gather: { default: 0.12, min: -0.5, max: 1, step: 0.01, label: "Gather" },
    detail: { default: 0.5, min: 0, max: 1, step: 0.01, label: "Fine detail" },
    jitter: { default: 0.0, min: 0, max: 0.05, step: 0.001, label: "Jitter", randomize: false },
  },
  wgsl: /* wgsl */ `
fn cf_grad(c: vec2i) -> vec2f {
  var h = bitcast<u32>(c.x) * 0x27d4eb2du + bitcast<u32>(c.y) * 0x165667b1u;
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h = h ^ (h >> 15u);
  return vec2f(f32(h & 0xffffu), f32(h >> 16u)) * (2.0 / 65535.0) - 1.0;
}

// 2D gradient noise. x = value, yz = analytic derivative.
fn cf_noise(p: vec2f) -> vec3f {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let ga = cf_grad(i);
  let gb = cf_grad(i + vec2i(1, 0));
  let gc = cf_grad(i + vec2i(0, 1));
  let gd = cf_grad(i + vec2i(1, 1));
  let va = dot(ga, f);
  let vb = dot(gb, f - vec2f(1.0, 0.0));
  let vc = dot(gc, f - vec2f(0.0, 1.0));
  let vd = dot(gd, f - vec2f(1.0, 1.0));
  let k = va - vb - vc + vd;
  let v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k;
  let d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
        + du * (u.yx * k + vec2f(vb, vc) - va);
  return vec3f(v, d);
}

fn update(p: Particle, i: u32) -> Particle {
  let P = plane.params;
  let dt = globals.dt;
  let t = globals.time * P.evolve;
  let q = p.pos * P.scale + plane.seed * 97.0;

  // Potential = two noise layers sliding in different directions, which
  // animates the flow without paying for 3D noise.
  let n1 = cf_noise(q + vec2f(t, t * 0.37));
  let n2 = cf_noise(q * 2.03 - vec2f(t * 0.61, t) + 17.0);
  let g = n1.yz + n2.yz * (P.detail * 2.03);

  // Curl of the potential (incompressible swirl) plus a little of its gradient.
  let flow = (vec2f(g.y, -g.x) + g * P.gather) * P.speed;

  var o: Particle;
  o.vel = mix(p.vel, flow, dt / (P.inertia + dt + 1e-6));
  var pos = p.pos + o.vel * dt;
  if (P.jitter > 0.0) {
    pos += (vec2f(rand(i, 1), rand(i, 2)) - 0.5) * P.jitter * sqrt(dt * 60.0);
  }
  o.pos = wrap(pos);
  return o;
}
`,
});
