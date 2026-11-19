// Minimal vector and matrix helpers for the experience layer.
// Column-major 4x4 matrices in Float32Array(16), matching WebGPU / gl-matrix
// conventions, with a clip-space depth range of 0..1 (WebGPU).
// No dependencies, so these modules stay standalone until the engine's own
// math is available.

import type { Mat4, Vec3 } from '../../core/contracts';

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const saturate = (x: number): number => clamp(x, 0, 1);

/** Hermite smoothstep on [e0, e1]. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Slow in, slow out. Used for every camera move so nothing ever snaps. */
export function easeInOutCubic(t: number): number {
  t = saturate(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  t = saturate(t);
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Frame-rate independent exponential approach.
 * `halfLife` is the time in seconds to cover half the remaining distance.
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target;
  return target + (current - target) * Math.pow(0.5, dt / halfLife);
}

/** Shortest signed angular difference b - a, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Any xyz triple. Results are always fresh `Vec3` tuples. */
type V = readonly number[];

export const v3 = {
  add: (a: V, b: V): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: V, b: V): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: V, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: V, b: V): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  length: (a: V): number => Math.hypot(a[0], a[1], a[2]),
  normalize(a: V): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  },
  lerp: (a: V, b: V, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)],
};

export const m4 = {
  identity(): Mat4 {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },

  /** Right-handed perspective, depth 0..1, looking down -Z. */
  perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovY / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = far / (near - far);
    m[11] = -1;
    m[14] = (near * far) / (near - far);
    return m;
  },

  lookAt(eye: V, target: V, up: V): Mat4 {
    const z = v3.normalize(v3.sub(eye, target));
    let x = v3.cross(up, z);
    // Looking straight along `up`: pick any stable perpendicular.
    if (v3.length(x) < 1e-6) x = v3.cross([0, 0, 1], z);
    if (v3.length(x) < 1e-6) x = [1, 0, 0];
    x = v3.normalize(x);
    const y = v3.cross(z, x);
    const m = new Float32Array(16);
    m[0] = x[0]; m[1] = y[0]; m[2] = z[0];
    m[4] = x[1]; m[5] = y[1]; m[6] = z[1];
    m[8] = x[2]; m[9] = y[2]; m[10] = z[2];
    m[12] = -v3.dot(x, eye);
    m[13] = -v3.dot(y, eye);
    m[14] = -v3.dot(z, eye);
    m[15] = 1;
    return m;
  },

  multiply(a: Mat4, b: Mat4): Mat4 {
    const m = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        m[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
    return m;
  },

  /** General inverse. Returns null for a singular matrix. */
  invert(a: Mat4): Mat4 | null {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1 / det;
    const m = new Float32Array(16);
    m[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    m[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    m[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    m[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    m[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    m[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    m[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    m[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    m[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    m[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    m[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    m[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    m[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    m[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    m[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    m[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return m;
  },

  /** Transform a point and apply the perspective divide. */
  transformPoint(m: Mat4, p: V): Vec3 {
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    ];
  },
};
