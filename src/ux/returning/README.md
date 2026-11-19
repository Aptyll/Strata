# src/ux/returning

Reasons to come back, from the second visit on: today's world (N), kept worlds (K), previous world (Backspace) and one line for each thing that is new. A first visit is left exactly as it is. Everything is remembered in this browser's `localStorage` and nowhere else. Design, rules and open questions: `docs/ux/returning.md`.

- **Key file:** `index.ts`: `mountReturning({ app, hud, keys, isOpening })` wires the four features to the HUD and the engine and returns `update(dt)` for the frame loop.
- **Pieces, all pure and tested on their own:** `daily.ts` (the day and its seed), `arrival.ts` (what a page load opens on), `store.ts` (the visitor's record), `worlds.ts` (copying, comparing and naming scenes), `history.ts` (the worlds seen, back and forward), `news.ts` (the "new since you were here" lines).
- **Shipping something a visitor can do?** Append one line to `NEWS` in `news.ts`. Append only: records store how many lines were told.
- **Demo:** `/src/ux/returning/demo/` (dev only): the real HUD and dice over a CPU stand-in engine, with buttons that move the clock to tomorrow. No WebGPU. Its storage is separate from the app's.
- **Tests:** `returning.test.js` (`npm test -- returning`).
- **Depends on:** `src/core/contracts.ts` (`AppContext`, `Scene`), the HUD's public surface (`src/ux/hud/index.d.ts`), `loadMemory` from `src/ux/experience/hints.ts`. The demo also uses `src/ux/hud/wire.ts` and `src/ux/design`.
- **Used by:** `src/main.ts`. Keys are rows in `src/app/keys.ts` (owner `returning`).
