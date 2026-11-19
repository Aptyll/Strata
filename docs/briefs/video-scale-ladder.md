# Brief: the video scale ladder and the one-pixel ending

Owner (2026-11-19): done. The ladder runs in the Node runner (PR #59) and in
the browser as the `ladder` and `collapse` shots on `/src/proof/web/`
(PR #79). It builds on `src/proof` (proof shots thread) and `src/offline`
(offline renderer thread).

## State on main (after PR #68)

- Done, PR #59: `npx tsx node/cli.mjs ladder` in `src/offline`
  (`core/ladder.ts`) freezes one frame and renders it at 1M, 100M, 10B and 1T
  by scaling every sheet's `particleCount` with exact largest-remainder math.
  Exposure is locked per particle (white scales with the count). This is the
  proportional prefix and locked exposure described below.
- Done, PR #65: per-thread write combining in the accumulate shader.
- Done, PR #79: the browser entry point, since the Node runner cannot run on
  Noah's PC (Windows Application Control blocks `dawn.node`). `/src/proof/web/`
  has a `ladder` shot (1M, 100M, 10B, 1T, always ending on the world's total,
  exposure locked per particle) and a `collapse` shot: every sheet shrinks
  toward the world point behind the center pixel until all particles land on
  one pixel, exposure locked to the first frame. Its last frame, held 2 s, is
  the one-pixel opening frame. Checked on a software GPU: 4,000,000 particles,
  1 lit pixel.

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
  addresses, and same-address atomics serialize. Per-thread write combining
  (PR #65: a running (pixel, weight) per invocation, `add64` only when the
  pixel changes) cuts that by up to the particles per invocation, exactly.
  The 64-bit grid holds the result (10^12 x 65536 = 6.6 x 10^16, under 2^64).
- **Lock exposure for the collapse too**, and let the final pixel clip to white.

## Steps

1. Browser ladder: add a "ladder" shot to `src/proof/shots.ts` and
   `src/proof/web/main.ts` that calls `core/ladder.ts` (no new scaling code)
   and holds each rung for a second or two with the existing tally label.
2. Add `collapsePasses(o, frames, target)`: per-frame jobs with sheets scaled
   toward `target` by s(t), locked exposure, `weighting: "count"`.
3. Opening frame: one white pixel on black, the same pixel the collapse ends on.
4. Render rungs up to 10B on any GPU first as a check; 1T on the 2070
   (about 5 minutes per 1T 4K frame in Chrome).

## Files to touch

- `src/proof/shots.ts`, `src/proof/web/main.ts` (shot list)
- reuse `src/offline/core/ladder.ts`; change it only to export what the browser needs

## Done when

- The ladder renders in Chrome from `/src/proof/web/` (or `/src/offline/web/`)
  with the same rungs and locked exposure as the Node `ladder` command.
- The collapse ends on one lit pixel whose 64-bit count divided by `ONE` is
  exactly the job's particle count.
