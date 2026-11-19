# Performance path: tens of millions of particles

Everything here lives in `src/perf/`. It plugs into the shared engine in two ways:

1. **`PerfEngine`**: a complete simulation and renderer for very high counts.
   It takes the shared `PlaneDesc` and `Behavior` types unchanged, so every
   behavior in `src/behaviors/` and every scene runs on it as is. Particles are
   8 bytes instead of 16. This is the path for the particle-count challenge.
2. **Drop-in parts for the main app**: the compute rasterizer pass (the app's
   default rasterizer) and a `ParticleBudget` (its "hold frame rate" option).

## Try it

```
npm run dev
# open http://localhost:5173/src/perf/bench/
```

| URL | What it does |
| --- | --- |
| `?n=50M&planes=64` | Live view of the real behaviors on a scatter layout. Drag to orbit, wheel to zoom, `[` `]` brightness. |
| `?bench=1` | Automated sweep from 1M to 100M, with and without culling and LOD. Prints ms per frame. |
| `?selftest=1` | 27 correctness checks on the real GPU device, including every registered behavior. |

More switches (`behaviors`, `seed`, `brightness`, `cull`, `lod`, `hidden`, `bilinear`, `density`, `sim`, `res`,
`offscreen`, `timer`, `counts`, `batch`) are listed at the top of
`src/perf/bench/main.ts`.

The sweep measures throughput without vsync: it submits a batch of frames back
to back and waits for the GPU to finish them, so the number is real headroom
and not a capped 60 fps.

## Measured so far

RTX 2070 (8 GB, 448 GB/s), 1920x1080, `?bench=1`, ms per frame without vsync,
measured on 2026-11-19. Self test 25 of 25 on the same device.

| particles | cull+lod | brute |
| ---: | ---: | ---: |
| 1M | 0.65 | 0.57 |
| 10M | 1.37 | 1.40 |
| 50M | 3.02 | 4.73 |
| 100M | 4.39 | 8.99 |
| 200M | 6.92 | 17.33 |
| 400M | 11.39 | 34.92 |
| 800M | 18.53 | 68.25 |

Adapter: 2 GiB storage bindings, subgroups (32), shader-f16, timestamp-query.
800M particles (6.4 GB) allocate fine.

What the numbers say:

- **Brute force is linear** at about 85 ps per particle (11.6B particles per
  second), with every particle simulated and splatted every frame. 60 fps
  holds up to about 190M.
- **Particle traffic is only 41% of peak bandwidth.** 16 bytes per particle
  (read and write 8) at 11.6B per second is about 185 GB/s of 448. The rest of
  the time is not explained yet. My guess, not measured: the random
  `atomicAdd` into the 8.3 MB framebuffer, which is twice the 2070's 4 MB L2,
  so most atomics go to memory. `draw=0` and `sim=0` split the two costs.
- **With culling and LOD, memory is the cap, not speed.** From 400M to 800M
  each extra particle costs about 18 ps, which is the off-screen and thinned
  particles still being simulated at their reduced rate. 800M runs at 54 fps,
  and the 8 GB card holds about 900M at 8 bytes. Past that, more particles
  need fewer bytes each (see "4 bytes per particle" below).

To profile: `?bench=1&modes=brute&counts=200M` with `draw=0`, then `sim=0`,
then `res=640x360` (a framebuffer that fits in L2).

## Design

### 8 bytes per particle

```
word 0  position  x:u16 | y:u16 << 16   unorm over the sheet's [-1, 1) square
word 1  velocity  x:i16 | y:i16 << 16   snorm, scaled by the plane's velMax
```

Half the size of `vec2f + vec2f`. At this scale the frame is limited by memory
bandwidth, so bytes per particle is the main lever: 50M particles are 400 MB
instead of 800 MB.

Fixed point was chosen over f16 on purpose. A plane is a bounded square, so u16
gives uniform resolution of 1/65536 of the plane everywhere, while f16 loses
precision away from the origin. u16 addition also wraps for free, so planes are
toroidal with no branch.

Motion smaller than one quantum per step would be lost by plain rounding. The
shader rounds up with probability equal to the fractional part, so slow drift
is correct on average and particles at rest stay exactly at rest. The self
test checks a drift of half a quantum per frame.

Velocity is clamped to `velMax` (default 4 sheet units per second, settable
per behavior in the engine options).

### Paged storage

Default WebGPU limits allow 256 MB per buffer and 128 MB per storage binding.
`ParticlePool` keeps particles in 64 MB pages (8.4M particles) and gives each
plane one contiguous range in one page. It works on default limits and scales
by adding pages. A single plane is limited to one page. Removed planes return
their range to a free list, so a streaming world does not grow.

Planes whose behavior has no `init()` are seeded by a compute shader (uniform,
at rest, the same default as the core engine), so nothing is uploaded from the
CPU. Behaviors with `init()` run it on the CPU and the result is packed and
uploaded in chunks.

### Behaviors run unchanged

The compute shader starts with the core engine's own behavior prelude
(`behaviorPreludeWGSL` in `src/gpu/shaderLib.ts`): same helpers (`rand`,
`noise2`, `wrap`, `respawn`, ...), same `globals` and `plane` uniforms, bound
to this path's bind group and without the engine's f32 particle array. The
entry point unpacks a particle to the standard `Particle { pos, vel }`, calls
`simulateParticle` (the behavior's `update` plus pointer brushes, exactly as
the core engine's entry point does), and packs the result.
`src/verify/cases/shaders.verify.ts` compiles this shader for every
registered behavior (`npm run verify`).

### One pass: simulate and rasterize together

Each active plane is one compute dispatch. Per particle the shader unpacks,
runs the behavior, packs, projects, and does `atomicAdd` into a `u32` framebuffer.
Simulation and drawing share one read of the particle data. Updates are in
place (no ping-pong buffers), which is safe because behaviors read fields, not
other particles.

A fullscreen triangle then resolves the framebuffer, either with the same tone
curve as the core tonemap pass or as linear light added to an HDR target
(`output: 'hdr'`). There are no vertex buffers and no point draw calls. Additive counting
is order independent, so no depth or sorting is needed.

Per-plane data sits in one uniform buffer addressed with dynamic offsets: one
`writeBuffer` per frame, one bind group per page, one pipeline per behavior.

### Culling

- **Per plane, CPU**: the four corners are tested against the frustum. A culled
  plane issues no dispatch at all.
- **Per particle, GPU**: clip test before the atomic write.

### LOD

- **Particle LOD**: particles are stored in random order, so the first k of a
  plane are an unbiased sample. A plane draws only enough to reach a target
  density per projected pixel (default 4), and each particle is brightened by
  `count / k` so the plane keeps the same total light. The self test checks
  this is exact.
- **Rate LOD**: planes at reduced detail simulate every 2nd or 4th frame, and
  culled planes every 8th, each with the accumulated dt. Planes are staggered so
  they do not all step on the same frame.
- `simulateHidden` (default on) decides whether particles that LOD is not
  drawing are still simulated. Off is cheaper but stale particles can pop when a
  plane comes close, for behaviors whose field changes over time.

## API

```ts
import { getBehavior } from './behaviors';
import { requestGpuDevice } from './gpu/context';
import { PerfEngine } from './perf';

const device = await requestGpuDevice({ timestamps: true }); // or any GPUDevice
const engine = new PerfEngine(device, { format }); // format of the target views
engine.resize(canvas.width, canvas.height);
engine.brightness = scene.render.brightness;

engine.setPlanes(scene.planes, getBehavior);       // a whole Scene
const id = engine.addPlane(desc, behavior);        // or one plane at a time
engine.updatePlane(id, nextDesc);                  // transform or params changed
engine.removePlane(id);                            // streaming

engine.frame({ viewProj, dt, time, target: context.getCurrentTexture().createView() });
```

`frame()` returns stats (visible planes, drawn and simulated particles, GPU
pass times when `timestamp-query` is available). The target can be any texture
view, which is what offline capture needs. `encode(encoder, params)` does the
same into a caller-owned encoder, for frame graphs.

## In the main app

- **Compute rasterizer.** `createAtomicRasterPass` is the app's default
  rasterizer (`?raster=points` switches back to point lists). It reads the
  standard f32 particle buffers through each plane's `simBindGroup` and adds
  light per pixel in fixed point, honouring per-plane brightness.
- **`PerfBudget`** implements `ParticleBudget` and is the app's "hold frame
  rate" option (`?adaptive=1`): a density cap per plane from `screenCoverage`,
  zero for culled planes, and a global governor that steps twice a second:
  it cuts by up to 20% when fps is below target and grows about 10% a second
  while it holds. It steps on a clock, not per frame, because the fps it reads
  is a 250 ms average (stepping per frame compounded one stale reading into a
  collapse). Note that the shared renderer does not
  brighten thinned planes, so a throttled plane gets dimmer. `PerfEngine` does
  compensate.
- **`PerfEngine` as the main simulation** is not wired into `src/main.ts` yet.
  It has the same plane operations as `PlaneHost` (add, update, remove), takes
  the same brushes (`engine.brushes`) and per-plane brightness, and can add
  into the HDR target (`output: 'hdr'`), so the switch is mostly choosing it in
  place of `Simulation` plus the rasterize pass. Until then it runs on the
  benchmark page.

## Decisions: one rasterizer, one engine, one 1T kernel (2026-11-19)

From [docs/briefs/unify-rasterizers.md](briefs/unify-rasterizers.md):

- **Default rasterizer.** `atomic-raster` (compute, fixed-point integer adds,
  no f16 blending) is the app's one default rasterizer. `points`,
  `density-splat` and `depth-sprites` stay selectable with `?raster=` and are
  labelled "debug" in the settings menu, because the two blending ones
  saturate near 2048 hits per pixel in `rgba16float`. `sheet-hue`
  (`?raster=hue`, one hue per sheet, added afterwards in #91) is not labelled
  debug; it blends in f16 like `points`, so it has the same cap. Folding
  sub-pixel, fog, size falloff and depth of field into the compute pass as
  options is still open (brief step 1).
- **`PerfEngine` stays bench-only for now.** It is not wired into
  `src/main.ts`; the app runs `Simulation` plus the compute rasterizer. Wiring
  it behind `?engine=perf` is the next step for the app's high-count path,
  but it replaces the simulate and rasterize stages together and was not
  safe to land in the final minutes before the deadline.
- **The film's 1T kernel is `src/offline`** (`StatelessRenderer`,
  `src/offline/core/shaders.ts`). The record (`src/record`) and proof
  (`src/proof`) paths use it and every verified 1T still came from it.
  `src/trillion` is a faster kernel on the same shared 64-bit keys, with its
  own demo. Since #80 the offline renderer can also run it behind the same
  `StatelessRenderer` (`kernel: "trillion"`), for an A/B; the default is still
  `"offline"`.

## Not done yet

- **Sub-plane culling.** A very large plane seen up close still processes all of
  its particles and rejects most per particle. Fix: keep particles binned into
  tiles and cull tiles.
- **Cache-friendly rasterization.** Particles are in random order (needed for
  prefix LOD), so framebuffer writes are scattered. A coarse spatial sort would
  trade that for locality. Worth testing on real hardware first.
- **4 bytes per particle.** Behaviors whose velocity is a pure function of
  position do not need stored velocity. That would halve memory again, but it
  needs a flag on `Behavior`.
- **Depth passes.** `PerfEngine` writes light only. Depth-aware effects need a
  second atomic buffer (nearest depth per pixel).
- **Particle interaction.** Behaviors are field based. Neighbor
  interaction needs a density grid per plane, built in the same pass.
