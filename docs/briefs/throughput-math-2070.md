# Brief: throughput math for the RTX 2070

## Context

The 1T render is stateless (`src/offline`, merged in PR #41): every frame
evaluates all 10^12 particles from (seed, index, time) and adds each one into a
64-bit integer grid with atomics. Memory is not the limit any more. Time is.
Nobody has measured particles per second on a real GPU. The field guide's
calculator defaults to 10 billion per second, which its own text calls a guess.
The target card is Noah's RTX 2070 (8 GB).

## Research conclusion

Everything follows from one division:

```
seconds per frame = 10^12 / R          (R = particles evaluated per second)
render hours      = frames * 10^12 / R / 3600
```

| R (estimate range) | one 1T frame | 10 s at 60 fps (600 frames, preset `trillion`) | 10 s at 30 fps |
| --- | --- | --- | --- |
| 5 G/s | 200 s | 33.3 h | 16.7 h |
| 10 G/s | 100 s | 16.7 h | 8.3 h |
| 20 G/s | 50 s | 8.3 h | 4.2 h |

Ceilings on a 2070 (estimates from the spec sheet, to be replaced by the bench):

- **Arithmetic.** 2304 lanes at about 1.62 GHz is about 3.7 x 10^12 simple
  instructions per second per pipe (Turing has separate FP32 and INT32 pipes).
  The `kepler` law plus hashes, projection and the clip test is roughly 100 to
  150 instructions per particle, so arithmetic alone allows about 25 to 50 G/s.
- **Atomics.** The 4K grid is 33 MB per word buffer, far larger than the 4 MB
  L2. A fully scattered atomic that misses L2 costs about a 32-byte read and a
  32-byte write: 448 GB/s / 64 B is about 7 G/s. Atomics that stay in L2 are
  several times faster.
- So the atomic write, not the math, is the likely limit, and **R will change
  with the shot.** The offline renderer dispatches one plane at a time, so in
  the wide shot each batch writes into one small screen footprint that fits in
  L2. In the close-up the hero sheet covers the whole frame and writes scatter
  over all 33 MB. Expect the close-up to be the slowest part of the clip.
- **Same-pixel contention.** Many adds to one address serialize. This matters
  for dense cores and above all for the collapse shot at the end of the video
  (all 10^12 adds into one pixel; see [video-scale-ladder](video-scale-ladder.md)).

Levers, most valuable first:

1. **30 fps instead of 60** halves the bill with no change to the picture per frame.
2. **Point splat** (1 atomic per particle) instead of bilinear (4). `world.ts`
   already picks point above 2 x 10^10 particles.
3. **Per-thread write combining.** Each invocation already loops over
   `perInvocation` (64) consecutive particles in `src/offline/core/shaders.ts`.
   Keep a running (pixel, weight) pair and only call `add64` when the pixel
   changes. Exact. It only pays where consecutive particles share a pixel
   (dense cores, the collapse shot), because ids are placed at random; elsewhere
   it costs one compare.
4. **Cheaper per-particle math.** Hoist anything that depends only on the
   plane out of the loop; skip the flux rounding draw when the weight is 1.
5. **Coherent ids** (bigger change): order ids so consecutive particles land
   near each other, then accumulate a tile in workgroup memory and flush once.
6. **Shard** with `--shard i/n` if a second GPU becomes available.

## Steps

1. On Noah's machine (the "Run Strata on the real GPU" thread has it):
   ```sh
   cd src/offline && npm install
   npx tsx node/cli.mjs bench
   ```
   It prints R for each law and both splat modes at 3840 x 2160, plus the
   clip times. Note the bench draws one full-frame sheet, so it measures the
   scattered (close-up) case.
2. Also time one real frame of the `trillion` preset near the start (wide
   shot) and one near the end (close-up). Run `npx tsx node/cli.mjs` with no
   arguments for the frame and range flags. These two numbers bound the clip.
3. Fill the table above with measured values in `docs/perf.md` (new section
   "Offline stateless throughput") and in `src/offline/README.md`.
4. Pick clip length and fps from a render budget Noah can live with. Rule:
   `frames = budget_hours * 3600 * R / 10^12`. Ask Noah with a decision card
   (2 to 4 options, one recommended), for example 10 s at 30 fps versus 5 s at 60 fps.
5. If R is below 5 G/s, implement lever 3 (write combining) before rendering,
   then bench again. It is a small, exact change.

## Files to touch

- `docs/perf.md` (append a section), `src/offline/README.md` (numbers only)
- `src/offline/core/shaders.ts` only if lever 3 is needed; coordinate with the
  offline renderer thread, which owns `src/offline`.

## Done when

- At least one measured R from the RTX 2070 is in `docs/perf.md`, with the
  adapter name, resolution, law, splat mode and date.
- Wide-shot and close-up frame times for 1T at 4K are recorded.
- A clip length and fps are chosen from those numbers, with the render time
  written next to them, and Noah has picked one on a decision card.
