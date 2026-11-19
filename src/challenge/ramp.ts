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
 *
 * Windows are noisy the other way too: a garbage collection or a busy
 * compositor can make one window read a fraction of the real rate. On Noah's
 * RTX 2070 one count read 16 fps and then 49 fps, and such windows walked a
 * 319M candidate down to 216M while the GPU had room for about 340M. So:
 *
 *  - A failed window is measured again before it counts. A count fails only
 *    on `failWindows` failed windows in a row, or when it cannot string
 *    together its confirming passes within a bounded number of windows.
 *  - A confirming count that passes with clear headroom contradicts the fail
 *    that sent the search down, so the search resumes upward from it, at most
 *    `MAX_REOPENS` times so the ramp always ends.
 *
 * Neither rule touches what counts as the record: it still needs
 * `confirmWindows` passing windows in a row.
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
  /** Failed windows in a row before a count counts as failed. Default 3. */
  failWindows?: number;
  /**
   * The frame rate cannot rise above the target (a screen that refreshes at
   * it, see refresh.ts), so a passing window says nothing about headroom:
   * double the count while it passes instead of scaling by the measured rate.
   * Default false.
   */
  blind?: boolean;
}

/**
 * Headroom (fps / target) at which a passing confirm window reopens the search.
 * A true fail steps the candidate down by 2 * tolerance, which leaves less than
 * this, so only a fail that was noise can trigger it.
 */
const REOPEN_HEADROOM = 1.15;
/** Most times the search may reopen. */
const MAX_REOPENS = 2;

export class Ramp {
  phase: RampPhase = "climb";
  /** The count the caller should be running now. */
  count: number;
  /** Sustained count, set when the ramp reaches "hold". */
  record = 0;
  /** Frame rate measured over the confirming windows of the record. */
  recordFps = 0;
  stop: RampStop = null;
  /** Failed windows that were measured again instead of believed at once. */
  remeasured = 0;
  /** Times a confirming count's headroom reopened the search. */
  reopens = 0;

  private lo = 0; // highest count that passed
  private hi = Infinity; // lowest count that failed (two windows in a row)
  private passes = 0;
  private fpsSum = 0;
  private measured = -1; // the count the last window ran
  private windowsHere = 0; // windows measured at that count
  private failsInRow = 0; // failed windows in a row at that count
  private readonly target: number;
  private readonly quantum: number;
  private readonly tolerance: number;
  private readonly confirmWindows: number;
  private readonly failWindows: number;
  private readonly blind: boolean;

  constructor(options: RampOptions) {
    this.target = options.targetFps;
    this.quantum = options.quantum;
    this.tolerance = options.tolerance ?? 0.04;
    this.confirmWindows = options.confirmWindows ?? 3;
    this.failWindows = options.failWindows ?? 3;
    this.blind = options.blind ?? false;
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
   * @returns the next count to run (the same count to measure it again)
   */
  report(fps: number, applied: number, ceiling = false): number {
    if (this.phase === "hold") return this.count;
    if (applied !== this.measured) {
      this.measured = applied;
      this.windowsHere = 0;
      this.failsInRow = 0;
    }
    this.windowsHere++;
    this.count = applied;
    const pass = fps >= this.target;

    if (pass) {
      this.failsInRow = 0;
    } else if (++this.failsInRow < this.failWindows && this.windowsHere < this.confirmWindows * 5) {
      // Not believed yet: measure this count again. The window cap ends a
      // count that keeps failing now and then and never strings together
      // its confirming passes.
      this.remeasured++;
      this.passes = 0; // the record's windows must be in a row
      this.fpsSum = 0;
      return this.count;
    } else {
      this.failsInRow = 0;
    }

    if (this.phase === "confirm") {
      if (pass) {
        if (this.reopen(fps, applied, ceiling)) return this.count;
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
      this.count = this.climbFrom(applied, fps);
      return this.count;
    }

    // refine
    if (this.lo === 0) {
      // Even the lowest count tried has failed: halve until something passes.
      if (applied <= this.quantum) return this.giveUp(applied);
      this.count = this.quantize(applied / 2);
      return this.count;
    }
    return this.bisect();
  }

  /** Climb step: scale by the measured headroom, between 1.25x and 2x. */
  private growth(fps: number): number {
    // A screen that refreshes at the target shows no headroom at all: double.
    if (this.blind) return 2;
    // A frame rate pinned at the display refresh hides the real headroom, so cap at 2x.
    return Math.min(2, Math.max(1.25, (fps / this.target) * 0.9));
  }

  /**
   * The next count of a climb. At least one quantum more than the last:
   * 1.25 times a count under four quanta rounds back down to itself, and the
   * climb would try that count for ever.
   */
  private climbFrom(applied: number, fps: number): number {
    return Math.max(this.quantize(applied * this.growth(fps)), applied + this.quantum);
  }

  /** The middle of the bracket, or settle on its low end once it is tight. */
  private bisect(): number {
    const mid = this.quantize(Math.sqrt(this.lo * this.hi));
    if (this.hi / this.lo <= 1 + this.tolerance || mid <= this.lo || mid >= this.hi) {
      return this.settle(this.lo, "fps");
    }
    this.count = mid;
    return this.count;
  }

  /**
   * A confirming count passed with clear headroom: the fail that sent the
   * search down here was noise. Resume the search upward from this count.
   * fps / target underestimates how far the count can grow (part of every
   * frame does not scale with the count), so a fail below `applied * fps /
   * target` is contradicted outright and forgotten.
   */
  private reopen(fps: number, applied: number, ceiling: boolean): boolean {
    const headroom = fps / this.target;
    if (ceiling || this.stop === "ceiling" || this.reopens >= MAX_REOPENS || headroom < REOPEN_HEADROOM) {
      return false;
    }
    this.reopens++;
    this.lo = applied;
    if (applied * headroom > this.hi) this.hi = Infinity;
    this.passes = 0;
    this.fpsSum = 0;
    this.stop = null;
    if (this.hi === Infinity) {
      this.phase = "climb";
      this.count = this.climbFrom(applied, fps);
    } else {
      this.phase = "refine";
      this.bisect();
    }
    return true;
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
