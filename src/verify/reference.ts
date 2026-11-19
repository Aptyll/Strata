/**
 * CPU twins of small WGSL building blocks, for writing reference
 * implementations. Each WGSL snippet here has a TypeScript function that
 * returns bit-identical results (checked in cases/reference.verify.ts).
 *
 * PCG_WGSL and U01_WGSL are the repo's shared blocks from src/gpu/wgsl.ts,
 * re-exported here so the verify cases test the exact text every shader uses.
 */

import { PCG_WGSL, U01_WGSL } from "../gpu/wgsl";

export { PCG_WGSL, U01_WGSL };
/** Small seeded generator for test data (mulberry32), floats in [0, 1). The app's own, from src/math.ts. */
export { seededRandom } from "../math";

/** CPU twin of `pcg` in PCG_WGSL (Jarzynski and Olano, "Hash Functions for GPU Rendering"). */
export function pcg(v: number): number {
  const state = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/**
 * CPU twin of `u01` in U01_WGSL: u32 to a float in [0, 1) using the top 24
 * bits, so the result is exact and can never round up to 1.0.
 */
export function u01(h: number): number {
  return (h >>> 8) / 16777216;
}

/** Sheet wrap used by the reference integrator: maps any coordinate into [-1, 1). */
export const WRAP_WGSL = /* wgsl */ `
fn wrapSheet(p: vec2f) -> vec2f {
  return p - 2.0 * floor((p + 1.0) * 0.5);
}
`;

const f = Math.fround;

export function wrapSheet(p: number): number {
  return f(p - f(2 * Math.floor(f(f(p + 1) * 0.5))));
}

/** Distance between two sheet coordinates, treating -1 and 1 as the same point. */
export function wrappedDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 2;
  return Math.min(d, 2 - d);
}
