/**
 * Offline rendering: a performance to audio, faster than realtime, with an
 * OfflineAudioContext. Frame i of the video is at i / fps on the audio
 * timeline too, so the soundtrack lines up with fixed-step video exactly.
 *
 * Long soundtracks are rendered in chunks. Each chunk first renders PREROLL
 * seconds before its start and throws them away, so the reverb tail, the
 * filters and any ringing bells are where one long render would have them;
 * voice phases and the noise loop are set from absolute time. Chunks
 * therefore join without a seam, which is what lets a recording stream audio
 * into the MP4 while the video is still rendering.
 */
import { soundAssets } from "./assets";
import { buildGraph, chordEnvelope, playNote, scheduleBreakpoints, startChord, valueAt, type SoundGraph } from "./graph";
import { compose, type SoundPerformance } from "./performance";
import type { ComposerOptions } from "./composer";
import { VOICES, type RecordingAudio, type SoundScore } from "./types";

/** 48 kHz divides evenly by 24, 25, 30, 50 and 60 fps: every video frame starts on a whole sample. */
export const DEFAULT_SAMPLE_RATE = 48000;
/** Seconds rendered and discarded before a chunk: longer than the reverb plus the longest bell. */
export const PREROLL = 10;

export interface RenderOptions {
  /** Default 48000. */
  sampleRate?: number;
  /** Extra gain in dB on the whole mix. Default 0. */
  gain?: number;
  /** Seconds of fade in at the start. Default 1. */
  fadeIn?: number;
  /** Seconds of fade out before `duration`. Default 2. Applied only when `duration` is known. */
  fadeOut?: number;
  /** Total length in seconds, for the fade out. */
  duration?: number;
}

/** Master gain over absolute time: fade in, then fade out before `duration` when it is known. */
function masterPoints(opts: RenderOptions): Array<[number, number]> {
  const gain = Math.pow(10, (opts.gain ?? 0) / 20);
  const fadeIn = Math.max(0, opts.fadeIn ?? 1);
  const points: Array<[number, number]> = fadeIn > 0 ? [[0, 0], [fadeIn, gain]] : [[0, gain]];
  if (opts.duration !== undefined) {
    const fadeOut = Math.min(Math.max(0, opts.fadeOut ?? 2), opts.duration);
    const start = Math.max(opts.duration - fadeOut, Math.min(fadeIn, opts.duration));
    points.push([start, valueAt(points, start)], [opts.duration, 0]);
  }
  return points;
}

/**
 * Schedules a per-frame track on `param` for the absolute span [origin, end]:
 * the frames inside it as one value curve (linear between frames), the value
 * at `origin` before the first of them.
 */
function scheduleTrack(param: AudioParam, values: Float32Array, fps: number, origin: number, end: number): void {
  const frames = values.length;
  if (!frames) return;
  const at = (t: number) => {
    const x = t * fps;
    const i = Math.floor(x);
    if (i >= frames - 1) return values[frames - 1];
    if (i < 0) return values[0];
    return values[i] + (values[i + 1] - values[i]) * (x - i);
  };
  const first = Math.max(0, Math.ceil(origin * fps - 1e-6));
  const last = Math.min(frames - 1, Math.ceil(end * fps - 1e-6));
  const start = Math.max(0, first / fps - origin);
  if (start > 1e-7 || last <= first) param.setValueAtTime(at(origin), 0);
  if (last > first) param.setValueCurveAtTime(values.slice(first, last + 1), start, (last - first) / fps);
}

function scheduleChords(g: SoundGraph, perf: SoundPerformance, origin: number, end: number): void {
  const segments = perf.segments;
  segments.forEach((segment, i) => {
    const next = segments[i + 1];
    const points = chordEnvelope(segment, next, i === 0);
    const silentFrom = next ? points[points.length - 1][0] : Infinity;
    if (segment.start >= end || silentFrom <= origin) return;
    const when = Math.max(0, segment.start - origin);
    const voices = startChord(g, segment.chord, when, Math.max(0, origin - segment.start));
    for (const env of voices.env) scheduleBreakpoints(env.gain, points, origin);
    if (silentFrom < end) voices.stop(silentFrom - origin + 0.05);
  });
}

/**
 * Renders samples [from, to) of a performance. Frames past the last one hold
 * its values, so a soundtrack can run to the end of the last video frame.
 */
export async function renderRange(perf: SoundPerformance, from: number, to: number, opts: RenderOptions = {}): Promise<AudioBuffer> {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  if (!(to > from) || from < 0) throw new RangeError(`audio: bad sample range ${from}..${to}`);
  const pre = Math.min(from, Math.round(PREROLL * sampleRate));
  const first = from - pre;
  const origin = first / sampleRate;
  const end = to / sampleRate;

  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: to - first, sampleRate });
  const g = buildGraph(ctx, soundAssets(sampleRate), { timeOrigin: origin });
  for (let v = 0; v < VOICES; v++) {
    scheduleTrack(g.voiceGain[v].gain, perf.level(v), perf.fps, origin, end);
    scheduleTrack(g.voicePan[v].pan, perf.pan(v), perf.fps, origin, end);
  }
  scheduleTrack(g.droneFilter.frequency, perf.cutoff(), perf.fps, origin, end);
  scheduleTrack(g.airGain.gain, perf.air(), perf.fps, origin, end);
  scheduleTrack(g.airFilter.frequency, perf.airFreq(), perf.fps, origin, end);
  scheduleTrack(g.droneSend.gain, perf.wet(), perf.fps, origin, end);
  scheduleChords(g, perf, origin, end);
  for (const n of perf.notes) if (n.time >= origin && n.time < end) playNote(g, n, n.time - origin);
  scheduleBreakpoints(g.master.gain, masterPoints(opts), origin);

  const rendered = await ctx.startRendering();
  if (pre === 0) return rendered;
  const out = new AudioBuffer({ numberOfChannels: 2, length: to - from, sampleRate });
  for (let ch = 0; ch < 2; ch++) out.copyToChannel(rendered.getChannelData(ch).subarray(pre), ch);
  return out;
}

export interface FullRenderOptions extends RenderOptions {
  /** Seconds per OfflineAudioContext. Default 60. */
  chunkSeconds?: number;
  onProgress?: (fraction: number) => void;
}

/** Renders a whole performance (to `duration`, default the end of its last frame) into one buffer. */
export async function renderPerformance(perf: SoundPerformance, opts: FullRenderOptions = {}): Promise<AudioBuffer> {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const duration = opts.duration ?? perf.duration;
  const total = Math.round(duration * sampleRate);
  if (total <= 0) throw new RangeError("audio: nothing to render");
  const chunk = Math.max(1, Math.round((opts.chunkSeconds ?? 60) * sampleRate));
  const out = new AudioBuffer({ numberOfChannels: 2, length: total, sampleRate });
  for (let from = 0; from < total; from += chunk) {
    const to = Math.min(total, from + chunk);
    const part = await renderRange(perf, from, to, { ...opts, sampleRate, duration });
    for (let ch = 0; ch < 2; ch++) out.copyToChannel(part.getChannelData(ch), ch, from);
    opts.onProgress?.(to / total);
  }
  return out;
}

/** Composes and renders a score. The audio is exactly frames / fps seconds long. */
export async function renderScore(
  score: SoundScore,
  opts: FullRenderOptions & { composer?: ComposerOptions } = {},
): Promise<AudioBuffer> {
  const perf = compose(score, opts.composer);
  return renderPerformance(perf, { ...opts, duration: opts.duration ?? score.frames.length / score.fps });
}

export interface RecordingAudioOptions extends Omit<RenderOptions, "duration"> {
  /** Seconds per chunk handed to the recorder. Default 8. The muxer holds about this much video until its audio arrives. */
  chunkSeconds?: number;
  /** Called once when the recording finishes or is cancelled. */
  onDone?: () => void;
  /** Keep a copy of everything handed over, for wav(). Default false. */
  keep?: boolean;
}

export interface SoundtrackRecording extends RecordingAudio {
  /** Everything handed over so far, when created with `keep: true`. */
  channels(): Float32Array[] | null;
}

/**
 * Audio for a recording that is still being made. The caller keeps pushing
 * frames into `perf` (one per video frame); the recorder pulls finished chunks
 * as the video advances and gets the rest, faded out, when it stops. Pass the
 * result as `recording.audio` to src/capture.
 */
export function createRecordingAudio(perf: SoundPerformance, opts: RecordingAudioOptions = {}): SoundtrackRecording {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const chunk = Math.max(1, Math.round((opts.chunkSeconds ?? 8) * sampleRate));
  // Audio is held back by the fade out, so the end can still fade when the length becomes known.
  const holdBack = Math.max(0, opts.fadeOut ?? 2);
  const kept: Float32Array[][] | null = opts.keep ? [] : null;
  let emitted = 0;
  let over = false;

  const done = () => {
    if (over) return;
    over = true;
    opts.onDone?.();
  };
  const keep = (b: AudioBuffer) => kept?.push([b.getChannelData(0).slice(), b.getChannelData(1).slice()]);

  return {
    sampleRate,
    numberOfChannels: 2,

    async pull(videoTime: number) {
      if (over || perf.frames === 0) return null;
      const known = Math.min(videoTime, (perf.frames - 1) / perf.fps) - holdBack;
      if (Math.floor(known * sampleRate) - emitted < chunk) return null;
      const b = await renderRange(perf, emitted, emitted + chunk, { ...opts, sampleRate });
      emitted += chunk;
      keep(b);
      return b;
    },

    async finish(duration: number) {
      if (over) return null;
      try {
        const end = Math.round(duration * sampleRate);
        if (end <= emitted || perf.frames === 0) return null;
        const out = new AudioBuffer({ numberOfChannels: 2, length: end - emitted, sampleRate });
        for (let from = emitted; from < end; from += chunk) {
          const to = Math.min(end, from + chunk);
          const part = await renderRange(perf, from, to, { ...opts, sampleRate, duration });
          for (let ch = 0; ch < 2; ch++) out.copyToChannel(part.getChannelData(ch), ch, from - emitted);
        }
        emitted = end;
        keep(out);
        return out;
      } finally {
        done();
      }
    },

    cancel: done,

    channels() {
      if (!kept) return null;
      const length = kept.reduce((n, part) => n + part[0].length, 0);
      return [0, 1].map((ch) => {
        const all = new Float32Array(length);
        let at = 0;
        for (const part of kept) {
          all.set(part[ch], at);
          at += part[ch].length;
        }
        return all;
      });
    },
  };
}
