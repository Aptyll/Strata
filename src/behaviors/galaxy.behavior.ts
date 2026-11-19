import { defineBehavior } from "./define";

/**
 * Three wandering gravity wells. Particles fall in, slingshot and smear into
 * spiral arms. No particle-particle interaction, just inertia.
 */
export default defineBehavior({
  id: "galaxy",
  label: "Gravity wells",
  params: {
    gravity: { default: 0.06, min: 0, max: 0.5 },
    // softening radius squared, avoids infinite forces
    soft: { default: 0.004, min: 0.0005, max: 0.05 },
    drag: { default: 0.25, min: 0, max: 3 },
    // how fast the wells wander
    spin: { default: 0.12, min: 0, max: 1 },
    lifetime: { default: 30, min: 1, max: 120 },
  },
  wgsl: /* wgsl */ `
fn update(pIn: Particle, i: u32) -> Particle {
  var p = pIn;
  var acc = vec2f(0.0);
  for (var k = 0u; k < 3u; k++) {
    let a = globals.time * plane.params.spin * (1.0 + 0.37 * f32(k)) + f32(k) * 2.094 + plane.seed * 6.283;
    let well = vec2f(cos(a), sin(a * 1.3)) * 0.5;
    let d = well - p.pos;
    let r2 = dot(d, d) + plane.params.soft;
    acc += d / (r2 * sqrt(r2));
  }
  p.vel = (p.vel + acc * plane.params.gravity * globals.dt) * exp(-plane.params.drag * globals.dt);
  p.pos += p.vel * globals.dt;
  if (outside(p.pos) || rand(i, 1u) * plane.params.lifetime < globals.dt) {
    p = respawn(i);
  }
  return p;
}
`,
});
