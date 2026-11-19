# src/ui

Mounts optional side panels. `index.ts` (`mountPanels`) registers every `*.panel.ts` file in this folder and shows them in a column on the right, hidden by default (Tab toggles it).

- **Key file:** `index.ts`. There are no `*.panel.ts` files at the moment; the settings people use live in the HUD (`src/ux/hud`).
- **Depends on:** `src/core/contracts.ts`.
- **Used by:** `src/main.ts`.
- **Status:** wired into the app, currently empty.
