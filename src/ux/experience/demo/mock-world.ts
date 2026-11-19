// A stand-in for the WebGPU engine, so the experience can be felt today.
//
// A few dozen planes of CPU particles drawn into a Canvas 2D ImageData. It
// consumes exactly the frame data the real engine will (viewProj, exposure,
// planeGain, heroBloom, brushes), which makes it a working example of the
// contract as well as a demo. It is not meant to be fast or pretty.

import type { Plane } from '../camera-rig';
import { brushForce } from '../force-brush';
import type { ExperienceFrame } from '../index';

type Field = (x: number, y: number, t: number) => [number, number];
interface LiveBrush { u: number; v: number; radius: number; strength: number; plane: number }

// Each plane gets one of these flow fields, so turning the camera or diving
// through the stack keeps showing something different.
const BEHAVIOURS: Field[] = [
  // slow curl
  (x, y, t) => [
    Math.sin(y * 3.1 + t) + 0.6 * Math.sin(y * 7.3 - t * 1.7 + x * 2),
    -Math.sin(x * 2.7 - t * 0.8) - 0.6 * Math.sin(x * 6.1 + t * 1.3 + y * 2),
  ],
  // vortex with a breathing core
  (x, y, t) => {
    const r2 = x * x + y * y + 0.05;
    const pull = 0.35 * Math.sin(t * 0.9) - (r2 > 0.8 ? 1.2 : 0);
    return [-y / r2 * 0.35 + x * pull, x / r2 * 0.35 + y * pull];
  },
  // standing waves: particles gather on nodal lines
  (x, y, t) => [
    -Math.sin(x * 9.4) * Math.cos(y * 6.3) * (1.2 + Math.sin(t * 0.7)),
    -Math.cos(x * 9.4) * Math.sin(y * 6.3) * (1.2 + Math.sin(t * 0.7)),
  ],
  // shear bands sliding past each other
  (x, y, t) => [Math.sign(Math.sin(y * 8 + t * 0.3)) * 0.9, Math.sin(x * 5 + t) * 0.25],
  // twin attractors trading places
  (x, y, t) => {
    const cx = Math.cos(t * 0.5) * 0.5, cy = Math.sin(t * 0.5) * 0.5;
    const ax = cx - x, ay = cy - y, bx = -cx - x, by = -cy - y;
    const a = 1 / (ax * ax + ay * ay + 0.08), b = 1 / (bx * bx + by * by + 0.08);
    return [(ax * a + bx * b - ay * a + by * b) * 0.12, (ay * a + by * b + ax * a - bx * b) * 0.12];
  },
];

export function createMockWorld(planes: Plane[], perPlane: number) {
  const n = planes.length * perPlane;
  const px = new Float32Array(n), py = new Float32Array(n);
  const vx = new Float32Array(n), vy = new Float32Array(n);
  const birth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = Math.random() * 2 - 1;
    py[i] = Math.random() * 2 - 1;
    birth[i] = Math.hypot(px[i], py[i]) / 1.5;
  }
  let time = 0;

  /** Advance the particles. `brushes` is the packed Float32Array from the experience. */
  function step(dt: number, brushes: Float32Array): void {
    time += dt;
    const live: LiveBrush[] = [];
    for (let k = 0; k < brushes.length; k += 8) {
      if (brushes[k + 6] >= 0) {
        live.push({ u: brushes[k], v: brushes[k + 1], radius: brushes[k + 2],
          strength: brushes[k + 3], plane: brushes[k + 6] });
      }
    }
    const drag = Math.pow(0.5, dt / 0.7);
    for (let p = 0; p < planes.length; p++) {
      const field = BEHAVIOURS[p % BEHAVIOURS.length];
      const t = time * 0.25 + p * 1.7;
      const mine = live.filter((b) => b.plane === p);
      const base = p * perPlane;
      for (let j = 0; j < perPlane; j++) {
        const i = base + j;
        let x = px[i], y = py[i];
        const f = field(x, y, t);
        for (const b of mine) {
          const a = brushForce(x, y, b, 1.4);
          vx[i] += a[0] * dt;
          vy[i] += a[1] * dt;
        }
        vx[i] *= drag;
        vy[i] *= drag;
        x += (f[0] * 0.05 + vx[i]) * dt;
        y += (f[1] * 0.05 + vy[i]) * dt;
        if (x > 1) x -= 2; else if (x < -1) x += 2;
        if (y > 1) y -= 2; else if (y < -1) y += 2;
        px[i] = x;
        py[i] = y;
      }
    }
  }

  /** Draw one frame into `image` from the experience layer's frame data. */
  function draw(image: ImageData, f: ExperienceFrame, heroIndex: number): void {
    const { width: w, height: h, data } = image;
    new Uint32Array(data.buffer).fill(0xff000000);
    const m = f.viewProj;
    for (let p = 0; p < planes.length; p++) {
      let gain = f.planeGain[p] * f.exposure;
      if (gain <= 0.003) continue;
      // The sheet under the cursor answers with a little more light.
      if (p === f.hoverPlane) gain *= 1.25;
      if (p === f.focusedPlane) gain *= 1 + f.focusGlow;
      const add = gain * 120;
      const pl = planes[p];
      const [cx, cy, cz] = pl.center;
      const ux = pl.u[0] * pl.halfSize[0], uy = pl.u[1] * pl.halfSize[0], uz = pl.u[2] * pl.halfSize[0];
      const wx = pl.v[0] * pl.halfSize[1], wy = pl.v[1] * pl.halfSize[1], wz = pl.v[2] * pl.halfSize[1];
      const bloom = p === heroIndex ? f.heroBloom : 2;
      const base = p * perPlane;
      for (let j = 0; j < perPlane; j++) {
        const i = base + j;
        if (birth[i] > bloom) continue;
        const X = cx + ux * px[i] + wx * py[i];
        const Y = cy + uy * px[i] + wy * py[i];
        const Z = cz + uz * px[i] + wz * py[i];
        const cw = m[3] * X + m[7] * Y + m[11] * Z + m[15];
        if (cw <= 0.01) continue;
        const sx = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / cw * 0.5 + 0.5) * w | 0;
        const sy = (0.5 - (m[1] * X + m[5] * Y + m[9] * Z + m[13]) / cw * 0.5) * h | 0;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const o = (sy * w + sx) << 2;
        const c = data[o] + add;
        data[o] = c; data[o + 1] = c; data[o + 2] = c;
      }
    }
    // The first particle: alone at the centre until the bloom swallows it.
    const spark = f.sparkAlpha * (1 - Math.min(1, f.heroBloom * 6));
    if (spark > 0) {
      const c = 255 * spark;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const o = (((h >> 1) + dy) * w + (w >> 1) + dx) << 2;
        data[o] = data[o + 1] = data[o + 2] = Math.max(data[o], c);
      }
    }
  }

  return { step, draw, count: n };
}
