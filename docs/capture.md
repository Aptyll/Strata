# Capture: PNG stills and MP4 video

`src/capture/` turns what the engine draws into files: PNG screenshots,
supersampled and poster-size stills, and MP4 video ready for YouTube.
Everything runs in the browser. Video is encoded with WebCodecs
(`VideoEncoder`, H.264 by default) and muxed with
[Mediabunny](https://mediabunny.dev). There is no server and no ffmpeg step.

The module does not import the engine. It needs a canvas and a few callbacks,
so it can be used from the main app, the offline challenge, or a test page.

```ts
import {
  capturePNG, captureStillPNG, captureTiledPNG,   // stills
  startRecording, renderOffline, pickOutputFile,  // video
  keyframePath, statePath, orbitPath, sequencePath, // camera paths
  createCaptureController,                        // hotkeys for live use
  TextureReader,                                  // GPU readback alternative
} from '../capture';
```

## In the app

Capture is already wired into the app by `src/capture/app.ts`:

- `P` saves a screenshot of the current frame.
- `V` starts and stops a live recording.
- The settings menu (`Esc`) has a **capture** section: resolution (1080p to
  8K, limited by the GPU), frame rate, length, 2x supersampling, save straight
  to disk, and two buttons. **save still** renders one frame at the chosen
  resolution. **render video** renders offline at a fixed time step, so the
  result is smooth however slowly it renders; pressing it again cancels.
- A video rendered while the sound is on (`M`, see `docs/audio.md`) carries
  the soundtrack: AAC at 192 kbit/s, or Opus where the browser cannot encode
  AAC. Live recordings (`V`) stay silent.

While a still or an offline video renders, the app's realtime loop stops
drawing, the drawing buffer is fixed at the render size
(`FrameGraph.fixedSize`), and every plane draws its full particle count
regardless of the adaptive budget. The camera keeps doing whatever it was
doing (idle drift, a flight in progress), advanced by the same fixed step, and
you can still steer it during the render. Progress shows in one line at the
bottom of the screen.

Files keep the color theme (`T`, or the **theme** menu). A theme is a CSS
filter on the canvas element (`src/ux/theme`), which the browser applies when
it shows the canvas but which is not in the canvas pixels. Every capture reads
the canvas element's computed filter and bakes it into the image after any
downsampling, through a 2D canvas element with `ctx.filter` set
(`OffscreenCanvas` ignores `url()` filters). Recordings read it every frame,
so switching themes mid-recording shows up in the video. Pass `filter: null`
to a still or recording to save the raw grey pixels, or a CSS filter string to
force one.

The rest of this document describes the module underneath, for use from other
code.

## The one rule

**Capture in the same task that rendered.** A WebGPU canvas only holds its
image until the browser presents it. If you render, `await` something, and
then capture, you get a black frame. Every function here copies the canvas
synchronously at the moment you call it, so the pattern is always:

```ts
device.queue.submit([encoder.finish()]);
capture.afterRender();        // or recorder.addFrame(), or capturePNG(canvas)
```

In terms of the frame graph in `docs/architecture.md`, this is the `capture`
stage, called after the command buffer for the frame has been submitted.

If that ordering is not possible, use [GPU readback](#gpu-readback) instead.

## Quick start: hotkeys in the live app

With the engine's frame graph, capture is one pass:

```ts
import { createCapturePass } from './capture';

const capture = createCapturePass(gpu.canvas, { onStatus: (text) => console.log(text) });
graph.add(capture);
// capture.controller is the controller described below.
```

Without the frame graph, call the controller yourself:

```ts
const capture = createCaptureController(canvas, {
  onStatus: (text) => (statusEl.textContent = text),
});

function frame() {
  engine.render();
  capture.afterRender();   // once per frame, right after rendering
  requestAnimationFrame(frame);
}
```

`P` saves a PNG, `R` starts and stops an MP4 recording. Keys are configurable
(`screenshotKey`, `recordKey`) and ignored while typing in a form field.
`capture.requestScreenshot()` and `capture.toggleRecording()` do the same from
code.

Live recording stamps frames with wall clock time and drops frames rather than
stall the render loop, so a live recording is only as smooth as the app was.
For anything going to YouTube, use the offline renderer below.

## Offline rendering: smooth 4K60 at any speed

`renderOffline` owns the loop. It advances the simulation by exactly
`1 / fps` per video frame, renders, encodes, and waits for the encoder before
moving on. Render time does not matter: a scene that manages 3 fps live still
produces a perfectly even 60 fps file.

```ts
const result = await renderOffline({
  canvas,
  width: 3840, height: 2160, fps: 60,
  duration: 30,                          // seconds of video
  supersample: 1,                        // 2 renders 7680x4320 and filters down
  warmupSteps: 600,                      // let the sim settle first, unrecorded
  step: (dt) => engine.simulate(dt),     // use this dt, never the wall clock
  render: () => engine.render(),         // must draw synchronously
  flush: () => device.queue.onSubmittedWorkDone(),
  camera: orbitPath({ duration: 30, radius: 6, height: 1.5, turns: 1 }),
  applyCamera: (pose) => engine.setCamera(pose),
  recording: { output: await pickOutputFile() },   // stream to disk
  onProgress: (p) => console.log(`${(p.progress * 100).toFixed(0)}%, ${p.remaining.toFixed(0)} s left`),
  signal: abortController.signal,
});
```

What the engine has to provide:

- `step(dt, frame)` advances the simulation by `dt` seconds. For the result to
  be reproducible, nothing in the simulation may read `performance.now()` or
  use an unseeded random source. Frame 0 shows the initial state; every later
  frame is `substeps` steps further on (`substeps` defaults to 1, each step
  being `1 / (fps * substeps)` seconds).
- `render(frame)` draws into the canvas and returns. The canvas backing store
  is set to `width * supersample` by `height * supersample` for the duration
  and restored afterwards, so the engine must size its targets from
  `canvas.width/height` each frame rather than from the window.
- Keep the light per pixel. Particles drawn as points or small splats light a
  fixed number of pixels, so a render taller than the window spreads the same
  light over more pixels and comes out darker than what was on screen. Scale
  particle light by `(render height / window height)^2` while the size is fixed
  (the vertical field of view stays the same, so pixels per radian follow the
  height). The app does this in `setResolution` in `src/main.ts`. Sprites sized
  from the target height, like the depth sprites, need nothing.
- `flush` (optional but recommended) keeps the loop from queueing GPU work
  faster than the GPU executes it.

While an offline render runs, pause the normal `requestAnimationFrame` loop,
or it will draw into the resized canvas between frames.

`result` reports `codec`, `audioCodec`, `frames`, `duration`, `elapsed`, and
`blob` (or `null` when the file was streamed to disk).

### Sound

`recording.audio` takes a `RecordingAudio` (src/audio's
`createRecordingAudio` makes one) and adds an AAC track, or Opus where the
browser cannot encode AAC (`audioBitrate`, default 192 kbit/s; Windows' AAC
encoder only takes 96, 128, 160 or 192). It needs fixed timing, so realtime
recordings refuse it. After each frame the recorder calls `pull(videoTime)`
and encodes whatever audio comes back; at the end `finish(duration)` returns
the rest, so the track ends with the last frame; `cancel()` is called if the
recording fails or is cancelled. Hand audio over a few seconds at a time
rather than all at the end: the muxer interleaves by time and keeps encoded
video in memory until audio for the same time arrives.

Checked in headless Chromium (which has no AAC encoder, so Opus): a 25 s
render came out with a 25 s VP9 track and a 25.01 s Opus track (the extra is
Opus padding), with no click where the audio chunks join.

### Memory or disk

By default the file is built in memory and returned as a `Blob`. At the
default 4K60 bitrate that is roughly 560 MB per minute, so for long renders
pass `recording: { output: await pickOutputFile() }`. That opens a save dialog
(it has to be called from a click or key handler) and streams the file to disk
as it is encoded. Chromium only.

## Camera paths

A camera path is a pose as a function of time: `{ duration, sample(t) }`. It is
sampled at each frame's video time, so the same path gives the same shot at
any frame rate.

```ts
// Smooth spline through keyframes (missing fields carry over from the previous key).
const shot = keyframePath([
  { t: 0,  position: [0, 2, 8],  target: [0, 0, 0], fov: 45 },
  { t: 6,  position: [5, 1, 3] },
  { t: 12, position: [0, 0, -2], target: [0, 0, -6], fov: 70, roll: 15 },
], { ease: 'smooth' });

// Orbit; with whole turns and linear easing it loops seamlessly.
const orbit = orbitPath({ duration: 20, radius: [8, 5], height: 1.5, turns: 1 });

// Hard cuts between shots.
const film = sequencePath([orbit, shot]);
```

`keyframePath` and `orbitPath` produce a generic pose:
`{ position, target, up, fov (degrees, vertical), roll (degrees) }`.
`viewMatrix(pose)` turns one into a column-major view matrix.

To script the engine's own `CameraState` directly, with no conversion, use
`statePath`. It splines any object of numbers and number arrays:

```ts
const path = statePath<CameraState>([
  { t: 0,  state: { target: [0, 0, 0], yaw: 0,           pitch: 0.2, distance: 8, fovY: 0.8 } },
  { t: 20, state: { target: [0, 0, 0], yaw: Math.PI * 2, pitch: 0.5, distance: 4, fovY: 0.8 } },
], { ease: 'smooth' });

renderOffline({ ..., camera: path, applyCamera: (state) => (camera.state = state) });
```

Angles are interpolated as plain numbers, so go from `0` to `2 * Math.PI` for
a full turn. Options: `ease` (`'linear' | 'smooth' | 'smoother' | 'ease-in' |
'ease-out'` or a function), `interpolation: 'linear'` for straight segments,
`loop: true` to blend the last keyframe back into the first.

## Stills

```ts
// What is on the canvas now, at its current size.
await capturePNG(canvas, { download: true });

// A 4K still rendered at 2x per axis and filtered down, whatever the window size.
await captureStillPNG({
  canvas, width: 3840, height: 2160, supersample: 2,
  render: () => engine.render(),
  download: true,
});

// A poster larger than the GPU can render in one pass (here 16K), in tiles.
await captureTiledPNG({
  canvas, width: 15360, height: 8640, tileSize: 4096,
  render: (tile) => engine.render({ projectionPrefix: tile.matrix }),
  download: true,
});
```

Supersampling matters for this project in particular: with more particles
than pixels, a 1x render keeps one sample per pixel and aliases, while a
supersampled one averages every sub-pixel sample into the final pixel.
Whole-factor downscaling (2x, 3x, ...) is a box filter computed in linear
light, so one lit subpixel among dark ones keeps its share of the light
instead of being crushed toward black, as averaging sRGB codes would do.
Other ratios fall back to `drawImage` in successive halvings.

`captureStillPNG` is limited by the GPU's maximum texture size
(`maxRenderSize`, default 8192). Beyond that, `captureTiledPNG` renders the
image as a grid. For each tile the engine multiplies `tile.matrix` in front of
its projection matrix (`tile.matrix * projection`), which zooms clip space so
the tile fills the viewport. Anything sized in pixels should use
`tile.fullWidth/fullHeight` instead of the canvas size. Screen-space effects
that look at neighbouring pixels (bloom, blur) will show seams at tile edges;
turn them off for tiled renders, or use `captureStillPNG`.

All still functions return the PNG `Blob`. `download: true` also saves it as
`strata-YYYYMMDD-HHMMSS.png`. The background defaults to black;
`background: null` keeps the canvas alpha.

## Manual recording

`renderOffline` and the controller are built on `startRecording`. Use it
directly for custom loops:

```ts
const rec = await startRecording(canvas, { fps: 60 });
for (let i = 0; i < 600; i++) {
  engine.simulate(1 / 60);
  engine.render();
  await rec.addFrame();          // copies the canvas now, resolves when the encoder is ready
}
const { blob } = await rec.stop();
```

`RecordingOptions`:

| option | default | notes |
| --- | --- | --- |
| `fps` | 60 | |
| `width`, `height` | canvas size | Rounded down to even. If the canvas is larger, frames are filtered down. |
| `codec` | `['avc', 'hevc', 'av1', 'vp9']` | First one the browser can encode at this size wins. |
| `bitrate` | from `bitsPerPixel` | Bits per second. |
| `bitsPerPixel` | 0.15 | About 75 Mbit/s at 4K60, 19 Mbit/s at 1080p60. |
| `keyFrameInterval` | 0.5 | Seconds. |
| `timing` | `'fixed'` | `'fixed'`: frame N is at N / fps. `'realtime'`: wall clock, drops frames when busy. |
| `output` | `'memory'` | Or a `FileSystemFileHandle` from `pickOutputFile()`. |
| `hardwareAcceleration` | `'no-preference'` | |
| `download`, `filename` | off | Download on stop (memory output). |

Why the bitrate is high: a dense particle field is close to noise, which is
the worst case for a video codec, and YouTube re-encodes whatever it is given.
Uploading at 4K helps even for viewers at 1080p, because YouTube gives 4K
uploads a better codec and far more bits. If a video still looks blocky on
YouTube, raise `bitsPerPixel` (0.25 is not unreasonable) and upload at 4K.

H.264 is tried first because it is what YouTube recommends and what every
player opens. H.264 tops out around 4096 px wide, so larger sizes fall through
to HEVC or AV1 where the machine can encode them.

## GPU readback

`TextureReader` reads a texture back as a `VideoFrame` instead of capturing the
canvas element. Use it when the image to record is not on the canvas (an
offscreen target), or when capture cannot run in the same task as the render.

```ts
const reader = new TextureReader(device);

// Inside the frame, before submit:
const pending = reader.copy(encoder, finalTexture);   // rgba8unorm or bgra8unorm, COPY_SRC
device.queue.submit([encoder.finish()]);
await recorder.addFrame(await pending.frame());       // the recorder closes the frame
```

Every capture function accepts this as a `capture` hook
(`renderOffline({ capture })`, `captureStillPNG({ capture })`,
`createCaptureController(canvas, { capture })`), and `capturePNG` accepts a
`VideoFrame` in place of a canvas. To read the canvas texture itself, configure
the context with `usage: RENDER_ATTACHMENT | COPY_SRC`.

## Demo and verification

`npm run dev`, then open `/src/capture/demo/index.html`. It draws a small
stand-in particle scene and has a button for every feature. Add `?2d` for a
Canvas 2D scene or `?readback` to exercise `TextureReader`.

`npm run verify:capture` drives that page in headless Chromium and checks that
an offline render produces an MP4 with exactly the expected frame count,
duration, frame rate and size, that stills are not blank, that a tiled still
matches a single-pass render, and that live recording yields a file. Flags:
`--2d`, `--readback`, `--codec avc|hevc|vp9|av1`, `--out <dir>` to keep the
files. It needs Playwright with Chromium installed.

## Limits and things not done

- Browser support: recording needs WebCodecs (Chrome, Edge, recent Safari and
  Firefox). `pickOutputFile` needs Chromium. `isRecordingSupported()` tells you
  up front.
- Live (realtime) recordings have no audio track; a soundtrack needs fixed
  timing (`recording.audio` above).
- No motion blur. The right way to do it is to accumulate several sub-frames
  in the engine's HDR target before tonemapping; averaging 8 bit canvas frames
  would crush dim particles. `substeps` already gives the simulation side of
  this.
- Video is 8 bit SDR. HDR output would need the engine to tonemap to a wide
  gamut target first.
