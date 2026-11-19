/**
 * What the soundtrack listens to. Plain data, so a score can be recorded from
 * the live app, computed from a scripted camera path, or loaded from JSON.
 */

/** Scene state for one frame. */
export interface SoundFrame {
  /** Particles drawn this frame, all planes together. The number the video is about. */
  particles: number;
  /** 0..1: share of the frame covered by visible sheets. */
  fill: number;
  /** 0..1: how dense the visible sheets look (log of particles per covered pixel, see densityOf). */
  density: number;
  /** Camera, as in the contract's CameraState: radians and world units. */
  yaw: number;
  pitch: number;
  distance: number;
}

/** Discrete moments the music answers. */
export type SoundEvent =
  /** The dice: a new set of behaviors. The drone moves to another chord and one bell sounds. */
  | { type: "roll"; seed: number }
  /** One soft bell on the current chord, for a moment worth marking (a reveal, a cut). 0..1, default 1. */
  | { type: "accent"; strength?: number };

/** A timed event in a score: it lands on video frame `frame`. */
export type ScoreEvent = SoundEvent & { frame: number };

/**
 * A whole performance's input: one SoundFrame per video frame, plus events.
 * Frame i sounds at time i / fps, the moment video frame i is shown.
 */
export interface SoundScore {
  version: 1;
  fps: number;
  /** Seeds every random choice, so the same score always sounds the same. */
  seed: number;
  frames: SoundFrame[];
  events: ScoreEvent[];
}

/** A soft sound with a start and a natural decay: a glint, a bell. */
export interface Note {
  /** Absolute time in seconds. */
  time: number;
  /** Fundamental in Hz. */
  freq: number;
  /** Linear peak gain of the fundamental. */
  gain: number;
  /** -1..1. */
  pan: number;
  /** Seconds for the fundamental to fall by 60 dB. */
  decay: number;
  kind: "glint" | "bell";
}

/** From `start` on, the drone voices play chord `chord` (an index into CHORDS). */
export interface Segment {
  start: number;
  chord: number;
}

/** Number of drone voices. Voice 0 is the bass, higher voices enter as the count grows. */
export const VOICES = 8;

/** Continuous controls the composer sets every frame. */
export interface ControlFrame {
  /** Per voice gain, 0..1, before the chord crossfade. */
  level: Float32Array;
  /** Per voice stereo position, -1..1. */
  pan: Float32Array;
  /** Drone low-pass cutoff in Hz: brighter when the frame is denser. */
  cutoff: number;
  /** Linear gain of the air (filtered noise) layer. */
  air: number;
  /** Center of the air band in Hz. */
  airFreq: number;
  /** Linear send from the drone into the reverb. */
  wet: number;
}

/**
 * A soundtrack for a recording, handed over in step with the video. Matches
 * `RecordingAudio` in src/capture/recorder.ts by shape, so neither module has
 * to import the other.
 */
export interface RecordingAudio {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  /**
   * Called after each video frame with the video time covered so far. Returns
   * the audio that follows the last buffer it returned, or null when no new
   * chunk is ready yet.
   */
  pull(videoTime: number): Promise<AudioBuffer | null>;
  /** Called once when the recording stops. Returns the rest, so the audio ends exactly at `duration`. */
  finish(duration: number): Promise<AudioBuffer | null>;
  /** Called if the recording is cancelled or fails. */
  cancel(): void;
}
