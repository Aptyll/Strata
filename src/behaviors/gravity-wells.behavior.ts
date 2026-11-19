import { defineBehavior } from "./core";

/**
 * Gravity wells: a handful of moving attractors pull the whole cloud.
 *
 * Particles start cold (at rest), so they fall as a smooth sheet that folds
 * over itself into sharp caustics, then winds into spirals around each well.
 * Anything swallowed by a well, or leaving the unit disc, restarts at rest on
 * the rim, which keeps fresh cold streams falling in forever.
 *
 * Cost per particle: one softened inverse-square term per well (up to 8) and
 * the wells' positions (2 trig calls per well). No noise, no fields, no reads
 * of other particles. State: pos + vel only, works from the default init.
 */
export default defineBehavior({
  id: "gravity-wells",
  label: "Gravity wells",
  description: "A cold cloud falls into a few moving wells, folding into caustics and spirals.",
  tags: ["orbit", "massive"],
  params: {
    wells: { default: 3, min: 1, max: 8, step: 1, label: "Wells", randomize: false },
    strength: { default: 0.15, min: 0.005, max: 0.4, scale: "log", label: "Strength" },
    softening: { default: 0.05, min: 0.01, max: 0.3, scale: "log", label: "Softening" },
    swirl: { default: 0.4, min: -1, max: 1, step: 0.01, label: "Swirl" },
    drag: { default: 0.4, min: 0, max: 2, step: 0.01, label: "Drag" },
    orbit: { default: 0.5, min: 0, max: 1.5, step: 0.01, label: "Well motion" },
    renew: { default: 0, min: 0, max: 1, step: 0.005, label: "Renew rate" },
  },
  wgsl: /* wgsl */ `
fn gw_well(k: u32, t: f32) -> vec2f {
  let fk = f32(k);
  let phase = plane.seed * 43.0 + fk * 2.399963;
  let radius = 0.15 + 0.5 * fract(fk * 0.618034 + plane.seed);
  let rate = (0.5 + fract(fk * 0.37 + 0.2)) * select(-1.0, 1.0, (k & 1u) == 0u);
  return vec2f(cos(phase + t * rate), sin(phase * 1.3 + t * rate * 0.83)) * radius;
}

fn update(p: Particle, i: u32) -> Particle {
  let P = plane.params;
  let dt = globals.dt;
  let t = globals.time * P.orbit;
  let n = u32(clamp(P.wells, 1.0, 8.0) + 0.5);
  let soft2 = P.softening * P.softening;

  var acc = vec2f(0.0);
  var nearest = 1e9;
  for (var k = 0u; k < n; k++) {
    let d = gw_well(k, t) - p.pos;
    let d2 = dot(d, d);
    let r2 = d2 + soft2;
    acc += (d + vec2f(-d.y, d.x) * P.swirl) / (r2 * sqrt(r2));
    nearest = min(nearest, d2);
  }

  var o: Particle;
  o.vel = (p.vel + acc * (P.strength * dt)) * max(0.0, 1.0 - P.drag * dt);
  o.pos = p.pos + o.vel * dt;

  // Swallowed, escaped or renewed: restart at rest on the rim. A thin cold ring
  // falling in is what keeps the folds sharp; a uniform refill would wash them out.
  if (dot(o.pos, o.pos) > 1.0 || nearest < soft2 * 0.1 || rand(i, 1) < P.renew * dt) {
    let a = rand(i, 2) * 6.2831853;
    o.pos = vec2f(cos(a), sin(a)) * (0.9 + 0.08 * rand(i, 3));
    o.vel = vec2f(0.0);
  }
  return o;
}
`,
});
