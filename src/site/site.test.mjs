// Unit tests for the site's head tags and its page table. Run with `npm test -- site`.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { applyHead, escapeHtml, headTags, pageUrl, sitemapXml } from "./head.ts";
import { PAGES, SITE } from "./pages.ts";

// Tests are bundled into a temp folder before they run, so find the repo from the working directory.
const root = existsSync(join(process.cwd(), "src/site/pages.ts"))
  ? process.cwd()
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const site = { ...SITE, cardUrl: (card) => SITE.url + "share/" + card.file.split("/").pop() };
const home = PAGES.find((page) => page.file === "index.html");

const count = (html, pattern) => (html.match(pattern) ?? []).length;

test("page addresses: an index.html is its folder", () => {
  assert.equal(pageUrl("https://x.test/Strata/", "index.html"), "https://x.test/Strata/");
  assert.equal(pageUrl("https://x.test/Strata/", "src/challenge/index.html"), "https://x.test/Strata/src/challenge/");
  assert.equal(pageUrl("https://x.test/", "docs/explainers/rendering.html"), "https://x.test/docs/explainers/rendering.html");
});

test("text is escaped for attributes and element content", () => {
  assert.equal(escapeHtml(`a "b" <c> & d`), "a &quot;b&quot; &lt;c&gt; &amp; d");
  const tags = headTags({ file: "index.html", title: `5 < 6 & "x"`, description: "d" }, site).join("\n");
  assert.ok(tags.includes("<title>5 &lt; 6 &amp; &quot;x&quot;</title>"));
  assert.ok(tags.includes(`content="5 &lt; 6 &amp; &quot;x&quot;"`));
});

test("the page's own title is replaced and its other tags are kept", () => {
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    "    <title>Strata</title>",
    '    <meta name="theme-color" content="#000000" />',
    '    <link rel="icon" href="data:image/svg+xml,%3Csvg%3E" />',
    "    <style>body { margin: 0; }</style>",
    "  </head>",
    "  <body><canvas></canvas></body>",
    "</html>",
  ].join("\n");
  const out = applyHead(html, home, site);
  assert.deepEqual(out.replaced, []);
  assert.equal(count(out.html, /<title>/g), 1);
  assert.ok(out.html.includes(`    <title>${escapeHtml(home.title)}</title>\n    <meta name="description"`));
  assert.ok(out.html.includes('<meta name="theme-color" content="#000000" />'));
  assert.ok(out.html.includes('<meta name="viewport"'));
  assert.ok(out.html.includes('<link rel="icon"'));
  assert.ok(out.html.includes(`<link rel="canonical" href="${SITE.url}" />`));
  assert.ok(out.html.includes(`<meta property="og:image" content="${SITE.url}share/strata-1t.jpg" />`));
  assert.ok(out.html.includes('<meta name="twitter:card" content="summary_large_image" />'));
  // The charset declaration must stay within the first 1024 bytes, so nothing may be put in front of it.
  assert.ok(out.html.indexOf("<meta charset") < out.html.indexOf("<title>"));
  assert.ok(out.html.endsWith("  </head>\n  <body><canvas></canvas></body>\n</html>"));
});

test("copies of owned tags in the HTML are removed, with their lines, and reported", () => {
  const html = [
    "<head>",
    '  <meta charset="utf-8">',
    "  <title>Old</title>",
    '  <meta name="description" content="old > older" />',
    "  <meta property='og:title' content='Old'>",
    '  <META NAME="twitter:card" CONTENT="summary">',
    '  <link rel="canonical" href="https://old.test/"><meta name="color-scheme" content="dark">',
    "</head><body></body>",
  ].join("\n");
  const out = applyHead(html, home, site);
  assert.deepEqual(out.replaced, ["description", "og:title", "twitter:card", "canonical"]);
  assert.equal(count(out.html, /name="description"/gi), 1);
  assert.equal(count(out.html, /og:title/g), 1);
  assert.equal(count(out.html, /twitter:card/gi), 1);
  assert.equal(count(out.html, /rel="canonical"/g), 1);
  assert.ok(!out.html.includes("old"));
  assert.ok(!out.html.includes("Old"));
  assert.ok(out.html.includes('<meta name="color-scheme" content="dark">'));
  assert.ok(!/\n[ \t]*\n/.test(out.html), "no blank lines left behind");
});

test("a page without a title gets its tags last in the head", () => {
  const out = applyHead('<head>\n  <meta charset="utf-8">\n</head>\n<body></body>', home, site);
  assert.ok(out.html.startsWith('<head>\n  <meta charset="utf-8">\n  <title>'));
  assert.ok(out.html.includes("</script>\n</head>\n<body></body>"));
});

test("only the front page carries the web application data, and it cannot close its script", () => {
  const data = headTags({ ...home, description: "</script><script>alert(1)</script>" }, site).at(-1);
  assert.ok(data.startsWith('<script type="application/ld+json">'));
  assert.equal(count(data, /<\/script>/g), 1);
  assert.equal(JSON.parse(data.slice(data.indexOf(">") + 1, data.lastIndexOf("<"))).name, "Strata");
  const other = headTags(PAGES.find((page) => !page.app), site).join("\n");
  assert.ok(!other.includes("ld+json"));
});

test("pages kept out of search say so and stay out of the sitemap", () => {
  const hidden = PAGES.find((page) => page.index === false);
  assert.ok(headTags(hidden, site).includes('<meta name="robots" content="noindex" />'));
  const xml = sitemapXml(SITE.url, PAGES);
  assert.ok(xml.includes(`<loc>${SITE.url}</loc>`));
  assert.ok(!xml.includes(pageUrl(SITE.url, hidden.file)));
});

test("the page table: files exist, lengths fit, and the trillion is never 'simulated'", () => {
  assert.ok(SITE.url.startsWith("https://") && SITE.url.endsWith("/"));
  assert.equal(new Set(PAGES.map((page) => page.file)).size, PAGES.length, "one row per file");
  for (const page of PAGES) {
    assert.ok(existsSync(join(root, page.file)), `${page.file} exists`);
    assert.ok(page.title.length <= 60, `${page.file}: title is ${page.title.length} characters, search results cut at about 60`);
    assert.ok(page.description.length >= 50 && page.description.length <= 160, `${page.file}: description is ${page.description.length} characters, keep it between 50 and 160`);
    // Clause by clause: "millions simulated live, and a trillion rendered" is right, "a trillion simulated" is not.
    for (const clause of `${page.title}. ${page.description}`.split(/[.?!:;]\s|,\s/)) {
      assert.ok(!(/trillion|1,000,000,000,000/i.test(clause) && /simulat/i.test(clause)), `${page.file}: "${clause}" calls the trillion simulated; it is rendered`);
    }
  }
});

test("the share card exists and is small enough for every chat app", () => {
  const cards = new Set([SITE.card, ...PAGES.map((page) => page.card).filter(Boolean)]);
  for (const card of cards) {
    const path = join(root, card.file);
    assert.ok(existsSync(path), `${card.file} exists`);
    // Some chat apps skip preview images above about 300 kB.
    assert.ok(statSync(path).size <= 300 * 1024, `${card.file} is ${Math.round(statSync(path).size / 1024)} kB, keep it under 300 kB`);
    assert.ok(card.alt.length <= 420, `${card.file}: alt text is ${card.alt.length} characters, X cuts at 420`);
  }
});
