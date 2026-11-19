/** Seeded randomness. Every random choice in the soundtrack comes from here, so a seed fixes the sound. */

export type Random = () => number;

/** mulberry32: small, fast, good enough for musical choices. Returns floats in [0, 1). */
export function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mixes numbers into one unsigned 32-bit seed. Fractions count too, so a
 * PlaneDesc seed in [0, 1) works as well as an integer.
 */
export function hashSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const n = Number.isInteger(p) ? p : Math.floor(p * 4294967296);
    h = Math.imul(h ^ (n >>> 0), 0x01000193);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}
