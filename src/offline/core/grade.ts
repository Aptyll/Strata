/**
 * Grade: stored log frames to finished 8-bit video frames.
 *
 * Runs after the render, on the CPU, in milliseconds per frame. Nothing here
 * needs the GPU, so the look can be changed and the clip re-encoded without
 * re-rendering a single particle.
 *
 * Tone curve, with pp = effective particles in a pixel:
 *   L = log(1 + pp / toe) / log(1 + white / toe),  out = clamp(L)^gamma
 * Near `toe` the response is linear, so a single particle is visible. Above it
 * the response is logarithmic, so a pixel holding a million particles is
 * brighter than one holding a thousand without clipping. Density reads far
 * beyond what one pixel could show by being on or off.
 */
import { HIST_BINS, LOG_SCALE, type FrameStats } from "./develop";
import { ONE } from "./job";
import { pcg } from "./laws";

export interface Look {
  /** Percentile of lit pixels that maps to white, 0..1. */
  whitePercentile: number;
  /** Stops of headroom above that percentile. */
  headroomStops: number;
  /** white / toe. Larger shows fainter detail. */
  contrast: number;
  gamma: number;
  /** Exposure smoothing over time, in frames (Gaussian sigma). */
  smoothFrames: number;
  /** Fixed white point in particles per pixel. Overrides the automatic one. */
  white?: number;
}

export const DEFAULT_LOOK: Look = {
  whitePercentile: 0.995,
  headroomStops: 1,
  contrast: 4096,
  gamma: 1,
  smoothFrames: 20,
};

/** Light level (particles per pixel) below which `fraction` of lit pixels fall. */
function percentile(stats: FrameStats, fraction: number): number {
  const goal = stats.litPixels * fraction;
  let seen = 0;
  for (let b = 0; b < HIST_BINS; b++) {
    seen += stats.hist[b];
    if (seen >= goal && stats.hist[b] > 0) {
      // Upper edge of the bin, converted from code to particles.
      return (Math.pow(2, ((b + 1) * 256) / LOG_SCALE) - 1) / ONE;
    }
  }
  return 1 / ONE;
}

/**
 * White point per frame, in particles per pixel. Automatic exposure follows a
 * percentile of each frame, smoothed over time in log space so it never pumps.
 * `stats` must be in frame order. Frames with no light inherit a neighbor.
 */
export function exposureTrack(stats: FrameStats[], look: Look): number[] {
  if (look.white !== undefined) return stats.map(() => look.white!);
  const raw = stats.map((s) =>
    s.litPixels > 0 ? Math.log(percentile(s, look.whitePercentile)) + look.headroomStops * Math.LN2 : NaN,
  );
  // Fill gaps so the smoothing has something to work with.
  let last = raw.find((v) => !Number.isNaN(v)) ?? 0;
  const filled = raw.map((v) => (Number.isNaN(v) ? last : (last = v)));
  const sigma = look.smoothFrames;
  if (!(sigma > 0)) return filled.map(Math.exp);
  const reach = Math.ceil(sigma * 3);
  return filled.map((_, i) => {
    let sum = 0;
    let weight = 0;
    for (let k = -reach; k <= reach; k++) {
      const j = Math.min(filled.length - 1, Math.max(0, i + k));
      const w = Math.exp((-0.5 * k * k) / (sigma * sigma));
      sum += filled[j] * w;
      weight += w;
    }
    return Math.exp(sum / weight);
  });
}

/** Lookup table from stored code to display value in [0, 255] (float). */
export function toneTable(white: number, look: Look, unitsPerParticle = ONE): Float32Array {
  const lut = new Float32Array(65536);
  const toe = white / look.contrast;
  const norm = 1 / Math.log(1 + white / toe);
  for (let code = 1; code < 65536; code++) {
    const pp = (Math.pow(2, code / LOG_SCALE) - 1) / unitsPerParticle;
    const l = Math.min(1, Math.log(1 + pp / toe) * norm);
    lut[code] = 255 * Math.pow(l, look.gamma);
  }
  return lut;
}

/**
 * Tone map one frame to 8-bit gray. Lit pixels get triangular dither of one
 * code value so smooth gradients do not band. Empty pixels stay exactly black.
 */
export function gradeFrame(codes: Uint16Array, lut: Float32Array, frame: number): Uint8Array {
  const out = new Uint8Array(codes.length);
  const salt = pcg(frame + 0x5bd1e995);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) continue;
    const h = pcg((i + salt) >>> 0);
    const dither = ((h & 0xffff) + (h >>> 16)) / 65536 - 1;
    const v = Math.round(lut[code] + dither);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

// ----------------------------------------------------------------- label ----

/** 5x7 bitmap glyphs, rows top to bottom, 5 bits per row. */
const GLYPHS: Record<string, string> = {
  "0": "01110100011001110101110011000101110",
  "1": "00100011000010000100001000010001110",
  "2": "01110100010000100010001000100011111",
  "3": "11111000100010000010000011000101110",
  "4": "00010001100101010010111110001000010",
  "5": "11111100001111000001000011000101110",
  "6": "00110010001000011110100011000101110",
  "7": "11111000010001000100010000100001000",
  "8": "01110100011000101110100011000101110",
  "9": "01110100011000101111000010001001100",
  A: "01110100011000110001111111000110001",
  B: "11110100011000111110100011000111110",
  C: "01110100011000010000100001000101110",
  D: "11100100101000110001100011001011100",
  E: "11111100001000011110100001000011111",
  F: "11111100001000011110100001000010000",
  G: "01110100011000010111100011000101111",
  H: "10001100011000111111100011000110001",
  I: "01110001000010000100001000010001110",
  J: "00111000100001000010000101001001100",
  K: "10001100101010011000101001001010001",
  L: "10000100001000010000100001000011111",
  M: "10001110111010110101100011000110001",
  N: "10001100011100110101100111000110001",
  O: "01110100011000110001100011000101110",
  P: "11110100011000111110100001000010000",
  Q: "01110100011000110001101011001001101",
  R: "11110100011000111110101001001010001",
  S: "01111100001000001110000010000111110",
  T: "11111001000010000100001000010000100",
  U: "10001100011000110001100011000101110",
  V: "10001100011000110001100010101000100",
  W: "10001100011000110101101011010101010",
  X: "10001100010101000100010101000110001",
  Y: "10001100011000101010001000010000100",
  Z: "11111000010001000100010001000011111",
  ",": "00000000000000000000011000010001000",
  ".": "00000000000000000000000000110001100",
  ":": "00000011000110000000011000110000000",
  "-": "00000000000000011111000000000000000",
  "/": "00001000010001000100010001000010000",
  "(": "00010001000100001000010000010000010",
  ")": "01000001000001000010000100010001000",
  "%": "11000110010001000100010001001100011",
  "+": "00000001000010011111001000010000000",
  "=": "00000000001111100000111110000000000",
};

/**
 * Draw lines of text into an 8-bit frame, bottom-left, in the project's dim
 * white. Unknown characters render as spaces. Text is drawn upper case.
 */
export function drawLabel(
  frame: Uint8Array,
  width: number,
  height: number,
  lines: string[],
  opacity = 0.45,
): void {
  const scale = Math.max(1, Math.round(height / 540));
  const margin = 12 * scale;
  const value = Math.round(255 * opacity);
  const lineHeight = 10 * scale;
  lines.forEach((line, row) => {
    const y0 = height - margin - (lines.length - row) * lineHeight + 3 * scale;
    let x0 = margin;
    for (const ch of line.toUpperCase()) {
      const g = GLYPHS[ch];
      if (g) {
        for (let gy = 0; gy < 7; gy++) {
          for (let gx = 0; gx < 5; gx++) {
            if (g[gy * 5 + gx] !== "1") continue;
            for (let sy = 0; sy < scale; sy++) {
              const y = y0 + gy * scale + sy;
              if (y < 0 || y >= height) continue;
              for (let sx = 0; sx < scale; sx++) {
                const x = x0 + gx * scale + sx;
                if (x < 0 || x >= width) continue;
                const i = y * width + x;
                if (frame[i] < value) frame[i] = value;
              }
            }
          }
        }
      }
      x0 += 6 * scale;
    }
  });
}

/** 1234567 -> "1,234,567". Accepts decimal strings for values past 2^53. */
export function withCommas(n: number | string): string {
  return String(typeof n === "number" ? Math.round(n) : n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
