// The opening sequence, as a pure function of time.
//
// introState(t) describes what the screen should look like t seconds after
// the first frame. It holds no state and touches no DOM, so the engine, the
// 2D fallback and the tests can all sample it the same way.
//
// Story beats (full variant, seconds):
//   hold      0.0 -  0.8   true black, nothing on screen
//   spark     0.8 -  2.0   one particle, alone
//   bloom     2.0 -  6.5   one plane fills in, face-on; reads as a 2D sim
//   tilt      6.5 - 11.0   camera swings off-axis; the "2D sim" is a sheet
//   pullback  9.5 - 16.5   camera retreats; every other plane ignites in turn
//   settle   16.5 - 18.0   motion eases out, control is handed over
//
// See docs/ux/experience.md for the reasoning behind each beat.

import { easeInOutCubic, easeOutCubic, lerp, saturate, smoothstep } from './math';

export const INTRO_BEATS = Object.freeze({
  hold: [0.0, 0.8],
  spark: [0.8, 2.0],
  bloom: [2.0, 6.5],
  tilt: [6.5, 11.0],
  pullback: [9.5, 16.5],
  settle: [16.5, 18.0],
});

export const INTRO_DURATION = INTRO_BEATS.settle[1];

/** Returning visitors get the same story played faster. */
export const SHORT_RATE = 3.2;

/** Reduced motion: no camera travel, one slow crossfade. */
export const REDUCED_DURATION = 2.5;

export type IntroVariant = 'full' | 'short' | 'reduced';
export type IntroPhase = 'hold' | 'spark' | 'bloom' | 'tilt' | 'pullback' | 'settle' | 'done';

export interface IntroPose {
  /** Radians around the vertical axis, 0 = face-on to the hero plane. */
  yaw: number;
  /** Radians above the horizon. */
  pitch: number;
  /** 0 = close (hero plane fills the view), 1 = overview. */
  distance: number;
}

export interface IntroState {
  phase: IntroPhase;
  /** 0..1 global brightness multiplier. */
  exposure: number;
  /** 0..1 brightness of the lone first particle. */
  sparkAlpha: number;
  /** 0..1 how much of the hero plane has appeared, growing out from its centre. */
  heroBloom: number;
  /** 0..1 master progress for igniting the other planes. */
  spread: number;
  /** Where the intro wants the camera. */
  pose: IntroPose;
  /** 1 while the intro owns the camera, 0 once it lets go. */
  cameraWeight: number;
  done: boolean;
}

export interface IntroOptions {
  variant?: IntroVariant;
  finalYaw?: number;
  finalPitch?: number;
  /** Seconds the remaining intro is squeezed into when the person takes over. */
  skipSeconds?: number;
}

/** @param t seconds since the first frame */
export function introState(t: number, opts: IntroOptions = {}): IntroState {
  const variant = opts.variant ?? 'full';
  const finalYaw = opts.finalYaw ?? 0.62;
  const finalPitch = opts.finalPitch ?? 0.2;

  if (variant === 'reduced') {
    const k = smoothstep(0.2, REDUCED_DURATION, t);
    return {
      phase: t >= REDUCED_DURATION ? 'done' : 'bloom',
      exposure: k,
      sparkAlpha: 0,
      heroBloom: 1,
      spread: 1,
      pose: { yaw: finalYaw, pitch: finalPitch, distance: 1 },
      cameraWeight: t >= REDUCED_DURATION ? 0 : 1,
      done: t >= REDUCED_DURATION,
    };
  }

  // The short variant keeps the hold (black still matters) and compresses
  // everything after it.
  if (variant === 'short') {
    const hold = INTRO_BEATS.hold[1];
    t = t <= hold ? t : hold + (t - hold) * SHORT_RATE;
  }

  const B = INTRO_BEATS;
  const inBeat = (b: readonly number[]) => saturate((t - b[0]) / (b[1] - b[0]));

  const sparkAlpha = smoothstep(B.spark[0], B.spark[0] + 0.5, t);
  const heroBloom = easeOutCubic(inBeat(B.bloom));
  const tilt = easeInOutCubic(inBeat(B.tilt));
  const pull = easeInOutCubic(inBeat(B.pullback));
  // Ignition runs through the pullback, finishing a little early so the last
  // second of camera travel is over a fully lit world.
  const spread = saturate((t - B.pullback[0]) / (B.pullback[1] - B.pullback[0] - 1.0));
  const settle = inBeat(B.settle);

  let phase: IntroPhase = 'done';
  if (t < B.hold[1]) phase = 'hold';
  else if (t < B.spark[1]) phase = 'spark';
  else if (t < B.bloom[1]) phase = 'bloom';
  else if (t < B.pullback[0]) phase = 'tilt';
  else if (t < B.pullback[1]) phase = t < B.tilt[1] ? 'tilt' : 'pullback';
  else if (t < B.settle[1]) phase = 'settle';

  return {
    phase,
    exposure: smoothstep(B.spark[0], B.bloom[0] + 1.5, t),
    sparkAlpha,
    heroBloom,
    spread,
    pose: {
      yaw: lerp(0, finalYaw, tilt),
      pitch: lerp(0, finalPitch, tilt),
      distance: pull,
    },
    cameraWeight: 1 - smoothstep(0, 1, settle),
    done: t >= INTRO_DURATION,
  };
}

/**
 * Brightness of one plane during the intro.
 *
 * Planes ignite in order of distance from the hero plane, so light appears to
 * travel outward through the stack. `rank` is that order normalised to 0..1
 * (0 = the hero itself, 1 = the farthest plane).
 *
 * `window` is the fraction of the spread each plane takes to fade in.
 */
export function planeIgnition(spread: number, rank: number, window = 0.18): number {
  if (rank <= 0) return 1;
  // Early planes come one at a time, late planes arrive in a rush: the eye
  // gets to count the first few, then gives up. That is the scale reveal.
  const start = Math.pow(rank, 0.6) * (1 - window);
  return smoothstep(start, start + window, spread);
}

/** Ranks planes by distance from the hero plane. Returns a rank per plane, 0..1. */
export function ignitionRanks(
  planes: ReadonlyArray<{ center: readonly number[] }>,
  heroIndex: number,
): Float32Array {
  const hero = planes[heroIndex].center;
  const order = planes
    .map((p, i) => ({
      i,
      d: Math.hypot(p.center[0] - hero[0], p.center[1] - hero[1], p.center[2] - hero[2]),
    }))
    .sort((a, b) => a.d - b.d);
  const ranks = new Float32Array(planes.length);
  const last = Math.max(1, planes.length - 1);
  order.forEach((o, n) => { ranks[o.i] = n / last; });
  return ranks;
}

/**
 * Drives introState with a clock, and handles the user taking over early.
 *
 * Any deliberate input calls skip(). The intro never cuts: the remaining
 * beats are replayed over `skipSeconds`, and the camera is released
 * immediately so the gesture that interrupted us already works.
 */
export class IntroDirector {
  opts: IntroOptions;
  variant: IntroVariant;
  skipSeconds: number;
  clock = 0;
  rate = 1;
  skipped = false;
  /** 0..1, how far the camera has been handed to the person. */
  released = 0;

  constructor(opts: IntroOptions = {}) {
    this.opts = opts;
    this.variant = opts.variant ?? 'full';
    this.skipSeconds = opts.skipSeconds ?? 1.4;
  }

  /** Length of the chosen variant in clock seconds. */
  get duration(): number {
    if (this.variant === 'reduced') return REDUCED_DURATION;
    if (this.variant === 'short') {
      const hold = INTRO_BEATS.hold[1];
      return hold + (INTRO_DURATION - hold) / SHORT_RATE;
    }
    return INTRO_DURATION;
  }

  get done(): boolean {
    return this.clock >= this.duration;
  }

  restart(variant: IntroVariant = this.variant): void {
    this.variant = variant;
    this.clock = 0;
    this.rate = 1;
    this.skipped = false;
    this.released = 0;
  }

  /** The user did something. Fast-forward what is left and let go of the camera. */
  skip(): void {
    if (this.skipped || this.done) return;
    this.skipped = true;
    const remaining = this.duration - this.clock;
    this.rate = Math.max(1, remaining / this.skipSeconds);
  }

  /** @param dt seconds */
  update(dt: number): IntroState {
    this.clock = Math.min(this.duration, this.clock + dt * this.rate);
    if (this.skipped) this.released = Math.min(1, this.released + dt / 0.4);
    const s = introState(this.clock, { ...this.opts, variant: this.variant });
    if (this.skipped) s.cameraWeight *= 1 - this.released;
    return s;
  }
}
