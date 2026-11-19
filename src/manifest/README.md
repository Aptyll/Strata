# src/manifest

One JSON **render manifest** per render of the stateless (offline, 1T) path,
saved next to the frames and published with the video. It says exactly what
the GPU did, so anyone can check or reproduce a frame. Brief:
[docs/briefs/honest-counting.md](../../docs/briefs/honest-counting.md).

- **Key files:** `manifest.mjs` (build and compare, no imports, runs in the
  browser and in plain Node; types in `manifest.d.mts`), `node/record.mjs`
  (the `npm run record` CLI), `node/reproduce.mjs` (GPU re-render on Dawn).
- **Depends on:** the files `src/offline` writes (`job.json`,
  `frame-NNNNNN.json`, `frame-NNNNNN.png`). `reproduce.mjs` also imports
  `src/offline/core`.
- **Used by:** `npm run record`; the app's `?record` job can call
  `buildManifest` for its saved JSON.

## What a manifest holds

| field | from |
| --- | --- |
| `mode: "rendered-stateless"`, `wording` | fixed: rendered, never simulated |
| `source.commit` | `git rev-parse HEAD` (`-dirty` if `src/` has local changes) |
| `job` | name, sha256 of the exact job JSON, size, fps, splat, weighting, sheet count, seed range, camera keys; `fullJob` embeds the whole job |
| `particlesPerFrame` | the job's configured count, kept apart from the tallies |
| `frames[]` | per frame, copied from the GPU-written stats: `evaluated`, `landed`, `outside`, exact grid `unitSum`, `litPixels`, `maxCode`, GPU seconds, particles/s, `gridHash`, sha256 of the 16-bit PNG |
| `drawing` | `weighting` and `splat`, and what they mean: `count` = exactly one unit per particle in frame; `flux` = light falls with distance, and the sentence says whether every particle in frame added light, from the GPU's `drawn` counts |
| `frames[].drawn`, `everyLandedDrawn` | the GPU's count of landed particles that added light to the grid, and whether it equals `landed`. `null` in manifests of frames rendered before the count existed, where far flux particles were drawn on average only |
| `frames[].unitsPerParticle` | grid units one full-weight particle adds: 65536, or more for flux frames with finer weights. `lightParticles` is `unitSum` divided by it |
| `frames[].eachLandedAddedOnce` | count + point only: `unitSum == landed x 65536`, proving every landed particle added exactly one unit. `null` when not provable |
| `totals` | frames complete, `allEvaluated` (GPU tally equals the job in every frame), summed evaluated, GPU seconds, measured particles/s |
| `gpu`, `host`, `grade` | adapter info, platform, the Look used for the picture |

`gridHash` covers only fields fixed by the integer grid (evaluated, landed,
unitSum, litPixels, maxCode, histogram). Integer adds commute, so the same job
gives the same hash on any GPU and any batching. Wall time is excluded. The
PNG hash is file integrity only (zlib output can differ between platforms).

## npm run record

```sh
npm run record -- make out/my-render --gpu "RTX 2070" --look look.json
npm run record -- check reference/manifest.json out/my-render
npm run record -- render reference/manifest.json --range 0:3   # Node + Dawn
```

`make` and `check` need no GPU, so they work on Noah's PC with frames
rendered in `/src/offline/web/` (save the folder, then run `make` on it).
`render` needs `cd src/offline && npm install` and native Dawn, which Noah's
PC blocks; use it on any other machine to reproduce a published clip.
