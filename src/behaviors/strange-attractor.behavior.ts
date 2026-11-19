import { defineBehavior } from "./core";

/**
 * Strange attractor: every particle integrates a 3D chaotic system and the
 * sheet shows its slowly tumbling projection.
 *
 * Packed state, 16 bytes, no extra buffers:
 *   pos    = rotated (x, y) of the 3D point, already the on-sheet position
 *   vel.x  = rotated z (depth, not drawn)
 *   vel.y  = tumble angle the point was last written with
 * Each step un-rotates with the stored angle, integrates, and re-rotates with
 * the current angle, so changing params, clamped frames or respawns never
 * desynchronise it. Works from the default init: any point that is off the
 * attractor falls onto it, and points that escape are re-seeded near it.
 *
 * Cost per particle: 2 midpoint steps of a polynomial ODE and one sin/cos pair
 * for each of two angles. No noise, no fields, no other particles.
 */
export default defineBehavior({
  id: "strange-attractor",
  label: "Strange attractor",
  description: "Every particle traces a 3D chaotic system; the sheet shows its slowly tumbling shadow.",
  tags: ["attractor", "massive"],
  params: {
    kind: {
      default: 0, min: 0, max: 4, step: 1, label: "System",
      description: "0 Lorenz, 1 Aizawa, 2 Thomas, 3 Halvorsen, 4 Dadras",
    },
    speed: { default: 1, min: 0, max: 4, step: 0.01, label: "Speed" },
    tumble: { default: 0.15, min: -1, max: 1, step: 0.01, label: "Tumble" },
    tilt: { default: 0.3, min: -1.6, max: 1.6, step: 0.01, label: "Tilt" },
    size: { default: 0.8, min: 0.2, max: 1.5, step: 0.01, label: "Size", randomize: false },
    reseed: { default: 0.0, min: 0, max: 2, step: 0.01, label: "Reseed rate", randomize: false },
  },
  wgsl: /* wgsl */ `
fn sa_deriv(kind: i32, a: vec3f) -> vec3f {
  switch kind {
    case 1 { // Aizawa
      let b = a.z - 0.7;
      return vec3f(b * a.x - 3.5 * a.y,
                   3.5 * a.x + b * a.y,
                   0.6 + 0.95 * a.z - a.z * a.z * a.z / 3.0
                     - (a.x * a.x + a.y * a.y) * (1.0 + 0.25 * a.z)
                     + 0.1 * a.z * a.x * a.x * a.x);
    }
    case 2 { // Thomas
      return sin(a.yzx) - 0.208186 * a;
    }
    case 3 { // Halvorsen
      return -1.89 * a - 4.0 * a.yzx - 4.0 * a.zxy - a.yzx * a.yzx;
    }
    case 4 { // Dadras
      return vec3f(a.y - 3.0 * a.x + 2.7 * a.y * a.z,
                   1.7 * a.y - a.x * a.z + a.z,
                   2.0 * a.x * a.y - 9.0 * a.z);
    }
    default { // Lorenz
      return vec3f(10.0 * (a.y - a.x), a.x * (28.0 - a.z) - a.y, a.x * a.y - 8.0 / 3.0 * a.z);
    }
  }
}

// xyz = centre of the attractor, w = half extent, in the system's own units.
fn sa_frame(kind: i32) -> vec4f {
  switch kind {
    case 1 { return vec4f(0.0, 0.0, 0.6, 1.7); }
    case 2 { return vec4f(0.0, 0.0, 0.0, 4.6); }
    case 3 { return vec4f(-3.0, -3.0, -3.0, 11.0); }
    case 4 { return vec4f(0.0, 0.0, 0.0, 13.0); }
    default { return vec4f(0.0, 0.0, 25.0, 30.0); }
  }
}

// Time advanced per 1/60 s at speed 1, chosen so each system moves at a similar visual pace.
fn sa_rate(kind: i32) -> f32 {
  switch kind {
    case 1 { return 0.012; }
    case 2 { return 0.06; }
    case 3 { return 0.006; }
    case 4 { return 0.01; }
    default { return 0.012; }
  }
}

fn sa_rotate(s: vec3f, ang: f32, tilt: f32) -> vec3f {
  let ca = cos(ang); let sn = sin(ang);
  let ct = cos(tilt); let st = sin(tilt);
  let r = vec3f(s.x * ca + s.z * sn, s.y, -s.x * sn + s.z * ca);
  return vec3f(r.x, r.y * ct - r.z * st, r.y * st + r.z * ct);
}

fn sa_unrotate(s: vec3f, ang: f32, tilt: f32) -> vec3f {
  let ca = cos(ang); let sn = sin(ang);
  let ct = cos(tilt); let st = sin(tilt);
  let r = vec3f(s.x, s.y * ct + s.z * st, -s.y * st + s.z * ct);
  return vec3f(r.x * ca - r.z * sn, r.y, r.x * sn + r.z * ca);
}

fn update(p: Particle, i: u32) -> Particle {
  let P = plane.params;
  let kind = i32(P.kind + 0.5);
  let frame = sa_frame(kind);

  // Sheet position back to the system's own coordinates. The sheet's y axis
  // is the system's z axis, the classic view for these attractors.
  let s = sa_unrotate(vec3f(p.pos / P.size, p.vel.x), p.vel.y, P.tilt);
  var a = s.xzy * frame.w + frame.xyz;

  let h = sa_rate(kind) * P.speed * globals.dt * 30.0;
  for (var k = 0; k < 2; k++) {
    let mid = a + sa_deriv(kind, a) * (h * 0.5);
    a += sa_deriv(kind, mid) * h;
  }

  // Escaped (or NaN) points and the optional reseed trickle restart near the centre.
  let off = a - frame.xyz;
  if (!(dot(off, off) < 6.0 * frame.w * frame.w) || rand(i, 4) < P.reseed * globals.dt) {
    a = frame.xyz + (vec3f(rand(i, 1), rand(i, 2), rand(i, 3)) - 0.5) * frame.w * 0.25;
  }

  let ang = fract(globals.time * P.tumble / 6.2831853) * 6.2831853;
  let r = sa_rotate(((a - frame.xyz) / frame.w).xzy, ang, P.tilt);

  var o: Particle;
  o.pos = r.xy * P.size;
  o.vel = vec2f(r.z, ang);
  return o;
}
`,
});
