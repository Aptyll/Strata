/**
 * How many particles this GPU could step and draw inside one frame at a
 * target frame rate. An estimate from measured GPU time, never a measurement:
 * anything that shows it must say "about".
 *
 * The passes that touch every particle (simulate, plane crossings, rasterize)
 * take time in proportion to the particle count. The rest of the frame (tone
 * mapping, bloom) costs the same however many particles there are. So
 *
 *   fit = particles now x (budget - fixed GPU time - script time) / per-particle GPU time
 *
 * where the budget is a share of the target frame, leaving room for the
 * browser's own work and for frames that run long. One reading extrapolated
 * a long way is fragile (the timer steps in 0.1 ms, and an idle GPU clocks
 * down), so a single estimate never moves further than `maxStep` times the
 * current count. Asking again after the world was resized refines it.
 */
import type { PassStage } from "../../core/contracts";
import type { PassTime } from "./passTimer";

/** Stages whose GPU time grows with the particle count. */
export const SCALING_STAGES: readonly PassStage[] = ["simulate", "interplane", "rasterize"];

export interface FitInput {
  /** Particles stepped and drawn in the measured frames. */
  particles: number;
  /** GPU milliseconds per frame, per pass. */
  passes: readonly PassTime[];
  /** Script milliseconds per frame. */
  cpuMs: number;
  targetFps: number;
}

export interface FitOptions {
  /** Share of the target frame to fill. Default 0.85. */
  fill?: number;
  /** Largest change in one estimate, as a factor up or down. Default 8. */
  maxStep?: number;
  /** Smallest per-particle GPU time trusted, in ms: the timer's step. Default 0.1. */
  resolutionMs?: number;
}

/** The estimate, rounded to two digits, or null when there is nothing to estimate from. */
export function particlesThatFit(input: FitInput, options: FitOptions = {}): number | null {
  const { fill = 0.85, maxStep = 8, resolutionMs = 0.1 } = options;
  if (!(input.particles > 0) || !(input.targetFps > 0) || input.passes.length === 0) return null;
  let scaling = 0;
  let fixed = 0;
  for (const p of input.passes) {
    if (SCALING_STAGES.includes(p.stage)) scaling += p.ms;
    else fixed += p.ms;
  }
  const room = (1000 / input.targetFps) * fill - fixed - Math.max(0, input.cpuMs);
  // Below the timer's step the per-particle time is mostly rounding; treat it as one step, which errs low.
  const factor = Math.min(maxStep, Math.max(1 / maxStep, room / Math.max(scaling, resolutionMs)));
  return Number((input.particles * factor).toPrecision(2));
}
