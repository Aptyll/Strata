# qa/challenge

Visual QA harness for the particle-count path: the shared density look
(`src/render`), captures and MP4 (`src/capture`), Challenge mode
(`src/challenge`), the offline 1T renderer (`src/offline`, with
`src/stateless` keys) and the trillion kernel (`src/trillion`). It renders
each case offscreen in headless Chromium, reads the pixels back exactly, and
turns them into annotated findings. The findings themselves live in
[`docs/qa/challenge/`](../../docs/qa/challenge/README.md).

Nothing here is part of the app or the build: it imports the real modules from
`src/` and drives them the way the app or the offline renderer does.

## Run

```sh
node qa/challenge/run.mjs                    # every scenario, software GPU
node qa/challenge/run.mjs offline trillion   # only these scenarios
node qa/challenge/run.mjs --out /tmp/qa      # where raw frames go (default: <tmp>/strata-qa/challenge)
node qa/challenge/run.mjs --opts '{"trillion":{"planes":32}}'   # options per scenario
node qa/challenge/run.mjs --hardware         # the machine's real GPU (opens a window)

python3 qa/challenge/annotate.py --in <raw dir> [<raw dir> ...] --out docs/qa/challenge
npx tsc -p qa/challenge/tsconfig.json        # type-check page.ts against src/
```

`run.mjs` starts Vite with no HMR and no file watching (a checkout mid-run must
not reload the page), opens `index.html`, and calls `window.qa.run(name, opts)`
per scenario. A failing scenario is logged and recorded in `results.json`; the
others still run. Each output folder gets an `info.json` with the adapter, the
`main` commit and whether `src/` had local changes, and `annotate.py` prints
that commit in every figure's footer.

`annotate.py` needs Python 3 with numpy and Pillow, plus ffmpeg and ffprobe for
the MP4 figure. With several `--in` folders the first one holding a file wins,
so list the newest run first. Figures whose inputs are missing are skipped.

## Scenarios (`page.ts`)

| name | what it renders |
| --- | --- |
| `ladder` | the render demo's source through the docs/render.md recipe at 0.5M to 32M particles |
| `overflow` | one frame at 1 to 230,000 times the energy, DensityPost recipe vs CountToneMapper |
| `ramp` | synthetic density ramps through DensityPost (default, no dither, filmic) |
| `flicker` | consecutive frames of the render demo, moving and frozen |
| `supersample`, `supersampleGain` | 1x, 2x, 3x captures through the capture Resampler, without and with the app's capture gain |
| `mp4` | `startRecording` with its defaults on density-look frames, plus the source frames |
| `challenge`, `challengeExposure` | Challenge mode, simulated and procedural, 1M to 67M, and procedural 4M at other exposures |
| `offline` | the trillion preset scaled down (1024 sheets, the real 600-frame move) at chosen frames; `splat` forces a splat, `frames` renders a short job instead |
| `offlineSeq`, `offlineMid` | the first frames with the web export's MP4, and frames 300 to 307 at one white point |
| `offlineKernels` | one frame through both kernels of `StatelessRenderer` ('offline' and 'trillion') |
| `fluxKeep` | no rendering: the share of particles the trillion kernel keeps under flux weighting, and each job's camera path |
| `trillion` | `TrillionKernel` on its demo scene (32 sheets): point, stochastic, another salt, and the demo's self test |

## Limits

- Software GPU (SwiftShader). Pixel values are exact; no speed is measured, and
  counts stay small (up to 400M per frame, at 640x360 to 960x540).
- Scaled-down offline jobs are not the 1T framing: the trillion preset builds
  its camera path and flux reference from the particle count (see finding 05).
- A canvas cannot be presented headless, so everything renders into offscreen
  textures and is read back. The app's own frame loop (`src/main.ts`) is not
  run; where it matters (the capture gain) the figure says how it was emulated.
