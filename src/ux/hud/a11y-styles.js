// Readability and accessibility rules for the HUD, layered after styles.js by a11y.js.
// They only override custom properties and sizes, so the look stays white on black.
//
// Contrast (WCAG 2.x, white text over a black void; the colour themes only remap the
// canvas and keep the void black, so these hold for every theme):
//   alpha 0.90 -> about 16.8:1  primary text, values
//   alpha 0.70 -> about 9.9:1  labels in the menu
//   alpha 0.62 -> about 7.8:1  stats labels, announce subtitle
//   alpha 0.56 -> about 6.5:1  section titles, footer
// The menu sits on a 0.9 black backing, so even over dense particles the background
// stays near black and every label clears 4.5:1.

export const A11Y_CSS = `
.strata-hud {
  --hud-panel-w: 312px;
  --hud-focus: rgb(var(--hud-fg));
}

/* ---- type scale ---------------------------------------------------------- */
/* Base HUD text is 11px. Read-at-a-glance text grows: stats 12px, menu and keys 13px. */
.strata-hud > .sh-stats { font-size: 12px; }
.strata-hud .sh-panel, .strata-hud .sh-help { font-size: 13px; line-height: 1.5; }

/* ---- contrast ------------------------------------------------------------ */
.strata-hud > .sh-stats, .strata-hud > .sh-announce { --hud-a-dim: 0.62; }
/* A dark halo keeps stats legible over bright, dense particles. Invisible over black. */
.strata-hud > .sh-stats, .strata-hud > .sh-announce, .strata-hud > .sh-job {
  text-shadow: 0 0 3px rgba(var(--hud-bg), 0.9), 0 0 8px rgba(var(--hud-bg), 0.6);
}
.strata-hud .sh-panel {
  --hud-a-dim: 0.7;
  --hud-a-ghost: 0.56;
  --hud-a-line: 0.28;
  background: rgba(var(--hud-bg), 0.9);
  /* A visible scrollbar tells keyboard and mouse users there is more below. */
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--hud-fg), 0.35) transparent;
}
.strata-hud .sh-help { background: rgba(var(--hud-bg), 0.82); --hud-a-dim: 0.7; }

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
@media (prefers-contrast: more) {
  .strata-hud { --hud-a-strong: 1; --hud-a-dim: 0.85; --hud-a-ghost: 0.75; --hud-a-line: 0.6; }
  .strata-hud .sh-panel, .strata-hud > .sh-stats, .strata-hud > .sh-announce {
    --hud-a-strong: 1; --hud-a-dim: 0.85; --hud-a-ghost: 0.75; --hud-a-line: 0.6;
  }
  .strata-hud .sh-panel { background: rgb(var(--hud-bg)); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
@media (prefers-reduced-transparency: reduce) {
  .strata-hud .sh-panel { background: rgb(var(--hud-bg)); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
@media (forced-colors: active) {
  .strata-hud { --hud-focus: Highlight; }
  .strata-hud .sh-panel { background: Canvas; border-color: CanvasText; }
  .strata-hud .sh-switch::before { border-color: ButtonText; }
  .strata-hud .sh-switch[aria-checked=true]::before { background: Highlight; border-color: Highlight; forced-color-adjust: none; }
  .strata-hud .sh-dot::before { background: ButtonText; forced-color-adjust: none; }
}
`;
