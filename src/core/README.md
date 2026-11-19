# src/core

The shared contracts every module builds against, plus the two engine pieces that sit on them. See `docs/architecture.md`.

- **Key files:** `contracts.ts` (types for planes, behaviors, passes, camera, budget, `AppContext`, plus `PASS_ORDER` and `TOKENS`), `frameGraph.ts` (`FrameGraph`: runs passes stage by stage and owns the HDR target), `budget.ts` (`VisibleOnlyBudget`: planes in view at full count, out of view paused).
- **Rule:** add new files that implement these interfaces instead of editing shared ones; a missing hook goes in as its own small, optional change.
- **Depends on:** nothing.
- **Used by:** almost every folder in `src/`.
- **Status:** live in the app.
