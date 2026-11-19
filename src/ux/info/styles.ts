/**
 * Styles for the information layer, shipped as a string like the HUD's own.
 * Everything hangs off the HUD's custom properties (--hud-fg, --hud-a-strong,
 * --hud-edge, ...), so themes and the accessibility layer carry through.
 *
 * Besides its own elements (.si-*), this sheet touches three things the HUD
 * built, each through a hook the HUD puts there for the purpose:
 *   .sh-stat[data-stat=...]   order of the two counts, and which stats show
 *   .sh-help                  room for a second column of controls
 */
export const INFO_CSS = `
/* ---- stats line -------------------------------------------------------- */
/* The two counts lead and sit together: "1.21M simulated  2.00M stored  32 sheets  0:42  60 fps". */
.strata-hud .sh-stat[data-stat="particles"] { order: -2; }
.strata-hud .sh-stat[data-stat="total"] { order: -1; }
/* When every stored particle was simulated this frame, one number says it all. */
.strata-hud.si-all-simulated .sh-stat[data-stat="total"] { display: none; }
/* The world's most common behavior says nothing about the sheet in view. The sheet label does. */
.strata-hud .sh-stat[data-stat="behavior"] { display: none; }

/* ---- sheet label: what the sheet you face (or point at) is doing --------- */
.strata-hud > .si-sheet {
  --hud-a-dim: 0.62;
  position: absolute;
  right: var(--hud-edge);
  bottom: var(--hud-edge);
  max-width: min(46ch, calc(100% - 2 * var(--hud-edge)));
  font-size: 12px;
  text-align: right;
  text-transform: none;
  text-shadow: 0 0 3px rgba(var(--hud-bg), 0.9), 0 0 8px rgba(var(--hud-bg), 0.6);
  opacity: 0;
  transition: opacity var(--hud-fade-out) var(--hud-ease);
}
.strata-hud > .si-sheet.is-on { opacity: 1; transition-duration: var(--hud-fade-in); }
/* It fades with the die and the dot. Once the stats line is asked for (H) it stays, like the stats. */
.strata-hud.is-idle:not(.stats-on) > .si-sheet,
/* The menu covers this corner, and a job has the world to itself. */
.strata-hud.panel-open > .si-sheet,
.strata-hud.has-job > .si-sheet { opacity: 0; transition-duration: var(--hud-fade-out); }
.si-sheet-name { color: rgba(var(--hud-fg), var(--hud-a-strong)); text-transform: lowercase; }
.si-sheet-text { color: rgba(var(--hud-fg), var(--hud-a-dim)); margin: 1px 0; }
.si-sheet-meta { color: rgba(var(--hud-fg), var(--hud-a-dim)); font-variant-numeric: tabular-nums; }
.si-sheet[data-level="short"] .si-sheet-text, .si-sheet-text:empty { display: none; }

/* ---- keys sheet: a second column for the pointer and the camera keys ----- */
.strata-hud .sh-help {
  flex-wrap: wrap; align-items: flex-start; align-content: center;
  gap: 2.4em 4.5em;
  padding: var(--hud-edge);
  overflow-y: auto;
}
.sh-help dl.si-controls dt.si-head {
  grid-column: 1 / -1;
  text-align: left;
  margin-top: 0.9em;
  color: rgba(var(--hud-fg), 0.56);
}
.sh-help dl.si-controls dt.si-head:first-child { margin-top: 0; }

/* ---- about card ----------------------------------------------------------- */
.strata-hud > .si-about {
  --hud-a-dim: 0.72;
  --hud-a-ghost: 0.56;
  position: absolute; inset: 0;
  display: flex; align-items: flex-start; justify-content: center;
  padding: calc(var(--hud-edge) * 2) var(--hud-edge);
  overflow-y: auto;
  background: rgba(var(--hud-bg), 0.84);
  font-size: 13px; line-height: 1.55; letter-spacing: 0.02em; text-transform: none;
  color: rgba(var(--hud-fg), var(--hud-a-dim));
  user-select: text; -webkit-user-select: text;
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity var(--hud-fade-in) var(--hud-ease), visibility 0s linear var(--hud-fade-in);
}
.strata-hud.si-about-open > .si-about {
  opacity: 1; visibility: visible; pointer-events: auto;
  transition: opacity var(--hud-fade-in) var(--hud-ease), visibility 0s;
}
/* margin auto centres the card when there is room and lets it scroll from the top when there is not. */
.si-card { position: relative; width: 100%; max-width: 38em; margin: auto 0; outline: none; }
.si-card h2 {
  margin: 2em 0 0.55em; font: inherit; font-weight: 400;
  text-transform: lowercase; letter-spacing: var(--hud-tracking);
  color: rgba(var(--hud-fg), var(--hud-a-ghost));
}
.si-card h2:first-of-type { margin-top: 0; }
.si-card p { margin: 0 0 0.7em; }
.si-card b { font-weight: 400; color: rgba(var(--hud-fg), var(--hud-a-strong)); }

.si-numbers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.9em 2em; margin: 0.2em 0 1em; }
.si-numbers div { min-width: 0; }
.si-numbers dd {
  margin: 0; font-size: 1.7em; line-height: 1.2;
  color: rgba(var(--hud-fg), var(--hud-a-strong));
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.si-numbers dt { color: rgba(var(--hud-fg), var(--hud-a-dim)); }

.si-legend { display: grid; gap: 0.75em; margin: 0; }
.si-legend dt { color: rgba(var(--hud-fg), var(--hud-a-strong)); }
.si-legend dt i { font-style: normal; margin-left: 0.9em; color: rgba(var(--hud-fg), var(--hud-a-ghost)); font-variant-numeric: tabular-nums; }
.si-legend dd { margin: 0; }

.si-about a {
  color: rgba(var(--hud-fg), var(--hud-a-strong));
  text-decoration: underline; text-decoration-color: rgba(var(--hud-fg), 0.35); text-underline-offset: 3px;
}
.si-about a:hover { text-decoration-color: rgb(var(--hud-fg)); }
.si-links { display: flex; flex-wrap: wrap; gap: 0.3em 1.6em; }
.si-foot {
  margin-top: 2em; padding-top: 0.9em;
  border-top: 1px solid rgba(var(--hud-fg), 0.2);
  color: rgba(var(--hud-fg), var(--hud-a-ghost));
  text-transform: lowercase; letter-spacing: var(--hud-tracking);
  display: flex; flex-wrap: wrap; gap: 0.3em 1.8em;
}
.si-foot b { margin-right: 0.5em; }
.strata-hud .si-close {
  position: absolute; top: -0.35em; right: 0;
  min-height: 24px; padding: 2px 4px; margin: 0 -4px;
  cursor: pointer; text-transform: lowercase; letter-spacing: var(--hud-tracking);
  color: rgba(var(--hud-fg), var(--hud-a-ghost));
}
.strata-hud .si-close:hover, .strata-hud .si-close:focus-visible { color: rgb(var(--hud-fg)); }
/* The footer link into the card sits with "reset", "stats" and "? keys". */
.sh-foot .si-about-link { cursor: pointer; }

@media (max-width: 520px), (pointer: coarse) {
  /* A phone keeps its thumb-reach corner for buttons; the label moves above the stats line. */
  .strata-hud > .si-sheet { right: auto; left: var(--hud-edge); bottom: calc(var(--hud-edge) + 44px); text-align: left; }
  .si-numbers dd { font-size: 1.45em; }
}
@media (prefers-reduced-motion: reduce) {
  .strata-hud > .si-sheet, .strata-hud > .si-about { transition: none !important; }
}
@media (prefers-contrast: more) {
  .strata-hud > .si-about { background: rgb(var(--hud-bg)); --hud-a-dim: 0.9; --hud-a-ghost: 0.8; }
  .strata-hud > .si-sheet { --hud-a-dim: 0.9; }
}
`;
