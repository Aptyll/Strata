/**
 * Scale ladder: one shot rendered at increasing particle counts.
 *
 * A ladder freezes one frame of a job (its camera pose and world time baked
 * into a one-frame job), then rescales every sheet's particle count. Sheets,
 * seeds, laws, camera, splat and weighting stay identical, so the rungs differ
 * only in how many particles are drawn. Side by side they show what more
 * particles buy (the same structure, finer grain), and the time each rung
 * takes measures throughput at that scale on the machine that renders it.
 *
 * Pure functions, no GPU. The Node runner's `ladder` command drives them.
 */
import { CameraPath } from "./camera";
import { totalParticles, type OfflineJob } from "./job";

/** The video's ladder: a million, a hundred million, ten billion, a trillion. */
export const DEFAULT_RUNGS: readonly number[] = [1e6, 1e8, 1e10, 1e12];

/** 1e6 -> "1M", 1e10 -> "10B", 1e12 -> "1T". Falls back to the plain number. */
export function shortCount(n: number): string {
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [v, s] of units) if (n >= v && n % v === 0) return `${n / v}${s}`;
  return String(n);
}

/**
 * A one-frame job that renders exactly what frame `frame` of `job` shows: the
 * same camera pose, the same world time and the same shutter.
 */
export function freezeFrame(job: OfflineJob, frame: number): OfflineJob {
  if (!Number.isInteger(frame) || frame < 0 || frame >= job.frames) {
    throw new Error(`Frame ${frame} is outside the clip (0 to ${job.frames - 1}).`);
  }
  const pose = new CameraPath(job.camera).atFrame(frame, job.frames);
  return {
    ...job,
    frames: 1,
    timeOffset: job.timeOffset + (frame / job.fps) * job.timeScale,
    camera: [{ t: 0, ...pose }],
  };
}

/**
 * The same job with exactly `total` particles, split over the sheets in
 * proportion to their current counts. Integer arithmetic with largest
 * remainders, so the split is exact and deterministic at any scale.
 */
export function scaleParticles(job: OfflineJob, total: number): OfflineJob {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`Particle count must be a whole number, got ${total}.`);
  const current = totalParticles(job);
  if (!(current > 0)) throw new Error("The job has no particles to scale.");
  const P = BigInt(current);
  const T = BigInt(total);
  const products = job.planes.map((p) => BigInt(p.particleCount) * T);
  const counts = products.map((v) => v / P);
  const remainders = products.map((v) => v % P);
  // Fewer than one particle per sheet is left over; give it to the largest remainders.
  const left = Number(T - counts.reduce((s, c) => s + c, 0n));
  const order = remainders
    .map((_, i) => i)
    .sort((a, b) => (remainders[b] > remainders[a] ? 1 : remainders[b] < remainders[a] ? -1 : a - b));
  for (let k = 0; k < left; k++) counts[order[k]] += 1n;
  const planes = job.planes.map((p, i) => {
    const n = Number(counts[i]);
    if (n > 0xffffffff) {
      throw new Error(`${total} particles puts ${n} on sheet ${i}, above 2^32 - 1 per sheet. Use more planes.`);
    }
    return { ...p, particleCount: n };
  });
  return { ...job, planes };
}

export interface LadderStep {
  /** Particles in this rung. */
  count: number;
  /** Short name, for folders and file names: "1M", "10B", "1T". */
  label: string;
  job: OfflineJob;
}

/** One job per rung, all showing frame `frame` of `job`. */
export function ladderJobs(job: OfflineJob, frame: number, rungs: readonly number[] = DEFAULT_RUNGS): LadderStep[] {
  if (rungs.length === 0) throw new Error("A ladder needs at least one rung.");
  const still = freezeFrame(job, frame);
  return rungs.map((count) => {
    const label = shortCount(count);
    return { count, label, job: { ...scaleParticles(still, count), name: `${job.name}-f${frame}-${label}` } };
  });
}

/** What one rung measured. */
export interface RungResult {
  label: string;
  count: number;
  /** GPU wall seconds for the frame, from the frame stats. */
  seconds: number;
  /** Exact particles that landed in frame, decimal string. */
  landed: string;
  litPixels: number;
  /** Still image file name, relative to the ladder folder. */
  still: string;
  /**
   * White point the still was graded with, in particles per pixel. Set when
   * exposure is locked (white scales with the count); absent for auto exposure.
   */
  white?: number;
}

export interface LadderReport {
  job: string;
  frame: number;
  width: number;
  height: number;
  adapter: string;
  splat: string;
  weighting: string;
  rungs: (RungResult & { particlesPerSecond: number })[];
  /** Extrapolated from the largest rung, which has the least fixed overhead. */
  projection: { particlesPerSecond: number; trillionFrameSeconds: number; clips: { label: string; seconds: number }[] };
}

const commas = (n: number | string): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function duration(s: number): string {
  if (!Number.isFinite(s)) return "?";
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  if (s < 90) return `${s.toFixed(1)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

/** Throughput per rung plus what the largest rung implies for full clips. */
export function ladderReport(job: OfflineJob, frame: number, adapter: string, results: RungResult[]): LadderReport {
  const rungs = results.map((r) => ({ ...r, particlesPerSecond: r.seconds > 0 ? r.count / r.seconds : 0 }));
  const top = rungs.reduce((a, b) => (b.count > a.count ? b : a), rungs[0]);
  const rate = top?.particlesPerSecond ?? 0;
  const frameSeconds = rate > 0 ? 1e12 / rate : Infinity;
  const clips: [string, number][] = [
    ["1T, 10 s at 60 fps (600 frames)", 600],
    ["1T, 10 s at 30 fps (300 frames)", 300],
    ["1T, 5 s at 30 fps (150 frames)", 150],
  ];
  return {
    job: job.name,
    frame,
    width: job.width,
    height: job.height,
    adapter,
    splat: job.splat,
    weighting: job.weighting,
    rungs,
    projection: {
      particlesPerSecond: rate,
      trillionFrameSeconds: frameSeconds,
      clips: clips.map(([label, frames]) => ({ label, seconds: frameSeconds * frames })),
    },
  };
}

/** The report as a short Markdown page, for pasting into docs or a thread. */
export function ladderMarkdown(r: LadderReport): string {
  const lines = [
    `# Scale ladder: ${r.job}, frame ${r.frame}`,
    "",
    `${r.width} x ${r.height}, ${r.splat} splat, ${r.weighting} weighting. Adapter: ${r.adapter}.`,
    "Same sheets, seeds, camera and time on every rung; only the particle count changes.",
    r.rungs.every((g) => g.white !== undefined)
      ? "Exposure is locked per particle: each rung's white point is the largest rung's, scaled by its count, so the rungs share one mean brightness and differ only in grain."
      : "Exposure is automatic per rung.",
    "",
    "| rung | particles | GPU time | particles per second | landed in frame | lit pixels | still |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...r.rungs.map(
      (g) =>
        `| ${g.label} | ${commas(g.count)} | ${duration(g.seconds)} | ${(g.particlesPerSecond / 1e9).toFixed(2)} B/s | ${commas(g.landed)} | ${commas(g.litPixels)} | ${g.still} |`,
    ),
    "",
    `Small rungs are dominated by fixed overhead, so their rate understates the GPU. At the largest rung's ${(r.projection.particlesPerSecond / 1e9).toFixed(2)} B/s, one trillion-particle frame takes ${duration(r.projection.trillionFrameSeconds)}:`,
    "",
    ...r.projection.clips.map((c) => `- ${c.label}: ${duration(c.seconds)}`),
    "",
  ];
  return lines.join("\n");
}
