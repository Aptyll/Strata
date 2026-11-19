# Brief: the video scale ladder and the one-pixel ending

Owner (2026-11-19): unowned.

## Context

The offline renderer (`src/offline`, PR #41) renders one shot: a cluster of
sheets, a wide view that flies in to the hero sheet until single particles
resolve. Presets `billion`, `ten_billion` and `trillion` exist, but each one
builds its own camera from its own density (`clusterJob` in
`src/offline/core/world.ts`), so they are not the same shot. The artist review
proposed the ending: the trillion particles collapse into one white pixel,
identical to the opening frame.

## Research conclusion

**A ladder only convinces if nothing changes but the count.** Same seed, same
planes, same camera, same exposure per particle. Then the viewer sees the same
structure get smoother, and faint structure appear, rung by rung.

| rung | particles | mean hits per pixel at 4K | one frame at 10 G/s (estimate) |
| --- | --- | --- | --- |
| 1 | 10^6 | 0.12 | 0.1 ms |
| 2 | 10^8 | 12 | 10 ms |
| 3 | 10^9 | 121 | 0.1 s |
| 4 | 10^10 | 1,206 | 1 s |
| 5 | 10^11 | 12,056 | 10 s |
| 6 | 10^12 | 120,563 | 100 s |

- **Nested rungs for free.** Within a plane `particleKey` is a bijection of the
  index, so the first n particles of each plane are a random subset. Build each
  rung by scaling every plane's `particleCount` by the same factor: every
  particle in the 1M rung is also in the 1T rung.
- **Exposure must be locked per particle.** Auto exposure would rescale each
  rung to look the same and hide the point. Use a fixed white point that
  scales with the count: `white_n = white_1T * n / 10^12` (the grade's `white`
  option, in particles per pixel), and scale the toe by the same factor so the
  curve keeps its shape. Same mean brightness, falling grain.
- **The collapse needs no new law.** Scale the whole world toward one point:
  each frame, multiply every plane's position offset from the target and its
  `halfSize` by s(t), easing from 1 to a size well under one pixel. The
  homography is built on the CPU from `position` and `halfSize`, so this is a
  per-frame job transform, not a shader change. In `count` weighting the last
  frame's single lit pixel holds exactly `10^12 * ONE`, a proof anyone can read.
- **The collapse frames are the slow ones.** All adds converge on a few
  addresses and same-address atomics serialize. Add per-thread write combining
  in `src/offline/core/shaders.ts` (keep a running pixel and weight across the
  64 particles of an invocation; call `add64` only when the pixel changes).
  Exact, and it divides the atomics by up to 64. The 64-bit grid holds the
  result (10^12 x 65536 = 6.6 x 10^16, under 2^64).
- **Fix the exposure for the collapse too**, or the one-pixel frame will look
  like any other frame. Let it clip to white.

## Steps

1. Add `ladderJobs(base: OfflineJob, counts: number[])` in a new file
   `src/offline/core/ladder.ts`: copies the 1T job, scales `particleCount` per
   plane, keeps camera, `splat`, `fluxRef`, `near` and seeds unchanged.
2. Add a fixed-white grade option per rung (white scaled by count) and a tally
   label per rung, read from the frame stats (see [honest-counting](honest-counting.md)).
3. Add `collapseJob(base, startFrame, frames, target)` in the same file:
   per-frame plane transforms scaled toward `target` by s(t); exposure locked;
   `weighting: "count"` for the final frames.
4. Add write combining to the accumulate shader. Keep the CPU reference test
   in `src/offline/node/test.mjs` passing (results must be bit-identical).
5. A preset or CLI flag that renders the ladder and the collapse as one job
   list; render rungs 1 to 4 on any GPU first as a check.
6. Opening frame: one white pixel on black, the same pixel the collapse ends
   on.

## Files to touch

- new `src/offline/core/ladder.ts`
- `src/offline/core/shaders.ts` (write combining), `src/offline/node/cli.mjs`
  (preset or flag), `src/offline/core/grade.ts` (fixed white per rung)
- Coordinate with the offline renderer thread, which owns `src/offline`.

## Done when

- Rungs 1 to 4 render from one base job with identical camera and seeds, and
  their frames differ only in grain (check by eye at one frame).
- The collapse ends on one lit pixel, and in count mode that pixel's 64-bit
  value divided by `ONE` is exactly the job's particle count.
- Write combining leaves the CPU reference test bit-identical, and the bench
  number does not drop.
