/**
 * World and shot generator: a cluster of sheets in the void and one camera
 * move that starts with every particle in frame and ends close enough to one
 * sheet that single particles resolve.
 *
 * Everything is derived from the seed, so a job is reproducible from a few
 * numbers. The expanded job (all planes, all camera keys) is plain JSON.
 */
import type { Quat, Vec3 } from "../../core/contracts";
import type { CameraKey, LawId, OfflineJob, OfflinePlane, SplatMode, Weighting } from "./job";
import { pcg } from "./laws";

export interface ClusterOptions {
  name: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** Total particles in the world, split evenly over the planes. */
  particles: number;
  planes: number;
  seed?: number;
  ssaa?: number;
  splat?: SplatMode;
  weighting?: Weighting;
  timeScale?: number;
  shutter?: number;
}

/** Small deterministic generator for world layout (not used per particle). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    return (pcg(s) >>> 8) / 16777216;
  };
}

export function randomRotation(r: () => number): Quat {
  // Uniform random rotation (Shoemake).
  const u1 = r();
  const u2 = r() * Math.PI * 2;
  const u3 = r() * Math.PI * 2;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

export function lawParams(law: LawId, r: () => number): number[] {
  switch (law) {
    case "kepler":
      // [ecc, twist, innerRadius, concentration, rate, orientScatter, eccScatter, _]
      return [mix(0.12, 0.38, r()), mix(1.5, 5, r()) * (r() < 0.5 ? -1 : 1), mix(0.02, 0.08, r()), mix(0.8, 1.6, r()), mix(0.02, 0.05, r()), mix(0.05, 0.35, r()), mix(0, 0.06, r()), 0];
    case "vortex":
      // [bands, fill, circulation, coreRadius, extent, _, _, _]
      return [Math.floor(mix(5, 24, r())), mix(0.3, 0.9, r()), mix(0.15, 0.5, r()) * (r() < 0.5 ? -1 : 1), mix(0.12, 0.4, r()), 0.7, 0, 0, 0];
    case "lissajous":
      // [freqX, freqY, shells, thickness, rateX, rateY, shellPhase, extent]
      return [Math.floor(mix(1, 6, r())), Math.floor(mix(1, 6, r())), Math.floor(mix(3, 14, r())), mix(0.01, 0.06, r()), mix(0.1, 0.4, r()), mix(0.1, 0.4, r()), mix(0, 0.5, r()), 0.92];
  }
}

export function clusterJob(o: ClusterOptions): OfflineJob {
  const seed = o.seed ?? 1;
  const r = rng(seed);
  const n = o.planes;
  const base = Math.floor(o.particles / n);
  const extra = o.particles - base * n;
  if (base + 1 > 0xffffffff) {
    throw new Error(`${o.particles} particles over ${n} planes exceeds 2^32 - 1 per plane. Use more planes.`);
  }

  // Sheets fill a flattened ellipsoid whose radius grows with their number, so
  // the cluster keeps the same density however many sheets there are.
  const radius = 6 * Math.cbrt(n);
  const heroHalf = 3;
  const planes: OfflinePlane[] = [];
  for (let i = 0; i < n; i++) {
    const hero = i === 0;
    const pick = r();
    const law: LawId = hero ? "kepler" : pick < 0.5 ? "kepler" : pick < 0.75 ? "vortex" : "lissajous";
    // Uniform in a ball, squashed along Y, pushed away from the hero sheet.
    const dir = randomRotation(r);
    const rad = radius * mix(0.12, 1, Math.cbrt(r()));
    const position: Vec3 = hero ? [0, 0, 0] : [dir[0] * rad, dir[1] * rad * 0.55, dir[2] * rad];
    const size = hero ? heroHalf : mix(0.7, 2.2, r() * r());
    const params = lawParams(law, r);
    if (hero) {
      params[0] = 0.3;
      params[1] = 3.2;
      params[2] = 0.03;
      params[3] = 1.1;
      params[4] = 0.03;
      params[5] = 0.22;
      params[6] = 0.03;
    }
    planes.push({
      position,
      rotation: hero ? [0, 0, 0, 1] : randomRotation(r),
      halfSize: [size, size],
      law,
      // Math.imul, not *: past seed 4,010,000 the float product loses its low
      // bits and sheets share seeds (the job then fails validation). Identical
      // for smaller seeds, so existing jobs keep their particles.
      seed: pcg((Math.imul(seed, 0x85ebca6b) + i) >>> 0),
      particleCount: base + (i < extra ? 1 : 0),
      params,
    });
  }

  // The shot. It ends over a spot on the hero sheet, close enough that the
  // local density is about one particle per 20 pixels.
  const fovY = (40 * Math.PI) / 180;
  const tanHalf = Math.tan(fovY / 2);
  const aspect = o.width / o.height;
  const wide = (radius * 1.15) / (tanHalf * Math.min(1, aspect));
  const heroCount = planes[0].particleCount;
  const density = heroCount / (Math.PI * (heroHalf * 0.6) ** 2); // particles per world unit^2, roughly
  const pixel = Math.sqrt(0.05 / Math.max(density, 1e-9)); // world size of a pixel at the end
  const close = Math.min((pixel * o.height) / (2 * tanHalf), heroHalf * 0.5);
  const spot: Vec3 = [heroHalf * 0.33, heroHalf * 0.12, 0];
  const camera: CameraKey[] = [
    { t: 0, target: [0, 0, 0], yaw: -0.5, pitch: -0.18, distance: wide, fovY },
    { t: 0.4, target: [0, 0, 0], yaw: 0.25, pitch: -0.3, distance: wide * 0.4, fovY },
    { t: 0.68, target: [spot[0] * 0.5, spot[1] * 0.5, 0], yaw: 0.75, pitch: -0.5, distance: heroHalf * 2.6, fovY },
    { t: 0.86, target: spot, yaw: 0.98, pitch: -0.62, distance: Math.sqrt(heroHalf * 2.6 * close), fovY },
    { t: 1, target: spot, yaw: 1.08, pitch: -0.66, distance: close, fovY },
  ];

  return {
    version: 1,
    name: o.name,
    width: o.width,
    height: o.height,
    fps: o.fps,
    frames: o.frames,
    timeScale: o.timeScale ?? 1,
    timeOffset: 40,
    ssaa: o.ssaa ?? 1,
    splat: o.splat ?? (o.particles > 2e10 ? "point" : "bilinear"),
    weighting: o.weighting ?? "flux",
    // Full weight once the camera is within a few times the final distance.
    fluxRef: close * 4,
    shutter: o.shutter ?? 0.5,
    near: close * 0.02,
    planes,
    camera,
  };
}

/** Named starting points. Every field can be overridden from the runner. */
export const PRESETS: Record<string, ClusterOptions> = {
  /** Seconds on any machine. For checking that the pipeline works. */
  smoke: { name: "smoke", width: 640, height: 360, fps: 30, frames: 12, particles: 4_000_000, planes: 24 },
  /** A quick look at the shot. */
  preview: { name: "preview", width: 1280, height: 720, fps: 30, frames: 150, particles: 200_000_000, planes: 128 },
  /** One billion particles, 4K60, 30 seconds. */
  billion: { name: "billion", width: 3840, height: 2160, fps: 60, frames: 1800, particles: 1_000_000_000, planes: 256 },
  /** Ten billion. */
  ten_billion: { name: "ten_billion", width: 3840, height: 2160, fps: 60, frames: 1800, particles: 10_000_000_000, planes: 512 },
  /** One trillion particles, every one evaluated every frame. */
  trillion: { name: "trillion", width: 3840, height: 2160, fps: 60, frames: 600, particles: 1_000_000_000_000, planes: 1024 },
};
