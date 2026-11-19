# Brief: one rasterizer for the realtime app

Owner (2026-11-19): unowned. The cleanup threads own `src/render`,
`src/depth`, `src/passes`, `src/perf`, `src/challenge` and `src/gpu`, so agree
the plan with them before editing.

## Context

`src/main.ts` registers four rasterize passes and turns exactly one on
(`chooser("rasterize")`, `?raster=`, and the settings menu), because each one
clears the HDR target:

| pass | file | what only it has |
| --- | --- | --- |
| `atomic-raster` (default) | `src/perf/atomicRasterPass.ts` | compute speed, fixed-point counts, per-plane brightness |
| `points` | `src/passes/points.pass.ts` | the simplest path; blends into f16 |
| `depth-sprites` | `src/passes/sprites.pass.ts`, `src/depth/sprite-pass.ts` | fog, depth of field, size falloff |
| `density-splat` | `src/render/passes.ts`, `src/render/splat.ts` | sub-pixel bilinear splats |

Separately, three fused kernels live outside the app: `PerfEngine`
(`src/perf/engine.ts`, 8 bytes per particle, not wired into `src/main.ts`),
`ChallengeEngine` (`src/challenge`), and the offline `StatelessRenderer`.

## Research conclusion

The features exclude each other only because they live in different passes.
With more particles than pixels, the right core is one compute splat into an
integer grid, and every feature is an option of that kernel:

- sub-pixel: four bilinear weights instead of one add (already in `splat.ts`
  and in `src/offline/core/shaders.ts`);
- fog and size falloff: a per-particle weight, computed before the add;
- depth of field: jitter the projected position by a lens sample (PR #40
  added lens sampling for point renderers);
- flux weighting: weight by `min(1, (ref / depth)^2)`, as offline does.

Blending into `rgba16float` (points, sprites) saturates near 2048 adds per
pixel, so those passes should stay as debug fallbacks only. The fast 8-byte
`PerfEngine` is the app's missing high-count simulation path; the switch is
mostly choosing it in place of `Simulation` plus the rasterize pass
(`docs/perf.md`, "In the main app").

## Steps

1. Extend the atomic raster pass (or a new pass beside it) with options:
   `subpixel`, `fog`, `sizeFalloff`, `dof`. Port the math from
   `src/depth/depth.wgsl.ts` and `src/render/splat.ts`; do not blend.
2. Make it the only default rasterizer. Keep `?raster=points|sprites|splat`
   for comparison, and label them "debug" in the settings menu.
3. Map the depth settings (`?depth=1`) onto the new options so existing links
   keep working.
4. Decide `PerfEngine` in the app: either wire it behind `?engine=perf`
   (plane add/update/remove, brushes and brightness already match
   `PlaneHost`), or write in `docs/perf.md` that it stays bench-only and why.
5. Update the splat-mode table in `docs/render.md` and the rasterizer notes in
   `docs/depth.md`.

## Files to touch

- `src/perf/atomicRasterPass.ts` or a new `src/passes/unified-raster.pass.ts`
- `src/main.ts` (chooser defaults only; it changes often, rebase right before merging)
- `docs/render.md`, `docs/depth.md`, `docs/perf.md`

## Done when

- With the default rasterizer, fog, depth of field, size falloff and sub-pixel
  can be on at the same time.
- The default rasterizer never blends into `rgba16float`, so a dense core keeps
  counting past 2048 hits per pixel at 100M particles.
- `PerfEngine` is either selectable in the app or documented as bench-only.
- `npx tsc --noEmit` and `npm run build` pass.
