// For tests. Stylesheets that cannot import the design tokens (the plain JS HUD,
// index.html) write var(--st-x, fallback), where the fallback repeats the token's
// value. staleFallbacks() finds every fallback that no longer equals its token,
// so a token edit cannot leave a stale copy behind.
//
//   const { checked, stale } = staleFallbacks(css);
//   assert.deepEqual(stale, []);
import { TOKENS_CSS } from "./index";

/** A stylesheet split by media query: { "": the rules outside any @media, "(query)": the rules inside it }. */
export function scopes(css) {
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
export function fallbacks(css) {
  const out = [];
  const re = /var\((--st-[a-z0-9-]+)\s*,/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let i = re.lastIndex;
    for (let depth = 1; depth > 0; i++) depth += css[i] === "(" ? 1 : css[i] === ")" ? -1 : 0;
    out.push({ name: m[1], fallback: css.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/** The value a stylesheet gives a custom property, or undefined. */
export const declared = (css, name) => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css)?.[1];

const tidy = (text) => text.replace(/\s+/g, " ").trim();
const tokenSheet = scopes(TOKENS_CSS);

/** A token's value under a media query (or outside any), with the tokens it refers to filled in. */
export function tokenValue(name, query = "") {
  const raw = declared(tokenSheet[query] ?? "", name) ?? declared(tokenSheet[""], name);
  if (raw == null) return undefined;
  return raw.replace(/var\((--st-[a-z0-9-]+)\)/g, (_, inner) => tokenValue(inner, query) ?? `var(${inner})`);
}

/**
 * Compare every fallback in a stylesheet with its token, media query by media query.
 * @param {string} css
 * @param {(fallback: string) => string} [local]  Rewrites a fallback first, for one that points at a local alias.
 * @returns {{ checked: number, stale: string[] }}  `stale` holds one readable line per mismatch.
 */
export function staleFallbacks(css, local = (text) => text) {
  const stale = [];
  let checked = 0;
  for (const [query, rules] of Object.entries(scopes(css))) {
    for (const { name, fallback } of fallbacks(rules)) {
      checked++;
      const want = tokenValue(name, query);
      const where = query ? ` under ${query}` : "";
      if (want == null) stale.push(`${name}${where} is not a design token`);
      else if (tidy(local(fallback)) !== tidy(want)) stale.push(`${name}${where}: fallback "${tidy(fallback)}" but the token is "${tidy(want)}"`);
    }
  }
  return { checked, stale };
}
