/**
 * One snapshot of everything the perf HUD shows, and how numbers are worded.
 *
 * The sampler (index.ts) fills a PerfSnapshot a few times a second from the
 * running app; the menu parts (menu.ts, view.ts) only paint what a snapshot
 * says. The demo page paints made-up snapshots through the same code.
 *
 * Honest counting: every count carries where it comes from. `simulated` is
 * the number of particles dispatched to the GPU's simulate pass for the frame
 * (each has stored state and is stepped). `tally` is counted by the GPU
 * itself from the rasterizer's light buffer. `fit` is an estimate and is
 * always worded "about".
 */
import type { FrameSummary } from "./frameStats";
import type { GpuFacts } from "./gpuFacts";
import type { PassTime } from "./passTimer";

/**
 * live     realtime frames are being drawn
 * offline  an offline video render is stepping the world frame by frame, not in real time
 * paused   nothing has been drawn lately (a record render owns the GPU, or the tab was hidden)
 */
export type PerfState = "live" | "offline" | "paused";

/**
 * on           measuring
 * waiting      on, but no reading has come back yet
 * unavailable  the browser does not offer GPU timestamps
 * stopped      a GPU error arrived while timing, so timing was switched off
 */
export type GpuTimingStatus = "on" | "waiting" | "unavailable" | "stopped";

export interface GpuTiming {
  status: GpuTimingStatus;
  /** Smoothed GPU ms per pass, in execution order. Empty unless status is "on". */
  passes: PassTime[];
  /** Sum of `passes`. */
  totalMs: number;
  /** True when a frame began more GPU passes than the timer holds, so the total is a lower bound. */
  truncated: boolean;
}

/**
 * How far a tally's particle counts can be trusted:
 *
 * exact    to the particle: every drawn particle added the same whole amount of light
 * about    right on average: sub-pixel splats round each particle's light at random
 * atLeast  a floor: sheets are drawn at different brightness (fading in, out or
 *          with distance), and no particle added more than the brightest one does
 */
export type TallyBound = "exact" | "about" | "atLeast";

/** What the GPU counted in the rasterizer's light buffer for one frame. */
export interface FrameTally {
  /**
   * Particles that landed inside the frame: the light in the buffer divided
   * by the light one particle adds. Null when depth cues weight every
   * particle differently, because light is then not a count at all.
   */
  inFrame: number | null;
  /** Most particles on a single pixel, or null like `inFrame`. */
  peak: number | null;
  /** What `inFrame` and `peak` are: exact, about, or at least. */
  bound: TallyBound;
  /** Pixels holding any light. */
  litPixels: number;
}

/** What goes in front of a counted number: nothing, "~" or "≥". */
export const boundMark = (bound: TallyBound): string => (bound === "exact" ? "" : bound === "about" ? "~" : "\u2265");

export interface ParticleCounts {
  /** Particles dispatched to the simulate pass this frame: each has stored state and was stepped. */
  simulated: number;
  /** Particles held in GPU memory. */
  stored: number;
  bytesPerParticle: number;
  /** Drawing buffer size in pixels. */
  width: number;
  height: number;
  /** True when the active rasterizer keeps a per-pixel light buffer the GPU can count. */
  countable: boolean;
  /** The GPU's count for a recent frame, or null when there is no buffer to count or no count is back yet. */
  tally: FrameTally | null;
}

export interface PerfSnapshot {
  state: PerfState;
  /** Pacing over the last second (the "now" numbers) and the last five (1% low, worst). Null before any frame. */
  now: FrameSummary | null;
  recent: FrameSummary | null;
  /** Newest frame intervals in ms, oldest first, and how many of them are valid. */
  intervals: Float32Array;
  intervalCount: number;
  /** Frame rate the app aims for. */
  targetFps: number;
  /** The frame rate governor's scale (1 = drawing everything), or null while "hold frame rate" is off. */
  governor: number | null;
  gpu: GpuTiming;
  particles: ParticleCounts;
  /** Estimated particle count that fills a frame at `targetFps`, or null without GPU timing. An estimate. */
  fit: number | null;
  facts: GpuFacts;
  canvasFormat: string;
}

// ---- wording ----------------------------------------------------------------

/** 0.34 ms, 4.1 ms, 16.7 ms, 120 ms. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  return `${ms < 1 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : ms.toFixed(0)} ms`;
}

/** 59.6 becomes "60 fps"; below 10 one decimal is kept. */
export function formatFps(fps: number): string {
  if (!Number.isFinite(fps)) return "-";
  return `${fps < 9.95 ? fps.toFixed(1) : Math.round(fps)} fps`;
}

/** 0.253 becomes "25%"; under 1% reads "<1%". */
export function formatShare(share: number): string {
  if (!Number.isFinite(share)) return "-";
  const pct = share * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/** Decimal units, as docs/perf.md counts memory: 128 MB, 3.2 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** GPU time per frame as a share of the frame interval, 0..1 and beyond when the GPU is the limit. */
export function gpuLoad(snapshot: PerfSnapshot): number | null {
  const { gpu, now } = snapshot;
  if (gpu.status !== "on" || snapshot.state !== "live" || !now) return null;
  return gpu.totalMs / now.avgMs;
}

/** Particles stepped per second: simulated per frame times the measured frame rate. Null unless live. */
export function particlesPerSecond(snapshot: PerfSnapshot): number | null {
  if (snapshot.state !== "live" || !snapshot.now) return null;
  return snapshot.particles.simulated * snapshot.now.fps;
}
