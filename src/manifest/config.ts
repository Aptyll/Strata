/**
 * Record config: the committed recipe of a record render (proof/*.json).
 *
 * It names the world with the same settings as the app's ?record URL
 * (src/record), so both build the same OfflineJob, and it can pin the camera
 * path. `npm run record -- job <config>` writes the job into a folder; the
 * offline page (/src/offline/web/) renders a folder's job when you choose it.
 * The manifest of that render embeds the exact job and its SHA-256, so a
 * published record stays checkable even if the world generator changes later.
 *
 * Batch size and work per invocation are not part of the config: integer
 * accumulation makes a frame bit-identical however it is batched.
 */
import { validateJob, type CameraKey, type OfflineJob, type SplatMode, type Weighting } from "../offline/core/job";
import { PRESETS, clusterJob } from "../offline/core/world";

export const RECORD_FORMAT = "strata-record/1";

/** Same fields and meaning as RecordSettings in src/record, all explicit. */
export interface RecordWorld {
  /** Particles per frame, every one evaluated every frame. */
  particles: number;
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** Sheets the particles are split over (at most 2^32 - 1 particles each). */
  planes: number;
  /** The public seed: sheet layout, laws, and every particle's identity. */
  seed: number;
  /** "count": every particle in frame adds exactly one unit of light. */
  weighting: Weighting;
  splat: SplatMode;
}

export interface RecordConfig {
  format: typeof RECORD_FORMAT;
  title: string;
  description?: string;
  world: RecordWorld;
  /** Fixed camera path. When present it replaces the generated shot. */
  camera?: CameraKey[];
}

/** 1e12 -> "1T", as src/record names its jobs. */
export function shortCount(n: number): string {
  for (const [d, s] of [[1e12, "T"], [1e9, "B"], [1e6, "M"]] as const) if (n >= d) return `${+(n / d).toFixed(2)}${s}`;
  return String(n);
}

/** The job name src/record gives the same settings. */
export function recordName(w: RecordWorld): string {
  return `record-${shortCount(w.particles)}-${w.width}x${w.height}-${w.frames}f`;
}

/**
 * The OfflineJob a config renders. Mirrors the cluster branch of recordJob()
 * in src/record/run.ts (clusterJob over PRESETS.trillion with the settings as
 * overrides), which cannot be imported here because that module pulls in
 * browser-only code. A drift between the two shows up as a different job
 * SHA-256 in the manifests.
 */
export function expandJob(config: RecordConfig): OfflineJob {
  const w = config.world;
  const job = clusterJob({
    ...PRESETS.trillion,
    name: recordName(w),
    width: w.width,
    height: w.height,
    fps: w.fps,
    frames: w.frames,
    particles: w.particles,
    planes: w.planes,
    seed: w.seed,
    weighting: w.weighting,
    splat: w.splat,
  });
  if (config.camera) {
    // Same key order as the generated camera, so an unchanged path gives byte-identical job JSON.
    job.camera = config.camera.map((k) => ({
      t: k.t,
      target: [k.target[0], k.target[1], k.target[2]],
      yaw: k.yaw,
      pitch: k.pitch,
      distance: k.distance,
      fovY: k.fovY,
    }));
  }
  validateJob(job);
  return job;
}

/** Throws a readable error for anything a hand-edited config can get wrong. */
export function validateConfig(value: unknown): RecordConfig {
  const fail = (m: string): never => {
    throw new Error(`Invalid record config: ${m}`);
  };
  if (!value || typeof value !== "object") fail("not a JSON object");
  const c = value as RecordConfig;
  if (c.format !== RECORD_FORMAT) fail(`format must be "${RECORD_FORMAT}"`);
  if (typeof c.title !== "string" || !c.title) fail("title is required");
  const w = c.world;
  if (!w || typeof w !== "object") fail("world is required");
  for (const k of ["particles", "width", "height", "frames", "planes"] as const) {
    if (!Number.isSafeInteger(w[k]) || w[k] <= 0) fail(`world.${k} must be a positive integer`);
  }
  if (!(typeof w.fps === "number" && w.fps > 0)) fail("world.fps must be positive");
  if (!Number.isInteger(w.seed) || w.seed < 0 || w.seed > 0xffffffff) fail("world.seed must be an integer in [0, 2^32 - 1]");
  if (w.weighting !== "count" && w.weighting !== "flux") fail('world.weighting must be "count" or "flux"');
  if (w.splat !== "point" && w.splat !== "bilinear") fail('world.splat must be "point" or "bilinear"');
  if (c.camera !== undefined) {
    if (!Array.isArray(c.camera) || c.camera.length === 0) fail("camera must be a non-empty array of keys");
    c.camera.forEach((k, i) => {
      const target = Array.isArray(k?.target) ? k.target : [];
      const nums = [k?.t, k?.yaw, k?.pitch, k?.distance, k?.fovY, ...target];
      if (target.length !== 3 || !nums.every((v) => typeof v === "number" && Number.isFinite(v))) {
        fail(`camera[${i}] needs finite t, target [x, y, z], yaw, pitch, distance and fovY`);
      }
    });
  }
  return c;
}
