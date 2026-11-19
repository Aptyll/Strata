/**
 * Develop: turn a raw accumulation grid into a stored frame.
 *
 * A stored frame is a 16-bit log-encoded image of light per output pixel. It
 * keeps the full dynamic range (up to 2^64 weight units per pixel) at about
 * 0.07% precision, so the look (exposure, contrast, labels) is decided later
 * by the grade step without re-rendering anything.
 *
 *   code = round(LOG_SCALE * log2(1 + units))      units = weight units in the pixel
 */
import { accumulationSum, type KernelChoice } from "./renderer";

/** Codes per stop (doubling of light). */
export const LOG_SCALE = 1024;

/** Histogram bins: one per quarter stop, code >> 8. */
export const HIST_BINS = 256;

export interface FrameStats {
  frame: number;
  /**
   * Particles evaluated for this frame, as a decimal string. Counted on the
   * GPU when evaluatedBy is "gpu" (or absent); summed by the host from dispatch
   * sizes when it is "host". Equals the world's particle count for every
   * complete frame.
   */
  evaluated: string;
  /** "gpu": counted by the shader (every kernel now). "host": summed from dispatch sizes, in stats from the trillion kernel before it had its own tally. */
  evaluatedBy?: "gpu" | "host";
  /** Exact sum of the grid in weight units, as a decimal string. */
  unitSum: string;
  /**
   * Exact number of particles whose position fell inside the frame, as a
   * decimal string. evaluated - landed were behind the camera or off frame.
   */
  landed: string;
  /** Output pixels that received any light. */
  litPixels: number;
  /** Largest code in the frame. */
  maxCode: number;
  /** Lit-pixel histogram over code >> 8 (quarter stops). */
  hist: number[];
  /**
   * Wall seconds of GPU work, and how many dispatches it took, for the whole
   * frame: a frame that was stopped and continued sums every run.
   */
  seconds: number;
  batches: number;
  /**
   * How many times the frame was continued from a checkpoint. 0 is one
   * uninterrupted run. Absent in stats written before this field existed,
   * where `seconds` and `batches` of a continued frame cover only its last run.
   */
  resumes?: number;
  /**
   * SHA-256 commitment to the exact accumulation grid (fingerprint.ts).
   * Missing in stats from before it existed, or where WebCrypto is not
   * available (a page served over plain http from another machine).
   */
  gridSha256?: string;
  /** 16 x 9 log-coded tile brightness of the grid (fingerprint.ts), for comparing renders across GPU models. */
  signature?: number[];
  /** The kernel that rendered the frame, so a re-render can use the same one. */
  kernel?: KernelChoice;
}

export const encodeLog = (units: number): number => Math.min(65535, Math.round(LOG_SCALE * Math.log2(1 + units)));
export const decodeLog = (code: number): number => Math.pow(2, code / LOG_SCALE) - 1;

/** Sum the supersampled grid down to output pixels and log-encode. */
export function develop(
  lo: Uint32Array,
  hi: Uint32Array,
  width: number,
  height: number,
  ssaa: number,
): { codes: Uint16Array; litPixels: number; maxCode: number; hist: number[] } {
  const codes = new Uint16Array(width * height);
  const hist = new Array<number>(HIST_BINS).fill(0);
  const gw = width * ssaa;
  let litPixels = 0;
  let maxCode = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let units = 0;
      for (let sy = 0; sy < ssaa; sy++) {
        const row = (y * ssaa + sy) * gw + x * ssaa;
        for (let sx = 0; sx < ssaa; sx++) units += lo[row + sx] + hi[row + sx] * 4294967296;
      }
      if (units > 0) {
        const code = encodeLog(units);
        codes[y * width + x] = code;
        hist[code >> 8]++;
        litPixels++;
        if (code > maxCode) maxCode = code;
      }
    }
  }
  return { codes, litPixels, maxCode, hist };
}

export function frameStats(
  frame: number,
  acc: { lo: Uint32Array; hi: Uint32Array; landed: bigint },
  developed: { litPixels: number; maxCode: number; hist: number[] },
  run: { evaluated: bigint; seconds: number; batches: number; resumes?: number; evaluatedBy?: "gpu" | "host" },
): FrameStats {
  return {
    frame,
    evaluated: run.evaluated.toString(),
    evaluatedBy: run.evaluatedBy,
    unitSum: accumulationSum(acc.lo, acc.hi).toString(),
    landed: acc.landed.toString(),
    litPixels: developed.litPixels,
    maxCode: developed.maxCode,
    hist: developed.hist,
    seconds: run.seconds,
    batches: run.batches,
    resumes: run.resumes,
  };
}
