/**
 * Offline render job: everything needed to reproduce a clip, as plain JSON.
 *
 * The offline renderer is standalone. It borrows only the math and camera
 * types from the shared contracts so that a camera pose or a plane transform
 * means the same thing here as in the realtime app.
 */
import type { Quat, Vec2, Vec3 } from "../../core/contracts";

/**
 * Closed-form laws of motion. A particle has no stored state: its position is
 * a pure function of (plane seed, particle index, time), re-evaluated from
 * scratch every frame. See laws.ts for the equations.
 */
export type LawId = "kepler" | "vortex" | "lissajous";

/** Each law reads up to 8 floats. Same cap as MAX_BEHAVIOR_PARAMS. */
export const LAW_PARAM_COUNT = 8;

export interface OfflinePlane {
  position: Vec3;
  /** xyzw. */
  rotation: Quat;
  /** Half extents in world units. Particles live in [-1, 1]^2 locally. */
  halfSize: Vec2;
  law: LawId;
  /** Unsigned 32-bit integer. */
  seed: number;
  /** Particles on this sheet, at most 2^32 - 1. */
  particleCount: number;
  /** LAW_PARAM_COUNT floats, meaning depends on the law. */
  params: number[];
}

/** One camera pose on the path. Same fields as the contract's CameraState. */
export interface CameraKey {
  /** Position on the timeline, 0 (first frame) to 1 (last frame). */
  t: number;
  target: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
  /** Vertical field of view in radians. */
  fovY: number;
}

export type SplatMode = "point" | "bilinear";
export type Weighting = "count" | "flux";

export interface OfflineJob {
  version: 1;
  name: string;
  /** Output size in pixels. */
  width: number;
  height: number;
  fps: number;
  /** Number of frames in the clip. */
  frames: number;
  /** Simulated seconds per second of video. */
  timeScale: number;
  /** Simulated time at frame 0, in seconds. */
  timeOffset: number;
  /** Supersampling factor per axis. The accumulation grid is ssaa times larger. */
  ssaa: number;
  /** "point": 1 atomic add per particle. "bilinear": 4, weights sum exactly to one. */
  splat: SplatMode;
  /**
   * "count": every particle adds exactly ONE. The buffer sum is then an exact
   * count of the particles in view.
   * "flux": a particle adds ONE * min(1, (fluxRef / depth)^2), like a point
   * light of fixed luminosity, with unbiased stochastic rounding.
   */
  weighting: Weighting;
  /** Depth (world units) inside which a particle is at full weight in flux mode. */
  fluxRef: number;
  /**
   * Shutter open time as a fraction of the frame interval. Each particle is
   * evaluated at its own fixed instant inside the shutter window, so motion
   * blur emerges from the ensemble at no extra cost. 0 disables it.
   */
  shutter: number;
  /** Particles closer than this depth are clipped. */
  near: number;
  planes: OfflinePlane[];
  camera: CameraKey[];
}

/** One unit of light. A particle at full weight adds this to the 64-bit accumulator. */
export const ONE = 65536;

export function totalParticles(job: OfflineJob): number {
  let n = 0;
  for (const p of job.planes) n += p.particleCount;
  return n;
}

export function validateJob(job: OfflineJob): void {
  const fail = (m: string): never => {
    throw new Error(`Invalid offline job: ${m}`);
  };
  if (job.version !== 1) fail("version must be 1");
  const posInt = (v: number, name: string) => {
    if (!Number.isInteger(v) || v <= 0) fail(`${name} must be a positive integer`);
  };
  posInt(job.width, "width");
  posInt(job.height, "height");
  posInt(job.frames, "frames");
  posInt(job.ssaa, "ssaa");
  if (job.width % 2 || job.height % 2) fail("width and height must be even (yuv420 video)");
  if (!(job.fps > 0)) fail("fps must be positive");
  if (job.splat !== "point" && job.splat !== "bilinear") fail("splat must be point or bilinear");
  if (job.weighting !== "count" && job.weighting !== "flux") fail("weighting must be count or flux");
  if (!(job.shutter >= 0 && job.shutter <= 1)) fail("shutter must be in [0, 1]");
  if (!(job.near > 0)) fail("near must be positive");
  if (job.weighting === "flux" && !(job.fluxRef > 0)) fail("fluxRef must be positive");
  if (job.planes.length === 0) fail("no planes");
  if (job.camera.length === 0) fail("no camera keys");
  job.planes.forEach((p, i) => {
    if (!Number.isInteger(p.particleCount) || p.particleCount < 0 || p.particleCount > 0xffffffff)
      fail(`plane ${i}: particleCount must be an integer in [0, 2^32 - 1]`);
    if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xffffffff) fail(`plane ${i}: seed must be a u32`);
    if (p.params.length !== LAW_PARAM_COUNT) fail(`plane ${i}: params must have ${LAW_PARAM_COUNT} entries`);
    if (p.law !== "kepler" && p.law !== "vortex" && p.law !== "lissajous") fail(`plane ${i}: unknown law ${p.law}`);
  });
  for (let i = 1; i < job.camera.length; i++) {
    if (!(job.camera[i].t > job.camera[i - 1].t)) fail("camera keys must have increasing t");
  }
}
