# Challenge mode

How many particles can this GPU run? Challenge mode starts small, ramps the
count up until the frame rate falls to the target, confirms the result over
several seconds and shows the count and the tier reached.

```
npm run dev
# standalone page          http://localhost:5173/src/challenge/
# from the main app        http://localhost:5173/?challenge
```

It is self-contained: its own kernels, its own page, no dependency on the
shared engine. Options and keys are listed at the top of `main.ts`.

## What counts

Tier 1 is 100M particles at 30+ fps on a 1920x1080 buffer. The readout only
says "TIER 1 REACHED" when all of this holds:

- **Simulated mode.** Every particle has 8 bytes of stored state (position and
  velocity) that is read, integrated and written back every frame.
- **Every particle, every frame.** No LOD, no skipped frames, no instancing,
  no culling of whole sheets. Each particle is also projected and splatted
  every frame. A particle outside the view is still simulated.
- **Sustained.** The count must pass three one-second windows in a row.
- **Honest frame rate.** Frames are counted between two moments at which the
  GPU had finished all submitted work, so a queue backlog cannot inflate it.
- **Counted on the GPU.** The kernels count the particles they actually process
  (one atomic add per workgroup) and the readout shows that count. A tier needs
  it to equal the reported count in every checked frame. A frame the browser
  dropped counts zero, which refuses the tier for the rest of the run.

Procedural mode (key `M`) is reported separately and never as a tier. Its
particles have no stored state: position is a closed-form function of id and
time. That is how counts in the billions become possible in realtime, and the
readout labels it as such.

Press `C` to copy the result as JSON (count, fps, resolution, adapter, GPU
time, GPU count and whether it matched). That JSON is the number to report.

## Measured so far

**No real GPU numbers yet.** This was written on a machine with no GPU and
checked on Chromium's software WebGPU (SwiftShader, 4 CPU cores), which runs
about 15M particles per second. That shows the code is correct, not how fast
it is. What was checked there:

- All shaders compile and run with no validation errors.
- With flat weights and the whole world in view, the accumulation buffer sums
  to exactly `count * units` in both modes, over several frames, across
  several slabs and a partly filled slab. So no particle is dropped, counted
  twice or lost to a race.
- Particles move and velocities change from frame to frame.
- The ramp logic converges to within 2 percent of a simulated device's limit
  and handles the memory ceiling and "cannot hold the target at all" cases.
- One preview frame of each mode looks right.

Not checked: presenting to a real canvas (the headless software GPU cannot),
the frame-graph adapter in `passes.ts` (type-checked only), and anything about
speed.

## Design

**8 bytes per particle.** Two `u32`: position as two u16 in fixed point over
the sheet (wraps for free, the sheet is a torus), velocity as two biased 16
bit values. All rounding is stochastic, so motion slower than one quantum per
frame is right on average instead of freezing.

**One touch per particle.** A single fused kernel unpacks, applies forces,
integrates, packs, projects and does one `atomicAdd` into a `u32`
accumulation buffer. State is updated in place. There are no draw calls, no
vertex buffers and no second pass over the particles.

**Slabs, not planes.** State lives in 128 MiB slabs (16.7M particles), which
fit WebGPU's default limits, so no special device limits are needed. Slabs are
allocated as the ramp climbs, and an out-of-memory allocation stops the ramp
cleanly and is reported as "limited by GPU memory". Sheets are interleaved
inside a slab (each workgroup of 256 ids belongs to one sheet), so the first n
particles are always spread evenly over all sheets and a frame is one dispatch
per slab, however many sheets there are.

**Projection as a homography.** A sheet is flat, so sheet coordinates map to
pixels with a 3x3 matrix per sheet, computed on the CPU. The kernel does 9
multiplies and one divide per particle.

**Brightness.** Each splat is weighted by 1 / distance^2, so a sheet keeps its
surface brightness at any range, and edge-on sheets glow. Weights are fixed
point and dithered, so a far particle with weight 0.3 adds one unit 30 percent
of the time. Units per particle shrink as the count grows so a pixel's `u32`
cannot wrap. The resolve uses a log curve to keep dense cores and faint haze
both visible.

**Forces (simulated mode).** Drag toward a time-dependent incompressible flow,
softened gravity toward up to four moving wells (attracting or repelling), and
a small random kick. Because particles have inertia they do not follow the
flow: they are thrown out of vortices and gather along strain lines, which is
where the filaments come from. Each sheet gets its own mix from its seed. No
neighbor search, no fields, no extra buffers.

**Stateless mode.** Position from `(id, time)`: either a uniform cloud folded
by nested compression waves (caustics), or orbits on nested ellipses (a
density-wave disc). Particle ids are hashed so that no two particles are
copies of each other.

## Relation to `src/perf`

`src/perf` (PerfEngine) arrived at the same core idea independently: 8 byte
particles, a fused kernel, atomic accumulation. The differences here are the
ramp and tier protocol, strict "no LOD" counting, slab interleaving (no
per-sheet particle limit, one dispatch per slab), the stateless mode, and
distance-weighted dithered splats. Two independent kernels are useful as a
cross-check: on a real GPU, compare this page with `src/perf/bench/?bench=1`.

## Using it elsewhere

```ts
import { ChallengeEngine, createChallengePasses } from "./challenge";

const engine = new ChallengeEngine({ device, width, height, planes });
await engine.setCount(100_000_000);

// own loop, or a deterministic offline render with a fixed dt:
engine.encode(encoder, { viewProj, time, dt, frame });
engine.resolveToCanvas(encoder, view, format);

// or as frame-graph passes on the shared HDR target:
graph.add(...createChallengePasses(engine));
```

Given the same seed, plane list, dt sequence and frame indices, a run is
repeatable, which is what video capture needs.

## Next

- Real numbers from a real GPU, then tune from them: workgroup size (`wg=`),
  slab size, whether a coarse spatial sort for framebuffer locality pays off.
- A 4 byte mode for flows that need no stored velocity.
- Density feedback (deposit a field per sheet in the same pass and let
  particles react to it) for true particle interaction at O(n).
