// Deterministic hashing and random numbers for world generation.
// Everything in src/world derives from these, so the same seed always
// produces the same world on every machine.

import type { Quat, Vec3 } from '../core/contracts';

/** Mix any number of integers into one uint32. Order matters. */
export function hash32(...values: number[]): number {
  let h = 0x9e3779b9;
  for (let i = 0; i < values.length; i++) {
    let k = values[i] | 0;
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= values.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Turn a number or string seed into a uint32. */
export function seedFrom(seed: number | string): number {
  if (typeof seed === 'number') return hash32(seed, (seed / 0x100000000) | 0);
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return hash32(h);
}

/** Small seeded generator (mulberry32) with the helpers the world code needs. */
export class Rng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform uint32. */
  u32(): number {
    return (this.float() * 4294967296) >>> 0;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** Uniform integer in [min, max], both inclusive. */
  intRange(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)];
  }

  /** Index chosen in proportion to the given non-negative weights. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.float() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /** Standard normal sample. */
  gauss(): number {
    const u = 1 - this.float();
    const v = this.float();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Uniform point on the unit sphere. */
  unitVector(): Vec3 {
    const z = this.range(-1, 1);
    const a = this.range(0, 2 * Math.PI);
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), r * Math.sin(a), z];
  }

  /** Uniform random rotation as a quaternion [x, y, z, w]. */
  quat(): Quat {
    const u1 = this.float();
    const u2 = this.range(0, 2 * Math.PI);
    const u3 = this.range(0, 2 * Math.PI);
    const a = Math.sqrt(1 - u1);
    const b = Math.sqrt(u1);
    return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
  }

  /** Independent child generator. Does not advance this one. */
  fork(label: number): Rng {
    return new Rng(hash32(this.state, label));
  }
}
