// Autofocus that follows the nearest plane in front of the camera.

import type { PlaneDesc, Vec3 } from '../core/contracts';

/**
 * A sheet as focus sees it: centre plus two half extent vectors, so a point
 * on it is center + a*u + b*v with a, b in [-1, 1].
 */
export interface FocusPlane {
  center: Vec3;
  u: Vec3;
  v: Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Rotate a vector by a quaternion (xyzw). */
export function rotateByQuat(v: Vec3, q: readonly number[]): Vec3 {
  const qv: Vec3 = [q[0], q[1], q[2]];
  const t = cross(qv, v);
  const t2: Vec3 = [t[0] * 2, t[1] * 2, t[2] * 2];
  const c = cross(qv, t2);
  return [v[0] + q[3] * t2[0] + c[0], v[1] + q[3] * t2[1] + c[1], v[2] + q[3] * t2[2] + c[2]];
}

/** Build a FocusPlane from the shared PlaneDesc contract. */
export function focusPlaneFromDesc(desc: Pick<PlaneDesc, 'position' | 'rotation' | 'halfSize'>): FocusPlane {
  return {
    center: desc.position,
    u: rotateByQuat([desc.halfSize[0], 0, 0], desc.rotation),
    v: rotateByQuat([0, desc.halfSize[1], 0], desc.rotation),
  };
}

/**
 * Distance along the ray to where it crosses the plane rectangle, or Infinity.
 * `dir` must be normalised. `slack` widens the rectangle (1 = exact size).
 */
export function rayPlaneDistance(origin: Vec3, dir: Vec3, plane: FocusPlane, slack = 1): number {
  const n = cross(plane.u, plane.v);
  const denom = dot(n, dir);
  if (Math.abs(denom) < 1e-9) return Infinity;
  const t = dot(n, sub(plane.center, origin)) / denom;
  if (!(t > 0)) return Infinity;
  const hit: Vec3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  const rel = sub(hit, plane.center);
  const a = dot(rel, plane.u) / dot(plane.u, plane.u);
  const b = dot(rel, plane.v) / dot(plane.v, plane.v);
  if (Math.abs(a) > slack || Math.abs(b) > slack) return Infinity;
  return t;
}

/** Distance to the nearest plane the view axis hits beyond minDist. */
export function nearestPlaneDistance(origin: Vec3, forward: Vec3, planes: readonly FocusPlane[], minDist = 0): number {
  let best = Infinity;
  for (let i = 0; i < planes.length; i++) {
    const t = rayPlaneDistance(origin, forward, planes[i]);
    if (t > minDist && t < best) best = t;
  }
  return best;
}

export interface FocusTrackerOptions {
  /** Starting focus distance. */
  initial?: number;
  /** Seconds for the focus pull to cover about 63% of the way. */
  tau?: number;
  /**
   * Ignore planes closer than this, so focus racks to the next plane before
   * the camera passes through the current one.
   */
  minDist?: number;
  /** Never focus farther than this. */
  maxDist?: number;
}

export class FocusTracker {
  distance: number;
  target: number;
  tau: number;
  minDist: number;
  maxDist: number;

  constructor({ initial = 20, tau = 0.6, minDist = 3, maxDist = 1e4 }: FocusTrackerOptions = {}) {
    this.distance = initial;
    this.target = initial;
    this.tau = tau;
    this.minDist = minDist;
    this.maxDist = maxDist;
  }

  /** Jump straight to the current target with no easing. */
  snap(): void {
    this.distance = this.target;
  }

  /**
   * @param origin  camera position
   * @param forward normalised view direction
   * @param dt      seconds since the last update
   * @returns the smoothed focus distance
   */
  update(origin: Vec3, forward: Vec3, planes: readonly FocusPlane[], dt: number): number {
    const t = nearestPlaneDistance(origin, forward, planes, this.minDist);
    // If nothing is in view keep the last target instead of hunting.
    if (Number.isFinite(t)) this.target = Math.min(t, this.maxDist);
    // Ease in log space: a pull from 5 to 10 feels like one from 50 to 100.
    const k = this.tau > 0 ? 1 - Math.exp(-Math.max(dt, 0) / this.tau) : 1;
    const cur = Math.log(Math.max(this.distance, 1e-4));
    const tgt = Math.log(Math.max(this.target, 1e-4));
    this.distance = Math.exp(cur + (tgt - cur) * k);
    return this.distance;
  }
}
