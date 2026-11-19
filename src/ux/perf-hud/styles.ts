/**
 * Styles for the perf HUD's blocks, built on the design tokens
 * (src/ux/design, docs/ux/design.md): every font, ink level, space and line
 * here is a `--st-*` token.
 *
 * Text roles: names and values are `data` (values in the strong ink), the
 * note that says what a value is or where it comes from is `fine`, and so is
 * the per-pass breakdown. Marks that show a value (the frame time line, the
 * meters, the bar) take the theme accent through `--st-mark`.
 *
 * Widths are sized for the Esc menu: about 42 characters across, so a row is
 * a name of up to 13 characters, a value of up to 7 and a note of up to 20.
 */
import { TYPE, installTokens } from "../design";

export const PERF_HUD_CSS = `
.ph { display: block; ${TYPE.data} text-transform: none; }
.ph [hidden] { display: none; }
.ph-row {
  display: grid;
  grid-template-columns: calc(var(--st-u) * 28) calc(var(--st-u) * 16) minmax(0, 1fr);
  column-gap: var(--st-space-2);
  align-items: baseline;
  min-height: var(--st-space-6);
}
.ph-k { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ph-v { color: var(--st-strong); text-align: right; white-space: nowrap; }
.ph-n { ${TYPE.fine} text-transform: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* One pass of the frame under the gpu row: smaller, with a hairline meter where the note would be.
   Its name and value share the width of the two columns above (28 + 2 + 16 units), so the values line up. */
.ph-sub {
  ${TYPE.fine} text-transform: none; min-height: calc(var(--st-u) * 5);
  grid-template-columns: calc(var(--st-u) * 46) minmax(0, 1fr);
}
.ph-kv { display: flex; justify-content: space-between; column-gap: var(--st-space-2); min-width: 0; }
.ph-kv .ph-k { flex: 0 1 auto; min-width: 0; }
.ph-kv .ph-v { flex: none; color: var(--st-dim); }
.ph-sub .ph-n { align-self: center; overflow: visible; }
.ph-meter { display: block; height: 1px; width: var(--p, 0%); background: var(--st-mark); }

/* A name and free text: adapter names and the like. */
.ph-wide { grid-template-columns: calc(var(--st-u) * 28) minmax(0, 1fr); }
.ph-wide .ph-v { text-align: left; white-space: normal; overflow-wrap: anywhere; }

/* Frame time, frame by frame. The canvas draws in its own color. */
.ph-graph {
  display: block; width: 100%; height: var(--st-space-12); margin-bottom: var(--st-space-2);
  color: var(--st-mark);
  border-bottom: 1px solid var(--st-hair);
}
/* Where the frame goes: simulate, draw, the rest. The empty part is headroom. */
.ph-bar {
  display: flex; height: calc(var(--st-u) / 2); margin: var(--st-space-1) 0 var(--st-space-2);
  overflow: hidden; background: var(--st-hair);
}
.ph-bar i { display: block; height: 100%; flex: none; background: var(--st-mark); }
.ph-bar i:nth-child(2) { background: rgba(var(--st-accent), var(--st-a-dim)); }
.ph-bar i:nth-child(3) { background: rgba(var(--st-accent), var(--st-a-stroke)); }

.ph-note { ${TYPE.fine} text-transform: none; padding: var(--st-space-1) 0; white-space: normal; }
.ph-note b { font-weight: inherit; color: var(--st-strong); }
`;

const STYLE_ID = "strata-perf-hud-style";

/** Adds the tokens and this stylesheet to the page once. */
export function installPerfHudStyles(doc: Document = document): void {
  installTokens(doc);
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PERF_HUD_CSS;
  doc.head.appendChild(style);
}
