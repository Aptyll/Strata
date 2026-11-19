import { defineLaw } from './types';

/**
 * Ribbons: a square of particles folded by a Clifford map.
 *
 *   x' = sin(a y) + c cos(a x)
 *   y' = sin(b x) + d cos(b y)
 *
 * Iterated forever this map draws a strange attractor. Applied only two or
 * three times to a uniform square it does something better for a trillion
 * particles: it folds the square into translucent sheets with razor caustics
 * where they turn over, like silk ribbons. The parameters drift slowly, so the
 * ribbons slide, fold and unfold. Each particle keeps its place in the square,
 * so its motion is smooth (the map is smooth in a, b, c, d).
 *
 * q.xy is the place in the square. q.z spreads each particle's drift phase a
 * little, which gives the ribbons depth instead of a single hard sheet.
 *
 * Expensive: four transcendentals per iteration. Chaotic maps also stretch a
 * lot, so stratified walks along q.x spread on screen (see `cost.stretch`).
 */
export const ribbons = defineLaw({
  id: 'ribbons',
  title: 'Ribbons',
  summary:
    'A square of particles folded two or three times by a Clifford map: translucent silk ribbons with sharp ' +
    'caustic edges. The map parameters drift, so the ribbons slide and refold.',
  qFn: 'lawRibbonsQ',
  params: [
    { name: 'a', default: -1.7, min: -2.2, max: 2.2, note: 'map parameter a' },
    { name: 'b', default: 1.8, min: -2.2, max: 2.2, note: 'map parameter b' },
    { name: 'c', default: -1.9, min: -2.0, max: 2.0, note: 'map parameter c' },
    { name: 'd', default: -0.4, min: -2.0, max: 2.0, note: 'map parameter d' },
    { name: 'drift', default: 0.08, min: 0, max: 0.3, note: 'how far the parameters wander' },
    { name: 'speed', default: 0.25, min: 0, max: 2, note: 'drift speed, radians per second' },
    { name: 'folds', default: 2, min: 1, max: 4, integer: true, note: 'iterations: 2 silk, 3 finer, 4 near the attractor' },
    { name: 'depth', default: 0.35, min: 0, max: 2, note: 'spread of drift phase across particles' },
  ],
  cost: {
    transcendental: 10,
    fma: 22,
    stretch: 40,
    note: 'sin and cos for the drift, then 4 per fold (2 folds by default, +4 per extra fold)',
  },
  // q.z spreads the drift phase, and the map stretches that spread.
  coherent: false,
  wgsl: /* wgsl */ `
// Ribbons. p: [a, b, c, d, drift, speed, folds, depth]
fn lawRibbonsQ(q: vec3f, t: f32, p: array<f32, 8>) -> vec2f {
  // One drift phase per sheet, spread a little per particle by q.z.
  let ph = p[5] * t + 3.1 * p[0] + 1.7 * p[1] + p[7] * (q.z - 0.5);
  let s = sin(ph);
  let k = cos(ph);
  let a = p[0] + p[4] * s;
  let b = p[1] + p[4] * k;
  let c = p[2] + 0.5 * p[4] * k;
  let d = p[3] - 0.5 * p[4] * s;
  var x = 4.0 * q.x - 2.0;
  var y = 4.0 * q.y - 2.0;
  let n = u32(clamp(p[6] + 0.5, 1.0, 4.0));
  for (var i = 0u; i < n; i++) {
    let nx = sin(a * y) + c * cos(a * x);
    let ny = sin(b * x) + d * cos(b * y);
    x = nx;
    y = ny;
  }
  // |sin + c cos| <= 1 + |c| and |c| <= |p2| + p4 / 2, so this stays on the
  // sheet. The bounds use params only (no per-particle division).
  return 0.95 * vec2f(x, y) / vec2f(1.0 + abs(p[2]) + 0.5 * p[4], 1.0 + abs(p[3]) + 0.5 * p[4]);
}
`,
  mirror(q, t, p) {
    const ph = p[5] * t + 3.1 * p[0] + 1.7 * p[1] + p[7] * (q[2] - 0.5);
    const s = Math.sin(ph);
    const k = Math.cos(ph);
    const a = p[0] + p[4] * s;
    const b = p[1] + p[4] * k;
    const c = p[2] + 0.5 * p[4] * k;
    const d = p[3] - 0.5 * p[4] * s;
    let x = 4 * q[0] - 2;
    let y = 4 * q[1] - 2;
    const n = Math.trunc(Math.min(Math.max(p[6] + 0.5, 1), 4));
    for (let i = 0; i < n; i++) {
      const nx = Math.sin(a * y) + c * Math.cos(a * x);
      const ny = Math.sin(b * x) + d * Math.cos(b * y);
      x = nx;
      y = ny;
    }
    return [(0.95 * x) / (1 + Math.abs(p[2]) + 0.5 * p[4]), (0.95 * y) / (1 + Math.abs(p[3]) + 0.5 * p[4])];
  },
});
