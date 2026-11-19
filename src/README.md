# src

Map of the source tree. Each folder has its own README with key files, dependencies and status. Shared types live in `core/contracts.ts`; `main.ts` wires the modules into the app.

| Folder | What it does | Status |
| --- | --- | --- |
| `core/` | Shared contracts, frame graph, default budget | live |
| `gpu/` | WebGPU setup, CPU/WGSL byte layouts, sim shader builder | live |
| `sim/` | Per-plane particle simulation (`Simulation`) | live |
| `behaviors/` | Motion rules (WGSL snippets), auto-registered | live |
| `passes/` | Auto-registered frame-graph passes (points, sprites, tonemap) | live |
| `perf/` | Default atomic rasterizer and budget; standalone `PerfEngine` and bench | live / standalone |
| `render/` | Density splat, trails, bloom, tone map; integer counter tone map | live |
| `world/` | Endless seeded world and plane streamer | live |
| `interplane/` | Particles crossing between linked planes | live |
| `depth/` | Fog, depth of field, parallax | in app, off by default |
| `ux/` | HUD, camera, first-run experience, dice roll | live |
| `app/` | Key ownership and intro adapters for `main.ts` | live |
| `ui/` | Optional side panels (none yet) | wired, empty |
| `capture/` | PNG stills and MP4 video in the browser | live |
| `record/` | Launches a 1T record render from the app | live |
| `challenge/` | "How many particles can this GPU run?" mode | live (`?challenge`) |
| `stateless/` | Stateless motion laws and 64-bit particle keys | used by offline |
| `offline/` | Offline renderer for up to 1T particles per frame | standalone page |
| `trillion/` | Exact-count GPU splat kernel for stateless particles | standalone |
| `proof/` | Trillion proof shots built on the offline renderer | standalone page |
| `verify/` | Fast shader correctness checks (`npm run verify`) | tooling |
