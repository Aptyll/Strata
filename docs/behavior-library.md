# Behavior library

Three behaviors built for the particle-count challenge. Each one updates a
particle from its own 16 bytes and the clock: no neighbor search, no fields, no
extra buffers, no CPU init. They are plain `Behavior` files, so the engine picks
them up by filename.

| id | file | what you see | cost per particle |
| --- | --- | --- | --- |
| `curl-flow` | `src/behaviors/curl-flow.behavior.ts` | smoke-like filaments that keep folding and drifting | 2 noise taps with analytic derivatives (8 integer hashes), no trig |
| `strange-attractor` | `src/behaviors/strange-attractor.behavior.ts` | a tumbling Lorenz, Aizawa, Thomas, Halvorsen or Dadras attractor | 4 evaluations of a small polynomial, 4 trig calls |
| `gravity-wells` | `src/behaviors/gravity-wells.behavior.ts` | a cold ring falling into moving wells, folding into sharp curtains | one inverse-square term and 2 trig calls per well (1 to 8 wells) |

## Why these look good in white on black

Density is the only thing a monochrome additive point can show, so each
behavior is built to concentrate particles into thin structures:

- **Curl flow.** An incompressible flow keeps a uniform cloud uniform, which
  reads as static. `inertia` makes particles lag the flow, so eddies fling them
  out and they collect on thin sheets between eddies. `gather` adds a small
  compressible pull for the same purpose. Set both to 0 to see the difference.
- **Strange attractor.** Chaotic systems contract volume, so any cloud collapses
  onto a thin folded surface and stays spread along it.
- **Gravity wells.** Particles restart at rest on a thin rim, so what falls in
  is a cold sheet. Cold sheets fold into caustics instead of blurring.

## Params

`curl-flow`

| param | default | range | effect |
| --- | --- | --- | --- |
| `scale` | 2.2 | 0.5 to 12 | eddies across the sheet |
| `speed` | 0.35 | 0 to 1.5 | flow speed |
| `evolve` | 0.12 | 0 to 1 | how fast the flow pattern changes |
| `inertia` | 0.6 | 0 to 3 | seconds a particle takes to catch up with the flow. Higher gives sharper filaments |
| `gather` | 0.12 | -0.5 to 1 | pull toward ridges (negative pushes away) |
| `detail` | 0.5 | 0 to 1 | weight of the second, finer noise layer |
| `jitter` | 0 | 0 to 0.05 | random walk, softens filaments |

`strange-attractor`

| param | default | range | effect |
| --- | --- | --- | --- |
| `kind` | 0 | 0 to 4 | 0 Lorenz, 1 Aizawa, 2 Thomas, 3 Halvorsen, 4 Dadras |
| `speed` | 1 | 0 to 4 | integration speed |
| `tumble` | 0.15 | -1 to 1 | rotation about the vertical axis, rad/s |
| `tilt` | 0.3 | -1.6 to 1.6 | fixed pitch, rad |
| `size` | 0.8 | 0.2 to 1.5 | size on the sheet |
| `reseed` | 0 | 0 to 2 | fraction of particles per second restarted near the centre |

`gravity-wells`

| param | default | range | effect |
| --- | --- | --- | --- |
| `wells` | 3 | 1 to 8 | number of wells. Cost grows with it |
| `strength` | 0.15 | 0.005 to 0.4 | pull of each well |
| `softening` | 0.05 | 0.01 to 0.3 | core radius. Particles inside about a third of it are swallowed |
| `swirl` | 0.4 | -1 to 1 | sideways part of the pull, makes spirals |
| `drag` | 0.4 | 0 to 2 | velocity loss per second |
| `orbit` | 0.5 | 0 to 1.5 | how fast the wells move |
| `renew` | 0 | 0 to 1 | fraction of particles per second sent back to the rim |

## Packed state

All three keep to the engine's 16-byte particle and work from the default
initial state (random positions at rest), so a plane of any size starts without
a CPU pass over its particles.

`strange-attractor` reuses the velocity slots because its points have three
coordinates: `pos` is the rotated x, y (already the on-sheet position),
`vel.x` is the rotated depth and `vel.y` is the tumble angle the point was last
written with. Each step un-rotates with the stored angle and re-rotates with
the current one, so a param change, a clamped frame or a respawn cannot
desynchronise it. Anything that reads `vel` as a velocity (for example speed
based brightness) should skip this behavior.

`gravity-wells` keeps particles inside the unit disc, not the full square.

## Preview page

`src/behaviors/preview/` is a one-sheet page that runs any
`src/behaviors/*.behavior.ts` file today, without the engine:

    npm run dev
    open http://localhost:5173/src/behaviors/preview/

Pick a behavior and a particle count, drag the sliders. Drag pans, the wheel
zooms, space pauses, R resets, H hides the panel. A link such as
`#b=strange-attractor&n=4000000&kind=3` opens a specific setup.

`preview/harness.ts` supplies the WGSL scope from `docs/architecture.md`
(`globals`, `plane`, `rand`, `noise2`, `outside`, `wrap`, `respawn`) with the
same uniform layouts. It is a stand-in: when the engine and the harness
disagree, the engine is right.

## Notes for the engine

- Helper functions are prefixed per behavior (`cf_`, `sa_`, `gw_`) so they
  cannot collide with engine helpers or with each other.
- `rand` is always called with a bare integer literal as salt (`rand(i, 2)`),
  which compiles whether the engine declares the salt as `u32` or `f32`.
- Only `rand` and `wrap` are used from the shared helpers.

## What was checked

Type check passes. All three were compiled and stepped on WebGPU (software
rasterizer, 600,000 particles, up to 1,200 frames) through the preview harness,
with no shader errors and no non-finite values, and the frames were inspected.
Not checked: the real engine prelude, real GPU performance, and the preview
page's on-screen canvas (the sandbox cannot present a WebGPU canvas, so frames
were read back from the float target instead).

## Left out on purpose

Boids, Particle Life, physarum, reaction-diffusion and self-gravitating
galaxies need particles to see each other or a shared field. The contract rules
that out for now in favour of particle count. They fit a per-plane field built
in the `interplane` stage; see `docs/behaviors.md`.
