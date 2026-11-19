# Stateless particles

Motion laws and randomness for particles that store nothing: a particle's
position is `f(key, t, params)`, evaluated from scratch every frame. This is
what lets the offline renderer (`src/offline`) draw a trillion particles.

## Particle keys: 64 bits, one per particle

`rng.ts` defines the identity of a stateless particle. Everything random about
a particle comes from its key, so the key is the particle.

```
identity = (seed, index)          seed unique per sheet, index 0..count-1
key      = Feistel3(seed, index)  vec2u, 64 bits, fully mixed
```

A Feistel network is invertible whatever its round function, so two particles
share a key only if they share both seed and index. With unique sheet seeds
and at most 2^32 particles per sheet, every particle in the world has its own
key. The old 32-bit key, `pcg(pcg(index) + seed)`, could not promise that: two
sheets drew from the same 2^32 keys, so a 4-billion-particle sheet was a
reshuffle of every other one.

| WGSL | meaning |
| --- | --- |
| `alias Key = vec2u` | a particle key |
| `particleKey(index, seed) -> Key` | the bijection above, about 27 integer ops |
| `draw(key, k) -> u32` | k-th random word. `k = 0, 1` are the key words (free, and together all 64 bits). `k >= 2` mix both words, one `pcg` each |
| `u01(h) -> f32` | uniform in [0, 1) from the top 24 bits, never 1 |
| `tri(h) -> f32` | triangular on (-1, 1) |
| `pcg(v) -> u32` | 32-bit bijective hash |
| `TAU` | 2 pi |

Draw numbers: laws use `k = 0..5`; the offline runner owns `6` (shutter
instant) and `7` (stochastic weight rounding).

`STATELESS_RNG_WGSL` is the prelude to paste in front of any shader that
evaluates laws. The TypeScript exports mirror it bit for bit, and
`keyIdentity(key)` is the inverse of `particleKey`.

## Checks

```sh
node src/stateless/test/run.mjs
```

Runs in about two seconds. It checks that `keyIdentity` inverts `particleKey`
on a million random identities and on edge values, counts duplicates directly
among 16.7 million keys from four sheets (zero), and shows that the old 32-bit
scheme gave every particle an exact twin on another sheet while the new key
decodes to exactly one identity.
