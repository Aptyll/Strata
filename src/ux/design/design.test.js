// The promises the design tokens make, checked by `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { THEMES } from "../theme";
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

test("text stays readable on a panel with white-hot particles behind it", () => {
  // Worst case: the canvas under the panel is pure white, so the backing is a grey of (1 - panel alpha).
  const backing = 1 - DESIGN.surface.panel;
  const luminance = (s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
  const text = DESIGN.alpha.faint + (1 - DESIGN.alpha.faint) * backing;
  const ratio = (luminance(text) + 0.05) / (luminance(backing) + 0.05);
  assert.ok(ratio >= 4.5, `faint text on the panel backing is ${ratio.toFixed(2)}:1`);
});

test("every color theme gives the accent marks at least 3:1 on the void", () => {
  for (const theme of THEMES) {
    const accent = accentOf(theme.stops);
    if (theme.stops.length === 0) assert.equal(accent, null, "an empty ramp leaves the marks in the ink");
    else assert.ok(accent && contrastOnVoid(1, accent) >= 3, `theme "${theme.id}": the accent is too dark for a mark`);
  }
});
