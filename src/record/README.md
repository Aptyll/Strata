# src/record

Launches a record-scale render (one 1 trillion particle 4K still by default) from the app, as an Esc-menu job or from the URL (`?record`). A thin wrapper over `src/offline`: it builds the job, runs `renderJob` (batched, checkpointed, resumable) and `gradeJob`, reports progress through the HUD, saves the result and prints an exact tally per frame. The URL options are documented at the top of `index.ts`.

- **Key file:** `index.ts` (`mountRecord`).
- **Depends on:** `src/offline/core`, `src/offline/web/platform`, `src/capture`, `src/ux/hud`.
- **Used by:** `src/main.ts`.
- **Status:** live in the app.
