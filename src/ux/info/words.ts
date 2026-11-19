/**
 * The words Strata uses with viewers, and how it writes counts. One place, so
 * the stats line, the sheet label and the about card all say the same thing.
 * The vocabulary and the rules: docs/ux/information.md.
 *
 * The one rule that must never slip (CLAUDE.md, "Honest counting"): a count
 * always carries the word that says what was done to those particles.
 *
 *   simulated   stored state, stepped this frame       the live world
 *   stored      held in GPU memory, maybe resting      the live world
 *   rendered    stateless, computed and forgotten      the trillion (offline)
 *
 * Pure: no DOM, so tests and other modules can import it freely.
 */
import { formatCount } from "../hud/index.js";

/** A word viewers see and the plain sentence that defines it. */
export interface Term {
  readonly word: string;
  readonly means: string;
}

export const TERMS = {
  particle: {
    word: "particle",
    means: "One dot of light. Where particles overlap their light adds up, so brighter means denser.",
  },
  sheet: {
    word: "sheet",
    means: "A flat square floating in the void that runs its own 2D particle system. The code calls it a plane.",
  },
  behavior: {
    word: "behavior",
    means: "The one rule a sheet's particles follow.",
  },
  simulated: {
    word: "simulated",
    means:
      "Every particle has a position and a velocity stored on the graphics card, and each one is moved forward every frame.",
  },
  stored: {
    word: "stored",
    means:
      "Particles held in GPU memory. A sheet that is out of view rests, and a sheet can be thinned to hold the frame rate, so fewer may be simulated than stored.",
  },
  rendered: {
    word: "rendered",
    means:
      "Nothing is stored. For each frame, every particle's position is computed from its number and the time. The ones that land in view add light to the picture, and nothing is kept for the next frame.",
  },
} as const satisfies Record<string, Term>;

/**
 * Measured results the app is allowed to quote, with the hardware they were
 * measured on. Source: README.md ("The numbers", "Rendered, not simulated").
 * When a new number is measured on the real GPU, change it there and here.
 */
export const MEASURED = {
  gpu: "RTX 2070",
  /** Particles in one offline 4K frame. */
  trillion: 1_000_000_000_000,
  /**
   * Seconds per 4K trillion frame, fastest and slowest framing, for the two
   * ways a particle's light is added. The times differ sixfold, so a time is
   * never quoted without saying which one it is.
   */
  trillionFrameSeconds: {
    /** Count weighting: every particle in view adds exactly one unit (the proof shots). */
    exact: [160, 193],
    /** Flux weighting: far particles get a randomly rounded weight, often zero (the record stills). */
    averaged: [26, 52],
  },
} as const;

/** 1048576 -> "1.05M". Three significant digits with K, M, B or T, for lines that must stay short. */
export const shortCount = (n: number): string => formatCount(n);

/** 1000000000000 -> "1,000,000,000,000". For the places where the exact number is the point. */
export const exactCount = (n: number): string => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "-");

/** plural(1, "sheet") -> "1 sheet", plural(32, "sheet") -> "32 sheets". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${exactCount(n)} ${n === 1 ? one : many}`;

/**
 * Particles for every pixel of the picture, as text: "0.96", "3.9", "386".
 * The project's point is to hold more particles than the screen has pixels, so this is worth showing.
 */
export function perPixel(particles: number, pixels: number): string {
  if (!(pixels > 0) || !Number.isFinite(particles)) return "-";
  const r = particles / pixels;
  return r >= 100 ? exactCount(r) : r >= 10 ? r.toFixed(1) : r.toFixed(2);
}

/**
 * How long a caption of this many characters should stay up so it can be read,
 * in milliseconds: about 17 characters a second plus a second to notice it,
 * never less than 4 s or more than 10 s.
 */
export const readingMs = (characters: number): number =>
  Math.min(10_000, Math.max(4_000, 1_000 + (Math.max(0, characters) / 17) * 1_000));
