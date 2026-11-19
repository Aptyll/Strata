# src/app

The app shell: the small modules `src/main.ts` boots the realtime world from. `main.ts` reads top to bottom as the boot sequence; each step lives here. Map and recipes (new setting, new key, new per-frame step): `docs/CODEMAP.md`, "App shell, UX, world, interplane and capture".

- **Key files:** `options.ts` (every URL option, one table), `graph.ts` (every pass the app draws with, the rasterizer choice, plane crossings), `budget.ts` (full or adaptive particle budget), `scene.ts` (current scene, `loadScene` / `getScene`, particle total), `context.ts` (the `AppContext` UI code gets), `hud.ts` (the app's menu entries, stats and keys), `keys.ts` (`KEYS`: every key with its owner; the camera gets the rest), `menu.ts` (`MENU`: the Esc menu's table of contents, every control with its page, section, name and hint), `loop.ts` (the frame loop and its hooks), `intro.ts` (the first-run opening on the app's camera and budget).
- **Depends on:** `src/core`, `src/sim`, `src/passes`, `src/perf`, `src/render`, `src/depth`, `src/interplane`, `src/world`, `src/ux`.
- **Used by:** `src/main.ts`.
- **Status:** live in the app.
