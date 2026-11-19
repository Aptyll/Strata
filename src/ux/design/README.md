# src/ux/design

The design tokens: one place that says what the chrome (everything on screen that is not particles) looks like. Type roles, ink levels, spacing, motion timings and the theme accent, as CSS custom properties named `--st-*`. Rules and tables: `docs/ux/design.md`.

- **Key file:** `index.ts`: `installTokens()` puts the tokens on the page, `TYPE` holds each text role as CSS declarations, `setAccent()` and `accentOf()` let a color theme tint the marks, `DESIGN` holds the raw values, `contrastOnVoid()` measures a level against black.
- **Demo:** `/src/ux/design/demo/` (also in the production build): every token in use over stand-in particles, with switches for the type option and the color theme. No WebGPU.
- **Tests:** `design.test.js` (`npm test -- design`): every token referenced exists, text levels keep WCAG AA on black, every theme's accent keeps 3:1.
- **Depends on:** nothing. The demo and the test read `THEMES` from `src/ux/theme`.
- **Used by:** the specimen page, and the HUD with its Esc menu and keys sheet (`src/ux/hud`, through `--hud-*` properties that follow the tokens). The color themes (`src/ux/theme`) set the accent. Hints, title card and Challenge readout follow in separate PRs; `docs/ux/design.md` has the status table.
