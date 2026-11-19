// The HUD follows the design tokens (src/ux/design) through var(--st-x, fallback),
// and each fallback repeats the token's value for a page that did not install the
// tokens. `npm test` fails here when a fallback and its token drift apart, or when
// a literal alpha comes back into the HUD stylesheets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TOKENS_CSS } from "../design";
import { A11Y_CSS } from "./a11y-styles.js";
import { MENU_CSS } from "./menu-styles.js";
import { CSS } from "./styles.js";

const SHEETS = { "styles.js": CSS, "menu-styles.js": MENU_CSS, "a11y-styles.js": A11Y_CSS };

/** A stylesheet split by media query: { "": the rules outside any @media, "(query)": the rules inside it }. */
function scopes(css) {
  const out = { "": "" };
  let rest = css;
  for (let at = rest.indexOf("@media"); at >= 0; at = rest.indexOf("@media")) {
    out[""] += rest.slice(0, at);
    const open = rest.indexOf("{", at);
    let i = open + 1;
    for (let depth = 1; depth > 0; i++) depth += rest[i] === "{" ? 1 : rest[i] === "}" ? -1 : 0;
    const query = rest.slice(at + "@media".length, open).trim();
    out[query] = (out[query] ?? "") + rest.slice(open + 1, i - 1);
    rest = rest.slice(i);
  }
  out[""] += rest;
  return out;
}

/** Every var(--st-x, fallback) in a piece of CSS. A fallback may hold commas and brackets of its own. */
function fallbacks(css) {
  const out = [];
  const re = /var\((--st-[a-z0-9-]+)\s*,/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let i = re.lastIndex;
    for (let depth = 1; depth > 0; i++) depth += css[i] === "(" ? 1 : css[i] === ")" ? -1 : 0;
    out.push({ name: m[1], fallback: css.slice(re.lastIndex, i - 1) });
  }
  return out;
}

const declared = (css, name) => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css)?.[1];
const tidy = (text) => text.replace(/\s+/g, " ").trim();

const tokenSheet = scopes(TOKENS_CSS);
/** A token's value under a media query (or outside any), with the tokens it refers to filled in. */
function token(name, query) {
  const raw = declared(tokenSheet[query] ?? "", name) ?? declared(tokenSheet[""], name);
  assert.ok(raw != null, `${name} is not a design token`);
  return raw.replace(/var\((--st-[a-z0-9-]+)\)/g, (_, inner) => token(inner, query));
}

const hudBase = scopes(CSS)[""];
/** A fallback may point at another HUD property, such as var(--hud-fg): read that property's own fallback. */
const local = (fallback) =>
  fallback.replace(/var\((--hud-[a-z0-9-]+)\)/g, (whole, name) => fallbacks(declared(hudBase, name) ?? "")[0]?.fallback ?? whole);

test("every fallback in the HUD stylesheets repeats its design token", () => {
  let checked = 0;
  for (const [file, css] of Object.entries(SHEETS)) {
    for (const [query, rules] of Object.entries(scopes(css))) {
      for (const { name, fallback } of fallbacks(rules)) {
        const where = `${file}: the fallback of ${name}${query ? ` under ${query}` : ""}`;
        assert.equal(tidy(local(fallback)), tidy(token(name, query)), `${where} is not the token's value`);
        checked++;
      }
    }
  }
  assert.ok(checked > 25, "expected the HUD stylesheets to follow the design tokens");
});

test("the HUD stylesheets take every alpha from a level, never a literal", () => {
  for (const [file, css] of Object.entries(SHEETS)) {
    const literal = /rgba\(var\(--hud-(?:fg|bg)\),\s*[0-9.]+\s*\)/.exec(css);
    assert.equal(literal, null, `${file}: ${literal?.[0]} should use a level: --hud-a-strong, -dim, -ghost, -stroke, -line or -panel`);
  }
});
