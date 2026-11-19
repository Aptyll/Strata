# src/interplane

Edge crossing: particles that reach a linked edge of one plane fly through 3D space as a stream and land on a neighbouring plane. Cost scales with the small pool of particles in transit ("couriers"), not with the world's particle count. See `docs/interplane.md`.

- **Key files:** `interplane.pass.ts` (`createInterplane`: compute and render passes), `links.ts` (which edge leads to which neighbour, pure math), `wgsl.ts` (shared crossing math so compute and render agree), `links.test.mjs`.
- **`demo/`:** standalone page faking just enough engine (`/src/interplane/demo/`).
- **Depends on:** `src/core/contracts.ts`.
- **Used by:** the app, through `src/app/graph.ts` (registers its passes after the rasterizers).
- **Status:** live in the app.
