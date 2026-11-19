# Brief: accumulation and tone mapping at 10^5 hits per pixel

Owners (2026-11-19): the cleanup threads own `src/render` and `src/depth`;
the offline renderer owns `src/offline/core/develop.ts` and `grade.ts`.

## Context

At 1T and 4K the average pixel is hit 120,563 times and dense cores far more.
The app's shared HDR target is `rgba16float`. There are now two tone mappers
for integer counts: `CountToneMapper` (`src/render/counts.ts`, GPU, realtime
and previews) and the offline grade (`src/offline/core/grade.ts`, CPU, the film).

## Research conclusion

1. **Never accumulate counts in a half float.** f16 has an 11-bit significand,
   so an additive target stops counting near 2048 adds of weight one (more
   precisely near 2048 times the weight per add). Converting a finished count
   to f16 once is fine (0.05% steps); adding into it is not. The point-list
   and sprite rasterizers blend into `rgba16float`, so they saturate in dense
   cores. Compute paths are safe.
2. **Integer grids, sized for the worst pixel.** Realtime: u32 fixed point
   (`fixedScale` 256 gives 16.7M full hits per pixel). Offline: 64-bit lo/hi
   with carry, as `src/offline` does. The one-pixel collapse shot needs 64 bits
   (10^12 hits).
3. **Where grain goes away depends on the curve.** Shot noise is 1/sqrt(n) of
   the signal. With a *linear* curve and a pixel at full white, it drops below
   one 8-bit step (1/256) only at about 65,000 hits: the field guide's figure.
   With a *log* curve `L = log(1 + n/toe) / log(1 + white/toe)`, the noise in
   output units is about `1 / (sqrt(n) * ln(white/toe))`. For a 10,000:1 range
   that is below one step from roughly 800 hits. So dense regions look smooth
   long before 1T. **The visible gain of 1T over 1B is in the faint regions**
   (halos, tails, gaps between sheets: about 1 hit per pixel at 1B, about
   1,000 at 1T) **and in the deep zoom.** Exposure and toe must be set so those
   regions are on screen, not crushed to black.
4. **Exposure from the histogram of lit pixels**, percentiles in log2 space,
   empty pixels excluded. Both tone mappers already do this. For any sequence
   that compares counts (the ladder, the collapse) lock exposure instead; see
   [video-scale-ladder](video-scale-ladder.md).
5. **Dither, then encode.** Both paths dither 8-bit output. YouTube transcodes
   everything, so banding in the faint gradients is the open risk. A 10-bit
   upload may help; this is untested.

## Steps

1. Make the two tone mappers agree: same curve, same percentile defaults, same
   black and white point meaning. Write a test that feeds one synthetic count
   image (for example `src/render/demo/counts.ts`'s generator) to both and
   compares 8-bit output.
2. In the app, document which rasterizers saturate (points, sprites) in
   `docs/render.md`, and default to the compute rasterizer above a density
   threshold. See [unify-rasterizers](unify-rasterizers.md).
3. In the offline grade, add a "lock exposure" mode that takes a white point in
   particles per pixel and a toe, for the ladder and the collapse.
4. Pick default toe and range so that a 1B frame shows its faint regions as
   visible grain, and the 1T frame shows them smooth. Check on one still at
   each count.

## Files to touch

- `src/render/counts.ts`, `src/offline/core/grade.ts`, a shared test file
- `docs/render.md` (precision table already exists; add the curve note)

## Done when

- The same counts graded by both mappers differ by at most one 8-bit step.
- A locked-exposure mode exists in the offline grade.
- One still pair (1B and 1T, same frame, same exposure per particle) shows the
  faint-region difference, and the pair is saved to the project files.
