# 05. Trillion splat kernel

| | |
| --- | --- |
| Date | Nov 18, 2026 (US Central; Nov 19 in UTC) |
| Covers | 7:34 PM to 8:19 PM |
| Code | [`src/trillion`](../../../src/trillion/README.md) |
| Reference docs | [docs/trillion.md](../../trillion.md), [throughput brief](../../briefs/throughput-math-2070.md) |
| Status as of | 8:20 PM |

[Back to the rendering journal](README.md)

A second, standalone kernel for stateless particles, built to get past the
one thing that limits the offline renderer on the RTX 2070: where the hits
land in memory. This page records the design, the software checks, and the
first numbers from the real card, which did **not** show the speedup the
design was aiming for.

## Why a different kernel

The reasoning, from the [throughput brief](../../briefs/throughput-math-2070.md)
(arithmetic and estimates, written before any measurement of this kernel):

- A 4K grid of `u32` counters is 33 MB. The 2070's L2 cache is 4 MB. Atomic
  adds to random pixels miss the cache and go to video memory.
- Estimate for scattered atomics: 3 to 7 billion adds per second, so 3 to 5
  minutes per trillion.
- Estimate for the arithmetic of the laws alone: 25 to 50 billion particles
  per second.
- So accumulation is the bottleneck, not math. If a workgroup's particles
  land close together, their hits can be summed in fast workgroup memory first
  and written out once. The target was 10 to 15 seconds per 1T 4K frame.

## What was built

**The kernel** ([#50](https://github.com/Aptyll/Strata/pull/50)).
`TrillionKernel.encodeBatch` evaluates a range of particle ids of one plane
and counts hits per pixel. Hot counters are `u32` with fire-and-forget
atomics, folded into exact 64-bit counters before any can overflow. When a
plane's footprint on screen fits in workgroup memory (up to 8192 counters,
32 KB), hits go to a shared memory tile first and are flushed once per
workgroup. `renderFrame()` paces a frame as many short submits of about
200 ms, well under the 2 second Windows GPU watchdog.

**Shared keys and the offline laws**
([#58](https://github.com/Aptyll/Strata/pull/58)). Identity comes from
`src/stateless`, the kernel accepts the offline renderer's laws unchanged, and
plane culling became opt-in so that every particle is evaluated for the
record.

**Coherent particle ids** ([#82](https://github.com/Aptyll/Strata/pull/82)).
The fast path Noah picked. A plane is split into patches of about 2^17
particles, one workgroup each, and `strat(key)` gives each particle a
stratified coordinate so that neighbouring ids land next to each other on
screen. Each thread merges runs of hits on the same pixel in registers, adds
the runs to the tile, and the tile is flushed once. Kepler, vortex and
Lissajous were rewritten this way as `STRATIFIED_OFFLINE_LAWS`, with the same
distribution of positions per plane. The tally gained a GPU-counted
`evaluatedGpu`, `patches` and `tiledPatches`.

**Partial tiles** ([#115](https://github.com/Aptyll/Strata/pull/115)). A
patch whose footprint is larger than the tile used to get no tile at all. Now
it gets the largest tile over the middle of its footprint, and hits outside
still go straight to global memory.

**Behind the offline renderer**
([#80](https://github.com/Aptyll/Strata/pull/80),
[#120](https://github.com/Aptyll/Strata/pull/120)). `--kernel trillion` runs
this kernel behind the offline renderer's job format, checkpoints and grade.

Counts stay exact throughout: every landed particle adds exactly 1 to exactly
one pixel. Runs, tiles and folds only group those adds.

## Pull requests

| PR | title | merged (Central) | state |
| --- | --- | --- | --- |
| [#50](https://github.com/Aptyll/Strata/pull/50) | Add the trillion particle splat kernel with exact per-pixel counts | 7:34 PM | merged |
| [#58](https://github.com/Aptyll/Strata/pull/58) | Trillion kernel: shared stateless keys, offline laws, culling off by default | 7:37 PM | merged |
| [#64](https://github.com/Aptyll/Strata/pull/64) | Add agent briefs distilled from the rendering research | 7:39 PM | merged |
| [#75](https://github.com/Aptyll/Strata/pull/75) | Briefs: mark the ladder and write combining done, add the Chrome throughput number | 7:42 PM | merged |
| [#82](https://github.com/Aptyll/Strata/pull/82) | Trillion kernel: coherent particle ids with a shared memory tile per workgroup | 7:56 PM | merged |
| [#80](https://github.com/Aptyll/Strata/pull/80) | Offline: run the trillion splat kernel behind the same renderer, selectable | 7:59 PM | merged |
| [#115](https://github.com/Aptyll/Strata/pull/115) | Trillion kernel: partial shared memory tile for spread-out patches | 8:01 PM | merged |
| [#120](https://github.com/Aptyll/Strata/pull/120) | Docs: the trillion kernel is now selectable in the offline renderer, and the per-sheet hue rasterizer is in the code map | 8:05 PM | merged |
| [#149](https://github.com/Aptyll/Strata/pull/149) | Offline renders can use the new stateless laws, and the trillion kernel's evaluated count now comes from the GPU | 8:19 PM | merged |

## Measured on a software GPU

No speed meaning. From [docs/trillion.md](../../trillion.md) and the PRs:

| check | result |
| --- | --- |
| Self test | counter sum equals the landed tally; two batch sizes give bit-identical counts |
| `compare()`: the strata path against the plain path, per-pixel z-scores of the count difference | mean 0.01, spread 0.89, no pixel beyond 5 sigma |
| Patches that found a tile in the wide demo scene | 100% |
| Forced 256-counter tile at 1280x720 (80% of patches on a partial tile) | self test passes, GPU evaluated tally equals the host count |

## Measured on the RTX 2070

These numbers were reported by the agent driving Noah's desktop at 8:07 PM
and 8:10 PM. They were not yet in `docs/perf.md` or `docs/trillion.md` when
this page was written, so treat this page as their first written record.

Setup: main at `ab82ede`, RTX 2070 (8 GB), driver 621.01, Chrome 157,
Windows 11, 3840x2160, no device loss. Four-mode bench at
`/src/trillion/demo/?bench&w=3840&h=2160&n=4e10`. Each cell is billions of
particles per second, with seconds per trillion in brackets.

**Default tile**

| mode | wide shot | close-up |
| --- | ---: | ---: |
| math only (no accumulation) | 35.61 (28.1 s) | 23.57 (42.4 s) |
| random global atomics | 24.35 (41.1 s) | 20.87 (47.9 s) |
| run merge, no tile | 9.70 (103.1 s) | 15.47 (64.7 s) |
| run merge + tile | 15.41 (64.9 s), 100% of patches tiled | 21.09 (47.4 s), 33% tiled |

**With `&tile=4096`**

| mode | wide shot | close-up |
| --- | ---: | ---: |
| math only | 34.74 | 27.07 |
| random global atomics | 17.95 | 17.49 |
| run merge, no tile | 8.09 | 14.31 |
| run merge + tile | 20.06 (49.9 s) | 15.89 |

Caveat from the report itself: each run lasted 1 to 5 seconds, so the noise is
about 25%.

**Full frames.** With the same build, a full 1T 4K frame took 42 to 49
seconds on every run, the self test passed, and the stratified path was only
about 3% ahead of the plain path.

## What the first numbers say

- **The math estimate held.** Math only runs at 24 to 36 billion per second,
  inside the brief's 25 to 50.
- **The plain path was faster than the estimate for scattered hits.** The
  "random global atomics" mode is the kernel's plain path on the same two
  scenes: 17 to 24 billion per second, against the 3 to 7 estimated for hits
  scattered over a whole 4K frame. In these two scenes, the cost the fast path
  was built to remove is small. Whether one sheet filling the frame (the case
  where the offline kernel measured 3.3 billion per second) behaves the same
  was not part of this report.
- **Run merge without the tile was the slowest mode** in both shots.
- **Run merge with the tile came back to about the speed of random atomics**,
  not clearly past it.
- **10 to 15 seconds per frame is not confirmed.** The measured figure is 42
  to 49 seconds per 1T 4K frame.

These are short runs with 25% noise. Longer runs (`n=2e11`) were offered but
had not been run. The wide and close-up shots here are the kernel demo's own
scenes, so the numbers are not an A/B against the offline kernel's 26 to 52
second record frames, which used other scenes and flux weighting. That A/B is
`bench --kernel both` in `src/offline`, and it had not been run on the 2070.

## Open

- The stratified fast path only runs in the kernel's own demo. The offline
  renderer's `--kernel trillion` passes the plain laws.
- The kernel has no camera motion blur yet (the offline kernel got it in
  [#92](https://github.com/Aptyll/Strata/pull/92)).
- Until 8:19 PM the offline runner labelled this kernel's count
  "dispatched". [#149](https://github.com/Aptyll/Strata/pull/149) made it read
  the kernel's GPU count
  ([page 04](2026-11-18-04-particle-keys-and-honest-counting.md)). No frame
  had been rendered with that change yet.
- Noah had put the full 10 second 1T clip on hold until this kernel was
  ready. The first numbers do not show the speedup that hold was waiting for.
- `docs/trillion.md` still says "Not yet measured on the 2070".
