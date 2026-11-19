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
export type CoreLawId = "kepler" | "vortex" | "lissajous";
/** Laws from src/stateless/laws, by their id there. */
export type StatelessLawId = "veil" | "galaxy" | "web" | "ribbons";
export type LawId = CoreLawId | StatelessLawId;
export const LAW_IDS: readonly LawId[] = ["kepler", "vortex", "lissajous", "veil", "galaxy", "web", "ribbons"];

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
  /** Law time (seconds) per second of video. Rendered, not simulated: motion is closed-form. */
  timeScale: number;
  /** Law time at frame 0, in seconds. */
  timeOffset: number;
  /** Supersampling factor per axis. The accumulation grid is ssaa times larger. */
  ssaa: number;
  /** "point": 1 atomic add per particle. "bilinear": 4, weights sum exactly to one. */
  splat: SplatMode;
  /**
   * "count": every particle adds exactly ONE. The buffer sum is then an exact
   * count of the particles in view.
   * "flux": a particle adds min(1, (fluxRef / depth)^2) of a particle's light,
   * like a point light of fixed luminosity. The weight is an integer number of
   * units of 2^-fluxBits of a particle, rounded at random (unbiased).
   */
  weighting: Weighting;
  /** Depth (world units) inside which a particle is at full weight in flux mode. */
  fluxRef: number;
  /**
   * Flux mode only: the finest weight unit asked for, as a power of two. A
   * particle at full weight adds 2^fluxBits units (see fluxBitsUsed() for what a
   * job gets). Absent means 16, the first renders' behaviour: a particle
   * dimmer than 1/65536 was rounded at random to one unit or to nothing, so in
   * a wide shot most particles in view added no light and the picture was
   * drawn by a random fraction of them. The job builders ask for
   * MAX_FLUX_BITS, with which every particle in view adds light down to a
   * weight of 2^-fluxBitsUsed(job).
   */
  fluxBits?: number;
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
  /**
   * Optional off-axis window (the proof loupe). Project as if the frame were
   * `width` x `height` pixels, then stretch the rectangle [x0, x1) x [y0, y1)
   * of that frame over the whole output. Particles land in the output exactly
   * when they land in that rectangle of the reference frame, so a window of one
   * reference pixel holds that pixel's particles. Absent: the normal frame.
   */
  window?: ProjectionWindow;
  /**
   * Optional single-pixel selection (the proof loupe, exact). Project with the
   * camera as a `width` x `height` reference frame, keep only the particles
   * whose reference pixel is exactly (x, y), by the same float operations and
   * u32 floor the reference frame uses, and place each kept particle in the
   * output by its position inside that pixel. With the offline kernel and point
   * splats, the landed tally then equals that pixel's count in the reference
   * frame exactly. Grid pixels (ssaa included).
   */
  select?: PixelSelect;
}

export interface PixelSelect {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface ProjectionWindow {
  /** Reference frame size in pixels (the main view the window is cut from). */
  width: number;
  height: number;
  /** Rectangle in reference-frame pixels, x0 < x1, y0 < y1. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * One unit of light: what a particle adds to the 64-bit accumulator in count
 * mode. Stored frames, exposure and the grade are all in these units.
 */
export const ONE = 65536;

/** The shader's weights are u32, so a full-weight particle can add at most 2^31. */
export const MAX_FLUX_BITS = 31;

/** Most particles a job can hold: 2^47 of them at ONE each still fit 2^63. */
export const MAX_PARTICLES = 2 ** 47;

export function totalParticles(job: OfflineJob): number {
  let n = 0;
  for (const p of job.planes) n += p.particleCount;
  return n;
}

/**
 * Bits of a flux weight below one particle that this job's accumulator uses:
 * what the job asks for, lowered until the whole world at full weight in a
 * single pixel still fits the 64-bit accumulator with a bit to spare
 * (particles * 2^bits <= 2^63). A trillion particles get 23 bits, so a
 * particle 8 million times dimmer than a near one still adds a whole unit.
 * A pure function of the job: every batch, resume and machine agrees on it.
 */
export function fluxBitsUsed(job: OfflineJob): number {
  let bits = Math.min(job.fluxBits ?? 16, MAX_FLUX_BITS);
  const total = totalParticles(job);
  while (bits > 16 && total * 2 ** bits > 2 ** 63) bits--;
  return bits;
}

/**
 * Units a particle at full weight adds to the accumulator: ONE in count mode,
 * 2^fluxBitsUsed(job) in flux mode. Divide a grid value by this for particles of
 * light. develop() brings every frame back to ONE units.
 */
export function unitsPerParticle(job: OfflineJob): number {
  return job.weighting === "flux" ? 2 ** fluxBitsUsed(job) : ONE;
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
  if (job.fluxBits !== undefined && !(Number.isInteger(job.fluxBits) && job.fluxBits >= 16 && job.fluxBits <= MAX_FLUX_BITS)) {
    fail(`fluxBits must be an integer from 16 to ${MAX_FLUX_BITS}`);
  }
  if (job.planes.length === 0) fail("no planes");
  if (job.camera.length === 0) fail("no camera keys");
  job.planes.forEach((p, i) => {
    if (!Number.isInteger(p.particleCount) || p.particleCount < 0 || p.particleCount > 0xffffffff)
      fail(`plane ${i}: particleCount must be an integer in [0, 2^32 - 1]`);
    if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xffffffff) fail(`plane ${i}: seed must be a u32`);
    if (p.params.length !== LAW_PARAM_COUNT) fail(`plane ${i}: params must have ${LAW_PARAM_COUNT} entries`);
    if (!LAW_IDS.includes(p.law)) fail(`plane ${i}: unknown law ${p.law}`);
  });
  // Past this the 64-bit accumulator could wrap if everything landed in one pixel.
  if (totalParticles(job) > MAX_PARTICLES) fail("more than 2^47 particles do not fit the 64-bit accumulator");
  // Distinct seeds give every sheet its own particle identities.
  const seeds = new Set(job.planes.map((p) => p.seed));
  if (seeds.size !== job.planes.length) fail("plane seeds must be unique");
  if (job.select) {
    const q = job.select;
    if (job.window) fail("select and window cannot be combined");
    if (job.splat !== "point") fail("select needs point splats");
    if (![q.width, q.height].every((v) => Number.isInteger(v) && v > 0)) fail("select width and height must be positive integers");
    if (!(Number.isInteger(q.x) && Number.isInteger(q.y) && q.x >= 0 && q.y >= 0 && q.x < q.width && q.y < q.height))
      fail("select pixel must be inside the reference frame");
  }
  if (job.window) {
    const w = job.window;
    if (!(w.width > 0 && w.height > 0)) fail("window width and height must be positive");
    if (!(w.x1 > w.x0 && w.y1 > w.y0)) fail("window needs x0 < x1 and y0 < y1");
  }
  for (let i = 1; i < job.camera.length; i++) {
    if (!(job.camera[i].t > job.camera[i - 1].t)) fail("camera keys must have increasing t");
  }
}
