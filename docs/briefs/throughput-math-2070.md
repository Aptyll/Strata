# Brief: throughput math for the RTX 2070

## Context

The 1T render is stateless (`src/offline`, merged in PR #41): every frame
evaluates all 10^12 particles from (seed, index, time) and adds each one into a
64-bit integer grid with atomics. Memory is not the limit any more. Time is.
The target card is Noah's RTX 2070 (8 GB).

The first real numbers landed in PR #44 (`docs/perf.md`): the stateful
`PerfEngine` at 1920 x 1080, brute force, runs about 11.6 billion particles
per second (85 ps each, every particle simulated and splatted). Its author
suspects the framebuffer atomics (an 8.3 MB grid, twice the 4 MB L2) for the
time that memory traffic does not explain.

The stateless offline renderer has since been run in Chrome on the same card
(`/src/offline/web/`; the Node runner cannot run there, because Windows
Application Control blocks `dawn.node`): about **3.3 billion particles per
second** with point splats on a frame-filling sheet, so about **5 minutes per
1T 4K frame**. That figure is in `docs/story/how-it-was-built.md` but not yet
in `docs/perf.md`, and it predates write combining (PR #65). It moves no
particle data, but does more math per particle (a 64-bit Feistel key of about
27 integer ops, plus the law) and writes into a 33 MB grid per word. Two 1T
kernels exist on main: `src/offline/core/shaders.ts` (used by `src/record` and
`src/proof`) and `src/trillion/kernel.ts` (PR #50).

## Research conclusion

Everything follows from one division:

```
seconds per frame = 10^12 / R          (R = particles evaluated per second)
render hours      = frames * 10^12 / R / 3600
```

| R | one 1T frame | 10 s at 60 fps (600 frames, preset `trillion`) | 10 s at 30 fps |
| --- | --- | --- | --- |
| 3.3 G/s (measured, Chrome) | 303 s | 50.5 h | 25.3 h |
| 5 G/s | 200 s | 33.3 h | 16.7 h |
| 10 G/s | 100 s | 16.7 h | 8.3 h |
| 20 G/s | 50 s | 8.3 h | 4.2 h |

A 1T 4K *still* is about 5 minutes today; a 1T *clip* is a day or more. A
clip needs the per-frame time cut by an order of magnitude, which is what the
levers below are for. A proposal from the "Propose the fastest path to 1T on an
RTX 2070" thread ("Fastest honest path to 1T particles on an RTX 2070")
estimates 10 to 15 s per frame with stratified particle labels, register run
merging and a shared-memory tile. Unmeasured.

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
3. **Per-thread write combining.** Done in PR #65: each invocation keeps a
   running (pixel, weight) pair and calls `add64` only when the pixel changes.
   It pays where consecutive particles share a pixel (dense cores, the
   collapse), because ids are placed at random. Re-measure after it.
4. **Cheaper per-particle math.** Hoist anything that depends only on the
   plane out of the loop; skip the flux rounding draw when the weight is 1.
5. **Coherent ids** (bigger change, the biggest expected win): order ids so
   consecutive particles land near each other (stratified labels), then
   accumulate a tile in workgroup memory and flush once. Needs an owner.
6. **Shard** with `--shard i/n` if a second GPU becomes available.

## Steps

1. On Noah's machine (the "Run Strata on the real GPU" thread has it), in
   Chrome at `/src/offline/web/` (not the Node runner, which is blocked
   there): re-measure R after PR #65 for each law at 3840 x 2160. A
   frame-filling sheet measures the scattered (close-up) case.
2. Also time one real frame of the `trillion` preset near the start (wide
   shot) and one near the end (close-up). These two numbers bound the clip.
3. Fill the table above with measured values in `docs/perf.md` (new section
   "Offline stateless throughput") and in `src/offline/README.md`.
4. Pick clip length and fps from a render budget Noah can live with. Rule:
   `frames = budget_hours * 3600 * R / 10^12`. Ask Noah with a decision card
   (2 to 4 options, one recommended), for example 10 s at 30 fps versus 5 s at 60 fps.
5. If a clip is wanted, give lever 5 (coherent ids and a shared tile) an
   owner, calibrated with a four-mode bench (math only, random global atomics,
   run merge, run merge plus tile).

## Files to touch

- `docs/perf.md` (append a section), `src/offline/README.md` (numbers only)
- `src/offline/core/shaders.ts` for lever 5; coordinate with the offline
  renderer thread, which owns `src/offline`.

## Done when

- At least one measured R from the RTX 2070 is in `docs/perf.md`, with the
  adapter name, resolution, law, splat mode and date.
- Wide-shot and close-up frame times for 1T at 4K are recorded.
- A clip length and fps are chosen from those numbers, with the render time
  written next to them, and Noah has picked one on a decision card.
