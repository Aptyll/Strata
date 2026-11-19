# Stateless particles

Motion laws and randomness for particles that store nothing: a particle's
position is `f(key, t, params)`, evaluated from scratch every frame. This is
what lets the offline renderer (`src/offline`) draw a trillion particles.

## Particle keys: 64 bits, one per particle

`rng.ts` defines the identity of a stateless particle. Everything random about
a particle comes from its key, so the key is the particle.

```
identity = (seed, index)                    seed unique per sheet, index 0..count-1
key      = Feistel3(pcg(seed ^ c), index)   vec2u, 64 bits, fully mixed
```

A Feistel network is invertible whatever its round function, and `pcg` is a
bijection, so two particles share a key only if they share both seed and
index. With unique sheet seeds and at most 2^32 particles per sheet, every
particle in the world has its own key. The old 32-bit key,
`pcg(pcg(index) + seed)`, could not promise that: two sheets drew from the
same 2^32 keys, so a 4-billion-particle sheet was a reshuffle of every other
one. Hashing the seed first gives every seed bit two `pcg` rounds before it
reaches `key.x`; with one, `key.x` inherited `pcg`'s own weak bits.

| WGSL | meaning |
| --- | --- |
| `alias Key = vec2u` | a particle key |
| `particleKey(index, seed) -> Key` | the bijection above: four `pcg` calls, about 40 integer ops, and the seed's one can be hoisted out of a loop over one sheet |
| `draw(key, k) -> u32` | k-th random word. `k = 0, 1` are the key words (free, and together all 64 bits). `k >= 2` mix both words, one `pcg` each |
| `u01(h) -> f32` | uniform in [0, 1) from the top 24 bits, never 1 |
| `tri(h) -> f32` | triangular on (-1, 1), variance 1/6: `u01`-style 24-bit uniforms from `h` and `pcg(h)`, subtracted. Exact in f32, 2^25 - 1 values |
| `pcg(v) -> u32` | 32-bit bijective hash |
| `TAU` | 2 pi |

Draw numbers: laws use `k = 0..5`; the offline runner owns `6` (shutter
instant) and `7` (stochastic weight rounding).

`STATELESS_RNG_WGSL` is the prelude to paste in front of any shader that
evaluates laws. The TypeScript exports mirror it bit for bit, and
`keyIdentity(key)` is the inverse of `particleKey`.

## Motion laws

`laws/` holds the motion: where a particle is at time `t`, in closed form.
At a trillion particles nobody sees a single particle, only the density, so
these laws are built to make density structure: they fold a smooth map over
itself, and brightness piles up along the folds (caustics) as they move.
Smooth incompressible flows such as curl noise keep a uniform sheet uniform,
which is invisible at that scale, so there are none here.

| law | what you see | transcendental | FMA | stretch | coherent |
| --- | --- | --- | --- | --- | --- |
| `veil` | a rippling sheet seen at an angle; bright fold lines run along it like an aurora curtain | 4 | 32 | 3 | yes |
| `galaxy` | a grand-design spiral; the arms are a density wave the stars stream through, with a bulge and star clusters | 6 | 38 | 0.8 | no |
| `web` | the cosmic web (Zel'dovich approximation): walls and knots around emptying voids, two nested scales, tiles the sheet | 8 | 44 | 4 | yes |
| `ribbons` | a square folded two to four times by a Clifford map: silk ribbons with razor caustic edges | 10 | 22 | 40 | no |

Costs are per particle, counted by hand from the WGSL (transcendental also
counts division and float rounding, which run at a quarter of the FMA rate on
NVIDIA). They are not measurements: nothing here has been timed on a real
GPU yet. All four are over the budget in the 1T speed proposal (about 3
transcendentals and 25 FMA); `veil` is the closest.

### Interface

Each law is written against continuous coordinates `q` in [0, 1)^3, and gets
a key-form wrapper:

```
fn lawVeilQ(q: vec3f, t: f32, p: array<f32, 8>) -> vec2f   // the law
fn lawVeil(key: Key, t: f32, p: array<f32, 8>) -> vec2f    // lawVeilQ(qFromKey(key), t, p)
```

Both return a position on the sheet, inside [-1, 1]^2. `qFromKey(key)` is
`(u01(key.x), u01(key.y), u01(draw(key, 2)))`, so a law uses draws 0 to 2.
Every law is continuous in `q.x` and `q.y`, takes discrete choices (a
population, a sector) from `q.z` only, and walks along `q.x` with the least
stretch. `stretch` bounds |d position / d q.x| in sheet units: how far a run
of neighbouring `q.x` spreads on screen. A law is `coherent` when it never
reads `q.z`, so particles that are neighbours in (`q.x`, `q.y`) land near
each other whatever their `q.z`.

In TypeScript, `STATELESS_LAWS` lists them and `lawById(id)` finds one. Each
is `{ id, title, summary, fn, qFn, wgsl, params, defaults, ranges, cost,
coherent, mirror }`: eight params with ranges and a one-line note each, and a
double-precision `mirror(q, t, p)` that follows the WGSL line for line.
`lawModuleWgsl(laws)` is `STATELESS_RNG_WGSL` plus the laws' WGSL, a complete
module apart from your entry point.

### Using them

- **Offline renderer** (`src/offline`): same prelude and the same key-form
  signature as its own laws. Append `law.wgsl` to the shader and call
  `law.fn(key, t, p)`.
- **Trillion kernel** (`src/trillion`): a law already has `{ id, fn, wgsl }`,
  so it is a `TrillionLaw` for the plain path as it stands. For the strata
  path, `strataVariant(law)` feeds the kernel's stratified `strat(key)` in as
  `q.x` and `q.y` (and `u01(draw(key, 2))` as `q.z`), and passes `coherent`
  through. Use it for `veil` and `web`; `galaxy` and `ribbons` read `q.z`, so
  a strata walk scatters and they gain little there.
- **Demo**: `/src/stateless/demo/` (also in the production build). One law
  on one sheet, face-on, with sliders for every param. Keys: 1 to 4 switch
  law, S rolls a new seed, H hides the panel, space pauses. URL options:
  `law`, `n`, `grid`, `speed`, `shutter`, `seed`, `white`, `t`, `p` (eight
  comma-separated params). The count on screen is a GPU tally of particles
  evaluated and landed this frame.

### Writing a new law

- Eight params, continuous in `q.x` and `q.y`, discrete choices from `q.z`
  only. Put the coordinate that stretches least on `q.x`.
- Anything that defines a particle's path comes from a 24-bit coordinate
  (`q`, or `u01` of a draw), never from `tri` or a few-bit band index, or
  particles share trajectories.
- Keep angles and phases small (wrap seeds and slots into [0, 2 pi) before
  adding per-particle spreads), or f32 rounds the spread away. Hash integer
  slots in u32 (`u01(slot * 0x91e10da5u)`) rather than `fract(slot * c)`.
- Write the mirror in f64, but take discrete choices through `Math.fround`
  so the mirror picks the same band on a boundary as the GPU does.
- Add it to `STATELESS_LAWS`, mark it `coherent` only if it never reads `q.z`,
  and run both checks below.

## Checks

```sh
node src/stateless/test/run.mjs     # keys and laws, through the mirrors
npm run verify -- stateless         # the laws' WGSL on a GPU
```

The first runs in about two seconds. It checks that `keyIdentity` inverts
`particleKey` on a million random identities and on edge values, counts
duplicates directly among 16.7 million keys from four sheets (zero), and shows
that the old 32-bit scheme gave every particle an exact twin on another sheet
while the new key decodes to exactly one identity. For every law it checks
that positions stay on the sheet for the defaults and 39 random param sets,
move less than 1% of the sheet in a quarter frame, and differ for 200,000
distinct keys.

The second compiles every law, runs it on the GPU (headless SwiftShader by
default) for the defaults and two random param sets, and compares 49,152
positions per law with the mirror: about 1e-4 apart (3e-3 for `ribbons`,
whose folds stretch rounding). It also compiles every law, plain and as a
strata variant, inside the trillion kernel's splat shader.
