/**
 * How often this page gets to show a frame: the screen's refresh rate as the
 * browser paces requestAnimationFrame. Usually 60, 120 or 144. It is 30 on a
 * phone in low power mode, in a browser's energy saver, and on a 30 Hz
 * screen, and that matters to Challenge mode: on such a screen "at least
 * 30 fps" can never be exceeded, only met, so a strict test passes or fails
 * on measurement noise and the search ends near zero (see main.ts).
 */

/**
 * Refresh rate in Hz from the gaps between animation frames, or 0 when there
 * are too few to tell. The median gap: a slow frame while the page starts
 * only makes a few gaps longer, and a doubled callback only makes one short.
 */
export function refreshFromIntervals(intervalsMs: readonly number[]): number {
  const good = intervalsMs.filter((ms) => ms > 2 && ms < 100).sort((a, b) => a - b);
  if (good.length < 5) return 0;
  return 1000 / good[Math.floor(good.length / 2)];
}

/**
 * Measure the refresh rate over about `frames` animation frames (under half a
 * second at 60 Hz). Resolves 0 when it cannot tell. Waits while the tab is
 * hidden, because no frames are shown there.
 */
export function measureRefresh(frames = 24, raf: (cb: FrameRequestCallback) => unknown = requestAnimationFrame): Promise<number> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let last = 0;
    let good = 0;
    const tick = (now: number) => {
      if (last) {
        const gap = now - last;
        intervals.push(gap);
        if (gap > 2 && gap < 100) good++;
      }
      last = now;
      // Give up after four times as many frames: something keeps the page from a steady pace.
      if (good >= frames || intervals.length >= frames * 4) resolve(refreshFromIntervals(intervals));
      else raf(tick);
    };
    raf(tick);
  });
}

/** What a screen's refresh rate means for a search that wants `targetFps`. */
export interface ScreenLimit {
  /** The refresh rate when the screen cannot show more than the target (within 5 percent), else null. */
  screenHz: number | null;
  /** Frames per second a measured window must reach to count as holding the frame rate. */
  passFps: number;
}

/**
 * On a screen faster than the target the test is the target itself. On a
 * screen at the target or slower, holding the frame rate means showing every
 * refresh: a window passes at 95 percent of the refresh rate, which is above
 * anything a missed refresh leaves (one miss in three already reads under 80
 * percent) and below the noise of a one-second window (about 3 percent).
 */
export function screenLimit(refreshHz: number, targetFps: number): ScreenLimit {
  const capped = refreshHz > 0 && refreshHz < targetFps * 1.05;
  return capped ? { screenHz: refreshHz, passFps: refreshHz * 0.95 } : { screenHz: null, passFps: targetFps };
}
