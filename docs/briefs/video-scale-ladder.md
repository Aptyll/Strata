# Brief: the video scale ladder and the one-pixel ending

Owner (2026-11-19): unowned. It builds on `src/proof` (proof shots thread)
and `src/offline` (offline renderer thread); coordinate with both.

## Context

The offline renderer (`src/offline`, PR #41) renders a cluster of sheets and
a camera that flies in until single particles resolve. `src/proof` (PR #49)
already wraps it in five shots: count-up, pull-back, loupe, dive and find
particle #N, all with `count` weighting and `point` splats.

Count-up uses `prefixJob`, which takes particles in **plane-major order**:
whole sheets first, then a prefix of the next. With the `trillion` world
(1024 sheets of about 977M), every stage below about 977M shows only the hero
sheet, and above it new sheets switch on one at a time. That is a fine shot,
but it mixes two effects: grain refining and sheets appearing.

The artist review proposed the ending: the trillion particles collapse into
one white pixel, identical to the opening frame.

## Research conclusion

**A ladder only convinces if nothing changes but the count.** Same seed, same
sheets, same camera, same exposure per particle. Then the viewer sees the same
structure get smoother, and faint structure appear, rung by rung.

| rung | particles | mean hits per pixel at 4K | one frame at 10 G/s (estimate) |
| --- | --- | --- | --- |
| 1 | 10^6 | 0.12 | 0.1 ms |
| 2 | 10^8 | 12 | 10 ms |
| 3 | 10^9 | 121 | 0.1 s |
| 4 | 10^10 | 1,206 | 1 s |
| 5 | 10^11 | 12,056 | 10 s |
| 6 | 10^12 | 120,563 | 100 s |

- **Proportional prefix.** Within a sheet the key is a bijection of the
  index, so the first n particles of a sheet are a uniform sample of it. Scale
  every sheet's `particleCount` by the same fraction and each rung shows every
  sheet at once, and every particle of a lower rung is also in the higher ones.
- **Exposure locked per particle.** Auto exposure would rescale each rung to
  look the same and hide the point. Use a fixed white point that scales with
  the count, `white_n = white_1T * n / 10^12` (the grade's `white` option, in
  particles per pixel), and scale the toe by the same factor so the curve keeps
  its shape. Same mean brightness, falling grain.
- **The collapse needs no new law.** Scale the whole world toward one point:
  each frame, multiply every sheet's offset from the target and its `halfSize`
  by s(t), easing from 1 to well under one pixel. The homography is built on
  the CPU from `position` and `halfSize`, so this is a per-frame job, not a
  shader change. In `count` weighting the last frame's single lit pixel holds
  exactly `10^12 * ONE`, a proof anyone can read (the loupe shot already reads
  one pixel's exact 64-bit count).
- **The collapse frames are the slow ones.** All adds converge on a few
  addresses, and same-address atomics serialize. Add per-thread write
  combining in `src/offline/core/shaders.ts`: keep a running (pixel, weight)
  across the particles of one invocation and call `add64` only when the pixel
  changes. Exact, and up to 64 times fewer atomics once particles share pixels.
  The 64-bit grid holds the result (10^12 x 65536 = 6.6 x 10^16, under 2^64).
- **Lock exposure for the collapse too**, and let the final pixel clip to white.

## Steps

1. In `src/proof/shots.ts`, add `scaledJob(job, fraction, name)` (every
   sheet's count times `fraction`, rounded) and `ladderPasses(o, counts)` that
   holds each rung for a second or two, with a locked white per rung and the
   existing tally label.
2. Add `collapsePasses(o, frames, target)`: per-frame jobs with sheets scaled
   toward `target` by s(t), locked exposure, `weighting: "count"`.
3. Add write combining to the accumulate shader. Keep
   `npx tsx node/test.mjs` in `src/offline` bit-identical.
4. Opening frame: one white pixel on black, the same pixel the collapse ends on.
5. Render rungs 1 to 4 on any GPU first as a check; rungs 5 and 6 on the 2070.

## Files to touch

- `src/proof/shots.ts`, `src/proof/web/main.ts` (shot list)
- `src/offline/core/shaders.ts` (write combining), `src/offline/core/grade.ts`
  (locked white per pass, if not already expressible)

## Done when

- Rungs 1 to 4 render from one world with identical camera and seeds, every
  sheet is visible at every rung, and the frames differ only in grain.
- The collapse ends on one lit pixel whose 64-bit count divided by `ONE` is
  exactly the job's particle count.
- Write combining leaves the offline self-checks bit-identical, and the bench
  number does not drop.
