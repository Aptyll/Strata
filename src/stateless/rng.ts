/**
 * Particle identity and randomness for stateless particles.
 *
 * A stateless particle stores nothing. Everything random about it (where it
 * starts, which orbit it takes, its phase) is drawn from its key, so the key
 * IS the particle. With a 32-bit key a sheet can hold at most 2^32 different
 * particles, and two sheets that draw keys from the same 32-bit space hold
 * permutations of the same set. At a trillion particles that would mean the
 * same ~4.3 billion particles shown about 233 times over.
 *
 * Here the key is 64 bits, and it is a bijection of the particle's identity:
 *
 *   identity = (seed, index)                   seed: unique per sheet, index: 0..count-1
 *   key      = Feistel3(pcg(seed ^ c), index)  two u32 words, fully mixed
 *
 * A Feistel network is invertible whatever its round function, and pcg is a
 * bijection, so two particles get the same key only if they have the same seed
 * and the same index. With unique sheet seeds, every particle in the world has
 * its own key. `keyIdentity` below is the inverse and the check script uses it.
 *
 * The seed is hashed once before the network. Without that, a seed bit reached
 * key.x through a single pcg and inherited pcg's own weak spots (flipping input
 * bit 21 flips output bits 10 to 14 with probability 0.42, not 0.5). The extra
 * pcg depends only on the seed, so a loop over one sheet can hoist it.
 * docs/proof/distinctness.md has the measurements.
 *
 * The first two draws of a particle are the two key words themselves, so the
 * 64 bits that make it unique feed straight into the law. Further draws mix
 * both words.
 *
 * Draw numbers: laws use k = 0..5. The offline runner owns k = 6 (shutter
 * instant) and k = 7 (stochastic weight rounding).
 *
 * The TypeScript functions mirror the WGSL bit for bit (all integer math).
 */

/**
 * WGSL prelude for laws and for any shader that evaluates them. Defines
 * `TAU`, `Key`, `pcg`, `u01`, `tri`, `particleKey` and `draw`.
 */
export const STATELESS_RNG_WGSL = /* wgsl */ `
const TAU = 6.283185307179586;

// A particle's 64-bit key, as two u32 words.
alias Key = vec2u;

// PCG output permutation used as a u32 -> u32 hash. Bijective.
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

// Uniform float in [0, 1) from the top 24 bits. Exact in f32, never 1.
fn u01(h: u32) -> f32 {
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

// Triangular distribution on (-1, 1), variance 1/6: the difference of two
// 24-bit uniforms, one from h and one from pcg(h). Exact in f32. It takes
// 2^25 - 1 values, so two particles draw the same one with probability 4e-8
// (summing the two 16-bit halves of h gave 131,071 values and 1e-5).
fn tri(h: u32) -> f32 {
  return (f32(h >> 8u) - f32(pcg(h) >> 8u)) * (1.0 / 16777216.0);
}

// The particle's key: a 3-round Feistel network on the 64-bit word
// (pcg(seed ^ c), index). Invertible, so distinct (seed, index) give distinct
// keys. Hashing the seed first sends every seed bit through two pcg rounds
// before it reaches key.x; it depends only on the seed, so a loop over one
// sheet can hoist it.
fn particleKey(index: u32, seed: u32) -> Key {
  var l = pcg(seed ^ 0x1f83d9abu);
  var r = index;
  l ^= pcg(r ^ 0x3c6ef372u);
  r ^= pcg(l ^ 0xa54ff53au);
  l ^= pcg(r ^ 0x510e527fu);
  return Key(r, l);
}

// The k-th random 32-bit draw of a particle. k = 0 and k = 1 are the key words
// (free, and together a bijection of the identity). k >= 2 mixes both words.
fn draw(key: Key, k: u32) -> u32 {
  if (k == 0u) { return key.x; }
  if (k == 1u) { return key.y; }
  return pcg(key.x ^ (key.y * (2u * k + 1u)) ^ (k * 0x9e3779b9u));
}
`;

/** A particle key: two u32 words, [x, y] as in the WGSL `Key`. */
export type Key = readonly [number, number];

export const TAU = 6.283185307179586;

export function pcg(v: number): number {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** Multiplicative inverse of an odd number modulo 2^32 (Newton iteration). */
function inverseOdd(a: number): number {
  let x = a >>> 0;
  for (let i = 0; i < 5; i++) x = Math.imul(x, (2 - Math.imul(a, x)) >>> 0) >>> 0;
  return x >>> 0;
}
const INV_A = inverseOdd(747796405);
const INV_C = inverseOdd(277803737);

/** Inverse of `pcg`: pcgInverse(pcg(v)) === v for every u32. */
export function pcgInverse(h: number): number {
  const w = (h ^ (h >>> 22)) >>> 0;
  const x = Math.imul(w, INV_C) >>> 0;
  // x = s ^ (s >> sh) with sh = (s >> 28) + 4; the top 4 bits pass through.
  const sh = (x >>> 28) + 4;
  let s = x;
  for (let k = sh; k < 32; k += sh) s = (x ^ (s >>> sh)) >>> 0;
  return Math.imul((s - 2891336453) >>> 0, INV_A) >>> 0;
}

export const u01 = (h: number): number => (h >>> 8) / 16777216;
export const tri = (h: number): number => ((h >>> 8) - (pcg(h) >>> 8)) / 16777216;

/** Seed pre-hash constant: fractional bits of sqrt(17), like the round constants (sqrt 5, 7, 11; SHA-256's IV). */
const SEED_SALT = 0x1f83d9ab;

export function particleKey(index: number, seed: number): Key {
  let l = pcg((seed ^ SEED_SALT) >>> 0);
  let r = index >>> 0;
  l = (l ^ pcg((r ^ 0x3c6ef372) >>> 0)) >>> 0;
  r = (r ^ pcg((l ^ 0xa54ff53a) >>> 0)) >>> 0;
  l = (l ^ pcg((r ^ 0x510e527f) >>> 0)) >>> 0;
  return [r, l];
}

/** Inverse of `particleKey`: recovers the (seed, index) a key came from. */
export function keyIdentity(key: Key): { index: number; seed: number } {
  let r = key[0] >>> 0;
  let l = key[1] >>> 0;
  l = (l ^ pcg((r ^ 0x510e527f) >>> 0)) >>> 0;
  r = (r ^ pcg((l ^ 0xa54ff53a) >>> 0)) >>> 0;
  l = (l ^ pcg((r ^ 0x3c6ef372) >>> 0)) >>> 0;
  return { index: r, seed: (pcgInverse(l) ^ SEED_SALT) >>> 0 };
}

export function draw(key: Key, k: number): number {
  if (k === 0) return key[0] >>> 0;
  if (k === 1) return key[1] >>> 0;
  return pcg((key[0] ^ Math.imul(key[1], 2 * k + 1) ^ Math.imul(k, 0x9e3779b9)) >>> 0);
}

/**
 * The 32-bit key scheme this replaces, kept for the comparison in the check
 * script: key = pcg(pcg(index) + seed).
 */
export const legacyKey32 = (index: number, seed: number): number => pcg((pcg(index) + seed) >>> 0);
