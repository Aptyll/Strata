/**
 * Color species rules for color life.
 *
 * Every particle belongs to one color species. How strongly species A is
 * pulled toward (or pushed from) species B is entry [A][B] of a rule matrix,
 * in [-1, 1]. The matrix need not be symmetric, so A can chase B while B
 * flees A: that asymmetry is where the moving, hunting, membrane-like
 * structures come from. Color is not decoration here: a particle's color is
 * its rule row, so what you see is what decides how it moves.
 *
 * Pure CPU code, no GPU: a roll is a seed, and the same seed always gives the
 * same rules, so a look can be shared as `#r=<seed>`.
 */

import { seededRandom } from "../math";

/** The shader's matrix is 8 x 8; fewer species use its top left corner. */
export const MAX_SPECIES = 8;
export const MIN_SPECIES = 2;

/** How a roll fills the matrix. Each style leans toward a different family of structures. */
export type RuleStyle = "random" | "symmetric" | "chase" | "cells";
export const RULE_STYLES: readonly RuleStyle[] = ["random", "symmetric", "chase", "cells"];

export interface ColorRules {
  seed: number;
  style: RuleStyle;
  species: number;
  /** Row major, MAX_SPECIES x MAX_SPECIES: matrix[a * 8 + b] is how much a is drawn to b. */
  matrix: Float32Array;
  /** Linear RGB per species, MAX_SPECIES x 4 floats (alpha unused). */
  palette: Float32Array;
  /** Repulsion core as a fraction of the interaction radius (every pair repels inside it). */
  beta: number;
  /** Strength of the rule forces. */
  force: number;
  /** Seconds for a free particle to lose half its speed. */
  frictionHalfLife: number;
}

/** HSV (h in turns) to linear-ish RGB, good enough for additive light. */
function hsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

/**
 * Species colors: evenly spaced hues from a rolled starting hue, so any two
 * species are easy to tell apart and the palette changes with every roll.
 */
export function makePalette(species: number, random: () => number): Float32Array {
  const out = new Float32Array(MAX_SPECIES * 4);
  const start = random();
  for (let i = 0; i < species; i++) {
    const [r, g, b] = hsv((start + i / species) % 1, 0.72 + 0.2 * random(), 1);
    out.set([r, g, b, 1], i * 4);
  }
  return out;
}

/** Fills the top left species x species block of the matrix for one style. */
export function makeMatrix(style: RuleStyle, species: number, random: () => number): Float32Array {
  const m = new Float32Array(MAX_SPECIES * MAX_SPECIES);
  const u = () => random() * 2 - 1;
  for (let a = 0; a < species; a++) {
    for (let b = 0; b < species; b++) {
      let v: number;
      switch (style) {
        case "symmetric":
          // Mutual attraction or repulsion: settles into stable blobs and layered rings.
          v = b < a ? m[b * MAX_SPECIES + a] : u();
          break;
        case "chase": {
          // Each species hunts the next and flees the previous: rotating, travelling chains.
          const ahead = (b - a + species) % species;
          v = ahead === 1 ? 0.6 + 0.4 * random() : ahead === species - 1 ? -(0.4 + 0.5 * random()) : 0.5 * u();
          if (a === b) v = 0.2 + 0.6 * random();
          break;
        }
        case "cells":
          // Strong self attraction, mixed cross terms: cell-like bodies with membranes.
          v = a === b ? 0.5 + 0.5 * random() : 0.8 * u();
          break;
        default:
          v = u();
      }
      m[a * MAX_SPECIES + b] = v;
    }
  }
  return m;
}

export interface RollRulesOptions {
  /** Force a species count instead of rolling 3..7. */
  species?: number;
  /** Force a style instead of rolling one. */
  style?: RuleStyle;
}

/** The whole look from one seed. */
export function rollRules(seed: number, opts: RollRulesOptions = {}): ColorRules {
  const random = seededRandom(seed >>> 0);
  const style = opts.style ?? RULE_STYLES[Math.floor(random() * RULE_STYLES.length)];
  const species = clampSpecies(opts.species ?? 3 + Math.floor(random() * 5));
  return {
    seed: seed >>> 0,
    style,
    species,
    matrix: makeMatrix(style, species, random),
    palette: makePalette(species, random),
    beta: 0.25 + 0.1 * random(),
    force: 8 + 6 * random(),
    frictionHalfLife: 0.035 + 0.03 * random(),
  };
}

export function clampSpecies(n: number): number {
  return Math.max(MIN_SPECIES, Math.min(MAX_SPECIES, Math.round(n) || MIN_SPECIES));
}

/** A fresh seed for the dice. */
export function newSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
}

/**
 * The particle life force between two particles at distance `rn`, measured in
 * interaction radii (0..1), for rule value `a`. Inside `beta` every pair
 * repels (so particles never collapse to a point); between `beta` and 1 the
 * rule value sets a triangular bump of attraction (a > 0) or repulsion.
 * CPU twin of `force()` in the force shader, used by the verify case.
 */
export function pairForce(rn: number, a: number, beta: number): number {
  if (rn < beta) return rn / beta - 1;
  if (rn < 1) return a * (1 - Math.abs(2 * rn - 1 - beta) / (1 - beta));
  return 0;
}
