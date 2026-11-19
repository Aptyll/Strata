/**
 * The soundtrack in the live app: an AudioContext that plays what the
 * composer writes, frame by frame. Off until enable() is called, which must
 * happen in a click or key handler the first time (browsers only start audio
 * after a gesture). Costs nothing while off: no context, no work per frame.
 */
import { soundAssets } from "./assets";
import { Composer, type ComposerOptions } from "./composer";
import {
  CHORD_FADE_IN,
  CHORD_FADE_OUT,
  CHORD_OUT_DELAY,
  buildGraph,
  playNote,
  startChord,
  type ChordVoices,
  type SoundGraph,
} from "./graph";
import { nextChord } from "./harmony";
import { VOICES, type ControlFrame, type Note, type Segment, type SoundEvent, type SoundFrame } from "./types";

export interface SoundtrackOptions {
  /** Seeds every random choice. Default 1. */
  seed?: number;
  /** 0..1. Default 0.7. */
  volume?: number;
  composer?: Omit<ComposerOptions, "seed" | "chord">;
}

export interface Soundtrack {
  readonly enabled: boolean;
  /** The chord sounding now (or that will sound when enabled). */
  readonly chord: number;
  /** 0..1. */
  volume: number;
  /** The controls of the last frame, for meters and debugging. Null while off. */
  readonly controls: ControlFrame | null;
  /** Starts the sound, fading in. Call from a click or key handler the first time. */
  enable(): Promise<void>;
  /** Fades out, then suspends the audio context. */
  disable(): void;
  setEnabled(on: boolean): Promise<void>;
  /** Call once per rendered frame. Returns at once while the sound is off. */
  frame(frame: SoundFrame, dt: number): void;
  event(event: SoundEvent): void;
  /** Silence the live sound without turning it off, for example while an offline render owns the frames. */
  hold(on: boolean): void;
  dispose(): void;
}

/** Live output is a little quieter than renders: it plays under whatever else the visitor hears. */
const LIVE_GAIN = 0.8;
/** Seconds between control updates sent to the audio thread. */
const CONTROL_INTERVAL = 1 / 40;
/** Smoothing of control updates on the audio thread, against zipper noise. */
const CONTROL_TAU = 0.05;
/** Notes are scheduled this far ahead, so they never land in the past. */
const LOOKAHEAD = 0.03;

interface LiveChord {
  voices: ChordVoices;
  /** Context time its fade in ends. */
  fadedIn: number;
  /** Context time its sources stop, once a newer chord has replaced it. */
  stopAt?: number;
}

export function createSoundtrack(opts: SoundtrackOptions = {}): Soundtrack {
  const seed = opts.seed ?? 1;
  let volume = clamp01(opts.volume ?? 0.7);
  let enabled = false;
  let heldByCaller = false;
  let hidden = typeof document !== "undefined" && document.hidden;
  let chord = 0;

  let ctx: AudioContext | null = null;
  let graph: SoundGraph | null = null;
  let composer: Composer | null = null;
  /** Composer time: seconds of frames since the sound was enabled. */
  let clock = 0;
  /** Composer time minus context time, fixed at each frame, to place notes. */
  let frameCtxTime = 0;
  let sinceControl = CONTROL_INTERVAL;
  let pending: SoundEvent[] = [];
  let lastControls: ControlFrame | null = null;
  let chords: LiveChord[] = [];
  let suspendTimer = 0;

  const audible = () => enabled && !heldByCaller && !hidden;

  const sink = {
    note(n: Note) {
      if (!graph || !ctx) return;
      playNote(graph, n, frameCtxTime + LOOKAHEAD + Math.max(0, n.time - clock));
    },
    segment(s: Segment) {
      if (!graph || !ctx) return;
      const when = ctx.currentTime + LOOKAHEAD;
      beginChord(s.chord, when, false);
    },
  };

  /**
   * Starts a chord at context time `when` and fades out the one before, with
   * the same timing as chordEnvelope uses offline: the old chord waits for the
   * new one to get going, and never starts fading before its own fade in ends.
   */
  function beginChord(index: number, when: number, first: boolean): void {
    if (!graph) return;
    const previous = chords[chords.length - 1];
    if (previous && previous.stopAt === undefined) {
      const out = Math.max(when + CHORD_OUT_DELAY, previous.fadedIn);
      for (const e of previous.voices.env) {
        e.gain.setValueAtTime(1, out);
        e.gain.linearRampToValueAtTime(0, out + CHORD_FADE_OUT);
      }
      previous.stopAt = out + CHORD_FADE_OUT + 0.05;
      previous.voices.stop(previous.stopAt);
    }
    const voices = startChord(graph, index, when, 0);
    // The first chord is simply there: the master fade brings the sound in.
    const fadedIn = first ? when : when + CHORD_FADE_IN;
    for (const e of voices.env) {
      e.gain.setValueAtTime(first ? 1 : 0, when);
      if (!first) e.gain.linearRampToValueAtTime(1, fadedIn);
    }
    chords.push({ voices, fadedIn });
  }

  function dropChords(): void {
    const now = ctx?.currentTime ?? 0;
    for (const c of chords) if (c.stopAt === undefined) c.voices.stop(now);
    chords = [];
  }

  function applyControls(c: ControlFrame): void {
    if (!graph || !ctx) return;
    const now = ctx.currentTime;
    for (let v = 0; v < VOICES; v++) {
      graph.voiceGain[v].gain.setTargetAtTime(c.level[v], now, CONTROL_TAU);
      graph.voicePan[v].pan.setTargetAtTime(c.pan[v], now, CONTROL_TAU);
    }
    graph.droneFilter.frequency.setTargetAtTime(c.cutoff, now, CONTROL_TAU);
    graph.airGain.gain.setTargetAtTime(c.air, now, CONTROL_TAU);
    graph.airFilter.frequency.setTargetAtTime(c.airFreq, now, CONTROL_TAU);
    graph.droneSend.gain.setTargetAtTime(c.wet, now, CONTROL_TAU);
  }

  /** Ramps the master to where it should be, and suspends the context once silent. */
  function applyMaster(seconds: number): void {
    if (!ctx || !graph) return;
    const target = audible() ? volume * LIVE_GAIN : 0;
    const gain = graph.master.gain;
    const now = ctx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(target, now + seconds);
    clearTimeout(suspendTimer);
    if (target > 0) {
      if (ctx.state === "suspended") void ctx.resume();
    } else {
      const c = ctx;
      suspendTimer = window.setTimeout(() => {
        if (!audible() && c.state === "running") void c.suspend();
        if (!enabled) dropChords();
      }, seconds * 1000 + 150);
    }
  }

  const onVisibility = () => {
    hidden = document.hidden;
    applyMaster(hidden ? 0.2 : 0.8);
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  const soundtrack: Soundtrack = {
    get enabled() {
      return enabled;
    },
    get chord() {
      return composer?.chord ?? chord;
    },
    get controls() {
      return enabled ? lastControls : null;
    },
    get volume() {
      return volume;
    },
    set volume(v: number) {
      volume = clamp01(v);
      applyMaster(0.1);
    },

    async enable() {
      if (enabled) return;
      if (!ctx) {
        ctx = new AudioContext({ latencyHint: "playback" });
        graph = buildGraph(ctx, soundAssets(ctx.sampleRate), { timeOrigin: 0 });
      }
      // Resume inside the gesture that called us; awaiting first would lose it.
      const resumed = ctx.resume();
      enabled = true;
      dropChords();
      // A fresh composer: smoothing starts from the scene as it is now, and
      // counts already reached ring no bell.
      composer = new Composer({ ...opts.composer, seed, chord }, sink);
      clock = 0;
      sinceControl = CONTROL_INTERVAL;
      pending = [];
      beginChord(chord, ctx.currentTime + LOOKAHEAD, true);
      applyMaster(1.5);
      await resumed;
    },

    disable() {
      if (!enabled) return;
      if (composer) chord = composer.chord;
      composer = null;
      enabled = false;
      applyMaster(0.6);
    },

    async setEnabled(on: boolean) {
      if (on) await soundtrack.enable();
      else soundtrack.disable();
    },

    frame(f: SoundFrame, dt: number) {
      if (!enabled || !composer || !ctx || ctx.state !== "running" || !(dt > 0)) return;
      clock += dt;
      frameCtxTime = ctx.currentTime;
      const events = pending;
      pending = [];
      const controls = composer.step(f, clock, dt, events);
      lastControls = controls;
      sinceControl += dt;
      if (sinceControl >= CONTROL_INTERVAL) {
        sinceControl = 0;
        applyControls(controls);
      }
      // Forget chords whose sources have stopped.
      const now = ctx.currentTime;
      chords = chords.filter((c) => c.stopAt === undefined || c.stopAt > now);
    },

    event(e: SoundEvent) {
      if (enabled && composer) pending.push(e);
      else if (e.type === "roll") chord = nextChord(chord, e.seed); // keep following the dice while off
    },

    hold(on: boolean) {
      heldByCaller = on;
      applyMaster(on ? 0.3 : 1);
    },

    dispose() {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(suspendTimer);
      enabled = false;
      dropChords();
      graph?.dispose();
      void ctx?.close();
      ctx = null;
      graph = null;
      composer = null;
    },
  };
  return soundtrack;
}

function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0;
}
