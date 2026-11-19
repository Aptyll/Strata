/**
 * The ramp: finds the largest particle count that holds a target frame rate.
 *
 * Pure logic, no GPU and no DOM. The caller measures one window of frames at
 * the count the ramp asked for and reports the frame rate. The ramp answers
 * with the next count to try.
 *
 *   climb    grow while the target holds (faster when there is headroom)
 *   refine   bisect between the last pass and the first fail
 *   confirm  the candidate must pass several windows in a row
 *   hold     done. `record` is the sustained count
 *
 * A count only becomes the record after it passes `confirmWindows` windows in
 * a row, so one lucky window cannot set it.
 */

export type RampPhase = "climb" | "refine" | "confirm" | "hold";

/** Why the ramp stopped where it did. */
export type RampStop = "fps" | "ceiling" | "floor" | null;

export interface RampOptions {
  /** Frames per second that must be held. */
  targetFps: number;
  /** First count to try. */
  start: number;
  /** Counts are rounded down to a multiple of this. Also the smallest count. */
  quantum: number;
  /** Stop refining when the bracket is this tight. Default 0.04 (4 percent). */
  tolerance?: number;
  /** Windows in a row the final count must pass. Default 3. */
  confirmWindows?: number;
}

export class Ramp {
  phase: RampPhase = "climb";
  /** The count the caller should be running now. */
  count: number;
  /** Sustained count, set when the ramp reaches "hold". */
  record = 0;
  /** Frame rate measured over the confirming windows of the record. */
  recordFps = 0;
  stop: RampStop = null;

  private lo = 0; // highest count that passed
  private hi = Infinity; // lowest count that failed
  private passes = 0;
  private fpsSum = 0;
  private readonly target: number;
  private readonly quantum: number;
  private readonly tolerance: number;
  private readonly confirmWindows: number;

  constructor(options: RampOptions) {
    this.target = options.targetFps;
    this.quantum = options.quantum;
    this.tolerance = options.tolerance ?? 0.04;
    this.confirmWindows = options.confirmWindows ?? 3;
    this.count = this.quantize(options.start);
  }

  private quantize(n: number): number {
    return Math.max(this.quantum, Math.floor(n / this.quantum) * this.quantum);
  }

  /**
   * Report one measured window.
   *
   * @param fps      frames per second over the window
   * @param applied  the count that actually ran (may be below the request)
   * @param ceiling  true when `applied` is the most the engine can run
   *                 (out of memory, or the mode's hard cap)
   * @returns the next count to run
   */
  report(fps: number, applied: number, ceiling = false): number {
    if (this.phase === "hold") return this.count;
    const pass = fps >= this.target;
    this.count = applied;

    if (this.phase === "confirm") {
      if (pass) {
        this.passes++;
        this.fpsSum += fps;
        if (this.passes >= this.confirmWindows) {
          this.phase = "hold";
          this.record = applied;
          this.recordFps = this.fpsSum / this.passes;
        }
        return this.count;
      }
      // The candidate did not hold. Treat it as a fail and look lower.
      this.hi = applied;
      this.lo = Math.min(this.lo, this.quantize(applied * (1 - 2 * this.tolerance)));
      if (applied <= this.quantum) return this.giveUp(applied);
      this.count = Math.max(this.quantum, Math.min(this.lo, applied - this.quantum));
      this.passes = 0;
      this.fpsSum = 0;
      this.stop = "fps";
      return this.count;
    }

    if (pass) {
      this.lo = Math.max(this.lo, applied);
      if (ceiling) return this.settle(applied, "ceiling");
    } else {
      this.hi = Math.min(this.hi, applied);
      this.phase = "refine";
    }

    if (this.phase === "climb") {
      // Scale by the measured headroom, between 1.25x and 2x. A frame rate
      // pinned at the display refresh hides the real headroom, so cap at 2x.
      const growth = Math.min(2, Math.max(1.25, (fps / this.target) * 0.9));
      this.count = this.quantize(applied * growth);
      return this.count;
    }

    // refine
    if (this.lo === 0) {
      // Even the lowest count tried has failed: halve until something passes.
      if (applied <= this.quantum) return this.giveUp(applied);
      this.count = this.quantize(applied / 2);
      return this.count;
    }
    const mid = this.quantize(Math.sqrt(this.lo * this.hi));
    if (this.hi / this.lo <= 1 + this.tolerance || mid <= this.lo || mid >= this.hi) {
      return this.settle(this.lo, "fps");
    }
    this.count = mid;
    return this.count;
  }

  /** The target cannot be held even at the smallest count. No record. */
  private giveUp(count: number): number {
    this.phase = "hold";
    this.stop = "floor";
    this.count = count;
    this.record = 0;
    this.recordFps = 0;
    return count;
  }

  private settle(count: number, why: RampStop): number {
    this.phase = "confirm";
    this.stop = why;
    this.count = count;
    this.passes = 0;
    this.fpsSum = 0;
    return count;
  }
}
