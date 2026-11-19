/**
 * The synth as a Web Audio graph, built the same way on a live AudioContext
 * and on an OfflineAudioContext.
 *
 *   chord voices ─ env (per chord) ─ voiceGain[v] ─ voicePan[v] ─┐
 *                                                                droneFilter ─ drone ─┬───────────── master ─ softClip ─ out
 *                                                                                     └ droneSend ─ reverb ─┘
 *   noise loop ─ airFilter ─ airGain ─────────────────────────────────────────────────────────────── master
 *   glints, bells ─ pan ─ notes ─┬ notesDry ───────────────────────────────────────────────────────── master
 *                                └ notesSend ─ reverb
 *
 * Everything with memory is either a pure function of absolute time (voice
 * phases, the noise position) or forgets its past within a few seconds
 * (filters, the reverb). That is what lets the offline renderer cut a long
 * soundtrack into chunks that join without a seam.
 */
import { WAVETABLE_LENGTH, type SoundAssets } from "./assets";
import { VOICE_BEAT, voiceHz } from "./harmony";
import { VOICES, type Note, type Segment } from "./types";

/** Overall level of the drone bus. Sets the loudness of the whole mix: about -18 LUFS. */
const DRONE_LEVEL = 0.135;
const REVERB_RETURN = 0.8;
/** Gain of a voice's detuned partner relative to the main oscillator. */
const PARTNER = 0.6;

/** Seconds a new chord takes to fade in. */
export const CHORD_FADE_IN = 3;
/** Seconds after a new chord starts before the old one starts to fade. */
export const CHORD_OUT_DELAY = 0.6;
/** Seconds the old chord takes to fade out. */
export const CHORD_FADE_OUT = 3.5;

export interface SoundGraph {
  readonly ctx: BaseAudioContext;
  readonly assets: SoundAssets;
  readonly voiceGain: readonly GainNode[];
  readonly voicePan: readonly StereoPannerNode[];
  readonly droneFilter: BiquadFilterNode;
  readonly droneSend: GainNode;
  readonly airGain: GainNode;
  readonly airFilter: BiquadFilterNode;
  readonly notes: GainNode;
  readonly master: GainNode;
  /** Stops the noise loop and disconnects everything. */
  dispose(): void;
}

export interface GraphOptions {
  /** Absolute time, in seconds, that context time 0 stands for. Keeps the noise loop continuous across chunks. */
  timeOrigin: number;
}

export function buildGraph(ctx: BaseAudioContext, assets: SoundAssets, opts: GraphOptions): SoundGraph {
  const master = new GainNode(ctx, { gain: 0 });
  const clip = new WaveShaperNode(ctx, { curve: softClipCurve(), oversample: "none" });
  master.connect(clip).connect(ctx.destination);

  const reverb = new ConvolverNode(ctx, { buffer: assets.impulse, disableNormalization: true });
  reverb.connect(new GainNode(ctx, { gain: REVERB_RETURN })).connect(master);

  const droneFilter = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 800, Q: 0.6 });
  const drone = new GainNode(ctx, { gain: DRONE_LEVEL });
  const droneSend = new GainNode(ctx, { gain: 0.3 });
  droneFilter.connect(drone);
  drone.connect(master);
  drone.connect(droneSend).connect(reverb);

  const voiceGain: GainNode[] = [];
  const voicePan: StereoPannerNode[] = [];
  for (let v = 0; v < VOICES; v++) {
    const gain = new GainNode(ctx, { gain: 0 });
    const pan = new StereoPannerNode(ctx, { pan: 0 });
    gain.connect(pan).connect(droneFilter);
    voiceGain.push(gain);
    voicePan.push(pan);
  }

  const air = new AudioBufferSourceNode(ctx, { buffer: assets.noise, loop: true });
  const airFilter = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 1200, Q: 0.8 });
  const airGain = new GainNode(ctx, { gain: 0 });
  air.connect(airFilter).connect(airGain).connect(master);
  const loop = assets.noise.length;
  const offset = ((Math.round(opts.timeOrigin * assets.sampleRate) % loop) + loop) % loop;
  air.start(0, offset / assets.sampleRate);

  const notes = new GainNode(ctx, { gain: 1 });
  notes.connect(new GainNode(ctx, { gain: 0.5 })).connect(master);
  notes.connect(new GainNode(ctx, { gain: 1 })).connect(reverb);

  return {
    ctx,
    assets,
    voiceGain,
    voicePan,
    droneFilter,
    droneSend,
    airGain,
    airFilter,
    notes,
    master,
    dispose() {
      try {
        air.stop();
      } catch {
        // already stopped
      }
      master.disconnect();
    },
  };
}

/** The oscillators of one chord. `env` holds one gain per voice; all of them carry the same fade. */
export interface ChordVoices {
  readonly env: readonly GainNode[];
  stop(when: number): void;
}

/**
 * Starts the voices of `chord` at context time `when`. `elapsed` is how long
 * the chord has already been sounding at that moment (for a chord that began
 * before this context existed), so every oscillator picks up at the phase it
 * would have had in one long render.
 */
export function startChord(g: SoundGraph, chord: number, when: number, elapsed: number): ChordVoices {
  const { ctx, assets } = g;
  const cycle = WAVETABLE_LENGTH / assets.sampleRate; // seconds per cycle at playbackRate 1
  const env: GainNode[] = [];
  const sources: AudioBufferSourceNode[] = [];
  for (let v = 0; v < VOICES; v++) {
    const e = new GainNode(ctx, { gain: 0 });
    e.connect(g.voiceGain[v]);
    env.push(e);
    const hz = voiceHz(chord, v);
    const partner = new GainNode(ctx, { gain: PARTNER });
    partner.connect(e);
    for (const [freq, dest] of [
      [hz, e],
      [hz + VOICE_BEAT[v], partner],
    ] as const) {
      const src = new AudioBufferSourceNode(ctx, { buffer: assets.wavetable, loop: true, playbackRate: freq * cycle });
      src.connect(dest);
      const phase = (freq * elapsed) % 1;
      src.start(when, phase * cycle);
      sources.push(src);
    }
  }
  return {
    env,
    stop(at: number) {
      for (const s of sources) s.stop(at);
    },
  };
}

/** Breakpoints `[time, value]` of a chord's fade, in absolute seconds. Linear in between. */
export function chordEnvelope(segment: Segment, next: Segment | undefined, first: boolean): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const fadedIn = first ? segment.start : segment.start + CHORD_FADE_IN;
  points.push([segment.start, first ? 1 : 0]);
  if (!first) points.push([fadedIn, 1]);
  if (next) {
    // The fade out waits for the fade in to finish, so a chord is never cut off mid-swell.
    const out = Math.max(next.start + CHORD_OUT_DELAY, fadedIn);
    points.push([out, 1], [out + CHORD_FADE_OUT, 0]);
  }
  return points;
}

/** Value of a breakpoint list at time t: held before the first and after the last point. */
export function valueAt(points: ReadonlyArray<readonly [number, number]>, t: number): number {
  if (!points.length) return 0;
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i];
    if (t <= t1) {
      const [t0, v0] = points[i - 1];
      return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1;
    }
  }
  return points[points.length - 1][1];
}

/**
 * Schedules the part of a breakpoint list after absolute time `origin` (which
 * is context time 0) onto `param`.
 */
export function scheduleBreakpoints(param: AudioParam, points: ReadonlyArray<readonly [number, number]>, origin: number): void {
  param.setValueAtTime(valueAt(points, origin), 0);
  for (const [t, v] of points) if (t > origin) param.linearRampToValueAtTime(v, t - origin);
}

/** Partials of each note kind: [frequency ratio, relative gain, relative decay]. */
const PARTIALS: Record<Note["kind"], ReadonlyArray<readonly [number, number, number]>> = {
  glint: [
    [1, 1, 1],
    [3, 0.12, 0.35],
  ],
  bell: [
    [1, 1, 1],
    [2, 0.32, 0.6],
    [3, 0.12, 0.42],
    [4.07, 0.06, 0.28],
  ],
};

/** Plays a note at context time `when`. */
export function playNote(g: SoundGraph, note: Note, when: number): void {
  const { ctx } = g;
  const pan = new StereoPannerNode(ctx, { pan: Math.max(-1, Math.min(1, note.pan)) });
  pan.connect(g.notes);
  const attack = note.kind === "bell" ? 0.006 : 0.004;
  for (const [ratio, rel, decayScale] of PARTIALS[note.kind]) {
    const freq = note.freq * ratio;
    if (freq >= ctx.sampleRate * 0.45) continue;
    const tau = (note.decay * decayScale) / 6.91; // 60 dB in `decay` seconds
    const osc = new OscillatorNode(ctx, { type: "sine", frequency: freq });
    const env = new GainNode(ctx, { gain: 0 });
    osc.connect(env).connect(pan);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(note.gain * rel, when + attack);
    env.gain.setTargetAtTime(0, when + attack, tau);
    osc.start(when);
    osc.stop(when + attack + 9 * tau); // 78 dB down
  }
}

/** Linear up to 0.6, then a gentle knee toward 0.9. A safety net, not a sound: the mix rarely reaches it. */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 2049;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= 0.6 ? a : 0.6 + 0.4 * Math.tanh((a - 0.6) / 0.4);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}
