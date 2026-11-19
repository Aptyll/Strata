/**
 * Minimal math for the camera rig. No dependencies.
 *
 * Conventions (match WebGPU defaults):
 * - Right-handed world, +Y up, camera looks down its local -Z.
 * - Matrices are column-major Float32Array(16), clip-space depth in [0, 1].
 * - Quaternions are [x, y, z, w].
 */

import type { Mat4, Quat, Vec3 } from "../../core/contracts";

export type { Mat4, Quat, Vec3 };

// ---------- scalars ----------

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Frame-rate independent smoothing factor. Use as `x = lerp(x, goal, damp(dt, tau))`.
 * `tau` is the time constant in seconds (63% of the way there after one tau).
 */
export const damp = (dt: number, tau: number): number =>
  tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);

export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

export const easeInOutCubic = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

// ---------- vec3 ----------

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const v3copy = (a: Vec3): Vec3 => [a[0], a[1], a[2]];
export const v3add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const v3sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const v3scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const v3addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [
  a[0] + b[0] * s,
  a[1] + b[1] * s,
  a[2] + b[2] * s,
];
export const v3dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const v3cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const v3len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const v3dist = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const v3normalize = (a: Vec3, fallback: Vec3 = [0, 0, 1]): Vec3 => {
  const l = v3len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : v3copy(fallback);
};
export const v3lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// ---------- quaternion ----------

export const quatIdentity = (): Quat => [0, 0, 0, 1];
export const quatCopy = (q: Quat): Quat => [q[0], q[1], q[2], q[3]];

export const quatNormalize = (q: Quat): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
};

export const quatFromAxisAngle = (axis: Vec3, angle: number): Quat => {
  const h = angle * 0.5;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
};

/** Hamilton product: applying the result rotates by `b` first, then `a`. */
export const quatMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

export const quatRotate = (q: Quat, v: Vec3): Vec3 => {
  const [x, y, z, w] = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  // v + w * t + cross(q.xyz, t)
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
};

/** Shortest-path spherical interpolation. */
export const quatSlerp = (a: Quat, b: Quat, t: number): Quat => {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let sa: number;
  let sb: number;
  if (cos > 0.9995) {
    sa = 1 - t;
    sb = t;
  } else {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    sa = Math.sin((1 - t) * theta) / sin;
    sb = Math.sin(t * theta) / sin;
  }
  return quatNormalize([
    a[0] * sa + bx * sb,
    a[1] * sa + by * sb,
    a[2] * sa + bz * sb,
    a[3] * sa + bw * sb,
  ]);
};

/** Angle in radians between two orientations (0..PI). */
export const quatAngle = (a: Quat, b: Quat): number => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(clamp(d, -1, 1));
};

/**
 * Quaternion from an orthonormal basis: `right` = local +X, `up` = local +Y,
 * `back` = local +Z (the camera looks along -back).
 */
export const quatFromBasis = (right: Vec3, up: Vec3, back: Vec3): Quat => {
  const m00 = right[0];
  const m10 = right[1];
  const m20 = right[2];
  const m01 = up[0];
  const m11 = up[1];
  const m21 = up[2];
  const m02 = back[0];
  const m12 = back[1];
  const m22 = back[2];
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return quatNormalize(q);
};

/**
 * Orientation that looks along `forward` with `upHint` as close to screen-up
 * as possible. Falls back to another axis if the two are parallel.
 */
export const quatLook = (forward: Vec3, upHint: Vec3 = [0, 1, 0]): Quat => {
  const back = v3normalize(v3scale(forward, -1));
  let right = v3cross(upHint, back);
  if (v3len(right) < 1e-5) {
    right = v3cross(Math.abs(back[1]) < 0.9 ? [0, 1, 0] : [0, 0, -1], back);
  }
  right = v3normalize(right, [1, 0, 0]);
  const up = v3cross(back, right);
  return quatFromBasis(right, up, back);
};

// ---------- mat4 ----------

export const mat4 = (): Mat4 => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

/** View matrix (world to camera) from eye position and camera orientation. */
export const mat4View = (out: Mat4, eye: Vec3, q: Quat): Mat4 => {
  const r = quatRotate(q, [1, 0, 0]);
  const u = quatRotate(q, [0, 1, 0]);
  const b = quatRotate(q, [0, 0, 1]);
  out[0] = r[0];
  out[1] = u[0];
  out[2] = b[0];
  out[3] = 0;
  out[4] = r[1];
  out[5] = u[1];
  out[6] = b[1];
  out[7] = 0;
  out[8] = r[2];
  out[9] = u[2];
  out[10] = b[2];
  out[11] = 0;
  out[12] = -v3dot(r, eye);
  out[13] = -v3dot(u, eye);
  out[14] = -v3dot(b, eye);
  out[15] = 1;
  return out;
};

/**
 * Perspective projection for WebGPU clip space (depth 0..1, right-handed).
 * `far` may be Infinity. With `reverseZ`, near maps to 1 and far to 0, which
 * keeps depth precision usable across a very large world (clear depth to 0
 * and use a `greater` depth compare).
 */
export const mat4Perspective = (
  out: Mat4,
  fovY: number,
  aspect: number,
  near: number,
  far: number,
  reverseZ = false,
): Mat4 => {
  const f = 1 / Math.tan(fovY * 0.5);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  if (reverseZ) {
    if (Number.isFinite(far)) {
      out[10] = near / (far - near);
      out[14] = (near * far) / (far - near);
    } else {
      out[10] = 0;
      out[14] = near;
    }
  } else if (Number.isFinite(far)) {
    out[10] = far / (near - far);
    out[14] = (near * far) / (near - far);
  } else {
    out[10] = -1;
    out[14] = -near;
  }
  return out;
};

/** out = a * b (column-major). `out` may alias neither input. */
export const mat4Mul = (out: Mat4, a: Mat4, b: Mat4): Mat4 => {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
};

/** Transform a point by a matrix and perspective-divide. Handy for tests. */
export const mat4TransformPoint = (m: Mat4, p: Vec3): Vec3 => {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w];
};
