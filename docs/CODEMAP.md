# Code map

Where everything lives in Strata, for anyone (person or agent) about to change
it. Read this page first, then the doc of the area you touch. Each area keeps
its own section up to date.

## The project in one paragraph

A black void full of flat sheets ("planes"). Every sheet runs a 2D particle
rule (a "behavior") on the GPU, and particles are drawn as additive light, so
density reads as brightness. There are two ways particles exist:
**simulated** (position and velocity stored in GPU memory and stepped every
frame: the realtime app, the perf bench, challenge mode) and **stateless**
(position computed from a particle's key and the time, nothing stored: the
trillion particle offline renders). Everything is TypeScript on WebGPU, built
with Vite, no framework.

## Pages

`npm run dev` serves all of them. The first six also ship in the production
build (`vite.config.ts`).

| page | entry | what it is |
| --- | --- | --- |
| `/` | `src/main.ts` | the app: the realtime world |
| `/?challenge` or `/src/challenge/` | `src/challenge/main.ts` | challenge mode: ramp to the most particles that hold the frame rate |
| `/src/offline/web/` | `src/offline/web/main.ts` | offline renderer, up to 10^12 particles per frame, to MP4 |
| `/src/perf/bench/` | `src/perf/bench/main.ts` | perf engine bench (`?bench=1` sweep, `?selftest=1` GPU checks) |
| `/src/verify/` | `src/verify/main.ts` | shader verify harness (`npm run verify` runs it headless) |
| `/src/color-life/demo/` | `src/color-life/demo/demo.ts` | color life: color species attract and repel by a rolled rule matrix (particle life on the GPU, simulated) |
| `/src/behaviors/preview/` | `src/behaviors/preview/preview.ts` | one behavior on one sheet, with sliders |
| `/src/render/demo/` | `src/render/demo/demo.ts` | density render pipeline demo (also `counts.html`) |
| `/src/depth/demo/` | `src/depth/demo/demo.ts` | depth cues demo |
| `/src/interplane/demo/` | `src/interplane/demo/demo.ts` | particles crossing between sheets |
| `/src/capture/demo/` | `src/capture/demo/main.ts` | stills and video capture |
| `/src/trillion/demo/` | `src/trillion/demo/demo.ts` | trillion splat kernel demo |
| `/src/proof/web/` | `src/proof/web/` | trillion proof shots (count-up, loupe, dive, ...) |
| `/src/world/demo/` | `src/world/demo/index.html` | world layouts and streaming |
| `/src/ux/camera/demo/`, `/src/ux/experience/demo/`, `/src/ux/hud/demo/` | each folder | camera, first-run experience and HUD on their own |

## Folders

| folder | role | start reading at |
| --- | --- | --- |
| `src/core` | shared contracts (types every module builds against), frame graph, default particle budget | `contracts.ts` |
| `src/gpu` | the engine's GPU contract: device setup, buffer layouts, WGSL declarations, shader prelude, shared WGSL snippets | `shaderLib.ts` |
| `src/sim` | the engine's simulation: one 16-byte particle buffer and one compute dispatch per plane | `simulation.ts` |
| `src/passes` | render passes auto-registered into the app (`*.pass.ts`): points, depth sprites, tone map | `index.ts` |
| `src/behaviors` | particle rules (`*.behavior.ts`, auto-registered), authoring tools, preview page | `index.ts`, `core/` |
| `src/perf` | the 8-byte high-count engine (PerfEngine), the app's compute rasterizer pass, the adaptive budget | `engine.ts`, `docs/perf.md` |
| `src/challenge` | challenge mode: its own 8-byte engine, the ramp, tiers, stateless "proc" mode | `README.md` |
| `src/render` | density rendering: splatting, trails, bloom, tone mapping, integer counter tone mapping | `docs/render.md` |
| `src/depth` | depth cues: fog, depth of field, size falloff, parallax, depth sprites | `docs/depth.md` |
| `src/interplane` | particles leaving one sheet's edge and arriving on a neighbour | `docs/interplane.md` |
| `src/world` | sheet layouts, seeded generator, streaming sheets in and out around the camera | `docs/world.md` |
| `src/ux` | camera rig and input, first-run experience, HUD, dice roll | `docs/ux/` |
| `src/app` | the app shell: the small modules `src/main.ts` boots from (URL options, frame graph, scene, HUD entries, key ownership, frame loop) | `src/main.ts`, then the section below |
| `src/ui` | DOM panel registry (`*.panel.ts`, none yet) | `index.ts` |
| `src/capture` | PNG stills, MP4 recording, offline video of the realtime world | `docs/capture.md` |
| `src/stateless` | 64-bit particle keys and randomness for stateless particles | `README.md` |
| `src/color-life` | particle life with color species: rule matrix rolls, GPU grid sort for neighbors, colored additive render; standalone | `README.md` |
| `src/trillion` | trillion particle splat kernel: exact per-pixel counts, nothing stored | `index.ts` |
| `src/offline` | offline renderer (browser and Node): stateless particles into a 64-bit grid, frame by frame, to MP4 | `README.md` |
| `src/record` | launches a record-scale offline render from the app's Esc menu or `?record` | `index.ts` |
| `src/proof` | trillion proof shots built on the offline renderer | `README.md` |
| `src/verify` | shader verify harness: compile, lint, run and compare with a CPU reference | `README.md` |
| `src/math.ts` | column-major mat4 and quaternion helpers, `seededRandom` (mulberry32) | |
| `docs/` | one doc per area, plus `explainers/rendering.html` | `architecture.md` |

## Which particle engine is which

Several engines exist because they were built in parallel for different
goals. Pick by what you need, and read the overlap notes at the end before
adding another.

| engine | folder | particle state | how it draws | used by |
| --- | --- | --- | --- | --- |
| `Simulation` (the engine) | `src/sim`, `src/gpu` | 16 bytes: `pos: vec2f, vel: vec2f`, one buffer per plane | a rasterize pass reads the buffer: `atomic-raster` (default, `src/perf/atomicRasterPass.ts`), `points`, `density-splat`, `depth-sprites` | the app `/` |
| `PerfEngine` | `src/perf` | 8 bytes packed (below), 64 MB pages, one range per plane | fused kernel: simulate and `atomicAdd` in one pass, then a fullscreen resolve | bench page; not yet the app's simulation |
| `ChallengeEngine` | `src/challenge` | 8 bytes packed, a different velocity encoding (below), 128 MiB slabs | fused kernel with its own forces (not contract behaviors), `atomicAdd`, own resolve | `/?challenge` |
| stateless "proc" mode | `src/challenge` | none: position from `(id, time)` | same accumulation buffer as above | `/?challenge`, key `M` |
| `TrillionKernel` | `src/trillion` | none: stateless laws keyed by particle | exact hit counts per pixel (u32 hot counters folded into 64 bits), batched submits | trillion demo |
| offline renderer | `src/offline` (+ `src/record`, `src/proof`) | none: 64-bit keys from `src/stateless` | 64-bit integer accumulation grid, developed to 16-bit log PNG, encoded to MP4 | offline page, Node CLI, `?record` |
| behavior preview | `src/behaviors/preview` | 16 bytes, like the engine | point list | preview page |

Contract behaviors (`src/behaviors/*.behavior.ts`) run unchanged on
`Simulation` and `PerfEngine`, because both build their shader from the same
prelude (`behaviorPreludeWGSL` in `src/gpu/shaderLib.ts`). Challenge mode and
the stateless renderers have their own motion code.

## GPU data layouts

**Engine uniforms and the 16-byte particle**: the header of
`src/gpu/shaderLib.ts` lists every byte offset of `Particle`, `Globals`
(208 bytes, group 0) and `Plane` (112 bytes, group 1), next to the WGSL
declarations and offset constants. Change them there and nowhere else.

**8-byte packed particles** (two u32 words):

| engine | word 0: position | word 1: velocity |
| --- | --- | --- |
| `PerfEngine` | x:u16, y:u16 unorm over [-1, 1), wraps | x:i16, y:i16 snorm, 32767 = `velMax` (default 4) |
| `ChallengeEngine` | the same | x:u16, y:u16 biased by 32768, `V_MAX` = 4 at full scale |

Both quantize with stochastic rounding so slow motion survives on average.
CPU twins for the perf format are in `src/perf/packing.ts`.

**Accumulation buffers** (one counter per pixel, row major, top row first):

| buffer | type | one full-brightness hit adds |
| --- | --- | --- |
| atomic raster pass, `PerfEngine` | `array<atomic<u32>>` | `LIGHT_ONE` = 256 (`src/perf/shaders.ts`) |
| `ChallengeEngine` | `array<atomic<u32>>` | `unitsForCount(count)` units, scaled by 1 / distance^2 when `attenuate` is on, dithered |
| `TrillionKernel` | u32 hot counters folded into 64-bit counters (lo, hi words) | exactly 1 |
| offline renderer | 64-bit counters (two u32 words) | exactly 1 |

## Shared code: reuse it instead of copying

| need | use |
| --- | --- |
| a type every module agrees on (Behavior, PlaneDesc, Pass, Brush, ...) | `src/core/contracts.ts` |
| the engine's Globals, Plane or Particle in WGSL, or their byte offsets | `src/gpu/shaderLib.ts` |
| pcg hash, `u01`, fullscreen triangle, basic tone curve in WGSL | `src/gpu/wgsl.ts` |
| a 2D dispatch that covers any count | `dispatchSize` and `DISPATCH_ROW_PARTICLES` in `src/gpu/shaderLib.ts` |
| matrices, quaternions, a seeded CPU random | `src/math.ts` |
| keys and randomness for stateless particles | `src/stateless/rng.ts` |
| tone parameters, HDR format choice, render-side WGSL | `src/render/common.ts` |
| a compile check for a shader you generate | a `*.verify.ts` file next to it, see `src/verify/README.md` |

## Conventions

- **Add files instead of editing shared ones.** Behaviors, passes and panels
  are registered by filename: `src/behaviors/<id>.behavior.ts`,
  `src/passes/<name>.pass.ts`, `src/ui/<id>.panel.ts`. Contract changes go
  in their own small PR.
- **Coordinates.** A sheet is [-1, 1]^2 in its own space; the plane's model
  matrix scales it by its half size. Matrices are column-major with WebGPU
  clip space (depth 0..1).
- **Dispatch.** Workgroups of 256, 2D dispatches with `DISPATCH_ROW_PARTICLES`
  (65,536) particles per row, index `i = id.x + id.y * 65536`, guarded by the
  count. That reaches the u32 limit of 4.29 billion particles.
- **Light is additive and order independent.** Rasterizers add fixed-point
  integers with `atomicAdd` or add floats with blending; nothing sorts.
- **Checks.** `npx tsc --noEmit`, `npm run build`, and `npm run verify`
  (about a second, compiles and lints every registered shader). Speed is only
  measured on a real GPU (`docs/perf.md` has RTX 2070 numbers).
- **Git.** Readable branch names (`feat/...`, `fix/...`, `refactor/...`,
  `docs/...`), one small PR per change, rebased on `main` before merging.

## Known overlaps

Worth knowing before adding a fourth of anything:

- **Two 8-byte engines.** `PerfEngine` runs contract behaviors with culling
  and LOD; `ChallengeEngine` has its own forces, strict no-LOD counting, slab
  interleaving and the stateless mode. Same position packing, different
  velocity packing. They are kept apart on purpose for now and serve as a
  cross-check (`src/challenge/README.md`, "Relation to src/perf").
- **Several atomic accumulators.** Perf fused kernel, the atomic raster pass,
  challenge, trillion and offline each project and `atomicAdd` with their own
  projection and weighting. The resolve and tone mapping of integer counters
  is converging on `CountToneMapper` in `src/render/counts.ts`.
- **WGSL copies.** The pcg hash and the fullscreen triangle used to be pasted
  into many shaders; new code takes them from `src/gpu/wgsl.ts`, and the old
  copies are being switched over area by area.

<!-- Sections below: one per area, kept by the people working in it. -->

## Engine core: contracts, GPU, simulation

_Details to come with the GPU and perf cleanup._

## The perf path

_Details to come with the GPU and perf cleanup. Meanwhile see `docs/perf.md`._

## Behaviors

_Details to come with the GPU and perf cleanup. Meanwhile see
`docs/behaviors.md` and `docs/behavior-library.md`._

## Rendering, depth and the 1T path

_To be written by the rendering cleanup: rasterizers, tone mappers, HDR and
counter buffers with their formats, the offline pipeline._

## App shell, UX, world, interplane and capture

### Boot: `src/main.ts` and `src/app/`

`src/main.ts` is the boot sequence and nothing else; read it top to bottom.
Each step is a small module in `src/app/`:

| file | owns |
| --- | --- |
| `options.ts` | every URL option, parsed once into `AppOptions`; its header is the one table of `?` flags, including those other modules read |
| `graph.ts` | the frame graph: `Simulation` plus every pass the app draws with, registered in one list; the rasterizer choice (`RASTERIZERS`: URL name, pass name, menu label); plane crossings |
| `budget.ts` | which `ParticleBudget` runs: full (`src/core/budget.ts`) or adaptive (`src/perf/budget.ts`), and the target fps |
| `scene.ts` | the current `Scene`, `loadScene` / `getScene`, the particle total, the generated layout (`buildScene`) |
| `context.ts` | the `AppContext` handed to UI code; each member forwards to its owner |
| `hud.ts` | mounts the HUD and the color themes, then adds the app's menu entries, the "total" stat and the app keys |
| `keys.ts` | `KEYS`: every key, its owner and its label, plus the router that gives the camera every key nobody else owns |
| `intro.ts` | runs the first-run opening on the app's camera and budget |
| `loop.ts` | the frame loop, the fps meter and the hooks features plug into |

Boot order, and where it matters:

1. URL options, then the GPU (or the no-WebGPU fallback, `src/ux/experience/fallback.ts`).
2. Frame graph, budget, key router, camera and its input, the parallax view, the scene host (loads the opening scene).
3. `AppContext`, the streamed world (`?world`), panels, `window.strata` for the console.
4. HUD, then pointer brushes, then the intro. Brushes must come after the HUD:
   while a pointer is held they stop its moves from propagating, and the
   HUD's idle timer listens for those moves on the same window listener phase.
5. Frame loop and hooks, capture, record, `loop.start()`.

HUD menu entries and keys sheet rows appear in registration order, so new
entries go at the end of their group.

### One frame (`src/app/loop.ts`)

resize, `beforeCamera` hooks (the intro steers the camera and returns an
exposure), camera update, `afterCamera` hooks (world streaming), Globals
(view, time, brightness x exposure, pointer brushes), budget, `afterBudget`
hooks (the intro thins counts), apply counts and run the graph, `afterFrame`
hooks (HUD).

Capture calls `renderFrame(dt)` itself for stills and offline video. While
`loop.offline` is true (capture or the record job has the GPU) the realtime
tick only measures fps. The frame is drawn through `view`, the parallax
wrapper from `src/depth`; `camera` (the `EngineCamera` from `src/ux/camera`)
is what input, scenes, the intro and the world move.

### Recipes

- **Esc menu setting**: a `hud.registerParam` in `registerMenu` in
  `src/app/hud.ts`, at the end of its group. A feature that owns its settings
  registers them in its own mount function instead, as capture does.
- **Key**: a row in `KEYS` (`src/app/keys.ts`), registered from that row with
  `hud.registerShortcut(shortcut(KEYS.x, run))`. The camera stops seeing it
  automatically.
- **Per-frame step**: push a `FrameHook` in `src/main.ts`. Edit the loop only
  when the step needs data the hooks do not get.
- **Pass**: a `src/passes/<name>.pass.ts` file is picked up by name; any other
  pass goes in the list in `src/app/graph.ts`.
- **URL option**: a field in `AppOptions` and a line in the table at the top of
  `src/app/options.ts`.

### `src/ux`

| folder | what | used by |
| --- | --- | --- |
| `ux/camera` | the one camera: `CameraRig` (flights, focus, idle drift, picking), `EngineCamera` (the `CameraController` contract around it), `attachCameraInput` (mouse, touch, keys) | `src/main.ts` |
| `ux/hud` | the HUD (`index.js`, plain JS typed by `index.d.ts`): dice, stats line, Esc menu, keys sheet, status line, jobs. `wire.ts` connects it to an `AppContext`: dice rolls, particle and brightness sliders, behavior params, the `#r=` share link | `src/app/hud.ts` |
| `ux/behavior-ui` | `rollScene` (a seeded new scene) and `startRoll` (glides the live planes into it) | `ux/hud/wire.ts` |
| `ux/theme` | color themes: a gradient map applied as one SVG filter on the canvas after the tone map, no per-particle cost; T cycles, `?theme=` shares | `src/app/hud.ts` |
| `ux/experience` | the first-run experience. The app uses `intro-runner.ts` (through `src/app/intro.ts`), `engine-brushes.ts` (pointer forces), `capability.ts` and `fallback.ts` (no WebGPU). `createExperience` (`index.ts`) and `hints.ts` drive only the standalone demo, and `camera-rig.ts` is a thin front for `ux/camera` kept for that API | parts, from `src/main.ts` |

Camera self test: `npx esbuild src/ux/camera/selftest.ts --bundle --format=esm | node --input-type=module`.

### `src/world`, `src/interplane`, `src/capture`

- **World** (`docs/world.md`): `startStreamingWorld(app, options)` streams an
  endless seeded world through `AppContext.addPlane` and `removePlane` around
  the camera, ticked by an `afterCamera` hook. Loading any other scene clears
  the streamed planes, and streaming carries on around the camera. Tests:
  `node src/world/test/run.mjs`.
- **Interplane** (`docs/interplane.md`): `createInterplane()` returns a compute
  pass and a draw pass; `src/app/graph.ts` registers them after the
  rasterizers. Off with `?interplane=0` or the "plane crossings" setting.
- **Capture** (`docs/capture.md`): `mountCapture(host)` in `src/capture/app.ts`
  adds P and V and the "capture" menu section, and reaches the app only
  through `CaptureHost` (add a pass, render one frame, go offline, fix the
  resolution). The record job (`src/record`) is separate: it renders
  stateless particles with `src/offline` and borrows only the HUD and the
  offline flag.
