# Brief: 64-bit particle identity

Owner (2026-11-19): the stateless motion thread (`src/stateless/rng.ts`, a
Feistel key as `vec2u`), adopted by the offline renderer (`src/offline`).
This brief states the rule and the test so every stateless path agrees.

## Context

A stateless particle is nothing but its id. Everything about it (start,
orbit, phase, shutter instant) comes from hashing that id. WGSL has no 64-bit
integers, and a u32 holds 4,294,967,296 values.

## Research conclusion

**The number of distinct particles in one distribution can never exceed the
number of distinct keys.** If the key that feeds every random draw is 32 bits,
then any one distribution (one sheet, one law and transform) holds at most
4.29B distinct particles. Put 10^12 through it and you get each particle about
233 times at exactly the same place and time: an image of 4.29B particles
drawn 233 times brighter. Its grain is that of 4.29B particles (about 15 times,
sqrt(233), grainier than a true trillion), and the claim is false.

Chaining does not help: `h1 = pcg(h0)`, `h2 = pcg(h1)` are all functions of
the 32-bit `h0`. Mixing a batch number into a 32-bit hash does not help either:
233 batches of 2^32 ids through a bijective 32-bit hash produce every key
exactly 233 times.

State on main (PR #41): the offline renderer is **safe by construction** but
only by convention. `particleKey(i, seed) = pcg(pcg(i) + seed)` is a bijection
of a u32 index within one plane, `validateJob` caps a plane at 2^32 - 1
particles, and the `trillion` preset spreads 10^12 over 1024 planes of
976,562,500 each. Anything that puts more than 2^32 particles into one
distribution breaks it: a single hero sheet holding the trillion, a collapse
shot done as one distribution, a stateless engine kind with u32 ids.

Smaller pitfalls, same family:

- `f32(index)` is exact only to 16,777,216 (`docs/gpu-scale.md` rule 5).
- A u32 loop counter over all particles wraps at 4.29B.
- `u01(h)` keeps 24 bits. Fine for a coordinate, never for identity.
- `draw(key, k) = pcg(key + k * 0x9e3779b9)`: the draws of a particle whose key
  is `key + 0x9e3779b9` are the same numbers shifted by one slot. Probably
  invisible, but the test below should look at it.

## Steps

1. One key function for every stateless path: a 64-bit index
   (`vec2u(lo, hi)`) plus seed into a bijective 64-bit mix (the Feistel
   network in `src/stateless/rng.ts`). Every draw mixes both words of the key.
   No draw is derived from a single 32-bit intermediate.
2. A TypeScript mirror of the same function (BigInt or two `Math.imul` lanes).
3. A test (`node`, no GPU) that:
   - takes 10^6 indices `i` and also `i + 2^32`, `i + 5 * 2^32`, `i + 232 * 2^32`,
     and asserts their keys and their first two draws differ (a 32-bit collapse
     fails this instantly);
   - draws 10^7 random 64-bit indices and asserts zero collisions in the first
     64 bits of output (expected collisions about n^2 / 2^65, about 3 x 10^-6);
   - prints the correlation between draw k of one particle and draw k+1 of the
     particle whose key is one stream step away, to settle the last pitfall.
4. Adopt it in `src/offline/core/laws.ts` (`particleKey`, `draw`) and in the
   stateless engine kind. Then `validateJob` may allow more than 2^32 per
   plane, and the CPU reference in `src/offline/node/test.mjs` must still agree.
5. Add the rule to `docs/gpu-scale.md` under Precision: "identity bits per
   distribution must be at least log2 of its particle count".

## Files to touch

- `src/stateless/rng.ts` (owner), its test file next to it
- `src/offline/core/laws.ts`, `src/offline/core/job.ts` (with the offline thread)
- `docs/gpu-scale.md` (one rule)

## Done when

- The test above passes with `node`, and fails when the key is forced to 32 bits.
- The offline renderer and the stateless engine kind call the same key function.
- A one-plane job with more than 2^32 particles validates and renders, and with
  the whole sheet in view its count-mode grid sum equals its particle count
  times `ONE`.
