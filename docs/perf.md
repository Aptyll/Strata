# Performance path: tens of millions of particles

Everything here lives in `src/perf/`. It plugs into the shared engine in two ways:

1. **`PerfEngine`**: a complete simulation and renderer for very high counts.
   It takes the shared `PlaneDesc` and `Behavior` types unchanged, so every
   behavior in `src/behaviors/` and every scene runs on it as is. Particles are
   8 bytes instead of 16. This is the path for the particle-count challenge.
2. **Drop-in parts for the main app**: a compute rasterizer pass (switch to it
   with `?raster=atomic` or the Rasterizer panel under Tab) and a
   `ParticleBudget`.

## Try it

```
npm run dev
# open http://localhost:5173/src/perf/bench/
```

| URL | What it does |
| --- | --- |
| `?n=50M&planes=64` | Live view of the real behaviors on a scatter layout. Drag to orbit, wheel to zoom, `[` `]` brightness. |
| `?bench=1` | Automated sweep from 1M to 100M, with and without culling and LOD. Prints ms per frame. |
| `?selftest=1` | 25 correctness checks on the real GPU device, including every registered behavior. |

More switches (`behaviors`, `seed`, `brightness`, `cull`, `lod`, `hidden`, `bilinear`, `density`, `sim`, `res`,
`offscreen`, `timer`, `counts`, `batch`) are listed at the top of
`src/perf/bench/main.ts`.

The sweep measures throughput without vsync: it submits a batch of frames back
to back and waits for the GPU to finish them, so the number is real headroom
and not a capped 60 fps.

## Measured so far

**No real GPU numbers yet.** The development machine for this work has no GPU,
so everything was run on Chromium's software WebGPU (SwiftShader, 4 CPU cores).
That proves correctness, not speed:

- Self test: 25 of 25 pass.
- 50M particles in 64 planes allocate (7 pages, 448 MB), simulate and render
  with no validation errors.
- Software throughput is about 18M particles per second, which says nothing
  about a real GPU.

Please run `?bench=1` on real hardware and paste the table here. That is the
number this document is missing.

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

The compute shader is derived from the core engine's own `buildSimShader`: same
prelude, same helpers (`rand`, `noise2`, `wrap`, `respawn`, ...), same
`globals` and `plane` uniforms. Only the particle storage and the entry point
are swapped. The entry point unpacks a particle to the standard
`Particle { pos, vel }`, calls the behavior's `update`, and packs the result.
If the core shader changes shape, the derivation fails loudly instead of
silently drifting.

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
import { PerfEngine, requestPerfDevice } from './perf';

const device = await requestPerfDevice();          // or any GPUDevice
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

- **Compute rasterizer.** `src/passes/raster-atomic.pass.ts` registers
  `createAtomicRasterPass` next to the `points` pass, disabled by default.
  `?raster=atomic` or the Rasterizer panel (Tab) switches between the two, so
  they can be compared on the same scene. It reads the standard f32 particle
  buffers through each plane's `simBindGroup` and adds
  `count * globals.brightness` to the HDR target.
- **`PerfBudget`** implements `ParticleBudget`: a density cap per plane from
  `screenCoverage`, zero for culled planes, and a global governor that backs
  off when fps drops below target and recovers slowly. The main app currently
  constructs `VisibleOnlyBudget` directly; swapping it is a one-line change in
  `src/main.ts`, which this work did not touch. Note that the shared renderer
  does not brighten thinned planes, so a throttled plane gets dimmer.
  `PerfEngine` does compensate.
- **`PerfEngine` as the main simulation** needs `src/main.ts` to choose it in
  place of `Simulation` and the rasterize pass. Until then it runs on the
  benchmark page.

## Not done yet

- **Real GPU measurements.** See above.
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
