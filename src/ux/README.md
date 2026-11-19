# src/ux

Everything between the person and the simulation. Each subfolder is self-contained with its own doc in `docs/ux/`.

| Folder | What it does | Status |
| --- | --- | --- |
| `hud/` | Near-invisible overlay: stats (H), settings menu (Esc), job progress. `index.js` is dependency-free; `wire.ts` (`mountHud`) is the one file that talks to the engine through `AppContext`. Demo: `/src/ux/hud/demo/`. | live |
| `camera/` | `CameraRig`, a DOM-free camera for flying through the void; `engine.ts` (`createCamera`) adapts it to the `CameraController` contract, `input.ts` binds mouse, touch, pen and keys. Demo: `/src/ux/camera/demo/`. | live |
| `experience/` | First-run opening, capability check and starting budget (`capability.ts`), pointer forces (`engine-brushes.ts`), the no-WebGPU fallback (`fallback.ts`), gestures and hints. `index.ts` (`createExperience`) is the standalone version used by its demo. | partly live (capability, brushes, fallback, intro via `src/app/intro.ts`) |
| `behavior-ui/` | `roll.ts`: what the R dice produce (`rollScene`, `startRoll`); wired by `hud/wire.ts`. | live |
| `autocam/` | Auto camera tour: the camera picks dense sheets and clusters and glides between them (C, the Esc menu switch or `?autocam=1`); any camera input hands control back. `director.ts` and `shots.ts` are DOM-free. Notes: `docs/ux/autocam.md`. Demo: `/src/ux/autocam/demo/`. | live, off by default |
| `mobile/` | Touch screens: a smaller particle budget picked from the device, and a round button that opens the settings menu (phones have no Esc key). Touch camera gestures live in `camera/input.ts`. | live on touch devices |
| `recovery/` | What the app does when the GPU fails: a card and one automatic restart after a lost device, the last world that fit when a particle count does not, a card instead of a black page when boot throws. Demo: `/src/ux/recovery/demo/`. | live |
| `design/` | The design tokens (`--st-*`): type roles, ink levels, spacing, motion and the theme accent that all chrome is styled with. Rules: `docs/ux/design.md`. Specimen: `/src/ux/design/demo/`. | tokens live; chrome is being moved over |
| `theme/` | Color themes: a gradient map on the canvas after the tone map (one SVG filter), T to cycle, `?theme=`; mounted by `src/app/hud.ts`. | live |

- **Depends on:** `src/core/contracts.ts`.
- **Used by:** `src/main.ts`, `src/app`, `src/capture`, `src/record`, `src/challenge`.
