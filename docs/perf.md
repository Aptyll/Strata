# Performance path: tens of millions of particles

Everything here lives in `src/perf/` and is self-contained. It has two uses:

1. **`PerfEngine`**: a complete high-count simulation and renderer with its own
   compact storage. This is the path for the particle-count challenge.
2. **Adapters for the shared engine** (`src/core/contracts.ts`): a compute
   rasterizer `Pass` and a `ParticleBudget` that work on the standard 16-byte
   particle buffers with no other changes.

## Try it

```
npm run dev
# open http://localhost:5173/src/perf/bench/
```

| URL | What it does |
| --- | --- |
| `?n=50M&planes=64` | Live view. Drag to orbit, wheel to zoom, `[` `]` exposure. |
| `?bench=1` | Automated sweep from 1M to 100M, with and without culling and LOD. Prints ms per frame. |
| `?selftest=1` | 23 correctness checks on the real GPU device. |

More switches (`cull`, `lod`, `hidden`, `bilinear`, `density`, `sim`, `res`,
`offscreen`, `timer`, `counts`, `batch`) are listed at the top of
`src/perf/bench/main.ts`.

The sweep measures throughput without vsync: it submits a batch of frames back
to back and waits for the GPU to finish them, so the number is real headroom
and not a capped 60 fps.

## Measured so far

**No real GPU numbers yet.** The development machine for this work has no GPU,
so everything was run on Chromium's software WebGPU (SwiftShader, 4 CPU cores).
That proves correctness, not speed:

- Self test: 23 of 23 pass.
- 50M particles in 64 planes allocate (7 pages, 448 MB), simulate and render
  with no validation errors.
- Software throughput is about 18M particles per second, which says nothing
  about a real GPU.

Please run `?bench=1` on real hardware and paste the table here. That is the
number this document is missing.

## Design

### 8 bytes per particle

```
word 0  position  x:u16 | y:u16 << 16   unorm over the plane's [0, 1) square
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
shader uses dithered rounding (a per-particle, per-frame hash decides whether
to round up), so slow drift is correct on average.

### Paged storage

Default WebGPU limits allow 256 MB per buffer and 128 MB per storage binding.
`ParticlePool` keeps particles in 64 MB pages (8.4M particles) and gives each
plane one contiguous range in one page. It works on default limits and scales
by adding pages. A single plane is limited to one page.

Particles are seeded by a compute shader, so nothing is ever uploaded from the
CPU. Seeding 50M particles is one dispatch per plane.

### One pass: simulate and rasterize together

Each active plane is one compute dispatch. Per particle the shader unpacks,
integrates, packs, projects, and does `atomicAdd` into a `u32` framebuffer.
Simulation and drawing share one read of the particle data. Updates are in
place (no ping-pong buffers), which is safe because behaviors read fields, not
other particles.

A fullscreen triangle then resolves the framebuffer with an exponential tone
curve. There are no vertex buffers and no point draw calls. Additive counting
is order independent, so no depth or sorting is needed.

Per-plane data (matrix, params, counts, flags) sits in one uniform buffer
addressed with dynamic offsets: one `writeBuffer` and one bind group per page.

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
import { PerfEngine, requestPerfDevice, mat4PlaneModel } from './perf';

const device = await requestPerfDevice();          // or any GPUDevice
const engine = new PerfEngine(device, { format }); // format of the target views
engine.resize(canvas.width, canvas.height);
engine.addPlane({ count: 1_000_000, model, behavior: 'orbit' });

engine.frame({ viewProj, dt, time, target: context.getCurrentTexture().createView() });
```

`frame()` returns stats (visible planes, drawn and simulated particles, GPU
pass times when `timestamp-query` is available). The target can be any texture
view, which is what offline capture needs.

Custom behaviors are WGSL bodies returning an acceleration, passed in
`options.behaviors`. See `BUILTIN_BEHAVIORS` in `src/perf/shaders.ts` for five
examples (flow, orbit, vortex, wave, attractors).

## Using it from the shared engine

Both adapters build against `src/core/contracts.ts` and add no shared edits.

```ts
import { createAtomicRasterPass, PerfBudget } from './perf';

passes.push(createAtomicRasterPass(gpu));   // replaces a point-list rasterize pass
const budget = new PerfBudget({ width, height });
```

- `createAtomicRasterPass(gpu)` is a `rasterize` stage `Pass`. It reads the
  standard f32 particle buffers through each plane's `simBindGroup`, counts
  hits per pixel in a compute shader, and adds `count * globals.brightness` to
  the HDR target. It was tested against a stand-in `GpuContext` built from
  `docs/architecture.md`, not against the real core engine, which had not
  landed when this was written. It assumes the globals layout is visible to
  compute and fragment stages, and the plane uniform layout in that document.
- `PerfBudget` implements `ParticleBudget`: a density cap per plane from
  `screenCoverage`, zero for culled planes, and a global governor that backs
  off when fps drops below target and recovers slowly. Note that the shared
  renderer does not brighten thinned planes, so a throttled plane gets dimmer.
  `PerfEngine` does compensate.

## Not done yet

- **Real GPU measurements.** See above.
- **Sub-plane culling.** A very large plane seen up close still processes all of
  its particles and rejects most per particle. Fix: keep particles binned into
  tiles and cull tiles.
- **Cache-friendly rasterization.** Particles are in random order (needed for
  prefix LOD), so framebuffer writes are scattered. A coarse spatial sort would
  trade that for locality. Worth testing on real hardware first.
- **4 bytes per particle.** Behaviors whose velocity is a pure function of
  position do not need stored velocity. That would halve memory again.
- **Freeing planes.** `ParticlePool` is a bump allocator, ranges are not
  recycled. Needed for plane streaming.
- **Particle interaction.** Behaviors here are field based. Neighbor
  interaction needs a density grid per plane, built in the same pass.
