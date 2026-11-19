// The promises the design tokens make, checked by `npm test`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { THEMES } from "../theme";
import { staleFallbacks } from "./fallbacks.js";
import { DESIGN, TOKENS_CSS, TYPE, accentOf, contrastOnVoid } from "./index";

test("every token the stylesheet or a role refers to is defined", () => {
  const defined = new Set([...TOKENS_CSS.matchAll(/(--st-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = [...(TOKENS_CSS + Object.values(TYPE).join(" ")).matchAll(/var\((--st-[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 20, "expected the stylesheet to refer to its own tokens");
  for (const name of used) assert.ok(defined.has(name), `${name} is used but never defined`);
});

test("text levels meet WCAG AA on the void, and control outlines meet 3:1", () => {
  const { strong, dim, faint, stroke, hair } = DESIGN.alpha;
  for (const [name, a] of Object.entries({ strong, dim, faint })) {
    assert.ok(contrastOnVoid(a) >= 4.5, `${name} (${a}) is too faint for text: ${contrastOnVoid(a).toFixed(2)}:1`);
  }
  assert.ok(contrastOnVoid(stroke) >= 3, `stroke (${stroke}) is too faint for a control outline`);
  assert.ok(strong > dim && dim > faint && faint > stroke && stroke > hair, "the levels must stay in order");
});

test("text stays readable on a panel and on a sheet with white-hot particles behind them", () => {
  // Worst case: the canvas underneath is pure white, so the backing is a grey of (1 - the black's alpha).
  const luminance = (s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
  const ratio = (textAlpha, blackAlpha) => {
    const backing = 1 - blackAlpha;
    return (luminance(textAlpha + (1 - textAlpha) * backing) + 0.05) / (luminance(backing) + 0.05);
  };
  const onPanel = ratio(DESIGN.alpha.faint, DESIGN.surface.panel);
  assert.ok(onPanel >= 4.5, `faint text on the panel backing is ${onPanel.toFixed(2)}:1`);
  // A sheet lets more of the world through, so text on it is dim or stronger.
  const onSheet = ratio(DESIGN.alpha.dim, DESIGN.surface.scrim);
  assert.ok(onSheet >= 4.5, `dim text on the scrim is ${onSheet.toFixed(2)}:1`);
});

test("every color theme gives the accent marks at least 3:1 on the void", () => {
  for (const theme of THEMES) {
    const accent = accentOf(theme.stops);
    if (theme.stops.length === 0) assert.equal(accent, null, "an empty ramp leaves the marks in the ink");
    else assert.ok(accent && contrastOnVoid(1, accent) >= 3, `theme "${theme.id}": the accent is too dark for a mark`);
  }
});

test("the title card in index.html repeats the tokens it cannot import", () => {
  // The card starts before the script that installs the tokens, so it carries their values as fallbacks.
  // `npm test` runs from the repository root, where index.html lives.
  const css = /<style>([\s\S]*?)<\/style>/.exec(readFileSync("index.html", "utf8"))?.[1] ?? "";
  const { checked, stale } = staleFallbacks(css);
  assert.deepEqual(stale, []);
  assert.ok(checked >= 10, "expected the title card to be styled from the tokens");
});
