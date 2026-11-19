# Brief: 64-bit particle identity

Owner (2026-11-19): the stateless motion thread (`src/stateless/rng.ts`),
adopted by the offline renderer (`src/offline`). The "Prove the trillion
particles are distinct" thread checks hash quality. This brief states the rule
and what is still open, so every stateless path agrees.

## Context

A stateless particle is nothing but its identity. Everything about it (start,
orbit, phase, shutter instant) comes from hashing that identity into a key.
WGSL has no 64-bit integers, and a u32 holds 4,294,967,296 values.

## Research conclusion

**A distribution can never hold more distinct particles than it has distinct
keys.** If the key that feeds every random draw is 32 bits, any one
distribution (one sheet, one law and transform) holds at most 4.29B distinct
particles. Put 10^12 through it and each particle appears about 233 times at
exactly the same place and time: an image of 4.29B particles drawn 233 times
brighter. Its grain is that of 4.29B particles (sqrt(233), about 15 times
grainier than a true trillion), and the claim is false.

Chaining does not help: `h1 = pcg(h0)`, `h2 = pcg(h1)` are all functions of
the 32-bit `h0`. Mixing a batch number into a 32-bit hash does not help either:
233 batches of 2^32 ids through a bijective 32-bit hash produce every key
exactly 233 times. And with 32-bit keys, different sheets draw from the same
2^32 keys, so they are reshuffles of each other rather than independent.

## State on main (2026-11-19, after PR #51)

Done:

- PR #45 added `src/stateless/rng.ts`: `particleKey(index, seed)` is a
  three-round Feistel network giving a `vec2u` (64-bit) key; a Feistel network
  is invertible, so two particles share a key only if they share seed and
  index. `node src/stateless/test/run.mjs` checks the inverse and counts
  duplicates among 16.7M keys from four sheets (zero).
- PR #47 switched `src/offline` (and through it `src/record` and `src/proof`)
  to those keys. The `trillion` preset is 1024 sheets of 976,562,500.

Open:

1. **`src/trillion` (PR #50) still uses 32-bit keys.** Its laws are
   `fn <fn>(key: u32, ...)`, and `TrillionPlane.count` says "at most 2^32
   (keys are 32 bit, more would repeat positions)".
2. **The per-sheet index is still a u32** (`validateJob` caps a sheet at
   2^32 - 1). Fine for 1024 sheets; a single sheet holding the trillion (for
   example a one-sheet deep zoom) needs a 64-bit index into `particleKey`.
3. **Other stateless hashes**: the procedural mode of `src/challenge` and the
   pattern shader in `src/render/demo` have their own hashes. Not record
   paths, but they must not be quoted as trillion counts.
4. The engine's stateless particle kind (in progress in another thread) must
   use the shared key from the start.

Smaller pitfalls, same family: `f32(index)` is exact only to 16,777,216
(`docs/gpu-scale.md` rule 5); a u32 loop counter over all particles wraps at
4.29B; `u01(h)` keeps 24 bits, fine for a coordinate, never for identity.

## Steps

1. Port `src/trillion` laws to `Key` and `particleKey` from
   `src/stateless/rng.ts` (prepend `STATELESS_RNG_WGSL`), and drop its own
   hash. Coordinate with the thread that owns `src/trillion`.
2. Add one line to `docs/gpu-scale.md` under Precision: "Identity bits per
   distribution must be at least log2 of its particle count. Use
   `particleKey` from `src/stateless/rng.ts`; do not write a new particle hash."
3. Only if a one-sheet trillion shot is wanted: take the index as
   `vec2u(lo, hi)` in `particleKey`, lift the 2^32 - 1 cap in
   `src/offline/core/job.ts`, and extend `src/stateless/test` with indices
   `i`, `i + 2^32`, `i + 232 * 2^32` that must give different keys.

## Files to touch

- `src/trillion/*` (with its owner), `docs/gpu-scale.md`
- only for step 3: `src/stateless/rng.ts`, `src/stateless/test/*`,
  `src/offline/core/job.ts`, `src/offline/core/shaders.ts`

## Done when

- No stateless kernel on main defines its own particle hash; `grep -rn "key: u32" src/trillion` is empty.
- `node src/stateless/test/run.mjs` passes.
- If step 3 was done: a one-sheet job with more than 2^32 particles validates,
  and with the whole sheet in view its count-mode grid sum equals its particle
  count times `ONE`.
