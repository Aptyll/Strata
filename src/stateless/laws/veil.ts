import { clamp, defineLaw } from './types';

/**
 * Veil: a sheet of particles rippling in 3D, seen from an angle.
 *
 * The particles fill a flat lens-shaped sheet. Three travelling waves lift it
 * into a height field, and the sheet is tilted toward the viewer and
 * flattened onto the plane. Where the tilted sheet turns edge-on, it folds
 * over itself in projection and the density spikes into bright fold lines
 * that run along the veil as the waves travel, like an aurora curtain or silk
 * in wind. Nothing is random but the particle's place on the sheet, so the
 * motion is perfectly smooth.
 *
 * q.x runs along the veil, q.y across it. q.z is not used.
 */
export const veil = defineLaw({
  id: 'veil',
  title: 'Veil',
  summary:
    'A rippling sheet seen at an angle, like an aurora curtain or silk in wind. Bright fold lines appear where the ' +
    'sheet turns edge-on and travel along it with the waves.',
  qFn: 'lawVeilQ',
  params: [
    { name: 'tilt', default: 0.82, min: 0, max: 0.98, note: 'sine of the viewing tilt: 0 face-on, 1 edge-on' },
    { name: 'height', default: 0.32, min: 0, max: 0.6, note: 'wave height; more height, more folds' },
    { name: 'speed', default: 0.6, min: 0, max: 3, note: 'wave speed' },
    { name: 'scale', default: 3.0, min: 1, max: 8, note: 'wave number: small is broad swells, large is fine ripples' },
    { name: 'bend', default: 0.22, min: -0.5, max: 0.5, note: 'curves the veil into an arc' },
    { name: 'taper', default: 0.85, min: 0, max: 0.95, note: 'narrows the ends into a lens' },
    { name: 'sway', default: 0.08, min: 0, max: 0.3, note: 'slow rocking, as a fraction of a radian' },
    { name: 'seed', default: 0, min: 0, max: 1000, note: 'per-sheet variant: wave phases' },
  ],
  cost: {
    transcendental: 4,
    fma: 32,
    stretch: 3,
    note: 'three wave sines and one sine for the sway (the tilt sqrt and the fit scale use params only)',
  },
  coherent: true,
  wgsl: /* wgsl */ `
// Veil. p: [tilt, height, speed, scale, bend, taper, sway, seed]
fn lawVeilQ(q: vec3f, t: f32, p: array<f32, 8>) -> vec2f {
  let u = 2.0 * q.x - 1.0;
  let v = 2.0 * q.y - 1.0;
  let st = clamp(p[0], 0.0, 0.98);
  let ct = sqrt(1.0 - st * st);
  let k = p[3];
  let w = p[2] * t;
  let ph = p[7];
  // Height field: three travelling waves.
  let h = p[1] * (0.55 * sin(k * (1.7 * u + 0.6 * v) - 1.3 * w + ph)
                + 0.35 * sin(k * (-1.1 * u + 2.9 * v) - 0.9 * w + 2.0 * ph)
                + 0.25 * sin(k * (3.5 * u - 1.6 * v) - 1.9 * w + 3.0 * ph));
  // Tilt the sheet and flatten it: y mixes across-position and height.
  let half = 0.5 * (1.0 - p[5] * u * u);
  let x = 0.92 * u;
  let y = half * v * ct - h * st + p[4] * (u * u - 0.33);
  // Slow sway, a small rotation.
  let g = p[6] * sin(0.37 * w + 1.3 * ph);
  // Fit: the largest |x| and |y| any params allow, so nothing leaves the sheet.
  let ymax = 0.5 * ct + 1.15 * p[1] * st + 0.67 * abs(p[4]);
  let fit = 0.97 / max(0.92 + p[6] * ymax, ymax + p[6] * 0.92);
  return fit * vec2f(x - g * y, y + g * x);
}
`,
  mirror(q, t, p) {
    const u = 2 * q[0] - 1;
    const v = 2 * q[1] - 1;
    const st = clamp(p[0], 0, 0.98);
    const ct = Math.sqrt(1 - st * st);
    const k = p[3];
    const w = p[2] * t;
    const ph = p[7];
    const h =
      p[1] *
      (0.55 * Math.sin(k * (1.7 * u + 0.6 * v) - 1.3 * w + ph) +
        0.35 * Math.sin(k * (-1.1 * u + 2.9 * v) - 0.9 * w + 2 * ph) +
        0.25 * Math.sin(k * (3.5 * u - 1.6 * v) - 1.9 * w + 3 * ph));
    const half = 0.5 * (1 - p[5] * u * u);
    const x = 0.92 * u;
    const y = half * v * ct - h * st + p[4] * (u * u - 0.33);
    const g = p[6] * Math.sin(0.37 * w + 1.3 * ph);
    const ymax = 0.5 * ct + 1.15 * p[1] * st + 0.67 * Math.abs(p[4]);
    const fit = 0.97 / Math.max(0.92 + p[6] * ymax, ymax + p[6] * 0.92);
    return [fit * (x - g * y), fit * (y + g * x)];
  },
});
