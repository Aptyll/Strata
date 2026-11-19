/**
 * Frame pacing measured per frame, not averaged away: how long each frame
 * took to come round, and how much of it was script.
 *
 * An average frame rate hides stutter. One 50 ms hitch among 59 smooth
 * frames still reads "60 fps", so next to the average this keeps the "1% low"
 * (the slowest hundredth of recent frames, as a frame rate) and the single
 * worst frame. Pure numbers, no DOM and no GPU.
 */

export interface FrameSummary {
  /** Frames in the window. */
  frames: number;
  /** Mean time between frames in ms, and the frame rate it is. */
  avgMs: number;
  fps: number;
  /** Mean of the slowest 1% of frames in ms (at least one frame), and the frame rate it is. */
  low1Ms: number;
  low1Fps: number;
  /** The slowest single frame in ms. */
  worstMs: number;
  /** Script time per frame in ms: mean and worst. */
  cpuMs: number;
  cpuWorstMs: number;
}

/** A gap longer than this is a pause (hidden tab, offline render), not a frame. Below half a frame a second nothing is measured. */
export const PAUSE_MS = 2000;

export class FrameStats {
  private readonly intervals: Float32Array;
  private readonly cpu: Float32Array;
  private head = 0;
  private filled = 0;
  private readonly scratch: Float32Array;

  /** `capacity` frames of history; 600 is ten seconds at 60 fps. */
  constructor(readonly capacity = 600) {
    this.intervals = new Float32Array(capacity);
    this.cpu = new Float32Array(capacity);
    this.scratch = new Float32Array(capacity);
  }

  /** How many frames are held, up to `capacity`. */
  get count(): number {
    return this.filled;
  }

  /**
   * Record one frame: `intervalMs` since the previous frame started and
   * `cpuMs` of script spent on it. Gaps longer than PAUSE_MS are pauses and
   * are left out.
   */
  push(intervalMs: number, cpuMs: number): void {
    if (!(intervalMs > 0) || intervalMs > PAUSE_MS) return;
    this.intervals[this.head] = intervalMs;
    this.cpu[this.head] = Math.max(0, cpuMs);
    this.head = (this.head + 1) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + 1);
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
  }

  /** Copies the newest frame intervals into `out`, oldest first, and returns how many. */
  recent(out: Float32Array): number {
    const n = Math.min(out.length, this.filled);
    for (let i = 0; i < n; i++) out[i] = this.intervals[(this.head - n + i + 2 * this.capacity) % this.capacity];
    return n;
  }

  /** Statistics over the newest frames that fit in `windowMs`. Null with no frames yet. */
  summary(windowMs = 5000): FrameSummary | null {
    const { capacity, filled, intervals, cpu, scratch } = this;
    let frames = 0;
    let total = 0;
    let worstMs = 0;
    let cpuTotal = 0;
    let cpuWorstMs = 0;
    while (frames < filled && total < windowMs) {
      const i = (this.head - 1 - frames + 2 * capacity) % capacity;
      const ms = intervals[i];
      scratch[frames++] = ms;
      total += ms;
      if (ms > worstMs) worstMs = ms;
      cpuTotal += cpu[i];
      if (cpu[i] > cpuWorstMs) cpuWorstMs = cpu[i];
    }
    if (frames === 0) return null;
    const avgMs = total / frames;
    // The slowest hundredth of the window, at least one frame.
    const slow = scratch.subarray(0, frames).sort();
    const k = Math.max(1, Math.round(frames / 100));
    let slowTotal = 0;
    for (let i = frames - k; i < frames; i++) slowTotal += slow[i];
    const low1Ms = slowTotal / k;
    return {
      frames,
      avgMs,
      fps: 1000 / avgMs,
      low1Ms,
      low1Fps: 1000 / low1Ms,
      worstMs,
      cpuMs: cpuTotal / frames,
      cpuWorstMs,
    };
  }
}
