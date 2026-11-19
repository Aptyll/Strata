/**
 * Develop: turn a raw accumulation grid into a stored frame.
 *
 * A stored frame is a 16-bit log-encoded image of light per output pixel. It
 * keeps the full dynamic range (up to 2^64 weight units per pixel) at about
 * 0.07% precision, so the look (exposure, contrast, labels) is decided later
 * by the grade step without re-rendering anything.
 *
 *   code = round(LOG_SCALE * log2(1 + units))      units = light in the pixel, in
 *                                                   ONE units (1/65536 particle)
 *
 * A flux render accumulates in finer units than ONE (job.ts unitsPerParticle).
 * develop() scales the grid to ONE units first, as a real number, so stored
 * frames, exposure and the grade mean the same in every mode, and a pixel
 * holding less than one ONE unit still gets a code in proportion.
 */
import { ONE } from "./job";
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
  /**
   * Exact sum of the grid in its own units, as a decimal string. One particle
   * of light is `unitsPerParticle` of them.
   */
  unitSum: string;
  /**
   * Grid units a particle at full weight adds. Absent means 65536 (ONE): count
   * mode, the trillion kernel, and flux frames from before weights got finer.
   */
  unitsPerParticle?: number;
  /**
   * Exact number of particles whose position fell inside the frame, as a
   * decimal string. evaluated - landed were behind the camera or off frame.
   */
  landed: string;
  /**
   * Exact number of particles in the frame that added at least one unit of
   * light, counted on the GPU, as a decimal string. Equal to `landed` in count
   * mode. Absent in stats written before it was counted.
   */
  drawn?: string;
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

/**
 * Sum the supersampled grid down to output pixels and log-encode.
 * `unitsPerParticle` is the grid's own scale (Accumulation.unitsPerParticle).
 */
export function develop(
  lo: Uint32Array,
  hi: Uint32Array,
  width: number,
  height: number,
  ssaa: number,
  unitsPerParticle: number = ONE,
): { codes: Uint16Array; litPixels: number; maxCode: number; hist: number[] } {
  const codes = new Uint16Array(width * height);
  const hist = new Array<number>(HIST_BINS).fill(0);
  const gw = width * ssaa;
  // A power of two for every grid the renderer makes, so this is exact.
  const toOne = ONE / unitsPerParticle;
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
        // Code 0 means no light at all, so a lit pixel gets at least 1 however faint.
        const code = Math.max(1, encodeLog(units * toOne));
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
  acc: { lo: Uint32Array; hi: Uint32Array; landed: bigint; drawn?: bigint; unitsPerParticle?: number },
  developed: { litPixels: number; maxCode: number; hist: number[] },
  run: { evaluated: bigint; seconds: number; batches: number; resumes?: number; evaluatedBy?: "gpu" | "host" },
): FrameStats {
  return {
    frame,
    evaluated: run.evaluated.toString(),
    evaluatedBy: run.evaluatedBy,
    unitSum: accumulationSum(acc.lo, acc.hi).toString(),
    // Left out when it is ONE, so count-mode stats read as they always did.
    unitsPerParticle: acc.unitsPerParticle === undefined || acc.unitsPerParticle === ONE ? undefined : acc.unitsPerParticle,
    landed: acc.landed.toString(),
    drawn: acc.drawn?.toString(),
    litPixels: developed.litPixels,
    maxCode: developed.maxCode,
    hist: developed.hist,
    seconds: run.seconds,
    batches: run.batches,
    resumes: run.resumes,
  };
}
