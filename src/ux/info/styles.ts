/**
 * Styles for the information layer, shipped as a string like the HUD's own.
 * Every font, ink level, space and timing is a design token (src/ux/design,
 * rules in docs/ux/design.md); mountInfo installs the tokens before this sheet.
 *
 * Text roles used here:
 *   caption   a behavior's name (the sheet label, the list of sheets)
 *   body      sentences (a behavior's description, the about card)
 *   figure    the one hero number: particles simulated this frame
 *   data      the other live numbers
 *   fine      what a number counts, section names, the card's footer
 *
 * Besides its own elements (.si-*), this sheet touches two things the HUD
 * built, each through a hook the HUD puts there for the purpose:
 *   .sh-stat[data-stat=...]   the two counts lead the stats line; one stat is hidden
 *   .sh-help                  room for a second column of controls
 */
import { TYPE } from "../design";

/** The HUD sets lowercase and its own tracking on everything inside it. The roles below decide for themselves. */
const RESET = "text-transform: none; letter-spacing: normal;";

export const INFO_CSS = `
/* ---- stats line -------------------------------------------------------- */
/* The two counts lead and sit together: "1.21M simulated  2.00M stored  32 sheets  0:42  60 fps". */
.strata-hud .sh-stat[data-stat="particles"] { order: -2; }
.strata-hud .sh-stat[data-stat="total"] { order: -1; }
/* The world's most common behavior says nothing about the sheet in view. The sheet label does. */
.strata-hud .sh-stat[data-stat="behavior"] { display: none; }

/* ---- sheet label: what the sheet you face (or point at) is doing --------- */
.strata-hud > .si-sheet {
  ${RESET}
  position: absolute;
  right: var(--st-edge-right);
  bottom: var(--st-edge-bottom);
  max-width: min(calc(var(--st-u) * 84), calc(100% - var(--st-edge-left) - var(--st-edge-right)));
  text-align: right;
  /* A focused sheet fills the view, so this text usually sits on particles, not on the void:
     the halo three times over, and nothing fainter than dim. */
  text-shadow: var(--st-halo), var(--st-halo), var(--st-halo);
  opacity: 0;
  transition: opacity var(--st-slow) var(--st-ease-soft);
}
/* It answers an input (double-click, a key, the pointer), so it arrives at the pace of answering text. */
.strata-hud > .si-sheet.is-on { opacity: 1; transition: opacity var(--st-medium) var(--st-ease); }
/* It fades with the die and the dot, but only once there was time to read it (.is-held).
   With the stats line on (H) it stays, like the stats. */
.strata-hud.is-idle:not(.stats-on) > .si-sheet:not(.is-held),
/* The menu covers this corner, and a job has the world to itself. */
.strata-hud.panel-open > .si-sheet,
.strata-hud.has-job > .si-sheet { opacity: 0; transition: opacity var(--st-slow) var(--st-ease-soft); }
/* Tracked capitals end with a gap; pull it back so the name lines up with the text under it. */
.si-sheet-name { ${TYPE.caption} color: var(--st-strong); margin-right: calc(-1 * var(--st-track-wide)); }
.si-sheet-text { ${TYPE.body} margin: var(--st-space-1) 0; }
.si-sheet-meta { ${TYPE.fine} color: var(--st-dim); }
.si-sheet[data-level="short"] .si-sheet-text, .si-sheet-text:empty { display: none; }

/* ---- keys sheet: a second column for the pointer and the camera keys ----- */
.strata-hud .sh-help {
  flex-wrap: wrap; align-items: flex-start; align-content: center;
  gap: var(--st-space-8) var(--st-space-12);
  padding: var(--st-edge-top) var(--st-edge-right) var(--st-edge-bottom) var(--st-edge-left);
  overflow-y: auto;
}
/* Every group of rows gets a name: "pointer", "camera keys", and "shortcuts" over the HUD's own list. */
.sh-help dl.si-controls dt.si-head,
.sh-help > dl:not(.si-controls)::before {
  ${TYPE.fine}
  grid-column: 1 / -1;
  text-align: left;
  padding-bottom: var(--st-space-1);
  border-bottom: 1px solid var(--st-hair);
}
.sh-help > dl:not(.si-controls)::before { content: "shortcuts"; }
.sh-help dl.si-controls dt.si-head:not(:first-child) { margin-top: var(--st-space-4); }

/* ---- about card ----------------------------------------------------------- */
/* A full-screen sheet: the world stays visible, dimmed, around a panel made for reading. */
.strata-hud > .si-about {
  ${RESET}
  position: absolute; inset: 0;
  display: flex; align-items: flex-start; justify-content: center;
  padding: var(--st-edge-top) var(--st-edge-right) var(--st-edge-bottom) var(--st-edge-left);
  overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y;
  background: var(--st-scrim);
  user-select: text; -webkit-user-select: text;
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity var(--st-fast) var(--st-ease), visibility 0s linear var(--st-fast);
}
.strata-hud.si-about-open > .si-about {
  opacity: 1; visibility: visible; pointer-events: auto;
  transition: opacity var(--st-fast) var(--st-ease), visibility 0s;
}
/* margin auto centres the card when there is room and lets it scroll from the top when there is not. */
.si-card {
  ${TYPE.body}
  position: relative;
  width: 100%; max-width: calc(var(--st-u) * 132);
  margin: auto 0;
  padding: var(--st-space-6) var(--st-space-6) var(--st-space-4);
  background: var(--st-surface);
  border: 1px solid var(--st-hair);
  border-radius: var(--st-radius);
}
/* The card takes the focus so Tab starts inside it; it is not a control, so it shows no ring. */
.strata-hud .si-card:focus, .strata-hud .si-card:focus-visible { outline: none; }
.si-card h2 { ${TYPE.fine} margin: var(--st-space-6) 0 var(--st-space-2); }
.si-card h2:first-child { margin-top: 0; }
.si-card p { margin: 0 0 var(--st-space-3); }
.si-card b { font-weight: inherit; color: var(--st-strong); }

/* Live numbers: one hero figure, the rest as data. Each says what it counts. */
.si-live { margin: 0; }
/* In the markup the words come first (dt, then dd); on screen the number leads. */
.si-number { display: flex; flex-direction: column-reverse; }
.si-live dd { margin: 0; }
.si-live dt { ${TYPE.fine} }
.si-hero dd { ${TYPE.figure} }
.si-hero dt { margin-top: var(--st-space-1); }
.si-facts { display: flex; flex-wrap: wrap; gap: var(--st-space-2) var(--st-space-6); margin: var(--st-space-4) 0; }
.si-facts dd { ${TYPE.data} color: var(--st-strong); white-space: nowrap; }

.si-legend {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(calc(var(--st-u) * 56), 1fr));
  gap: var(--st-space-3) var(--st-space-8); margin: 0;
}
.si-legend dt { ${TYPE.caption} color: var(--st-strong); }
.si-legend dt i { ${TYPE.fine} ${RESET} font-style: normal; display: block; }
.si-legend dd { margin: var(--st-space-1) 0 0; }

.si-about a {
  color: var(--st-strong);
  text-decoration: underline; text-decoration-color: var(--st-stroke); text-underline-offset: 3px;
}
.si-about a:hover { color: var(--st-lit); text-decoration-color: var(--st-lit); }
.si-links { display: flex; flex-wrap: wrap; gap: 0 var(--st-space-4); }
.si-links a { display: inline-flex; align-items: center; min-height: var(--st-hit); }
.si-foot {
  ${TYPE.fine}
  display: flex; flex-wrap: wrap; gap: var(--st-space-1) var(--st-space-6);
  margin-top: var(--st-space-4); padding-top: var(--st-space-3);
  border-top: 1px solid var(--st-hair);
}
.si-foot b { margin-right: var(--st-space-2); }
.strata-hud .si-close {
  ${TYPE.fine}
  position: absolute; top: var(--st-space-4); right: var(--st-space-4);
  min-width: var(--st-hit); min-height: var(--st-hit); padding: 0 var(--st-space-2);
  cursor: pointer;
  transition: color var(--st-fast) var(--st-ease);
}
.strata-hud .si-close:hover { color: var(--st-lit); }
.strata-hud .si-about a:focus-visible, .strata-hud .si-close:focus-visible {
  outline: var(--st-focus); outline-offset: 2px; color: var(--st-lit);
}
/* The footer link into the card sits with "reset", "stats" and "? keys". */
.sh-foot .si-about-link { cursor: pointer; }

/* Room for two columns: the live world on the left, the trillion on the right, the sheets underneath. */
@media (min-width: 900px) {
  .si-card { max-width: calc(var(--st-u) * 236); padding: var(--st-space-6) var(--st-space-8) var(--st-space-4); }
  .si-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 var(--st-space-12); }
  .strata-hud .si-close { top: var(--st-space-4); right: var(--st-space-6); }
}
@media (max-width: 899px) {
  /* One column: the second group follows the first, so its heading needs its space back. */
  .si-cols > section + section > h2:first-child { margin-top: var(--st-space-6); }
}
@media (max-width: 899px), (pointer: coarse) {
  /* The bottom of a small screen is taken (stats, the die, hints, the menu button), so the label
     goes top left, clear of the menu dot in the other corner. */
  .strata-hud > .si-sheet {
    top: var(--st-edge-top); bottom: auto;
    left: var(--st-edge-left); right: auto;
    max-width: min(calc(var(--st-u) * 84), calc(100% - var(--st-edge-left) - var(--st-edge-right) - var(--st-space-8)));
    text-align: left;
  }
  .si-sheet-name { margin-right: 0; }
  /* Under the fps readout when "fps in corner" is on. */
  .strata-hud:has(.sm-corner) > .si-sheet { top: calc(var(--st-edge-top) + var(--st-space-6)); }
}
@media (pointer: coarse) {
  /* The last lines must scroll clear of the round menu button (src/ux/mobile) in the corner. */
  .strata-hud > .si-about { padding-bottom: calc(var(--st-edge-bottom) + var(--st-space-12) + var(--st-space-4)); }
}
`;
