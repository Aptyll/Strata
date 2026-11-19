// Distinctness of stateless particles.
//
// Claim: with unique sheet seeds and at most 2^32 particles per sheet, no two
// particles in the world share a key, so no particle is a copy of another.
// Proof: particleKey is a Feistel network on the 64-bit word (seed, index),
// and keyIdentity is its inverse. These tests check that the inverse really
// inverts the shader's function, then count duplicates directly on a large
// slice, and show the twins the old 32-bit scheme had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draw, keyIdentity, legacyKey32, particleKey, pcg, pcgInverse, u01 } from '../rng';

// Deterministic test randomness (xorshift32), independent of the code under test.
let state = 0x12345678;
const rnd = () => {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state;
};

test('pcgInverse inverts pcg', () => {
  const edge = [0, 1, 2, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
  for (const v of edge) assert.equal(pcgInverse(pcg(v)), v);
  for (let i = 0; i < 1_000_000; i++) {
    const v = rnd();
    if (pcgInverse(pcg(v)) !== v) assert.fail(`pcgInverse(pcg(${v})) != ${v}`);
  }
});

test('particleKey is invertible: keyIdentity recovers (seed, index)', () => {
  const edge = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff];
  for (const s of edge) for (const i of edge) assert.deepEqual(keyIdentity(particleKey(i, s)), { index: i, seed: s });
  for (let n = 0; n < 1_000_000; n++) {
    const i = rnd();
    const s = rnd();
    const id = keyIdentity(particleKey(i, s));
    if (id.index !== i || id.seed !== s) assert.fail(`round trip failed for index ${i} seed ${s}`);
  }
});

test('no duplicate keys among 16.7M particles across 4 sheets', () => {
  const perSheet = 1 << 22;
  const seeds = [0, 1, 0x9e3779b9, 0xdeadbeef];
  const n = perSheet * seeds.length;
  const keys = new BigUint64Array(n);
  const words = new Uint32Array(keys.buffer); // little-endian: [lo, hi] per key
  let m = 0;
  for (const seed of seeds) {
    for (let i = 0; i < perSheet; i++, m++) {
      const k = particleKey(i, seed);
      words[2 * m] = k[0];
      words[2 * m + 1] = k[1];
    }
  }
  keys.sort();
  let duplicates = 0;
  for (let j = 1; j < n; j++) if (keys[j] === keys[j - 1]) duplicates++;
  assert.equal(duplicates, 0);
});

test('draws 0 and 1 carry all 64 bits; higher draws differ per k', () => {
  for (let n = 0; n < 100_000; n++) {
    const k = particleKey(rnd(), rnd());
    const d = [0, 1, 2, 3, 4, 5, 6, 7].map((j) => draw(k, j));
    // The first two draws are the key itself, so they are as unique as the key.
    if (d[0] !== k[0] || d[1] !== k[1]) assert.fail('draws 0 and 1 must be the key words');
    for (const x of d) if (!(u01(x) >= 0 && u01(x) < 1)) assert.fail('u01 out of range');
  }
  // Higher draws behave like independent uniforms: mean 0.5, low cross-correlation.
  const N = 200_000;
  const sums = new Float64Array(8);
  let cross = 0;
  for (let n = 0; n < N; n++) {
    const k = particleKey(n, 7);
    for (let j = 0; j < 8; j++) sums[j] += u01(draw(k, j));
    cross += (u01(draw(k, 0)) - 0.5) * (u01(draw(k, 6)) - 0.5);
  }
  for (let j = 0; j < 8; j++) assert.ok(Math.abs(sums[j] / N - 0.5) < 0.005, `draw ${j} mean ${sums[j] / N}`);
  assert.ok(Math.abs(cross / N) < 0.002, `draw 0 and draw 6 correlate: ${cross / N}`);
});

test('the old 32-bit scheme had an exact twin on every other sheet; the 64-bit key has none', () => {
  const sA = 0x0badf00d;
  const sB = 0x5eed1234;
  let twins = 0;
  const samples = 100_000;
  for (let n = 0; n < samples; n++) {
    const i = rnd();
    // Old: key = pcg(pcg(i) + seed). Sheet B's index j with the same key:
    const j = pcgInverse((pcg(i) + sA - sB) >>> 0);
    if (legacyKey32(j, sB) === legacyKey32(i, sA)) twins++;
    // New: the key decodes to exactly one identity, and that identity is on sheet A.
    const id = keyIdentity(particleKey(i, sA));
    if (id.seed !== sA || id.index !== i) assert.fail('64-bit key decoded to another identity');
  }
  // Every sampled particle of A had a twin index on B under the old scheme
  // (present whenever B holds that index, i.e. for nearly all of a 4-billion sheet).
  assert.equal(twins, samples);
});
