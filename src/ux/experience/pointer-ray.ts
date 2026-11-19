// Turning a cursor position into a point on a plane.
//
// The cursor is a ray from the camera. Each plane is an infinite sheet with a
// bounded rectangle on it. We intersect, convert the hit to the plane's own
// 2D coordinates, and hand the simulation a (plane, u, v) triple. The
// simulation never needs to know about the camera.

import type { Mat4, Vec3 } from '../../core/contracts';
import type { Plane } from './camera-rig';
import { m4, smoothstep, v3 } from './math';

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

export interface PlaneHit {
  /** Which plane. */
  index: number;
  /** Distance along the ray. */
  t: number;
  /** -1..1 across the sheet's width. */
  u: number;
  /** -1..1 across the sheet's height. */
  v: number;
  /** World-space hit position. */
  point: Vec3;
  /** |cos| of the angle between ray and normal. */
  facing: number;
  /** 0..1, how trustworthy the hit is (0 when the sheet is edge-on). */
  grip: number;
}

export interface PickOptions {
  /** Only consider this plane. */
  focused?: number;
  /** Extra reach past the sheet's edge, in plane units. */
  margin?: number;
  /** Skip planes that are not lit yet. */
  visible?: (index: number) => boolean;
}

/** A screen rectangle, as from getBoundingClientRect(). */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * @param ndcX -1 (left) .. 1 (right)
 * @param ndcY -1 (bottom) .. 1 (top)
 */
export function screenToRay(ndcX: number, ndcY: number, invViewProj: Mat4): Ray {
  const near = m4.transformPoint(invViewProj, [ndcX, ndcY, 0]);
  const far = m4.transformPoint(invViewProj, [ndcX, ndcY, 1]);
  return { origin: near, dir: v3.normalize(v3.sub(far, near)) };
}

/** Client pixel coordinates to normalised device coordinates. */
export function clientToNdc(clientX: number, clientY: number, rect: ScreenRect): [number, number] {
  return [
    ((clientX - rect.left) / rect.width) * 2 - 1,
    1 - ((clientY - rect.top) / rect.height) * 2,
  ];
}

/** Returns null when the ray is parallel to the sheet or the hit is behind the camera. */
export function intersectPlane(ray: Ray, plane: Plane, index = 0): PlaneHit | null {
  const denom = v3.dot(ray.dir, plane.normal);
  if (Math.abs(denom) < 1e-6) return null;
  const t = v3.dot(v3.sub(plane.center, ray.origin), plane.normal) / denom;
  if (t <= 0) return null;
  const point = v3.add(ray.origin, v3.scale(ray.dir, t));
  const rel = v3.sub(point, plane.center);
  const facing = Math.abs(denom);
  return {
    index,
    t,
    u: v3.dot(rel, plane.u) / plane.halfSize[0],
    v: v3.dot(rel, plane.v) / plane.halfSize[1],
    point,
    facing,
    // Seen nearly edge-on, one pixel of cursor travel becomes a huge sweep
    // across the sheet. Fade interaction out rather than let it whip around.
    grip: smoothstep(0.06, 0.3, facing),
  };
}

/**
 * Choose the plane the cursor is touching.
 *
 * With a focused plane, only that plane is considered and the hit may fall
 * slightly outside its edge, so a force can be dragged off the sheet without
 * jumping to whatever is behind it. Otherwise the nearest sheet the ray
 * passes through wins.
 */
export function pickPlane(ray: Ray, planes: ReadonlyArray<Plane>, opts: PickOptions = {}): PlaneHit | null {
  const margin = opts.margin ?? 0;
  const focused = opts.focused ?? -1;
  if (focused >= 0 && focused < planes.length) {
    const hit = intersectPlane(ray, planes[focused], focused);
    if (hit && hit.grip > 0 && Math.abs(hit.u) <= 1.25 && Math.abs(hit.v) <= 1.25) return hit;
    return null;
  }
  let best: PlaneHit | null = null;
  for (let i = 0; i < planes.length; i++) {
    if (opts.visible && !opts.visible(i)) continue;
    const hit = intersectPlane(ray, planes[i], i);
    if (!hit || hit.grip <= 0) continue;
    if (Math.abs(hit.u) > 1 + margin || Math.abs(hit.v) > 1 + margin) continue;
    if (!best || hit.t < best.t) best = hit;
  }
  return best;
}

/**
 * World size of one screen pixel at a given point. Used to keep the brush
 * the same size on screen whatever the zoom.
 */
export function worldPerPixel(
  point: Vec3, eye: Vec3, forward: Vec3, fovY: number, viewportHeight: number,
): number {
  const depth = Math.max(1e-4, v3.dot(v3.sub(point, eye), forward));
  return (2 * depth * Math.tan(fovY / 2)) / Math.max(1, viewportHeight);
}

/**
 * World point to client pixels. Returns null when behind the camera.
 * Handy for anchoring a hint or reticle to something in the world.
 */
export function worldToClient(point: Vec3, viewProj: Mat4, rect: ScreenRect): [number, number] | null {
  const x = point[0], y = point[1], z = point[2];
  const w = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
  if (w <= 0) return null;
  const nx = (viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12]) / w;
  const ny = (viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13]) / w;
  return [rect.left + (nx * 0.5 + 0.5) * rect.width, rect.top + (0.5 - ny * 0.5) * rect.height];
}
