# src/world

The endless, seeded world of plane structures, and the streamer that keeps the planes that matter to the camera in a fixed GPU budget. Every sector is a pure function of (seed, sector coordinates), so nothing is stored and the world can be infinite. See `docs/world.md`.

- **Entry point:** `index.ts` (`createWorld`, `createStreamer`, `startStreamingWorld`).
- **Key files:** `world.ts` (sectors and structures), `arrangements.ts` (layout recipes for groups of planes), `streamer.ts` (slot states: free, awake, asleep), `driver.ts` (turns streamer changes into `PlaneHost` add, remove and fade calls), `scene.ts` (world data to contract types), `layout.ts` (`scatterLayout` for the simple non-streaming layout), `rng.ts` (deterministic hashing), `math.ts`.
- **`demo/`:** `/src/world/demo/`. **`test/`:** `node src/world/test/run.mjs`.
- **Depends on:** `src/core/contracts.ts`, `src/math.ts`.
- **Used by:** `src/main.ts`, the perf bench.
- **Status:** live in the app.
