# src

Map of the source tree. Each folder has its own README with key files, dependencies and status. Shared types live in `core/contracts.ts`; `main.ts` wires the modules into the app.

| Folder | What it does | Status |
| --- | --- | --- |
| `core/` | Shared contracts, frame graph, default budget | live |
| `gpu/` | WebGPU setup, CPU/WGSL byte layouts, sim shader builder | live |
| `sim/` | Per-plane particle simulation (`Simulation`) | live |
| `behaviors/` | Motion rules (WGSL snippets), auto-registered | live |
| `passes/` | Auto-registered frame-graph passes (points, sprites, tonemap) | live |
| `perf/` | Density budget per plane; standalone `PerfEngine` (8-byte particles) and bench | live / standalone |
| `raster/` | The app's default compute rasterizer (`atomic-raster`), with optional sub-pixel splats and depth cues | live |
| `render/` | Density splat, trails, bloom, tone map; integer counter tone map | live |
| `world/` | Endless seeded world and plane streamer | live |
| `interplane/` | Particles crossing between linked planes | live |
| `depth/` | Fog, depth of field, parallax | in app, off by default |
| `hue/` | One color per sheet: a points rasterizer plus a tint pass (`?raster=hue`) | in app, off by default |
| `ux/` | HUD, camera, auto camera tour, first-run experience, dice roll, color themes, design tokens, phone controls, GPU failure recovery | live |
| `app/` | The app shell `main.ts` boots from: URL options, frame graph, scene, HUD entries, key table, frame loop | live |
| `ui/` | Optional side panels (none yet) | wired, empty |
| `capture/` | PNG stills and MP4 video in the browser | live |
| `audio/` | Generative soundtrack driven by the scene, live and rendered offline to WAV | in app, off by default (`M`) |
| `record/` | Launches a 1T record render from the app | live |
| `challenge/` | "How many particles can this GPU run?" mode | live (`?challenge`) |
| `color-life/` | Particle life with color species, simulated on the GPU | standalone page |
| `stateless/` | Stateless motion laws and 64-bit particle keys | used by offline |
| `offline/` | Offline renderer for up to 1T particles per frame | standalone page |
| `trillion/` | Exact-count GPU splat kernel for stateless particles | standalone demo; selectable in the offline renderer |
| `manifest/` | One JSON manifest per offline render (GPU tallies, job hash, grid hash) and `npm run record` | tooling |
| `proof/` | Trillion proof shots built on the offline renderer | standalone page |
| `verify/` | Fast shader correctness checks (`npm run verify`) | tooling |
| `site/` | What the published site says about itself: page titles, link previews, share card, sitemap, load budget | build time only |
