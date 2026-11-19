// HUD styles, shipped as a string so the module needs no bundler or CSS loader.
// Every colour, size and timing hangs off a custom property on .strata-hud, and
// each of those follows a design token (src/ux/design, docs/ux/design.md). The
// value after the comma repeats the token, for a page that did not install the
// tokens; tokens.test.js fails when the two drift apart.

export const CSS = `
.strata-hud {
  --hud-fg: var(--st-ink, 255, 255, 255);
  --hud-bg: var(--st-shade, 0, 0, 0);
  --hud-mark: var(--st-accent, var(--hud-fg));   /* marks that show a value or a selection; a color theme tints them */
  --hud-a-strong: var(--st-a-strong, 0.9);       /* values, anything active */
  --hud-a-dim: var(--st-a-dim, 0.65);            /* labels, sentences */
  --hud-a-ghost: var(--st-a-faint, 0.48);        /* section titles, footer, idle icons: the floor for text */
  --hud-a-stroke: var(--st-a-stroke, 0.36);      /* outlines of controls */
  --hud-a-line: var(--st-a-hair, 0.16);          /* separators */
  --hud-a-panel: var(--st-a-surface, 0.88);      /* black behind the menu */
  --hud-scrim: var(--st-scrim, rgba(0, 0, 0, 0.8));
  --hud-blur: var(--st-blur, 10px);
  --hud-halo: var(--st-halo, 0 0 6px rgba(0, 0, 0, 0.9), 0 0 12px rgba(0, 0, 0, 0.9));
  --hud-unit: var(--st-u, 4px);
  --hud-edge: var(--st-edge, 20px);              /* distance from the viewport edge */
  --hud-panel-w: 264px;
  --hud-fade-in: var(--st-fast, 180ms);          /* answer an input */
  --hud-fade-text: var(--st-medium, 480ms);      /* text that answers an input */
  --hud-fade-out: var(--st-slow, 1200ms);        /* leave */
  --hud-ease: var(--st-ease, cubic-bezier(0.2, 0, 0, 1));
  --hud-ease-soft: var(--st-ease-soft, cubic-bezier(0.4, 0, 0.6, 1));
  /* Instrument voice: what the machine reports. --hud-font is the base, --hud-font-fine the small print. */
  --hud-font: var(--st-font-data, 400 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  --hud-font-fine: var(--st-font-fine, 400 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  --hud-font-figure: var(--st-font-figure, 200 34px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
  /* Voice: words spoken to the person. */
  --hud-font-voice: var(--st-font-caption, 400 11px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
  --hud-font-body: var(--st-font-body, 400 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
  --hud-tracking: var(--st-track, 0.04em);
  --hud-tracking-wide: var(--st-track-wide, 0.3em);
  --hud-tracking-title: var(--st-track-title, 0.5em);

  position: absolute;
  inset: 0;
  z-index: var(--st-z-hud, 10);
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
/* Controls start bare. :where() keeps this as weak as one class, so any class rule below it wins
   (as a plain ".strata-hud button" it outranked them, which dropped the tab underline and the die's centring). */
.strata-hud :where(input, select, button) {
  font: inherit; letter-spacing: inherit; text-transform: inherit; color: inherit;
  margin: 0; background: none; border: 0; border-radius: 0; outline: none;
}

/* Everything fades as one layer. Fade out slowly, come back fast. */
.strata-hud > * { transition: opacity var(--hud-fade-in) var(--hud-ease); }
.strata-hud.is-idle > .sh-dot,
.strata-hud.is-idle > .sh-dice { opacity: 0; transition-duration: var(--hud-fade-out); transition-timing-function: var(--hud-ease-soft); }
/* Stats are off until asked for. Once asked for they stay, idle or not. */
.strata-hud > .sh-stats { opacity: 0; }
.strata-hud.stats-on > .sh-stats { opacity: 1; }

.strata-hud-idle, .strata-hud-idle * { cursor: none !important; }

/* Text with no panel behind it: a soft dark halo keeps it legible over bright sheets without any visible chrome. */
.sh-stats, .sh-announce, .sh-job, .sh-message { text-shadow: var(--hud-halo); }

/* ---- stats ---------------------------------------------------------- */
.sh-stats {
  position: absolute;
  bottom: var(--hud-edge);
  display: flex;
  gap: calc(var(--hud-unit) * 4);
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
/* Spoken to the person, so it takes the voice: wide capitals. It answers a roll, and leaves slowly. */
.sh-announce {
  position: absolute;
  left: 0; right: 0;
  bottom: max(14%, calc(var(--hud-edge) + var(--hud-unit) * 18)); /* clear of the die and of a hint above it */
  text-align: center;
  font: var(--hud-font-voice);
  text-transform: uppercase;
  opacity: 0;
  transition: opacity var(--hud-fade-out) var(--hud-ease-soft) !important;
}
.sh-announce.is-on { opacity: 1; transition: opacity var(--hud-fade-text) var(--hud-ease) !important; }
.sh-announce .sh-a-title {
  /* The one place tracking opens all the way: a title card, not a label. */
  letter-spacing: var(--hud-tracking-title);
  margin-right: calc(var(--hud-tracking-title) * -1); /* optical centring: cancel trailing tracking */
  color: rgba(var(--hud-fg), var(--hud-a-strong));
}
.sh-announce .sh-a-sub {
  margin-top: calc(var(--hud-unit) * 2);
  letter-spacing: var(--hud-tracking-wide);
  margin-right: calc(var(--hud-tracking-wide) * -1);
  color: rgba(var(--hud-fg), var(--hud-a-dim));
}

/* ---- status line and job progress ---------------------------------------- */
.sh-job {
  position: absolute; left: 0; right: 0; bottom: var(--hud-edge);
  display: flex; flex-direction: column; align-items: center; gap: calc(var(--hud-unit) * 2);
  text-align: center; text-transform: none; white-space: pre-line;
  opacity: 0;
}
.strata-hud.has-status > .sh-job { opacity: 1; }
/* The die steps aside while the line is up, and a job keeps the line through idle. */
.strata-hud.has-status > .sh-dice { opacity: 0; pointer-events: none; }
.sh-job-bar { width: 240px; max-width: 60%; height: 1px; background: rgba(var(--hud-fg), var(--hud-a-stroke)); display: none; }
.strata-hud.has-progress .sh-job-bar { display: block; }
.sh-job-bar i { display: block; height: 100%; background: rgb(var(--hud-mark)); transform-origin: 0 50%; transform: scaleX(0); transition: transform var(--hud-fade-in) linear; }

/* ---- message --------------------------------------------------------- */
.sh-message {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: var(--hud-edge);
  font: var(--hud-font-body); letter-spacing: 0;
  text-align: center; white-space: pre-line; text-transform: none;
  color: rgba(var(--hud-fg), var(--hud-a-strong));
  opacity: 0;
}
.strata-hud.has-message > .sh-message { opacity: 1; }

/* ---- panel ------------------------------------------------------------ */
.sh-panel {
  position: absolute;
  top: calc(var(--hud-edge) + var(--hud-unit) * 6);
  right: var(--hud-edge);
  width: var(--hud-panel-w);
  max-width: calc(100% - 2 * var(--hud-edge));
  max-height: calc(100% - 2 * var(--hud-edge) - var(--hud-unit) * 17); /* room for the dot above and the die below */
  overflow-y: auto;
  scrollbar-width: none;
  padding: calc(var(--hud-unit) * 4);
  background: rgba(var(--hud-bg), var(--hud-a-panel));
  border: 1px solid rgba(var(--hud-fg), var(--hud-a-line));
  -webkit-backdrop-filter: blur(var(--hud-blur));
  backdrop-filter: blur(var(--hud-blur));
  pointer-events: auto;
  opacity: 0;
  visibility: hidden;
  transform: translateY(calc(var(--hud-unit) * -1));
  transition: opacity var(--hud-fade-in) var(--hud-ease), transform var(--hud-fade-in) var(--hud-ease), visibility 0s linear var(--hud-fade-in);
}
.sh-panel::-webkit-scrollbar { display: none; }
.strata-hud.panel-open > .sh-panel {
  opacity: 1;
  visibility: visible;
  transform: none;
  transition: opacity var(--hud-fade-in) var(--hud-ease), transform var(--hud-fade-in) var(--hud-ease), visibility 0s;
}
.sh-group + .sh-group { margin-top: calc(var(--hud-unit) * 3); padding-top: calc(var(--hud-unit) * 3); border-top: 1px solid rgba(var(--hud-fg), var(--hud-a-line)); }
.sh-group-title { font: var(--hud-font-fine); color: rgba(var(--hud-fg), var(--hud-a-ghost)); margin-bottom: calc(var(--hud-unit) * 2); }
.sh-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  column-gap: calc(var(--hud-unit) * 3);
  min-height: calc(var(--hud-unit) * 6);
  color: rgba(var(--hud-fg), var(--hud-a-dim));
}
.sh-row:hover, .sh-row:focus-within { color: rgba(var(--hud-fg), var(--hud-a-strong)); }
.sh-row.is-changed .sh-label::after { content: " \\00b7"; }
.sh-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sh-value { color: rgba(var(--hud-fg), var(--hud-a-strong)); text-align: right; min-width: 5ch; }
.sh-row.sh-range { grid-template-rows: auto auto; padding: var(--hud-unit) 0; }
.sh-row.sh-range input { grid-column: 1 / -1; }

/* range: a one pixel line with a small tick for a thumb. The filled part and the tick are marks. */
.strata-hud input[type=range] {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 14px; cursor: ew-resize;
  --p: 0%;
  background:
    linear-gradient(rgb(var(--hud-mark)), rgb(var(--hud-mark))) 0 50% / var(--p) 1px no-repeat,
    linear-gradient(rgba(var(--hud-fg), var(--hud-a-stroke)), rgba(var(--hud-fg), var(--hud-a-stroke))) 0 50% / 100% 1px no-repeat;
}
.strata-hud input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 3px; height: 11px; background: rgb(var(--hud-mark)); border: 0; border-radius: 0;
}
.strata-hud input[type=range]::-moz-range-thumb {
  width: 3px; height: 11px; background: rgb(var(--hud-mark)); border: 0; border-radius: 0;
}
.strata-hud input[type=range]::-moz-range-track { background: none; }
.strata-hud input[type=range]:focus-visible::-webkit-slider-thumb { height: 14px; width: 5px; }
.strata-hud input[type=range]:focus-visible::-moz-range-thumb { height: 14px; width: 5px; }

/* toggle: a small square, filled with the mark when on */
.sh-switch {
  width: 22px; height: 22px; cursor: pointer; position: relative; padding: 0;
}
.sh-switch::before {
  content: ""; position: absolute; right: 0; top: 6px; width: 9px; height: 9px;
  border: 1px solid rgba(var(--hud-fg), var(--hud-a-stroke));
}
.sh-switch[aria-checked=true]::before { background: rgb(var(--hud-mark)); border-color: rgb(var(--hud-mark)); }
.sh-switch:focus-visible::before { outline: 1px solid rgba(var(--hud-fg), var(--hud-a-strong)); outline-offset: 2px; }

.strata-hud select {
  -webkit-appearance: none; appearance: none; cursor: pointer;
  color: rgba(var(--hud-fg), var(--hud-a-strong));
  text-align: right; text-align-last: right; direction: rtl;
  padding: 2px 0; max-width: 150px;
  border-bottom: 1px solid transparent;
}
.strata-hud select:hover, .strata-hud select:focus-visible { border-bottom-color: rgba(var(--hud-fg), var(--hud-a-ghost)); }
.strata-hud select option { background: #000; color: #fff; direction: ltr; }

.sh-act {
  grid-column: 1 / -1; text-align: left; cursor: pointer; padding: var(--hud-unit) 0 !important;
  color: rgba(var(--hud-fg), var(--hud-a-dim));
}
.sh-act:hover, .sh-act:focus-visible { color: rgb(var(--hud-fg)); }
.sh-act::before { content: "\\2192\\00a0"; color: rgba(var(--hud-fg), var(--hud-a-ghost)); }
.sh-act:hover::before, .sh-act:focus-visible::before { color: inherit; }

.sh-foot {
  display: flex; justify-content: space-between; gap: calc(var(--hud-unit) * 3);
  margin-top: calc(var(--hud-unit) * 3); padding-top: calc(var(--hud-unit) * 3);
  border-top: 1px solid rgba(var(--hud-fg), var(--hud-a-line));
  color: rgba(var(--hud-fg), var(--hud-a-ghost));
}
.sh-foot button { font: var(--hud-font-fine); cursor: pointer; padding: 2px 0; }
.sh-foot button:hover, .sh-foot button:focus-visible { color: rgb(var(--hud-fg)); }
.sh-foot button[aria-pressed=true] { color: rgba(var(--hud-fg), var(--hud-a-strong)); }

/* ---- menu dot: the only chrome besides the dice --------------------- */
/* A 40px target around a 4px point. The point's outer corner sits on the edge lines, in line with the panel under it. */
.sh-dot {
  position: absolute; right: calc(var(--hud-edge) - 18px); top: calc(var(--hud-edge) - 18px);
  width: 40px; height: 40px; padding: 0;
  pointer-events: auto; cursor: pointer;
}
.sh-dot::before {
  content: ""; position: absolute; left: 18px; top: 18px; width: 4px; height: 4px;
  border-radius: 50%; background: rgba(var(--hud-fg), var(--hud-a-ghost));
  transition: transform var(--hud-fade-in) var(--hud-ease), background var(--hud-fade-in) var(--hud-ease);
}
.sh-dot:hover::before, .sh-dot:focus-visible::before,
.strata-hud.panel-open > .sh-dot::before { background: rgb(var(--hud-fg)); transform: scale(1.5); }

/* ---- dice ------------------------------------------------------------ */
/* A 48px target around a 24px face. The face stands on the edge line, like the stats beside it. */
.sh-dice {
  position: absolute; left: calc(50% - 24px); bottom: calc(var(--hud-edge) - 12px);
  width: 48px; height: 48px; padding: 10px;
  pointer-events: auto; cursor: pointer;
  color: rgba(var(--hud-fg), var(--hud-a-ghost));
  transition: opacity var(--hud-fade-in) var(--hud-ease), color var(--hud-fade-in) var(--hud-ease);
}
.sh-dice:hover, .sh-dice:focus-visible, .sh-dice.is-rolling { color: rgb(var(--hud-fg)); }
.sh-dice svg { display: block; width: 28px; height: 28px; overflow: visible; }
.sh-dice rect { fill: none; stroke: currentColor; stroke-width: 1; vector-effect: non-scaling-stroke; }
.sh-dice circle { fill: currentColor; opacity: 0; transition: opacity 60ms linear; }
.sh-dice circle.is-on { opacity: 1; }
.sh-dice:hover svg { transform: rotate(-8deg); }
.sh-dice:active svg { transform: scale(0.88); }
.sh-dice svg { transition: transform var(--hud-fade-in) var(--hud-ease); }
/* The die is the one piece of chrome that loops and bounces, so the timings of its toss, its pips and its breathing are its own. */
/* First-visit hint: stay visible through idle and breathe slowly. */
.strata-hud.is-idle > .sh-dice.is-hinting { opacity: 1; }
.sh-dice.is-hinting:not(:hover):not(.is-rolling) { animation: sh-breathe 2.8s ease-in-out infinite; }
@keyframes sh-breathe {
  0%, 100% { color: rgba(var(--hud-fg), var(--hud-a-stroke)); }
  50%      { color: rgba(var(--hud-fg), var(--hud-a-strong)); }
}
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
/* A full-screen sheet: the scrim dims the world, and text on it is dim or stronger. */
.sh-help {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--hud-scrim);
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity var(--hud-fade-in) var(--hud-ease), visibility 0s linear var(--hud-fade-in);
}
.strata-hud.help-open > .sh-help {
  opacity: 1; visibility: visible; pointer-events: auto;
  transition: opacity var(--hud-fade-in) var(--hud-ease), visibility 0s;
}
.sh-help dl {
  display: grid; grid-template-columns: auto auto; gap: calc(var(--hud-unit) * 2) calc(var(--hud-unit) * 6); margin: 0;
}
.sh-help dt { text-align: right; color: rgba(var(--hud-fg), var(--hud-a-strong)); }
.sh-help dd { margin: 0; color: rgba(var(--hud-fg), var(--hud-a-dim)); }

@media (max-width: 520px) {
  .strata-hud { --hud-edge: var(--st-edge, 16px); }
  .sh-panel { left: var(--hud-edge); width: auto; }
  /* The die owns the bottom row of a narrow screen, so both stats lines stack above it, left-hand ones lowest. */
  .sh-stats.sh-left { bottom: calc(var(--hud-edge) + var(--hud-unit) * 11); }
  .sh-stats.sh-right { bottom: calc(var(--hud-edge) + var(--hud-unit) * 12 + 1.5em); right: auto; left: var(--hud-edge); flex-direction: row; }
}
@media (prefers-reduced-motion: reduce) {
  .strata-hud, .strata-hud * { transition-duration: 1ms !important; }
  .sh-dice.is-rolling svg, .sh-dice.is-hinting { animation: none !important; }
}
`;
