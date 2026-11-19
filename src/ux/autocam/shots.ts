/**
 * Shots for the auto camera: what is worth looking at, and camera moves that
 * look at it without the eye passing through a sheet.
 *
 * Everything here is pure (no DOM, no GPU), so the director can plan a move,
 * test it, and throw it away before it ever reaches the screen.
 *
 * A shot is a pose as a function of time. It stays defined a little past its
 * own end, so the next shot can blend in while this one is still moving: the
 * camera never comes to a dead stop between moves.
 */

import type { PlaneInstance } from "../../core/contracts";
import {
  lerp,
  smoothstep,
  quatLook,
  quatRotate,
  v3add,
  v3addScaled,
  v3cross,
  v3dot,
  v3len,
  v3normalize,
  v3scale,
  v3sub,
} from "../camera/math";
import type { Vec3 } from "../camera/math";
import type { CameraPose } from "../camera/rig";

const DEG = Math.PI / 180;
const WORLD_UP: Vec3 = [0, 1, 0];

// ------------------------------------------------------------------ sheets

/** A sheet as the director sees it: a rectangle in the world plus how much light it carries. */
export interface Sheet {
  key: string;
  center: Vec3;
  normal: Vec3;
  right: Vec3;
  up: Vec3;
  /** Half width and half height in world units. */
  hw: number;
  hh: number;
  /** Particles it can show, times its brightness (streaming fades sheets with it). */
  weight: number;
  behaviorId: string;
}

/**
 * Read sheets from the live planes. Uses capacity, not activeCount: the budget
 * gives off-screen sheets zero particles, and those are exactly the ones the
 * camera might want to visit next.
 */
export function sheetsFrom(planes: readonly PlaneInstance[]): Sheet[] {
  return planes.map((p, i) => {
    const d = p.desc;
    return {
      key: d.id ?? `#${i}:${d.position.join(",")}`,
      center: [d.position[0], d.position[1], d.position[2]],
      right: quatRotate(d.rotation, [1, 0, 0]),
      up: quatRotate(d.rotation, [0, 1, 0]),
      normal: quatRotate(d.rotation, [0, 0, 1]),
      hw: d.halfSize[0],
      hh: d.halfSize[1],
      weight: p.capacity * Math.max(0, d.brightness ?? 1),
      behaviorId: d.behaviorId,
    };
  });
}

/** Does the segment a to b pass through the sheet's rectangle (grown by `grow`)? */
export function segmentHitsSheet(a: Vec3, b: Vec3, s: Sheet, grow = 1.08): boolean {
  const sa = v3dot(v3sub(a, s.center), s.normal);
  const sb = v3dot(v3sub(b, s.center), s.normal);
  if ((sa > 0 && sb > 0) || (sa < 0 && sb < 0)) return false;
  const denom = sa - sb;
  const t = Math.abs(denom) < 1e-12 ? 0 : sa / denom;
  const hit = v3sub(v3addScaled(a, v3sub(b, a), t), s.center);
  return Math.abs(v3dot(hit, s.right)) <= s.hw * grow && Math.abs(v3dot(hit, s.up)) <= s.hh * grow;
}

/** The eye position of a pose. */
export const eyeOf = (p: CameraPose): Vec3 =>
  v3addScaled(p.target, quatRotate(p.orientation, [0, 0, 1]), p.distance);

/**
 * Sample a path of poses (`samples` segments between t0 and t1, evaluated in
 * order) and count how many times the eye crosses a sheet. `stopAt` ends the
 * count early once reached.
 */
export function pathCrossings(
  pose: (t: number) => CameraPose,
  t0: number,
  t1: number,
  sheets: readonly Sheet[],
  samples = 48,
  stopAt = Infinity,
): number {
  let hits = 0;
  let prev = eyeOf(pose(t0));
  for (let i = 1; i <= samples; i++) {
    const eye = eyeOf(pose(lerp(t0, t1, i / samples)));
    for (const s of sheets) {
      if (segmentHitsSheet(prev, eye, s) && ++hits >= stopAt) return hits;
    }
    prev = eye;
  }
  return hits;
}

/** True when the eye never crosses a sheet along the path. */
export const pathIsClear = (
  pose: (t: number) => CameraPose,
  t0: number,
  t1: number,
  sheets: readonly Sheet[],
  samples = 48,
): boolean => pathCrossings(pose, t0, t1, sheets, samples, 1) === 0;

// ------------------------------------------------------------------ interest

export interface WorldStats {
  /** Light-weighted centre of everything. */
  center: Vec3;
  /** Radius that holds nearly all sheets around `center`. */
  radius: number;
  /** Typical sheet half size, for scale-free choices. */
  sheetSize: number;
}

export function worldStats(sheets: readonly Sheet[]): WorldStats {
  let w = 0;
  let c: Vec3 = [0, 0, 0];
  const sizes: number[] = [];
  for (const s of sheets) {
    const k = Math.max(s.weight, 1);
    c = v3addScaled(c, s.center, k);
    w += k;
    sizes.push(Math.max(s.hw, s.hh));
  }
  c = w > 0 ? v3scale(c, 1 / w) : [0, 0, 0];
  let radius = 0;
  for (const s of sheets) radius = Math.max(radius, v3len(v3sub(s.center, c)) + Math.hypot(s.hw, s.hh));
  sizes.sort((a, b) => a - b);
  const sheetSize = sizes.length ? sizes[sizes.length >> 1] : 1;
  return { center: c, radius: Math.max(radius, sheetSize, 1e-3), sheetSize: Math.max(sheetSize, 1e-3) };
}

/** A dense neighbourhood around one sheet. */
export interface Cluster {
  center: Vec3;
  radius: number;
  /** Total light nearby (soft count). */
  mass: number;
}

/** Soft neighbourhood of sheet `i`: Gaussian weights by distance, scale `sigma`. */
export function clusterAround(sheets: readonly Sheet[], i: number, sigma: number): Cluster {
  const origin = sheets[i].center;
  let mass = 0;
  let c: Vec3 = [0, 0, 0];
  for (const s of sheets) {
    const d = v3len(v3sub(s.center, origin));
    const k = s.weight * Math.exp(-(d * d) / (sigma * sigma));
    mass += k;
    c = v3addScaled(c, s.center, k);
  }
  c = mass > 0 ? v3scale(c, 1 / mass) : origin;
  let r2 = 0;
  for (const s of sheets) {
    const d = v3len(v3sub(s.center, origin));
    const k = s.weight * Math.exp(-(d * d) / (sigma * sigma));
    const dc = v3len(v3sub(s.center, c));
    r2 += k * dc * dc;
  }
  const radius = mass > 0 ? Math.sqrt(r2 / mass) : sigma;
  return { center: c, radius: Math.max(radius, sigma * 0.5), mass };
}

// ------------------------------------------------------------------ shots

export type ShotKind = "wide" | "pullback" | "orbit" | "edge" | "inside";

export interface Shot {
  kind: ShotKind;
  /** Seconds the shot holds the screen before the next one starts to blend in. */
  duration: number;
  /** Sheet it is about, so the director can avoid revisiting it right away. */
  sheet?: Sheet;
  /** Pose at `t` seconds, defined for any t >= 0: past `duration` the motion eases to a stop. */
  pose(t: number): CameraPose;
}

/**
 * An orbit on a sphere around `target`, described in a frame: `a0` is the
 * direction at azimuth 0, `a90` at azimuth 90 degrees, `pole` is elevation 90.
 * Azimuth, elevation and log distance move linearly in time, so the camera
 * moves at a steady pace (the blends between shots supply the easing).
 */
interface Orbit {
  target: (u: number) => Vec3;
  a0: Vec3;
  a90: Vec3;
  pole: Vec3;
  az: [number, number];
  el: [number, number];
  dist: [number, number];
  /** Preferred screen up. World up keeps the horizon level. */
  upHint: Vec3;
}

function orbitPose(o: Orbit, u: number): CameraPose {
  const az = lerp(o.az[0], o.az[1], u);
  const el = lerp(o.el[0], o.el[1], u);
  const ce = Math.cos(el);
  const dir = v3normalize(
    v3add(
      v3add(v3scale(o.a0, ce * Math.cos(az)), v3scale(o.a90, ce * Math.sin(az))),
      v3scale(o.pole, Math.sin(el)),
    ),
  );
  // Near the up hint, lean screen up smoothly toward another axis of the frame
  // (never switch at once: that would be a cut).
  const alt = o.upHint === o.pole ? o.a0 : o.pole;
  const k = smoothstep((Math.abs(v3dot(dir, o.upHint)) - 0.8) / 0.17);
  const up = k > 0 ? v3normalize(v3add(v3scale(o.upHint, 1 - k), v3scale(alt, k))) : o.upHint;
  const d0 = Math.log(Math.max(o.dist[0], 1e-6));
  const d1 = Math.log(Math.max(o.dist[1], 1e-6));
  return {
    target: o.target(u),
    orientation: quatLook(v3scale(dir, -1), up),
    distance: Math.exp(lerp(d0, d1, u)),
  };
}

/**
 * Progress past the end of a shot: same speed at u = 1, then easing to a stop
 * at 1.4. The outgoing shot keeps moving while the next blends in, without
 * running away (a pull-back extrapolated linearly would grow without bound).
 */
const overrun = (u: number): number => (u <= 1 ? u : 1 + (1 - Math.exp(-2.5 * (u - 1))) / 2.5);

const makeShot = (kind: ShotKind, duration: number, o: Orbit, sheet?: Sheet): Shot => {
  const shot: Shot = {
    kind,
    duration,
    sheet,
    pose: (t) => orbitPose(o, overrun(t / duration)),
  };
  return shot;
};

export interface ShotContext {
  sheets: readonly Sheet[];
  world: WorldStats;
  /** Vertical field of view (radians) and aspect, for framing. */
  fovY: number;
  aspect: number;
  random: () => number;
  /** Where the eye is now, so a sheet is approached from the near side. */
  eye: Vec3;
}

/** Distance at which a w x h rectangle fills the frame, times `pad`. */
export function fitDistance(ctx: ShotContext, hw: number, hh: number, pad = 1.15): number {
  const tan = Math.tan(ctx.fovY * 0.5);
  return Math.max(hh / tan, hw / (tan * ctx.aspect)) * pad;
}

const rangeRand = (r: () => number, a: number, b: number) => a + (b - a) * r();
const sign = (r: () => number) => (r() < 0.5 ? -1 : 1);

/** A horizontal frame around world up, rotated by `yaw`. */
function worldFrame(yaw: number): { a0: Vec3; a90: Vec3; pole: Vec3 } {
  return { a0: [Math.sin(yaw), 0, Math.cos(yaw)], a90: [Math.cos(yaw), 0, -Math.sin(yaw)], pole: WORLD_UP };
}

/** A frame on a sheet, azimuth 0 = straight out of the face nearest the eye. */
function sheetFrame(s: Sheet, eye: Vec3): { a0: Vec3; a90: Vec3; pole: Vec3 } {
  const side = v3dot(v3sub(eye, s.center), s.normal) >= 0 ? 1 : -1;
  const a0 = v3scale(s.normal, side);
  return { a0, a90: v3scale(s.right, side), pole: v3normalize(v3cross(a0, v3scale(s.right, side))) };
}

/** "Open wide": the whole world small in frame, turning slowly. */
export function wideShot(ctx: ShotContext, yawOffset = 0): Shot {
  const { world, random } = ctx;
  const tan = Math.tan(ctx.fovY * 0.5) * Math.min(1, ctx.aspect);
  const far = (world.radius / tan) * 0.95;
  const yaw = Math.atan2(ctx.eye[0] - world.center[0], ctx.eye[2] - world.center[2]) + yawOffset;
  const turn = sign(random) * rangeRand(random, 25, 45) * DEG;
  return makeShot("wide", rangeRand(random, 13, 17), {
    target: () => world.center,
    ...worldFrame(yaw),
    az: [0, turn],
    el: [rangeRand(random, 12, 22) * DEG, rangeRand(random, 18, 30) * DEG],
    dist: [far, far * rangeRand(random, 0.78, 0.9)],
    upHint: WORLD_UP,
  });
}

/** Start close on a sheet's face and pull back slowly until its neighbours come into frame. */
export function pullbackShot(ctx: ShotContext, s: Sheet): Shot {
  const r = ctx.random;
  const fit = fitDistance(ctx, s.hw, s.hh);
  const f = sheetFrame(s, ctx.eye);
  return makeShot("pullback", rangeRand(r, 12, 16), {
    target: () => s.center,
    ...f,
    az: [rangeRand(r, -12, 12) * DEG, rangeRand(r, -25, 25) * DEG],
    el: [rangeRand(r, -8, 8) * DEG, rangeRand(r, 5, 15) * DEG],
    dist: [fit * 0.18, fit * rangeRand(r, 2.2, 3)],
    upHint: s.up,
  }, s);
}

/** A three-quarter view that circles a sheet. */
export function orbitShot(ctx: ShotContext, s: Sheet): Shot {
  const r = ctx.random;
  const fit = fitDistance(ctx, s.hw, s.hh);
  const f = sheetFrame(s, ctx.eye);
  const start = sign(r) * rangeRand(r, 15, 40) * DEG;
  return makeShot("orbit", rangeRand(r, 11, 15), {
    target: () => s.center,
    ...f,
    az: [start, start - Math.sign(start) * rangeRand(r, 35, 60) * DEG],
    el: [rangeRand(r, 5, 20) * DEG, rangeRand(r, 10, 25) * DEG],
    dist: [fit * rangeRand(r, 1.1, 1.4), fit * rangeRand(r, 0.85, 1.05)],
    upHint: WORLD_UP,
  }, s);
}

/** Swing from a slanted view to nearly edge-on, so the sheet folds into a line of light. */
export function edgeShot(ctx: ShotContext, s: Sheet): Shot {
  const r = ctx.random;
  // Edge-on, the sheet's long side is what stays on screen.
  const fit = fitDistance(ctx, Math.max(s.hw, s.hh), Math.min(s.hw, s.hh));
  const f = sheetFrame(s, ctx.eye);
  const dir = sign(r);
  // Never end exactly edge-on: a little face keeps the light readable.
  return makeShot("edge", rangeRand(r, 11, 14), {
    target: () => s.center,
    ...f,
    az: [dir * rangeRand(r, 30, 45) * DEG, dir * rangeRand(r, 80, 86) * DEG],
    el: [rangeRand(r, 0, 10) * DEG, rangeRand(r, -4, 4) * DEG],
    // Far enough that the eye stays outside the rectangle when it is level with it.
    dist: [Math.max(fit, Math.hypot(s.hw, s.hh) * 1.3), Math.max(fit * 0.9, Math.hypot(s.hw, s.hh) * 1.25)],
    upHint: WORLD_UP,
  }, s);
}

/** Inside a dense cluster, turning slowly among the sheets (the "key1" framing). */
export function insideShot(ctx: ShotContext, cluster: Cluster, s: Sheet): Shot {
  const r = ctx.random;
  const yaw = rangeRand(r, 0, Math.PI * 2);
  const turn = sign(r) * rangeRand(r, 30, 55) * DEG;
  const d = cluster.radius * rangeRand(r, 0.45, 0.7);
  return makeShot("inside", rangeRand(r, 13, 17), {
    target: () => cluster.center,
    ...worldFrame(yaw),
    az: [0, turn],
    el: [rangeRand(r, -10, 15) * DEG, rangeRand(r, -5, 20) * DEG],
    dist: [d, d * rangeRand(r, 0.8, 1.0)],
    upHint: WORLD_UP,
  }, s);
}

/** A pose that holds still: the user's camera at the moment the tour starts. */
export function holdShot(pose: CameraPose): Shot {
  return { kind: "wide", duration: 0, pose: () => pose };
}
