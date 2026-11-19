/**
 * Double-precision math for the offline renderer.
 *
 * Conventions match src/ux/camera: right-handed world, +Y up, the camera looks
 * down its local -Z, orientation = yaw about +Y then pitch about local +X,
 * quaternions are xyzw. Sheets lie in their local XY plane.
 */
import type { Quat, Vec2, Vec3 } from "../../core/contracts";
import type { CameraKey } from "./job";

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // v + 2w(q x v) + 2 q x (q x v)
  const cx = y * v[2] - z * v[1];
  const cy = z * v[0] - x * v[2];
  const cz = x * v[1] - y * v[0];
  const dx = y * cz - z * cy;
  const dy = z * cx - x * cz;
  const dz = x * cy - y * cx;
  return [v[0] + 2 * (w * cx + dx), v[1] + 2 * (w * cy + dy), v[2] + 2 * (w * cz + dz)];
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(angle / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Camera frame for one pose: where the eye is and which way it looks. */
export interface CameraBasis {
  eye: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  fovY: number;
}

export function cameraBasis(pose: Omit<CameraKey, "t">): CameraBasis {
  const q = quatMul(quatFromAxisAngle([0, 1, 0], pose.yaw), quatFromAxisAngle([1, 0, 0], pose.pitch));
  const forward = quatRotate(q, [0, 0, -1]);
  return {
    eye: sub(pose.target, scale(forward, pose.distance)),
    right: quatRotate(q, [1, 0, 0]),
    up: quatRotate(q, [0, 1, 0]),
    forward,
    fovY: pose.fovY,
  };
}

/**
 * Homography from sheet-local (x, y) to accumulation-grid pixels.
 *
 * Returns three columns c0, c1, c2 (9 numbers) such that
 *   (px * depth, py * depth, depth) = c0 * x + c1 * y + c2
 * where depth is the distance along the view axis in world units, px runs
 * left to right and py top to bottom, both in grid pixels (pixel centers at
 * half integers). Composed in doubles, the GPU gets it rounded to f32.
 */
export function planeHomography(
  cam: CameraBasis,
  plane: { position: Vec3; rotation: Quat; halfSize: Vec2 },
  gridWidth: number,
  gridHeight: number,
): number[] {
  const q = quatNormalize(plane.rotation);
  const ax = scale(quatRotate(q, [1, 0, 0]), plane.halfSize[0]);
  const ay = scale(quatRotate(q, [0, 1, 0]), plane.halfSize[1]);
  const c = sub(plane.position, cam.eye);
  // Square pixels: one focal length for both axes, in grid pixels.
  const focal = (0.5 * gridHeight) / Math.tan(cam.fovY / 2);
  const col = (v: Vec3): [number, number, number] => {
    const depth = dot(cam.forward, v);
    return [
      focal * dot(cam.right, v) + 0.5 * gridWidth * depth,
      -focal * dot(cam.up, v) + 0.5 * gridHeight * depth,
      depth,
    ];
  };
  return [...col(ax), ...col(ay), ...col(c)];
}
