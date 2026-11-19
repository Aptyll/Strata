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
A frame in progress is checkpointed every 5 minutes.

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

Presets: `smoke`, `preview`, `billion`, `ten_billion`, `trillion`. Any field can
be overridden, for example `--preset trillion --seconds 5 --fps 30`. Run the
command with no arguments for the full list of options.

Run `bench` first. It prints how long one trillion-particle frame takes on the
machine, and from that how long a clip will take. Pick the clip length to fit.

## Running it (browser)

`npm run dev` at the repo root, then open
`http://localhost:5173/src/offline/web/`. Pick a preset, **choose folder**
(Chrome or Edge: frames go to disk and a render resumes after a reload), then
**render**, and **export mp4** when the frames are done. Export encodes in the
browser with WebCodecs through `src/capture`, so it needs no ffmpeg.

Use the Node runner for renders that take hours. A browser tab can be
throttled in the background, and browsers reset the GPU if one submission runs
too long, so the page keeps batches short (about 120 ms) at some cost in speed.

## Checks

```sh
npx tsx node/test.mjs
```

Quick self-checks on whatever adapter is available: every particle is counted
exactly once, results do not depend on batch size, 64-bit carries are exact,
the shader agrees with a double-precision CPU reference, and a checkpointed
frame resumes to the identical result.

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
node/             runner for Node (Dawn + ffmpeg) and the self-checks
web/              browser page (WebGPU + WebCodecs)
```

`core/` has no dependency on Node or the DOM. It takes a `GPUDevice` from
anywhere.
