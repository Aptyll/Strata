/**
 * CPU twins of small WGSL building blocks, for writing reference
 * implementations. Each WGSL snippet here has a TypeScript function that
 * returns bit-identical results (checked in cases/reference.verify.ts).
 */

/** PCG hash (Jarzynski and Olano, "Hash Functions for GPU Rendering"). */
export const PCG_WGSL = /* wgsl */ `
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
`;

export function pcg(v: number): number {
  const state = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/**
 * u32 to a float in [0, 1) using the top 24 bits, so the result is exact and
 * can never round up to 1.0.
 */
export const UNIT_FLOAT_WGSL = /* wgsl */ `
fn unitFloat(h: u32) -> f32 {
  return f32(h >> 8u) * (1.0 / 16777216.0);
}
`;

export function unitFloat(h: number): number {
  return (h >>> 8) / 16777216;
}

/** Small seeded generator for test data (mulberry32). Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
