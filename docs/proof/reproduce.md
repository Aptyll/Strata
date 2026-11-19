# Reproduce the trillion-particle record

Strata's record video shows 1,000,000,000,000 particles in every frame at 4K.
This page explains how the record is made so that anyone can check it, and how
to check it yourself with one command.

The short version: the record is rendered from a committed config with a public
seed and a fixed camera path. While it renders, the GPU counts every particle it
evaluates, and every frame's stats carry a SHA-256 of the frame's exact 64-bit
accumulation grid. One JSON file, the render manifest, collects all of that and
is published next to the video. To verify, you re-render a few frames picked at
random on your own GPU and compare them with the manifest.

## What is claimed

- **Every frame evaluates every one of the 10^12 particles from scratch.** The
  particles are stateless: a position is a closed-form function of (sheet seed,
  particle index, time), so nothing is stored per particle. The record is
  rendered, not simulated: there are no forces between particles.
- **The count comes from the GPU.** The renderer's shader keeps an exact 64-bit
  tally of particles evaluated and of particles landing inside the picture,
  reduced per workgroup (`src/offline/core/shaders.ts`). The manifest copies
  these numbers; nothing is computed from the job. The renderer refuses to save
  a frame whose GPU count differs from the number of particles in the world.
  Every kernel the renderer has (`offline`, `trillion`, `trillion-strata`)
  counts on the GPU. Stats the `trillion` kernel wrote before it had its own
  tally were summed on the host from dispatch sizes; a manifest says which
  counter was used, and `verify` fails a render that was not counted on the
  GPU.
- **Each particle in frame adds exactly one unit of light.** The record uses
  count weighting with point splats, so a frame's grid sum is exactly
  (particles in frame) x 65536. The manifest checks this for every frame.
- **Frames are exact and reproducible.** Each frame's grid holds an exact 64-bit
  integer per pixel. Integer adds commute, so a frame is bit-identical however
  the work is split into batches, in whatever order the GPU schedules it, and
  across a stop and resume.

## Verify a published record

You need a GPU with a recent driver, Node 20.6 or newer (22 recommended) and
git. Allow about 140 MB for Dawn, the WebGPU implementation the verifier uses
(D3D12 on Windows, Vulkan on Linux, Metal on macOS).

```sh
git clone https://github.com/Aptyll/Strata && cd Strata
git checkout <the commit named in the manifest>     # for identical frames
npm ci
npm ci --prefix src/offline                         # tsx and Dawn, pinned, once
npm run record -- verify proof/runs/<manifest>.json
```

`verify` does three things:

1. **Checks the manifest on its own**, no GPU needed: the embedded job hashes
   to the recorded SHA-256 and holds the claimed particles per frame, every
   frame's count is exactly the whole world and was counted on the GPU, every
   frame's grid sum is exactly (particles in frame) x 65536, the totals add up,
   and which fingerprints and provenance (commit, GPU, video hash) it carries.
2. **Runs the GPU self-checks** on your machine (below).
3. **Re-renders 2 frames chosen at random** with the manifest's own job, through
   the same renderer the record used, and compares each one with the published
   frame. Your GPU's own count must be exactly 1,000,000,000,000. Each frame
   then gets a verdict:
   - `identical`: the same exact grid (equal grid SHA-256) and the same counts.
     Expected on the same GPU model, driver and browser or Dawn build, from the
     same commit.
   - `same picture`: the grids differ, but the 16 x 9 tile brightness is within
     2% and the in-frame count within 0.5%. Expected on another GPU model:
     GPUs compute f32 sin, cos, log and pow slightly differently, so a few
     particles land one pixel over.
   - `different`: anything else. Verification fails.

The frames, a manifest of them and `verify-report.json` (every check, every
verdict, your machine) go to `proof/out/verify-<job>/`.

Options: `--frames 5` re-renders 5 random frames, `--at 0,300,590:600` names
them, `--seed 42` makes the random pick repeatable, `--frames 0` checks only the
file, `--mp4 <file>` checks a downloaded master video against the manifest's
SHA-256, `--config proof/trillion-4k.json` checks that the committed config
builds exactly the job that was rendered, `--no-selfcheck` skips the self-checks.
A stopped verify continues where it stopped when run again with the same frames
(it prints the command).

A trillion-particle 4K frame takes as long as your GPU needs for 10^12
evaluations: about 160 to 190 seconds on an RTX 2070 with count weighting. The
manifest lists each frame's time on the record machine, and the verifier prints
your speed as it goes.

To compare two manifests without rendering anything, for example the record and
your own full re-render:

```sh
npm run record -- check proof/runs/<manifest>.json proof/out/verify-<job>/manifest.json
```

### How close is "same picture"?

Measured so far on two independent software Vulkan implementations, SwiftShader
and Mesa's lavapipe, rendering all 12 frames of `proof/smoke.json`: every frame's
grid differed, so the exact hashes never matched, while the tile brightness
differed by at most 0.021% and the in-frame count by at most 0.0029%. The limits
(2% and 0.5%) leave about a hundredfold margin there. They have not yet been
measured between real GPU vendors, whose fast sin and cos are less exact than a
software renderer's, so treat them as first guesses until a few real GPUs have
verified the record.

## Make the record

The record machine is Noah's RTX 2070. Its Windows Application Control blocks
native `dawn.node`, so the record is rendered in Chrome:

```sh
npm ci --prefix src/offline             # tsx, for the next line (no GPU use)
npm run record -- job                   # proof/trillion-4k.json -> proof/out/record-1T-3840x2160-600f/job.json
npm run dev                             # then open /src/offline/web/
```

1. On the offline page, press **choose folder** and pick
   `proof/out/record-1T-3840x2160-600f`. A folder that holds a job renders that
   job, whatever the form says. Every kernel counts every particle on the GPU,
   and each frame's stats record which kernel rendered it, so `verify` uses the
   same one (the kernels sample camera blur differently, so their pixels
   differ). **offline** is the default. Press **render**. It is resumable: stop, close the tab or
   reboot, then choose the folder and press render again. The page also saves
   the GPU's name in the folder (`adapter.json`).
2. Export the MP4 into the same folder (the default name is the job name).
3. Write the manifest. It needs no GPU, so it runs on the record PC:

   ```sh
   npm run record -- make proof/out/record-1T-3840x2160-600f
   ```

   It reads every frame's GPU-written stats, hashes every PNG and the MP4, and
   records the commit (with `-dirty` if `src/` has local changes, so commit
   first), the GPU and this machine.
4. Publish: copy `manifest.json` to `proof/runs/<date>-<gpu>.json`, commit it
   and tag the commit. YouTube re-encodes uploads, so attach the master MP4 to a
   GitHub release; its SHA-256 is in the manifest.

The same world also renders from the app: `/?record=1e12&size=4k&frames=600&fps=60&sheets=1024&seed=1`
builds byte-identical job JSON (the same job SHA-256), keeps the frames in the
browser's private storage and downloads its manifest when done. The folder is
the safer home for a render that takes a day or more.

At count weighting the 2070 needs about 160 to 193 seconds per 1T 4K frame, so
the 600 frames of the default config are roughly 27 to 32 hours. `frames` and
`fps` in the config are the knobs: 30 fps halves it with no change to any frame.

On any machine that can load Dawn, `npm run record -- render <folder>` renders
the missing frames of a job folder from the command line instead, after the GPU
self-checks: resumable with Ctrl+C, reopening the GPU after a driver reset, and
it writes the manifest at the end. Encode the MP4 with the offline CLI
(`cd src/offline && npx tsx node/cli.mjs encode --out <folder>`), then run
`make` again to add the video's hash.

## The record config

`proof/trillion-4k.json` is the recipe. Its `world` uses the same settings as
the app's `?record` URL, and `npm test` checks that it still builds the claimed
job (10^12 particles on 1024 sheets with distinct seeds, 3840 x 2160, count
weighting, point splats, the pinned camera). `proof/smoke.json` is a 4-million
particle version that renders in seconds, for trying the pipeline.

| field | meaning |
| --- | --- |
| `world.particles` | particles per frame, all evaluated every frame |
| `world.width`, `height`, `fps`, `frames` | output video |
| `world.planes` | sheets the particles are split over (at most 2^32 - 1 each) |
| `world.seed` | the public seed: sheet layout, laws, every particle's identity |
| `world.weighting` | `count`: every particle in frame adds exactly one unit of light |
| `world.splat` | `point`: one atomic add per particle |
| `camera` | the fixed camera path (keys at timeline positions 0 to 1); without it the generated shot is used |

`npm run record -- job [config] [--out dir]` writes the expanded job (all 1024
sheets and the camera) as `job.json`. The manifest embeds that job and its
SHA-256, so verification uses exactly the job that was rendered even if the
world generator changes later.

## The manifest

One JSON file per render, written by `src/manifest/manifest.mjs` (fields:
[src/manifest/README.md](../../src/manifest/README.md)). Per frame it holds the
GPU's `evaluated` and `landed` counts, who counted (`evaluatedBy`), the exact
grid sum, `gridSha256`, the tile `signature`, the kernel, lit pixels, the PNG's
SHA-256 and the frame's GPU time. Around them: the embedded job and its SHA-256, the
weighting and what it means, totals, the GPU, the commit, and the video's name,
size and SHA-256.

Fingerprint layouts, so another implementation can reproduce them
(`src/offline/core/fingerprint.ts`):

- `gridSha256` = SHA-256 of the ASCII header `strata-grid-v1\n<gw>x<gh>\n`,
  then SHA-256 of the grid's low 32-bit words, then SHA-256 of its high words
  (each word little-endian, row major; the two inner hashes as 32 raw bytes
  each). `<gw> x <gh>` is the grid size: output size times supersampling.
- `signature` = 16 x 9 tiles over the grid, row major, each
  `round(256 x log2(1 + units / 65536))` where `units` is the tile's grid sum
  (under count weighting, units / 65536 is the particles in the tile).
- job `sha256` = SHA-256 of the job JSON exactly as embedded.

## GPU self-checks

Run before every `verify` and `render`, on the device that renders
(`src/manifest/node/selfcheck.mjs`), and alone with `npm run record -- selfcheck`.
A second or two on a real GPU.

| check | what it shows |
| --- | --- |
| gpu count | the GPU's tally equals the particles in a small job, with odd batch sizes and odd work per invocation |
| grid matches tally | the grid sum is exactly (in-frame count) x 65536 under count weighting |
| batch invariance | one batch per sheet and thousands of small batches give a bit-identical grid |
| resume | a frame stopped after its first batch and resumed from the checkpoint ends bit-identical |
| no GPU errors | the device reported no validation or out-of-memory errors |

## What this does not show

- The self-checks run on the verifier's GPU, not in the browser that rendered
  the record. The record's own frames are checked by re-rendering them.
- Re-rendering checks a random sample of frames, not all of them. Picking them
  at random after the manifest is published is what makes a sample meaningful.
- The video is tied to the manifest by its SHA-256, but nothing yet decodes
  video frames and compares them with a re-render.
- On another GPU model, "same picture" is a tolerance: a small edit to an
  in-frame count could pass the frame comparison. The manifest's own check that
  the grid sum equals (particles in frame) x 65536 catches such an edit unless
  the grid sum was edited to match, and a re-render on the record's GPU model
  catches any edit, because the grid hash then has to match too.
- Counts show that every particle was evaluated and accumulated. They say
  nothing about physics: the motion is closed-form, not a time-stepped
  simulation with interactions.

## Troubleshooting

- `This step needs tsx and webgpu from src/offline`: run `npm ci --prefix src/offline` once.
- `No GPU adapter found`: update the graphics driver, or pick another Dawn
  backend with `--dawn backend=vulkan` (`d3d12` on Windows, `metal` on macOS).
- Windows Application Control blocks `dawn.node`: render in the browser as
  above, and run `verify` on another machine. `job`, `make` and `check` need no Dawn.
- Testing in a container without a GPU: point the Vulkan loader at a software
  driver, for example
  `VK_ICD_FILENAMES=/path/to/vk_swiftshader_icd.json npm run record -- render proof/out/record-4M-640x360-12f`
  after `npm run record -- job proof/smoke.json`. Software rendering manages
  tens of millions of particles per second, so only the smoke config is
  practical there.
