/**
 * Trillion proof shots: thin wrappers around the offline renderer
 * (src/offline). Each shot is one or more plain OfflineJobs plus the words
 * burned into its frames. Every number on screen comes from the renderer's own
 * GPU counters (the per-frame landed tally, or an exact 64-bit pixel counter),
 * never from arithmetic on the job.
 *
 * Wording rule: the trillion is "rendered", never "simulated". Particles are
 * stateless: positions are closed-form functions of (sheet seed, index, time).
 *
 * Shots (the short version of prompts/trillion-believability.md):
 *  - countUp: one frozen frame built from 1 particle to all of them.
 *  - loupe:   one dice-chosen pixel, opened up so its particles separate.
 *  - dive:    an unbroken log zoom from the whole world to a few dots.
 *  - find:    fly to one exact particle, by its global index.
 */
import type { FrameStats } from "../offline/core/develop";
import { withCommas } from "../offline/core/grade";
import { totalParticles, type CameraKey, type OfflineJob } from "../offline/core/job";
import { lawPosition, particleKey, pcg } from "../offline/core/laws";
import { add, cameraBasis, quatNormalize, quatRotate, scale, sub, type CameraBasis } from "../offline/core/math";
import { DEFAULT_RUNGS, scaleParticles, shortCount } from "../offline/core/ladder";
import { CameraPath } from "../offline/core/camera";
import { clusterJob, type ClusterOptions } from "../offline/core/world";
import type { Vec3 } from "../core/contracts";

export type ShotId = "countUp" | "pullBack" | "loupe" | "dive" | "find" | "ladder" | "collapse";

export interface ShotOptions {
  /** Particles in the world. 1e12 for the real thing, less for a quick look. */
  particles: number;
  width: number;
  height: number;
  fps: number;
  /** World seed (sheet layout and identities). */
  seed: number;
  /** Dice seed: which pixel the loupe opens. */
  dice: number;
  /** Global particle index for the find shot. */
  findIndex: number;
}

export const DEFAULT_SHOT_OPTIONS: ShotOptions = {
  particles: 1_000_000_000_000,
  width: 3840,
  height: 2160,
  fps: 60,
  seed: 1,
  dice: 6,
  findIndex: 999_999_999_999,
};

/** The frozen world every shot looks at: the same sheets as the offline trillion preset. */
export function baseWorld(o: ShotOptions, frames = 1): OfflineJob {
  const c: ClusterOptions = {
    name: "proof",
    width: o.width,
    height: o.height,
    fps: o.fps,
    frames,
    particles: o.particles,
    planes: Math.max(24, Math.min(1024, Math.ceil(o.particles / 1e9))),
    seed: o.seed,
    ssaa: 1,
    splat: "point",
    // Every particle adds exactly one unit, so pixel values and frame sums are exact counts.
    weighting: "count",
    timeScale: 0,
    shutter: 0,
  };
  return clusterJob(c);
}

const big = (s: string | number | bigint): string => withCommas(String(s));

// ------------------------------------------------------------ count-up ----

/** Log-spaced particle counts 1, 2, 5, 10, 20, 50, ... up to total. */
export function countUpStages(total: number): number[] {
  const out: number[] = [];
  for (let d = 1; d <= total; d *= 10) for (const m of [1, 2, 5]) if (d * m < total) out.push(d * m);
  out.push(total);
  return out;
}

/**
 * The first `n` particles of a job in plane-major order: whole sheets, then a
 * prefix of the next one. Within a sheet the index is hashed, so any prefix is
 * a uniform sample of that sheet: grain refines into structure.
 */
export function prefixJob(job: OfflineJob, n: number, name: string): OfflineJob {
  let left = n;
  const planes = [];
  for (const p of job.planes) {
    if (left <= 0) break;
    const take = Math.min(left, p.particleCount);
    planes.push({ ...p, particleCount: take });
    left -= take;
  }
  return { ...job, name, frames: 1, planes };
}

export interface Pass {
  /** Prefix for this pass's files in the shot folder. */
  key: string;
  job: OfflineJob;
  /** Frames of video this pass's frame is held for (count-up, loupe). 1 means play through. */
  hold: number;
  /**
   * Lock the exposure to another pass: grade with the automatic white point of
   * pass `key`'s first frame times `scale`, instead of exposing this pass on
   * its own. The ladder scales by count (same exposure per particle); the
   * collapse keeps the first frame's white so the final pixel clips to white.
   */
  lock?: { key: string; scale: number };
}

export function countUpPasses(o: ShotOptions): Pass[] {
  const world = baseWorld(o);
  const total = totalParticles(world);
  return countUpStages(total).map((n, i) => ({
    key: `countup-${String(i).padStart(2, "0")}-`,
    job: prefixJob(world, n, `countup ${n}`),
    hold: Math.max(6, Math.round(o.fps * 0.4)),
  }));
}

/**
 * `s.seconds` is this pass's own GPU time (the final pass is the full frame);
 * `allSeconds` is the wall time of every count-up pass together, never
 * presented as one frame's time.
 */
export function countUpLabel(s: FrameStats, job: OfflineJob, allSeconds: number, passes: number): string[] {
  return [
    `PARTICLES RENDERED ${big(s.evaluated)}`,
    `LANDED IN FRAME ${big(s.landed)} (COUNTED ON THE GPU)`,
    `THIS FRAME TOOK ${s.seconds.toFixed(1)} S ON THE GPU` +
      (Number.isFinite(allSeconds) ? `  ALL ${passes} PASSES ${allSeconds.toFixed(1)} S` : ""),
    `STATELESS  ONE FROZEN FRAME  ${job.width}X${job.height}`,
  ];
}

// --------------------------------------------------------------- loupe ----

/** Particles a loupe pixel should hold so its dots stay distinct when opened up. */
export const LOUPE_MIN = 10_000;
export const LOUPE_MAX = 50_000;

/** Opened-up loupe frame size: a pixel's dots average about this many output pixels apart at LOUPE_MAX. */
export const LOUPE_SIZE = 2160;

/**
 * Deterministic dice roll over a count grid for a pixel holding between `min`
 * and `max` particles. Opened up at LOUPE_SIZE squared, 50,000 dots are about
 * 10 pixels apart, so every one reads as a separate dot (a 3,000,000 pixel is
 * grey static). Tries random pixels in the central 60% first, then the whole
 * frame, then falls back to the lit pixel whose count is closest to the range.
 */
export function rollPixel(
  lo: Uint32Array,
  hi: Uint32Array,
  width: number,
  height: number,
  dice: number,
  min = LOUPE_MIN,
  max = LOUPE_MAX,
): { x: number; y: number; count: bigint } {
  const countAt = (i: number): bigint => (BigInt(lo[i]) + (BigInt(hi[i]) << 32n)) / 65536n;
  const lo64 = BigInt(min);
  const hi64 = BigInt(max);
  let h = pcg(dice >>> 0);
  for (const span of [0.6, 1]) {
    for (let tries = 0; tries < 200000; tries++) {
      h = pcg(h);
      const x = Math.floor(width * (0.5 - span / 2) + ((h >>> 8) / 16777216) * width * span);
      h = pcg(h);
      const y = Math.floor(height * (0.5 - span / 2) + ((h >>> 8) / 16777216) * height * span);
      const count = countAt(y * width + x);
      if (count >= lo64 && count <= hi64) return { x, y, count };
    }
  }
  // Full scan: the lit pixel nearest the range, ties broken by grid order.
  let best = -1;
  let bestGap = -1;
  for (let i = 0; i < lo.length; i++) {
    if (lo[i] === 0 && hi[i] === 0) continue;
    const c = Number(countAt(i));
    if (c === 0) continue;
    const gap = c < min ? min / c : c > max ? c / max : 1;
    if (best < 0 || gap < bestGap) {
      best = i;
      bestGap = gap;
      if (gap === 1) break;
    }
  }
  if (best < 0) throw new Error("No lit pixel found for the loupe");
  return { x: best % width, y: Math.floor(best / width), count: countAt(best) };
}

/**
 * A camera at the same eye as `job`'s frame 0, looking through pixel (x, y),
 * with a field of view of exactly one main-view pixel. A square frame of this
 * camera is that pixel blown up.
 */
export function loupeJob(job: OfflineJob, x: number, y: number, size: number): OfflineJob {
  const key = job.camera[0];
  const cam = cameraBasis(key);
  const focal = (0.5 * job.height) / Math.tan(cam.fovY / 2);
  const dx = (x + 0.5 - job.width / 2) / focal;
  const dy = -(y + 0.5 - job.height / 2) / focal;
  let dir = add(add(cam.forward, scale(cam.right, dx)), scale(cam.up, dy));
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  dir = scale(dir, 1 / len);
  // One pixel seen from slightly off-axis is 1/len times smaller in angle.
  const fovY = 2 * Math.atan(0.5 / focal / len);
  const pitch = Math.asin(Math.max(-1, Math.min(1, dir[1])));
  const yaw = Math.atan2(-dir[0], -dir[2]);
  const target = add(cam.eye, scale(dir, key.distance));
  const camera: CameraKey[] = [{ t: 0, target, yaw, pitch, distance: key.distance, fovY }];
  return { ...job, name: `loupe ${x},${y}`, width: size, height: size, frames: 1, camera };
}

export function loupeLabel(pixel: { x: number; y: number; count: bigint }, loupeLanded: string): string[] {
  return [
    `THIS PIXEL (${pixel.x}, ${pixel.y}): ${big(pixel.count)} PARTICLES`,
    `OPENED UP: ${big(loupeLanded)} DOTS IN VIEW (COUNTED ON THE GPU)`,
    `EVERY DOT IS ONE PARTICLE`,
  ];
}

// ---------------------------------------------------------------- dive ----

/**
 * One unbroken zoom from the whole world to a few dots on the hero sheet.
 * Distance is interpolated in log space by the camera path, so every power of
 * ten takes the same time. About 1.5 s per decade.
 */
export function diveJob(o: ShotOptions): OfflineJob {
  const world = baseWorld(o, 2);
  const wide = world.camera[0];
  const close = world.camera[world.camera.length - 1];
  // Deeper than the offline shot's end: neighbors far apart on screen.
  const end = close.distance * 0.25;
  const decades = Math.log10(wide.distance / end);
  const frames = Math.max(2, Math.round(decades * 1.5 * o.fps));
  const camera: CameraKey[] = [
    { ...wide, t: 0, target: [0, 0, 0] },
    { ...close, t: 1, distance: end },
  ];
  return { ...world, name: "dive", frames, near: end * 0.02, camera };
}

export function diveLabel(s: FrameStats): string[] {
  return [`PARTICLES IN VIEW ${big(s.landed)}`, `COUNTED ON THE GPU, EVERY FRAME`, `OF ${big(s.evaluated)} RENDERED`];
}

// ---------------------------------------------------------------- find ----

/** Global index -> (sheet, index on sheet). Indices run sheet by sheet. */
export function locate(job: OfflineJob, index: number): { plane: number; offset: number } {
  if (!Number.isInteger(index) || index < 0) throw new Error("Particle index must be a non-negative integer");
  let left = index;
  for (let p = 0; p < job.planes.length; p++) {
    if (left < job.planes[p].particleCount) return { plane: p, offset: left };
    left -= job.planes[p].particleCount;
  }
  throw new Error(`Particle #${big(index)} does not exist: the world has ${big(totalParticles(job))}`);
}

/**
 * World position of one particle at time t, from the CPU reference of the same
 * closed-form law the GPU evaluates (offline/core/laws.ts). f32 on the GPU vs
 * f64 here differ by far less than the final framing's dot spacing.
 */
export function particlePosition(job: OfflineJob, index: number, t: number): Vec3 {
  const { plane, offset } = locate(job, index);
  const p = job.planes[plane];
  const [lx, ly] = lawPosition(p.law, particleKey(offset, p.seed), t, p.params);
  const q = quatNormalize(p.rotation);
  const ax = scale(quatRotate(q, [1, 0, 0]), p.halfSize[0] * lx);
  const ay = scale(quatRotate(q, [0, 1, 0]), p.halfSize[1] * ly);
  return add(add(p.position, ax), ay);
}

/** Fly from the wide shot to one exact particle and hold on it. */
export function findJob(o: ShotOptions): OfflineJob {
  const world = baseWorld(o, 2);
  const target = particlePosition(world, o.findIndex, world.timeOffset);
  const wide = world.camera[0];
  const close = world.camera[world.camera.length - 1];
  const end = close.distance * 0.25;
  const decades = Math.log10(wide.distance / end);
  const fly = Math.round(decades * 1.5 * o.fps);
  const hold = Math.round(2 * o.fps);
  const frames = fly + hold;
  const tFly = fly / (frames - 1);
  const camera: CameraKey[] = [
    { ...wide, t: 0 },
    { ...close, t: tFly, target, distance: end },
    { ...close, t: 1, target, distance: end },
  ];
  return { ...world, name: `find ${o.findIndex}`, frames, near: end * 0.02, camera };
}

/** Where a world point lands on screen, in output pixels, or null if behind the camera. */
export function project(cam: CameraBasis, p: Vec3, width: number, height: number): { x: number; y: number } | null {
  const v: Vec3 = [p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]];
  const depth = v[0] * cam.forward[0] + v[1] * cam.forward[1] + v[2] * cam.forward[2];
  if (depth <= 0) return null;
  const focal = (0.5 * height) / Math.tan(cam.fovY / 2);
  const rx = v[0] * cam.right[0] + v[1] * cam.right[1] + v[2] * cam.right[2];
  const uy = v[0] * cam.up[0] + v[1] * cam.up[1] + v[2] * cam.up[2];
  return { x: (focal * rx) / depth + width / 2, y: (-focal * uy) / depth + height / 2 };
}

export function findLabel(s: FrameStats, index: number, job: OfflineJob): string[] {
  const { plane, offset } = locate(job, index);
  return [
    `PARTICLE #${big(index)}`,
    `SHEET ${plane}, INDEX ${big(offset)} ON THAT SHEET`,
    `IN VIEW ${big(s.landed)} OF ${big(s.evaluated)} RENDERED (GPU COUNT)`,
  ];
}

// ------------------------------------------------------------ pull-back ----

/**
 * Noah's opening move: start on a single particle and pull back to the whole
 * world while the count climbs (4M, 8.3M, 1B, 1T). Each frame renders a
 * plane-major prefix of the world whose size grows log-uniformly, so the
 * counter is exactly the particles rendered in that frame and only the last
 * frames pay full trillion price. Sum of work is about frames / ln(total)
 * trillion-frames (10 s at 30 fps: about 11).
 */
export function pullBackPasses(o: ShotOptions, seconds = 10): Pass[] {
  const world = baseWorld(o, 2);
  const total = totalParticles(world);
  const dive = diveJob(o);
  const frames = Math.max(2, Math.round(seconds * o.fps));
  const out: Pass[] = [];
  for (let f = 0; f < frames; f++) {
    const s = f / (frames - 1);
    const n = Math.max(1, Math.round(Math.exp(s * Math.log(total))));
    const job = prefixJob(world, Math.min(total, n), `pullback ${f}`);
    // Camera runs the dive backwards: from closest to widest.
    const pose = new CameraPathAt(dive).at(1 - s);
    out.push({ key: `pullback-${String(f).padStart(4, "0")}-`, job: { ...job, near: dive.near, camera: [{ t: 0, ...pose }] }, hold: 1 });
  }
  return out;
}

class CameraPathAt {
  private readonly path: CameraPath;
  constructor(job: OfflineJob) {
    this.path = new CameraPath(job.camera);
  }
  at(t: number): Omit<CameraKey, "t"> {
    return this.path.at(t);
  }
}

export function pullBackLabel(s: FrameStats): string[] {
  return [`PARTICLES RENDERED ${big(s.evaluated)}`, `IN VIEW ${big(s.landed)} (COUNTED ON THE GPU)`, `STATELESS  TIME FROZEN`];
}

// -------------------------------------------------------------- ladder ----

/**
 * The scale ladder: the frozen world at 1M, 100M, 10B and 1T. Rungs above the
 * world's own count are left out and the world's total is always the top rung. Every sheet's count is scaled by the same
 * factor, so the rungs are nested and differ only in grain. Exposure is locked
 * per particle: each rung uses the top rung's white point scaled by its count,
 * so all rungs share one mean brightness. Each rung is held 1.5 s.
 * Cost: one frame per rung, about 1.01 trillion-frames for the default rungs.
 */
export function ladderPasses(o: ShotOptions, counts: readonly number[] = DEFAULT_RUNGS): Pass[] {
  const world = baseWorld(o);
  const total = totalParticles(world);
  const rungs = [...new Set(counts.filter((n) => n >= 1 && n <= total))].sort((a, b) => a - b);
  // The ladder always ends on the whole world, also in a reduced-count preview.
  if (rungs.length === 0 || rungs[rungs.length - 1] < total) rungs.push(total);
  const top = rungs[rungs.length - 1];
  const key = (n: number) => `ladder-${shortCount(n)}-`;
  return rungs.map((n) => ({
    key: key(n),
    job: { ...scaleParticles(world, n), name: `ladder ${shortCount(n)}` },
    hold: Math.max(1, Math.round(o.fps * 1.5)),
    lock: { key: key(top), scale: n / top },
  }));
}

export function ladderLabel(s: FrameStats): string[] {
  return [`PARTICLES RENDERED ${big(s.evaluated)}`, `IN VIEW ${big(s.landed)} (COUNTED ON THE GPU)`, `SAME SHOT, SAME EXPOSURE PER PARTICLE`];
}

// ------------------------------------------------------------ collapse ----

/**
 * The ending: time frozen, the whole world shrinks toward one pixel until
 * every particle lands in it. Each frame scales every sheet's offset from the
 * collapse point and its half size by s, easing in log space from 1 to a world
 * radius of 0.15 pixel, so it is a per-frame job transform and no shader
 * changes. The collapse point is the world point behind the center of pixel
 * (width/2, height/2) at the target's depth, so the end is one pixel, not the
 * four around the image center. In count weighting that pixel ends holding
 * exactly every particle (landed == evaluated, one lit pixel). Exposure is
 * locked to the first frame, so the gathering light clips to white. The last
 * frame is held 2 s and doubles as the video's opening frame.
 * Cost: every frame is a full frame of the world (4 s at 30 fps: 120).
 */
export function collapsePasses(o: ShotOptions, seconds = 4): Pass[] {
  const world = baseWorld(o);
  const pose = new CameraPath(world.camera).at(0);
  const cam = cameraBasis(pose);
  // World size of one pixel at the target's depth (square pixels, see planeHomography).
  const pixel = pose.distance / ((0.5 * world.height) / Math.tan(pose.fovY / 2));
  // Pixel centers sit at half integers: +x is right, +y is down the image.
  const point = add(pose.target, scale(sub(cam.right, cam.up), 0.5 * pixel));
  let reach = 0;
  for (const p of world.planes) {
    const d = sub(p.position, point);
    reach = Math.max(reach, Math.hypot(d[0], d[1], d[2]) + Math.hypot(p.halfSize[0], p.halfSize[1]));
  }
  const end = (0.15 * pixel) / Math.max(reach, 1e-30);
  const frames = Math.max(2, Math.round(seconds * o.fps));
  const key = (f: number) => `collapse-${String(f).padStart(4, "0")}-`;
  const out: Pass[] = [];
  for (let f = 0; f < frames; f++) {
    const u = f / (frames - 1);
    const s = Math.exp(Math.log(end) * u * u * (3 - 2 * u));
    const planes = world.planes.map((p) => ({
      ...p,
      position: add(point, scale(sub(p.position, point), s)),
      halfSize: [p.halfSize[0] * s, p.halfSize[1] * s] as [number, number],
    }));
    out.push({
      key: key(f),
      job: { ...world, name: `collapse ${f}`, planes, camera: [{ t: 0, ...pose }] },
      hold: f === frames - 1 ? Math.max(1, Math.round(o.fps * 2)) : 1,
      lock: { key: key(0), scale: 1 },
    });
  }
  return out;
}

export function collapseLabel(s: FrameStats): string[] {
  const where = s.litPixels === 1 ? "ALL OF THEM IN ONE PIXEL" : `LIT PIXELS ${big(s.litPixels)}`;
  return [`PARTICLES RENDERED ${big(s.evaluated)}`, `IN VIEW ${big(s.landed)} (COUNTED ON THE GPU)`, where];
}
