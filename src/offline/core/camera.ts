/**
 * Deterministic camera path: keyframed orbit poses, smooth in between.
 *
 * Each channel (target xyz, yaw, pitch, log distance, fov) is a monotone cubic
 * Hermite spline (Fritsch-Carlson tangents). It never overshoots a key, so a
 * dive that ends just above a sheet cannot punch through it. Distance is
 * interpolated in log space so a zoom across many orders of magnitude moves
 * at an even perceived speed. The path starts and ends at rest.
 */
import type { CameraKey } from "./job";

function tangents(ts: number[], ys: number[]): number[] {
  const n = ts.length;
  const m = new Array<number>(n).fill(0);
  if (n < 3) return m; // two keys: ease in, ease out
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (ts[i + 1] - ts[i]));
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      // Weighted harmonic mean keeps the spline monotone between keys.
      const h0 = ts[i] - ts[i - 1];
      const h1 = ts[i + 1] - ts[i];
      const w0 = 2 * h1 + h0;
      const w1 = h1 + 2 * h0;
      m[i] = (w0 + w1) / (w0 / d[i - 1] + w1 / d[i]);
    }
  }
  return m; // m[0] = m[n-1] = 0: at rest at both ends
}

function evalChannel(ts: number[], ys: number[], ms: number[], t: number): number {
  const n = ts.length;
  if (n === 1 || t <= ts[0]) return ys[0];
  if (t >= ts[n - 1]) return ys[n - 1];
  let i = 0;
  while (i < n - 2 && t > ts[i + 1]) i++;
  const h = ts[i + 1] - ts[i];
  const s = (t - ts[i]) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * ys[i] +
    (s3 - 2 * s2 + s) * h * ms[i] +
    (-2 * s3 + 3 * s2) * ys[i + 1] +
    (s3 - s2) * h * ms[i + 1]
  );
}

export class CameraPath {
  private readonly ts: number[];
  private readonly channels: { ys: number[]; ms: number[] }[];

  constructor(keys: CameraKey[]) {
    this.ts = keys.map((k) => k.t);
    const pick: ((k: CameraKey) => number)[] = [
      (k) => k.target[0],
      (k) => k.target[1],
      (k) => k.target[2],
      (k) => k.yaw,
      (k) => k.pitch,
      (k) => Math.log(k.distance),
      (k) => k.fovY,
    ];
    this.channels = pick.map((f) => {
      const ys = keys.map(f);
      return { ys, ms: tangents(this.ts, ys) };
    });
  }

  /** Pose at timeline position t in [0, 1]. */
  at(t: number): Omit<CameraKey, "t"> {
    const v = this.channels.map((c) => evalChannel(this.ts, c.ys, c.ms, t));
    return { target: [v[0], v[1], v[2]], yaw: v[3], pitch: v[4], distance: Math.exp(v[5]), fovY: v[6] };
  }

  /** Pose for a frame of a clip with `frames` frames. */
  atFrame(frame: number, frames: number): Omit<CameraKey, "t"> {
    return this.at(frames > 1 ? frame / (frames - 1) : 0);
  }
}
