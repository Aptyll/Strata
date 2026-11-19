/**
 * Scores from functions of time, for scripted videos whose camera and counts
 * are known in advance (the offline renderer's camera path, a ladder of
 * particle counts). Sample the functions once per video frame and you have
 * the soundtrack's whole input before a single frame is rendered.
 */
import { densityOf } from "./sense";
import type { ScoreEvent, SoundEvent, SoundScore } from "./types";

export interface Timeline {
  fps: number;
  /** Seconds of video. */
  duration: number;
  seed?: number;
  /** Particles drawn at time t. */
  particles(t: number): number;
  camera(t: number): { yaw: number; pitch: number; distance: number };
  /** 0..1 share of the frame covered by sheets. Default 0.7. */
  fill?(t: number): number;
  /** 0..1. Default: from particles and fill on a 1920x1080 frame (see densityOf). */
  density?(t: number): number;
  events?: Array<SoundEvent & { time: number }>;
}

export function scoreFromTimeline(tl: Timeline): SoundScore {
  const count = Math.max(1, Math.round(tl.duration * tl.fps));
  const frames = Array.from({ length: count }, (_, i) => {
    const t = i / tl.fps;
    const particles = tl.particles(t);
    const fill = tl.fill?.(t) ?? 0.7;
    const cam = tl.camera(t);
    return {
      particles,
      fill,
      density: tl.density?.(t) ?? densityOf(particles / Math.max(1, fill * 1920 * 1080)),
      yaw: cam.yaw,
      pitch: cam.pitch,
      distance: cam.distance,
    };
  });
  const events: ScoreEvent[] = (tl.events ?? []).map((e) => {
    const frame = Math.min(count - 1, Math.max(0, Math.round(e.time * tl.fps)));
    return e.type === "roll" ? { type: "roll", seed: e.seed, frame } : { type: "accent", strength: e.strength, frame };
  });
  return { version: 1, fps: tl.fps, seed: tl.seed ?? 1, frames, events };
}

export interface LadderOptions {
  /** Default 60. */
  seconds?: number;
  /** Default 60. */
  fps?: number;
  /** Counts held one after another, each for an equal share of the clip. Default 1M, 100M, 10B, 1T. */
  rungs?: number[];
  seed?: number;
}

/**
 * The video's spine as a score: hold each count, glide up a few seconds in
 * log space to the next, a slow orbit throughout, a dice roll halfway through
 * each hold after the first. Used by the demo page for its preview render.
 */
export function ladderScore(opts: LadderOptions = {}): SoundScore {
  const seconds = opts.seconds ?? 60;
  const rungs = opts.rungs ?? [1e6, 1e8, 1e10, 1e12];
  const share = seconds / rungs.length;
  const glide = Math.min(4, share * 0.3);
  const logs = rungs.map((n) => Math.log10(n));
  const ease = (x: number) => x * x * (3 - 2 * x);
  const particles = (t: number) => {
    const i = Math.min(rungs.length - 1, Math.floor(t / share));
    const into = t - i * share;
    if (i === 0 || into >= glide) return rungs[i];
    return Math.pow(10, logs[i - 1] + (logs[i] - logs[i - 1]) * ease(into / glide));
  };
  return scoreFromTimeline({
    fps: opts.fps ?? 60,
    duration: seconds,
    seed: opts.seed ?? 7,
    particles,
    fill: (t) => 0.55 + (0.35 * t) / seconds,
    camera: (t) => ({ yaw: 0.6 + 0.12 * t, pitch: -0.35 + 0.1 * Math.sin(t * 0.07), distance: 20 * Math.pow(0.6, t / seconds) }),
    events: rungs.slice(1).map((_, i) => ({ type: "roll" as const, seed: 0x9e3779b9 * (i + 1), time: (i + 1.5) * share })),
  });
}
