# src/ux/info

The information layer: what the words on screen tell a viewer about what they are looking at. It adds no controls to the world, only meaning to what is already there. The vocabulary and the rules for new text: `docs/ux/information.md`.

What it puts on screen, all through the HUD it is given:

| where | what |
| --- | --- |
| stats line (H) | every count says what it counts: `1.21M simulated  2.00M stored  32 sheets`. The second count shows only while some sheets rest |
| sheet label, bottom right | the sheet the camera faces: its behavior's name, the sentence that describes it, `sheet 7 of 32 · 62.5K particles simulated`. With the stats line on, also the sheet under the pointer |
| keys sheet (?) | the controls that are not HUD shortcuts: what the pointer does and the camera keys |
| about card (I, or "about" in the menu footer) | one screen: what a sheet is, the live counts, why the trillion is "rendered" and this world is "simulated", and the behaviors in this world |

- **Key files:** `index.ts` (`mountInfo`, the only file that touches the HUD and the DOM events), `words.ts` (`TERMS`: each word and its one definition; `MEASURED`: the numbers the app may quote; count formats), `sheets.ts` (facts read from the live planes: one sheet, the census of behaviors, totals; what counts as simulated), `controls.ts` (the pointer, touch and camera key rows as data), `label.ts` (the sheet label), `about.ts` (the about card), `styles.ts` (one stylesheet, design tokens only).
- **Demo:** `/src/ux/info/demo/` runs `mountHud` and `mountInfo` over a CPU stand-in for the engine, so it needs no WebGPU. `#about`, `#keys`, `#stats` and `#rest` in the address open that view.
- **Tests:** `info.test.js` (`npm test -- ux/info`): count formats, what counts as simulated, the census, that no row in the camera key list names a key the HUD owns, that the stylesheet uses only design tokens that exist, and that the measured numbers the card quotes are the ones in `README.md`.
- **Depends on:** `src/core/contracts.ts` (types), `src/ux/hud` (its public API and the `data-stat` hooks), `src/ux/design` (tokens).
- **Used by:** `src/app/hud.ts` (one call to `mountInfo`). The key is the `about` row of `KEYS` in `src/app/keys.ts`.

Adding to it:

- **A new word viewers see** goes in `TERMS` with one sentence, and everything that shows the word reads it from there.
- **A new behavior** needs nothing here: give it a `label` and a `description` (`src/core/contracts.ts`) and the sheet label and the about card show them.
- **A new camera gesture or key** gets a row in `controls.ts`. The rows describe code in `src/ux/camera/input.ts` and `src/ux/experience/gestures.ts`; keep them true to it.
- **A new measured number** goes in the README first, then in `MEASURED`. The test fails when the two disagree.
