import { defineBehavior } from "./core";

/**
 * Particles ride a slowly evolving noise field. A curl component makes them
 * swirl, and a small downhill component gathers them into drifting filaments.
 */
export default defineBehavior({
  id: "flow",
  label: "Flow field",
  description: "Particles ride a slowly changing noise field that swirls them and gathers them into drifting filaments.",
  params: {
    // noise frequency across the sheet
    scale: { default: 2.2, min: 0.5, max: 8 },
    // how fast particles travel
    speed: { default: 0.35, min: 0, max: 2 },
    // 0 = pure swirl (uniform fog), higher = sharper filaments
    gather: { default: 0.45, min: 0, max: 2 },
    // how fast the field itself changes
    evolve: { default: 0.06, min: 0, max: 1 },
    // how quickly velocity follows the field
    response: { default: 4, min: 0.2, max: 20 },
    // mean seconds before a particle respawns
    lifetime: { default: 14, min: 1, max: 120 },
  },
  wgsl: /* wgsl */ `
fn potential(p: vec2f) -> f32 {
  let t = globals.time * plane.params.evolve;
  let o = plane.seed * 37.0;
  let q = p * plane.params.scale;
  return noise2(q + vec2f(o + t, o - 0.7 * t)) + 0.5 * noise2(q * 2.03 - vec2f(1.3 * t, o));
}

fn update(pIn: Particle, i: u32) -> Particle {
  var p = pIn;
  let e = 0.01;
  let n = potential(p.pos);
  let g = vec2f(potential(p.pos + vec2f(e, 0.0)) - n, potential(p.pos + vec2f(0.0, e)) - n) / e;
  let want = (vec2f(g.y, -g.x) - g * plane.params.gather) * plane.params.speed;
  p.vel = mix(p.vel, want, 1.0 - exp(-globals.dt * plane.params.response));
  p.pos += p.vel * globals.dt;
  if (outside(p.pos) || rand(i, 1u) * plane.params.lifetime < globals.dt) {
    p = respawn(i);
  }
  return p;
}
`,
});
