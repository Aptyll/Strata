/**
 * Minimal column-major mat4 helpers (WebGPU clip space, z in [0, 1]).
 * Kept dependency-free so src/perf can be used standalone.
 */

export type Mat4 = Float32Array;

export function mat4Identity(out: Mat4 = new Float32Array(16)): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** out = a * b (column-major). `out` may not alias `a` or `b`. */
export function mat4Multiply(out: Mat4, a: ArrayLike<number>, b: ArrayLike<number>): Mat4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/** Right-handed perspective, depth 0..1. */
export function mat4Perspective(out: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (near * far) / (near - far);
  return out;
}

export function mat4LookAt(out: Mat4, eye: ArrayLike<number>, target: ArrayLike<number>, up: ArrayLike<number>): Mat4 {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

/**
 * Model matrix for a "paper" plane: unit square in local XY (z = 0), scaled to
 * `size`, rotated by Euler angles (X then Y then Z) and moved to `position`.
 */
export function mat4PlaneModel(
  out: Mat4,
  position: ArrayLike<number>,
  size: number | [number, number],
  rotX = 0,
  rotY = 0,
  rotZ = 0,
): Mat4 {
  const sx = typeof size === 'number' ? size : size[0];
  const sy = typeof size === 'number' ? size : size[1];
  const cx = Math.cos(rotX), sxr = Math.sin(rotX);
  const cy = Math.cos(rotY), syr = Math.sin(rotY);
  const cz = Math.cos(rotZ), szr = Math.sin(rotZ);
  // R = Rz * Ry * Rx
  const r00 = cz * cy, r01 = cz * syr * sxr - szr * cx, r02 = cz * syr * cx + szr * sxr;
  const r10 = szr * cy, r11 = szr * syr * sxr + cz * cx, r12 = szr * syr * cx - cz * sxr;
  const r20 = -syr, r21 = cy * sxr, r22 = cy * cx;
  out[0] = r00 * sx; out[1] = r10 * sx; out[2] = r20 * sx; out[3] = 0;
  out[4] = r01 * sy; out[5] = r11 * sy; out[6] = r21 * sy; out[7] = 0;
  out[8] = r02; out[9] = r12; out[10] = r22; out[11] = 0;
  out[12] = position[0]; out[13] = position[1]; out[14] = position[2]; out[15] = 1;
  return out;
}
