/**
 * AutoCamDirector: picks what to look at next and hands out one camera pose
 * per frame. DOM-free and GPU-free; `mountAutoCam` (./index.ts) wires it into
 * the app.
 *
 * The tour is a sequence of shots (./shots.ts). Each new shot blends in over a
 * few seconds while the previous one keeps moving, so the camera never stops
 * dead and never cuts. Before a shot is accepted, its whole eye path and the
 * blend into it are sampled; a path that passes through a sheet is thrown
 * away, the blend first gets a bigger pull-back arc, and if nothing clean is
 * found the director goes wide instead (which is always outside the world).
 */

import { seededRandom } from "../../math";
import {
  clamp,
  easeInOutCubic,
  lerp,
  quatAngle,
  quatNormalize,
  v3dist,
  v3len,
  v3lerp,
  v3sub,
} from "../camera/math";
import type { Quat } from "../camera/math";
import type { CameraPose } from "../camera/rig";
import {
  clusterAround,
  edgeShot,
  eyeOf,
  holdShot,
  insideShot,
  orbitShot,
  pathCrossings,
  pathIsClear,
  pullbackShot,
  wideShot,
  worldStats,
} from "./shots";
import type { Sheet, Shot, ShotContext, ShotKind } from "./shots";

export interface DirectorView {
  sheets: readonly Sheet[];
  fovY: number;
  aspect: number;
}

export interface DirectorOptions {
  /** Seed for shot choices. Same seed and same world give the same tour. */
  seed?: number;
  /** Go back to a wide shot at least this often (in shots). Default 6. */
  wideEvery?: number;
}

/** How often each kind is picked, relative to the others. */
const KIND_WEIGHTS: Record<ShotKind, number> = {
  wide: 0.6,
  pullback: 1.6,
  orbit: 1.6,
  edge: 1.3,
  inside: 2.2,
};

/** Pull-back arcs tried for a blend, as a fraction of how far the pivot travels. */
const ARCS = [0.2, 0.5, 0.9];
/** Extra arcs for the wide fallback, which must find a way out whatever happens. */
const WIDE_ARCS = [...ARCS, 1.5, 2.5];

const dot4 = (a: Quat, b: Quat) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const neg4 = (q: Quat): Quat => [-q[0], -q[1], -q[2], -q[3]];
/** `q` or `-q` (the same rotation), whichever is closer to `ref` in quaternion space. */
const alignTo = (q: Quat, ref: Quat): Quat => (dot4(q, ref) < 0 ? neg4(q) : q);

/**
 * Slerp that never flips to the other hemisphere. Both ends of a blend move,
 * and a shortest-path slerp would jump the moment their angle passes 180
 * degrees; with signs tracked frame to frame this one stays continuous.
 */
function slerpNoFlip(a: Quat, b: Quat, t: number): Quat {
  const cos = clamp(dot4(a, b), -1, 1);
  if (cos > 0.9995 || cos < -0.9995) return quatNormalize(lerp4(a, b, t));
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const sa = Math.sin((1 - t) * theta) / sin;
  const sb = Math.sin(t * theta) / sin;
  return quatNormalize([a[0] * sa + b[0] * sb, a[1] * sa + b[1] * sb, a[2] * sa + b[2] * sb, a[3] * sa + b[3] * sb]);
}
const lerp4 = (a: Quat, b: Quat, t: number): Quat => [
  lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t),
];

/**
 * The move from one shot into the next. The outgoing shot keeps running while
 * the incoming one fades in: pivot and rotation eased, distance eased in log
 * space plus a pull-back arc. Evaluate with increasing `tau` only: it tracks
 * quaternion signs from call to call.
 */
class Blend {
  private qa: Quat | null = null;
  private qb: Quat | null = null;

  constructor(
    readonly from: Shot,
    readonly fromT: number,
    readonly to: Shot,
    readonly duration: number,
    readonly hump: number,
  ) {}

  at(tau: number): CameraPose {
    const a = this.from.pose(this.fromT + tau);
    const b = this.to.pose(tau);
    const qa = this.qa ? alignTo(a.orientation, this.qa) : a.orientation;
    // At the start, take the short way round; after that, follow each end continuously.
    const qb = this.qb ? alignTo(b.orientation, this.qb) : alignTo(b.orientation, qa);
    this.qa = qa;
    this.qb = qb;
    const e = easeInOutCubic(clamp(tau / this.duration, 0, 1));
    return {
      target: v3lerp(a.target, b.target, e),
      orientation: slerpNoFlip(qa, qb, e),
      distance: Math.exp(lerp(Math.log(a.distance), Math.log(b.distance), e)) + this.hump * Math.sin(Math.PI * e),
    };
  }

  /** A fresh copy for sampling the path without disturbing the live one. */
  clone(): Blend {
    return new Blend(this.from, this.fromT, this.to, this.duration, this.hump);
  }
}

/** Play `shot` backwards from `fromT` to its start, easing in and out. */
function reverseShot(shot: Shot, fromT: number): Shot {
  const duration = clamp(fromT * 0.6, 3, 10);
  return {
    kind: shot.kind,
    duration,
    sheet: shot.sheet,
    pose: (t) => shot.pose(fromT * (1 - easeInOutCubic(clamp(t / duration, 0, 1)))),
  };
}

export class AutoCamDirector {
  active = false;
  /** The shot on screen, for status lines and debugging. */
  get kind(): ShotKind | null {
    return this.active && this.shot ? this.shot.kind : null;
  }

  private readonly random: () => number;
  private readonly wideEvery: number;

  private shot: Shot | null = null;
  private t = 0;
  /** When the current shot hands over: its duration, or later if it needs longer on screen. */
  private shotEnd = 0;
  private retries = 0;
  private blend: Blend | null = null;
  private blendT = 0;

  private recentSheets: string[] = [];
  private recentBehaviors: string[] = [];
  private lastKind: ShotKind | null = null;
  private sinceWide = 0;
  private lastPose: CameraPose | null = null;

  constructor(opts: DirectorOptions = {}) {
    this.random = seededRandom(opts.seed ?? 0x5eed);
    this.wideEvery = opts.wideEvery ?? 6;
  }

  /** Take over from `pose` (the camera as the user left it). The first move opens wide. */
  start(pose: CameraPose): void {
    this.active = true;
    this.shot = holdShot(pose);
    this.t = 0;
    this.shotEnd = 0;
    this.retries = 0;
    this.blend = null;
    this.lastKind = null;
    this.sinceWide = this.wideEvery; // open wide
    this.lastPose = pose;
  }

  stop(): void {
    this.active = false;
    this.shot = this.blend = null;
  }

  /** Advance by `dt` seconds and return the pose to show, or null when inactive. */
  step(dt: number, view: () => DirectorView): CameraPose | null {
    if (!this.active || !this.shot) return null;
    this.t += dt;
    if (this.blend) {
      this.blendT += dt;
      if (this.blendT >= this.blend.duration) this.blend = null;
    }
    if (!this.blend && this.t >= this.shotEnd) this.next(view());
    const pose = this.blend ? this.blend.at(this.blendT) : this.shot.pose(this.t);
    this.lastPose = pose;
    return pose;
  }

  // ------------------------------------------------------------------

  private next(view: DirectorView): void {
    const from = this.shot!;
    const fromT = this.t;
    const ctx: ShotContext = {
      sheets: view.sheets,
      world: worldStats(view.sheets),
      fovY: view.fovY,
      aspect: view.aspect,
      random: this.random,
      eye: eyeOf(this.lastPose ?? from.pose(fromT)),
    };

    // Candidates in order of preference; the first whose shot and blend both keep the
    // eye out of every sheet wins. Wide sits outside the world, so only its blend can cross.
    const forceWide = this.sinceWide >= this.wideEvery || view.sheets.length === 0;
    const wides = [0, 1, 2, 3].map((k) => () => wideShot(ctx, (k * Math.PI) / 2));
    const others = Array.from({ length: forceWide ? 10 : 8 }, () => () => this.propose(ctx));
    const candidates = forceWide ? [...wides, ...others] : [...others, ...wides];

    let best: { blend: Blend; hits: number } | null = null;
    for (const make of candidates) {
      const shot = make();
      // Past its end a shot eases to a stop; by 3x its duration it has all but stopped.
      if (!shot || !pathIsClear(shot.pose, 0, shot.duration * 3, ctx.sheets, 64)) continue;
      const plan = this.planBlend(from, fromT, shot, ctx.sheets, shot.kind === "wide" ? WIDE_ARCS : ARCS);
      if (!best || plan.hits < best.hits) best = plan;
      if (plan.hits === 0) break;
    }
    // Boxed in (say, deep inside a cluster): let the current shot drift on a little and
    // look again, rather than fly through a sheet. After a few tries take the least bad move.
    if ((!best || best.hits > 0) && this.retries < 6 && from.duration > 0) {
      this.retries++;
      this.shotEnd = this.t + 1.5;
      return;
    }
    // Still boxed in: back out the way this shot came in. That path was checked when the
    // shot was accepted, so it is clear, and the next look starts from open space.
    if ((!best || best.hits > 0) && from.duration > 0 && fromT > 1) {
      const back = this.planBlend(from, fromT, reverseShot(from, fromT), ctx.sheets, [0]);
      if (!best || back.hits < best.hits) best = back;
    }
    this.retries = 0;
    const chosen = (best ?? this.planBlend(from, fromT, wideShot(ctx), ctx.sheets, WIDE_ARCS)).blend;

    const shot = chosen.to;
    this.shot = shot;
    this.t = 0;
    // Hold each shot a while after it has fully blended in.
    this.shotEnd = Math.max(shot.duration, chosen.duration + 5);
    this.blend = chosen;
    this.blendT = 0;

    this.lastKind = shot.kind;
    this.sinceWide = shot.kind === "wide" ? 0 : this.sinceWide + 1;
    if (shot.sheet) {
      this.recentSheets = [shot.sheet.key, ...this.recentSheets].slice(0, 6);
      this.recentBehaviors = [shot.sheet.behaviorId, ...this.recentBehaviors].slice(0, 2);
    }
  }

  /** Seconds to blend between two poses: longer for far moves and big turns. */
  private blendDuration(a: CameraPose, b: CameraPose): number {
    const travel = v3dist(a.target, b.target);
    const refD = Math.max(Math.min(a.distance, b.distance), 1e-6);
    const turn = quatAngle(a.orientation, b.orientation) / Math.PI;
    const zoom = Math.abs(Math.log(b.distance / a.distance));
    return clamp(3 + 1.1 * Math.log2(1 + travel / refD) + 2 * turn + 0.5 * zoom, 3.5, 8);
  }

  /**
   * Try pull-back arcs from small to large and return the first blend whose
   * eye stays out of every sheet (hits 0), or else the one that crosses least.
   */
  private planBlend(
    from: Shot,
    fromT: number,
    to: Shot,
    sheets: readonly Sheet[],
    arcs: readonly number[],
  ): { blend: Blend; hits: number } {
    const a = from.pose(fromT);
    const b = to.pose(0);
    const duration = this.blendDuration(a, b);
    // With no pivot travel (same target), arc against the camera distance instead.
    const reach = Math.max(v3dist(a.target, b.target), 0.25 * (a.distance + b.distance));
    let best: { blend: Blend; hits: number } | null = null;
    for (const arc of arcs) {
      const blend = new Blend(from, fromT, to, duration, arc * reach);
      const probe = blend.clone();
      const hits = pathCrossings((tau) => probe.at(tau), 0, duration, sheets, 64, best ? best.hits : Infinity);
      if (!best || hits < best.hits) best = { blend, hits };
      if (hits === 0) break;
    }
    return best!;
  }

  /** One candidate shot: a kind (never the same twice running) and a sheet worth seeing. */
  private propose(ctx: ShotContext): Shot | null {
    const r = this.random;
    const kinds = (Object.keys(KIND_WEIGHTS) as ShotKind[]).filter((k) => k !== this.lastKind);
    const total = kinds.reduce((n, k) => n + KIND_WEIGHTS[k], 0);
    let pick = r() * total;
    let kind = kinds[kinds.length - 1];
    for (const k of kinds) {
      pick -= KIND_WEIGHTS[k];
      if (pick <= 0) {
        kind = k;
        break;
      }
    }
    if (kind === "wide") return wideShot(ctx);

    const i = this.pickSheet(ctx);
    if (i < 0) return null;
    const s = ctx.sheets[i];
    switch (kind) {
      case "pullback":
        return pullbackShot(ctx, s);
      case "orbit":
        return orbitShot(ctx, s);
      case "edge":
        return edgeShot(ctx, s);
      case "inside": {
        const cluster = clusterAround(ctx.sheets, i, ctx.world.sheetSize * 4);
        return insideShot(ctx, cluster, s);
      }
    }
  }

  /**
   * Interest: half how densely lit a sheet is, half how much light surrounds it
   * (clusters), with recently seen sheets and behaviors pushed down and a mild
   * preference for nearby targets so moves stay short. Weighted random pick.
   */
  private pickSheet(ctx: ShotContext): number {
    const { sheets, world } = ctx;
    const n = sheets.length;
    if (n === 0) return -1;
    // Large streamed worlds: score a random sample, planning stays cheap.
    const idx = n <= 256 ? sheets.map((_, i) => i) : Array.from({ length: 256 }, () => Math.floor(this.random() * n));
    const sigma = world.sheetSize * 4;
    const density = idx.map((i) => sheets[i].weight / Math.max(4 * sheets[i].hw * sheets[i].hh, 1e-9));
    const mass = idx.map((i) => clusterAround(sheets, i, sigma).mass);
    const maxD = Math.max(...density, 1e-12);
    const maxM = Math.max(...mass, 1e-12);
    const scores = idx.map((i, j) => {
      const s = sheets[i];
      if (s.weight <= 0) return 0;
      let score = 0.5 * (density[j] / maxD) + 0.5 * (mass[j] / maxM);
      if (this.recentSheets.includes(s.key)) score *= 0.08;
      if (this.recentBehaviors.includes(s.behaviorId)) score *= 0.5;
      score *= Math.exp(-v3len(v3sub(s.center, ctx.eye)) / (2 * world.radius));
      return score * score;
    });
    const total = scores.reduce((a, b) => a + b, 0);
    if (total <= 0) return -1;
    let pick = this.random() * total;
    for (let j = 0; j < idx.length; j++) {
      pick -= scores[j];
      if (pick <= 0) return idx[j];
    }
    return idx[idx.length - 1];
  }
}
