/** WAV files from rendered audio, for editors and for muxing with ffmpeg. */
import { mulberry32 } from "./rng";

export interface WavOptions {
  /** 16 or 24 bit integer PCM, or 32 bit float. Default 24. */
  bitDepth?: 16 | 24 | 32;
  /** Needed when passing raw channels instead of an AudioBuffer. Default 48000. */
  sampleRate?: number;
}

/** Encodes audio as a WAV file. Integer formats get TPDF dither from a fixed seed, so output is reproducible. */
export function encodeWav(audio: AudioBuffer | readonly Float32Array[], opts: WavOptions = {}): Blob {
  let channels: readonly Float32Array[];
  let sampleRate = opts.sampleRate ?? 48000;
  if (typeof AudioBuffer !== "undefined" && audio instanceof AudioBuffer) {
    channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
    sampleRate = audio.sampleRate;
  } else {
    channels = audio as readonly Float32Array[];
  }
  const bits = opts.bitDepth ?? 24;
  const float = bits === 32;
  const bytes = bits / 8;
  const count = channels.length;
  const frames = count ? channels[0].length : 0;
  const dataBytes = frames * count * bytes;
  const header = float ? 58 : 44; // float adds cbSize to fmt and a fact chunk
  const buffer = new ArrayBuffer(header + dataBytes);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) u8[at + i] = s.charCodeAt(i);
  };

  text(0, "RIFF");
  view.setUint32(4, header - 8 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, float ? 18 : 16, true);
  view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * bytes, true);
  view.setUint16(32, count * bytes, true);
  view.setUint16(34, bits, true);
  let at = 36;
  if (float) {
    view.setUint16(36, 0, true);
    text(38, "fact");
    view.setUint32(42, 4, true);
    view.setUint32(46, frames, true);
    at = 50;
  }
  text(at, "data");
  view.setUint32(at + 4, dataBytes, true);
  at += 8;

  const random = mulberry32(0x5eed);
  const clamp = (x: number) => (x > 1 ? 1 : x < -1 ? -1 : x);
  if (float) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < count; c++, at += 4) view.setFloat32(at, channels[c][i], true);
    }
  } else if (bits === 16) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < count; c++, at += 2) {
        const v = Math.round(clamp(channels[c][i]) * 32767 + random() - random());
        view.setInt16(at, Math.max(-32768, Math.min(32767, v)), true);
      }
    }
  } else {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < count; c++, at += 3) {
        const v = Math.max(-8388608, Math.min(8388607, Math.round(clamp(channels[c][i]) * 8388607 + random() - random())));
        u8[at] = v & 0xff;
        u8[at + 1] = (v >> 8) & 0xff;
        u8[at + 2] = (v >> 16) & 0xff;
      }
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}
