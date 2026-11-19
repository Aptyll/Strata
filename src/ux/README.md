# src/ux

Everything between the person and the simulation. Each subfolder is self-contained with its own doc in `docs/ux/`.

| Folder | What it does | Status |
| --- | --- | --- |
| `hud/` | Near-invisible overlay: stats (H), settings menu (Esc), job progress. `index.js` is dependency-free; `wire.ts` (`mountHud`) is the one file that talks to the engine through `AppContext`. Demo: `/src/ux/hud/demo/`. | live |
| `camera/` | `CameraRig`, a DOM-free camera for flying through the void; `engine.ts` (`createCamera`) adapts it to the `CameraController` contract, `input.ts` binds mouse, touch, pen and keys. Demo: `/src/ux/camera/demo/`. | live |
| `experience/` | First-run opening, capability check and starting budget (`capability.ts`), pointer forces (`engine-brushes.ts`), the no-WebGPU fallback (`fallback.ts`), gestures and hints. `index.ts` (`createExperience`) is the standalone version used by its demo. | partly live (capability, brushes, fallback, intro via `src/app/intro.ts`) |
| `behavior-ui/` | `roll.ts`: what the R dice produce (`rollScene`, `startRoll`); wired by `hud/wire.ts`. | live |
| `design/` | The design tokens (`--st-*`): type roles, ink levels, spacing, motion and the theme accent that all chrome is styled with. Rules: `docs/ux/design.md`. Specimen: `/src/ux/design/demo/`. | tokens live; chrome is being moved over |
| `info/` | The information layer: what the words on screen say. Labelled counts on the stats line ("simulated", "stored", "sheets"), the label for the sheet the camera faces, the pointer and camera rows on the keys sheet, and the about card (I) that explains simulated versus rendered. Vocabulary and rules: `docs/ux/information.md`. Demo: `/src/ux/info/demo/`. | live |
| `theme/` | Color themes: a gradient map on the canvas after the tone map (one SVG filter), T to cycle, `?theme=`; mounted by `src/app/hud.ts`. | live |

- **Depends on:** `src/core/contracts.ts`.
- **Used by:** `src/main.ts`, `src/app`, `src/capture`, `src/record`, `src/challenge`.
