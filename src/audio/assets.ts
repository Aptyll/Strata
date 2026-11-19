/**
 * Buffers the synth plays from: one wavetable for the drone voices, a loop of
 * pink noise for the air, and a reverb impulse. All generated from fixed seeds,
 * so every context (live or offline, any chunk) hears exactly the same ones.
 * AudioBuffers made with the constructor belong to no context and are shared.
 */
import { hashSeed, mulberry32 } from "./rng";

export interface SoundAssets {
  readonly sampleRate: number;
  /** One cycle of the drone voice waveform. */
  readonly wavetable: AudioBuffer;
  /** Seamless stereo loop of pink noise. */
  readonly noise: AudioBuffer;
  /** Stereo reverb impulse, energy 1 per channel. */
  readonly impulse: AudioBuffer;
}

export const WAVETABLE_LENGTH = 2048;
const NOISE_SECONDS = 8;
const REVERB_SECONDS = 4.5;
/** Seconds for the reverb tail to fall 60 dB. */
const REVERB_RT60 = 4.2;

const cache = new Map<number, SoundAssets>();

export function soundAssets(sampleRate: number): SoundAssets {
  let assets = cache.get(sampleRate);
  if (!assets) {
    assets = { sampleRate, wavetable: wavetable(sampleRate), noise: noise(sampleRate), impulse: impulse(sampleRate) };
    cache.set(sampleRate, assets);
  }
  return assets;
}

/**
 * A soft, mostly fundamental tone: harmonics 1 to 8 at 1/k^2. Through the
 * drone's low-pass it reads as nearly pure when dark and gains a little air
 * when the filter opens.
 */
function wavetable(sampleRate: number): AudioBuffer {
  const n = WAVETABLE_LENGTH;
  const data = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    let x = 0;
    for (let k = 1; k <= 8; k++) x += Math.sin(k * theta) / (k * k);
    data[i] = x;
    peak = Math.max(peak, Math.abs(x));
  }
  for (let i = 0; i < n; i++) data[i] /= peak;
  const buffer = new AudioBuffer({ length: n, sampleRate, numberOfChannels: 1 });
  buffer.copyToChannel(data, 0);
  return buffer;
}

/** Stereo pink noise (Paul Kellet's filter), RMS about 0.5, with the end crossfaded into the start. */
function noise(sampleRate: number): AudioBuffer {
  const n = Math.round(NOISE_SECONDS * sampleRate);
  const fade = Math.round(0.25 * sampleRate);
  const buffer = new AudioBuffer({ length: n, sampleRate, numberOfChannels: 2 });
  for (let ch = 0; ch < 2; ch++) {
    const random = mulberry32(hashSeed(0xa1, ch));
    const raw = new Float32Array(n + fade);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let energy = 0;
    for (let i = 0; i < raw.length; i++) {
      const white = random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      raw[i] = pink;
      if (i < n) energy += pink * pink;
    }
    const scale = 0.5 / Math.sqrt(energy / n);
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = raw[i] * scale;
    // The sample after the last is the first: blend the continuation into the head.
    for (let i = 0; i < fade; i++) {
      const w = i / fade;
      data[i] = data[i] * Math.sqrt(w) + raw[n + i] * scale * Math.sqrt(1 - w);
    }
    buffer.copyToChannel(data, ch);
  }
  return buffer;
}

/**
 * A large, dark hall: decaying noise whose brightness falls over time, a short
 * pre-delay, and independent noise per channel for width.
 */
function impulse(sampleRate: number): AudioBuffer {
  const n = Math.round(REVERB_SECONDS * sampleRate);
  const predelay = Math.round(0.015 * sampleRate);
  const buffer = new AudioBuffer({ length: n, sampleRate, numberOfChannels: 2 });
  for (let ch = 0; ch < 2; ch++) {
    const random = mulberry32(hashSeed(0xb7, ch));
    const data = new Float32Array(n);
    let y = 0;
    let energy = 0;
    for (let i = predelay; i < n; i++) {
      const t = (i - predelay) / sampleRate;
      // Low-pass cutoff glides from 9 kHz down to 1.2 kHz across the tail.
      const fc = 9000 * Math.pow(1200 / 9000, t / REVERB_SECONDS);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);
      y += a * (random() * 2 - 1 - y);
      const onset = Math.min(1, t / 0.01);
      const v = y * Math.exp((-6.91 * t) / REVERB_RT60) * onset;
      data[i] = v;
      energy += v * v;
    }
    const scale = 1 / Math.sqrt(energy);
    for (let i = 0; i < n; i++) data[i] *= scale;
    buffer.copyToChannel(data, ch);
  }
  return buffer;
}
