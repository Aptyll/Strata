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
.sm-tabs, .sm-subtabs {
  display: flex; flex-wrap: wrap; gap: 0.2em 1.1em;
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
/* The section tab already names the group, so its heading would repeat it. */
.sm-page.has-sub .sh-group-title { display: none; }

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
