/**
 * ParticleBudget for the shared engine (src/core/contracts.ts).
 *
 * Two rules:
 *
 *  1. Density cap, every frame. A plane never needs more particles than a
 *     target density times the pixels it covers. Beyond that, extra particles
 *     land on pixels that are already bright. Culled planes get zero.
 *  2. Frame rate governor, one step every `stepSeconds`. One global scale in
 *     (0, 1] multiplies every plane's allocation. It backs off quickly when
 *     fps drops under the target and recovers slowly, so the count settles
 *     near the highest the machine holds.
 *
 * Particles are stored in random order, so using the first `activeCount`
 * of a plane is an unbiased thinning of the same picture.
 */

import type { BudgetInput, ParticleBudget } from '../core/contracts';

export interface PerfBudgetOptions {
  /** Target particles per covered pixel. */
  pixelDensity?: number;
  /** Lowest share of its capacity a visible plane may drop to. */
  minFraction?: number;
  /** Lowest value of the global governor scale. */
  minScale?: number;
  /** Drawing buffer size in pixels. Update with setViewport on resize. */
  width?: number;
  height?: number;
  /**
   * Seconds between governor steps. Keep it at least twice the window the
   * caller averages fps over, so every step reads a frame rate measured
   * entirely after the step before it. Default 0.5 (src/main.ts averages
   * over 0.25 s).
   */
  stepSeconds?: number;
  /** Clock in milliseconds. Default `performance.now`; tests pass their own. */
  now?: () => number;
}

/** Largest cut in one governor step. */
const MAX_CUT = 0.8;
/** Growth per governor step while the target holds: about 10% a second at the default step. */
const PROBE_GROWTH = 1.05;

export class PerfBudget implements ParticleBudget {
  pixelDensity: number;
  minFraction: number;
  minScale: number;
  stepSeconds: number;
  /** Governor output, 1 = no throttling. */
  scale = 1;

  private pixels: number;
  private readonly now: () => number;
  private lastStep = -Infinity;

  constructor(o: PerfBudgetOptions = {}) {
    this.pixelDensity = o.pixelDensity ?? 4;
    this.minFraction = o.minFraction ?? 1 / 64;
    this.minScale = o.minScale ?? 1 / 32;
    this.pixels = (o.width ?? 1920) * (o.height ?? 1080);
    this.stepSeconds = o.stepSeconds ?? 0.5;
    this.now = o.now ?? (() => performance.now());
  }

  setViewport(width: number, height: number): void {
    this.pixels = Math.max(1, width * height);
  }

  allocate(input: BudgetInput): number[] {
    this.govern(input.fps, input.targetFps);

    const out = new Array<number>(input.planes.length);
    for (let i = 0; i < input.planes.length; i++) {
      const p = input.planes[i];
      if (!p.visible || p.capacity <= 0) {
        out[i] = 0;
        continue;
      }
      const byDensity = this.pixelDensity * p.screenCoverage * this.pixels;
      const floor = Math.ceil(p.capacity * this.minFraction);
      const want = Math.min(p.capacity, Math.max(floor, byDensity)) * this.scale;
      out[i] = Math.max(1, Math.min(p.capacity, Math.round(want)));
    }
    return out;
  }

  /**
   * One step per `stepSeconds`, however often allocate() is called.
   *
   * The fps a caller passes is an average over a recent window, so the same
   * reading arrives for many frames in a row, and a cut only shows up in it
   * one window later. Stepping on every call compounds one stale reading:
   * a 0.8x cut on each of the 15 frames of a 250 ms window is 0.035x, so the
   * count collapsed to the floor and then crawled back, over and over.
   */
  private govern(fps: number, targetFps: number): void {
    if (!(fps > 0 && targetFps > 0)) return;
    const t = this.now();
    if (t - this.lastStep < this.stepSeconds * 1000) return;
    this.lastStep = t;
    // Multiplicative decrease proportional to the miss (GPU-bound frame time
    // grows with the count, so the ratio estimates the scale that would hold),
    // gentle probing upward. fps is normally capped at the display rate, so
    // "at target" means "has headroom or exactly fits".
    const ratio = fps / targetFps;
    if (ratio < 0.95) this.scale *= Math.max(MAX_CUT, ratio);
    else if (ratio >= 0.99) this.scale *= PROBE_GROWTH;
    this.scale = Math.min(1, Math.max(this.minScale, this.scale));
  }
}
