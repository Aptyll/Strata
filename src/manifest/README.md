# src/manifest

One JSON **render manifest** per render of the stateless (offline, 1T) path,
saved next to the frames and published with the video. It says exactly what
the GPU did, so anyone can check or reproduce a frame. Walkthrough for the
record: [docs/proof/reproduce.md](../../docs/proof/reproduce.md). Brief:
[docs/briefs/honest-counting.md](../../docs/briefs/honest-counting.md).

- **Key files:** `manifest.mjs` (build, check and compare; no imports, runs in
  the browser and in plain Node; types in `manifest.d.mts`), `config.ts` (record
  configs, `proof/*.json`), `node/record.mjs` (the `npm run record` CLI, plain
  Node), `node/folder.mjs` (render folder to manifest), `node/reproduce.mjs`
  (job, render, verify on Dawn, loaded through src/offline's tsx),
  `node/selfcheck.mjs` (GPU self-checks).
- **Depends on:** the files `src/offline` writes (`job.json`,
  `frame-NNNNNN.json`, `frame-NNNNNN.png`, `adapter.json`), including the
  fingerprints `renderJob` puts in every frame's stats
  (`src/offline/core/fingerprint.ts`). `reproduce.mjs` also imports
  `src/offline/core`.
- **Used by:** `npm run record`; the app's `?record` job calls `buildManifest`
  for its saved JSON.

## What a manifest holds

| field | from |
| --- | --- |
| `mode: "rendered-stateless"`, `wording` | fixed: rendered, never simulated |
| `source.commit` | `git rev-parse HEAD` (`-dirty` if `src/` has local changes) |
| `job` | name, sha256 of the exact job JSON, size, fps, splat, weighting, sheet count, seed range, camera keys; `fullJob` embeds the whole job |
| `particlesPerFrame` | the job's configured count, kept apart from the tallies |
| `frames[]` | per frame, copied from the GPU-written stats: `evaluated`, `landed`, `outside`, exact grid `unitSum`, `litPixels`, `maxCode`, GPU seconds, particles/s, `gridHash`, sha256 of the 16-bit PNG |
| `frames[].evaluatedBy` | who counted `evaluated`: `gpu` (both kernels now) or `host` (trillion-kernel stats from before its GPU tally, summed from dispatch sizes); `null` in stats from before the field |
| `frames[].kernel` | the kernel that rendered the frame (`offline` or `trillion`), so `verify` re-renders with the same one; `null` in older stats |
| `frames[].gridSha256` | SHA-256 commitment to the exact 64-bit grid; `null` in older stats or without WebCrypto |
| `frames[].signature` | 16 x 9 tile brightness, `round(256 log2(1 + particles in tile))`, for comparing renders across GPU models |
| `drawing` | `weighting` and `splat`, and what they mean: `count` = exactly one unit per particle in frame; `flux` = randomly rounded weights, drawn on average only |
| `frames[].eachLandedAddedOnce` | count + point only: `unitSum == landed x 65536`, proving every landed particle added exactly one unit. `null` when not provable |
| `totals` | frames complete, `allEvaluated` (GPU tally equals the job in every frame), `countedOnGpu`, summed evaluated, GPU seconds, measured particles/s |
| `video` | the published MP4's file name, size and sha256 (`make --mp4`, or `<job name>.mp4` in the folder) |
| `gpu`, `host`, `grade` | adapter info (and the browser, for renders from the offline page), platform, the Look used for the picture |

`gridSha256` commits to every pixel of the exact grid. Integer adds commute, so
the same job gives the same hash however it was batched, stopped and resumed,
on the same GPU model, driver and browser or Dawn build. `gridHash` is weaker:
a hash of the grid-determined stats (evaluated, landed, unitSum, litPixels,
maxCode, histogram), kept for stats written before `gridSha256` existed.

Neither hash matches across GPU models: GPUs compute f32 sin, cos, log and pow
slightly differently, so a few particles land one pixel over, and landed, lit
pixels and the histogram move a little. `compareManifests` allows for that:
each frame is `identical` (same exact grid), `same picture` (same GPU count;
tile signature within 2% and in-frame count within 0.5%) or `different`.
Measured between SwiftShader and Mesa lavapipe on the smoke record: every grid
differed, tiles by at most 0.021% and in-frame counts by at most 0.0029%. Not
yet measured between real GPU vendors. The PNG hash is file integrity only
(zlib output can differ between platforms).

## npm run record

```sh
npm run record -- job proof/trillion-4k.json        # write the record's job.json (tsx, no GPU)
npm run record -- make <folder> [--mp4 file]        # write <folder>/manifest.json (no GPU)
npm run record -- check reference.json <folder>     # identical / same picture / different (no GPU)
npm run record -- verify reference.json --frames 2  # self-checks, re-render random frames, compare (Node + Dawn)
npm run record -- render <folder>                   # render a job folder's missing frames (Node + Dawn)
npm run record -- selfcheck                         # GPU self-checks only (Node + Dawn)
```

`make` and `check` need no GPU, so they work on Noah's PC with frames rendered
in `/src/offline/web/`. `job` needs tsx, and `verify`, `render` and `selfcheck`
need Dawn too: `npm ci --prefix src/offline` once. Noah's PC blocks native
Dawn, so use those on any other machine. `render <manifest.json> --range a:b`
still works and means `verify --at a:b`.
