// Styles for the menu structure in menu.js: summary header, page tabs, section
// tabs, and the optional corner fps readout. Sizes are in em so the panel's
// type scale (the HUD's base font) carries through. Same palette as styles.js:
// the ink on black, one-pixel lines, no fills. Marks that show a value or a
// selection (the graph's line, the selected underline) take --hud-mark, which
// a color theme tints.

export const MENU_CSS = `
.sh-panel.sm-menu {
  --hud-panel-w: 30em;
  display: flex; flex-direction: column;
  overflow: hidden;
  padding: 0;
}
.sh-panel.sm-menu > .sh-foot { margin: 0; padding: 0.8em 1.45em 0.9em; flex: none; }

/* ---- summary header ---- */
.sm-summary {
  flex: none;
  padding: 1.1em 1.45em 0.9em;
  border-bottom: 1px solid rgba(var(--hud-fg), var(--hud-a-line));
}
.sm-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 1em; }
.sm-fps { display: flex; align-items: baseline; gap: 0.45em; white-space: nowrap; }
/* The one hero number of the menu: the figure role, thin so its strokes stay a pixel wide. */
.sm-fps-num {
  font: var(--hud-font-figure); letter-spacing: 0;
  color: rgba(var(--hud-fg), var(--hud-a-strong));
  font-variant-numeric: tabular-nums; min-width: 2ch; text-align: right;
}
.sm-fps i { font-style: normal; }
.sm-ms { color: rgba(var(--hud-fg), var(--hud-a-dim)); font-variant-numeric: tabular-nums; }
.sm-graph {
  display: block; width: 11em; height: 2.6em; flex: 0 1 11em; min-width: 5em;
  color: rgb(var(--hud-mark));
  border-bottom: 1px solid rgba(var(--hud-fg), var(--hud-a-line));
}
.sm-facts {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.55em 1em; margin: 0.9em 0 0;
}
.sm-fact { min-width: 0; }
.sm-fact[hidden] { display: none; }
.sm-fact dd {
  margin: 0; color: rgba(var(--hud-fg), var(--hud-a-strong));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.sm-fact dt { font: var(--hud-font-fine); color: rgba(var(--hud-fg), var(--hud-a-ghost)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- page tabs (first navbar) and section tabs (second navbar) ---- */
/* Six page tabs must fit on one line: about 0.64em a character plus the gaps, in 27em of room. */
.sm-tabs, .sm-subtabs {
  display: flex; flex-wrap: wrap; gap: 0.2em 0.8em;
}
.sm-tabs {
  flex: none;
  padding: 0.75em 1.45em 0;
  border-bottom: 1px solid rgba(var(--hud-fg), var(--hud-a-line));
}
.sm-subtabs { padding: 0 0 0.6em; margin-bottom: 0.7em; gap: 0.2em 0.9em; }
.sm-subtabs[hidden], .sm-tab[hidden] { display: none; }
.sm-tab, .sm-subtab {
  cursor: pointer; padding: 0.35em 0 0.5em;
  color: rgba(var(--hud-fg), var(--hud-a-dim));
  border-bottom: 1px solid transparent;
  margin-bottom: -1px;
  white-space: nowrap;
}
.sm-subtab { padding: 0.2em 0 0.25em; color: rgba(var(--hud-fg), var(--hud-a-ghost)); }
.sm-tab:hover, .sm-subtab:hover { color: rgba(var(--hud-fg), var(--hud-a-strong)); }
.sm-tab[aria-selected=true], .sm-subtab[aria-selected=true] {
  color: rgb(var(--hud-fg));
  border-bottom-color: rgb(var(--hud-mark));
}

/* ---- pages: the only part that scrolls ---- */
.sm-pages {
  flex: 1 1 auto; min-height: 0;
  overflow-y: auto; scrollbar-width: none;
  padding: 0.9em 1.45em 0.4em;
}
.sm-pages::-webkit-scrollbar { display: none; }
.sm-page[hidden], .sm-section[hidden] { display: none; }
/* The page tab, the section tab or the section title already names the group. */
.sm-menu .sh-group-title { display: none; }

/* ---- stacked pages: every section shown, under a small title ---- */
.sm-section-title { display: none; }
.sm-page.is-stacked .sm-section-title {
  display: block; width: 100%; padding: 0; text-align: left;
  font: var(--hud-font-fine);
  color: rgba(var(--hud-fg), var(--hud-a-ghost));
  margin-bottom: calc(var(--hud-unit) * 2);
}
/* A page's first section, named like the page: the page tab already says it. */
.sm-page.is-stacked > .sm-subtabs + .sm-section.is-self-named > .sm-section-title:not(.sm-fold) { display: none; }
.sm-page.is-stacked .sm-section + .sm-section {
  margin-top: calc(var(--hud-unit) * 3); padding-top: calc(var(--hud-unit) * 3);
  border-top: 1px solid rgba(var(--hud-fg), var(--hud-a-line));
}
/* A folded section: the title is a button, marked + while folded and a minus sign while open. */
.sm-page.is-stacked .sm-fold { cursor: pointer; min-height: calc(var(--hud-unit) * 6); }
.sm-fold::before { content: "+\\00a0"; }
.sm-fold[aria-expanded=true]::before { content: "\\2212\\00a0"; }
.sm-page.is-stacked .sm-fold[aria-expanded=false] { margin-bottom: 0; }
.sm-page.is-stacked .sm-fold:hover, .sm-page.is-stacked .sm-fold:focus-visible { color: rgb(var(--hud-fg)); }
.sm-section > .sh-group[hidden] { display: none; }

/* Values keep their case here too: a count of 1T must not read 1t. */
.strata-hud .sm-menu select { text-transform: none; }

/* ---- a control whose switch is off (ParamPlacement.needs): faint, and it does not react.
   Its words sit at the floor for text; its marks (track, tick, switch) fade with them. ---- */
.sh-row.is-off, .sh-row.is-off:hover, .sh-row.is-off:focus-within { color: rgba(var(--hud-fg), var(--hud-a-ghost)); }
.strata-hud .sh-row.is-off :is(.sh-value, .sh-act, select) { color: inherit; }
.strata-hud .sh-row.is-off :is(input[type=range], .sh-switch) { opacity: var(--hud-a-ghost); }
.strata-hud .sh-row.is-off * { cursor: default; }

/* ---- optional always-on fps readout (perf page, "fps in corner") ---- */
.sm-corner {
  position: absolute; left: var(--hud-edge); top: var(--hud-edge);
  color: rgba(var(--hud-fg), var(--hud-a-strong));
  font-variant-numeric: tabular-nums; white-space: pre;
  text-shadow: var(--hud-halo);
  pointer-events: none;
}

@media (max-width: 520px) {
  .sh-panel.sm-menu { --hud-panel-w: auto; }
  .sm-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;
