/**
 * The words Strata uses with viewers, and how it writes counts. One place, so
 * the stats line, the sheet label, the about card and the Esc menu all say the
 * same thing. Design notes and the full rules: docs/ux/information.md.
 *
 * The one rule that must never slip (CLAUDE.md, "Honest counting"): a count
 * always carries the word that says what was done to those particles.
 *
 *   simulated   stored state, stepped every frame      the live world, challenge mode
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
    means: "One white dot. Where particles overlap their light adds up, so brighter means denser.",
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
    means: "Particles held in GPU memory. Sheets outside the view rest, so fewer may be simulated than stored.",
  },
  rendered: {
    word: "rendered",
    means:
      "Nothing is stored. Each particle's position is computed from its number and the time, added to the picture and forgotten.",
  },
} as const satisfies Record<string, Term>;

/**
 * Measured results the app is allowed to quote, with the hardware they were
 * measured on. Source: README.md and docs/perf.md. When a new number is
 * measured on the real GPU, change it here and the about card follows.
 */
export const MEASURED = {
  gpu: "RTX 2070",
  /** Particles in one offline 4K frame. */
  trillion: 1_000_000_000_000,
  /** Seconds per 4K trillion frame, fastest and slowest framing. */
  trillionFrameSeconds: [26, 52],
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
