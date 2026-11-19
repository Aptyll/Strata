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
  2x2 blocks, tiles and folds only group those adds. Integer adds commute, so
  a frame is bit-identical however it is batched.
- The tally comes from the GPU: `evaluatedGpu`, `inView` and `landed` (equals
  the sum of all counters), plus `evaluated` and `culled` from the CPU.
  Culling is off by default, so `evaluated == N` for the record.
- No subsampling, interpolation, or analytic density anywhere.

## Why the 2070 needs a different kernel

A 4K counter grid is 33 MB. The 2070's L2 is 4 MB, so atomics to random
pixels miss the cache and go to DRAM. The idea is to make a workgroup's
particles land close together on screen, so their hits can be added up in
registers and fast workgroup memory first:

1. **Stratified ids.** A plane is split into `gu x gv` patches of about 2^17
   particles, one workgroup each. Each thread walks one row of its patch.
   The particle's stratified coordinate `strat(key)` is its cell in this
   jittered grid, so neighbouring ids get neighbouring coordinates.
2. **Coherent laws.** A law that takes its two main coordinates from
   `strat(key)` (and declares `coherent: true`) maps a patch to a small patch
   of screen. `STRATIFIED_OFFLINE_LAWS` are kepler, vortex and lissajous from
   `src/offline` rewritten that way: same distribution of positions per plane.
3. **Run merge over the splat's 2x2 block.** The stochastic sub-pixel splat
   sends each particle to one of the 4 pixels around it, at random with the
   bilinear weights, so consecutive particles rarely hit the same pixel. They
   do share the same 2x2 block, so each thread counts hits per corner of the
   current block in registers and adds them only when the block changes.
   Every particle still lands on its own pixel.
4. **Shared memory tile.** Each workgroup first evaluates the two u edges of
   its patch, places a tile of up to 4096 counters (16 KB, so four
   workgroups fit on a 64 KB multiprocessor) around them, adds there, and
   flushes the tile to global memory once. Hits outside the tile go straight
   to global memory, so a bad guess costs speed, never correctness.
   `tally.tiledPatches / tally.patches` shows how often it works.
5. **Exact folding.** Global counters are `u32` with fire-and-forget atomics
   (4 bytes a pixel, no return value to wait for). Before any could overflow
   (at most 2^32 - 1 particles since the last fold) they are folded into the
   exact 64-bit `counts`, CountToneMapper `words: 2` layout.

Per particle the kernel avoids the slow (quarter-rate) conversion
instructions: the pixel and its sub-pixel fraction come from 8-bit fixed point
rounded through the f32 mantissa, the stratified jitter is built with a
bitcast, and the splat and shutter jitter is one two-multiply hash of the key.
Non-coherent laws use the plain path: direct global atomics, or a per-plane
tile when the whole plane is small on screen.

## Use

```ts
import { TrillionKernel, renderFrame, planeHomography, trillionLimits, STRATIFIED_OFFLINE_LAWS } from './trillion';

const device = await adapter.requestDevice({ requiredLimits: trillionLimits(adapter) });
const kernel = await TrillionKernel.create(device, { width: 3840, height: 2160, laws: STRATIFIED_OFFLINE_LAWS });
kernel.settings.time = t;          // seconds, passed to the law (mid shutter)
kernel.settings.shutter = s;       // seconds of exposure, 0 for none
const planes = [{
  law: 'kepler', count: 4e9, seed: 17, params,
  homography: planeHomography(viewProj, model, 3840, 2160),    // camera at mid shutter
  homographyDelta: close.map((v, k) => v - open[k]),            // optional camera blur
}];
const tally = await renderFrame(kernel, planes, { targetMs: 200 });   // clears, paces, folds
// kernel.counts: exact u64 per pixel -> CountToneMapper({ words: 2 })
```

- **Keep `settings.salt` constant across a video** (the default 0). The salt
  re-rolls every particle's sub-pixel choice, shutter instant and `keep`
  decision; changing it per frame makes single dots jitter and flicker in
  close-ups. Change it only to get an independent realization of a still.
- **Motion blur.** Each particle gets one instant s in [-0.5, 0.5) of the
  shutter. The law sees `time + shutter * s`, and with `homographyDelta`
  (homography at shutter close minus open) the camera sees
  `homography + s * delta`, so position and camera agree.

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
| `&tile=8160` | 32 KB tile instead of the default 16 KB |
| `?bench&w=3840&h=2160&n=2e11` | bench, wide and close-up: plain math only, random global atomics, strata math only, run merge, run merge + tile, plain math only again (clock drift). Prints billions per second and seconds per trillion. |

In the console: `__trillion.selftest()` (counter sum equals landed; two batch
sizes give bit-identical counts), `__trillion.compare()` (strata path against
the plain path: per pixel z-scores of the count difference, which must center
on 0 with spread at most 1) and `__trillion.blurTest()` (a camera delta that
slides the sheet 24 px keeps the count and the centroid and adds 24^2/12 to
the x variance).

## Measured

### RTX 2070, before the 2x2 run merge (main `ab82ede`, 2026-11-19)

Driver 621.01, Chrome 157, Windows 11, 3840x2160, no device loss. Tile 8160
counters (32 KB).

Full 1T frames, 233 planes:

| frame | time | rate | notes |
| --- | ---: | ---: | --- |
| stratified, wide | 47.55 s | 21.03 B/s | 1e12 evaluated (GPU tally), 1e12 landed, 7,637,051 patches, 100% on a tile |
| stratified, close-up | 42.39 s | 23.59 B/s | 4.0854e11 in view, 40.3% on a tile, 0.9% partly |
| plain (offline laws), wide | 48.92 s | 20.44 B/s | |

`selftest()` on the 2070: `{"ok":true,"landed":20000000,"sum":20000000,"identical":true}`.

Four-mode bench, seconds per 1T (billions per second). Runs were 1 to 5 s, so
the noise is about 25%:

| mode | wide | close-up | wide, tile 4096 | close-up, tile 4096 |
| --- | ---: | ---: | ---: | ---: |
| math only, plain path (no counter writes) | 28.1 (35.61) | 42.4 (23.57) | 28.8 (34.74) | 36.9 (27.07) |
| random global atomics | 41.1 (24.35) | 47.9 (20.87) | 55.7 (17.95) | 57.2 (17.49) |
| run merge, no tile | 103.1 (9.70) | 64.7 (15.47) | 123.6 (8.09) | 69.9 (14.31) |
| run merge + tile | 64.9 (15.41) | 47.4 (21.09) | 49.9 (20.06) | 62.9 (15.89) |

With the default tile, 100% of patches found a tile in the wide shot and 33%
in the close-up (the rest are mostly off screen).

What it says:

- **The strata path was no faster than the plain one** (47.6 s against
  48.9 s wide).
- **Runs were too short.** The stochastic splat picks one of 4 pixels per
  particle, so fewer than half of consecutive particles shared a pixel and
  runs averaged under 2. And the 32 threads of a warp walk 32 neighbouring
  rows, so their adds hit the same few counters at once and queue. That is my
  reading of why run merge without the tile was the slowest mode. The 2x2
  block merge above is the fix; not yet measured.
- **Not the fold or the patches.** About 233 folds per 1T frame, under 0.1 s
  in total. Edge sampling adds 0.4% particles, plus two barriers and one tile
  scan per patch.
- **Math is the floor.** With no counter writes at all, key + law +
  projection cost 28 to 42 s per 1T. The math does not depend on the camera,
  so the wide/close gap is most likely clock boost and noise; the bench now
  repeats the math row at the end to show drift. The close-up frame already runs
  at its math-only time. Estimate, not measured: with the 2x2 merge and the
  cheaper per-particle arithmetic, about 25 to 35 s per 1T 4K frame. 10 to
  15 s would need laws and keys about half as expensive as kepler's.

### Software WebGPU (correctness only, no speed meaning)

After the 2x2 merge: every shader compiles (`npm run verify`), the self test
passes on the strata path with the default tile and with a 256-counter tile
(80% partial tiles), `compare()` gives z mean -0.004, z spread 0.88, no pixel
beyond 5 sigma, and `blurTest()` gives a variance growth of 48.02 for an
expected 48 with a centroid shift of 0.005 px, on both paths.

## Limits

- Coherence decays when a law shears its patches over time (differential
  rotation, vortex winding). The tile ratio in the tally shows it; smaller
  patches (`plane.strata = [gu, gv]`) help.
- Per-particle scatter draws (kepler's orientation and eccentricity scatter)
  spread a patch by the scatter amount.
- Frame sides up to 65535 pixels (16-bit run keys). The sub-pixel fraction
  has 8 bits up to 32764 pixels and fewer above.
- A strata row holds at most 65535 ids (16-bit run counts); `strataLayout`
  adds patches when a plane's `strata` would make rows longer.
