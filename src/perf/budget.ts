/**
 * ParticleBudget for the shared engine (src/core/contracts.ts).
 *
 * Two rules, applied per frame:
 *
 *  1. Density cap. A plane never needs more particles than a target density
 *     times the pixels it covers. Beyond that, extra particles land on pixels
 *     that are already bright. Culled planes get zero.
 *  2. Frame rate governor. One global scale in (0, 1] multiplies every plane's
 *     allocation. It backs off quickly when fps drops under the target and
 *     recovers slowly, so the count settles near the highest the machine holds.
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
}

export class PerfBudget implements ParticleBudget {
  pixelDensity: number;
  minFraction: number;
  minScale: number;
  /** Governor output, 1 = no throttling. */
  scale = 1;

  private pixels: number;

  constructor(o: PerfBudgetOptions = {}) {
    this.pixelDensity = o.pixelDensity ?? 4;
    this.minFraction = o.minFraction ?? 1 / 64;
    this.minScale = o.minScale ?? 1 / 32;
    this.pixels = (o.width ?? 1920) * (o.height ?? 1080);
  }

  setViewport(width: number, height: number): void {
    this.pixels = Math.max(1, width * height);
  }

  allocate(input: BudgetInput): number[] {
    // Governor: multiplicative decrease proportional to the miss, slow increase.
    // fps is normally capped at the display rate, so "at target" means "has
    // headroom or exactly fits"; keep probing upward gently.
    if (input.fps > 0 && input.targetFps > 0) {
      const ratio = input.fps / input.targetFps;
      if (ratio < 0.95) this.scale *= Math.max(0.8, ratio);
      else if (ratio >= 0.99) this.scale *= 1.01;
      this.scale = Math.min(1, Math.max(this.minScale, this.scale));
    }

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
}
