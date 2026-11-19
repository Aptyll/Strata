// Readability and accessibility rules for the HUD, layered after styles.js by a11y.js.
// They only override custom properties and sizes, so the look stays white on black.
//
// Type sizes and text contrast come from the design tokens (src/ux/design), which the
// HUD's --hud-* properties in styles.js follow. Contrast (WCAG 2.x, the ink over the
// black void; the colour themes only remap the canvas and keep the void black, so
// these hold for every theme):
//   strong 0.90 -> 16.7:1  values, anything active
//   dim    0.65 ->  8.6:1  labels
//   faint  0.48 ->  4.9:1  section titles, footer (the floor for text)
//   stroke 0.36 ->  3.1:1  outlines of controls
// The menu sits on a 0.88 black backing, so even over white-hot particles faint text
// stays above 4.5:1 (src/ux/design/design.test.js checks these numbers).

export const A11Y_CSS = `
.strata-hud {
  --hud-panel-w: 312px;
  --hud-focus: rgb(var(--hud-fg));
}

/* ---- scrollbars ----------------------------------------------------------- */
/* A visible scrollbar tells keyboard and mouse users there is more below. With the tabbed menu only the pages scroll. */
.strata-hud .sh-panel, .strata-hud .sm-pages { scrollbar-width: thin; scrollbar-color: rgba(var(--hud-fg), var(--hud-a-stroke)) transparent; }

/* ---- target sizes (WCAG 2.2: 24px minimum) --------------------------------- */
.strata-hud .sh-row { min-height: 28px; }
.strata-hud .sh-switch { width: 24px; height: 24px; }
.strata-hud .sh-switch::before { top: 7px; width: 10px; height: 10px; }
.strata-hud select { min-height: 24px; }
.strata-hud .sh-foot button { min-height: 24px; padding: 2px 4px; margin: 0 -4px; }
.strata-hud .sh-act { min-height: 28px; }
.strata-hud input[type=range] { height: 20px; }

/* ---- focus --------------------------------------------------------------- */
/* Every control shows where keyboard focus is. Pointer clicks do not draw the ring. */
.strata-hud :focus-visible { outline: 2px solid var(--hud-focus); outline-offset: 2px; }
.strata-hud .sh-panel:focus, .strata-hud .sh-help:focus { outline: none; }
.strata-hud .sh-switch:focus-visible { outline: none; }
.strata-hud .sh-switch:focus-visible::before { outline: 2px solid var(--hud-focus); outline-offset: 3px; }
.strata-hud input[type=range]:focus-visible { outline-offset: 3px; }
.strata-hud .sh-dot:focus-visible { outline-offset: -10px; border-radius: 50%; }
.strata-hud .sh-dice:focus-visible { outline-offset: -6px; }
/* Focused chrome stays visible through the idle fade. */
.strata-hud.is-idle > .sh-dot:focus-visible,
.strata-hud.is-idle > .sh-dice:focus-visible { opacity: 1; }

/* ---- user preferences ---------------------------------------------------- */
@media (prefers-reduced-motion: reduce) {
  .strata-hud .sh-panel { transform: none !important; }
  .strata-hud .sh-announce, .strata-hud .sh-announce.is-on { transition: none !important; }
  .strata-hud .sh-dice svg { transform: none !important; }
  .strata-hud *, .strata-hud *::before, .strata-hud *::after { animation: none !important; scroll-behavior: auto !important; }
}
/* The design tokens raise every level and make panels solid. These repeat their values for a page without the tokens. */
@media (prefers-contrast: more) {
  .strata-hud {
    --hud-a-strong: var(--st-a-strong, 1); --hud-a-dim: var(--st-a-dim, 0.85); --hud-a-ghost: var(--st-a-faint, 0.75);
    --hud-a-stroke: var(--st-a-stroke, 0.7); --hud-a-line: var(--st-a-hair, 0.5);
    --hud-a-panel: var(--st-a-surface, 1); --hud-blur: var(--st-blur, 0px);
  }
  .strata-hud .sh-panel { -webkit-backdrop-filter: none; backdrop-filter: none; }
}
@media (prefers-reduced-transparency: reduce) {
  .strata-hud { --hud-a-panel: var(--st-a-surface, 1); --hud-blur: var(--st-blur, 0px); }
  .strata-hud .sh-panel { -webkit-backdrop-filter: none; backdrop-filter: none; }
}
@media (forced-colors: active) {
  .strata-hud { --hud-focus: Highlight; }
  .strata-hud .sh-panel { background: Canvas; border-color: CanvasText; }
  .strata-hud .sh-switch::before { border-color: ButtonText; }
  .strata-hud .sh-switch[aria-checked=true]::before { background: Highlight; border-color: Highlight; forced-color-adjust: none; }
  .strata-hud .sh-dot::before { background: ButtonText; forced-color-adjust: none; }
}
`;
