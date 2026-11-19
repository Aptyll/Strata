/**
 * A performance is everything the composer decided for a run of frames:
 * one value per frame for every continuous control, plus the notes and chord
 * changes with their times. It grows a frame at a time, so a recording can be
 * rendered in chunks while the video is still being made.
 */
import { Composer, type ComposerOptions } from "./composer";
import { VOICES, type ControlFrame, type Note, type Segment, type SoundEvent, type SoundFrame, type SoundScore } from "./types";

/** A Float32Array that grows. */
class Track {
  private data = new Float32Array(1024);
  length = 0;
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  /** The values so far (a view, valid until the next push). */
  values(): Float32Array {
    return this.data.subarray(0, this.length);
  }
}

export interface PerformanceOptions extends ComposerOptions {
  /** Frames per second of the video this performance accompanies. Frame i is at i / fps. */
  fps: number;
}

export class SoundPerformance {
  readonly fps: number;
  readonly seed: number;
  /** Chord changes, oldest first. The first one starts at 0. */
  readonly segments: Segment[];
  /** Glints and bells in time order. */
  readonly notes: Note[] = [];
  private readonly composer: Composer;
  private readonly tracks = {
    level: Array.from({ length: VOICES }, () => new Track()),
    pan: Array.from({ length: VOICES }, () => new Track()),
    cutoff: new Track(),
    air: new Track(),
    airFreq: new Track(),
    wet: new Track(),
  };

  constructor(opts: PerformanceOptions) {
    if (!(opts.fps > 0)) throw new RangeError("audio: a performance needs fps > 0");
    this.fps = opts.fps;
    this.seed = opts.seed ?? 1;
    this.segments = [{ start: 0, chord: opts.chord ?? 0 }];
    this.composer = new Composer(opts, {
      note: (n) => this.notes.push(n),
      segment: (s) => this.segments.push(s),
    });
  }

  /** Frames composed so far. */
  get frames(): number {
    return this.tracks.cutoff.length;
  }

  /** Seconds covered by the frames so far. */
  get duration(): number {
    return this.frames / this.fps;
  }

  /** The chord sounding after the last frame. */
  get chord(): number {
    return this.composer.chord;
  }

  /** Compose the next frame. Events land on this frame. */
  push(frame: SoundFrame, events: readonly SoundEvent[] = []): void {
    const i = this.frames;
    this.store(this.composer.step(frame, i / this.fps, i === 0 ? 0 : 1 / this.fps, events));
  }

  private store(c: ControlFrame): void {
    const t = this.tracks;
    for (let v = 0; v < VOICES; v++) {
      t.level[v].push(c.level[v]);
      t.pan[v].push(c.pan[v]);
    }
    t.cutoff.push(c.cutoff);
    t.air.push(c.air);
    t.airFreq.push(c.airFreq);
    t.wet.push(c.wet);
  }

  level(v: number): Float32Array {
    return this.tracks.level[v].values();
  }
  pan(v: number): Float32Array {
    return this.tracks.pan[v].values();
  }
  cutoff(): Float32Array {
    return this.tracks.cutoff.values();
  }
  air(): Float32Array {
    return this.tracks.air.values();
  }
  airFreq(): Float32Array {
    return this.tracks.airFreq.values();
  }
  wet(): Float32Array {
    return this.tracks.wet.values();
  }
}

/** Compose a whole score. */
export function compose(score: SoundScore, opts: ComposerOptions = {}): SoundPerformance {
  const perf = new SoundPerformance({ ...opts, fps: score.fps, seed: opts.seed ?? score.seed });
  const byFrame = new Map<number, SoundEvent[]>();
  for (const e of score.events) {
    const frame = Math.max(0, Math.min(score.frames.length - 1, Math.round(e.frame)));
    const list = byFrame.get(frame) ?? [];
    list.push(e.type === "roll" ? { type: "roll", seed: e.seed } : { type: "accent", strength: e.strength });
    byFrame.set(frame, list);
  }
  score.frames.forEach((f, i) => perf.push(f, byFrame.get(i)));
  return perf;
}
