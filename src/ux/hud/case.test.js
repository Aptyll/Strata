// The HUD draws its chrome in lowercase (text-transform on .strata-hud). Anything
// that shows a value has to opt out: formatCount writes 2.00M, and "2.00m" reads
// as milli on the one number the project is about. `npm test` fails here when an
// element that shows values loses its opt-out. A new place that shows a count
// gets a line in VALUES.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MENU_CSS } from "./menu-styles.js";
import { CSS } from "./styles.js";

/** Selectors of the elements that show values: stats, slider readouts, the menu header's facts, dropdowns. */
const VALUES = [".sh-stat b", ".sh-value", ".sm-fact dd", ".strata-hud .sm-menu select"];

/** The declarations of every rule that names `selector` in its selector list. */
function declarations(css, selector) {
  let found = "";
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, selectors, body] of rules) {
    if (selectors.split(",").some((s) => s.trim() === selector)) found += body;
  }
  return found;
}

test("every element that shows a value keeps its case", () => {
  const sheet = CSS + MENU_CSS;
  for (const selector of VALUES) {
    assert.match(
      declarations(sheet, selector),
      /text-transform:\s*none/,
      `${selector} has no text-transform: none, so a count such as 2.00M would be drawn as 2.00m`,
    );
  }
});

test("the lowercase the values opt out of is still there", () => {
  // If the HUD stops lowercasing its chrome, this file and the opt-outs can go.
  assert.match(declarations(CSS, ".strata-hud"), /text-transform:\s*lowercase/);
});
