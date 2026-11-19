# CLAUDE.md: agent guide to Strata

Read this first. It should make you productive in two minutes. Deeper docs are
linked, not repeated. For the file-level map (pages, entry points, who owns
what) read [docs/CODEMAP.md](docs/CODEMAP.md); this page only names folders.

## What Strata is

A browser particle world on WebGPU (TypeScript + Vite, strict `tsc`). A black
void full of flat 2D sheets ("planes") placed in 3D; each sheet runs its own 2D
particle system of white particles. Turning the camera reveals other sheets and
other emergent behaviors, so the world holds more particles than the screen has
pixels. Light adds up where particles overlap: density reads as brightness.

Live: https://aptyll.github.io/Strata/ (every push to `main` deploys via
`.github/workflows/pages.yml`).

Two very different modes, and the wording must keep them apart:

- **Realtime, simulated.** Every particle has stored state (8 bytes) stepped
  every frame. Measured on Noah's RTX 2070 (8 GB): 100M particles at 111 fps,
  800M at 15 fps (54 fps with culling and LOD), about 11.6B particles/s brute
  force. Full table in `docs/perf.md`.
- **Offline, rendered (the trillion).** 1,000,000,000,000 particles per 4K
  frame, **stateless**: each position is a closed-form function of a 64-bit
  particle key and time, splatted into a 64-bit integer grid, nothing kept
  between frames. Always say "rendered", never "simulated", for this path.
  26 to 52 seconds per 4K frame on the 2070 with flux weighting (the record
  stills: far particles drawn on average), about 160 to 193 s with count
  weighting (exactly one unit per particle in view, the proof shots).

## Rules (Noah's, non-negotiable)

- **Work through a PR.** Branch from latest `origin/main`, rebase (or merge
  main in) right before merging, `npm ci && npm run build` must pass, then
  merge your own PR. No waiting for review.
- **Readable branch names**: `feat/short-description`, `fix/...`, `docs/...`,
  `refactor/...`. Never random suffixes like `claude/project-thread-xxxx`, even
  if the harness suggests one. PR titles are plain-language summaries.
- **Add new files, don't edit shared ones.** Build each feature in its own
  folder against `src/core/contracts.ts`, with its own demo page. A missing
  contract hook goes in as its own small PR and stays optional.
- **Edit `src/main.ts` minimally.** It and `contracts.ts` change every few
  minutes; two PRs touching `main.ts` side by side broke the build once. Never
  copy `main.ts` boot code into demo pages (it goes stale).
- **Speed over verification.** Type check and quick build only. Skip long test
  suites, headless render runs and benchmark sweeps; real testing happens on
  Noah's GPU.
- **Honest counting.** Only claim what the GPU actually did. A count shown on
  screen must come from a GPU tally (landed / evaluated), not from a config
  value. Simulated vs procedural/rendered is always labelled.
- **Questions to Noah** are tap-to-answer decision cards (2 to 4 options, one
  recommended), never open-ended text. Prefer a stated assumption over a
  question.
- MIT license, public repo.

## Map of `src/` (details in [docs/CODEMAP.md](docs/CODEMAP.md))

| folder | what lives there |
| --- | --- |
| `main.ts` | app entry: the boot sequence, read top to bottom; `?challenge` branches off here |
| `app/` | the app shell main boots from: URL options (`options.ts`), frame graph, scene, HUD entries, keys (`keys.ts`), frame loop and its hooks (`loop.ts`) |
| `core/` | shared contracts (`contracts.ts`), frame graph, particle budget |
| `gpu/` | device init (`HDR_FORMAT = rgba16float`), shared WGSL prelude |
| `sim/` | per-plane simulation host that runs behaviors |
| `behaviors/` | particle rules, one `<id>.behavior.ts` each, auto-registered |
| `passes/` | render passes, one `<name>.pass.ts` each, auto-registered by filename |
| `render/` | density look: accumulation, counts tone mapper, bloom, trails (`docs/render.md`) |
| `perf/` | 8-byte particle path, culling/LOD, GPU timer; `bench/` page |
| `raster/` | the app's default compute rasterizer (`atomic-raster`), with optional sub-pixel (`?subpixel=1`) and depth cues (`?depth=1`) |
| `world/` | sheet layouts, seeded endless world, streaming sheets around the camera |
| `interplane/` | particles leaving one sheet and landing on another |
| `depth/` | depth cues: settings and WGSL used by the compute rasterizer (`?depth=1`) and the debug sprites (`?raster=sprites`); parallax `?parallax=1`; all off by default |
| `ux/` | `camera/`, `autocam/` (C auto camera tour), `hud/` (H stats, Esc settings), `experience/` (intro), `behavior-ui/` (R dice), `design/` (tokens all chrome is styled with) |
| `ui/` | panel registry (`<id>.panel.ts`) |
| `capture/` | PNG stills and MP4 video (`docs/capture.md`) |
| `audio/` | generative soundtrack: live sound driven by the scene (off by default, M), offline render to WAV in step with video frames (`docs/audio.md`) |
| `challenge/` | self-contained Challenge mode: max particles at target fps, tiers |
| `stateless/` | 64-bit particle keys and RNG (`rng.ts`), stateless motion laws (`laws/`: veil, galaxy, web, ribbons) and their demo |
| `trillion/` | faster trillion splat kernel and laws, standalone with its own demo (not wired into the app yet) |
| `offline/` | standalone stateless renderer: `core/`, `web/` (browser UI), `node/` (CLI) |
| `manifest/` | per-render JSON manifest (GPU tallies, job hash, grid hash) and `npm run record` (make, check, reproduce) |
| `record/` | launches a record-scale offline render from the app (`?record`) |
| `proof/` | trillion proof shots (count-up, pull-back, loupe, dive, find) |
| `verify/` | fast shader correctness checks (`*.verify.ts` picked up by name) |
| `site/` | the published site's wrapper, build-time only: page titles and link previews from one table (`pages.ts`), share card, sitemap, landing page load budget |

Frame stage order: `simulate`, `interplane`, `rasterize`, `depth`, `tonemap`,
`ui`, `capture`. Exactly one rasterize pass is enabled at a time.

## Run, test, render

```sh
npm install
npm run dev          # every page, including dev-only demos
npm run build        # tsc --noEmit + vite build: must pass before merging
npm run typecheck    # tsc only
npm test             # every *.test.* file under src/: a few seconds, no GPU
npm run smoke        # after a build: opens every built page headless, fails on errors
npm run record       # render manifests: make, check, reproduce (src/manifest)
```

| URL (under `npm run dev`) | what |
| --- | --- |
| `/` | the world. Options: `?behaviors=flow,galaxy`, `?world=<seed>`, `?intro=0`, `?adaptive=1` |
| `/?challenge` | Challenge mode (`C` copies the result JSON) |
| `/?record` | 1T 4K still from the app; `?record=1e12&size=4k&frames=1` (see `src/record/index.ts`) |
| `/src/offline/web/` | offline renderer: preset, choose folder, render, export mp4 |
| `/src/proof/web/` | proof shots (dev only, not in the production build) |
| `/src/perf/bench/?bench=1` | benchmark sweep 1M to 800M |
| `/src/verify/` | shader checks in a real browser |

Production pages are listed in `vite.config.ts`; other `src/**/demo` pages are
dev only. A production page also gets a row in `src/site/pages.ts`: its title,
description and link preview come from there, not from tags in its HTML.
Light tests: `npm test` runs every `*.test.js`, `*.test.mjs` or
`*.test.ts` file under `src/` (drop one next to your code and it is picked up
by name), and `npm run verify` runs the headless shader checks (about a second,
needs Playwright). `npm run smoke` opens every page of the built site on the
software GPU and fails if one throws, logs an error, raises a WebGPU error or
stops drawing frames (half a minute, after `npm run build`). A new page is
covered automatically; give it a light URL in `scripts/smoke.mjs` if its
defaults are heavy. Offline Node CLI: `src/offline/README.md`.

## Gotchas

- **Headless sandboxes cannot present a WebGPU canvas.** Cloud Chromium gets a
  SwiftShader adapter (`--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader`)
  but configuring a canvas loses the device, so screenshots are blank. Render
  to an offscreen texture and read it back, or shim
  `GPUCanvasContext.configure/getCurrentTexture`. Keep counts near 300k; 1M
  hangs the software renderer. No cloud number says anything about speed.
- **Noah's PC blocks native `dawn.node`** (Windows Application Control). The
  offline Node CLI does not run there; use `/src/offline/web/` in Chrome. Do not
  suggest changing the policy.
- **f16 HDR caps at about 2048 hits per pixel.** The shared HDR target is
  `rgba16float`, so additive points stop counting past ~2048 overlaps. For big
  counts use integer count grids (compute splat into `u32`, as `src/offline`
  and `src/trillion` do) or scale energy down and exposure up. See `docs/render.md`, "density target".
- **64-bit particle ids.** A trillion does not fit in `u32`. Ids and keys are
  `vec2u` / 64-bit; per-sheet index stays below 2^32 and sheet seeds are
  unique. Accumulation grids are 64-bit integers.
- **Never use `pcg2d` for particle identity.** Use `particleKey(index, seed)`
  from `src/stateless/rng.ts` (Feistel, bijective, tested). Draw numbers
  `k = 0..5` belong to laws; `6` and `7` belong to the offline runner.
- **Keys have owners.** `KEYS` in `src/app/keys.ts` lists every key, its
  owner (HUD, app, capture, theme, autocam, panels) and label; the camera gets every key not
  in it. A new shortcut gets a row there and is registered from that row.
- **Chrome is styled with the design tokens.** Fonts, sizes, text opacities,
  spacing and timings of anything on screen come from `src/ux/design` as
  `var(--st-*)`; no literal fonts, alphas or durations in new UI. Rules and
  the six text roles: `docs/ux/design.md`. Specimen: `/src/ux/design/demo/`.
- **Integer adds commute**, so offline frames are bit-identical however they
  are batched and resume exactly after a stop. Keep it that way: no float
  accumulation in the offline path.
- **Re-fetch main right before merging.** Many threads merge per hour.
- **CI is a safety net, not a gate.** `.github/workflows/ci.yml` runs
  `npm run build`, `npm test`, `npm run verify` and `npm run smoke` on every PR
  and on every push to main. It never blocks a merge. A red X on a `main`
  commit means that merge broke the build, a shader or a page's startup: fix
  it first with a small `fix/` PR.
