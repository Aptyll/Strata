import { defineLaw } from './types';

/**
 * Web: the cosmic web, by the Zel'dovich approximation.
 *
 * Every particle starts on a uniform grid point q and moves along the gradient
 * of a smooth potential: x = q + D grad psi(q). This is the first-order
 * solution for matter collapsing under gravity in an expanding universe.
 * Where the flow converges, particles cross each other's paths and pile up in
 * caustics: thin bright walls and knots around emptying voids. Two scales are
 * stacked, the fine one carried by the coarse one, so big cells hold smaller
 * filaments. Mode phases drift, so the web slowly reconfigures.
 *
 * Wavevectors are whole multiples of pi, so the pattern tiles the sheet and
 * particles wrap at the edges without a seam. q.z is not used.
 */

// Three coarse and three fine modes: integer wavevectors n (k = pi n), about
// 120 degrees apart, and a drift speed per mode.
const COARSE = [
  [2, 1, 1.5],
  [-2, 2, -1.68],
  [1, -3, 1.78],
] as const;
const FINE = [
  [5, 2, -2.32],
  [-3, 5, 2.41],
  [-2, -5, -2.32],
] as const;
// Per-sheet phase offsets: seed times these.
const PHASE = [1.0, 2.6180339887, 4.2360679775, 1.6180339887, 3.1415926536, 5.0990195136];

function modeWgsl(level: 'x0' | 'x1', [nx, ny, w]: readonly [number, number, number], strain: string, i: number): string {
  const c = (1 / (3 * Math.PI * (nx * nx + ny * ny))).toPrecision(9);
  return `  d = d + st_webWave(${level}, vec2f(${nx.toFixed(1)}, ${ny.toFixed(1)}), ${strain} * ${c}, ${w.toFixed(2)} * w + ${PHASE[i].toFixed(10)} * seed);`;
}

export const web = defineLaw({
  id: 'web',
  title: 'Cosmic web',
  summary:
    'Matter collapsing into walls, filaments and knots around emptying voids, by the Zel\'dovich approximation. ' +
    'Two scales nest, and the web slowly reconfigures.',
  qFn: 'lawWebQ',
  params: [
    { name: 'collapse', default: 2.6, min: 0, max: 5, note: 'coarse strain: above 1 particles cross and caustics form' },
    { name: 'detail', default: 1.2, min: 0, max: 3, note: 'fine strain: filaments inside the cells' },
    { name: 'speed', default: 0.08, min: 0, max: 1, note: 'how fast the web reconfigures' },
    { name: 'flip', default: 0, min: 0, max: 3, integer: true, note: 'orientation: 0..3 mirror and swap the axes' },
    { name: 'unused4', default: 0, min: 0, max: 0, note: 'reserved' },
    { name: 'unused5', default: 0, min: 0, max: 0, note: 'reserved' },
    { name: 'unused6', default: 0, min: 0, max: 0, note: 'reserved' },
    { name: 'seed', default: 0, min: 0, max: 1000, note: 'per-sheet variant: mode phases' },
  ],
  cost: {
    transcendental: 8,
    fma: 44,
    stretch: 4,
    note: 'one sin per mode (6), two rounds to wrap onto the sheet',
  },
  // q.z is not used; patches that straddle the wrap seam split in two.
  coherent: true,
  wgsl: /* wgsl */ `
// Zel'dovich displacement of one potential mode: -c n sin(pi n.x + phase).
fn st_webWave(x: vec2f, n: vec2f, c: f32, phase: f32) -> vec2f {
  return n * (-c * sin(3.14159265 * dot(n, x) + phase));
}

// Cosmic web. p: [collapse, detail, speed, flip, -, -, -, seed]
fn lawWebQ(q: vec3f, t: f32, p: array<f32, 8>) -> vec2f {
  let seed = p[7];
  let w = p[2] * t;
  // Orientation variant: mirror x (bit 0) and swap axes (bit 1).
  let flip = u32(clamp(p[3] + 0.5, 0.0, 3.0));
  let sx = select(1.0, -1.0, (flip & 1u) != 0u);
  let sw = (flip & 2u) != 0u;
  var x0 = vec2f(q.x, q.y) * 2.0 - 1.0;
  x0 = select(x0, x0.yx, sw) * vec2f(sx, 1.0);
  // Coarse level, evaluated at the start point.
  var d = vec2f(0.0);
${COARSE.map((m, i) => modeWgsl('x0', m, 'p[0]', i)).join('\n')}
  let x1 = x0 + d;
  // Fine level, evaluated where the coarse flow has carried the particle.
  d = vec2f(0.0);
${FINE.map((m, i) => modeWgsl('x1', m, 'p[1]', i + 3)).join('\n')}
  var x = (x1 + d) * vec2f(sx, 1.0);
  x = select(x, x.yx, sw);
  // The pattern has period 2: wrap onto [-1, 1].
  return x - 2.0 * round(0.5 * x);
}
`,
  mirror(q, t, p) {
    const seed = p[7];
    const w = p[2] * t;
    const flip = Math.trunc(Math.min(Math.max(p[3] + 0.5, 0), 3));
    const sx = flip & 1 ? -1 : 1;
    const sw = (flip & 2) !== 0;
    let ax = 2 * q[0] - 1;
    let ay = 2 * q[1] - 1;
    if (sw) [ax, ay] = [ay, ax];
    ax *= sx;
    const wave = (x: number, y: number, [nx, ny, sp]: readonly [number, number, number], strain: number, i: number) => {
      const c = strain / (3 * Math.PI * (nx * nx + ny * ny));
      const s = -c * Math.sin(3.14159265 * (nx * x + ny * y) + sp * w + PHASE[i] * seed);
      return [nx * s, ny * s];
    };
    let dx = 0;
    let dy = 0;
    COARSE.forEach((m, i) => {
      const [u, v] = wave(ax, ay, m, p[0], i);
      dx += u;
      dy += v;
    });
    const bx = ax + dx;
    const by = ay + dy;
    dx = 0;
    dy = 0;
    FINE.forEach((m, i) => {
      const [u, v] = wave(bx, by, m, p[1], i + 3);
      dx += u;
      dy += v;
    });
    let x = (bx + dx) * sx;
    let y = by + dy;
    if (sw) [x, y] = [y, x];
    return [x - 2 * Math.round(0.5 * x), y - 2 * Math.round(0.5 * y)];
  },
});
