/**
 * The composer turns scene frames into music: continuous controls every
 * frame, plus discrete notes and chord changes. Pure, causal and seeded: the
 * same frames and events always give the same output, and nothing here knows
 * about Web Audio. The live engine and the offline renderer both play what it
 * writes, which is why the video sounds like the app.
 *
 * The mapping, in one table (details in docs/audio.md):
 *
 *   particles  log10 decides how many drone voices sound: one more per power of
 *              ten or so, the last one near a trillion. A soft low bell the
 *              first time the count passes each power of ten from a million.
 *   density    opens the drone's low-pass filter and the air band: denser
 *              frames sound brighter.
 *   fill       widens the stereo image, makes glints (single particles) more
 *              frequent, raises the air.
 *   yaw        turns the stereo field: each voice sits at an angle in the
 *              world, so orbiting the camera moves voices across the speakers.
 *   motion     camera speed (orbit and zoom) raises a breath of air. Jumps
 *              bigger than a cut threshold count as cuts, not motion.
 *   distance   further out means more reverb.
 *   roll       the drone dissolves into another chord and one bell rings.
 */
import {
  ENTRY_WIDTH,
  VOICE_ENTRY,
  VOICE_WEIGHT,
  accentBellHz,
  glintPitches,
  milestoneBellHz,
  nextChord,
  rollBellHz,
} from "./harmony";
import { hashSeed, mulberry32, type Random } from "./rng";
import { VOICES, type ControlFrame, type Note, type Segment, type SoundEvent, type SoundFrame } from "./types";

export interface ComposerOptions {
  /** Seeds glints, breathing and voice placement. Default 1. */
  seed?: number;
  /** Chord to open with, an index into CHORDS. Default 0. */
  chord?: number;
  /**
   * Ring a soft low bell the first time the count reaches each power of ten
   * from 10^milestonesFrom up. Default 6 (a million). null: never.
   */
  milestonesFrom?: number | null;
  /** Glints per second at a full, dense, trillion-particle frame. Default 1.2. 0: none. */
  glintRate?: number;
}

/** Where the composer's notes and chord changes go. */
export interface ComposerSink {
  note(note: Note): void;
  segment(segment: Segment): void;
}

const TAU = 2 * Math.PI;
const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
const db = (d: number) => Math.pow(10, d / 20);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** One-pole follower: moves `current` toward `target` with time constant `tau` seconds. */
const follow = (current: number, target: number, dt: number, tau: number) =>
  current + (target - current) * (1 - Math.exp(-dt / tau));
const wrapAngle = (a: number) => a - TAU * Math.round(a / TAU);

/** A camera change bigger than this in one frame is a cut: it moves the stereo field but makes no wind. */
const CUT_ANGLE = 0.6;
const CUT_ZOOM = 0.8;
/** Bells closer together than this ring once. */
const BELL_GAP = 1.5;
const MILESTONE_GAP = 4;

export class Composer {
  private readonly rand: Random;
  private readonly milestonesFrom: number | null;
  private readonly glintRate: number;
  private readonly breathPeriod = new Float64Array(VOICES);
  private readonly breathPhase = new Float64Array(VOICES);
  private readonly azimuth = new Float64Array(VOICES);
  private readonly out: ControlFrame = {
    level: new Float32Array(VOICES),
    pan: new Float32Array(VOICES),
    cutoff: 0,
    air: 0,
    airFreq: 0,
    wet: 0,
  };

  private started = false;
  private currentChord: number;
  // Smoothed inputs.
  private mag = 0;
  private fill = 0;
  private density = 0;
  private speed = 0;
  private far = 0.5;
  private yawSmooth = 0;
  // Raw camera of the previous frame, for motion.
  private yawRaw = 0;
  private yawUnwrapped = 0;
  private pitchRaw = 0;
  private distRaw = 1;
  private refDistance = 1;
  // Discrete state.
  private peakDecade = 0;
  private lastBell = -Infinity;
  private lastMilestone = -Infinity;
  private glintDebt: number;

  constructor(
    opts: ComposerOptions,
    private readonly sink: ComposerSink,
  ) {
    const seed = opts.seed ?? 1;
    this.rand = mulberry32(hashSeed(seed, 0x91));
    const shape = mulberry32(hashSeed(seed, 0x5a));
    for (let v = 0; v < VOICES; v++) {
      // Slow and mutually incommensurate, so the drone never breathes in unison.
      this.breathPeriod[v] = 14 + 26 * shape();
      this.breathPhase[v] = TAU * shape();
      this.azimuth[v] = TAU * ((v * 0.6180339887 + shape()) % 1);
    }
    this.currentChord = opts.chord ?? 0;
    this.milestonesFrom = opts.milestonesFrom === undefined ? 6 : opts.milestonesFrom;
    this.glintRate = opts.glintRate ?? 1.2;
    this.glintDebt = -Math.log(1 - this.rand());
  }

  /** The chord sounding now. */
  get chord(): number {
    return this.currentChord;
  }

  /**
   * Advance to the frame at absolute `time` seconds, `dt` after the previous
   * one (0 on the first frame). Events are handled at this frame's time.
   * Returns this frame's controls in an object that is reused on the next call.
   */
  step(f: SoundFrame, time: number, dt: number, events: readonly SoundEvent[] = []): ControlFrame {
    const particles = Number.isFinite(f.particles) ? Math.max(0, f.particles) : 0;
    const mag = Math.log10(Math.max(1, particles));
    const fill = clamp01(f.fill);
    const density = clamp01(f.density);
    const dist = f.distance > 0 && Number.isFinite(f.distance) ? f.distance : this.distRaw;

    if (!this.started) {
      this.started = true;
      this.mag = mag;
      this.fill = fill;
      this.density = density;
      this.yawRaw = this.yawUnwrapped = this.yawSmooth = f.yaw || 0;
      this.pitchRaw = f.pitch || 0;
      this.distRaw = this.refDistance = dist;
      // No bell for the count the performance opens with.
      this.peakDecade = Math.floor(mag + 1e-9);
    } else if (dt > 0) {
      const dyaw = wrapAngle((f.yaw || 0) - this.yawRaw);
      const dpitch = (f.pitch || 0) - this.pitchRaw;
      const dzoom = Math.log(dist / this.distRaw);
      this.yawRaw = f.yaw || 0;
      this.pitchRaw = f.pitch || 0;
      this.distRaw = dist;
      this.yawUnwrapped += dyaw;
      if (Math.abs(dyaw) > CUT_ANGLE || Math.abs(dpitch) > CUT_ANGLE || Math.abs(dzoom) > CUT_ZOOM) {
        this.yawSmooth += dyaw; // a cut: the stereo field jumps with the picture
      } else {
        const rate = Math.hypot(dyaw, dpitch) / dt / 0.8 + Math.abs(dzoom) / dt / 1.2;
        const target = 1 - Math.exp(-rate);
        this.speed = follow(this.speed, target, dt, target > this.speed ? 0.35 : 1.6);
      }
      this.yawSmooth = follow(this.yawSmooth, this.yawUnwrapped, dt, 0.3);
      this.mag = follow(this.mag, mag, dt, 1.2);
      this.fill = follow(this.fill, fill, dt, 0.8);
      this.density = follow(this.density, density, dt, 0.8);
      this.far = follow(this.far, clamp01(0.5 + Math.log2(dist / this.refDistance) / 4), dt, 1);
    }

    for (const e of events) this.handle(e, time);
    this.milestone(mag, time);
    this.glints(time, dt);
    return this.controls(time);
  }

  private handle(e: SoundEvent, time: number): void {
    if (e.type === "roll") {
      this.currentChord = nextChord(this.currentChord, e.seed);
      this.sink.segment({ start: time, chord: this.currentChord });
      if (time - this.lastBell >= BELL_GAP) {
        this.lastBell = time;
        this.bell(time, rollBellHz(this.currentChord), -21, 6, 0.5);
      }
    } else if (e.type === "accent") {
      const strength = clamp01(e.strength ?? 1);
      if (strength > 0) this.bell(time, accentBellHz(this.currentChord), -22 + 20 * Math.log10(strength), 5, 0.4);
    }
  }

  private bell(time: number, freq: number, gainDb: number, decay: number, spread: number): void {
    this.sink.note({ time, freq, gain: db(gainDb), pan: (this.rand() - 0.5) * spread, decay, kind: "bell" });
  }

  private milestone(mag: number, time: number): void {
    if (this.milestonesFrom === null) return;
    const decade = Math.floor(mag + 1e-9);
    if (decade > this.peakDecade) {
      if (decade >= this.milestonesFrom && time - this.lastMilestone >= MILESTONE_GAP) {
        this.lastMilestone = time;
        this.bell(time, milestoneBellHz(this.currentChord), -23, 7, 0);
      }
      this.peakDecade = decade;
    } else if (mag < this.peakDecade - 1) {
      this.peakDecade = decade; // fell a whole decade: the next climb rings again
    }
  }

  /** Single particles: sparse, quiet, high sines on the chord, as a Poisson process. */
  private glints(time: number, dt: number): void {
    if (!(dt > 0) || this.glintRate <= 0) return;
    const mm = clamp01((this.mag - 3) / 9);
    const rate = 0.05 + this.glintRate * Math.pow(this.fill, 0.8) * Math.pow(mm, 1.6) + 0.25 * this.speed * mm;
    this.glintDebt -= rate * dt;
    while (this.glintDebt <= 0) {
      this.glintDebt += -Math.log(1 - this.rand());
      const pool = glintPitches(this.currentChord);
      this.sink.note({
        time: time + this.rand() * dt,
        freq: pool[Math.floor(this.rand() * pool.length)],
        gain: db(-27 + 4 * mm + 5 * (this.rand() - 0.5)),
        pan: (this.rand() * 2 - 1) * 0.8,
        decay: 0.8 + 1.8 * this.rand(),
        kind: "glint",
      });
    }
  }

  private controls(time: number): ControlFrame {
    const c = this.out;
    const width = 0.25 + 0.5 * this.fill;
    for (let v = 0; v < VOICES; v++) {
      const entry = v === 0 ? 1 : smoothstep(VOICE_ENTRY[v] - ENTRY_WIDTH, VOICE_ENTRY[v] + ENTRY_WIDTH, this.mag);
      const breath = 1 - 0.28 * (0.5 - 0.5 * Math.cos((TAU * time) / this.breathPeriod[v] + this.breathPhase[v]));
      c.level[v] = VOICE_WEIGHT[v] * entry * breath;
      c.pan[v] = v === 0 ? 0 : width * Math.sin(this.azimuth[v] - this.yawSmooth);
    }
    const bright = clamp01(0.6 * this.density + 0.4 * clamp01((this.mag - 4) / 8));
    c.cutoff = 300 * Math.pow(2, 4.8 * bright);
    c.air = db(-38 + 10 * this.fill + 6 * this.density + 14 * this.speed);
    c.airFreq = 600 * Math.pow(2, 2.4 * bright + 1.4 * this.speed);
    c.wet = 0.2 + 0.3 * this.far;
    return c;
  }
}
