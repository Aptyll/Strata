# Strata offline renderer

Renders clips that are far beyond realtime: up to one trillion particles per
frame, at 4K, to an MP4. Standalone. It does not need the realtime engine.

## How a trillion particles fit

Stored state cannot work at this scale. A trillion particles at 4 bytes each is
4 TB. So particles here are **stateless**: nothing is stored per particle. Each
frame, every particle's position is computed from scratch from its index, its
sheet's seed and the time, using a closed-form solution of a real equation of
motion (see `core/laws.ts`):

| law | what it solves |
| --- | --- |
| `kepler` | two-body orbits around a central mass, with spiral density waves |
| `vortex` | tracers in a steady circular shear flow winding a ruled sheet |
| `lissajous` | two-dimensional harmonic oscillators flowing along nested figures |

Jobs can also use the laws in `src/stateless/laws` by id: `veil`, `galaxy`,
`web` and `ribbons`. They run on both kernels, and the self-checks compare
each one against its double-precision mirror. The `alive_preview` and
`alive_trillion` presets (1T, 4K, 24 fps, 10 s) draw their sheets from them.
None of them has been timed on a real GPU yet.

This is honest work per particle (a hash, an orbit solve, a projection and an
atomic add), but it is not a time-stepped simulation with interactions. The
default label burned into the video says so.

## Pipeline

1. **Render** (GPU). For each frame, short compute dispatches evaluate ranges
   of particles and add them to a 64-bit integer accumulation grid with atomic
   adds. Integer adds commute, so a frame is bit-identical however it is
   batched, and an interrupted frame resumes exactly.
2. **Develop**. The grid is stored as a 16-bit log PNG per frame, about 0.07%
   precision over the full range, plus a small JSON of stats.
3. **Grade and encode** (CPU, fast). Automatic exposure, log tone curve,
   dither, label, then ffmpeg. The look can be changed and re-encoded without
   re-rendering.

Frames are independent. A render can be stopped (Ctrl+C) and continued by
running the same command again, or split across machines with `--shard i/n`.
A frame in progress is checkpointed every 5 minutes. A checkpoint carries the
time and batches spent so far, so `seconds` and `batches` in a frame's stats
cover the whole frame however often it was stopped, and `resumes` says how
often. Particles per second from those stats is then right for a continued
frame too.

## Running it (Node)

Needs Node 22 or newer and, for `encode`, ffmpeg on the PATH.

```sh
cd src/offline
npm install

npx tsx node/cli.mjs bench                       # particles per second on this GPU
npx tsx node/cli.mjs render --preset smoke       # a few seconds, proves the pipeline
npx tsx node/cli.mjs encode --out out/smoke      # writes out/smoke/smoke.mp4

npx tsx node/cli.mjs render --preset trillion    # 1e12 particles, 4K60, 10 s
npx tsx node/cli.mjs encode --out out/trillion
```

Presets: `smoke`, `preview`, `billion`, `ten_billion`, `trillion`, `alive_preview`,
`alive_trillion`, plus three
hand-placed hero compositions that default to a 1T 4K still (`core/compositions.ts`):
`heroA` (close, four sheets, one edge-on as a line of light), `heroB` (a
cathedral stack of floors), `heroC` (the camera inside a cloud of sheets).
They default to bilinear splats, since sub-pixel rings alias into moire with
point splats. Low-resolution previews at 30M particles are in `docs/record/`. Sheets past
2^32 particles are split into layers with the same transform and their own seeds. Any field can
be overridden, for example `--preset trillion --seconds 5 --fps 30`. Run the
command with no arguments for the full list of options.

Run `bench` first. It prints how long one trillion-particle frame takes on the
machine, and from that how long a clip will take. Pick the clip length to fit.

### The scale ladder

```sh
npx tsx node/cli.mjs ladder                      # frame 0 of "trillion" at 1M, 100M, 10B, 1T
npx tsx node/cli.mjs ladder --frame 300 --rungs 1M,1B,1T --out out/ladder-300
```

`ladder` renders one frame of a job at several particle counts. Each rung is
the same job with every sheet's `particleCount` scaled by the same factor
(`core/ladder.ts`): same sheets, seeds, laws, camera, time, splat and
weighting. Within a sheet the key is a bijection of the index, so the rungs
are nested: every particle of the 1M rung is also in the 1T rung.

Exposure is locked per particle by default. The largest rung picks its white
point (automatic, or `--white`), and each smaller rung uses that white scaled
by its count, so all rungs have the same mean brightness and differ only in
grain. `--exposure auto` exposes every rung on its own instead.

Output: `out/<job>-ladder/<rung>.png` (labeled stills), one resumable job
folder per rung, and `ladder.md` / `ladder.json` with each rung's GPU time,
particles per second, exact in-frame count, and what the largest rung's rate
implies for a full trillion-particle clip. Ctrl+C stops after the current
batch; the same command continues.

## Running it (browser)

`npm run dev` at the repo root, then open
`http://localhost:5173/src/offline/web/`. Pick a preset, **choose folder**
(Chrome or Edge: frames go to disk and a render resumes after a reload), then
**render**, and **export mp4** when the frames are done. Export encodes in the
browser with WebCodecs through `src/capture`, so it needs no ffmpeg.

Use the Node runner for renders that take hours. A browser tab can be
throttled in the background, and browsers reset the GPU if one submission runs
too long, so the page keeps batches short (about 120 ms) at some cost in speed.

## Two kernels

`--kernel offline` (default) is this folder's accumulate shader: returning
64-bit atomics, exact per-particle flux weights, and evaluated and in-frame
counts both counted on the GPU. `--kernel trillion` runs `src/trillion`'s
splat kernel behind the same renderer, checkpoints and grade: fire-and-forget
u32 atomics folded into u64, shared-memory tiles for small sheets. With it,
flux weighting becomes a per-sheet keep probability from the sheet center's
depth. Both kernels count `evaluated` and `landed` on the GPU. Camera motion
blur is in the offline kernel only; the
trillion kernel uses the mid-shutter camera. `bench --kernel both` compares them on one
machine. The page has the same choice.

## Checks

```sh
npx tsx node/test.mjs
```

Quick self-checks on whatever adapter is available: every particle is counted
exactly once, the in-frame tally matches the grid, results do not depend on
batch size, 64-bit carries are exact, the shader agrees with a
double-precision CPU reference, cancel works, and a checkpointed frame resumes
to the identical result.

## The tally

Every frame's stats JSON holds `evaluated` (always the whole world) and
`landed`, the exact number of particles whose position fell inside the frame,
counted on the GPU with one atomic per workgroup. `evaluated - landed` were
behind the camera or off frame. In `count` weighting with `point` splat, the
grid sum divided by 65536 equals `landed` exactly, which the checks verify.
In `flux` weighting it does not: a far particle's weight is randomly rounded
(unbiased) and is often 0, so `landed` counts it but it adds no light. Such a
frame is drawn correctly on average, not particle by particle; say "evaluated"
and "in frame", never "every particle drawn", for flux renders.

## Layout

```
core/job.ts       job format (plain JSON)
core/laws.ts      the motion laws, WGSL plus a TypeScript mirror
core/shaders.ts   the accumulate compute shader
core/renderer.ts  frame renderer: batching, pacing, readback
core/develop.ts   accumulation grid to 16-bit log frame
core/grade.ts     exposure, tone curve, dither, label
core/session.ts   resumable frame loop and grading loop
core/world.ts     world and camera shot generator, presets
core/camera.ts    keyframed camera path
core/ladder.ts    scale ladder: one frame at several particle counts, report
node/             runner for Node (Dawn + ffmpeg) and the self-checks
web/              browser page (WebGPU + WebCodecs)
```

`core/` has no dependency on Node or the DOM. It takes a `GPUDevice` from
anywhere.
