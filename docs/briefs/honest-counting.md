# Brief: honest counting

Owners (2026-11-19): the offline renderer (exact landed counter in
`src/offline`), the recorder (`src/record` tally and manifest), and the record
script (`npm run record`). This brief is the shared definition they all build
to, so the three pieces report the same numbers.

## Context

The headline is "one trillion particles". Skeptics will check three things:
that the word is right, that every particle was really computed, and that no
particle is a copy. A reflection review on 2026-11-19 listed the proof devices.

## Research conclusion

1. **Wording.** The 1T film is *rendered* (or "procedurally animated"), never
   "simulated". Its particles have no stored state and do not interact; motion
   is a closed-form law. Real simulations with about 2 trillion particles exist
   (for example the Uchuu cosmology run, 12800^3, about 2.1 x 10^12), so "first
   trillion particle simulation" would be false. The simulation claim belongs to
   the realtime tier: 100M particles with 8 bytes of state read, integrated and
   written every frame (`src/challenge/README.md`, "What counts").
2. **What the number means.** The claim is *evaluated per frame*: every id
   from 0 to N - 1 went through the kernel exactly once in that frame. Also
   report *landed*: how many passed the clip test and were added to the grid.
   Evaluated is the headline; landed is shown next to it.
3. **Weight one.** For the claim, every particle counts as exactly one. No
   level-of-detail multiplier (`PerfEngine` brightens a thinned plane by
   `count / k`, so it may never feed a record), no instancing, no copies (see
   [64-bit-ids](64-bit-ids.md)). Flux weighting (dimmer when far) is fine for the
   look, but then the grid sum is a light total, not a count, so the landed
   count needs its own counter.
4. **Count on the GPU, not in host bookkeeping.** The host knows how many it
   dispatched; only the GPU can say how many ran. Each workgroup sums its
   evaluated and landed counts in workgroup memory, then adds them once into a
   64-bit counter (lo/hi with carry, the same `add64` as the grid). That is two
   atomics per workgroup, a negligible cost.
5. **Prior art to credit.** Histogram renderers that accumulate billions of
   samples per image (fractal flames, the Buddhabrot), and compute-shader point
   rasterization (Schütz, Kerbl, Wimmer, 2021).

## Steps

1. Offline renderer: add the two GPU counters (evaluated, landed) to the
   accumulate shader and to `FrameResult`; write them to each frame's stats
   JSON. Fail the frame if evaluated is not exactly the job's total.
2. Count mode check: when `weighting` is `count`, also assert
   `grid sum == landed * ONE`.
3. Recorder: burn a tally into the frame (evaluated, exact digits, for example
   `1,000,000,000,000 particles this frame`) and keep the label that says
   "rendered, not simulated". The tally must come from the stats JSON, not from
   the job.
4. Manifest per render (`src/record`): git commit, job JSON and its hash, seed,
   GPU adapter string, measured particles per second, per-frame evaluated and
   landed counts, wall time per frame. Published with the video.
5. Record script: `npm run record` reproduces a short clip from the manifest
   and compares per-frame counts and a grid hash.

## Files to touch

- `src/offline/core/shaders.ts`, `src/offline/core/renderer.ts`,
  `src/offline/core/develop.ts` (stats)
- `src/record/*` (recorder thread), root `package.json` script (record thread)

## Done when

- Every rendered frame's stats JSON holds GPU-counted `evaluated` and `landed`,
  and `evaluated` equals the job total exactly.
- The tally on screen is read from those stats.
- A manifest exists for every render, and `npm run record` reproduces a clip's
  counts and grid hash from it.
- No text in the video, title or description says "simulated" about the 1T shot.
