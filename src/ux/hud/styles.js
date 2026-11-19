// HUD styles, shipped as a string so the module needs no bundler or CSS loader.
// Every colour and size hangs off a custom property on .strata-hud, so the
// engine can retheme by setting variables on the root element.

export const CSS = `
.strata-hud {
  --hud-fg: 255, 255, 255;
  --hud-bg: 0, 0, 0;
  /* Defaults mirror TOKENS in src/core/contracts.ts. createHud({ tokens: TOKENS }) overrides them. */
  --hud-a-strong: 0.9;    /* primary text, active controls */
  --hud-a-dim: 0.45;      /* secondary text, idle controls */
  --hud-a-line: calc(var(--hud-a-dim) * 0.33);  /* hairlines */
  --hud-a-ghost: calc(var(--hud-a-dim) * 0.62); /* section titles, footer */
  --hud-unit: 4px;
  --hud-edge: calc(var(--hud-unit) * 5);        /* distance from the viewport edge */
  --hud-panel-w: 264px;
  --hud-fade-in: 180ms;
  --hud-fade-out: 900ms;
  --hud-ease: cubic-bezier(0.2, 0, 0, 1);
  --hud-font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --hud-tracking: 0.04em;

  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  overflow: hidden;
  font: var(--hud-font);
  letter-spacing: var(--hud-tracking);
  text-transform: lowercase;
  font-variant-numeric: tabular-nums;
  color: rgba(var(--hud-fg), var(--hud-a-dim));
  -webkit-font-smoothing: antialiased;
  user-select: none;
  -webkit-user-select: none;
}
.strata-hud.is-fixed { position: fixed; }
.strata-hud *, .strata-hud *::before, .strata-hud *::after { box-sizing: border-box; }

/* Everything fades as one layer. Fade out slowly, come back fast. */
.strata-hud > * { transition: opacity var(--hud-fade-in) var(--hud-ease); }
.strata-hud.is-idle > .sh-dot,
.strata-hud.is-idle > .sh-dice { opacity: 0; transition-duration: var(--hud-fade-out); }
/* Stats are off until asked for. Once asked for they stay, idle or not. */
.strata-hud > .sh-stats { opacity: 0; }
.strata-hud.stats-on > .sh-stats { opacity: 1; }

/* ---- stats ---------------------------------------------------------- */
.sh-stats {
  position: absolute;
  bottom: var(--hud-edge);
  display: flex;
  gap: 18px;
  white-space: nowrap;
}
.sh-stats.sh-left { left: var(--hud-edge); }
.sh-stats.sh-right { right: var(--hud-edge); flex-direction: row-reverse; }
.sh-stat b { font-weight: 400; color: rgba(var(--hud-fg), var(--hud-a-strong)); }
.sh-stat i { font-style: normal; margin-left: 0.5em; }
/* Values keep their case: 1.05M must not become 1.05m. */
.sh-stat b, .sh-value { text-transform: none; }
.sh-stat:empty { display: none; }

/* ---- announce (plane / behaviour name) ------------------------------- */
.sh-announce {
  position: absolute;
  left: 0; right: 0;
  bottom: 14%;
  text-align: center;
  opacity: 0;
  transition: opacity 1400ms ease-in !important;
}
.sh-announce.is-on { opacity: 1; transition: opacity 500ms ease-out !important; }
.sh-announce .sh-a-title {
  /* The one place tracking opens up: a title card, not a label. */
  letter-spacing: 0.5em;
  margin-right: -0.5em; /* optical centring: cancel trailing tracking */
  text-transform: uppercase;
  color: rgba(var(--hud-fg), var(--hud-a-strong));
}
.sh-announce .sh-a-sub {
  margin-top: calc(var(--hud-unit) * 2);
  letter-spacing: 0.3em;
  margin-right: -0.3em;
  text-transform: uppercase;
  color: rgba(var(--hud-fg), var(--hud-a-dim));
}

/* ---- panel ------------------------------------------------------------ */
.sh-panel {
  position: absolute;
  top: calc(var(--hud-edge) + 26px);
  right: var(--hud-edge);
  width: var(--hud-panel-w);
  max-width: calc(100% - 2 * var(--hud-edge));
  max-height: calc(100% - 2 * var(--hud-edge) - 26px - 44px);
  overflow-y: auto;
  scrollbar-width: none;
  padding: 14px 16px 10px;
  background: rgba(var(--hud-bg), 0.78);
  border: 1px solid rgba(var(--hud-fg), var(--hud-a-line));
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  pointer-events: auto;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px);
  transition: opacity var(--hud-fade-in) var(--hud-ease), transform var(--hud-fade-in) var(--hud-ease), visibility 0s linear var(--hud-fade-in);
}
.sh-panel::-webkit-scrollbar { display: none; }
.strata-hud.panel-open > .sh-panel {
  opacity: 1;
  visibility: visible;
  transform: none;
  transition: opacity var(--hud-fade-in) var(--hud-ease), transform var(--hud-fade-in) var(--hud-ease), visibility 0s;
}
.sh-group + .sh-group { margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(var(--hud-fg), var(--hud-a-line)); }
.sh-group-title { color: rgba(var(--hud-fg), var(--hud-a-ghost)); margin-bottom: 8px; }
.sh-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  column-gap: 10px;
  min-height: 22px;
  color: rgba(var(--hud-fg), var(--hud-a-dim));
}
.sh-row:hover, .sh-row:focus-within { color: rgba(var(--hud-fg), var(--hud-a-strong)); }
.sh-row.is-changed .sh-label::after { content: " \\00b7"; }
.sh-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sh-value { color: rgba(var(--hud-fg), var(--hud-a-strong)); text-align: right; min-width: 5ch; }
.sh-row.sh-range { grid-template-rows: auto auto; padding: 3px 0 5px; }
.sh-row.sh-range input { grid-column: 1 / -1; }

.strata-hud input, .strata-hud select, .strata-hud button {
  font: inherit; letter-spacing: inherit; text-transform: inherit; color: inherit;
  margin: 0; background: none; border: 0; border-radius: 0; outline: none;
}
/* range: a hairline with a small tick for a thumb */
.strata-hud input[type=range] {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 14px; cursor: ew-resize;
  --p: 0%;
  background:
    linear-gradient(rgba(var(--hud-fg), 0.75), rgba(var(--hud-fg), 0.75)) 0 50% / var(--p) 1px no-repeat,
    linear-gradient(rgba(var(--hud-fg), 0.18), rgba(var(--hud-fg), 0.18)) 0 50% / 100% 1px no-repeat;
}
.strata-hud input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 3px; height: 11px; background: rgb(var(--hud-fg)); border: 0; border-radius: 0;
}
.strata-hud input[type=range]::-moz-range-thumb {
  width: 3px; height: 11px; background: rgb(var(--hud-fg)); border: 0; border-radius: 0;
}
.strata-hud input[type=range]::-moz-range-track { background: none; }
.strata-hud input[type=range]:focus-visible::-webkit-slider-thumb { height: 14px; width: 5px; }
.strata-hud input[type=range]:focus-visible::-moz-range-thumb { height: 14px; width: 5px; }

/* toggle: a small square, filled when on */
.sh-switch {
  width: 22px; height: 22px; cursor: pointer; position: relative; padding: 0;
}
.sh-switch::before {
  content: ""; position: absolute; right: 0; top: 6px; width: 9px; height: 9px;
  border: 1px solid rgba(var(--hud-fg), 0.55);
}
.sh-switch[aria-checked=true]::before { background: rgb(var(--hud-fg)); border-color: rgb(var(--hud-fg)); }
.sh-switch:focus-visible::before { outline: 1px solid rgba(var(--hud-fg), 0.8); outline-offset: 2px; }

.strata-hud select {
  -webkit-appearance: none; appearance: none; cursor: pointer;
  color: rgba(var(--hud-fg), var(--hud-a-strong));
  text-align: right; text-align-last: right; direction: rtl;
  padding: 2px 0; max-width: 150px;
  border-bottom: 1px solid transparent;
}
.strata-hud select:hover, .strata-hud select:focus-visible { border-bottom-color: rgba(var(--hud-fg), 0.5); }
.strata-hud select option { background: #000; color: #fff; direction: ltr; }

.sh-act {
  grid-column: 1 / -1; text-align: left; cursor: pointer; padding: 4px 0 !important;
  color: rgba(var(--hud-fg), var(--hud-a-dim));
}
.sh-act:hover, .sh-act:focus-visible { color: rgb(var(--hud-fg)); }
.sh-act::before { content: "\\2192\\00a0"; opacity: 0.5; }

.sh-foot {
  display: flex; justify-content: space-between; gap: 10px;
  margin-top: 14px; padding-top: 10px;
  border-top: 1px solid rgba(var(--hud-fg), var(--hud-a-line));
  color: rgba(var(--hud-fg), var(--hud-a-ghost));
}
.sh-foot button { cursor: pointer; padding: 2px 0; }
.sh-foot button:hover, .sh-foot button:focus-visible { color: rgb(var(--hud-fg)); }

/* ---- menu dot: the only chrome besides the dice --------------------- */
.sh-dot {
  position: absolute; right: calc(var(--hud-edge) - 14px); top: calc(var(--hud-edge) - 14px);
  width: 40px; height: 40px; padding: 0;
  pointer-events: auto; cursor: pointer;
}
.sh-dot::before {
  content: ""; position: absolute; left: 18px; top: 18px; width: 4px; height: 4px;
  border-radius: 50%; background: rgba(var(--hud-fg), var(--hud-a-dim));
  transition: transform var(--hud-fade-in) var(--hud-ease), background var(--hud-fade-in);
}
.sh-dot:hover::before, .sh-dot:focus-visible::before,
.strata-hud.panel-open > .sh-dot::before { background: rgb(var(--hud-fg)); transform: scale(1.5); }

/* ---- dice ------------------------------------------------------------ */
.sh-dice {
  position: absolute; left: 50%; bottom: calc(var(--hud-edge) - 6px);
  width: 48px; height: 48px; margin-left: -24px; padding: 10px;
  pointer-events: auto; cursor: pointer;
  color: rgba(var(--hud-fg), var(--hud-a-dim));
  transition: opacity var(--hud-fade-in) var(--hud-ease), color var(--hud-fade-in) var(--hud-ease);
}
.sh-dice:hover, .sh-dice:focus-visible, .sh-dice.is-rolling { color: rgb(var(--hud-fg)); }
.sh-dice svg { display: block; width: 28px; height: 28px; overflow: visible; }
.sh-dice rect { fill: none; stroke: currentColor; stroke-width: 1; vector-effect: non-scaling-stroke; }
.sh-dice circle { fill: currentColor; opacity: 0; transition: opacity 60ms linear; }
.sh-dice circle.is-on { opacity: 1; }
.sh-dice:hover svg { transform: rotate(-8deg); }
.sh-dice:active svg { transform: scale(0.88); }
.sh-dice svg { transition: transform 160ms ease-out; }
.sh-dice.is-rolling svg { animation: sh-roll 620ms cubic-bezier(0.2, 0.7, 0.2, 1); }
/* A toss: lift, spin a turn and a quarter (a square looks the same every quarter), land with one small bounce. */
@keyframes sh-roll {
  0%   { transform: translateY(0) rotate(0deg) scale(0.88); }
  35%  { transform: translateY(-14px) rotate(250deg) scale(1.06); }
  70%  { transform: translateY(0) rotate(440deg) scale(1); }
  84%  { transform: translateY(-3px) rotate(452deg); }
  100% { transform: translateY(0) rotate(450deg); }
}

/* ---- help overlay ------------------------------------------------------ */
.sh-help {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(var(--hud-bg), 0.6);
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity var(--hud-fade-in) var(--hud-ease), visibility 0s linear var(--hud-fade-in);
}
.strata-hud.help-open > .sh-help {
  opacity: 1; visibility: visible; pointer-events: auto;
  transition: opacity var(--hud-fade-in) var(--hud-ease), visibility 0s;
}
.sh-help dl {
  display: grid; grid-template-columns: auto auto; gap: 9px 28px; margin: 0;
}
.sh-help dt { text-align: right; color: rgba(var(--hud-fg), var(--hud-a-strong)); }
.sh-help dd { margin: 0; color: rgba(var(--hud-fg), var(--hud-a-dim)); }

@media (max-width: 520px) {
  .strata-hud { --hud-edge: calc(var(--hud-unit) * 3.5); }
  .sh-panel { left: var(--hud-edge); width: auto; }
  .sh-stats.sh-right { bottom: calc(var(--hud-edge) + 18px); right: auto; left: var(--hud-edge); flex-direction: row; }
}
@media (prefers-reduced-motion: reduce) {
  .strata-hud, .strata-hud * { transition-duration: 1ms !important; }
  .sh-dice.is-rolling svg { animation: none; }
}
`;
