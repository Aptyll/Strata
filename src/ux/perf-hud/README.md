# src/ux/perf-hud

Live frame, GPU and particle numbers in the Esc menu: a few facts in the
summary header and three blocks on the perf page. Everything shown is
measured, and every count says where it comes from.

```ts
mountPerfHud({ hud: ui.hud, gpu, graph, sim, budget, hooks: loop.hooks }); // src/main.ts
```

## What it shows

**Summary header** (next to the frame rate the menu already had):

| fact | what | source |
| --- | --- | --- |
| simulating | particles stepped this frame. Reads "paused" when nothing is being stepped (a record render has the GPU). | counts sent to the simulate pass |
| per second | simulating x frame rate | the two measured numbers |
| in frame | particles that landed inside the picture | the rasterizer's light buffer, summed on the GPU |
| gpu load | GPU time as a share of the frame. A display caps the frame rate, so 60 fps says nothing about headroom; this does. | GPU timestamps |
| 1% low | the slowest hundredth of recent frames, as a frame rate. One hitch a second still averages 58 fps; this shows it. | every frame's time |

**Perf page**, three blocks:

- **timing**: frame time graph (one point per frame, target as a dashed
  line), average, 1% low, worst frame, script time, GPU time and where it goes
  pass by pass, the governor's scale while "hold frame rate" is on, and an
  estimate of how many particles would fill a frame at the target.
- **particles**: simulated, in frame, per second, per pixel, lit pixels,
  densest pixel, stored (with bytes).
- **gpu**: the WebGPU adapter, the product name WebGL reports, whether pass
  timing is available, the largest sheet the GPU can hold, the canvas.

And one action, "fit particles to target fps": sets the particle count to the
estimate. It is an estimate from measured GPU time (it says "about"), it
never moves more than 8x in one press, and pressing again refines it.

## How a count is worded

The "in frame" count is the light in the compute rasterizer's buffer divided
by the light one particle adds. How far that can be trusted depends on how the
frame was drawn, and the page says which:

| drawn with | shown as | why |
| --- | --- | --- |
| compute rasterizer, every sheet at one brightness | `742K`, "counted on the gpu" | every particle added the same whole amount: exact |
| sub-pixel splats (`?subpixel=1`) | `~742K`, "gpu light sum" | each particle's light is rounded at random: right on average |
| sheets at different brightness (fading, streamed world) | `≥742K`, "gpu light sum" | no particle adds more than the brightest: a floor |
| depth cues (`?depth=1`) | `-`, "depth cues are on" | every particle adds its own amount: light is not a count |
| another rasterizer (points, sprites) | `-`, "no gpu count here" | it blends and keeps no per-pixel count |

## Files

| file | what |
| --- | --- |
| `index.ts` | `mountPerfHud`: the sampler. Two frame hooks, the pass timer, the tally, one `PerfSnapshot` five times a second while the menu is open, the fit action. |
| `model.ts` | `PerfSnapshot` (everything the menu shows, as numbers) and how numbers are worded |
| `menu.ts` | `attachPerfMenu`: registers the blocks and paints the header facts from a snapshot |
| `view.ts`, `styles.ts` | the three blocks as plain DOM, styled with the design tokens |
| `passTimer.ts` | GPU time per pass through `timestamp-query`, added from outside the passes |
| `lightTally.ts` | sums the rasterizer's light buffer in a small compute pass |
| `frameStats.ts` | per-frame pacing: average, 1% low, worst, script time |
| `fit.ts` | the particle count that fits a frame at a target frame rate |
| `gpuFacts.ts` | adapter name, limits, the WebGL product name |
| `demo/` | `/src/ux/perf-hud/demo/`: the real menu code painting made-up numbers, ten cases on keys 1 to 9 and 0, no WebGPU |
| `perf-hud.test.js` | `npm test -- perf-hud`: the arithmetic and the wording |
| `perf-hud.verify.ts` | `npm run verify -- perf-hud`: the tally against a CPU sum and the pass timer on a real GPU device |

## How it measures

- **Frame pacing.** One hook at the front of the frame loop's hooks and one
  at the back. The frame's time is the browser's own stamp for it
  (`document.timeline.currentTime`, the value `requestAnimationFrame` passes),
  so the difference between two frames shows dropped frames and not how late
  a callback happened to start. Script time is the clock between the two hooks.
- **GPU time per pass.** WebGPU only writes timestamps at the start and end of
  a GPU pass, when the pass descriptor asks. The app's passes know nothing
  about timing, so `PassTimer` is a `FrameObserver` (`src/core/frameGraph.ts`)
  that hands each pass an encoder which adds the timestamp writes to every
  compute and render pass it begins. Each reading is tagged with the graph pass
  that began it. Chrome rounds timestamps to 0.1 ms, so rows show an average
  over about a dozen frames. If a GPU validation error arrives while timing is
  on, timing switches itself off for the session.
- **In frame.** Twice a second, one compute pass sums the light buffer in
  strips (64-bit sum, peak, lit pixels per strip), and a few kilobytes come
  back.

All of it runs only while the menu is open. Closed, the cost is two clock
reads and one ring buffer write a frame.

## Not measured

- Time the GPU spends outside passes (buffer clears, copies) and the browser's
  own compositing. "gpu" is time inside the frame's passes.
- Anything about the offline trillion renderer. It reports its own rate and
  GPU tallies in its manifest (`src/manifest`). While it runs, this page reads
  "paused": the world on screen is not being stepped.

- **Depends on:** `src/core` (contracts, `FrameObserver`), `src/ux/hud`
  (`registerView`, `setFact`), `src/ux/design`, `LIGHT_ONE` from `src/perf`.
- **Used by:** `src/main.ts`.
