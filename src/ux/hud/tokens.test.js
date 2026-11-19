// The HUD follows the design tokens (src/ux/design) through var(--st-x, fallback),
// and each fallback repeats the token's value for a page that did not install the
// tokens. `npm test` fails here when a fallback and its token drift apart, or when
// a literal alpha comes back into the HUD stylesheets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { declared, fallbacks, scopes, staleFallbacks } from "../design/fallbacks.js";
import { A11Y_CSS } from "./a11y-styles.js";
import { MENU_CSS } from "./menu-styles.js";
import { CSS } from "./styles.js";

const SHEETS = { "styles.js": CSS, "menu-styles.js": MENU_CSS, "a11y-styles.js": A11Y_CSS };

const hudBase = scopes(CSS)[""];
/** A fallback may point at another HUD property, such as var(--hud-fg): read that property's own fallback. */
const local = (fallback) =>
  fallback.replace(/var\((--hud-[a-z0-9-]+)\)/g, (whole, name) => fallbacks(declared(hudBase, name) ?? "")[0]?.fallback ?? whole);

test("every fallback in the HUD stylesheets repeats its design token", () => {
  let total = 0;
  for (const [file, css] of Object.entries(SHEETS)) {
    const { checked, stale } = staleFallbacks(css, local);
    assert.deepEqual(stale, [], `${file} has fallbacks that differ from their tokens`);
    total += checked;
  }
  assert.ok(total > 25, "expected the HUD stylesheets to follow the design tokens");
});

test("the HUD stylesheets take every alpha from a level, never a literal", () => {
  for (const [file, css] of Object.entries(SHEETS)) {
    const literal = /rgba\(var\(--hud-(?:fg|bg)\),\s*[0-9.]+\s*\)/.exec(css);
    assert.equal(literal, null, `${file}: ${literal?.[0]} should use a level: --hud-a-strong, -dim, -ghost, -stroke, -line or -panel`);
  }
});
