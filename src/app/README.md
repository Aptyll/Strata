# src/app

Small adapters that `src/main.ts` uses to glue modules written in parallel into one app.

- **Key files:** `keys.ts` (`createKeyRouter`: decides which module owns each key, so the HUD and the camera never both react to one press; a new HUD shortcut must be added to its reserved set), `intro.ts` (`mountIntro`: runs the first-run opening from `src/ux/experience/intro-runner.ts` on the app's own camera and frame loop).
- **Depends on:** `src/core/contracts.ts`, `src/ux/experience`.
- **Used by:** `src/main.ts`.
- **Status:** live in the app.
