# Trillion splat kernel (`src/trillion`)

A GPU kernel that renders stateless particles: each particle's position is a
closed-form function of its 64-bit key and time, evaluated and counted every
frame, with nothing stored per particle. Built for 1,000,000,000,000 particles
per 4K frame on Noah's RTX 2070. This path is **rendered**, not simulated.

## Honest counting

- Every particle has a unique key, `particleKey(index, seed)` from
  `src/stateless/rng.ts`. Planes hold at most 2^32 particles and seeds must be
  unique, so a trillion needs at least 233 planes.
- Every landed particle adds exactly 1 to exactly one pixel counter. Runs,
  tiles and folds only group those adds. Integer adds commute, so a frame is
  bit-identical however it is batched.
- The tally comes from the GPU: `landed` (equals the sum of all counters) and
  `inView`, plus `evaluated` and `culled` from the CPU. Culling is off by
  default, so `evaluated == N` for the record.
- No subsampling, interpolation, or analytic density anywhere.

## Why the 2070 needs a different kernel

A 4K counter grid is 33 MB. The 2070's L2 is 4 MB, so atomics to random
pixels miss the cache and go to DRAM: about 3 to 7 billion adds per second,
3 to 5 minutes per trillion. The arithmetic of the laws allows roughly 25 to
50 billion particles per second. Accumulation is the bottleneck, not math.
(Estimates from `docs/briefs/throughput-math-2070.md`; src/offline measured
3.3 B/s worst case and 34.5 B/s on a real scene.)

The fix is to make a workgroup's particles land close together on screen, so
their hits can be added up in fast workgroup memory first:

1. **Stratified ids.** A plane is split into `gu x gv` patches of about 2^17
   particles, one workgroup each. Each thread walks one row of its patch.
   The particle's stratified coordinate `strat(key)` is its cell in this
   jittered grid, so neighbouring ids get neighbouring coordinates.
2. **Coherent laws.** A law that takes its two main coordinates from
   `strat(key)` (and declares `coherent: true`) maps a patch to a small patch
   of screen. `STRATIFIED_OFFLINE_LAWS` are kepler, vortex and lissajous from
   `src/offline` rewritten that way: same distribution of positions per plane.
3. **Run merge.** Consecutive particles of a row usually hit the same pixel,
   so each thread keeps (pixel, count) in registers and adds only when the
   pixel changes.
4. **Shared memory tile.** Each workgroup first evaluates the two u edges of
   its patch, places a tile of up to 8160 counters (32 KB) around them, adds
   runs there, and flushes the tile to global memory once. Hits outside the
   tile go straight to global memory, so a bad guess costs speed, never
   correctness. `tally.tiledPatches / tally.patches` shows how often it works.
5. **Exact folding.** Global counters are `u32` with fire-and-forget atomics
   (4 bytes a pixel, no return value to wait for). Before any could overflow
   (at most 2^32 - 1 particles since the last fold) they are folded into the
   exact 64-bit `counts`, CountToneMapper `words: 2` layout.

Non-coherent laws use the plain path: direct global atomics, or a per-plane
tile when the whole plane is small on screen.

## Use

```ts
import { TrillionKernel, renderFrame, planeHomography, trillionLimits, STRATIFIED_OFFLINE_LAWS } from './trillion';

const device = await adapter.requestDevice({ requiredLimits: trillionLimits(adapter) });
const kernel = await TrillionKernel.create(device, { width: 3840, height: 2160, laws: STRATIFIED_OFFLINE_LAWS });
kernel.settings.time = t;          // seconds, passed to the law
kernel.settings.salt = frame;      // sub-pixel and shutter jitter
const planes = [{ law: 'kepler', count: 4e9, seed: 17, params, homography: planeHomography(viewProj, model, 3840, 2160) }];
const tally = await renderFrame(kernel, planes, { targetMs: 200 });   // clears, paces, folds
// kernel.counts: exact u64 per pixel -> CountToneMapper({ words: 2 })
```

Lower level: `kernel.clear(enc)`, `kernel.encodeBatch(enc, { plane, start, count })`,
`kernel.submitted()` after each submit, `kernel.fold(enc)`, `kernel.readTally()`.
`clear(enc, { keepCounts: true })` resumes from counts written into `kernel.counts`.

A law is WGSL `fn name(key: Key, t: f32, p: array<f32, 8>) -> vec2f` returning
a sheet position in [-1, 1]^2, with `pcg`, `u01`, `tri`, `draw`, `strat` and
`TAU` in scope.

## Demo and bench

`npm run dev`, then `/src/trillion/demo/`:

| URL | what |
| --- | --- |
| `?n=1e12&strat` | one frame of the stratified laws, progressive, with the tally |
| `?offline` | the same laws on the plain path |
| `&shot=close` | close-up camera |
| `?bench&w=3840&h=2160&n=1e10` | four-mode bench, wide and close-up: math only, random global atomics, run merge, run merge + tile. Prints billions per second and seconds per trillion. |

In the console: `__trillion.selftest()` (counter sum equals landed; two batch
sizes give bit-identical counts) and `__trillion.compare()` (strata path
against the plain path: per pixel z-scores of the count difference, which must
center on 0 with spread at most 1).

## Measured

On software WebGPU only (no speed meaning): every shader compiles, the self
test passes on both paths, `compare()` gives z mean 0.01, z spread 0.89, no
pixel beyond 5 sigma, 100% of patches tiled in the wide demo scene.

**Not yet measured on the 2070.** Run `?bench&w=3840&h=2160&n=1e10` there and
add the table to `docs/perf.md`.

## Limits

- Coherence decays when a law shears its patches over time (differential
  rotation, vortex winding). The tile ratio in the tally shows it; smaller
  patches (`plane.strata = [gu, gv]`) help.
- Per-particle scatter draws (kepler's orientation and eccentricity scatter)
  spread a patch by the scatter amount.
- Frame resolution up to 65535 pixels per side (run merge packs x and y in 16
  bits each).
